// Supabase Edge Function: roq-plan-checkout
//
// Starts a Stripe Checkout Session for a paid ROQ plan (Home Value Potential
// today). The intake answers are saved first as a pending plan_orders row,
// so they are on record even if the customer never finishes paying; the
// order id rides on the session (client_reference_id + metadata) and
// roq-plan-webhook marks the order paid once Stripe confirms it.
//
// The price is never taken from the browser: each plan maps to a Stripe
// Price ID held in a function secret. A plan whose secret isn't set simply
// isn't purchasable, which is how Renovation Plan stays off until its price
// exists.
//
// Request shape: POST { plan, address, email, summary, intake, origin } -> { url }
// The frontend redirects the browser to the returned Stripe-hosted URL.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLANS: Record<string, { name: string; priceEnv: string; page: string }> = {
  potential: { name: "Home Value Potential", priceEnv: "ROQ_STRIPE_PRICE_POTENTIAL", page: "/potential.html" },
  renovation: { name: "Renovation Plan", priceEnv: "ROQ_STRIPE_PRICE_RENOVATION", page: "/renovate.html" },
};

// Where Stripe may send the customer back to. Anything else is refused, so
// the function can't be used to bounce people to someone else's site.
function allowedOrigin(origin: string): boolean {
  return origin === "https://roqhome.com" || origin === "https://www.roqhome.com" ||
    /^http:\/\/localhost(:\d+)?$/.test(origin);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const stripeKey = Deno.env.get("ROQ_STRIPE_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!stripeKey || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Checkout isn't available right now. Please try again later." }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const planKey = text(body.plan, 40);
  const plan = PLANS[planKey];
  let priceId = plan ? Deno.env.get(plan.priceEnv) : undefined;
  if (!plan || !priceId) {
    return jsonResponse({ error: "This plan isn't available for purchase yet." }, 400);
  }

  // The secret may hold a Product ID (prod_...) instead of a Price ID; use
  // that product's default price.
  if (priceId.startsWith("prod_")) {
    const productRes = await fetch(`https://api.stripe.com/v1/products/${encodeURIComponent(priceId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    }).catch(() => null);
    const product = productRes && productRes.ok ? await productRes.json().catch(() => null) : null;
    const defaultPrice = typeof product?.default_price === "string" ? product.default_price : product?.default_price?.id;
    if (!defaultPrice) {
      return jsonResponse({ error: "This plan isn't available for purchase yet." }, 400);
    }
    priceId = defaultPrice;
  }

  const address = text(body.address, 300);
  const email = text(body.email, 200);
  const summary = text(body.summary, 4000);
  const origin = text(body.origin, 200).replace(/\/$/, "");
  const intake = body.intake && typeof body.intake === "object" && !Array.isArray(body.intake) ? body.intake : null;

  if (address.length < 8) {
    return jsonResponse({ error: "Please enter the full property address." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "Please enter a valid email address." }, 400);
  }
  if (!allowedOrigin(origin)) {
    return jsonResponse({ error: "Missing request origin." }, 400);
  }

  const restHeaders = {
    "Content-Type": "application/json",
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  // 1. Save the order as pending.
  const orderRes = await fetch(`${supabaseUrl}/rest/v1/plan_orders`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ plan: planKey, address, email, summary, intake }),
  });
  const orderRows = await orderRes.json().catch(() => null);
  const orderId = orderRes.ok && Array.isArray(orderRows) ? orderRows[0]?.id : null;
  if (!orderId) {
    return jsonResponse({ error: "Could not save your request. Please try again." }, 502);
  }

  // 2. Create the Checkout Session.
  const back = `${origin}${plan.page}`;
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("customer_email", email);
  params.set("client_reference_id", orderId);
  params.set("metadata[order_id]", orderId);
  params.set("metadata[plan]", planKey);
  params.set("payment_intent_data[metadata][order_id]", orderId);
  params.set("payment_intent_data[description]", `${plan.name}: ${address}`);
  params.set("success_url", `${back}?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${back}?checkout=cancelled`);
  params.set("allow_promotion_codes", "true");

  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `plan-order-${orderId}`,
      },
      body: params.toString(),
    });
  } catch {
    return jsonResponse({ error: "Could not reach the payment provider. Try again shortly." }, 502);
  }

  const session = await res.json().catch(() => null);
  if (!res.ok || !session?.url) {
    return jsonResponse({ error: session?.error?.message || "Could not start checkout. Try again." }, 502);
  }

  // 3. Remember which session belongs to the order (best effort: the webhook
  //    finds the order by its id either way).
  await fetch(`${supabaseUrl}/rest/v1/plan_orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: { ...restHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ stripe_session_id: session.id }),
  }).catch(() => {});

  return jsonResponse({ url: session.url });
});
