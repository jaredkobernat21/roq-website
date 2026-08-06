// Supabase Edge Function: property-fingerprint-webhook
//
// Stripe webhook receiver for the Property Fingerprint $10 checkout. This is
// a reliability safety net, not the primary unlock path: today, a paid
// report unlocks when the customer's browser redirects back from Stripe with
// a session_id (handled in property-fingerprint/index.ts). That redirect can
// fail to arrive -- closed tab, network blip, browser back button -- leaving
// a real Stripe charge with no record on our side and no way for the
// customer to get back into a report they paid for.
//
// This function listens for `checkout.session.completed` directly from
// Stripe's servers (which doesn't depend on the customer's browser doing
// anything) and records the purchase immediately. Between this and the
// redirect path, whichever arrives first wins -- the insert is idempotent
// on stripe_session_id (see property-fingerprint/index.ts's matching
// upsert), so there's no double-write and no error either way.
//
// Deployed with --no-verify-jwt: Stripe calls this directly and will never
// send our anon key, only its own Stripe-Signature header, which is what
// actually authenticates the request here.

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Manual Stripe webhook signature verification (HMAC-SHA256 over
// "{timestamp}.{rawBody}"), using Deno's Web Crypto rather than pulling in
// the Stripe SDK for one operation. Rejects stale signatures (>5 min old) to
// guard against replay of a captured payload.
async function verifyStripeSignature(rawBody: string, sigHeader: string | null, secret: string): Promise<boolean> {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts["t"];
  const v1 = parts["v1"];
  if (!timestamp || !v1) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookSecret || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is not configured for this request." }, 500);
  }

  // Signature verification needs the exact raw bytes Stripe signed -- must
  // read the body as text before any JSON parsing touches it.
  const rawBody = await req.text();
  const valid = await verifyStripeSignature(rawBody, req.headers.get("Stripe-Signature"), webhookSecret);
  if (!valid) {
    return jsonResponse({ error: "Invalid signature." }, 400);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid payload." }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    const address = typeof session?.metadata?.address === "string" ? session.metadata.address : null;
    if (address && session.payment_status === "paid") {
      await fetch(`${supabaseUrl}/rest/v1/property_fingerprint_purchases?on_conflict=stripe_session_id`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify({
          address_input: address,
          email: session.customer_details?.email ?? null,
          stripe_session_id: session.id,
          stripe_payment_intent_id: session.payment_intent ?? null,
          amount_cents: session.amount_total ?? null,
        }),
      });
    }
  }

  // Stripe retries on anything but a 2xx, so acknowledge every event type we
  // don't act on too -- there's nothing else here we need to handle yet.
  return jsonResponse({ received: true });
});
