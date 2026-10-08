// ── Email-tracker WATCHDOG (dead-man switch) ──────────────────────────────────────────────────
// Every breakage of the dealer email/SMS pipeline so far was found by a dealer or a CSM, days late:
// passes killed at Vercel's 300s (no summary, no end-of-pass alert), weekly/monthly digests stuck in
// "scheduled", rows orphaned mid-send, SMS dead for a week on a Twilio 401, and nobody paged because
// every alert lived at the END of the pass that was being killed. This job is independent of those
// passes: it reads the ledgers they leave behind and says what is missing.
//
// Runs as its own Vercel cron (GET /api/cron/roi-watchdog, `17,47 * * * *`). The minutes are chosen
// to never overlap a digest pass (daily :00-:05, weekly :20-:25, monthly :40-:45), so a row a pass
// is touching at that second is not mistaken for a stuck one.
//
// Detects (each a pure function below, tested offline in __tests__/watchdog.test.mjs):
//   (a) a live, sending department (is_live, dry_run=false, daily_enabled, not churned, ≥1 eligible
//       recipient) with NO daily roi_digest_runs row for its report date by 10:00 dealer-local
//   (b) a weekly/monthly row still scheduled/queued after its send day
//   (c) rows stuck mid-send: digest `sending` > 2h or `queued` > 1h; event email/SMS `queued` > 1h
//   (d) a cron source that has written roi_cron_runs before, silent for > 2× its schedule
//   (e) a transactional email type at 0 sent today while it averaged > 10/day over the last 7 days
//   (f) SMS failing on Twilio auth (401 / 20003) in the last 2h
//
// ONE consolidated postSystemicAlert per run, listing only problems not already alerted in the last
// 6h. State lives in roi_cron_runs rows written with source "roi-watchdog" (summary.alerted holds the
// problem keys alerted that run). Read-only apart from that one row per run. Every read pages
// (PostgREST caps a response at 1000 rows) with an explicit order so pages never skip or repeat.
"use strict";

const crypto = require("node:crypto");
const { isSubscribed, isChurned } = require("./subscriptions.cjs");
const { canEmail, isMissingColumnError, DELIVERABILITY_COLS } = require("./emailHealth.cjs");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WATCHDOG_SOURCE = "roi-watchdog";
const DEDUPE_MS = 6 * HOUR;
const DEFAULT_TZ = "America/New_York";
const PAGE = 1000;

const T = {
  dailyDeadlineHour: Number(process.env.WATCHDOG_DAILY_DEADLINE_HOUR || 10),
  sendingStuckMs: 2 * HOUR,
  queuedStuckMs: 1 * HOUR,
  stuckLookbackMs: 48 * HOUR,       // older orphans age out of the alert instead of paging forever
  overdueLookbackDays: 7,           // (b) a send day missed more than a week ago is history, not news
  sourceGraceMs: 2 * MIN,           // cron start jitter
  volumeMinDailyAvg: 10,            // (e) only types that normally send > 10/day
  volumeMinExpectedSoFar: 3,        // (e) …and would normally have sent ≥ 3 by this time of day
  smsAuthWindowMs: 2 * HOUR,
};
const VOLUME_TYPES = ["post_appointment", "action_item", "action_item_overdue", "post_conversation"];
const SMS_AUTH_RE = /\b401\b|20003|authenticat/i;

// ── Expected cron sources (LOCKSTEP with vercel.json — watchdog.test.mjs enforces it) ─────────
// Events run as EVENT_SHARDS shards: every 4 min in 00-02 + 12-23 UTC, every 15 min in 03-11 UTC.
const EVENT_SHARDS = 4;
const eventsIntervalMin = (utcHour) => (utcHour >= 3 && utcHour <= 11 ? 15 : 4);
// A source's allowed silence: 2× the slowest interval in effect over the last 30 minutes (so the
// 15-min → 4-min switch at 12:00 UTC does not page on the last 15-min gap), plus start jitter.
const eventsMaxGapMs = (now) => 2 * Math.max(eventsIntervalMin(new Date(now).getUTCHours()), eventsIntervalMin(new Date(now - 30 * MIN).getUTCHours())) * MIN;
const fixed = (min) => () => 2 * min * MIN;
// Shard sources are listed 0-based (as in the cron path) AND 1-based: only names that have ever
// written a row are checked, so whichever numbering the events pass uses is the one watched.
const EXPECTED_SOURCES = [
  { source: "roi-email-daily", label: "daily digest pass", maxGapMs: fixed(60) },
  { source: "roi-digest-weekly", label: "weekly digest pass", maxGapMs: fixed(60) },
  { source: "roi-digest-monthly", label: "monthly digest pass", maxGapMs: fixed(60) },
  ...Array.from({ length: EVENT_SHARDS + 1 }, (_, i) => ({ source: `roi-events-shard-${i}-of-${EVENT_SHARDS}`, label: "transactional events shard", maxGapMs: eventsMaxGapMs })),
  { source: "sync-live", label: "rooftop discovery (go-lives)", maxGapMs: fixed(24 * 60) },
  { source: "sync-lifecycle", label: "rooftop lifecycle sync", maxGapMs: fixed(24 * 60) },
];

