// Supabase Edge Function: market-preview-request
//
// Powers the "Free Market Preview" questionnaire on the Slade landing page
// (slade.html). Unlike the multi-day-review wizards (market-ready-intake,
// strategy-intake), this is a single short questionnaire answered in a
// modal, so there's no start/save/resume flow -- the whole answer set is
// submitted at once.
//
// All reads/writes go through this function with the service-role key;
// `market_preview_requests` has RLS enabled with zero policies, so the anon
// key alone can't touch it.
//
// Request shape (POST):
//   { market, property_types, strategy, price_range, most_valuable_info,
//     first_name, email, phone }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Same Resend convention as the other intake functions. Awaited (not
// fire-and-forget) since an Edge Function can be torn down right after its
// response is sent, which would otherwise risk killing the request mid-flight.
async function notifyRoq(opts: { subject: string; html: string }): Promise<void> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "ROQ <notifications@roqhome.com>",
        to: ["hello@roqhome.com"],
        subject: opts.subject,
        html: opts.html,
      }),
    });
  } catch {
    // Swallowed -- the answers are already saved either way.
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
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is not configured for this request." }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const firstName = typeof body.first_name === "string" ? body.first_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!firstName || !email || !email.includes("@")) {
    return jsonResponse({ error: "Please enter your first name and a valid email address." }, 400);
  }

  const row = {
    market: typeof body.market === "string" ? body.market.trim() : "",
    property_types: Array.isArray(body.property_types) ? body.property_types : [],
    strategy: typeof body.strategy === "string" ? body.strategy : "",
    price_range: typeof body.price_range === "string" ? body.price_range : "",
    most_valuable_info: typeof body.most_valuable_info === "string" ? body.most_valuable_info.trim() : "",
    first_name: firstName,
    email,
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
  };

  const res = await fetch(`${supabaseUrl}/rest/v1/market_preview_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    return jsonResponse({ error: "Could not submit your preview request. Please try again." }, 502);
  }

  await notifyRoq({
    subject: `Slade market preview request: ${row.market || "no market given"}`,
    html: `
      <h2>Free Market Preview requested</h2>
      <p><strong>Market:</strong> ${row.market || "—"}</p>
      <p><strong>Property types:</strong> ${row.property_types.join(", ") || "—"}</p>
      <p><strong>Strategy:</strong> ${row.strategy || "—"}</p>
      <p><strong>Price range:</strong> ${row.price_range || "—"}</p>
      <p><strong>Most valuable to know:</strong> ${row.most_valuable_info || "—"}</p>
      <p><strong>Name:</strong> ${row.first_name}</p>
      <p><strong>Email:</strong> ${row.email}</p>
      <p><strong>Phone:</strong> ${row.phone || "—"}</p>
    `,
  });

  return jsonResponse({ ok: true });
});
