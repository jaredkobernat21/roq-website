// Supabase Edge Function: home-potential
//
// Takes a homeowner's address, calls RentCast's AVM value-estimate endpoint
// (subject property value + nearby comparable listings), and applies a
// rules-based "neighborhood ceiling" + renovation-potential calculation on
// top of the raw comp data. The RentCast API key stays server-side only.
//
// Request:  POST { "address": "123 Main St, Springfield, IL 62704" }
// Response: 200 HomePotentialResult | 4xx/5xx { error: string }

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const numberInRange = (value: unknown, min: number, max: number): number | undefined => {
    const n = typeof value === "number" ? value : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };

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
  return jsonResponse(result, 200);
});
