// Supabase Edge Function: property-fingerprint
//
// Powers the Property Fingerprint report page (property-fingerprint.html).
// Takes an address, fans out to RentCast, ATTOM, Shovels.ai, and FEMA in
// parallel, assembles the results into the 11-category report shape the
// frontend renders, and writes a one-paragraph AI summary with Claude.
//
// Vendor coverage (see the plan doc for how this scope was decided):
//   - RentCast: AVM/comps/rent estimate (Market), subject property basics
//     (Identity, Timeline, Property Systems). Same vendor already used by
//     the home-potential function.
//   - ATTOM: ownership, tax/assessment, lot/land characteristics, basic
//     building permits, school profiles, and neighborhood crime/demographics
//     (via its Community API, chained off the geoIdV4 the Property API
//     returns). Estated no longer exists as a separate company -- it was
//     folded into ATTOM.
//   - Shovels.ai: deeper permit history, plus government/planning decisions
//     (rezonings, variances) for the Potential category -- nothing else we
//     evaluated has this data at all.
//   - FEMA NFHL: flood zone, free public API, no key.
//   - Anthropic (Claude Haiku): the one-paragraph AI summary.
//
// GreatSchools, a dedicated crime vendor, and Regrid were deliberately left
// out of this build -- ATTOM's own school/crime/land data is tried first,
// and those vendors only get added later if ATTOM's real responses turn out
// to be too thin for a given property.
//
// Request shape: POST { address } -> { report }
// Results are cached in `property_fingerprint_reports`, keyed by the
// formatted address, for 30 days.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CACHE_TTL_DAYS = 30;

// ATTOM's mortgage data comes from public deed-of-trust filings, which
// record the *original* loan amount and lender at origination -- never the
// current payoff balance, interest rate, or term (those simply aren't part
// of the public record in most jurisdictions). Equity and monthly P&I are
// therefore always modeled estimates, never exact figures, and are labeled
// as such in the UI. These two constants are the modeling assumption behind
// the P&I estimate and should be revisited periodically against a current
// average 30-year fixed rate.
const ASSUMED_MORTGAGE_RATE_PCT = 6.75;
const ASSUMED_MORTGAGE_TERM_YEARS = 30;
const RENTCAST_BASE_URL = "https://api.rentcast.io/v1";
const ATTOM_BASE_URL = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
const ATTOM_V4_BASE_URL = "https://api.gateway.attomdata.com/v4";
const SHOVELS_BASE_URL = "https://api.shovels.ai/v2";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function unavailable(reason: string) {
  return { available: false, reason };
}

