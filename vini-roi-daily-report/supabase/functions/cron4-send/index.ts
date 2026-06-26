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
//   1. ?spyneOnly=true      → real send, but recipients are OVERRIDDEN with the
//                             fixed PREVIEW_RECIPIENTS reviewer allowlist (see
//                             below). Every rooftop's preview goes to ONLY those
//                             internal reviewers — no customer, and no other
//                             @spyne.ai address, ever receives. This is the
//                             tracker's "preview to Spyne" action. Overrides the
//                             dry_run flag. The run is recorded
//                             status='suppressed'/reason='spyne_preview' (NOT
//                             'sent') because the DEALER was not sent, so it never
//                             inflates the tracker's sent count.
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
//
// MANUAL SEND-LIVE PASSWORD (anti-churn / deliberate-send guard):
//   A human-triggered run from the tracker supplies the FE mail token in the
//   `x-mail-token` header; the SCHEDULED cron (pg_cron → cron1) does NOT (it uses the
//   env token). So when `x-mail-token` is present we treat it as a MANUAL send and
//   REQUIRE the override password in the `x-send-override` header to equal DANGER — for
//   BOTH a real customer "Send live" AND the reviewer "Preview all" (spyneOnly).
//   Missing/wrong → the row is left QUEUED (not sent) and summary.override_required=true.
//   Only the scheduled cron (no FE token) is exempt.
import { supa, json } from "../_shared/lib.ts";

const MAIL_URL = "https://mail.spyne.ai/api/v1/send-template-email";
const TEMPLATE = "email-control-tower-report";

// PREVIEW allowlist — a spyneOnly ("Preview to Spyne") run is sent ONLY to these
// fixed internal reviewers, regardless of each rooftop's configured recipients.
// This guarantees no customer (and no other @spyne.ai address) ever receives a
// preview, and that every rooftop's preview reaches the reviewers even when the
// rooftop has no @spyne.ai recipient of its own.
const PREVIEW_RECIPIENTS = ["devansh.hasija@spyne.ai", "subhav.malhotra@spyne.ai"];

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const team = u.searchParams.get("team");
  const dryParam = u.searchParams.get("dry") === "true";
  const force = u.searchParams.get("force") === "true";
  const spyneOnly = u.searchParams.get("spyneOnly") === "true";
  const mailToken = req.headers.get("x-mail-token") || Deno.env.get("MAIL_TOKEN") || Deno.env.get("MAIL_COOKIE") || "";
  // Manual bulk "Send live" guard: a human-triggered run supplies the FE mail token
  // in the x-mail-token header; the SCHEDULED cron uses the env token (no such header).
  // For a manual real CUSTOMER send we require the override password (DANGER) — typed
  // in the tracker's Send-live prompt and forwarded by cron1 as x-send-override. The
  // scheduled cron and the reviewer-only preview (spyneOnly) are exempt.
  const isManual = !!req.headers.get("x-mail-token");
  const overrideOk = (req.headers.get("x-send-override") || "").trim() === "DANGER";
  const sb = supa();

  let q = sb.from("roi_digest_runs").select("id,team_id,department,local_date,recipients,rendered_html,subject").eq("status", "queued");
  if (team) q = q.eq("team_id", team);
  const { data: rows } = await q;

  const { data: liveRows } = await sb.from("roi_live_departments").select("team_id,department,dry_run");
  // default to dry (true) if no row — fail safe
  const dryOf = new Map((liveRows ?? []).map((l) => [`${l.team_id}|${l.department}`, l.dry_run !== false]));

  const out = { sent: 0, suppressed: 0, preview: 0, errors: 0, skipped: 0, pending_render: 0, auth_failed: false, override_required: false };

  for (const r of rows ?? []) {
    const flagDry = dryOf.get(`${r.team_id}|${r.department}`) ?? true;
    // spyneOnly forces a real send (recipients filtered below); otherwise the dry
    // hard-safety wins, then force, then the per-rooftop flag.
    const realSend = spyneOnly || (!dryParam && (force || !flagDry));
    let recips = (r.recipients ?? []).map((x: any) => x.email).filter(Boolean);
    // Preview mode: override the recipient set with the fixed reviewer allowlist so
    // ONLY those internal addresses are emailed — never a customer, never any other
    // @spyne.ai address, and the preview lands even if the rooftop has no recipients.
    if (spyneOnly) recips = [...PREVIEW_RECIPIENTS];

    if (!realSend) {
      await sb.from("roi_digest_runs").update({ status: "suppressed", reason: "dry_run" }).eq("id", r.id);
      out.suppressed++; continue;
    }
    // Any manual send (live customer OR reviewer preview) needs the override password.
    // Leave the row QUEUED (don't mark it) so a correct-password retry — or the next
    // scheduled cron run — still sends it; only block this manual attempt.
    if (isManual && !overrideOk) {
      out.override_required = true; out.skipped++; continue;
    }
    if (!recips.length) {
      // Preview always has the reviewer allowlist, so this only trips a real send
      // for a rooftop with no configured recipients.
      await sb.from("roi_digest_runs").update({ status: "not_sent", reason: "recipients_missing" }).eq("id", r.id);
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
      // A preview reached the internal reviewers only — the DEALER was NOT sent, so
      // it must NOT count as 'sent'. Record it 'suppressed/spyne_preview' and store
      // the reviewer list we actually emailed (so the tracker shows who got it),
      // never claiming a customer received the email.
      await sb.from("roi_digest_runs").update({
        status: spyneOnly ? "suppressed" : "sent",
        sent_at: new Date().toISOString(),
        message_id: (j as any).messageId ?? (j as any).id ?? null,
        send_path: spyneOnly ? "spyne_preview" : "raw_html",
        reason: spyneOnly ? "spyne_preview" : null,
        reason_detail: spyneOnly ? `preview emailed to reviewers (${recips.join(", ")}); dealer not sent` : null,
        recipients: spyneOnly
          ? recips.map((e: string) => ({ email: e, received: true }))
          : (r.recipients ?? []).map((x: any) => ({ ...x, received: true })),
      }).eq("id", r.id);
      if (spyneOnly) out.preview++; else out.sent++;
    } catch (e) {
      await sb.from("roi_digest_runs").update({ status: "not_sent", reason: "mail_error", reason_detail: String(e).slice(0, 500) }).eq("id", r.id);
      out.errors++;
    }
  }
  return json(out);
});
