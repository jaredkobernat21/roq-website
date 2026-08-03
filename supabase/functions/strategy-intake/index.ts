// Supabase Edge Function: strategy-intake
//
// Powers the post-purchase Home Potential Strategy questionnaire
// (strategy-intake.html). The page is reached via a private link
// (?id=<previewId>) sent manually after a customer pays through the
// Stripe Payment Link -- there's no account/login, so the previewId acts
// as a bearer token, the same trust model already used by the free
// preview's email-capture step.
//
// All reads/writes go through this function with the service-role key;
// the `home_potential_interest` table itself has no anon RLS policies, so
// the anon key alone can't touch it. This keeps the valuation numbers and
// personal intake answers (name, budget, uploaded photo paths, etc.)
// off-limits to anyone who doesn't have a specific previewId.
//
// Request shapes (all POST):
//   { action: "load",   previewId }
//   { action: "save",   previewId, fields: { ...allow-listed columns } }
//   { action: "submit", previewId, fields: { contact_name, email } }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Only these columns can be written by the client -- anything else in a
// `fields` payload is silently dropped rather than passed through to the
// database, since this function's whole job is to be a narrow, safe
// gateway onto a table that otherwise has zero anon access.
const ALLOWED_FIELDS = new Set([
  "goals",
  "goals_other",
  "timeline",
  "focus_areas",
  "focus_areas_other",
  "budget",
  "design_styles",
  "photo_paths",
  "priorities_ranked",
  "change_one_thing",
  "additional_notes",
  "contact_name",
  "email",
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

// Same Resend convention as the home-potential and notify-slates-lead
// functions. Awaited (not fire-and-forget) since an Edge Function can be
// torn down right after its response is sent, which would otherwise risk
// killing the request mid-flight.
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

  const action = body.action;
  const previewId = typeof body.previewId === "string" ? body.previewId : "";
  if (!previewId) {
    return jsonResponse({ error: "Missing request id." }, 400);
  }

  const restHeaders = {
    "Content-Type": "application/json",
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const rowUrl = `${supabaseUrl}/rest/v1/home_potential_interest?id=eq.${encodeURIComponent(previewId)}`;

  if (action === "load") {
    const res = await fetch(`${rowUrl}&select=*`, { headers: restHeaders });
    if (!res.ok) {
      return jsonResponse({ error: "Could not load your request." }, 502);
    }
    const rows = await res.json();
    const row = rows?.[0];
    if (!row) {
      return jsonResponse({ error: "We couldn't find that request. Please use the link from your confirmation email." }, 404);
    }
    return jsonResponse({
      address: row.address ?? null,
      email: row.email ?? null,
      alreadySubmitted: !!row.intake_submitted_at,
      answers: {
        goals: row.goals ?? [],
        goals_other: row.goals_other ?? "",
        timeline: row.timeline ?? "",
        focus_areas: row.focus_areas ?? [],
        focus_areas_other: row.focus_areas_other ?? "",
        budget: row.budget ?? "",
        design_styles: row.design_styles ?? [],
        photo_paths: row.photo_paths ?? [],
        priorities_ranked: row.priorities_ranked ?? [],
        change_one_thing: row.change_one_thing ?? "",
        additional_notes: row.additional_notes ?? "",
        contact_name: row.contact_name ?? "",
      },
    });
  }

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
      body: JSON.stringify({ ...fields, contact_name: name, email, intake_submitted_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      return jsonResponse({ error: "Could not submit your answers. Please try again." }, 502);
    }

    const updatedRows = await res.json().catch(() => []);
    const row = updatedRows?.[0];
    if (row) {
      const photoCount = Array.isArray(row.photo_paths) ? row.photo_paths.length : 0;
      await notifyRoq({
        subject: `Strategy questionnaire submitted: ${row.address ?? "unknown address"}`,
        html: `
          <h2>Strategy questionnaire completed</h2>
          <p><strong>Address:</strong> ${row.address ?? "—"}</p>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Goals:</strong> ${(row.goals ?? []).join(", ") || "—"}</p>
          <p><strong>Timeline:</strong> ${row.timeline ?? "—"}</p>
          <p><strong>Budget:</strong> ${row.budget ?? "—"}</p>
          <p><strong>Focus areas:</strong> ${(row.focus_areas ?? []).join(", ") || "—"}</p>
          <p><strong>Photos uploaded:</strong> ${photoCount}</p>
          <p>Full answers and photos are on this row in Supabase &mdash; time to build their $99 Strategy (24&ndash;48hr window started now).</p>
        `,
      });
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Unknown action." }, 400);
});