// Standard fixed-rate amortization formula. Returns null rather than NaN/0
// for a zero or missing principal, since "a $0/mo payment" would read as a
// real fact rather than "not applicable."
function monthlyPayment(principal: number, annualRatePct: number, termYears: number): number | null {
  if (!principal || principal <= 0) return null;
  const r = annualRatePct / 100 / 12;
  const n = termYears * 12;
  return (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

// Neighborhood-ceiling comp weighting: a closed sale is real evidence of what
// a buyer actually paid; a pending sale is a buyer's accepted offer, not yet
// final; an active listing is only ever an asking price. Weighted this way
// rather than treated as one flat pool.
const COMP_WEIGHT = { sold: 1.0, pending: 0.6, active: 0.35 };

// Linear-interpolated weighted percentile over {value, weight} pairs.
function weightedPercentile(items: Array<{ value: number; weight: number }>, p: number): number | null {
  const pool = items.filter((i) => Number.isFinite(i.value) && i.weight > 0).sort((a, b) => a.value - b.value);
  if (pool.length === 0) return null;
  const totalWeight = pool.reduce((s, i) => s + i.weight, 0);
  let cumulative = 0;
  for (let idx = 0; idx < pool.length; idx++) {
    cumulative += pool[idx].weight;
    if (cumulative / totalWeight >= p) return pool[idx].value;
  }
  return pool[pool.length - 1].value;
}

// "4118 Comstock Ridge Rd, Asheville, NC 28804" -> address1/address2, the
// shape ATTOM's endpoints expect. Splits on the first comma; if there's no
// comma, the whole string goes in address1 and ATTOM will do its best.
function splitAddress(address: string): { address1: string; address2: string } {
  const idx = address.indexOf(",");
  if (idx === -1) return { address1: address.trim(), address2: "" };
  return {
    address1: address.slice(0, idx).trim(),
    address2: address.slice(idx + 1).trim(),
  };
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RentCast -- Market, plus subject-property basics for Identity/Timeline/Systems
// ---------------------------------------------------------------------------

async function fetchRentCast(address: string, apiKey: string) {
  const params = new URLSearchParams({ address, compCount: "10" });
  const [avmRes, rentRes] = await Promise.allSettled([
    fetch(`${RENTCAST_BASE_URL}/avm/value?${params.toString()}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    }),
    fetch(`${RENTCAST_BASE_URL}/avm/rent/long-term?${params.toString()}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    }),
  ]);

  const avm = avmRes.status === "fulfilled" && avmRes.value.ok ? await safeJson(avmRes.value) : null;
  const rent = rentRes.status === "fulfilled" && rentRes.value.ok ? await safeJson(rentRes.value) : null;
  return { avm, rent };
}

// ---------------------------------------------------------------------------
// ATTOM -- Ownership, Land, Public Records/permits (basic), Property Systems,
// Neighborhood (schools + crime/demographics via the Community API)
// ---------------------------------------------------------------------------

async function attomGet(path: string, params: Record<string, string>, apiKey: string, baseUrl = ATTOM_BASE_URL) {
  const url = `${baseUrl}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: { APIKey: apiKey, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return await safeJson(res);
}

async function fetchAttom(address: string, apiKey: string) {
  const { address1, address2 } = splitAddress(address);
  const params = { address1, address2 };

  // Two property endpoints, confirmed against real responses to have
  // different casing/field coverage: expandedprofile carries owner,
  // assessment, lot, and building detail; detailwithschools is the only one
  // that includes the school/schoolDistrict arrays. Both happen to include
  // location.geoIdV4, so either can drive the Community API chain below.
  const [expanded, schools, permits, mortgage, saleHistory] = await Promise.allSettled([
    attomGet("/property/expandedprofile", params, apiKey),
    attomGet("/property/detailwithschools", params, apiKey),
    attomGet("/property/buildingpermits", params, apiKey),
    attomGet("/property/detailmortgage", params, apiKey),
    attomGet("/saleshistory/expandedhistory", params, apiKey),
  ]);

  const expandedData = expanded.status === "fulfilled" ? expanded.value : null;
  const schoolsData = schools.status === "fulfilled" ? schools.value : null;
  const permitsData = permits.status === "fulfilled" ? permits.value : null;
  const mortgageData = mortgage.status === "fulfilled" ? mortgage.value : null;
  const saleHistoryData = saleHistory.status === "fulfilled" ? saleHistory.value : null;

  // The Property API response embeds a geoIdV4 map that unlocks the
  // separate Community API for crime/demographics. Prefer ZIP-level (ZI) as
  // the best balance of "neighborhood-sized" without being too granular to
  // have data; fall back through other geography levels if ZI is absent.
  const geoIdV4 =
    expandedData?.property?.[0]?.location?.geoIdV4 ?? schoolsData?.property?.[0]?.location?.geoIdV4 ?? null;
  const geoId = geoIdV4 ? (geoIdV4.ZI ?? geoIdV4.N4 ?? geoIdV4.N2 ?? geoIdV4.CS ?? Object.values(geoIdV4)[0]) : null;

  let community: any = null;
  if (geoId) {
    community = await attomGet("/neighborhood/community", { geoIdV4: String(geoId) }, apiKey, ATTOM_V4_BASE_URL);
  }

  return {
    detail: expandedData,
    schools: schoolsData,
    permits: permitsData,
    mortgage: mortgageData,
    saleHistory: saleHistoryData,
    community,
  };
}

// ---------------------------------------------------------------------------
// Shovels.ai -- permit history (deeper than ATTOM's) + government decisions,
// the only source we found for "nearby development plans"
// ---------------------------------------------------------------------------

async function fetchShovels(address: string, apiKey: string) {
  const headers = { "X-API-Key": apiKey, Accept: "application/json" };

  const searchRes = await fetch(`${SHOVELS_BASE_URL}/addresses/search?${new URLSearchParams({ q: address })}`, {
    headers,
  });
  if (!searchRes.ok) return { permits: null, decisions: null };
  const searchData = await safeJson(searchRes);
  const geoId = searchData?.items?.[0]?.geo_id;
  if (!geoId) return { permits: null, decisions: null };

  const today = new Date().toISOString().slice(0, 10);
  const farPast = "1990-01-01";

  const [permitsRes, decisionsRes] = await Promise.allSettled([
    fetch(
      `${SHOVELS_BASE_URL}/permits/search?${new URLSearchParams({
        geo_id: geoId,
        permit_from: farPast,
        permit_to: today,
        size: "25",
      })}`,
      { headers },
    ),
    fetch(
      `${SHOVELS_BASE_URL}/decisions/search?${new URLSearchParams({
        geo_id: geoId,
        decision_from: farPast,
        decision_to: today,
        size: "10",
      })}`,
      { headers },
    ),
  ]);

  const permits =
    permitsRes.status === "fulfilled" && permitsRes.value.ok ? await safeJson(permitsRes.value) : null;
  const decisions =
    decisionsRes.status === "fulfilled" && decisionsRes.value.ok ? await safeJson(decisionsRes.value) : null;

  return { permits, decisions };
}

// ---------------------------------------------------------------------------
// ATTOM sale/snapshot -- genuine closed sales (public record) within a radius
// of the subject property, for the Potential category's "sold" comp tier.
// This is a materially better source for verified sales than RentCast's
// listing-based comps, but Kansas and several other states are non-disclosure
// jurisdictions where the true sale price isn't part of the public record --
// ATTOM fills the gap with an algorithmic estimate and flags it via the
// `salecode` field. Those get filtered out entirely rather than silently fed
// into a ceiling calculation (confirmed live: one nearby "sale" came back as
// $3.875M for a 768 sq ft home, tagged "ESTIMATED ... non-disclosure counties").
// ---------------------------------------------------------------------------

async function fetchSoldComps(lat: number, lon: number, apiKey: string) {
  const today = new Date();
  const twelveMonthsAgo = new Date(today);
  twelveMonthsAgo.setMonth(today.getMonth() - 12);
  const params = {
    latitude: String(lat),
    longitude: String(lon),
    radius: "1",
    startSaleSearchDate: twelveMonthsAgo.toISOString().slice(0, 10),
    endSaleSearchDate: today.toISOString().slice(0, 10),
    orderBy: "distance asc",
    pageSize: "100",
  };
  const data = await attomGet("/sale/snapshot", params, apiKey);
  const props: any[] = data?.property ?? [];

  return props
    .map((p) => {
      const amt = p?.sale?.amount ?? {};
      const saleAmt = amt.saleamt ?? amt.saleAmt;
      const saleCode = String(amt.salecode ?? amt.saleCode ?? "");
      const sqft = p?.building?.size?.universalsize ?? p?.building?.size?.universalSize;
      const date = p?.sale?.saleTransDate ?? p?.sale?.saletransdate;
      return { saleAmt, saleCode, sqft, date, distance: p?.location?.distance };
    })
    .filter((c) => c.saleAmt && c.sqft && c.sqft > 0 && !/estimat|non-?disclosure/i.test(c.saleCode));
}

// ---------------------------------------------------------------------------
// FEMA NFHL -- flood zone, free, no key. Needs a lat/lon, which we take from
// whichever of RentCast/ATTOM found one first.
// ---------------------------------------------------------------------------

async function fetchFloodZone(lat: number, lon: number) {
  const url =
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?" +
    new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "FLD_ZONE,ZONE_SUBTY",
      f: "json",
    });
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await safeJson(res);
    return data?.features?.[0]?.attributes ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Anthropic -- one-paragraph AI summary of the assembled report
// ---------------------------------------------------------------------------

// Returns 3-6 short, specific insight bullets (not a paragraph) for the
// report's Insights panel -- e.g. "Sold 18% below the 2024 comp average" or
// "No permits on file for the 2nd-story addition visible in the lot record."
// Only ever draws on data actually present in `report`; told explicitly not
// to invent figures for sections that came back unavailable.
async function generateInsights(report: Record<string, unknown>, apiKey: string): Promise<string[] | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content:
              "Given this property report JSON, write 3-6 short, specific insight bullets for a homeowner, realtor, buyer, " +
              "or investor -- the kind of thing a sharp analyst would flag at a glance, not a generic summary. " +
              "Each bullet under 20 words. Only use data actually present in the JSON below -- never invent a figure, " +
              "and don't mention sections that are marked unavailable. " +
              'Respond with ONLY a JSON array of strings, e.g. ["...", "..."], no other text.\n\n' +
              JSON.stringify(report),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await safeJson(res);
    const text = data?.content?.find((block: any) => block.type === "text")?.text;
    if (typeof text !== "string") return null;
    const match = text.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : text);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

function assembleReport(address: string, rentcast: any, attom: any, shovels: any, flood: any, soldComps: any[]) {
  const avmSubject = rentcast.avm?.subjectProperty ?? {};
  const attomProp = attom.detail?.property?.[0] ?? null;
  const attomSchools: any[] = attom.schools?.property?.[0]?.school ?? [];
  const attomCommunity = attom.community?.community ?? null;

  const formattedAddress = avmSubject.formattedAddress ?? attomProp?.address?.oneLine ?? address;

  const identity = attomProp
    ? {
        available: true,
        address: formattedAddress,
        apn: attomProp?.identifier?.apn ?? null,
        county: attomProp?.area?.countrySecSubd ?? attomProp?.area?.county ?? null,
        propertyType: attomProp?.summary?.propertyType ?? attomProp?.summary?.propType ?? avmSubject.propertyType ?? null,
        legalDescription: attomProp?.summary?.legal1 ?? null,
        latitude: attomProp?.location?.latitude ?? null,
        longitude: attomProp?.location?.longitude ?? null,
      }
    : { available: true, address: formattedAddress, apn: null, county: null, propertyType: avmSubject.propertyType ?? null };

  const timeline: Array<Record<string, unknown>> = [];
  if (attomProp?.summary?.yearBuilt) {
    timeline.push({ date: String(attomProp.summary.yearBuilt), label: "Constructed" });
  }

  // Full transaction history, not just the single "most recent sale" field --
  // that field only ever holds one entry and doesn't distinguish an actual
  // sale from a refinance (a refinance still records a document, but there's
  // no buyer/seller or sale price, just a new loan amount). Using saleTransType/
  // saleDocType to tell them apart avoids mislabeling a refinance as a sale
  // and, just as importantly, stops a genuine sale from ever getting dropped
  // because a later refinance was the only thing a single-record lookup saw.
  const saleHistoryEntries: any[] = attom.saleHistory?.property?.[0]?.saleHistory ?? [];
  let sawAttomSale = false;
  for (const entry of saleHistoryEntries) {
    const saleAmt = entry.amount?.saleAmt;
    const isFinanceOnly = entry.amount?.saleDocType === "MORTGAGE" || /finance/i.test(entry.amount?.saleTransType ?? "");
    if (saleAmt) {
      sawAttomSale = true;
      timeline.push({ date: entry.saleTransDate, label: `Sold — $${Math.round(saleAmt).toLocaleString()}` });
    } else if (isFinanceOnly && entry.mortgage?.FirstConcurrent?.amount) {
      timeline.push({
        date: entry.saleTransDate,
        label: `Refinanced — $${Math.round(entry.mortgage.FirstConcurrent.amount).toLocaleString()} loan`,
      });
    } else if (entry.saleTransDate) {
      timeline.push({ date: entry.saleTransDate, label: "Ownership record filed" });
    }
  }
  if (!sawAttomSale && avmSubject.lastSaleDate) {
    timeline.push({
      date: avmSubject.lastSaleDate,
      label: `Sold${avmSubject.lastSalePrice ? ` — $${avmSubject.lastSalePrice.toLocaleString()}` : ""}`,
    });
  }

  for (const permit of shovels.permits?.items ?? []) {
    timeline.push({
      date: permit.file_date ?? permit.issue_date ?? permit.start_date ?? null,
      label: `Permit filed — ${permit.description_derived ?? permit.description ?? permit.type ?? "Unspecified work"}`,
    });
  }
  timeline.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

  const ownership = attomProp?.assessment?.owner
    ? {
        available: true,
        ownerNames: [attomProp.assessment.owner.owner1?.fullName, attomProp.assessment.owner.owner2?.fullName]
          .filter(Boolean)
          .join(" & ") || null,
        mailingAddress: attomProp.assessment.owner.mailingAddressOneLine ?? null,
      }
    : unavailable("ATTOM did not return ownership data for this address");

  const land = attomProp?.lot
    ? {
        available: true,
        lotSizeSqft: attomProp.lot.lotSize2 ?? attomProp.lot.lotsize2 ?? null,
        zoning: attomProp.lot.zoningType ?? null,
        frontage: attomProp.lot.frontage ?? null,
      }
    : unavailable("ATTOM did not return lot data for this address");

  const market = rentcast.avm
    ? {
        available: true,
        estimatedValue: rentcast.avm.price ?? null,
        valueRangeLow: rentcast.avm.priceRangeLow ?? null,
        valueRangeHigh: rentcast.avm.priceRangeHigh ?? null,
        rentEstimate: rentcast.rent?.rent ?? null,
        comps: (rentcast.avm.comparables ?? []).slice(0, 5).map((c: any) => ({
          address: c.formattedAddress ?? null,
          price: c.price ?? null,
          squareFootage: c.squareFootage ?? null,
          distanceMiles: c.distance ?? null,
        })),
      }
    : unavailable("RentCast did not return AVM data for this address");

  // /property/detailmortgage can lag behind the full sale/refinance history
  // (seen in practice: it kept returning a 2023 purchase loan after a 2025
  // refinance had already replaced it). Since we already have every
  // transaction's concurrent mortgage from saleHistoryEntries, take whichever
  // dated loan record -- from either source -- is actually the most recent.
  const detailMortgage = attom.mortgage?.property?.[0]?.mortgage ?? null;
  const loanCandidates = [
    ...(detailMortgage?.amount ? [{ amount: detailMortgage.amount, date: detailMortgage.date }] : []),
    ...saleHistoryEntries
      .filter((e) => e.mortgage?.FirstConcurrent?.amount)
      .map((e) => ({ amount: e.mortgage.FirstConcurrent.amount, date: e.mortgage.FirstConcurrent.date || e.saleTransDate })),
  ].filter((c) => c.date);
  loanCandidates.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const mortgageRecord = loanCandidates[0] ?? null;
  const originalLoanAmount = mortgageRecord?.amount || null;
  const estimatedValueForFinance = market.available ? market.estimatedValue : null;
  const finance =
    estimatedValueForFinance && originalLoanAmount
      ? {
          available: true,
          isEstimate: true,
          originalLoanAmount,
          loanRecordedDate: mortgageRecord?.date || null,
          estimatedEquity: Math.round(estimatedValueForFinance - originalLoanAmount),
          estimatedMonthlyPI: (() => {
            const pi = monthlyPayment(originalLoanAmount, ASSUMED_MORTGAGE_RATE_PCT, ASSUMED_MORTGAGE_TERM_YEARS);
            return pi ? Math.round(pi) : null;
          })(),
          assumedRatePct: ASSUMED_MORTGAGE_RATE_PCT,
          assumedTermYears: ASSUMED_MORTGAGE_TERM_YEARS,
          note:
            "Estimated from the original recorded loan amount, not the current payoff balance -- actual equity is likely higher than shown. Monthly payment assumes a " +
            `${ASSUMED_MORTGAGE_RATE_PCT}% 30-year fixed rate, not the loan's actual terms (rate/term aren't part of the public record).`,
        }
      : estimatedValueForFinance
        ? {
            available: true,
            isEstimate: true,
            originalLoanAmount: null,
            estimatedEquity: Math.round(estimatedValueForFinance),
            estimatedMonthlyPI: null,
            note: "No mortgage found on record for this property -- it may be owned free and clear.",
          }
        : unavailable("Need an estimated value to calculate equity");

  const neighborhood = attomSchools.length > 0 || attomCommunity
    ? {
        available: true,
        schools: attomSchools.slice(0, 5).map((s: any) => ({
          name: s?.InstitutionName ?? null,
          rating: s?.schoolRating ?? null,
          distanceMiles: s?.distance ?? null,
        })),
        medianHouseholdIncome: attomCommunity?.demographics?.median_Household_Income ?? null,
        crimeIndex: attomCommunity?.crime?.crime_Index ?? null,
      }
    : unavailable("No school or community data returned for this location");

  const systems = attomProp?.building
    ? {
        available: true,
        livingAreaSqft: attomProp.building.size?.universalSize ?? null,
        bedrooms: attomProp.building.rooms?.beds ?? null,
        bathrooms: attomProp.building.rooms?.bathsTotal ?? null,
        stories: attomProp.building.summary?.levels ?? null,
        construction: attomProp.building.construction?.wallType ?? null,
        yearBuilt: attomProp.summary?.yearBuilt ?? attomProp.summary?.yearbuilt ?? avmSubject.yearBuilt ?? null,
      }
    : { available: !!avmSubject.squareFootage, livingAreaSqft: avmSubject.squareFootage ?? null, bedrooms: avmSubject.bedrooms ?? null, bathrooms: avmSubject.bathrooms ?? null, yearBuilt: avmSubject.yearBuilt ?? null };

  const permitRecords = (shovels.permits?.items ?? []).map((p: any) => ({
    type: p.description_derived ?? p.type ?? "Permit",
    number: p.number ?? null,
    date: p.file_date ?? p.issue_date ?? null,
  }));
  const attomPermits = (attom.permits?.property?.[0]?.buildingPermits ?? []).map((p: any) => ({
    type: p?.type ?? p?.description ?? "Permit",
    number: p?.permitNumber ?? null,
    date: p?.effectiveDate ?? null,
  }));
  const records =
    permitRecords.length > 0 || attomPermits.length > 0 || attomProp?.assessment
      ? {
          available: true,
          assessedValue: attomProp?.assessment?.assessed?.assdTtlValue ?? null,
          taxAmount: attomProp?.assessment?.tax?.taxAmt ?? null,
          permits: permitRecords.length > 0 ? permitRecords : attomPermits,
        }
      : unavailable("No permit or assessment records found");

  // FEMA's "X" zone is the minimal-risk designation; anything else on the
  // map (A/AE/V/VE/AO/AH/etc.) carries some mapped flood risk.
  const floodBucket = flood?.FLD_ZONE
    ? flood.FLD_ZONE === "X"
      ? "Low"
      : /^(V|VE|A|AE|AO|AH)/.test(flood.FLD_ZONE)
        ? "High"
        : "Moderate"
    : null;
  const crimeIndexVal = attomCommunity?.crime?.crime_Index;
  const crimeBucket = typeof crimeIndexVal === "number" ? (crimeIndexVal < 90 ? "Low" : crimeIndexVal < 130 ? "Moderate" : "High") : null;

  const risk = {
    available: !!(floodBucket || crimeBucket),
    reason: !floodBucket && !crimeBucket ? "No risk data returned for this location" : undefined,
    items: [
      floodBucket
        ? { label: "Flood risk", level: floodBucket, detail: `FEMA Zone ${flood.FLD_ZONE}` }
        : { label: "Flood risk", level: null, detail: "Not available for this location" },
      crimeBucket
        ? { label: "Crime risk", level: crimeBucket, detail: `Crime index ${crimeIndexVal}` }
        : { label: "Crime risk", level: null, detail: "Not available for this location" },
      { label: "Wildfire risk", level: null, detail: "Not yet tracked" },
      { label: "Severe weather", level: null, detail: "Not yet tracked" },
      { label: "Environmental", level: null, detail: "Not yet tracked" },
    ],
  };

  const decisions = (shovels.decisions?.items ?? []).map((d: any) => ({
    title: d.title ?? null,
    category: d.category ?? null,
    date: d.decision_date ?? null,
    description: d.description ?? null,
  }));

  // Neighborhood ceiling: a weighted percentile of $/sqft across three comp
  // tiers -- verified closed sales (ATTOM, weight 1.0), pending sales
  // (RentCast, weight 0.6), and active listings (RentCast, weight 0.35) --
  // rather than one flat unweighted pool. Real evidence of what a buyer
  // actually paid should count for more than an asking price nobody has
  // agreed to yet.
  const subjectSqft = systems.available ? systems.livingAreaSqft : avmSubject.squareFootage;
  const compPool: Array<{ value: number; weight: number }> = [];

  for (const c of soldComps) {
    if (c.sqft > 0) compPool.push({ value: c.saleAmt / c.sqft, weight: COMP_WEIGHT.sold });
  }
  for (const c of rentcast.avm?.comparables ?? []) {
    if (!c.price || !c.squareFootage || c.squareFootage <= 0) continue;
    const status = String(c.status ?? "").toLowerCase();
    const weight = status === "pending" ? COMP_WEIGHT.pending : status === "active" ? COMP_WEIGHT.active : null;
    if (weight) compPool.push({ value: c.price / c.squareFootage, weight });
  }

  const soldCompCount = soldComps.length;
  const pendingCompCount = (rentcast.avm?.comparables ?? []).filter((c: any) => String(c.status).toLowerCase() === "pending").length;
  const activeCompCount = (rentcast.avm?.comparables ?? []).filter((c: any) => String(c.status).toLowerCase() === "active").length;

  // Anchor "current value" to the subject's own most recent genuine sale if
  // it happened within the last ~9 months -- a real closed transaction on
  // this exact property beats any model estimate or neighbor comp. Public
  // records can lag 1-3 months, so a very recent sale may not show up yet.
  const recentOwnSale = saleHistoryEntries
    .filter((e) => e.amount?.saleAmt && e.saleTransDate)
    .sort((a, b) => String(b.saleTransDate).localeCompare(String(a.saleTransDate)))[0];
  const daysSinceOwnSale = recentOwnSale
    ? (Date.now() - new Date(recentOwnSale.saleTransDate).getTime()) / (1000 * 60 * 60 * 24)
    : null;
  const hasRecentOwnSale = daysSinceOwnSale != null && daysSinceOwnSale <= 270;
  const currentValue = hasRecentOwnSale ? recentOwnSale.amount.saleAmt : market.available ? market.estimatedValue : null;

  let neighborhoodCeiling: { low: number; high: number } | null = null;
  if (subjectSqft && subjectSqft > 0 && compPool.length >= 3) {
    const lowPerSqft = weightedPercentile(compPool, 0.6);
    const highPerSqft = weightedPercentile(compPool, 0.8);
    if (lowPerSqft && highPerSqft) {
      let low = lowPerSqft * subjectSqft;
      let high = highPerSqft * subjectSqft;
      const outerCap = currentValue ? currentValue * 1.25 : high;
      high = Math.min(high, outerCap);
      low = Math.min(low, high);
      if (!hasRecentOwnSale && market.available && market.valueRangeHigh) {
        low = Math.max(low, Math.min(market.valueRangeHigh, high));
      }
      if (high <= low) high = low * 1.03;
      neighborhoodCeiling = { low: Math.round(low), high: Math.round(high) };
    }
  }

  const potential: Record<string, unknown> = {};
  if (neighborhoodCeiling && currentValue) {
    const renovationLow = Math.max(0, neighborhoodCeiling.low - currentValue);
    const renovationHigh = Math.max(0, neighborhoodCeiling.high - currentValue);
    potential.available = true;
    potential.neighborhoodCeiling = neighborhoodCeiling;
    potential.renovationPotential = { low: Math.round(renovationLow), high: Math.round(renovationHigh) };
    potential.overCapitalizationRisk = renovationHigh > currentValue * 0.3;
    potential.confidence = soldCompCount >= 5 ? "high" : soldCompCount >= 2 ? "medium" : "low";
    potential.compsUsed = { sold: soldCompCount, pending: pendingCompCount, active: activeCompCount };
    potential.methodologyNote =
      "Weighted toward verified closed sales over pending/active listings. Active listings without a corroborating sold or pending comp carry the least weight -- RentCast doesn't expose price-reduction history, so \"stale\" asking prices aren't specifically down-weighted beyond their base tier.";
  } else {
    potential.available = false;
    potential.reason =
      compPool.length < 3
        ? "Not enough verified sales, pending sales, or active listings nearby to estimate a ceiling"
        : "Missing a current value or subject square footage to anchor the calculation";
  }
  if (decisions.length > 0) {
    potential.available = true;
    potential.nearbyDecisions = decisions;
  }
  if (!potential.available && decisions.length === 0) {
    potential.reason = potential.reason || "No nearby zoning/planning decisions found on record";
  }

  return {
    address: { input: address, formatted: formattedAddress },
    identity,
    timeline,
    photos: unavailable("MLS/interior photos require an IDX license — not in scope yet"),
    ownership,
    land,
    market,
    finance,
    neighborhood,
    systems,
    records,
    risk,
    potential,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const rentcastKey = Deno.env.get("RENTCAST_API_KEY");
  const attomKey = Deno.env.get("ATTOM_API_KEY");
  const shovelsKey = Deno.env.get("SHOVELS_API_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is not configured for this request." }, 500);
  }

  let address: string | undefined;
  let forceRefresh = false;
  let sessionId: string | undefined;
  try {
    const body = await req.json();
    address = typeof body?.address === "string" ? body.address.trim() : undefined;
    forceRefresh = body?.refresh === true;
    sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : undefined;
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  if (!address || address.length < 8 || !/\d/.test(address)) {
    return jsonResponse({ error: "Please enter a full street address, city, state, and ZIP." }, 400);
  }
  if (!sessionId) {
    return jsonResponse({ error: "Payment required." }, 402);
  }

  const restHeaders = {
    "Content-Type": "application/json",
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  // Payment gate. Every request -- including a cache hit -- needs a session
  // that genuinely paid for *this* address. A cached report is a cost
  // optimization for us, not a free-access loophole for whoever guesses an
  // address someone else already paid to look up.
  //
  // Fast path: this exact session has already been recorded (a repeat visit
  // via a saved/bookmarked link, or the "Refresh data" button). Slow path:
  // first time seeing this session_id, so verify it against Stripe directly
  // and record it if it checks out.
  const purchaseRes = await fetch(
    `${supabaseUrl}/rest/v1/property_fingerprint_purchases?stripe_session_id=eq.${encodeURIComponent(sessionId)}&limit=1`,
    { headers: restHeaders },
  );
  const existingPurchase = purchaseRes.ok ? (await safeJson(purchaseRes))?.[0] : null;

  if (existingPurchase) {
    if (existingPurchase.address_input.toLowerCase() !== address.toLowerCase()) {
      return jsonResponse({ error: "This payment does not match the requested address." }, 402);
    }
  } else {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      return jsonResponse({ error: "Server is not configured for this request." }, 500);
    }
    const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!stripeRes.ok) {
      return jsonResponse({ error: "We couldn't verify that payment. Please pay again to view this report." }, 402);
    }
    const session = await safeJson(stripeRes);
    const paidAddress = typeof session?.metadata?.address === "string" ? session.metadata.address : "";
    if (session?.payment_status !== "paid" || paidAddress.toLowerCase() !== address.toLowerCase()) {
      return jsonResponse({ error: "Payment for this report has not completed yet." }, 402);
    }
    // The webhook may have already recorded this exact session between the
    // customer paying and their browser finishing the redirect back here --
    // ignore-on-conflict so neither path errors when the other already won.
    await fetch(`${supabaseUrl}/rest/v1/property_fingerprint_purchases?on_conflict=stripe_session_id`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        address_input: address,
        email: session.customer_details?.email ?? null,
        stripe_session_id: sessionId,
        stripe_payment_intent_id: session.payment_intent ?? null,
        amount_cents: session.amount_total ?? null,
      }),
    });
  }

  // Cache check -- exact (case-insensitive) match on the raw input string.
  // Good enough for now; a fuzzier normalized-address match can follow once
  // there's real repeat-lookup traffic to justify it.
  if (!forceRefresh) {
    const cacheRes = await fetch(
      `${supabaseUrl}/rest/v1/property_fingerprint_reports?address_input=ilike.${encodeURIComponent(address)}&order=created_at.desc&limit=1`,
      { headers: restHeaders },
    );
    if (cacheRes.ok) {
      const cached = await safeJson(cacheRes);
      const row = cached?.[0];
      if (row?.report && row?.fetched_at) {
        const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays < CACHE_TTL_DAYS) {
          return jsonResponse({ report: row.report });
        }
      }
    }
  }

  if (!rentcastKey && !attomKey) {
    return jsonResponse({ error: "Server is not configured for this request." }, 500);
  }

  const [rentcastResult, attomResult, shovelsResult] = await Promise.allSettled([
    rentcastKey ? fetchRentCast(address, rentcastKey) : Promise.resolve({ avm: null, rent: null }),
    attomKey ? fetchAttom(address, attomKey) : Promise.resolve({ detail: null, permits: null, community: null }),
    shovelsKey ? fetchShovels(address, shovelsKey) : Promise.resolve({ permits: null, decisions: null }),
  ]);

  const rentcast = rentcastResult.status === "fulfilled" ? rentcastResult.value : { avm: null, rent: null };
  const attom = attomResult.status === "fulfilled" ? attomResult.value : { detail: null, permits: null, community: null };
  const shovels = shovelsResult.status === "fulfilled" ? shovelsResult.value : { permits: null, decisions: null };

  const lat =
    attom.detail?.property?.[0]?.location?.latitude ?? rentcast.avm?.subjectProperty?.latitude ?? null;
  const lon =
    attom.detail?.property?.[0]?.location?.longitude ?? rentcast.avm?.subjectProperty?.longitude ?? null;

  const [floodResult, soldCompsResult] = await Promise.allSettled([
    lat && lon ? fetchFloodZone(Number(lat), Number(lon)) : Promise.resolve(null),
    lat && lon && attomKey ? fetchSoldComps(Number(lat), Number(lon), attomKey) : Promise.resolve([]),
  ]);
  const flood = floodResult.status === "fulfilled" ? floodResult.value : null;
  const soldComps = soldCompsResult.status === "fulfilled" ? soldCompsResult.value : [];

  const report = assembleReport(address, rentcast, attom, shovels, flood, soldComps);

  if (anthropicKey) {
    const insights = await generateInsights(report, anthropicKey);
    (report as Record<string, unknown>).insights = insights;
  }

  // Cache the result. Best-effort -- a failed write shouldn't fail the
  // response, since the report was already successfully assembled.
  try {
    await fetch(`${supabaseUrl}/rest/v1/property_fingerprint_reports`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        address_input: address,
        address_formatted: report.address.formatted,
        apn: report.identity?.apn ?? null,
        raw_sources: { rentcast: rentcast.avm, attom: attom.detail, shovels: shovels.permits, flood, soldComps },
        report,
        fetched_at: new Date().toISOString(),
      }),
    });
  } catch {
    // Swallowed -- the report is already computed and about to be returned.
  }

  return jsonResponse({ report });
});