// ── time helpers (dealer-local, DST-safe) ──────────────────────────────────────────────────────
function safeTz(tz) {
  if (!tz) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}
function localParts(tz, now) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(now));
  const g = (t) => +p.find((x) => x.type === t).value;
  const H = g("hour") === 24 ? 0 : g("hour");
  return { Y: g("year"), M: g("month"), D: g("day"), H, Min: g("minute"), ymd: ymd(g("year"), g("month"), g("day")) };
}
const ymd = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); return ymd(y, m, d + n); };
// The UTC instant of a dealer-local wall-clock time (two passes settle DST transitions).
function localToUtcMs(dateStr, hour, minute, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, hour, minute);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const lp = localParts(tz, guess);
    guess += want - Date.UTC(lp.Y, lp.M - 1, lp.D, lp.H, lp.Min);
  }
  return guess;
}
const ms = (t) => (t == null ? NaN : new Date(t).getTime());
const hhmm = (lp) => `${String(lp.H).padStart(2, "0")}:${String(lp.Min).padStart(2, "0")}`;
const ago = (msDiff) => (msDiff >= 2 * HOUR ? `${Math.round(msDiff / HOUR)}h` : `${Math.round(msDiff / MIN)}m`);

const nameOf = (cfg, teamId) => (cfg && (cfg.rooftop_name || cfg.team_name)) || teamId;
const byTeam = (rows) => new Map((rows || []).map((r) => [r.team_id, r]));

// The day a digest row's send was due, dealer-local: daily + weekly report "yesterday" (sent the day
// after local_date); monthly reports the previous month (local_date = its 1st), sent on
// monthly_send_day of the following month.
function sendDateOf(row, cfg) {
  if (row.cadence === "monthly") {
    const [y, m] = row.local_date.split("-").map(Number);
    const daysInNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = Math.min(Math.max(1, Number(cfg?.monthly_send_day) || 1), daysInNext);
    return ymd(y, m + 1, day);
  }
  return addDays(row.local_date, 1);
}

