// Supabase Edge Function: roq-plan-webhook
//
// Stripe webhook for paid ROQ plans (see roq-plan-checkout). On
// checkout.session.completed it marks the matching plan_orders row paid and
// emails ROQ the order with its intake answers. This, not the customer's
// redirect back to the site, is what records a payment, so a closed tab
// after paying loses nothing.
//
// Idempotent: the update only matches a row that is still pending, so a
// retried or duplicated event can't mark an order twice or send a second
// email.
//
// Deployed with --no-verify-jwt: Stripe calls this directly and never sends
// our anon key, only its Stripe-Signature header, which is what
// authenticates the request here.

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

// Same manual verification as property-fingerprint-webhook: HMAC-SHA256 over
// "{timestamp}.{rawBody}", rejecting signatures older than 5 minutes.
async function verifyStripeSignature(rawBody: string, sigHeader: string | null, secret: string): Promise<boolean> {
  if (!sigHeader) return false;
  const pairs = sigHeader.split(",").map((p) => p.split("="));
  const timestamp = pairs.find(([k]) => k === "t")?.[1];
  const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || !signatures.length) return false;

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

  return signatures.some((v1) => {
    if (v1.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
    return diff === 0;
  });
}

async function notifyRoq(subject: string, html: string): Promise<void> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "ROQ <notifications@roqhome.com>",
        to: ["hello@roqhome.com"],
        subject,
        html,
      }),
    });
  } catch {
    // Swallowed -- the order is already marked paid either way.
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const webhookSecret = Deno.env.get("ROQ_STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookSecret || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is not configured for this request." }, 500);
  }

  // Signature verification needs the exact raw bytes Stripe signed.
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
    const session = event.data?.object ?? {};
    const orderId = session.metadata?.order_id || session.client_reference_id;
    // "no_payment_required" covers a session fully covered by a 100%-off
    // promotion code -- still a completed checkout, just $0 due.
    const paymentOk = session.payment_status === "paid" || session.payment_status === "no_payment_required";

    if (orderId && /^[0-9a-f-]{36}$/i.test(orderId) && paymentOk) {
      const res = await fetch(`${supabaseUrl}/rest/v1/plan_orders?id=eq.${orderId}&status=eq.pending`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          status: "paid",
          paid_at: new Date().toISOString(),
          stripe_session_id: session.id,
          stripe_payment_intent_id: session.payment_intent ?? null,
          amount_cents: session.amount_total ?? null,
          email: session.customer_details?.email ?? undefined,
        }),
      });
      if (!res.ok) {
        // Let Stripe retry rather than lose the payment record.
        return jsonResponse({ error: "Could not record the order." }, 500);
      }
      const rows = await res.json().catch(() => []);
      const order = Array.isArray(rows) ? rows[0] : null;

      if (order) {
        const amount = typeof order.amount_cents === "number" ? `$${(order.amount_cents / 100).toFixed(2)}` : "—";
        const lines = String(order.summary || "").split(" | ").map((l) => `<li>${esc(l)}</li>`).join("");
        await notifyRoq(
          `Paid order: ${order.plan === "potential" ? "Home Value Potential" : order.plan} (${amount})`,
          `
            <h2>New paid order${event.livemode ? "" : " (test mode)"}</h2>
            <p><strong>Plan:</strong> ${esc(order.plan)}<br />
               <strong>Amount:</strong> ${esc(amount)}<br />
               <strong>Address:</strong> ${esc(order.address)}<br />
               <strong>Email:</strong> ${esc(order.email)}<br />
               <strong>Order:</strong> ${esc(order.id)}</p>
            <ul>${lines}</ul>
          `,
        );
      }
    }
  }

  // Stripe retries on anything but a 2xx, so acknowledge every other event.
  return jsonResponse({ received: true });
});
