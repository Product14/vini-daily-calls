/* Twilio SMS sender — the SMS companion to sendMail() in eventRunner.cjs.
 *
 * Dealer-facing notifications (action items, appointments) can be delivered by SMS to the
 * rooftop's people (Salesperson / BDC / GM) in addition to (or instead of) email. This module
 * is the thin transport: it takes an already-rendered plain-text body + an E.164 number and
 * POSTs to Twilio's REST API. Rendering lives in transactionalTemplates.cjs (renderActionItemSms
 * / renderPostAppointmentSms); recipient selection lives in the runner.
 *
 * AUTH: API Key (recommended) — TWILIO_API_KEY_SID (SK…) + TWILIO_API_KEY_SECRET, still requires
 * TWILIO_ACCOUNT_SID (AC…) in the URL path. Falls back to Account SID + TWILIO_AUTH_TOKEN.
 * FROM: TWILIO_MESSAGING_SERVICE_SID (preferred — pooled/branded) OR TWILIO_FROM (a single number).
 *
 * SAFETY: SMS_DRY_RUN defaults TRUE (mirrors DRY_RUN for email) — returns a fake sid, sends nothing.
 */
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const API_KEY_SID = process.env.TWILIO_API_KEY_SID || ACCOUNT_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN || "";
const FROM = process.env.TWILIO_FROM || "";
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
const SMS_DRY_RUN = process.env.SMS_DRY_RUN !== "false"; // default TRUE — never send unless explicitly disabled

// Best-effort E.164 normalization. Accepts "(775) 261-1534", "775-261-1534", "+17752611534".
// Bare 10-digit US numbers get a +1; 11-digit starting with 1 gets a +. Already-E.164 passes through.
function toE164(raw) {
  if (!raw) return "";
  var s = String(raw).trim();
  if (s[0] === "+") return "+" + s.slice(1).replace(/[^\d]/g, "");
  var d = s.replace(/[^\d]/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d ? "+" + d : "";
}

/**
 * Send one SMS. Returns the Twilio message sid (or a "dry_…" sentinel in dry-run).
 * @param {string} to    recipient phone (any common format — normalized to E.164)
 * @param {string} body  plain-text message
 * @param {object} [opts] { from, dryRun } overrides
 */
async function sendSms(to, body, opts) {
  opts = opts || {};
  var dry = opts.dryRun != null ? !!opts.dryRun : SMS_DRY_RUN;
  var e164 = toE164(to);
  if (!e164) throw new Error("sendSms: invalid recipient number: " + to);
  if (!body || !String(body).trim()) throw new Error("sendSms: empty body");
  if (dry) return "dry_" + e164; // suppressed — mirrors email DRY_RUN

  if (!ACCOUNT_SID) throw new Error("sendSms: TWILIO_ACCOUNT_SID (AC…) not set");
  if (!API_KEY_SECRET) throw new Error("sendSms: TWILIO_API_KEY_SECRET / TWILIO_AUTH_TOKEN not set");
  var svc = opts.messagingServiceSid || MESSAGING_SERVICE_SID;
  var from = toE164(opts.from || FROM);
  if (!svc && !from) throw new Error("sendSms: set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM");

  var params = new URLSearchParams();
  params.set("To", e164);
  params.set("Body", String(body));
  if (svc) params.set("MessagingServiceSid", svc); else params.set("From", from);

  var url = "https://api.twilio.com/2010-04-01/Accounts/" + ACCOUNT_SID + "/Messages.json";
  var authHeader = "Basic " + Buffer.from(API_KEY_SID + ":" + API_KEY_SECRET).toString("base64");
  for (var attempt = 1; attempt <= 3; attempt++) {
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: authHeader },
      body: params.toString(),
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) { var j = await res.json().catch(function () { return {}; }); return j.sid || null; }
    var text = await res.text().catch(function () { return ""; });
    // 4xx (except 429 rate-limit) is a permanent error — don't retry.
    if (res.status < 500 && res.status !== 429) throw new Error("twilio " + res.status + ": " + text.slice(0, 300));
    await new Promise(function (r) { setTimeout(r, attempt * 1500); });
  }
  throw new Error("sendSms: failed after retries");
}

module.exports = { sendSms: sendSms, toE164: toE164, SMS_DRY_RUN: SMS_DRY_RUN };
