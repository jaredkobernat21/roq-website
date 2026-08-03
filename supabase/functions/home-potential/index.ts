// Supabase Edge Function: home-potential
//
// Takes a homeowner's address, calls RentCast's AVM value-estimate endpoint
// (subject property value + nearby comparable listings), and applies a
// rules-based "neighborhood ceiling" + renovation-potential calculation on
// top of the raw comp data. The RentCast API key stays server-side only.
//
// This function powers the FREE preview: it computes the full numbers
// internally and logs them to `home_potential_interest` (service-role only,
// never exposed to the anon key) for the future $99 manual report pipeline,
// but only returns a qualitative "gap bucket" to the client -- the exact
// ceiling/renovation-potential figures and comps are the paid product, so
// they never go out over the wire on this free endpoint.
//
// Two request shapes:
//   1. Lookup:        POST { address, bedrooms?, bathrooms?, squareFootage? }
//      -> 200 { estimatedValue, confidence, gapBucket, gapHeadline,
//               gapMessage, squareFootageAvailable, previewId, subject }
//   2. Claim interest: POST { previewId, email }
//      -> 200 { ok: true }

const RENTCAST_BASE_URL = "https://api.rentcast.io/v1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface RentCastComparable {
  formattedAddress?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  price?: number;
  status?: string;
  distance?: number;
  daysOld?: number;
  correlation?: number;
}

interface RentCastSubject {
  formattedAddress?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  yearBuilt?: number;
  lastSaleDate?: string;
  lastSalePrice?: number;
}

