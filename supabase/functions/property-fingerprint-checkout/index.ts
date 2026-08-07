// Supabase Edge Function: property-fingerprint-checkout
//
// Creates a $10 Stripe Checkout Session for a single Property Fingerprint
// report. The address being paid for travels in the session's metadata, so
// the property-fingerprint function can confirm (once the user is redirected
// back with a session_id) that this exact session actually paid for this
// exact address -- not just that *a* payment happened somewhere.
//
// Request shape: POST { address } -> { url }
// The frontend redirects the browser to the returned Stripe-hosted URL.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REPORT_PRICE_CENTS = 1000; // $10.00

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return jsonResponse({ error: "Server is not configured for this request." }, 500);
  }

  const numberInRange = (value: unknown, min: number, max: number): number | undefined => {
    const n = typeof value === "number" ? value : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };

  let address: string | undefined;
  let origin: string | undefined;
  let bedrooms: number | undefined;
  let bathrooms: number | undefined;
  let squareFootage: number | undefined;
  try {
    const body = await req.json();
    address = typeof body?.address === "string" ? body.address.trim() : undefined;
    origin = typeof body?.origin === "string" ? body.origin.replace(/\/$/, "") : undefined;
    bedrooms = numberInRange(body?.bedrooms, 0, 20);
    bathrooms = numberInRange(body?.bathrooms, 0, 20);
    squareFootage = numberInRange(body?.squareFootage, 100, 50000);
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  if (!address || address.length < 8 || !/\d/.test(address)) {
    return jsonResponse({ error: "Please enter a full street address, city, state, and ZIP." }, 400);
  }
  if (!origin || !/^https?:\/\//.test(origin)) {
    return jsonResponse({ error: "Missing request origin." }, 400);
  }

  const successUrl = `${origin}/property-fingerprint.html?address=${encodeURIComponent(address)}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/property-fingerprint.html?address=${encodeURIComponent(address)}&checkout=cancelled`;

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(REPORT_PRICE_CENTS));
  params.set("line_items[0][price_data][product_data][name]", "Property Fingerprint Report");
  params.set("line_items[0][price_data][product_data][description]", address);
  params.set("metadata[address]", address);
  if (bedrooms != null) params.set("metadata[bedrooms]", String(bedrooms));
  if (bathrooms != null) params.set("metadata[bathrooms]", String(bathrooms));
  if (squareFootage != null) params.set("metadata[squareFootage]", String(squareFootage));
  params.set("customer_creation", "if_required");
  params.set("allow_promotion_codes", "true");

  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch {
    return jsonResponse({ error: "Could not reach the payment provider. Try again shortly." }, 502);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) {
    return jsonResponse({ error: data?.error?.message || "Could not start checkout. Try again." }, 502);
  }

  return jsonResponse({ url: data.url });
});
