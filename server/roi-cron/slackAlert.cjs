// ── Shared Slack breakage alert ───────────────────────────────────────────────
// One alert used by BOTH send pipelines — the daily/weekly/monthly digest (runner.cjs) and the
// transactional event emails (eventRunner.cjs) — so a failure in either surfaces the same way.
// Styled after the team's ops alerts: severity header · What · counts · thresholds · per-row list ·
// window/env/ran footer. Best-effort: no bot token → log-only; a Slack error never breaks the cron.
//
// TIERED THRESHOLDS (env-tunable, SHARED across both pipelines): alert fires only at/above WARN; at/above
// CRIT it escalates to a :rotating_light: CRITICAL with an @channel ping (WARNING is quieter — no ping).
// Below WARN the pass is healthy and nothing is posted (noise floor).
//   DIGEST_ALERT_WARN  (default 1)  — any failed send is worth surfacing
//   DIGEST_ALERT_CRIT  (default 5)  — this many failing at once = systemic (mail gateway / token / render)
// Destination: #vini-alerts-and-monitoring (override with SLACK_ALERT_CHANNEL). Needs SLACK_BOT_TOKEN in
// the project env AND the bot (vini_control_tower) invited to the channel.

const SLACK_ALERT_MAX_LIST = 20;
const ALERT_WARN = Math.max(1, Number(process.env.DIGEST_ALERT_WARN) || 1);
const ALERT_CRIT = Math.max(ALERT_WARN, Number(process.env.DIGEST_ALERT_CRIT) || 5);

/**
 * @param {object} o
 * @param {string} o.source        e.g. "Daily digest" | "Transactional email"
 * @param {Array<{rooftop:string,dept:string,error:string}>} o.failures  genuine send failures this pass
 * @param {number} [o.sentOk]      how many sent OK this pass (context)
 * @param {string} [o.windowLabel] the pass description shown in the footer
 */
async function postBreakageAlert({ source, failures, sentOk, windowLabel }) {
  if (!Array.isArray(failures) || failures.length === 0) return;
  if (failures.length < ALERT_WARN) return; // below the noise floor — healthy pass
  const critical = failures.length >= ALERT_CRIT;
  const level = critical ? "CRITICAL" : "WARNING";
  const icon = critical ? ":rotating_light:" : ":warning:";
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_ALERT_CHANNEL || "vini-alerts-and-monitoring";
  const ranAt = new Date().toISOString();
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || "production";
  const shown = failures.slice(0, SLACK_ALERT_MAX_LIST);
  const lines = shown.map((f) => `• *${f.rooftop}* [${f.dept}] — ${f.error}`).join("\n");
  const more = failures.length > shown.length ? `\n…and ${failures.length - shown.length} more.` : "";
  // Source-aware cause + storage wording so the SMS alert doesn't read as an email/mail-gateway issue.
  const isSms = /sms/i.test(source);
  const cause = isSms ? "Twilio / render / unexpected error" : "mail gateway / render / unexpected error";
  const stored = isSms ? "Recorded as *error* in the SMS ledger (roi_event_sms)." : "Recorded as *error* and shown as *Failed* in the tracker.";
  const text =
    `${icon} *[${source} · ${level}] ${source} sends failing*` + (critical ? "\n<!channel>" : "") + `\n\n` +
    `*What:* ${failures.length} ${source.toLowerCase()} send${failures.length === 1 ? "" : "s"} threw this pass ` +
    `(${cause}). ${stored}\n` +
    `*Failed:* ${failures.length}   ·   *Sent OK:* ${sentOk == null ? "?" : sentOk}\n` +
    `*Thresholds:* warn ≥ ${ALERT_WARN} · crit ≥ ${ALERT_CRIT}   (tune via DIGEST_ALERT_WARN / DIGEST_ALERT_CRIT)\n` +
    `*Window:* ${windowLabel || "send pass"}  ·  *env:* ${env}  ·  *ran:* ${ranAt}\n\n` +
    `*Failed sends:*\n${lines}${more}`;
  if (!token) { console.log(`  ⚠ SLACK_BOT_TOKEN not set — ${source} alert not posted. Would post to #${channel}:\n${text}`); return; }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`slack ${j.error || res.status}`);
  console.log(`  🔔 Slack ${level} alert posted to #${channel} — ${source} (${failures.length} failed · warn≥${ALERT_WARN} crit≥${ALERT_CRIT})`);
}

module.exports = { postBreakageAlert, ALERT_WARN, ALERT_CRIT };
