// Supabase Edge Function: market-ready-intake
//
// Powers the Market Ready questionnaire (market-ready.html). Unlike the
// Home Potential flow, there's no free preview step first -- the visitor
// lands straight on the $149 offer, so the row this function manages is
// created by the wizard itself the moment someone clicks "Get Market
// Ready", not by an earlier lookup. The returned id is then used both to
// resume/save progress and to namespace any uploaded photos in the
// `market-ready-photos` storage bucket, the same trust model as the
// Home Potential Strategy previewId.
//
// All reads/writes go through this function with the service-role key;
// `market_ready_requests` has RLS enabled with zero policies, so the anon
// key alone can't touch it.
//
// Request shapes (all POST):
//   { action: "start" }
//   { action: "save",   requestId, fields: { ...allow-listed columns } }
//   { action: "submit", requestId, fields: { contact_name, email, phone } }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Only these columns can be written by the client -- anything else in a
// `fields` payload is silently dropped, since this function's whole job is
// to be a narrow, safe gateway onto a table with zero anon access.
const ALLOWED_FIELDS = new Set([
  "property_info",
  "has_listing_link",
  "situation",
  "goal",
  "photo_paths",
  "special_attention",
  "optional_services",
  "contact_name",
  "email",
  "phone",
]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function sanitizeFields(fields: unknown): Record<string, unknown> {
  if (!fields || typeof fields !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (ALLOWED_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

// Same Resend convention as the home-potential and strategy-intake functions.
// Awaited (not fire-and-forget) since an Edge Function can be torn down
// right after its response is sent, which would otherwise risk killing the
// request mid-flight.
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

  const restHeaders = {
    "Content-Type": "application/json",
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  const action = body.action;

  if (action === "start") {
    const res = await fetch(`${supabaseUrl}/rest/v1/market_ready_requests`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      return jsonResponse({ error: "Could not start your request. Please try again." }, 502);
    }
    const rows = await res.json();
    const id = rows?.[0]?.id;
    if (!id) {
      return jsonResponse({ error: "Could not start your request. Please try again." }, 502);
    }
    return jsonResponse({ requestId: id });
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!requestId) {
    return jsonResponse({ error: "Missing request id." }, 400);
  }
  const rowUrl = `${supabaseUrl}/rest/v1/market_ready_requests?id=eq.${encodeURIComponent(requestId)}`;

  if (action === "save") {
    const fields = sanitizeFields(body.fields);
    if (Object.keys(fields).length === 0) {
      return jsonResponse({ ok: true });
    }
    const res = await fetch(rowUrl, {
      method: "PATCH",
      headers: restHeaders,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      return jsonResponse({ error: "Could not save your answer. Please try again." }, 502);
    }
    return jsonResponse({ ok: true });
  }

  if (action === "submit") {
    const fields = sanitizeFields(body.fields);
    const name = typeof fields.contact_name === "string" ? fields.contact_name.trim() : "";
    const email = typeof fields.email === "string" ? fields.email.trim() : "";
    if (!name || !email || !email.includes("@")) {
      return jsonResponse({ error: "Please enter your name and a valid email address." }, 400);
    }
    const res = await fetch(rowUrl, {
      method: "PATCH",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ ...fields, contact_name: name, email, submitted_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      return jsonResponse({ error: "Could not submit your answers. Please try again." }, 502);
    }

    const updatedRows = await res.json().catch(() => []);
    const row = updatedRows?.[0];
    if (row) {
      const photoCount = Array.isArray(row.photo_paths) ? row.photo_paths.length : 0;
      await notifyRoq({
        subject: `Market Ready request submitted: ${row.property_info ?? "no address/listing given"}`,
        html: `
          <h2>Market Ready questionnaire completed &middot; $149</h2>
          <p><strong>Property / listing:</strong> ${row.property_info ?? "—"}</p>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Phone:</strong> ${row.phone ?? "—"}</p>
          <p><strong>Situation:</strong> ${row.situation ?? "—"}</p>
          <p><strong>Biggest goal:</strong> ${row.goal ?? "—"}</p>
          <p><strong>Special attention:</strong> ${row.special_attention ?? "—"}</p>
          <p><strong>Optional services:</strong> ${(row.optional_services ?? []).join(", ") || "—"}</p>
          <p><strong>Photos uploaded:</strong> ${photoCount}</p>
          <p>Full answers and photos are on this row in Supabase &mdash; send the Stripe Payment Link to collect the $149, then get started on their Market Ready package.</p>
        `,
      });
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Unknown action." }, 400);
});
