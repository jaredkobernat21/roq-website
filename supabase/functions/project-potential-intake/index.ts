// Supabase Edge Function: project-potential-intake
//
// Powers the "Free Project Potential" CTA on the Improve page
// (renovate.html) -- a short, three-step lead capture (address, project
// type, phone or email) submitted all at once. Same convention as
// groundbreakable-intake: no live valuation, just a saved lead + a
// notification, followed up on manually.
//
// All reads/writes go through this function with the service-role key;
// `project_potential_requests` has RLS enabled with zero policies, so the
// anon key alone can't touch it.
//
// Request shape (POST):
//   { address, project_type, contact, contact_method }

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
    // Swallowed -- the answer is already saved either way.
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

  const address = typeof body.address === "string" ? body.address.trim() : "";
  const projectType = typeof body.project_type === "string" ? body.project_type.trim() : "";
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  const contactMethod = contact.includes("@") ? "email" : "phone";

  if (!address || address.length < 8) {
    return jsonResponse({ error: "Please enter your full home address." }, 400);
  }
  if (!projectType) {
    return jsonResponse({ error: "Please choose a project." }, 400);
  }
  if (!contact) {
    return jsonResponse({ error: "Please enter a phone number or email so we can send your results." }, 400);
  }

  const row = {
    address,
    project_type: projectType,
    contact,
    contact_method: contactMethod,
  };

  const res = await fetch(`${supabaseUrl}/rest/v1/project_potential_requests`, {
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
    subject: `Free Project Potential request: ${row.project_type}`,
    html: `
      <h2>New Free Project Potential request</h2>
      <p><strong>Address:</strong> ${row.address}</p>
      <p><strong>Project:</strong> ${row.project_type}</p>
      <p><strong>Contact (${row.contact_method}):</strong> ${row.contact}</p>
    `,
  });

  return jsonResponse({ ok: true });
});
