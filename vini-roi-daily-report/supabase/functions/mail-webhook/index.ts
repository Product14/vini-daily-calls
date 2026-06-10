// ============================================================================
// mail-webhook — Supabase Edge Function (Deno)
// Resend webhook sink. Ingests delivered/open/click/bounce/complaint events,
// writes them to roi_engagement_events, and reflects delivered/bounced onto the
// originating run's per-recipient state. Pure Supabase — no Mongo, no Sails.
//
// Deploy:  supabase functions deploy mail-webhook --no-verify-jwt
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, (optional) RESEND_WEBHOOK_SECRET
// Point your Resend webhook at: https://<PROJECT_REF>.supabase.co/functions/v1/mail-webhook
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// Resend event type → our event_type
const MAP: Record<string, string> = {
  "email.delivered": "delivered",
  "email.opened": "open",
  "email.clicked": "click",
  "email.bounced": "bounce",
  "email.complained": "complaint",
  "email.delivery_delayed": "deferred",
};

Deno.serve(async (req) => {
  // NOTE: add Svix signature verification with RESEND_WEBHOOK_SECRET before prod.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Resend sends one event per call: { type, data: { email_id, to, created_at, click? } }
  const events = Array.isArray(body) ? body : [body];
  let ingested = 0;

  for (const ev of events) {
    const type = MAP[String((ev as any).type ?? "")];
    const data = (ev as any).data ?? {};
    const messageId: string | null = data.email_id ?? data.id ?? null;
    const recipient: string | null = Array.isArray(data.to) ? data.to[0] : data.to ?? null;
    if (!type || !messageId) continue;

    // resolve the originating run (join by message_id)
    const { data: run } = await sb
      .from("roi_digest_runs")
      .select("id, team_id, recipients")
      .eq("message_id", messageId)
      .maybeSingle();

    await sb.from("roi_engagement_events").insert({
      run_id: run?.id ?? null,
      team_id: run?.team_id ?? null,
      message_id: messageId,
      recipient_email: recipient ? String(recipient).toLowerCase() : null,
      event_type: type,
      url: data.click?.link ?? null,
      provider: "resend",
      raw: ev,
      occurred_at: data.created_at ?? new Date().toISOString(),
    });
    ingested++;

    // reflect delivered/bounced onto the run's recipient state
    if (run && Array.isArray(run.recipients) && (type === "delivered" || type === "bounce") && recipient) {
      const updated = run.recipients.map((r: any) =>
        (r.email ?? "").toLowerCase() === String(recipient).toLowerCase()
          ? type === "delivered"
            ? { ...r, received: true }
            : { ...r, received: false, bounced: true }
          : r,
      );
      await sb.from("roi_digest_runs").update({ recipients: updated }).eq("id", run.id);
    }
  }

  return new Response(JSON.stringify({ ok: true, ingested }), {
    headers: { "Content-Type": "application/json" },
  });
});
