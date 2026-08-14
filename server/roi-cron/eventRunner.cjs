#!/usr/bin/env node
/* ROI TRANSACTIONAL email poll — the event-driven companion to the daily/weekly/monthly
 * digest cron (runner.cjs). Runs frequently (every ~15 min via Vercel cron) and, per the
 * Jun-2026 review, sends one email per NEW event:
 *
 *   post_appointment       — a new appointment was booked            (reporting-vini /api/meetings)
 *   post_conversation      — a call/SMS/website-chat conversation    (reporting-vini /api/conversations,
 *                            channel=call | sms | chat)
 *   action_item            — a new action item was created/assigned  (reporting-vini /api/action-items?scope=recent)
 *   action_item_overdue    — an action item breached its SLA         (reporting-vini /api/action-items?scope=overdue)
 *
 * Each type is gated per rooftop by roi_rooftop_config.*_enabled. Dedupe is the unique
 * (team_id, email_type, event_key) on roi_event_emails — an event is emailed at most once.
 * Outbound post-conversation only fires when the customer responded / it's actionable
 * (config: post_conversation_mode, post_conversation_outbound_requires_reply).
 *
 * SAFETY: DRY_RUN defaults TRUE — records 'suppressed/dry_run', sends nothing. dealership
 * dry_run=true is always held. Same mail proxy + env as runner.cjs.
 *
 * CADENCE: the Vercel cron (vercel.json) fires this every ~4 min while US dealers are open
 * (12:00–02:59 UTC) and every 15 min deep-night, so customer-facing events go out fast during
 * business hours without blasting the mail proxy overnight. The per-pass look-back (POLL_MINUTES)
 * is constant and wider than the largest cron gap, so dedup absorbs the overlap and nothing drops.
 *
 *   node eventRunner.cjs            # one pass
 *   node eventRunner.cjs --loop     # self-paced: ~4 min active window, 15 min deep-night
 */
const { createClient } = require("@supabase/supabase-js");
const T = require("../../src/email/transactionalTemplates.cjs");
// Anti-churn value gate (shared with the digest runner) — never email a no-value
// transactional unless overridden (DANGER).
const emailValue = require("./emailValue.cjs");
// SMS channel — the Twilio companion to sendMail(). Gated per rooftop by roi_rooftop_config.sms_enabled
// and per recipient by roi_recipients.sms_enabled + phone. Its own dedupe ledger (roi_event_sms).
const { sendSms, SMS_DRY_RUN } = require("./sendSms.cjs");
// Per-recipient subscription matrix + role-tiered ("assigned salesperson → parent") routing.
const { isSubscribed, pickTieredRecipients, isChurned } = require("./subscriptions.cjs");
const { postBreakageAlert, postSystemicAlert } = require("./slackAlert.cjs");
// Self-healing dealer-timezone lookup (live Spyne working-hours API) — see resolveTz.cjs for why.
const { resolveTz, resolveWorkingHours } = require("./resolveTz.cjs");
// Lead-capture field enrichment (ClickHouse) for rooftops on post_conversation_template='lead_capture'.
const leadCaptureCH = require("./leadCaptureCH.cjs");

const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const MAIL_URL = process.env.MAIL_PROXY_URL || process.env.EMAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
const MAIL_TEMPLATE = process.env.MAIL_TEMPLATE || "email-control-tower-report";
const MAIL_TOKEN = process.env.MAIL_TOKEN || "";
// "false" and "0" both disable — .env.example documents DRY_RUN=0 to go live.
const DRY_RUN = !["false", "0"].includes(String(process.env.DRY_RUN ?? "").trim().toLowerCase());
const REPORTING_API_BASE = (process.env.REPORTING_API_BASE || "https://reporting-vini.vercel.app").replace(/\/$/, "");
const SPYNE_TOKEN = process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || "";
// ── US active window (call-time, DST-safe by construction) ───────────────────────────────────
// "Active" = at least one US dealer is open, across all lower-48 zones (ET→PT). Business hours
// ~8am-7pm local map to a UTC window of 12:00 → 02:59 (next day); 03:00 → 11:59 UTC is deep-night
// (every US dealer closed). We use whole-UTC-hour bounds so it is correct year-round without any
// DST math. This drives ONLY the send-stagger choice below, and it MUST be evaluated PER CALL — a
// warm serverless instance lives for hours, so a value frozen at module load would go stale.
// The cron FREQUENCY (vercel.json) is what actually paces sends: every ~4 min in the active window,
// every 15 min deep-night. See the /api/cron/roi-events entries in vercel.json.
function isUSActiveWindow(d = new Date()) {
  const h = d.getUTCHours();
  return h >= 12 || h <= 2; // 12:00–23:59 or 00:00–02:59 UTC
}
// Look-back window per pass — CONSTANT and generous ON PURPOSE. The unique (team_id, email_type,
// event_key) dedup makes re-fetching the same window free, so a wide window can only ever RE-scan
// (harmless), never DROP. It MUST exceed the largest gap between cron runs (15 min deep-night) plus
// margin, or events arriving in the gap are lost forever. The earlier `isUSBusinessHour() ? 4 : 20`
// was a silent data-loss bug: a 4-min look-back under a 15-min cron dropped 11 min of events/cycle.
const POLL_MINUTES = Number(process.env.EVENT_POLL_MINUTES || 25);
// meetings.meta.source values that mean "this appointment row is not one Vini booked" — no
// post_appointment email, on either channel. Kept as a set so a sibling value can be muted with a
// one-word change; 'callback' is deliberately NOT in here (it hasn't been asked for or verified).
const NON_VINI_META_SOURCES = new Set(["warm_transfer"]);
// SMS post-conversation is batched to END OF DAY (the thread runs all day, so one email per lead/day
// instead of one per message). Fires once the dealer-local hour reaches this (default 8pm). Calls stay instant.
const SMS_EOD_HOUR = Number(process.env.EVENT_SMS_EOD_HOUR || 20);
const CONSOLE_BASE = "https://console.spyne.ai/converse-ai";
// Overdue action items are a scheduled 2x/day report (before the dealer opens, and at close),
// not a continuous per-pass rebatch — the SLA was already breached, so a report tied to the
// dealer's own rhythm is more useful than a ping every few minutes. Hours come from
// resolveWorkingHours() (real per-dealer open/close, cached on roi_rooftop_config.working_hours);
// these are only the fallback for a rooftop that hasn't resolved yet or has no live data.
const OVERDUE_MORNING_FALLBACK_HOUR = Number(process.env.EVENT_OVERDUE_MORNING_FALLBACK_HOUR || 7);
const OVERDUE_EOD_FALLBACK_HOUR = Number(process.env.EVENT_OVERDUE_EOD_FALLBACK_HOUR || 19);
function parseHour(hhmm) { const m = /^(\d{1,2}):/.exec(String(hhmm || "")); return m ? Number(m[1]) : null; }
// SMS has no send-pacing queue (unlike email's stagger queue for domain reputation) — every sendSms()
// call fires as fast as the loop runs, relying only on Twilio's reactive 429-retry (sendSms.cjs) rather
// than proactively avoiding the rate limit. A small fixed delay before each live send keeps this pass
// well under typical Twilio/10DLC per-second throughput without meaningfully slowing the cron (batching
// already cut per-pass SMS volume ~40x, so this adds at most a few seconds, not minutes).
const SMS_SEND_STAGGER_MS = Number(process.env.EVENT_SMS_SEND_STAGGER_MS || 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open-tracking pixel → the track-open Edge Function (keyed by the event-email row id).
// Override the host with DIGEST_TRACK_BASE if it ever moves.
const TRACK_OPEN_URL = (process.env.DIGEST_TRACK_BASE || "https://qludnojfibguobgeeujw.supabase.co/functions/v1/track-open").replace(/\/$/, "");

// ── Send queue: minimum spacing between transactional sends (sender-reputation guard) ─────────
// Every event send is threaded through one promise chain so a single cron pass can never fan
// out a sub-second burst at the shared mail proxy. The floor is time-aware: tighter in the US
// active window (fast customer notifications when dealers are open), looser deep-night (a burst
// at 4am ET reads as spam to ISPs and there is nobody to act on it anyway).
//   active     → 1s/event  = up to 3600 sends/hr, well above any realistic event volume
//   deep-night → 2s/event  = 1800 sends/hr, deliberately gentle
// Tunable via EVENT_SEND_DELAY_ACTIVE_MS / EVENT_SEND_DELAY_NIGHT_MS (set 0 to disable spacing).
const EVENT_SEND_DELAY_ACTIVE_MS = Number(process.env.EVENT_SEND_DELAY_ACTIVE_MS ?? 1000); // 1s
const EVENT_SEND_DELAY_NIGHT_MS  = Number(process.env.EVENT_SEND_DELAY_NIGHT_MS  ?? 2000); // 2s
let _eventSendQueue = Promise.resolve();
let _lastEventSendAt = 0;
function enqueueSendEvent(to, subject, html, opts) {
  _eventSendQueue = _eventSendQueue.then(async () => {
    const delayMs = isUSActiveWindow() ? EVENT_SEND_DELAY_ACTIVE_MS : EVENT_SEND_DELAY_NIGHT_MS;
    const elapsed = Date.now() - _lastEventSendAt;
    if (delayMs > 0 && _lastEventSendAt > 0 && elapsed < delayMs) {
      await new Promise((r) => setTimeout(r, delayMs - elapsed));
    }
    _lastEventSendAt = Date.now();
    return sendMailRaw(to, subject, html, opts);
  });
  return _eventSendQueue;
}
function withPixel(html, id) {
  if (!html || !id) return html;
  const img = `<img src="${TRACK_OPEN_URL}?id=${encodeURIComponent(id)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
  return html.includes("</body>") ? html.replace("</body>", `${img}</body>`) : html + img;
}

// Per-recipient open attribution (Option B) — see runner.cjs for the full rationale. Most event
// emails go to a single recipient (already exactly attributable), so this only matters for the few
// multi-recipient types. DEFAULT OFF; flip with PER_RECIPIENT_PIXEL to fan out one attributed copy
// per recipient (pixel keyed &r=<email>, which the track-open edge fn flips per person).
const PER_RECIPIENT_PIXEL = /^(1|true|yes)$/i.test(String(process.env.PER_RECIPIENT_PIXEL || ""));
function withRecipientPixel(html, email) {
  if (!html || !email) return html;
  const enc = encodeURIComponent(email);
  return html.replace(/(https?:\/\/[^"']*\/functions\/v1\/track-open\?[^"']*?)(["'])/i, (_m, url, q) =>
    (/[?&]r=/.test(url) ? url : `${url}&r=${enc}`) + q);
}
async function sendMailAttributed(emails, subject, html, opts) {
  if (!PER_RECIPIENT_PIXEL || !Array.isArray(emails) || emails.length <= 1) {
    return sendMail(emails, subject, html, opts);
  }
  let firstId = null;
  for (const em of emails) {
    try {
      const id = await sendMail([em], subject, withRecipientPixel(html, em), opts);
      if (!firstId) firstId = id;
    } catch (e) {
      console.warn(`  ⚠ per-recipient event send skipped ${em}: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }
  return firstId;
}

