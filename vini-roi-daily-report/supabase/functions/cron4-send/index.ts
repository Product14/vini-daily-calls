// CRON 4 (Step 3): take every QUEUED run, double-check it hasn't already gone out,
// honour the dry-run flag, and POST the stored HTML to the Spyne mail API. The HTML
// generated in cron3 is dropped verbatim into templateData.HTMLdata of the
// 'email-control-tower-report' template — the curl just carries our body.
//
//   curl --location 'https://mail.spyne.ai/api/v1/send-template-email' \
//     --header 'Content-Type: application/json' --header 'Authorization: Bearer <MAIL_TOKEN>' \
//     --data-raw '{"to":"...","subject":"...","template":"email-control-tower-report",
//                  "templateData":{"HTMLdata":"<rendered html>"}}'
//   (verified 2026-06-08: Authorization: Bearer <token> returns 200 OK; Cookie auth is NOT used.)
//
// SEND DECISION (per row), in precedence order:
//   1. ?spyneOnly=true      → real send, but recipients are filtered to ONLY
//                             @spyne.ai addresses (every external/customer address
//                             is dropped). This is the tracker's "preview to Spyne"
//                             action — internal testers get the real email, no
//                             customer ever does. Overrides the dry_run flag. The
//                             run is recorded status='suppressed'/reason='spyne_preview'
//                             (NOT 'sent') because the DEALER was not sent, so it
//                             never inflates the tracker's sent count.
//   2. ?dry=true            → ALWAYS suppress (hard safety).
//   3. ?force=true          → real send, ignoring the rooftop's dry_run flag
//                             (manual "Send now" from the UI for ONE rooftop).
//   4. dry_run flag = false  → real send (the normal scheduled path).
//   5. otherwise            → suppress (reason='dry_run').
// ?team=<id> scopes to one rooftop.
//
// MAIL TOKEN resolution (for real sends), sent as `Authorization: Bearer <token>`:
//   - request header `x-mail-token`  (FE-supplied — see token-on-frontend flow), else
//   - env `MAIL_TOKEN` (or legacy `MAIL_COOKIE`).
//   The token is read from a HEADER, never the URL, because it's a secret.
// ⚠ The token expires. On a 401/403 the row is marked not_sent/mail_auth and the
//   summary sets auth_failed=true so the UI can prompt for a fresh token.
import { supa, json } from "../_shared/lib.ts";

const MAIL_URL = "https://mail.spyne.ai/api/v1/send-template-email";
const TEMPLATE = "email-control-tower-report";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const team = u.searchParams.get("team");
  const dryParam = u.searchParams.get("dry") === "true";
  const force = u.searchParams.get("force") === "true";
  const spyneOnly = u.searchParams.get("spyneOnly") === "true";
  const isSpyne = (e: unknown) => /@spyne\.ai\s*$/i.test(String(e ?? "").trim());
  const mailToken = req.headers.get("x-mail-token") || Deno.env.get("MAIL_TOKEN") || Deno.env.get("MAIL_COOKIE") || "";
  const sb = supa();

  let q = sb.from("roi_digest_runs").select("id,team_id,department,local_date,recipients,rendered_html,subject").eq("status", "queued");
  if (team) q = q.eq("team_id", team);
  const { data: rows } = await q;

  const { data: liveRows } = await sb.from("roi_live_departments").select("team_id,department,dry_run");
  // default to dry (true) if no row — fail safe
  const dryOf = new Map((liveRows ?? []).map((l) => [`${l.team_id}|${l.department}`, l.dry_run !== false]));

  const out = { sent: 0, suppressed: 0, preview: 0, errors: 0, skipped: 0, pending_render: 0, auth_failed: false };

  for (const r of rows ?? []) {
    const flagDry = dryOf.get(`${r.team_id}|${r.department}`) ?? true;
    // spyneOnly forces a real send (recipients filtered below); otherwise the dry
    // hard-safety wins, then force, then the per-rooftop flag.
    const realSend = spyneOnly || (!dryParam && (force || !flagDry));
    let recips = (r.recipients ?? []).map((x: any) => x.email).filter(Boolean);
    // Preview mode: keep ONLY internal @spyne.ai recipients so no customer is emailed.
    if (spyneOnly) recips = recips.filter(isSpyne);

    if (!realSend) {
      await sb.from("roi_digest_runs").update({ status: "suppressed", reason: "dry_run" }).eq("id", r.id);
      out.suppressed++; continue;
    }
    if (!recips.length) {
      // For a preview run, "no @spyne.ai recipient" is the expected skip reason.
      await sb.from("roi_digest_runs").update({ status: "not_sent", reason: spyneOnly ? "no_spyne_recipient" : "recipients_missing" }).eq("id", r.id);
      out.skipped++; continue;
    }
    if (!r.rendered_html) {
      // HTML not prebuilt yet — leave the row 'queued' so it sends after the
      // email-render/prebuild.cjs job populates rendered_html.
      out.pending_render++; continue;
    }
    if (!mailToken) {
      // real send requested but we have no credential at all → treat as auth failure
      out.auth_failed = true;
      await sb.from("roi_digest_runs").update({ status: "not_sent", reason: "mail_auth", reason_detail: "no mail token (set MAIL_COOKIE or supply x-mail-token)" }).eq("id", r.id);
      out.errors++; continue;
    }

    try {
      const res = await fetch(MAIL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mailToken}` },
        body: JSON.stringify({ to: recips.join(","), subject: spyneOnly ? `[PREVIEW] ${r.subject ?? "Daily Digest"}` : (r.subject ?? "Daily Digest"), template: TEMPLATE, templateData: { HTMLdata: r.rendered_html } }),
      });
      if (res.status === 401 || res.status === 403) {
        out.auth_failed = true;
        const detail = `mail auth ${res.status}: ${(await res.text()).slice(0, 180)}`;
        await sb.from("roi_digest_runs").update({ status: "not_sent", reason: "mail_auth", reason_detail: detail }).eq("id", r.id);
        out.errors++; continue;
      }
      if (!res.ok) throw new Error(`mail ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json().catch(() => ({}));
      // Preview: mark received=true ONLY for the @spyne.ai addresses we actually
      // sent to, so the tracker never claims a customer received the email.
      const sentSet = new Set(recips.map((e: string) => String(e).trim().toLowerCase()));
      // A preview reached internal recipients only — the DEALER was NOT sent, so
      // it must NOT count as 'sent'. Record it 'suppressed/spyne_preview' (the
      // internal delivery is still captured in recipients[].received + reason_detail).
      await sb.from("roi_digest_runs").update({
        status: spyneOnly ? "suppressed" : "sent",
        sent_at: new Date().toISOString(),
        message_id: (j as any).messageId ?? (j as any).id ?? null,
        send_path: spyneOnly ? "spyne_preview" : "raw_html",
        reason: spyneOnly ? "spyne_preview" : null,
        reason_detail: spyneOnly ? `preview emailed to ${recips.length} @spyne.ai recipient(s); dealer not sent` : null,
        recipients: (r.recipients ?? []).map((x: any) => ({ ...x, received: spyneOnly ? sentSet.has(String(x.email).trim().toLowerCase()) : true })),
      }).eq("id", r.id);
      if (spyneOnly) out.preview++; else out.sent++;
    } catch (e) {
      await sb.from("roi_digest_runs").update({ status: "not_sent", reason: "mail_error", reason_detail: String(e).slice(0, 500) }).eq("id", r.id);
      out.errors++;
    }
  }
  return json(out);
});