interface RentCastAvmResponse {
  price?: number;
  priceRangeLow?: number;
  priceRangeHigh?: number;
  subjectProperty?: RentCastSubject;
  comparables?: RentCastComparable[];
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function round(n: number, step = 1000): number {
  return Math.round(n / step) * step;
}

/**
 * Builds the "neighborhood ceiling" and renovation-potential range from a
 * subject property and its RentCast comparables. Rules:
 *
 * 1. Comp pool = comparables of the same property type, within ~30% of the
 *    subject's square footage, within 2 miles. Size-matching only runs when
 *    the subject's own square footage is known -- if RentCast couldn't pull
 *    it from public records, we can't tell a same-size comp from a comp
 *    half the size, so the pool (and any comp-based math) is skipped
 *    entirely rather than silently comparing against mismatched homes.
 * 2. Ceiling low  = 75th-percentile $/sqft of that pool x subject sqft.
 *    Ceiling high = 90th-percentile $/sqft of that pool x subject sqft.
 * 3. The ceiling is floored at RentCast's own priceRangeHigh (their AVM's
 *    upper uncertainty band, grounded in recorded sales data) so it never
 *    sits below the model's own high estimate.
 * 4. Ceiling high is capped at 1.35x the current estimated value -- beyond
 *    that a "ceiling" isn't credible off a handful of listing comps.
 * 5. Renovation potential = ceiling minus current estimated value, floored
 *    at 0. Flagged as over-capitalization risk once it exceeds 30% of
 *    current value (the standard real-estate "30% rule" for avoiding
 *    renovation spend the market won't return).
 * 6. Every code path always produces low < high -- a flat, zero-width
 *    "ceiling" is never a meaningful answer, so it's treated as a bug
 *    rather than a valid result.
 */
function computeHomePotential(avm: RentCastAvmResponse) {
  const subject = avm.subjectProperty ?? {};
  const price = avm.price ?? 0;
  const sqft = subject.squareFootage ?? 0;
  const hasSqft = sqft > 0;
  const comparables = avm.comparables ?? [];

  const pool = hasSqft
    ? comparables.filter((c) => {
        if (!c.price || !c.squareFootage || c.squareFootage <= 0) return false;
        if (subject.propertyType && c.propertyType && c.propertyType !== subject.propertyType) return false;
        if (Math.abs(c.squareFootage - sqft) / sqft > 0.3) return false;
        if (c.distance != null && c.distance > 2) return false;
        if (subject.bedrooms != null && c.bedrooms != null && Math.abs(c.bedrooms - subject.bedrooms) > 1) return false;
        return true;
      })
    : [];

  const ppsfList = pool
    .map((c) => (c.price as number) / (c.squareFootage as number))
    .sort((a, b) => a - b);

  let ceilingLow: number;
  let ceilingHigh: number;

  if (hasSqft && ppsfList.length >= 3) {
    ceilingLow = percentile(ppsfList, 0.75) * sqft;
    ceilingHigh = percentile(ppsfList, 0.9) * sqft;

    const outerCap = price > 0 ? price * 1.35 : ceilingHigh;
    ceilingHigh = Math.min(ceilingHigh, outerCap);
    ceilingLow = Math.min(ceilingLow, ceilingHigh);

    if (avm.priceRangeHigh) {
      ceilingLow = Math.max(ceilingLow, Math.min(avm.priceRangeHigh, ceilingHigh));
    }
  } else if (avm.priceRangeHigh && avm.priceRangeHigh > price) {
    // Not enough size-matched comps to trust a percentile calc -- fall back
    // to RentCast's own AVM uncertainty band instead of a comp-derived one.
    ceilingLow = avm.priceRangeHigh;
    ceilingHigh = avm.priceRangeHigh * 1.08;
  } else {
    // No usable comps and no informative price range from the provider --
    // a conservative flat premium beats a zero-width "ceiling".
    ceilingLow = price * 1.05;
    ceilingHigh = price * 1.15;
  }

  if (ceilingHigh <= ceilingLow) {
    ceilingHigh = ceilingLow * 1.03;
  }

  const renovationLow = Math.max(0, ceilingLow - price);
  const renovationHigh = Math.max(0, ceilingHigh - price);
  const overCapitalizationRisk = price > 0 && renovationHigh > price * 0.3;

  const distances = pool.filter((c) => c.distance != null).map((c) => c.distance as number);
  const avgDistance = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null;
  const activeCount = pool.filter((c) => c.status === "Active").length;

  let confidence: "high" | "medium" | "low";
  if (!hasSqft) {
    confidence = "low";
  } else if (pool.length >= 8 && avgDistance != null && avgDistance <= 1 && activeCount >= 2) {
    confidence = "high";
  } else if (pool.length >= 4) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  // Only surface comps as supporting evidence when they were actually
  // validated against the subject's size. Otherwise a "comp" could be half
  // the square footage and tens of thousands cheaper -- misleading rather
  // than informative.
  const topComps = hasSqft
    ? [...pool]
        .sort((a, b) => (b.correlation ?? 0) - (a.correlation ?? 0))
        .slice(0, 5)
        .map((c) => ({
          address: c.formattedAddress ?? null,
          price: c.price ?? null,
          squareFootage: c.squareFootage ?? null,
          distanceMiles: c.distance ?? null,
          status: c.status ?? null,
        }))
    : [];

  return {
    estimatedValue: round(price),
    ceiling: { low: round(ceilingLow), high: round(ceilingHigh) },
    renovationPotential: { low: round(renovationLow), high: round(renovationHigh) },
    overCapitalizationRisk,
    confidence,
    compsUsed: hasSqft ? pool.length : 0,
    comps: topComps,
    squareFootageAvailable: hasSqft,
    subject: {
      address: subject.formattedAddress ?? null,
      propertyType: subject.propertyType ?? null,
      bedrooms: subject.bedrooms ?? null,
      bathrooms: subject.bathrooms ?? null,
      squareFootage: subject.squareFootage ?? null,
      yearBuilt: subject.yearBuilt ?? null,
    },
  };
}

/**
 * Buckets the gap between ceiling and current value into a qualitative
 * headline/message -- this is what the free tier actually shows. The exact
 * dollar figures behind it are the paid product.
 */
function gapBucket(estimatedValue: number, ceilingHigh: number) {
  const gapPercent = estimatedValue > 0 ? (ceilingHigh - estimatedValue) / estimatedValue : 0;

  if (gapPercent >= 0.15) {
    return {
      bucket: "significant",
      headline: "Significant Renovation Room",
      message:
        "Your home's neighborhood ceiling sits notably above its estimated value — there may be real upside if you renovate strategically.",
    };
  }
  if (gapPercent >= 0.05) {
    return {
      bucket: "moderate",
      headline: "Some Renovation Room",
      message:
        "There's a modest gap between your home's value and what this neighborhood supports — worth understanding before you invest in upgrades.",
    };
  }
  return {
    bucket: "near_ceiling",
    headline: "Near the Neighborhood Ceiling",
    message:
      "Your home is already close to the top of what buyers pay on this block. Be cautious about over-improving — the market may not pay back much more.",
  };
}

async function logInterestRow(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/home_potential_interest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) return null;
    const inserted = await res.json();
    return inserted?.[0]?.id ?? null;
  } catch {
    return null;
  }
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

  const numberInRange = (value: unknown, min: number, max: number): number | undefined => {
    const n = typeof value === "number" ? value : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };

  // Shape 2: claiming a previously-computed preview with an email address,
  // for the $99 report follow-up. No RentCast call needed here.
  let earlyBody: Record<string, unknown> | undefined;
  try {
    earlyBody = await req.clone().json();
  } catch {
    earlyBody = undefined;
  }
  if (earlyBody && typeof earlyBody.previewId === "string" && typeof earlyBody.email === "string" && !earlyBody.address) {
    const email = earlyBody.email.trim();
    if (!email || !email.includes("@")) {
      return jsonResponse({ error: "Please enter a valid email address." }, 400);
    }
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Server is not configured for this request." }, 500);
    }
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/home_potential_interest?id=eq.${encodeURIComponent(earlyBody.previewId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({ email, email_captured_at: new Date().toISOString() }),
      },
    );
    if (!patchRes.ok) {
      return jsonResponse({ error: "Could not save your request. Please try again." }, 502);
    }
    return jsonResponse({ ok: true }, 200);
  }

  let address: string | undefined;
  let overrideBedrooms: number | undefined;
  let overrideBathrooms: number | undefined;
  let overrideSquareFootage: number | undefined;
  try {
    const body = await req.json();
    address = typeof body?.address === "string" ? body.address.trim() : undefined;
    overrideBedrooms = numberInRange(body?.bedrooms, 0, 20);
    overrideBathrooms = numberInRange(body?.bathrooms, 0, 20);
    overrideSquareFootage = numberInRange(body?.squareFootage, 100, 50000);
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  if (!address || address.length < 8 || !/\d/.test(address)) {
    return jsonResponse({ error: "Please enter a full street address, city, state, and ZIP." }, 400);
  }

  const apiKey = Deno.env.get("RENTCAST_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "Server is not configured for this request." }, 500);
  }

  // User-supplied bed/bath/sqft override incomplete or missing public-records
  // data -- both for RentCast's own AVM calculation and comp selection, and
  // as a fallback for our own comp-filtering logic below.
  const overrideParams = new URLSearchParams({ address, compCount: "25" });
  if (overrideBedrooms != null) overrideParams.set("bedrooms", String(overrideBedrooms));
  if (overrideBathrooms != null) overrideParams.set("bathrooms", String(overrideBathrooms));
  if (overrideSquareFootage != null) overrideParams.set("squareFootage", String(overrideSquareFootage));

  const url = `${RENTCAST_BASE_URL}/avm/value?${overrideParams.toString()}`;

  let avmResponse: Response;
  try {
    avmResponse = await fetch(url, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
  } catch {
    return jsonResponse({ error: "Could not reach the property data provider. Try again shortly." }, 502);
  }

  if (avmResponse.status === 404) {
    return jsonResponse({ error: "We couldn't find that address. Double-check the spelling and ZIP code." }, 404);
  }
  if (!avmResponse.ok) {
    return jsonResponse({ error: "Property data provider error. Try again shortly." }, 502);
  }

  const avm = (await avmResponse.json()) as RentCastAvmResponse;
  if (!avm.price) {
    return jsonResponse({ error: "Not enough data to estimate this property yet." }, 422);
  }

  // Trust what the homeowner told us over whatever RentCast echoes back --
  // public records can be missing or stale, and this is what actually
  // drives our own comp-filtering and ceiling math below.
  if (overrideBedrooms != null || overrideBathrooms != null || overrideSquareFootage != null) {
    avm.subjectProperty = {
      ...avm.subjectProperty,
      ...(overrideBedrooms != null ? { bedrooms: overrideBedrooms } : {}),
      ...(overrideBathrooms != null ? { bathrooms: overrideBathrooms } : {}),
      ...(overrideSquareFootage != null ? { squareFootage: overrideSquareFootage } : {}),
    };
  }

  const result = computeHomePotential(avm);
  const gap = gapBucket(result.estimatedValue, result.ceiling.high);

  let previewId: string | null = null;
  if (supabaseUrl && serviceRoleKey) {
    previewId = await logInterestRow(supabaseUrl, serviceRoleKey, {
      address: result.subject.address ?? address,
      estimated_value: result.estimatedValue,
      ceiling_low: result.ceiling.low,
      ceiling_high: result.ceiling.high,
      renovation_low: result.renovationPotential.low,
      renovation_high: result.renovationPotential.high,
      gap_bucket: gap.bucket,
      confidence: result.confidence,
      square_footage_available: result.squareFootageAvailable,
    });
  }

  // Free-tier response: the headline ranges, clearly framed as a quick
  // automated preview. The specific comps we'd personally review, the
  // renovation roadmap, budgets, and ROI reasoning are the $99 report.
  return jsonResponse(
    {
      estimatedValue: result.estimatedValue,
      ceiling: result.ceiling,
      renovationPotential: result.renovationPotential,
      overCapitalizationRisk: result.overCapitalizationRisk,
      confidence: result.confidence,
      compsUsed: result.compsUsed,
      squareFootageAvailable: result.squareFootageAvailable,
      gapBucket: gap.bucket,
      gapHeadline: gap.headline,
      gapMessage: gap.message,
      previewId,
      subject: { address: result.subject.address },
    },
    200,
  );
});