const IS_CLI = require.main === module;
if (IS_CLI && (!SB_URL || !SB_KEY)) { console.error("Set ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY"); process.exit(1); }
const sb = createClient(SB_URL || "http://invalid.local", SB_KEY || "noop", { auth: { persistSession: false } });

const todayISO = () => new Date().toISOString().slice(0, 10);
// Cross-TYPE lead identity — lets the post_conversation suppression (below) recognize "this is the
// SAME lead" across action_item/action_item_overdue/post_appointment/post_conversation, even though
// each feed surfaces different fields. Prefers leadId (present on action-items/conversations);
// meetings don't carry one today, so appointments fall back to name/phone — a best-effort match
// (name collisions are possible), not a hard guarantee. A missed suppression here just means an
// occasional redundant post_conversation email, not a correctness bug.
function leadMatchKey({ leadId, customer, phone }) {
  if (leadId) return `id:${leadId}`;
  if (customer) return `name:${String(customer).trim().toLowerCase()}`;
  if (phone) return `phone:${String(phone).replace(/\D/g, "")}`;
  return null;
}
// Dealer-local "today" (YYYY-MM-DD) so the post-appointment window matches the dealer's day, not UTC.
function localDateISO(tz) {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t)?.value;
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch { return todayISO(); }
}
// Dealer-local hour+minute (0–23, 0–59) — gates the EOD SMS batch and sizes its since-midnight window.
function localHourMin(tz) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const g = (t) => Number(p.find((x) => x.type === t)?.value);
    let h = g("hour"); if (h === 24) h = 0; // some ICU builds emit "24" at midnight
    return { h, m: g("minute") };
  } catch { return { h: 0, m: 0 }; }
}
// Appointment time in the dealer's local zone, e.g. "Mon, Jun 23 · 2:30 PM".
function fmtSched(iso, tz) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d.getTime())) return "";
  const z = tz || "America/New_York";
  try {
    const dp = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: z }).format(d);
    const tp = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: z }).format(d);
    return `${dp} · ${tp}`;
  } catch { return ""; }
}
// A customer-originated SMS (vs an AI/agent outbound) — the anchor for "the customer responded".
const isInboundSms = (mm) => !!mm && (mm.direction === "in" || mm.direction === "inbound" || mm.authorType === "human");
// Split a lead's SMS messages into SESSIONS: a new session begins after a lull of > gapMin minutes
// of silence. Returns [{ startAt, _lastT, msgs, hasReply }] in order. Powers the 'session' cadence.
function smsSessions(msgs, gapMin) {
  const sorted = (msgs || []).filter((x) => x && x.at).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const out = [];
  for (const mm of sorted) {
    const t = new Date(mm.at).getTime();
    if (isNaN(t)) continue;
    const cur = out[out.length - 1];
    if (!cur || (t - cur._lastT) > gapMin * 60000) out.push({ startAt: mm.at, _lastT: t, msgs: [mm], hasReply: isInboundSms(mm) });
    else { cur._lastT = t; cur.msgs.push(mm); cur.hasReply = cur.hasReply || isInboundSms(mm); }
  }
  return out;
}
// The reporting-vini read API now requires a credential (it returns per-customer PII). Forward the
// trusted service secret (preferred) or the Spyne token so these server-to-server calls authorize;
// without this the conversations/action-items/reports/meetings calls return 401.
// canonical: reporting-vini's read API authorizes on ITS OWN service secret. That is NOT necessarily
// this app's CRON_SECRET (which guards our Vercel crons). Prefer a dedicated REPORTING_CRON_SECRET
// (set to reporting-vini's secret) so our calls authorize once reporting enforces auth; fall back to
// the old chain so nothing changes where the dedicated var isn't set.
const REPORTING_AUTH = process.env.REPORTING_CRON_SECRET || process.env.CRON_SECRET || SPYNE_TOKEN || "";
// Set when any feed response comes back degraded (e.g. reporting-vini missing CLICKHOUSE_* → empty
// feed). Surfaced loudly at the end of runOnce so a misconfig can't silently disable all transactional
// email for days. Reset at the start of each pass.
let _feedDegraded = false;
async function apiJson(path) {
  const headers = REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {};
  const res = await fetch(`${REPORTING_API_BASE}${path}`, { headers, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`reporting-api ${res.status} ${path}`);
  const j = await res.json();
  if (j && (j.degraded || j.note === "clickhouse not configured")) _feedDegraded = true;
  return j;
}
// The /api/action-items feed hard-caps `limit` at 200 server-side regardless of what's requested —
// a single fetch with a fixed limit silently truncates any rooftop whose backlog (recent/open/overdue)
// exceeds it. Page through with `offset` + the response's `hasMore` flag until a page comes back short.
// ACTION_ITEMS_MAX_PAGES is a safety backstop (2000 items), not an expected ceiling — hitting it is
// itself surfaced (`capped:true`) to the caller rather than silently stopping, same "never hide a
// truncation" rule as the rest of this pass.
const ACTION_ITEMS_PAGE_LIMIT = 200;
const ACTION_ITEMS_MAX_PAGES = 10;
// Intents that are NEVER actionable — nothing for a rep to do about a lead that's already lost,
// or about the AI having left a voicemail (Vini keeps retrying per cadence on its own) — so they
// never generate a notification on either channel. Filtered here (the one place every
// scope=recent/open/overdue caller goes through) rather than at each call site, so a new caller
// can't forget to apply it. Extend this set later without another design pass.
// sales/service_left_voicemail: user request 2026-07-21 — "left voicemail (low)" alert lines are noise.
const NON_ACTIONABLE_INTENTS = new Set(["sales_lost_lead", "sales_left_voicemail", "service_left_voicemail"]);
const isActionable = (it) => !NON_ACTIONABLE_INTENTS.has(String(it && it.intent || "").trim().toLowerCase());
async function fetchAllActionItems(qs) {
  let all = [];
  for (let page = 0; page < ACTION_ITEMS_MAX_PAGES; page++) {
    const j = await apiJson(`/api/action-items?${qs}&limit=${ACTION_ITEMS_PAGE_LIMIT}&offset=${page * ACTION_ITEMS_PAGE_LIMIT}`);
    const items = (j.actionItems || []).filter(isActionable);
    all = all.concat(items);
    if (j.degraded) return { actionItems: all, total: j.total, degraded: true };
    if (!j.hasMore || (j.actionItems || []).length < ACTION_ITEMS_PAGE_LIMIT) return { actionItems: all, total: all.length };
  }
  return { actionItems: all, total: all.length, capped: true };
}
function links(team, ent, dept) {
  const q = `?enterprise_id=${encodeURIComponent(ent || "")}&team_id=${encodeURIComponent(team)}&serviceType=${dept}`;
  return { appointment: `${CONSOLE_BASE}/appointments${q}`, conversations: `${CONSOLE_BASE}/conversations${q}`, actionItems: `${CONSOLE_BASE}/action-items${q}`, console: CONSOLE_BASE };
}

// MTD appointment count for the post-appointment "additional value" strip.
async function apptMTD(team, dept) {
  try {
    const start = todayISO().slice(0, 8) + "01", end = todayISO();
    const j = await apiJson(`/api/reports?team_id=${team}&start=${start}&end=${end}`);
    const D = dept === "service" ? "Service" : "Sales";
    const byName = {}; for (const a of j.agents || []) byName[a.name] = a;
    const im = (byName[`${D} Inbound`] || {}).metrics || {}, om = (byName[`${D} Outbound`] || {}).metrics || {};
    return (Number(im.appointments) || 0) + (Number(om.appointments) || 0);
  } catch { return 0; }
}

async function sendMailRaw(to, subject, html, opts) {
  // Anti-churn gate: refuse a no-value email (marker stamped by the renderer)
  // unless { force: true } (DANGER override). Strip the marker off the wire.
  const force = opts && opts.force === true;
  if (emailValue.isNoValue(html)) {
    if (!force) { const e = new Error("This email shows no value — blocked to avoid churn. Override with the password to send."); e.code = "BLOCKED_NO_VALUE"; throw e; }
    html = emailValue.stripMarker(html);
  }
  const body = JSON.stringify({ to: to.join(","), subject, template: MAIL_TEMPLATE, templateData: { HTMLdata: html } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(MAIL_URL, { method: "POST", headers: { "Content-Type": "application/json", ...(MAIL_TOKEN ? { Authorization: `Bearer ${MAIL_TOKEN}` } : {}) }, body });
    if (res.ok) { const j = await res.json().catch(() => ({})); return j.messageId ?? j.id ?? null; }
    if (res.status < 500 && res.status !== 429) throw new Error(`mail ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw new Error("mail failed after retries");
}

// Public sendMail routes through the event send queue for domain reputation protection.
function sendMail(to, subject, html, opts) {
  return enqueueSendEvent(to, subject, html, opts);
}

// Insert the dedupe row FIRST (status 'queued') — the unique (team,type,event_key) guarantees
// only one worker ever claims an event. If the insert conflicts, someone already handled it → skip.
async function claim(base, eventKey) {
  const { data, error } = await sb.from("roi_event_emails")
    .insert({ ...base, event_key: eventKey, status: "queued" })
    .select("id");
  if (error) { if ((error.code || "") === "23505" || /duplicate|unique/i.test(error.message || "")) return null; throw error; }
  return data && data[0] ? data[0].id : null;
}
const finish = (id, patch) => sb.from("roi_event_emails").update(patch).eq("id", id);

// SMS ledger equivalents (roi_event_sms) — same claim-first dedupe, independent of the email row
// so an event can be both emailed and texted without either blocking the other.
async function claimSms(base, eventKey) {
  const { data, error } = await sb.from("roi_event_sms")
    .insert({ ...base, event_key: eventKey, status: "queued" })
    .select("id");
  if (error) { if ((error.code || "") === "23505" || /duplicate|unique/i.test(error.message || "")) return null; throw error; }
  return data && data[0] ? data[0].id : null;
}
const finishSms = (id, patch) => sb.from("roi_event_sms").update(patch).eq("id", id);

async function runOnce() {
  console.log(`\n── ROI EVENT pass @ ${new Date().toISOString()} · DRY_RUN=${DRY_RUN} · window=${POLL_MINUTES}m ──`);
  _feedDegraded = false;
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const [liveRes, cfgRes, recRes] = await Promise.all([
    // enterprise_id lives on roi_rooftop_config (not roi_live_departments) — read it from cfg, like runner.cjs.
    sb.from("roi_live_departments").select("team_id,department,dry_run").eq("is_live", true),
    sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,team_name,timezone,post_appointment_enabled,post_conversation_enabled,chat_enabled,action_item_enabled,action_item_overdue_enabled,post_conversation_mode,post_conversation_outbound_requires_reply,post_conversation_template,action_item_sla_minutes,sms_enabled,sms_post_conversation_cadence,working_hours,lifecycle_status,churn_date"),
    sb.from("roi_recipients").select("team_id,email,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at"),
  ]);
  if (liveRes.error || cfgRes.error || recRes.error) throw new Error((liveRes.error || cfgRes.error || recRes.error).message);
  const cfgOf = new Map((cfgRes.data ?? []).map((c) => [c.team_id, c]));
  const recOf = new Map();
  for (const r of recRes.data ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  const out = { sent: 0, suppressed: 0, skipped_dupe: 0, no_recipients: 0, errors: 0, email_batches: 0, sms_sent: 0, sms_suppressed: 0, sms_dupe: 0, sms_no_recipients: 0, sms_errors: 0, sms_batches: 0, action_items_feed_capped: 0, post_conversation_suppressed: 0, churned_skipped: 0,
    // Appointment rows dropped because meta.source says Vini didn't book them. Counted (not silent)
    // so a rooftop whose feed is full of warm_transfer rows shows up in the pass summary.
    appt_skipped_not_ours: 0 };
  const failures = []; // genuine transactional-email send failures this pass → shared Slack breakage alert
  const smsFailures = []; // genuine SMS send failures this pass → shared Slack breakage alert (SMS)
  const feedFailures = []; // upstream FEED errors (per rooftop/dept) — the pass couldn't even fetch events.
                           // These used to be swallowed (out.errors++, continue) with no alert → the pipeline
                           // failed silently for 13 days. Now they raise a Slack alert like send failures do.
  const smsDoneTeams = new Set(); // EOD SMS batch runs once per team (it's not dept-split)
  const chatDoneTeams = new Set(); // website-chat poll also runs once per team (chat has no dept either)
  const ONLY = (process.env.ONLY_TEAMS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const targets = (liveRes.data ?? []).filter((L) => !ONLY.length || ONLY.includes(L.team_id));

  for (const L of targets) {
    const c = cfgOf.get(L.team_id) || {};
    const name = c.rooftop_name || c.team_name || "";
    // dealer-local zone for windows + displayed times — configured value, else a live self-heal
    // lookup (never a silent America/New_York default for a rooftop nobody's set up yet).
    const tz = await resolveTz(sb, L.team_id, c.timezone, name);
    // ── CHURN GATE ───────────────────────────────────────────────────────────────────────────────
    // Transactional alerts are the fastest-firing surface (every few minutes), so a churned dealer
    // would otherwise keep getting appointment/action-item alerts indefinitely. Stage otherwise
    // never gates a send — churn is the sole carve-out. See subscriptions.cjs isChurned.
    if (isChurned(c, localDateISO(tz))) {
      out.churned_skipped++;
      console.log(`  · ${name} [${L.department}] skipped → churned (lifecycle=${c.lifecycle_status ?? "?"})`);
      continue;
    }
    // Real per-dealer open/close hours (falls back to a fixed hour if unresolved) — gates the
    // overdue action-item report to twice a day instead of every pass. Not dept-specific (a
    // rooftop's hours are the same for sales/service), resolved once per (team,dept) target;
    // harmless if it re-resolves live once more for the rooftop's second dept in the same pass
    // (persists on the first success either way, so only the very first pass ever pays this twice).
    const workingHours = await resolveWorkingHours(sb, L.team_id, c.working_hours, name, tz);
    const overdueMorningHour = (workingHours && parseHour(workingHours.startTime)) ?? OVERDUE_MORNING_FALLBACK_HOUR;
    const overdueEodHour = (workingHours && parseHour(workingHours.endTime)) ?? OVERDUE_EOD_FALLBACK_HOUR;
    const overdueSlot = (() => { const { h } = localHourMin(tz); return h >= overdueEodHour ? "eod" : (h === overdueMorningHour ? "am" : null); })();
    const dept = L.department; // 'sales' | 'service'
    // FORMAT of this rooftop's per-conversation email (roi_rooftop_config.post_conversation_template).
    // 'lead_capture' also DEFINES THE EMAIL SET: the lead sheet is the only per-event email these
    // dealers asked for (plus the daily digest), and the sheet already carries the follow-ups the
    // action-item emails would repeat. Superior Auto's BDC received seven "7 overdue leads" emails
    // in one evening that nobody asked for, because the *_enabled flags were re-enabled twice by
    // something that leaves no audit row — so the email set can't be enforced by config alone.
    // Switching the template back to default restores the standard types.
    const leadCapture = String(c.post_conversation_template || "") === "lead_capture";
    if (leadCapture && (c.post_appointment_enabled || c.action_item_enabled || c.action_item_overdue_enabled)) {
      console.log(`  · ${name} [${dept}] lead-capture rooftop → only the lead sheet is sent (appointment/action-item types suppressed by template)`);
    }
    const recs = recOf.get(L.team_id) ?? [];
    const deptOk = (r) => (dept === "sales" ? r.receives_sales : r.receives_service);
    // Per-TYPE recipient selection: dept + per-channel master + the subscription matrix, then
    // role-tiered (salesperson → bdc → gm; whole rooftop when no roles set). Transactional events
    // are lead-ish, so they route to the tier; a rooftop with no roles behaves exactly as before.
    // GATE: only recipients a human has verified for THIS rooftop (verified_at set) can be emailed —
    // the guarantee against a wrong-rooftop address ever receiving another rooftop's data. Unverified
    // rows are held; the daily audit alert surfaces them for a human to verify.
    // isRealEmail excludes the phone-only placeholder (…@phone.invalid) so a phone-only
    // recipient is never emailed (SMS only).
    const isRealEmail = (e) => /\S+@\S+\.\S+/.test(String(e || "")) && !/@phone\.invalid$/i.test(String(e || ""));
    const emailsForType = (type) =>
      pickTieredRecipients(recs.filter((r) => r.verified_at && isRealEmail(r.email) && deptOk(r) && r.email_enabled && isSubscribed(r, type, "email"))).map((r) => r.email);
    const smsForType = (type) =>
      c.sms_enabled
        ? pickTieredRecipients(recs.filter((r) => r.verified_at && deptOk(r) && r.sms_enabled && r.phone && isSubscribed(r, type, "sms"))).map((r) => ({ phone: r.phone, role: r.role }))
        : [];
    const base = { team_id: L.team_id, enterprise_id: c.enterprise_id, department: dept };
    const dry = DRY_RUN || L.dry_run === true;
    const L_ = links(L.team_id, c.enterprise_id, dept);

    // Build the list of (type, eventKey, render, subject) jobs for the enabled types.
    const jobs = [];
    try {
      if (c.post_appointment_enabled && !leadCapture) {
        // Query for appointments created in the last POLL_MINUTES, not meetings scheduled for today.
        // This ensures booked-but-future-scheduled appointments (e.g. booked today, appointment next month)
        // still trigger an email. scope=recent + minutes=25 means: fetch meeting records where createdAt
        // is within the last 25 minutes, regardless of when the meeting is scheduled.
        const j = await apiJson(`/api/meetings?scope=recent&team_id=${L.team_id}&enterprise_id=${encodeURIComponent(c.enterprise_id || "")}&serviceType=${dept}&minutes=${POLL_MINUTES}${SPYNE_TOKEN ? `&auth_key=${encodeURIComponent(SPYNE_TOKEN)}` : ""}`);
        const mtd = await apptMTD(L.team_id, dept);
        const candidates = (j.meetings || []).slice(0, 50);
        // meta.source per meeting — the feed doesn't carry it, so it's resolved from ClickHouse.
        // See NON_VINI_META_SOURCES for what it's for. Best-effort: no creds / lookup failure →
        // empty Map → nothing is gated, exactly as before.
        const metaSrc = await leadCaptureCH.fetchMeetingMetaSource(L.team_id, candidates.map((m) => m && m.id));
        for (const m of candidates) {
          if (!m.id) continue;
          // Only surface VINI-booked appointments (source='spyne'). Skip known BDC/CRM bookings —
          // a "Vini booked you an appointment" email about the dealer's own booking is noise.
          // (When the feed doesn't report source yet, keep firing with a generic label.)
          if (m.source && m.source !== "spyne") continue;
          // …and `source='spyne'` alone is NOT proof Vini made the booking. meta.source says how the
          // row came to exist: 'warm_transfer' rows are appointments Vini did not create, pulled in
          // around a transfer, so an email about one announces a booking that never happened.
          // Honda of Downtown Los Angeles, 2026-08-14: all 7 of the "New appointment" emails a
          // manager received for ONE customer in 6 seconds were warm_transfer rows (start times
          // Jul-2024 → Jan-2026 — her own past service visits).
          const meta = String(metaSrc.get(String(m.id)) || "").toLowerCase();
          if (NON_VINI_META_SOURCES.has(meta)) {
            out.appt_skipped_not_ours++;
            console.log(`  · ${name} [${dept}] appointment ${m.id} skipped — meta.source=${meta} (not booked by Vini)`);
            continue;
          }
          const byVini = m.source === "spyne";
          const apptData = {
            customer: m.customer, phone: m.phone, when: fmtSched(m.when, m.tz || tz), time: m.time, relDay: m.relDay,
            type: m.type || (dept === "service" ? "Service" : "Sales"), intent: m.intent, vehicle: m.vehicle,
            transportation: m.transportation || m.transportationOption, status: m.status, byVini, recordingUrl: m.recordingUrl,
            bookedAt: m.bookedAt,  // when the appointment was created
            assignedTo: m.assignedTo,  // who booked it
            leadId: m.leadId,  // link to the lead for context
          };
          jobs.push({ type: "post_appointment", key: m.id,
            subject: `${byVini ? "Vini booked an appointment" : "New appointment"} — ${name}`,
            html: T.renderPostAppointment({ rooftopName: name, dept, tz, mtdCount: mtd, links: L_, appointment: apptData }),
            smsBody: T.renderPostAppointmentSms({ rooftopName: name, dept, links: L_, appointment: apptData }),
            leadMatchKey: leadMatchKey({ leadId: m.leadId, customer: m.customer, phone: m.phone }) });
        }
      }
      if (c.action_item_enabled && !leadCapture) {
        const [recent, open] = await Promise.all([
          fetchAllActionItems(`team_id=${L.team_id}&serviceType=${dept}&scope=recent&minutes=${POLL_MINUTES}`),
          fetchAllActionItems(`team_id=${L.team_id}&serviceType=${dept}&scope=open`),
        ]);
        if (recent.capped || open.capped) {
          out.action_items_feed_capped++;
          console.warn(`  ⚠ ${name} [${dept}] action-items feed (recent/open) hit the pagination safety cap (${ACTION_ITEMS_MAX_PAGES * ACTION_ITEMS_PAGE_LIMIT}+ items) — some may be invisible this pass`);
        }
        const openItems = open.actionItems || [];
        const recentItems = recent.actionItems || [];
        // LEAD-LEVEL: group just-arrived items by their lead, then send ONE email per lead
        // carrying ALL of that lead's open action items + lead context. Falls back to grouping
        // by customer/id when the feed has no leadId yet.
        const leadKey = (it) => it.leadId || it.lead_id || it.customer || it.id;
        const byLead = new Map();
        for (const it of recentItems) { const k = leadKey(it); const g = byLead.get(k) || []; g.push(it); byLead.set(k, g); }
        // Zeigler Hyundai of Racine (Javian Perry, Aug 2026): the alert showed only OUR follow-up
        // SLA clock ("due Aug 7, 9:17 PM") — enrich each lead with the visit date+time the CUSTOMER
        // asked for on their latest call. Best-effort: no ClickHouse creds, no call on file, or no
        // time stated → the field simply doesn't render. (Non-leadId keys match nothing — harmless.)
        const apptAsks = await leadCaptureCH.fetchApptAsksByLead(L.team_id, [...byLead.keys()]);
        for (const [k, arrived] of byLead) {
          const leadOpen = openItems.filter((p) => leadKey(p) === k);
          const items = leadOpen.length ? leadOpen : arrived; // prefer the lead's full open set
          const seed = arrived[0] || items[0] || {};
          const lead = {
            customer: seed.customer || seed.leadName, phone: seed.phone, vehicle: seed.vehicle,
            source: seed.leadSource || seed.source, stage: seed.stage,
            aiScore: seed.aiScore, grade: seed.grade, sentiment: seed.sentiment, sentimentScore: seed.sentimentScore,
            lastSummary: seed.lastSummary || seed.conversationSummary,
          };
          const ask = apptAsks.get(String(k));
          if (ask) {
            lead.requestedTime = ask.requestedTime;
            lead.requestedTimeAt = ask.at; // phrases like "tomorrow" are relative to the CALL — the template dates them
            lead.requestedTimeBooked = ask.booked; // "Booked for" vs "Customer asked for"
          }
          // dedupe per lead per newest-arrived item, so a fresh item re-triggers the lead view once
          const newestId = arrived.map((x) => x.id).filter(Boolean).sort().slice(-1)[0] || k;
          jobs.push({ type: "action_item", key: `lead:${k}:${newestId}`,
            subject: `Action items — ${lead.customer || name}`,
            html: T.renderActionItem({ rooftopName: name, dept, tz, lead, items, totalOpen: leadOpen.length || items.length, justArrived: arrived.length, mtdOpen: open.total, links: L_ }),
            smsBody: T.renderActionItemSms({ rooftopName: name, dept, lead, items, totalOpen: leadOpen.length || items.length, justArrived: arrived.length, links: L_ }),
            // Raw per-lead data (not pre-rendered text) for the cross-lead batch renderers —
            // see the "EMAIL"/"SMS channel" blocks below. smsLead is a trimmed subset (fine for
            // SMS); emailLead carries the FULL lead object since leadHeader() shows more of it.
            smsLead: { customer: lead.customer, phone: lead.phone, vehicle: lead.vehicle, items, totalOpen: leadOpen.length || items.length, justArrived: arrived.length,
              requestedTime: lead.requestedTime, requestedTimeBooked: lead.requestedTimeBooked },
            emailLead: { ...lead, items, totalOpen: leadOpen.length || items.length, justArrived: arrived.length },
            // Rooftop-level (not per-lead) — `open` is out of scope by the time the batch email
            // renders, so it's carried on the job like everything else the batch render needs.
            mtdOpen: open.total,
            leadMatchKey: leadMatchKey({ leadId: seed.leadId || seed.lead_id, customer: lead.customer, phone: lead.phone }) });
        }
      }
      // Scheduled 2x/day digest (before-open + EOD, real dealer hours) — a single email per team·dept·slot
      // showing the total count + recent list of overdue items. No individual per-lead emails (which flooded
      // to 9k+/day). The SLA is already breached, so a digest on the dealer's own rhythm is more useful than
      // per-item spam. Outside the two slots, this whole block is skipped: no fetch, no build.
      if (c.action_item_overdue_enabled && overdueSlot && !leadCapture) {
        const [j, openForStat] = await Promise.all([
          fetchAllActionItems(`team_id=${L.team_id}&serviceType=${dept}&scope=overdue`),
          fetchAllActionItems(`team_id=${L.team_id}&serviceType=${dept}&scope=open`),
        ]);
        const overdue = j.actionItems || [];
        if (j.capped || openForStat.capped) {
          out.action_items_feed_capped++;
          console.warn(`  ⚠ ${name} [${dept}] overdue feed hit cap — some items may be invisible`);
        }
        const totalOverdueCount = overdue.length;
        const totalPendingAllLeads = openForStat.total;
        if (totalOverdueCount > 0) {
          // ONE digest per team·dept·slot (not per lead) — shows count + top ~10 most-urgent items
          const dayKey = localDateISO(tz);
          // Sort by dueAt (oldest first = most overdue) and take top items for the list
          const topItems = overdue
            .sort((a, b) => {
              const adue = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
              const bdue = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
              return adue - bdue;
            })
            .slice(0, 10); // Show 10 most urgent per digest
          jobs.push({ type: "action_item_overdue", key: `rooftop:${L.team_id}:${dept}:overdue:${dayKey}:${overdueSlot}`,
            subject: `Overdue items — ${totalOverdueCount} pending · ${name}`,
            html: T.renderOverdueActionItemsDigest({ rooftopName: name, dept, tz, topItems, totalOverdueCount, totalPendingAllLeads, links: L_ }),
            smsBody: T.renderOverdueActionItemsDigestSms({ rooftopName: name, dept, topItems, totalOverdueCount, links: L_ }),
            // Rooftop-level digest (not per-lead) — no leadMatchKey
          });
        }
      }
      // post_conversation runs LAST (after post_appointment/action_item/action_item_overdue above)
      // specifically so it can see their jobs and defer to them — a bare "here's a call summary"
      // for a lead that ALREADY has an action-item or appointment notification this pass is
      // redundant noise, not new signal. Leads with ONLY conversation activity are unaffected.
      if (c.post_conversation_enabled) {
        const coveredLeadKeys = new Set(jobs.map((j) => j.leadMatchKey).filter(Boolean));
        const isCovered = (cv) => {
          // LEAD-CAPTURE rooftops NEVER defer. For them the lead sheet is the product — the dealer
          // keys the lead into their CRM from it — and it already lists the action items under
          // "Follow-ups <agent> logged", so an action-item email is a strictly poorer duplicate, not
          // a reason to stay silent. Deferring here silenced EVERY sheet for the first such rooftop
          // (Aug 2026): its calls always log a follow-up, so the action-item email always won the
          // lead first and the sheet was dropped with no row and no error. Config alone couldn't fix
          // that safely — re-enabling action-item alerts would silently break the sheet again.
          if (leadCapture) return false;
          const lmk = leadMatchKey({ leadId: cv.leadId, customer: cv.customer, phone: cv.phone });
          return !!(lmk && coveredLeadKeys.has(lmk));
        };
        // CALLS → instant. One email per call as soon as the poll sees it (channel=call, the default).
        const actionableOnly = (c.post_conversation_mode || "actionable") === "actionable";
        const j = await apiJson(`/api/conversations?team_id=${L.team_id}&serviceType=${dept}&channel=call&minutes=${POLL_MINUTES}&limit=50${actionableOnly ? "&actionableOnly=1" : ""}`);
        // Roll multiple same-day calls for ONE lead into a single email — a lead phoned three times
        // in a day shouldn't generate three alerts (~30% of call emails were this redundancy). The
        // dedupe key carries an outcome TIER (plain=0, actionItem=1, appointment=2), so the first
        // real call fires once and a LATER call that books an appointment still re-fires as an
        // upgrade — but repeat plain calls to the same lead/day are suppressed. Set
        // EVENT_CALL_ROLLUP=false to fall back to one-email-per-conversation.
        const callRollup = process.env.EVENT_CALL_ROLLUP !== "false";
        const callDay = localDateISO(tz);
        const bestByLead = new Map();
        const chosen = []; // [{ key, cv, subject }] — one entry per email this pass, in either mode
        for (const cv of j.conversations || []) {
          // VOICEMAIL GATE (BOTH sales and service, BOTH directions). The agent reached an answering
          // machine, so there is no conversation to report — no human ever spoke.
          //
          // This MUST key on endedReason, not duration. The earlier `!cv.connected` test assumed a
          // voicemail call has duration 0; it does not. The agent monologues at the machine, so all
          // 2,430 outbound voicemail calls in a 2-day production sample ran 75-187s (avg 109s) and were
          // therefore `connected:true` — a 0/2,430 hit rate. Meanwhile 96.7% of ALL outbound calls end
          // in voicemail, and 5,392 of them carry an action item ("left a voicemail" follow-ups), which
          // satisfied the reply gate below. That is the "2 minutes of conversation, nothing to read"
          // email: ~2,700/day of it.
          //
          // endedReason='voicemail' is exact: across 7,125 such calls in that sample, 0 booked an
          // appointment and 0 resolved a query, so nothing of value is suppressed.
          if (T.isNoConversation(cv.endedReason)) continue;
          // OUTBOUND REPLY GATE (applies to BOTH sales and service): only email if customer responded.
          // when enabled (default), skip outbound calls with no action items / appointments.
          if (cv.direction === "outbound" && c.post_conversation_outbound_requires_reply !== false && !(cv.hasActionItem || cv.appointmentScheduled)) continue;
          // SUBSTANCE GATE — there must be something a human can actually read or act on.
          //
          // The summary check MUST go through T.cleanSummary(). `report_summary` is never literally
          // blank in production (13,359/13,359 rows had a value), so a raw `String(cv.summary).trim()`
          // test passes 100% of the time and is a no-op. What the model actually emits for a call with
          // no conversation is an EMPTY SHELL — `[]`, `[,,]`, `["",""]` — which is a truthy string but
          // renders as nothing. 47% of calls are shells like this; 3,710 of them over 3 days would have
          // emailed, and none booked. cleanSummary resolves a shell to "" so this gate can see it, and
          // it is the SAME function the template renders with, so gate and email cannot disagree.
          //
          // A transcript deliberately does NOT count: a screener/IVR call transcribes the machine's
          // words ("please record your message"), which is exactly the empty email being stopped.
          if (!(T.cleanSummary(cv.summary) || cv.hasActionItem || cv.appointmentScheduled || cv.queryResolved === true)) continue;
          // spam gate — a call the model flagged as spam is never a real conversation. No-op until
          // the conversations feed surfaces `spam`; harmless when absent.
          if (cv.spam === true || cv.spam === "Yes") continue;
          if (isCovered(cv)) { out.post_conversation_suppressed++; continue; }
          if (!callRollup) { chosen.push({ key: cv.id, cv, subject: `Conversation summary — ${name}` }); continue; }
          const k = cv.leadId || cv.id;
          const rank = cv.appointmentScheduled ? 2 : cv.hasActionItem ? 1 : 0;
          const prev = bestByLead.get(k);
          // keep the highest-outcome call for the lead; tie-break on the most recent.
          if (!prev || rank > prev.rank || (rank === prev.rank && String(cv.at || "") > String(prev.cv.at || ""))) bestByLead.set(k, { cv, rank });
        }
        for (const [k, { cv, rank }] of bestByLead) {
          chosen.push({ key: `call:lead:${k}:${callDay}:t${rank}`, cv, subject: `Conversation summary — ${cv.customer || name}` });
        }
        // 'lead_capture' rooftops want a lead sheet, not a conversation summary — the extra fields
        // (requested vehicle, financing/trade-in flags, preferred time + store, the ZIP the caller
        // gave, the transcript) are NOT on the funnel feed, so they're enriched from ClickHouse in
        // ONE batched query for this pass's calls. WHICH calls email is untouched — every gate above
        // already decided that. A call the enrichment can't resolve falls back to the standard
        // email: never a dropped alert. (`leadCapture` is resolved above, next to the coverage rule.)
        // This same batched query now ALSO runs for standard (non-lead-capture) rooftops, because the
        // conversation summary's "What the customer shared" rows (financing, trade-in) come from the
        // same report_sales fields and are not on the funnel feed either. It stays one query per pass,
        // and the voicemail gate above means `chosen` is now a small fraction of what it used to be.
        // Standard rooftops use it for those rows ONLY — the lead-sheet branch below is still gated on
        // `leadCapture`, so which template a rooftop gets is unchanged.
        let extras = new Map();
        if (chosen.length) {
          if (leadCapture && !leadCaptureCH.hasCreds()) console.warn(`[events] ${name}: post_conversation_template=lead_capture but CLICKHOUSE_HOST/PASSWORD are unset — falling back to the standard conversation email`);
          extras = await leadCaptureCH.fetchLeadFields(L.team_id, chosen.map((x) => x.cv.id));
        }
        // STANDARD summaries get the same requested-time enrichment as the action-item emails
        // (Zeigler ask, Aug 2026): a call that only REQUESTED a slot shows nothing today — the
        // appointment card renders only when the call actually booked. Keyed on the conversation's
        // OWN call, so the time shown is the one asked on the call being summarized. Lead-capture
        // sheets already carry apptWhen and skip this.
        const callAsks = (!leadCapture && chosen.length)
          ? await leadCaptureCH.fetchApptAsksByCall(L.team_id, chosen.map((x) => x.cv.id))
          : new Map();
        for (const { key, cv, subject } of chosen) {
          const lx = extras.get(String(cv.id));
          // `leadCapture &&` is LOAD-BEARING. `extras` is now fetched for every rooftop (see above), so
          // without this guard a standard rooftop with resolvable enrichment would silently start
          // receiving the lead SHEET instead of its conversation summary. The template a rooftop gets
          // must depend only on its own post_conversation_template setting.
          if (leadCapture && lx) {
            // feed values are the fallback for identity only — the rest is the sales sub-report.
            const lead = { ...lx, customer: lx.customer || cv.customer || "", phone: lx.phone || cv.phone || "", at: lx.at || cv.at };
            const vehLabel = [lead.vehicleType, lead.vehicle].filter(Boolean).join(" ").trim();
            jobs.push({ type: "post_conversation", key,
              subject: `New lead — ${lead.customer || name}${vehLabel ? ` · ${vehLabel}` : ""}`,
              html: T.renderLeadCapture({ rooftopName: name, dept, tz, lead, links: L_ }) });
            continue;
          }
          // Standard summary: carry over the sales fields the funnel feed doesn't have. Vehicle prefers
          // the feed's own value and only falls back to enrichment, so the summary keeps describing the
          // call it is about.
          if (lx) {
            cv.email = cv.email || lx.email;
            cv.financing = cv.financing || lx.financing;
            cv.tradeIn = cv.tradeIn || lx.tradeIn;
            cv.vehicle = cv.vehicle || lx.vehicle;
            cv.transcript = cv.transcript || lx.transcript;
          }
          const ask = callAsks.get(String(cv.id));
          if (ask && !cv.appointmentScheduled) {
            cv.requestedTime = ask.requestedTime;
            cv.requestedTimeBooked = ask.booked; // report says booked but feed flag lagged → "Booked for"
          }
          jobs.push({ type: "post_conversation", key, subject,
            html: T.renderPostConversation({ rooftopName: name, dept, tz, conversation: cv, links: L_ }) });
        }
        // SMS post-conversation — CADENCE is per rooftop (roi_rooftop_config.sms_post_conversation_cadence):
        //   'daily'  (default) — ONE end-of-day digest per lead/day; a late same-day reply folds in, the
        //                        next day starts a fresh email. Cheapest, least immediate.
        //   'session'          — split a lead's thread on lulls > EVENT_SMS_SESSION_GAP_MIN (default 180m);
        //                        each SETTLED burst that had a customer reply is its own email. Timelier.
        //   'first_plus_digest'— an instant push on the lead's FIRST reply of the day, plus the EOD digest.
        // Every key is dept-agnostic + day-scoped, so multi-day flows always start a new email and
        // roi_event_(emails|sms) dedupe holds across passes. SMS is processed once per team per pass.
        const smsCadence = c.sms_post_conversation_cadence || "daily";
        const gapMin = Number(process.env.EVENT_SMS_SESSION_GAP_MIN || 180);
        const { h, m } = localHourMin(tz);
        const isEod = h >= SMS_EOD_HOUR;
        const day = localDateISO(tz);
        // 'daily' only needs to work at EOD; the timelier modes run every pass (dedupe de-dups).
        const runSmsNow = (smsCadence === "daily" ? isEod : true) && !smsDoneTeams.has(L.team_id);
        if (runSmsNow) {
          smsDoneTeams.add(L.team_id);
          const sinceMin = Math.min(10_080, h * 60 + m + 1); // window back to local midnight
          const js = await apiJson(`/api/conversations?team_id=${L.team_id}&serviceType=both&channel=sms&minutes=${sinceMin}&limit=200`);
          const byLead = new Map(); // one lead's SMS threads for the day
          for (const cv of js.conversations || []) {
            // No customer reply → nothing to report (an all-AI outbound blast isn't a "conversation").
            if (!cv.hasReply && c.post_conversation_outbound_requires_reply !== false) continue;
            if (isCovered(cv)) { out.post_conversation_suppressed++; continue; }
            const k = cv.leadId || cv.id;
            const g = byLead.get(k) || []; g.push(cv); byLead.set(k, g);
          }
          const nowT = Date.now();
          // LEAD-CAPTURE (same rooftop flag as the call path): a text reply is shown as the dealer's
          // lead sheet too, not a second email format. The thread itself carries no sales sub-report,
          // so the fields come from that LEAD's own call (the agent texts the pre-qual/trade-in links at the
          // end of the call she just had); a lead with no call falls back to a thread-only sheet.
          const smsLeadFields = leadCapture
            ? await leadCaptureCH.fetchLeadFieldsByLead(L.team_id, [...byLead.keys()])
            : new Map();
          // Build one SMS post_conversation job from a slice of a lead's messages.
          const pushSms = (seed, msgs, key, label, leadKey) => {
            const sms = msgs.slice(-12);
            const cv = { ...seed, channel: "sms", sms, smsFailed: sms.filter((b) => ["failed", "undelivered", "error"].includes(b.status)).length };
            if (leadCapture) {
              const lead = leadCaptureCH.buildSmsLead(smsLeadFields.get(String(leadKey)) || null, seed, cv.sms);
              const vehLabel = [lead.vehicleType, lead.vehicle].filter(Boolean).join(" ").trim();
              jobs.push({ type: "post_conversation", key,
                subject: `Text reply — ${lead.customer || name}${vehLabel ? ` · ${vehLabel}` : ""}`,
                html: T.renderLeadCapture({ rooftopName: name, dept, tz, lead, links: L_ }),
                smsBody: T.renderPostConversationSms({ rooftopName: name, dept, conversation: cv, links: L_ }) });
              return;
            }
            jobs.push({ type: "post_conversation", key,
              subject: `SMS ${label} — ${seed.customer || name}`,
              html: T.renderPostConversation({ rooftopName: name, dept, tz, conversation: cv, links: L_ }),
              smsBody: T.renderPostConversationSms({ rooftopName: name, dept, conversation: cv, links: L_ }) });
          };
          for (const [k, threads] of byLead) {
            threads.sort((a, b) => String(a.at).localeCompare(String(b.at)));
            const seed = threads[threads.length - 1];
            const allMsgs = threads.flatMap((t) => t.sms || []).filter((x) => x && x.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
            if (smsCadence === "session") {
              // one email per SETTLED burst (quiet for > gapMin) that had a customer reply; at EOD,
              // flush any still-open burst so nothing is dropped.
              for (const s of smsSessions(allMsgs, gapMin)) {
                if (!s.hasReply) continue;
                if ((nowT - s._lastT) <= gapMin * 60000 && !isEod) continue; // still active → wait
                pushSms(seed, s.msgs, `sms:${k}:${day}:s${s.startAt}`, "conversation", k);
              }
            } else if (smsCadence === "first_plus_digest") {
              // instant: the lead's FIRST customer reply of the day (fires the pass we first see it).
              const firstIdx = allMsgs.findIndex(isInboundSms);
              if (firstIdx >= 0) pushSms(seed, allMsgs.slice(0, firstIdx + 1), `sms:${k}:${day}:first`, "reply", k);
              // digest: the full day's thread, at EOD only.
              if (isEod) pushSms(seed, allMsgs, `sms:${k}:${day}:digest`, "summary", k);
            } else {
              // 'daily' (default): one digest per lead/day.
              pushSms(seed, allMsgs, `sms:${k}:${day}`, "summary", k);
            }
          }
        }
      }
      // ── CHAT channel — website-chatbot threads (dealer_leads.conversations type='chat'; the
      // bubbles share the SMS store, so the feed row looks like an SMS thread plus the widget's
      // own analysis: summary, sentiment, outcome, booked-appointment flag, action items).
      //
      // LIVE-FOR-ALL-TEAMS GATING (deliberately NOT post_conversation_enabled): chat is a distinct,
      // rare, high-intent surface (~tens/day fleet-wide vs hundreds of calls), so it must not
      // inherit the call channel's noise controls. Rooftop gate = roi_rooftop_config.chat_enabled,
      // DEFAULT ON (a missing row/column counts as enabled — set false to opt a rooftop out).
      // Recipient matching likewise uses its own 'chat' subscription key (subscriptionType below,
      // default ON for email): most seeded recipients carry an explicit post_conversation:false
      // (call-summary noise), and riding that cell would silence chat for exactly the dealers with
      // the most chat traffic (e.g. New Brighton Ford: 28 replied chats/30d, 0 post_conversation
      // subscribers). EMAIL-ONLY for now — no smsBody, so the dealer-SMS channel never fires for
      // chat (a new subscription key defaults SMS ON, which would text people who never opted in).
      // Everything else that guards sends still applies: dealer dry_run, global DRY_RUN, churn
      // gate, verified-recipient gate, and the roi_event_emails dedupe.
      //
      // A chat is a LIVE session — emailing on first sight would ship a half-finished thread — so a
      // burst only emails once it SETTLES (quiet > EVENT_CHAT_SESSION_GAP_MIN), the backend marks
      // the conversation completed, or the EOD flush. Same session mechanics as the SMS 'session'
      // cadence; keys are conversation+day+session-start scoped, so a visitor who returns later
      // the same day emails again with the new burst and dedupe holds across passes. A real
      // visitor message is REQUIRED (hard gate, not config): the widget auto-greets on page view,
      // so an all-AI thread is noise, not a conversation. Chat renders the standard conversation
      // email everywhere for now (incl. lead_capture rooftops — the chat feed carries none of the
      // lead-sheet sub-report fields, and a visitor-typed thread is the record the dealer works).
      // Kill switch: EVENT_CHAT_CHANNEL=false (default ON). Once per team per pass (no dept split).
      if (process.env.EVENT_CHAT_CHANNEL !== "false" && c.chat_enabled !== false && !chatDoneTeams.has(L.team_id)) {
        chatDoneTeams.add(L.team_id);
        const chatGapMin = Number(process.env.EVENT_CHAT_SESSION_GAP_MIN || 30);
        const { h, m } = localHourMin(tz);
        const isEod = h >= SMS_EOD_HOUR;
        const day = localDateISO(tz);
        const sinceMinChat = Math.min(10_080, h * 60 + m + 1); // window back to local midnight
        const jc = await apiJson(`/api/conversations?team_id=${L.team_id}&serviceType=both&channel=chat&minutes=${sinceMinChat}&limit=200`);
        const nowC = Date.now();
        // Defer to a same-pass appointment/action-item email for the same lead (same rule as the
        // call/SMS paths) — that email already carries the chat lead's context.
        const coveredLeadKeys = new Set(jobs.map((j) => j.leadMatchKey).filter(Boolean));
        for (const cv of jc.conversations || []) {
          if (!cv.hasReply) continue; // auto-greeting with no visitor reply — never email
          const lmk = leadMatchKey({ leadId: cv.leadId, customer: cv.customer, phone: cv.phone });
          if (lmk && coveredLeadKeys.has(lmk)) { out.post_conversation_suppressed++; continue; }
          const allMsgs = (cv.sms || []).filter((x) => x && x.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
          const done = String(cv.status || "") === "completed";
          for (const s of smsSessions(allMsgs, chatGapMin)) {
            if (!s.hasReply) continue;
            if ((nowC - s._lastT) <= chatGapMin * 60000 && !isEod && !done) continue; // still active → wait
            const conv = { ...cv, channel: "chat", sms: s.msgs.slice(-12) };
            jobs.push({ type: "post_conversation", subscriptionType: "chat", key: `chat:${cv.id}:${day}:s${s.startAt}`,
              subject: `Website chat — ${cv.customer || name}`,
              html: T.renderPostConversation({ rooftopName: name, dept, tz, conversation: conv, links: L_ }) });
          }
        }
      }
    } catch (e) { out.errors++; feedFailures.push({ rooftop: name, dept, error: String(e && e.message ? e.message : e).slice(0, 200) }); console.log(`  ✗ ${name} [${dept}] feed error: ${String(e).slice(0, 140)}`); continue; }

    // action_item / action_item_overdue are BATCHED across leads below — the same reasoning as
    // the SMS channel (a large backlog otherwise means one full email per lead, back-to-back).
    // post_appointment / post_conversation stay on this unchanged one-email-per-job path.
    const BATCH_EMAIL_TYPES = new Set(["action_item", "action_item_overdue"]);

    // ── 1) unchanged path — one email per job ──
    for (const job of jobs) {
      if (BATCH_EMAIL_TYPES.has(job.type)) continue;
      let id;
      try {
        id = await claim({ ...base, email_type: job.type }, job.key);
        if (!id) { out.skipped_dupe++; continue; } // already handled in a prior pass
        // Recipients are chosen PER TYPE (subscription matrix + role tier), not per rooftop.
        // subscriptionType overrides the matrix key when a job's audience differs from its stored
        // email_type — chat jobs store as post_conversation (tracker/dedupe grain) but match the
        // 'chat' key so a recipient's call-noise opt-out doesn't silence chat.
        const emails = emailsForType(job.subscriptionType || job.type);
        // Inject the open-tracking pixel now that we have the row id, so the stored
        // HTML and the sent bytes both carry it (id keys the open back to this row).
        const html = withPixel(job.html, id);
        // Always store the generated HTML — even when we can't send (no recipient) — so the tracker
        // always has a copy to view and you can send it manually later.
        if (!emails.length) { await finish(id, { status: "not_sent", reason: "recipients_missing", subject: job.subject, rendered_html: html }); out.no_recipients++; continue; }
        if (dry) { await finish(id, { status: "suppressed", reason: "dry_run", subject: job.subject, rendered_html: html, recipients: emails.map((e) => ({ email: e })) }); out.suppressed++; continue; }
        const sentAt = new Date().toISOString();
        const messageId = await sendMailAttributed(emails, job.subject, html);
        await finish(id, { status: "sent", subject: job.subject, rendered_html: html, message_id: messageId || `evt-${sentAt}`, sent_at: sentAt, recipients: emails.map((e) => ({ email: e, received: true })) });
        out.sent++;
      } catch (e) { out.errors++; failures.push({ rooftop: name, dept: job.type || dept, error: String(e && e.message ? e.message : e).slice(0, 200) }); if (id) { try { await finish(id, { status: "error", reason: String(e).slice(0, 300), rendered_html: job.html }); } catch { /* ignore */ } } }
    }

    // ── 2) batched path — action_item / action_item_overdue, one email per TYPE covering every
    // freshly-claimed lead this pass ──
    const batchEmailTypes = new Set(jobs.filter((j) => BATCH_EMAIL_TYPES.has(j.type)).map((j) => j.type));
    for (const type of batchEmailTypes) {
      const typeJobs = jobs.filter((j) => j.type === type);
      const emails = emailsForType(type); // type-scoped, computed once — not per lead

      // Claim EVERY lead's row first — this is what preserves per-lead dedupe + the tracker's
      // per-lead audit rows. Only jobs that come back freshly-claimed go into the batch. Email
      // claims unconditionally (even no-recipients / dry-run cases still claim + mark a status —
      // matching this channel's existing behavior, unlike SMS which skips claiming in those cases).
      const claimed = [];
      for (const job of typeJobs) {
        let id;
        try { id = await claim({ ...base, email_type: job.type }, job.key); }
        catch (e) { out.errors++; failures.push({ rooftop: name, dept: job.type, error: String(e && e.message ? e.message : e).slice(0, 200) }); continue; }
        if (!id) { out.skipped_dupe++; continue; }
        claimed.push({ job, id });
      }
      if (!claimed.length) continue; // everything was a dupe this pass — nothing to send

      if (!emails.length) {
        // No recipients for this type at all — mark each freshly-claimed lead not_sent, same as
        // today's per-lead behavior, using its OWN individual html (nothing was actually batched/sent).
        for (const { job, id } of claimed) {
          const html = withPixel(job.html, id);
          try { await finish(id, { status: "not_sent", reason: "recipients_missing", subject: job.subject, rendered_html: html }); }
          catch (e) { console.warn(`  ⚠ finish failed for a claimed row (${type}): ${String(e).slice(0, 140)}`); }
        }
        out.no_recipients += claimed.length;
        continue;
      }

      // Render ONE body covering every freshly-claimed lead. N=1 delegates to the exact
      // single-lead renderer (byte-identical to today's email, not a "1 lead" layout).
      const leads = claimed.map((c2) => c2.job.emailLead);
      const renderBatch = type === "action_item_overdue" ? T.renderActionItemOverdueBatch : T.renderActionItemBatch;
      const subject = leads.length > 1
        ? (type === "action_item_overdue" ? `${leads.length} overdue leads — ${name}` : `${leads.length} leads with new action items — ${name}`)
        : claimed[0].job.subject;
      const rawHtml = renderBatch({
        rooftopName: name, dept, tz, leads, links: L_, mtdOpen: claimed[0].job.mtdOpen,
        totalPendingAllLeads: claimed[0].job.totalPendingAllLeads,
        detailCap: Number(process.env.EVENT_EMAIL_BATCH_DETAIL_CAP || 20),
      });
      // Pixel is keyed to ONE row (the first claimed lead) — there's one physical email, one open
      // event; roi_event_emails has one opened_at/open_count PER ROW, not a shared one.
      const html = withPixel(rawHtml, claimed[0].id);

      if (dry) {
        for (const { id } of claimed) {
          try { await finish(id, { status: "suppressed", reason: "dry_run", subject, rendered_html: html, recipients: emails.map((e) => ({ email: e })) }); }
          catch (e) { console.warn(`  ⚠ finish failed for a claimed row (${type}): ${String(e).slice(0, 140)}`); }
        }
        out.suppressed += claimed.length;
        continue;
      }

      const sentAt = new Date().toISOString();
      let messageId = null, sendErr = null;
      try { messageId = await sendMailAttributed(emails, subject, html); }
      catch (e) { sendErr = e; }

      // Fan the SAME outcome back to EVERY claimed lead row — none silently vanish. A row's
      // `rendered_html` is what ACTUALLY went out (the full batch), not a per-lead reconstruction.
      for (const { id } of claimed) {
        try {
          if (sendErr) await finish(id, { status: "error", reason: String(sendErr).slice(0, 300), subject, rendered_html: html });
          else await finish(id, { status: "sent", subject, rendered_html: html, message_id: messageId || `evt-${sentAt}`, sent_at: sentAt, recipients: emails.map((e) => ({ email: e, received: true })) });
        } catch (e) { console.warn(`  ⚠ finish failed for a batched row (${type}): ${String(e).slice(0, 140)}`); }
      }
      out.email_batches++;
      if (sendErr) {
        out.errors += claimed.length;
        // One failure entry PER LEAD (not per batch) so the existing Slack alert's tiered
        // warn/crit thresholds scale with real blast radius.
        for (let i = 0; i < claimed.length; i++) {
          failures.push({ rooftop: name, dept: type, error: `batch of ${claimed.length} (${type}): ` + String(sendErr && sendErr.message ? sendErr.message : sendErr).slice(0, 200) });
        }
      } else out.sent += claimed.length;
    }

    // ── SMS channel — same events, texted to the type's subscribed + role-tiered phones ──
    // Only SMS-able job types (those carrying smsBody). Recipients are chosen PER TYPE
    // (subscription matrix + role tier), NOT per lead — every job of a given type this pass
    // resolves to the exact same phone(s). Independent dedupe (roi_event_sms). We claim ONLY when a
    // real send will happen — a dry-run neither claims nor sends, so enabling SMS later isn't
    // pre-empted by a suppressed row. post_conversation SMS rides its EOD batch (jobs only exist at EOD).
    if (c.sms_enabled) {
      // SMS is its OWN channel — gated by SMS_DRY_RUN, NOT the email pipeline's global DRY_RUN
      // (emails may be deliberately held in dry-run while SMS is live). Per-dealer dry_run still
      // holds both channels for that rooftop.
      const smsDry = SMS_DRY_RUN || L.dry_run === true;
      // action_item / action_item_overdue are BATCHED across leads below (one text can otherwise
      // become 40+ near-simultaneous texts to the same phone when a rooftop's backlog is large —
      // see the Jones Chrysler Dodge Jeep Ram incident). post_appointment / post_conversation stay
      // on this unchanged one-SMS-per-job path — they're lower volume and each already reads as its
      // own distinct event.
      const BATCH_SMS_TYPES = new Set(["action_item", "action_item_overdue"]);

      // ── 1) unchanged path — one SMS per job ──
      for (const job of jobs) {
        if (!job.smsBody || BATCH_SMS_TYPES.has(job.type)) continue;
        const smsRecipients = smsForType(job.type);
        if (!smsRecipients.length) { out.sms_no_recipients++; continue; } // nobody subscribed to this type on SMS
        if (smsDry) { out.sms_suppressed++; continue; }
        let sid;
        try {
          sid = await claimSms({ ...base, email_type: job.type }, job.key);
          if (!sid) { out.sms_dupe++; continue; } // already texted in a prior pass
          const sentAt = new Date().toISOString();
          const results = [];
          for (const r of smsRecipients) {
            await sleep(SMS_SEND_STAGGER_MS);
            try { const msid = await sendSms(r.phone, job.smsBody, { dryRun: false }); results.push({ phone: r.phone, role: r.role, sid: msid, sent: true }); }
            catch (e) { results.push({ phone: r.phone, role: r.role, error: String(e.message || e).slice(0, 200) }); }
          }
          const firstSid = (results.find((x) => x.sid) || {}).sid || null;
          const anySent = results.some((x) => x.sent);
          await finishSms(sid, { status: anySent ? "sent" : "error", reason: anySent ? null : "all_recipients_failed", body: job.smsBody, message_sid: firstSid, sent_at: anySent ? sentAt : null, recipients: results });
          if (anySent) out.sms_sent++; else { out.sms_errors++; smsFailures.push({ rooftop: name, dept: job.type, error: (results.find((x) => x.error) || {}).error || "all recipients failed" }); }
        } catch (e) { out.sms_errors++; smsFailures.push({ rooftop: name, dept: job.type, error: String(e && e.message ? e.message : e).slice(0, 200) }); if (sid) { try { await finishSms(sid, { status: "error", reason: String(e).slice(0, 300), body: job.smsBody }); } catch { /* ignore */ } } }
      }

      // ── 2) batched path — action_item / action_item_overdue, one text per TYPE covering every
      // freshly-claimed lead this pass, not one text per lead ──
      const batchTypes = new Set(jobs.filter((j) => j.smsBody && BATCH_SMS_TYPES.has(j.type)).map((j) => j.type));
      for (const type of batchTypes) {
        const typeJobs = jobs.filter((j) => j.type === type);
        const smsRecipients = smsForType(type); // type-scoped, computed once — not per lead
        if (!smsRecipients.length) { out.sms_no_recipients += typeJobs.length; continue; }
        if (smsDry) { out.sms_suppressed += typeJobs.length; continue; } // dry-run: claim nothing, as today

        // Claim EVERY lead's row first — this is what preserves per-lead dedupe + the tracker's
        // per-lead audit rows. Only jobs that come back freshly-claimed (not a dupe from a prior
        // pass or an earlier claim today) go into the batch.
        const claimed = [];
        for (const job of typeJobs) {
          let sid;
          try { sid = await claimSms({ ...base, email_type: job.type }, job.key); }
          catch (e) { out.sms_errors++; smsFailures.push({ rooftop: name, dept: job.type, error: String(e && e.message ? e.message : e).slice(0, 200) }); continue; }
          if (!sid) { out.sms_dupe++; continue; }
          claimed.push({ job, sid });
        }
        if (!claimed.length) continue; // everything was a dupe this pass — nothing to send

        // Render ONE body covering every freshly-claimed lead. N=1 delegates to the exact
        // single-lead renderer (byte-identical to today's message, not a "1 lead:" list).
        const leads = claimed.map((c2) => c2.job.smsLead);
        const renderBatch = type === "action_item_overdue" ? T.renderActionItemOverdueBatchSms : T.renderActionItemBatchSms;
        const smsBody = renderBatch({
          rooftopName: name, dept, leads, links: L_,
          detailCap: Number(process.env.EVENT_SMS_BATCH_DETAIL_CAP || 8),
          maxChars: Number(process.env.EVENT_SMS_BATCH_MAX_CHARS || 1500),
        });

        const sentAt = new Date().toISOString();
        const results = [];
        for (const r of smsRecipients) {
          await sleep(SMS_SEND_STAGGER_MS);
          try { const msid = await sendSms(r.phone, smsBody, { dryRun: false }); results.push({ phone: r.phone, role: r.role, sid: msid, sent: true }); }
          catch (e) { results.push({ phone: r.phone, role: r.role, error: String(e.message || e).slice(0, 200) }); }
        }
        const anySent = results.some((x) => x.sent);
        const firstSid = (results.find((x) => x.sid) || {}).sid || null;
        const reason = anySent
          ? (claimed.length > 1 ? `batched (${claimed.length} leads this pass)` : null)
          : "all_recipients_failed";

        // Fan the SAME outcome back to EVERY claimed lead row — none silently vanish. A row's
        // `body` is what ACTUALLY went out (the full batch text), not a per-lead reconstruction.
        for (const { sid } of claimed) {
          try { await finishSms(sid, { status: anySent ? "sent" : "error", reason, body: smsBody, message_sid: firstSid, sent_at: anySent ? sentAt : null, recipients: results }); }
          catch (e) { console.warn(`  ⚠ finishSms failed for a batched row (${type}): ${String(e).slice(0, 140)}`); }
        }
        out.sms_batches++;
        if (anySent) out.sms_sent += claimed.length;
        else {
          out.sms_errors += claimed.length;
          // One failure entry PER LEAD (not per batch) so the existing Slack alert's tiered
          // warn/crit thresholds scale with real blast radius — a 40-lead batch failure reads as
          // loud as 40 individual failures did before batching, not as "1".
          for (let i = 0; i < claimed.length; i++) {
            smsFailures.push({ rooftop: name, dept: type, error: `batch of ${claimed.length} (${type}): ` + ((results.find((x) => x.error) || {}).error || "all recipients failed") });
          }
        }
      }
    }
  }
  if (_feedDegraded) {
    out.feed_degraded = true;
    console.error("  ⚠️  reporting-vini feed DEGRADED (clickhouse not configured) — transactional emails are DISABLED until CLICKHOUSE_HOST/CLICKHOUSE_PASSWORD are set on the reporting-vini deployment. No events were sent this pass.");
    // Loud, systemic alert — this disables the WHOLE pipeline and used to only console.error (invisible).
    await postSystemicAlert({
      source: "Transactional email",
      title: "reporting-vini feed DEGRADED — transactional pipeline DISABLED",
      detail: "The reporting-vini `/api/conversations` + `/api/action-items` feeds returned degraded (ClickHouse not configured / unauthorized). Set CLICKHOUSE_HOST / CLICKHOUSE_PASSWORD (and confirm CRON_SECRET auth) on the reporting-vini deployment.",
      windowLabel: `event email pass (~${POLL_MINUTES}m)`,
    }).catch((e) => console.warn("[roi-event] systemic alert skipped:", String(e).slice(0, 140)));
  }
  console.log("  events summary:", JSON.stringify(out));
  console.log(`  sms summary: sent=${out.sms_sent} suppressed=${out.sms_suppressed} dupe=${out.sms_dupe} no_recipients=${out.sms_no_recipients} errors=${out.sms_errors} batches=${out.sms_batches}`);
  // Breakage alert → Slack when transactional emails genuinely failed to send this pass (same tiered
  // warn/crit thresholds + channel as the digest alert). Best-effort; never throws.
  await postBreakageAlert({ source: "Transactional email", failures, sentOk: out.sent, windowLabel: `event email pass (~${POLL_MINUTES}m)` })
    .catch((e) => console.warn("[roi-event] slack alert skipped:", String(e).slice(0, 140)));
  // FEED-level failures (couldn't fetch events for a rooftop) — previously swallowed. Alert on them too,
  // so a broken/unauthorized upstream feed surfaces instead of silently producing zero emails.
  await postBreakageAlert({ source: "Transactional feed", failures: feedFailures, sentOk: out.sent, windowLabel: `event feed fetch (~${POLL_MINUTES}m)` })
    .catch((e) => console.warn("[roi-event] feed alert skipped:", String(e).slice(0, 140)));
  // Same tiered warn/crit alert for the SMS channel — a Twilio/render failure surfaces the same way.
  await postBreakageAlert({ source: "SMS", failures: smsFailures, sentOk: out.sms_sent, windowLabel: `event SMS pass (~${POLL_MINUTES}m)` })
    .catch((e) => console.warn("[roi-event] sms slack alert skipped:", String(e).slice(0, 140)));
  return out;
}

// ── LIVE PREVIEW (dashboard) ─────────────────────────────────────────────────
// Re-render ONE transactional email on demand with the CURRENT template, pulling the
// customer's real data from the reporting feeds. Powers the tracker's "Latest design"
// toggle so a manager can preview the up-to-date email per customer even when the
// stored copy is older (or no event has been sent yet). Mirrors the runOnce mapping.
// Returns rendered HTML, or null when the referenced item can't be found.
async function previewEvent(opts) {
  opts = opts || {};
  const dept = opts.department === "service" ? "service" : "sales";
  const name = opts.rooftopName || "";
  const teamId = opts.teamId, ent = opts.enterpriseId || "";
  const tz = await resolveTz(sb, teamId, opts.tz, name);
  const emailType = opts.emailType, eventKey = String(opts.eventKey || "");
  const L_ = links(teamId, ent, dept);
  // When a specific event was clicked (eventKey present) we must render THAT customer or nothing.
  // Falling back to the feed's most-recent item rendered a different customer's PII into the
  // preview (the "shows data for <someone else>" bug). The representative-customer fallback is only
  // allowed for the synthetic "latest design" preview, which carries no eventKey.
  const keyed = eventKey !== "";

  if (emailType === "post_appointment") {
    const day = localDateISO(tz);
    const j = await apiJson(`/api/meetings?scope=window&team_id=${teamId}&enterprise_id=${encodeURIComponent(ent)}&serviceType=${dept}&start=${day}&end=${day}${SPYNE_TOKEN ? `&auth_key=${encodeURIComponent(SPYNE_TOKEN)}` : ""}`);
    const list = j.meetings || [];
    const m = list.find((x) => String(x.id) === eventKey) || (keyed ? null : list[0]);
    if (!m) return null;
    const mtd = await apptMTD(teamId, dept).catch(() => 0);
    return T.renderPostAppointment({ rooftopName: name, dept, tz, mtdCount: mtd, links: L_, appointment: {
      customer: m.customer, phone: m.phone, when: fmtSched(m.when, m.tz || tz), time: m.time, relDay: m.relDay,
      type: m.type || (dept === "service" ? "Service" : "Sales"), intent: m.intent, vehicle: m.vehicle,
      transportation: m.transportation || m.transportationOption, status: m.status, byVini: m.source === "spyne", recordingUrl: m.recordingUrl,
    } });
  }

  if (emailType === "post_conversation") {
    const j = await apiJson(`/api/conversations?team_id=${teamId}&serviceType=${dept}&minutes=20160&limit=200`);
    const list = j.conversations || [];
    const cv = list.find((x) => String(x.id) === eventKey) || (keyed ? null : list[0]);
    if (!cv) return null;
    return T.renderPostConversation({ rooftopName: name, dept, tz, conversation: cv, links: L_ });
  }

  // action_item / action_item_overdue → eventKey is `lead:<leadKey>:…`
  const leadKey = eventKey.replace(/^lead:/, "").split(":")[0];
  const scope = emailType === "action_item_overdue" ? "overdue" : "open";
  const j = await apiJson(`/api/action-items?team_id=${teamId}&serviceType=${dept}&scope=${scope}&limit=200`);
  const all = j.actionItems || [];
  const keyOf = (it) => it.leadId || it.lead_id || it.customer || it.id;
  const items = leadKey ? all.filter((it) => String(keyOf(it)) === leadKey) : [];
  // Keyed click → only that lead's items (never another lead's, which showed the wrong customer's
  // action items). all.slice fallback is reserved for the synthetic, key-less preview.
  const use = items.length ? items : (keyed ? [] : all.slice(0, 4));
  if (!use.length) return null;
  const seed = use[0] || {};
  const lead = {
    customer: seed.customer || seed.leadName, phone: seed.phone, vehicle: seed.vehicle,
    source: seed.leadSource || seed.source, stage: seed.stage,
    aiScore: seed.aiScore, grade: seed.grade, sentiment: seed.sentiment, sentimentScore: seed.sentimentScore,
    lastSummary: seed.lastSummary || seed.conversationSummary,
  };
  if (emailType === "action_item_overdue") {
    const oldest = use.map((x) => x.dueAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
    return T.renderActionItemOverdue({ rooftopName: name, dept, tz, lead, items: use, oldestDueAt: oldest, totalOverdue: use.length, links: L_ });
  }
  return T.renderActionItem({ rooftopName: name, dept, tz, lead, items: use, totalOpen: use.length, justArrived: 0, mtdOpen: j.total, links: L_ });
}

module.exports = { runOnce, previewEvent, isUSActiveWindow };
if (IS_CLI) {
  (async () => {
    await runOnce();
    // --loop mirrors the prod cron cadence: ~4 min while US dealers are open, 15 min deep-night.
    // Self-scheduling setTimeout (not setInterval) so the interval is recomputed each tick.
    if (process.argv.includes("--loop")) {
      const tick = () => {
        const nextMs = (isUSActiveWindow() ? 4 : 15) * 60 * 1000;
        console.log(`\n[loop] next pass in ${nextMs / 60000} min …`);
        setTimeout(() => runOnce().catch((e) => console.error("pass failed:", e)).finally(tick), nextMs);
      };
      tick();
    }
  })();
}
