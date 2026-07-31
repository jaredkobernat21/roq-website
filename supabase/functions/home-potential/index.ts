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
 *    subject's square footage, within 2 miles.
 * 2. Ceiling low  = 75th-percentile $/sqft of that pool x subject sqft.
 *    Ceiling high = 90th-percentile $/sqft of that pool x subject sqft.
 * 3. Both ends are floored at RentCast's own priceRangeHigh (their AVM's
 *    upper uncertainty band, grounded in recorded sales data) so the
 *    ceiling never sits below the model's own high estimate.
 * 4. Ceiling high is capped at 1.35x the current estimated value -- beyond
 *    that a "ceiling" isn't credible off a handful of listing comps.
 * 5. Renovation potential = ceiling minus current estimated value, floored
 *    at 0. Flagged as over-capitalization risk once it exceeds 30% of
 *    current value (the standard real-estate "30% rule" for avoiding
 *    renovation spend the market won't return).
 */
function computeHomePotential(avm: RentCastAvmResponse) {
  const subject = avm.subjectProperty ?? {};
  const price = avm.price ?? 0;
  const sqft = subject.squareFootage ?? 0;
  const comparables = avm.comparables ?? [];

  const pool = comparables.filter((c) => {
    if (!c.price || !c.squareFootage || c.squareFootage <= 0) return false;
    if (subject.propertyType && c.propertyType && c.propertyType !== subject.propertyType) return false;
    if (sqft > 0 && Math.abs(c.squareFootage - sqft) / sqft > 0.3) return false;
    if (c.distance != null && c.distance > 2) return false;
    if (subject.bedrooms != null && c.bedrooms != null && Math.abs(c.bedrooms - subject.bedrooms) > 1) return false;
    return true;
  });

  const ppsfList = pool
    .map((c) => (c.price as number) / (c.squareFootage as number))
    .sort((a, b) => a - b);

  let ceilingLow = 0;
  let ceilingHigh = 0;

  if (sqft > 0 && ppsfList.length >= 3) {
    ceilingLow = percentile(ppsfList, 0.75) * sqft;
    ceilingHigh = percentile(ppsfList, 0.9) * sqft;
  } else if (avm.priceRangeHigh) {
    // Not enough comps to trust a percentile calc -- fall back to
    // RentCast's own AVM uncertainty band.
    ceilingLow = avm.priceRangeHigh;
    ceilingHigh = avm.priceRangeHigh * 1.08;
  } else {
    ceilingLow = price;
    ceilingHigh = price;
  }

  if (avm.priceRangeHigh) {
    ceilingLow = Math.max(ceilingLow, avm.priceRangeHigh);
    ceilingHigh = Math.max(ceilingHigh, avm.priceRangeHigh);
  }

  const outerCap = price > 0 ? price * 1.35 : ceilingHigh;
  ceilingHigh = Math.min(ceilingHigh, outerCap);
  ceilingLow = Math.min(ceilingLow, ceilingHigh);

  const renovationLow = Math.max(0, ceilingLow - price);
  const renovationHigh = Math.max(0, ceilingHigh - price);
  const overCapitalizationRisk = price > 0 && renovationHigh > price * 0.3;

  const distances = pool.filter((c) => c.distance != null).map((c) => c.distance as number);
  const avgDistance = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null;
  const activeCount = pool.filter((c) => c.status === "Active").length;

  let confidence: "high" | "medium" | "low";
  if (pool.length >= 8 && avgDistance != null && avgDistance <= 1 && activeCount >= 2) {
    confidence = "high";
  } else if (pool.length >= 4) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  const topComps = [...pool]
    .sort((a, b) => (b.correlation ?? 0) - (a.correlation ?? 0))
    .slice(0, 5)
    .map((c) => ({
      address: c.formattedAddress ?? null,
      price: c.price ?? null,
      squareFootage: c.squareFootage ?? null,
      distanceMiles: c.distance ?? null,
      status: c.status ?? null,
    }));

  return {
    estimatedValue: round(price),
    ceiling: { low: round(ceilingLow), high: round(ceilingHigh) },
    renovationPotential: { low: round(renovationLow), high: round(renovationHigh) },
    overCapitalizationRisk,
    confidence,
    compsUsed: pool.length,
    comps: topComps,
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

  let address: string | undefined;
  try {
    const body = await req.json();
    address = typeof body?.address === "string" ? body.address.trim() : undefined;
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

  const url = `${RENTCAST_BASE_URL}/avm/value?address=${encodeURIComponent(address)}&compCount=25`;

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

  const result = computeHomePotential(avm);
  return jsonResponse(result, 200);
});