// Digest recipients the send path would actually mail for a daily digest (runner.cjs subscribedEmails).
function eligibleDailyRecipients(recips, dept) {
  return (recips || []).filter((r) => r.verified_at && canEmail(r) && (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled && isSubscribed(r, "daily", "email"));
}

// ── (a) live sending department with no daily row by 10:00 dealer-local ────────────────────────
function detectMissingDaily({ live, cfgs, recipients, dailyRows, now, deadlineHour = T.dailyDeadlineHour }) {
  const cfgOf = byTeam(cfgs);
  const recOf = new Map();
  for (const r of recipients || []) { const a = recOf.get(r.team_id) || []; a.push(r); recOf.set(r.team_id, a); }
  const have = new Set();
  const rowTz = new Map();
  for (const r of dailyRows || []) {
    if (r.cadence && r.cadence !== "daily") continue;
    have.add(`${r.team_id}|${r.department}|${r.local_date}`);
    if (r.dealer_timezone && !rowTz.has(r.team_id)) rowTz.set(r.team_id, r.dealer_timezone);
  }
  const out = [];
  for (const L of live || []) {
    if (L.is_live !== true || L.dry_run !== false) continue;
    const cfg = cfgOf.get(L.team_id);
    if (cfg && cfg.daily_enabled === false) continue;
    const tz = safeTz(cfg?.timezone || rowTz.get(L.team_id));
    const lp = localParts(tz, now);
    if (lp.H < deadlineHour) continue;
    const reportDate = addDays(lp.ymd, -1);
    if (isChurned(cfg, reportDate)) continue;
    if (!eligibleDailyRecipients(recOf.get(L.team_id), L.department).length) continue;
    if (have.has(`${L.team_id}|${L.department}|${reportDate}`)) continue;
    out.push({ check: "a", key: `a:${L.team_id}|${L.department}|${reportDate}`, team_id: L.team_id,
      detail: `${nameOf(cfg, L.team_id)} [${L.department}] has no daily digest row for ${reportDate} (${hhmm(lp)} ${tz})` });
  }
  return out;
}

// ── (b) weekly/monthly still scheduled/queued after its send day ───────────────────────────────
function detectOverdueCadence({ rows, cfgs, now }) {
  const cfgOf = byTeam(cfgs);
  const out = [];
  for (const r of rows || []) {
    if (r.cadence !== "weekly" && r.cadence !== "monthly") continue;
    if (r.status !== "scheduled" && r.status !== "queued") continue;
    const cfg = cfgOf.get(r.team_id);
    const tz = safeTz(r.dealer_timezone || cfg?.timezone);
    const today = localParts(tz, now).ymd;
    const sendDate = sendDateOf(r, cfg);
    if (today <= sendDate || today > addDays(sendDate, T.overdueLookbackDays)) continue;
    out.push({ check: "b", key: `b:${r.team_id}|${r.department}|${r.cadence}|${r.local_date}`, team_id: r.team_id,
      detail: `${nameOf(cfg, r.team_id)} [${r.department}] ${r.cadence} for ${r.local_date} still "${r.status}" (send day was ${sendDate})` });
  }
  return out;
}

// ── (c) rows stuck mid-send ───────────────────────────────────────────────────────────────────
// roi_digest_runs has no updated_at, and created_at is the FIRST write (often a "scheduled" row at
// local midnight). A row cannot enter queued/sending before its send time, so the clock starts at
// the later of created_at and the dealer-local send time.
function detectStuck({ digestRows, eventRows, smsRows, cfgs, now }) {
  const cfgOf = byTeam(cfgs);
  const out = [];
  for (const r of digestRows || []) {
    const limit = r.status === "sending" ? T.sendingStuckMs : r.status === "queued" ? T.queuedStuckMs : null;
    if (limit == null) continue;
    const cfg = cfgOf.get(r.team_id);
    const tz = safeTz(r.dealer_timezone || cfg?.timezone);
    const sendAt = localToUtcMs(sendDateOf(r, cfg), Number(cfg?.digest_send_hour ?? 7), Number(cfg?.digest_send_minute ?? 0), tz);
    const since = Math.max(ms(r.created_at) || 0, sendAt);
    if (now - since <= limit || now - since > T.stuckLookbackMs) continue;
    out.push({ check: "c", key: `c:digest|${r.team_id}|${r.department}|${r.cadence}|${r.local_date}|${r.status}`, team_id: r.team_id,
      detail: `${nameOf(cfg, r.team_id)} [${r.department}] ${r.cadence} digest for ${r.local_date} stuck "${r.status}" for ~${ago(now - since)}` });
  }
  for (const [table, rows] of [["roi_event_emails", eventRows], ["roi_event_sms", smsRows]]) {
    const stuck = (rows || []).filter((r) => (r.status === "queued" || r.status === "sending") && now - ms(r.created_at) > (r.status === "sending" ? T.sendingStuckMs : T.queuedStuckMs) && now - ms(r.created_at) <= T.stuckLookbackMs);
    if (!stuck.length) continue;
    const oldest = stuck.reduce((a, r) => (ms(r.created_at) < ms(a.created_at) ? r : a));
    const teams = [...new Set(stuck.map((r) => nameOf(cfgOf.get(r.team_id), r.team_id)))];
    const types = [...new Set(stuck.map((r) => r.email_type))];
    out.push({ check: "c", key: `c:${table}|queued`, count: stuck.length,
      detail: `${stuck.length} ${table} row(s) claimed but never finished (oldest ${ago(now - ms(oldest.created_at))} ago; ${types.join(", ")}; ${teams.slice(0, 5).join(", ")}${teams.length > 5 ? ` +${teams.length - 5} more` : ""}). Those events are not retried.` });
  }
  return out;
}

// ── (d) a cron source gone silent ─────────────────────────────────────────────────────────────
// latest: Map source → latest created_at (or null/absent = never written: not deployed yet, skip).
function detectStaleSources({ latest, now, expected = EXPECTED_SOURCES }) {
  const out = [];
  for (const s of expected) {
    const at = latest instanceof Map ? latest.get(s.source) : latest?.[s.source];
    if (!at) continue;
    const gap = now - ms(at);
    const allowed = s.maxGapMs(now) + T.sourceGraceMs;
    if (gap <= allowed) continue;
    out.push({ check: "d", key: `d:${s.source}`,
      detail: `${s.source} (${s.label}) has not reported for ${ago(gap)} (allowed ${ago(allowed)}; last ${new Date(at).toISOString()}). The pass is not running or is being killed before it finishes.` });
  }
  return out;
}

// ── (e) an email type that went silent ────────────────────────────────────────────────────────
// sentRows: { email_type, created_at } for status='sent' over the last 7 full UTC days + today.
// "Today" is the UTC day so far. To stay quiet in the US night (UTC morning) it also needs the same
// part of the day to have averaged ≥ volumeMinExpectedSoFar sends over the previous 7 days.
function detectVolumeDrop({ sentRows, now, types = VOLUME_TYPES }) {
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const elapsed = now - dayStart;
  const out = [];
  for (const type of types) {
    let today = 0, prior = 0, priorSoFar = 0;
    for (const r of sentRows || []) {
      if (r.email_type !== type) continue;
      const t = ms(r.created_at);
      if (t >= dayStart && t <= now) { today++; continue; }
      if (t < dayStart - 7 * DAY || t >= dayStart) continue;
      prior++;
      if ((t - dayStart + 7 * DAY) % DAY <= elapsed) priorSoFar++;
    }
    const avg = prior / 7, avgSoFar = priorSoFar / 7;
    if (today === 0 && avg > T.volumeMinDailyAvg && avgSoFar >= T.volumeMinExpectedSoFar) {
      out.push({ check: "e", key: `e:${type}:${new Date(dayStart).toISOString().slice(0, 10)}`,
        detail: `${type}: 0 sent today (UTC) by ${new Date(now).toISOString().slice(11, 16)}; the last 7 days averaged ${avg.toFixed(1)}/day and ${avgSoFar.toFixed(1)} by this time` });
    }
  }
  return out;
}

// ── (f) SMS failing on Twilio auth ─────────────────────────────────────────────────────────────
function detectSmsAuth({ smsErrorRows, cfgs, now }) {
  const cfgOf = byTeam(cfgs);
  const hits = (smsErrorRows || []).filter((r) => r.status === "error" && now - ms(r.created_at) <= T.smsAuthWindowMs
    && SMS_AUTH_RE.test(`${r.reason || ""} ${typeof r.recipients === "string" ? r.recipients : JSON.stringify(r.recipients || "")}`));
  if (!hits.length) return [];
  const teams = [...new Set(hits.map((r) => nameOf(cfgOf.get(r.team_id), r.team_id)))];
  return [{ check: "f", key: "f:sms-auth", count: hits.length,
    detail: `${hits.length} SMS failed on Twilio authentication (401 / 20003) in the last 2h (${teams.slice(0, 5).join(", ")}${teams.length > 5 ? ` +${teams.length - 5} more` : ""}). Every SMS is failing: rotate TWILIO_AUTH_TOKEN / check the Twilio account. Failed events are not retried.` }];
}

// ── dedupe + message ──────────────────────────────────────────────────────────────────────────
function alertedRecently(priorRuns, now, windowMs = DEDUPE_MS) {
  const keys = new Set();
  for (const r of priorRuns || []) {
    if (now - ms(r.created_at) > windowMs) continue;
    for (const k of (r.summary && r.summary.alerted) || []) keys.add(k);
  }
  return keys;
}
function planAlert(problems, priorRuns, now) {
  const done = alertedRecently(priorRuns, now);
  return { fresh: problems.filter((p) => !done.has(p.key)), ongoing: problems.filter((p) => done.has(p.key)) };
}
const fingerprint = (problems) => crypto.createHash("sha1").update(problems.map((p) => p.key).sort().join("\n")).digest("hex").slice(0, 16);

const CHECK_LABEL = {
  a: "Daily digest missing by 10:00 dealer-local",
  b: "Weekly/monthly digest still pending after its send day",
  c: "Rows stuck mid-send",
  d: "Cron pass not reporting",
  e: "Email type went silent",
  f: "SMS failing on Twilio auth",
  w: "Watchdog could not read",
};
function formatAlert(fresh, ongoing, maxPerGroup = 8) {
  const groups = new Map();
  for (const p of fresh) { const g = groups.get(p.check) || []; g.push(p); groups.set(p.check, g); }
  const parts = [];
  for (const check of Object.keys(CHECK_LABEL)) {
    const g = groups.get(check);
    if (!g) continue;
    const lines = g.slice(0, maxPerGroup).map((p) => `  • ${p.detail}`);
    if (g.length > maxPerGroup) lines.push(`  …and ${g.length - maxPerGroup} more`);
    parts.push(`*${CHECK_LABEL[check]}* (${g.length})\n${lines.join("\n")}`);
  }
  const tail = ongoing.length ? `\n_Still open, already alerted in the last 6h: ${ongoing.length}._` : "";
  return {
    title: `${fresh.length} new email-tracker problem${fresh.length === 1 ? "" : "s"}`,
    detail: `watchdog found ${fresh.length + ongoing.length} problem(s).\n${parts.join("\n")}${tail}`,
  };
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────
// Page through a select. `order` must be a unique-ish key so pages neither skip nor repeat rows.
async function pagedSelect(sb, table, cols, build, order) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(cols);
    if (build) q = build(q);
    for (const o of order) q = q.order(o, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}
async function latestBySource(sb, sources) {
  const out = new Map();
  await Promise.all(sources.map(async (source) => {
    const { data, error } = await sb.from("roi_cron_runs").select("created_at").eq("source", source).order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error(`roi_cron_runs: ${error.message}`);
    if (data && data[0]) out.set(source, data[0].created_at);
  }));
  return out;
}

function defaultSb() {
  const url = process.env.ROI_SUPABASE_URL, key = process.env.ROI_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const { createClient } = require("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * One watchdog pass. Never throws.
 * @param {object} [o]
 * @param {object} [o.sb]     Supabase client (default: ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY)
 * @param {Function} [o.post] alert poster (default: slackAlert.postSystemicAlert)
 * @param {number} [o.now]    epoch ms (tests)
 * @param {boolean} [o.write] write the roi-watchdog row (default true; false = pure dry run)
 */
async function runWatchdog(o = {}) {
  const started = Date.now();
  const now = o.now ?? started;
  const sb = o.sb || defaultSb();
  if (!sb) return { ok: false, error: "ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY not set", problems: [] };
  const post = o.post || require("./slackAlert.cjs").postSystemicAlert;
  const write = o.write !== false;
  const utcToday = new Date(now).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${utcToday}T00:00:00Z`);
  const iso = (t) => new Date(t).toISOString();

  const problems = [];
  const read = async (name, fn) => {
    try { return await fn(); } catch (e) {
      problems.push({ check: "w", key: `w:${name}`, detail: `${name}: ${String(e?.message ?? e).slice(0, 200)}` });
      return null;
    }
  };
  const recipientCols = "id,team_id,email,receives_sales,receives_service,email_enabled,subscriptions,verified_at";
  const [live, cfgs, recipients, dailyRows, pendingRows, eventRows, smsRows, sentRows, smsErrorRows, latest, priorRuns] = await Promise.all([
    read("roi_live_departments", () => pagedSelect(sb, "roi_live_departments", "team_id,department,is_live,dry_run", (q) => q.eq("is_live", true), ["team_id", "department"])),
    read("roi_rooftop_config", () => pagedSelect(sb, "roi_rooftop_config", "team_id,rooftop_name,team_name,timezone,digest_send_hour,digest_send_minute,daily_enabled,monthly_send_day,lifecycle_status,churn_date", null, ["team_id"])),
    read("roi_recipients", async () => {
      try { return await pagedSelect(sb, "roi_recipients", `${recipientCols},${DELIVERABILITY_COLS}`, null, ["id"]); } catch (e) {
        if (!isMissingColumnError({ message: e.message })) throw e;
        return pagedSelect(sb, "roi_recipients", recipientCols, null, ["id"]); // pre-0023 database: structural gate only
      }
    }),
    read("roi_digest_runs (daily)", () => pagedSelect(sb, "roi_digest_runs", "id,team_id,department,cadence,local_date,status,created_at,dealer_timezone", (q) => q.eq("cadence", "daily").gte("local_date", addDays(utcToday, -2)), ["id"])),
    read("roi_digest_runs (pending)", () => pagedSelect(sb, "roi_digest_runs", "id,team_id,department,cadence,local_date,status,created_at,dealer_timezone", (q) => q.in("status", ["scheduled", "queued", "sending"]).gte("local_date", addDays(utcToday, -45)), ["id"])),
    read("roi_event_emails (queued)", () => pagedSelect(sb, "roi_event_emails", "id,team_id,email_type,status,created_at", (q) => q.in("status", ["queued", "sending"]).gte("created_at", iso(now - T.stuckLookbackMs)).lt("created_at", iso(now - T.queuedStuckMs)), ["id"])),
    read("roi_event_sms (queued)", () => pagedSelect(sb, "roi_event_sms", "id,team_id,email_type,status,created_at", (q) => q.in("status", ["queued", "sending"]).gte("created_at", iso(now - T.stuckLookbackMs)).lt("created_at", iso(now - T.queuedStuckMs)), ["id"])),
    read("roi_event_emails (sent)", () => pagedSelect(sb, "roi_event_emails", "id,email_type,created_at", (q) => q.eq("status", "sent").in("email_type", VOLUME_TYPES).gte("created_at", iso(dayStart - 7 * DAY)), ["id"])),
    read("roi_event_sms (errors)", () => pagedSelect(sb, "roi_event_sms", "id,team_id,email_type,status,reason,recipients,created_at", (q) => q.eq("status", "error").gte("created_at", iso(now - T.smsAuthWindowMs)), ["id"])),
    read("roi_cron_runs (latest)", () => latestBySource(sb, EXPECTED_SOURCES.map((s) => s.source))),
    read("roi_cron_runs (watchdog state)", () => pagedSelect(sb, "roi_cron_runs", "id,summary,created_at", (q) => q.eq("source", WATCHDOG_SOURCE).gte("created_at", iso(now - DEDUPE_MS)), ["created_at", "id"])),
  ]);

  if (live && cfgs && recipients && dailyRows) problems.push(...detectMissingDaily({ live, cfgs, recipients, dailyRows, now }));
  if (pendingRows) problems.push(...detectOverdueCadence({ rows: pendingRows, cfgs: cfgs || [], now }));
  problems.push(...detectStuck({ digestRows: pendingRows || [], eventRows: eventRows || [], smsRows: smsRows || [], cfgs: cfgs || [], now }));
  if (latest) problems.push(...detectStaleSources({ latest, now }));
  if (sentRows) problems.push(...detectVolumeDrop({ sentRows, now }));
  if (smsErrorRows) problems.push(...detectSmsAuth({ smsErrorRows, cfgs: cfgs || [], now }));

  const { fresh, ongoing } = planAlert(problems, priorRuns || [], now);
  let alerted = [], alertError = null, delivered = false;
  if (fresh.length) {
    const msg = formatAlert(fresh, ongoing);
    try {
      await post({ source: "Email tracker watchdog", title: msg.title, detail: msg.detail, windowLabel: "30-min email-tracker watchdog" });
      // Without a Slack token the poster only logs. Keep those problems un-alerted so they post the
      // first run after SLACK_BOT_TOKEN is set, instead of being muted for 6h.
      delivered = Boolean(process.env.SLACK_BOT_TOKEN) || Boolean(o.post);
      if (delivered) alerted = fresh.map((p) => p.key);
    } catch (e) { alertError = String(e?.message ?? e).slice(0, 300); }
  }

  const summary = {
    checkedAt: iso(now), elapsedMs: Date.now() - started,
    problemCount: problems.length, fresh: fresh.length, ongoing: ongoing.length,
    problems: problems.slice(0, 200).map((p) => ({ key: p.key, check: p.check, detail: p.detail })),
    alerted, alertError, fingerprint: fingerprint(problems),
  };
  if (write) {
    try {
      const { error } = await sb.from("roi_cron_runs").insert({ source: WATCHDOG_SOURCE, ok: problems.length === 0, summary });
      if (error) summary.writeError = error.message;
    } catch (e) { summary.writeError = String(e?.message ?? e); }
  }
  return { ok: problems.length === 0, ...summary };
}

module.exports = {
  runWatchdog,
  detectMissingDaily, detectOverdueCadence, detectStuck, detectStaleSources, detectVolumeDrop, detectSmsAuth,
  planAlert, formatAlert, fingerprint, pagedSelect,
  EXPECTED_SOURCES, EVENT_SHARDS, eventsIntervalMin, VOLUME_TYPES, WATCHDOG_SOURCE, DEDUPE_MS,
  _internal: { localParts, localToUtcMs, sendDateOf, addDays, safeTz, T },
};
