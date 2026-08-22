// Supabase Edge Function: groundbreakable-intake
//
// Powers the "Start My Build Plan" / "Get Started" intake modal on the
// Groundbreakable landing page (groundbreakable.html). Single short
// questionnaire answered in one modal, submitted all at once -- same
// convention as market-preview-request.
//
// All reads/writes go through this function with the service-role key;
// `groundbreakable_requests` has RLS enabled with zero policies, so the
// anon key alone can't touch it.
//
// Request shape (POST):
//   { location, build_type, build_type_other, stage, unsure_about,
//     name, email, phone }

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

  const location = typeof body.location === "string" ? body.location.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!location || !name || !email || !email.includes("@")) {
    return jsonResponse(
      { error: "Please enter your build location, name, and a valid email address." },
      400,
    );
  }

  const row = {
    location,
    build_type: typeof body.build_type === "string" ? body.build_type : "",
    build_type_other: typeof body.build_type_other === "string" ? body.build_type_other.trim() : "",
    stage: typeof body.stage === "string" ? body.stage : "",
    unsure_about: Array.isArray(body.unsure_about) ? body.unsure_about : [],
    name,
    email,
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
  };

  const res = await fetch(`${supabaseUrl}/rest/v1/groundbreakable_requests`, {
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
    return jsonResponse({ error: "Could not submit your request. Please try again." }, 502);
  }

  await notifyRoq({
    subject: `Groundbreakable Build Plan request: ${row.location}`,
    html: `
      <h2>New Groundbreakable Build Plan request</h2>
      <p><strong>Location:</strong> ${row.location}</p>
      <p><strong>Build type:</strong> ${row.build_type || "—"}${row.build_type_other ? ` (${row.build_type_other})` : ""}</p>
      <p><strong>Stage:</strong> ${row.stage || "—"}</p>
      <p><strong>Unsure about:</strong> ${row.unsure_about.join(", ") || "—"}</p>
      <p><strong>Name:</strong> ${row.name}</p>
      <p><strong>Email:</strong> ${row.email}</p>
      <p><strong>Phone:</strong> ${row.phone || "—"}</p>
    `,
  });

  return jsonResponse({ ok: true });
});
