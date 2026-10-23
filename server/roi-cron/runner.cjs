#!/usr/bin/env node
/* ROI Email — complete local cron (one process, runs the whole flow).
 *
 * Flow (per the spec):
 *   Step 0&1  finalized set = roi_live_departments.is_live + roi_recipients (who receives)
 *   Step 2    fetch metrics from the Reporting API (reporting-vini, Supabase-backed) per team+dept
 *             → store in roi_digest_runs with status 'queued' (data fetched, not sent yet)
 *   Step 3    validate guardrails on the data
 *   Step 4    SEND via the mail curl IFF: team live ✔ · recipients added ✔ · guardrails pass ✔ ·
 *             send-hour reached ✔ · not already sent today ✔
 *   Loop      every hour
 *
 * SAFETY: DRY_RUN defaults to TRUE — it renders + records 'suppressed/dry_run' and sends NOTHING.
 *         Set DRY_RUN=false to actually email. A rooftop with roi_live_departments.dry_run=true is
 *         always held even when DRY_RUN=false.
 *
 *   node runner.cjs                    # one pass
 *   node runner.cjs --loop             # run now, then every hour
 *   node runner.cjs --cadence weekly   # one weekly (or monthly) pass
 *   Operator knobs (ONLY_TEAMS, IGNORE_SEND_HOUR, IGNORE_SEND_DAY, RUN_LOCAL_DATE, FORCE_RESEND) are
 *   honoured ONLY from this CLI; the scheduled cron ignores them.
 */
const { createClient } = require("@supabase/supabase-js");
// Single source of truth for the digest HTML — the SAME module the SPA preview
// (src/email/renderDigest.ts) imports, so the cron-sent bytes never drift from
// what the tracker shows.
const { renderDigestHtml } = require("../../src/email/digestTemplate.cjs");
// Anti-churn value gate — never email a no-value digest unless overridden (DANGER).
const emailValue = require("./emailValue.cjs");
// Terse digest SMS renderer (companion to the rich email) + the Twilio sender.
const T = require("../../src/email/transactionalTemplates.cjs");
const { sendSms, SMS_DRY_RUN } = require("./sendSms.cjs");
// Per-recipient subscription matrix (who gets which type on which channel).
const { isSubscribed, isChurned } = require("./subscriptions.cjs");
// Self-healing rooftop-timezone resolver (live Spyne API, persisted back) — already used by
// eventRunner.cjs; the digest cron used to hardcode America/New_York for any rooftop with a
// blank roi_rooftop_config.timezone.
const { resolveTz, primeTeamDetails, fetchTeamDetailsCH } = require("./resolveTz.cjs");

// Deliverability gate — malformed / typo'd / already-bounced addresses are never mailed, because
// their bounces are charged to the sending domain and cost every OTHER rooftop its inbox placement.
// canEmail() subsumes the old isRealEmail() (it still excludes the …@phone.invalid placeholder, so
// a phone-only recipient gets SMS only). See emailHealth.cjs.
const emailHealth = require("./emailHealth.cjs");
const { canEmail, selectRecipients } = emailHealth;

// Digest recipients for a channel, filtered by dept + per-channel master + the subscription matrix.
// Digests are rooftop summaries → NO role tiering (everyone subscribed gets them).
// GATE (r.verified_at): a rooftop only emails recipients a human verified for it — the guarantee
// against cross-rooftop leaks. Unverified rows are held; the daily audit alert surfaces them.
function subscribedEmails(recips, dept, type) {
  return (recips ?? [])
    .filter((r) => r.verified_at && canEmail(r) && (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled && isSubscribed(r, type, "email"))
    .map((r) => r.email);
}
function subscribedSmsRecips(recips, dept, type, rooftopSmsEnabled) {
  if (!rooftopSmsEnabled) return [];
  return (recips ?? [])
    .filter((r) => r.verified_at && (dept === "sales" ? r.receives_sales : r.receives_service) && r.sms_enabled && r.phone && isSubscribed(r, type, "sms"))
    .map((r) => ({ phone: r.phone, role: r.role }));
}
// Send a digest SMS with its own dedupe (roi_event_sms, one per team+dept+cadence+day). Never
// throws to the caller — a digest SMS failure must not break the email path.
async function sendDigestSms(sbc, base, cadence, localDate, smsRecips, body) {
  const eventKey = `${cadence}:${base.department}:${localDate}`;
  try {
    const { data, error } = await sbc.from("roi_event_sms").insert({ ...base, email_type: cadence, event_key: eventKey, status: "queued" }).select("id");
    if (error) { if ((error.code || "") === "23505") return { dupe: true }; throw error; }
    const id = data && data[0] ? data[0].id : null;
    const results = [];
    for (const r of smsRecips) {
      try { const msid = await sendSms(r.phone, body, { dryRun: false }); results.push({ phone: r.phone, role: r.role, sid: msid, sent: true }); }
      catch (e) { results.push({ phone: r.phone, role: r.role, error: String(e.message || e).slice(0, 200) }); }
    }
    const anySent = results.some((x) => x.sent);
    const firstSid = (results.find((x) => x.sid) || {}).sid || null;
    await sbc.from("roi_event_sms").update({ status: anySent ? "sent" : "error", reason: anySent ? null : "all_recipients_failed", body, message_sid: firstSid, sent_at: anySent ? new Date().toISOString() : null, recipients: results }).eq("id", id);
    return { sent: anySent, error: anySent ? null : ((results.find((x) => x.error) || {}).error || "all recipients failed") };
  } catch (e) { const msg = String(e && e.message ? e.message : e).slice(0, 200); console.warn("[roi-cron] digest sms skipped:", msg); return { error: msg }; }
}

const SB_URL = process.env.ROI_SUPABASE_URL;
const SB_KEY = process.env.ROI_SUPABASE_SERVICE_KEY;
const MAIL_URL = process.env.MAIL_PROXY_URL || process.env.EMAIL_PROXY_URL || "https://mail.spyne.ai/api/v1/send-template-email";
const MAIL_TEMPLATE = process.env.MAIL_TEMPLATE || "email-control-tower-report";
const MAIL_TOKEN = process.env.MAIL_TOKEN || "";
// "false" and "0" both disable — .env.example documents DRY_RUN=0 to go live.
const DRY_RUN = !["false", "0"].includes(String(process.env.DRY_RUN ?? "").trim().toLowerCase());  // default ON
// Domain reputation: stagger mail sends between rooftops to avoid ISP filtering on burst delivery.
// Default 3s between rooftop sends (~3.5 min for 67 rooftops, completes well within the hourly cron).
// Set MAIL_SEND_DELAY_MS=0 to disable or tune for faster/slower sends.
const MAIL_SEND_DELAY_MS = Number(process.env.MAIL_SEND_DELAY_MS ?? 3000);
// Metrics source: the Reporting API (Supabase-backed) at reporting-vini. Metabase has been removed.
const REPORTING_API_BASE = process.env.REPORTING_API_BASE || "https://reporting-vini.vercel.app";
// The reporting-vini read API requires a credential (it returns PII). Forward the trusted service
// secret (preferred) or the Spyne token so server-to-server calls authorize; else they 401.
// canonical: reporting-vini authorizes on ITS service secret — prefer a dedicated REPORTING_CRON_SECRET
// (= reporting-vini's secret), NOT necessarily this app's CRON_SECRET. Falls back to the old chain.
const REPORTING_AUTH = process.env.REPORTING_CRON_SECRET || process.env.CRON_SECRET || process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || "";
// A reporting-api call that hangs must fail like a 504 instead of holding a pool worker forever.
// reporting-vini's /api/reports is capped at 30s server-side, so 60s only ever catches a hang.
const REPORTING_TIMEOUT_MS = Number(process.env.REPORTING_TIMEOUT_MS || 60000);

// ── Pass budget (2026-10-08) ──────────────────────────────────────────────────────────────────
// Vercel kills a function at 300s. A killed pass is silent and lossy: no summary, no Slack alert, no
// end-of-pass audits, a row caught between its send-claim and its "sent" write stays locked forever,
// and since every pass walked the same rows in the same order, the departments at the tail were
// never reached at all (130 daily-enabled ones on 2026-10-07, 38 of them live senders). So each pass
// stops LAUNCHING rooftops at this budget, leaves room for the ones in flight to finish, reports
// what it didn't reach, and the next hourly pass starts with the work that is still due.
const DIGEST_PASS_BUDGET_MS = Number(process.env.DIGEST_PASS_BUDGET_MS || 180000);

// ── Weekly / monthly catch-up bounds (2026-10-09) ─────────────────────────────────────────────
// A weekly/monthly digest used to go out ONLY on its exact send day: one bad day (a 504, a killed
// pass) lost the whole period. Now a period stays due from its send day until a 'sent' row exists,
// for at most this many days. Weekly can never be more than 6 days late (the next period starts),
// monthly gives up after 10 and records not_sent/missed_send_day so the tracker shows the gap.
const WEEKLY_MAX_LATE_DAYS = 6;
const MONTHLY_MAX_LATE_DAYS = 10;
// Internal test rooftops that discovery must never configure (in addition to any name matching /test/i
// and eventila's is_test_account flag).
const TEST_TEAM_IDS = new Set(["3769f9d53b"]);

// Period-over-period % the way the Overview computes it (liveData.ts pctDelta): null, never 0, when the
// prior window is empty, so the chip renders nothing instead of a fabricated "+100%".
function pctDelta(curr, prev) {
  const p = Number(prev) || 0;
  return p ? Math.round(((Number(curr) || 0) - p) / p * 100) : null;
}
// Calendar arithmetic on a YYYY-MM-DD string (UTC-anchored, so no zone can shift the date).
function addDaysISO(iso, n) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// A malformed IANA zone ("America/New York") makes Intl throw a RangeError. Checked per row so one bad
// config value fails that row, not the whole pass.
function isValidTz(tz) {
  if (!tz || typeof tz !== "string") return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()); return true; } catch { return false; }
}
function assertValidTz(tz) {
  if (isValidTz(tz)) return;
  const e = new Error(`invalid timezone "${tz}" in roi_rooftop_config; fix it in the tracker (an IANA name like America/Chicago)`);
  e.code = "INVALID_TZ";
  throw e;
}
// The dealer-local report date ("yesterday") without ever throwing: an invalid zone falls back to ET.
// Used only to ORDER work and key error rows, never to compute a window that is sent.
function safeLocalDate(tz) {
  try { return localParts(isValidTz(tz) ? tz : "America/New_York").localDate; } catch { return localParts("America/New_York").localDate; }
}
// PostgREST caps a select at 1000 rows. roi_rooftop_config (647) and roi_live_departments (401) are under
// it today; a silent cap would drop rooftops from every send with no error, so every fleet read pages.
async function readAll(table, cols, opts = {}) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols);
    if (opts.filter) q = opts.filter(q);
    for (const c of opts.order || ["team_id"]) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) return { data: null, error };
    out.push(...(data || []));
    if (!data || data.length < 1000) return { data: out, error: null };
  }
}
// emailHealth.selectRecipients pages internally. Wrapping it in a second paging loop (a `.range()` in the
// filter) made every outer page return the whole table, which never terminates past 1,000 recipients.
async function selectRecipientsAll(cols) {
  return selectRecipients(sb, cols);
}
const LIVE_COLS = "team_id,department,dry_run";
const LIVE_FILTER = { filter: (q) => q.eq("is_live", true), order: ["team_id", "department"] };
const RECIP_COLS = "team_id,email,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at";
// Live rows + config + recipients for a pass, paged, with enterprise_id attached to every live row.
async function loadFleet(cfgCols) {
  const [liveRes, cfgRes, recRes] = await Promise.all([
    readAll("roi_live_departments", LIVE_COLS, LIVE_FILTER),
    readAll("roi_rooftop_config", cfgCols),
    selectRecipientsAll(RECIP_COLS),
  ]);
  if (liveRes.error || cfgRes.error || recRes.error) {
    const e = liveRes.error || cfgRes.error || recRes.error;
    throw new Error(`Supabase read failed (check ROI_SUPABASE_URL/ROI_SUPABASE_SERVICE_KEY): ${e.message}`);
  }
  const cfgOf = new Map((cfgRes.data ?? []).map((c) => [c.team_id, c]));
  // enterprise_id lives on roi_rooftop_config (not roi_live_departments): attach it to each live row so
  // the stored row, console links, reporting calls and enrichment all carry the rooftop's own enterprise.
  for (const L of (liveRes.data ?? [])) L.enterprise_id = cfgOf.get(L.team_id)?.enterprise_id || "";
  const recOf = new Map();
  for (const r of recRes.data ?? []) { const a = recOf.get(r.team_id) ?? []; a.push(r); recOf.set(r.team_id, a); }
  return { live: liveRes.data ?? [], cfgOf, recOf };
}
// Recipients who would get this cadence if they subscribed: verified, deliverable, on this department's
// list, email on. Lets a pass tell "nobody subscribed to the weekly" (unsubscribed) from "no recipients at
// all" (recipients_missing) — the tracker labels the two differently.
function eligibleButUnsubscribed(recips, dept) {
  return (recips ?? []).some((r) => r.verified_at && canEmail(r) && (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled);
}

// ── Per-appointment dollar value (whiteboard spec) ───────────────────────────
// Same per-category rates as the Programs dashboard (src/agents/AgentsDashboard.tsx):
//   Sales Inbound $200 · Sales Outbound $250 · Service Inbound $100 · Service Outbound $200.
// The digest is per-DEPARTMENT and the meetings API has no inbound/outbound split
// (see reporting-vini src/lib/spyne/meetings.ts), so the per-row "Est. value" uses the
// department average of its two directions: Sales = avg(200,250) = 225, Service =
// avg(100,200) = 150. Env vars still override for ad-hoc tuning.
const APPT_DOLLAR = { sales_inbound: 200, sales_outbound: 250, service_inbound: 100, service_outbound: 200 };
const DIGEST_DOLLAR_RATE_SALES = (APPT_DOLLAR.sales_inbound + APPT_DOLLAR.sales_outbound) / 2;     // 225
const DIGEST_DOLLAR_RATE_SERVICE = (APPT_DOLLAR.service_inbound + APPT_DOLLAR.service_outbound) / 2; // 150
function digestDollarRate(department) {
  return Number(department === "service"
    ? (process.env.DIGEST_DOLLAR_RATE_SERVICE || DIGEST_DOLLAR_RATE_SERVICE)
    : (process.env.DIGEST_DOLLAR_RATE_SALES || DIGEST_DOLLAR_RATE_SALES));
}

// --rerender only re-renders rendered_html from already-stored metrics → Supabase only, no Metabase.
const RERENDER_ONLY = process.argv.includes("--rerender");
// When run as a CLI we hard-fail on missing config; when imported (Vercel function, tests) we don't
// call process.exit — the caller surfaces the error instead.
const IS_CLI = require.main === module;
if (IS_CLI) {
  if (!SB_URL || !SB_KEY) { console.error("Set ROI_SUPABASE_URL + ROI_SUPABASE_SERVICE_KEY"); process.exit(1); }
}
const sb = createClient(SB_URL || "http://invalid.local", SB_KEY || "noop", { auth: { persistSession: false } });

// ── dealer-local "today"/"yesterday" + send hour + UTC windows (start/end/month) ──
const fmtUTC = (d) => d.toISOString().slice(0, 19).replace("T", " ");
// Human label for a CALENDAR DATE (the dealer's reported day) — built from the y/m/d components, not
// from an instant. Formatting the UTC instant of dealer-midnight only lands on the right date for
// dealers BEHIND UTC; a rooftop ahead of it (Pacific/Guam, UTC+10) had its midnight fall on the
// previous UTC date, so the digest headed "Monday, August 3" for a Guam dealer read "Sunday, August 2".
// Anchoring at UTC noon makes the label offset-proof.
const dateLabelFor = (y, m, d) =>
  new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
function localToUTC(y, m, day, tz) {
  const approx = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(approx);
  const g = (t) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const asUTC = new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"), g("second")));
  return new Date(approx.getTime() + (approx.getTime() - asUTC.getTime()));
}
function localParts(tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const g = (t) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const Y = g("year"), M = g("month"), D = g("day"), H = g("hour") === 24 ? 0 : g("hour"), Min = g("minute");
  const pad = (n) => String(n).padStart(2, "0");
  // "Yesterday" (the reported day) with calendar-safe month/year rollover. The old naive `D - 1`
  // produced a malformed `YYYY-MM-00` on the 1st of the month, corrupting the API window every month.
  const yd = new Date(Date.UTC(Y, M - 1, D - 1));
  const yY = yd.getUTCFullYear(), yM = yd.getUTCMonth() + 1, yD = yd.getUTCDate();
  const yStart = localToUTC(yY, yM, yD, tz);
  const yEnd = new Date(localToUTC(Y, M, D, tz).getTime() - 1000);
  const monthStart = localToUTC(yY, yM, 1, tz);   // first of the reported (yesterday's) month
  const localDate = `${yY}-${pad(yM)}-${pad(yD)}`;
  const dateLabel = dateLabelFor(yY, yM, yD);
  // apiEnd stays "today" (exclusive end) → the day window is yesterday..today = the reported day,
  // and MTD is the first of yesterday's month..today.
  return { localHour: H, localMinute: Min, localDate, dateLabel, yStart: fmtUTC(yStart), yEnd: fmtUTC(yEnd), monthStart: fmtUTC(monthStart),
    apiStart: localDate, apiEnd: `${Y}-${pad(M)}-${pad(D)}`, apiMonthStart: `${yY}-${pad(yM)}-01` };
}

// ── Reporting API source (reporting-vini, Supabase-backed) — the only metrics source ──
// One team/window fetch returns all 4 agents (Sales/Service × Inbound/Outbound). We combine
// each dept's Inbound+Outbound into the same `m` shape the Metabase path produces.
// dedupe + memoize (team|start|end) within ONE pass. Module scope outlives a pass on a warm instance,
// so every pass starts by clearing it (resetApiCache) and a failed call is evicted at once: kept, a
// 504 replayed instantly into every later hourly pass and the rooftop could never recover, and a kept
// success served the numbers read at midnight to the 7am send.
const _apiCache = new Map();
const resetApiCache = () => _apiCache.clear();
// Every reporting-vini call carries the rooftop's OWN enterprise_id. Without it the route fell back to the
// env token's enterprise, and the dealer-leads action-item stats came back all zero for every rooftop
// from 2026-10-01 (audit F1/F18). Older reporting-vini deploys ignore the param.
const entQS = (entId) => (entId ? `&enterprise_id=${encodeURIComponent(String(entId))}` : "");
// The digest never shows lead sources (m.leadsBySource is stored, not rendered), so /api/reports may skip
// that canonical upstream call. hotLeads is NOT omitted: for Sales, j.warmLeads ("Leads to call now") IS
// the canonical hot-lead list. Older reporting-vini deploys ignore the param.
const REPORTS_OMIT = "&omit=leadSources";
// Resolves { j, byName }: the whole /api/reports response (the digest's appointment list, rooftop rungs and
// prior basis are read from the SAME response the KPI numbers come from) plus the agents keyed by name.
async function apiReport(teamId, start, end, entId) {
  const k = `${teamId}|${start}|${end}|${entId || ""}`;
  if (_apiCache.has(k)) return _apiCache.get(k);
  const p = (async () => {
    const res = await fetch(`${REPORTING_API_BASE}/api/reports?team_id=${encodeURIComponent(teamId)}&start=${start}&end=${end}${entQS(entId)}${REPORTS_OMIT}`, { headers: REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {}, signal: AbortSignal.timeout(REPORTING_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`reporting-api ${res.status} (${teamId} ${start}..${end}): ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
    // The reporting API returns a zeroed report with `degraded:true` on a backend read failure, and
    // (stab/reporting-parity) degraded:true + degradedReason:"canonical-timeout" when the canonical
    // overview missed its deadline, i.e. partial Sales numbers. Either way: a hard error, so the digest
    // holds instead of emailing zeros or a half-built report — sending those is itself a churn risk.
    if (j && j.degraded) throw new Error(`reporting-api degraded${j.degradedReason ? ` (${j.degradedReason})` : ""} (${teamId} ${start}..${end}) — holding digest`);
    const byName = {};
    for (const a of j.agents || []) byName[a.name] = a;
    return { j, byName };
  })();
  _apiCache.set(k, p);
  p.catch(() => { if (_apiCache.get(k) === p) _apiCache.delete(k); });
  return p;
}
const apiPickDept = (rep, dept) => {
  const byName = (rep && rep.byName) || {};
  const D = dept === "service" ? "Service" : "Sales";
  return { ib: byName[`${D} Inbound`] || {}, ob: byName[`${D} Outbound`] || {} };
};

// ── Ports of the Overview's own roll-up rules (reporting-vini src/components/reports/liveData.ts) ──
// The digest must print the number the dealer finds on the Overview for the same window. These mirror
// rooftopRungsFor / unattributedApptsFor / assistedApptsFor / hasAgentActivity line for line; keep them
// in step with that file.
const AGENT_ID = { "Sales Inbound": "sales_ib", "Sales Outbound": "sales_ob", "Service Inbound": "service_ib", "Service Outbound": "service_ob" };
const agentIdOf = (a) => (a && (a.id || AGENT_ID[a.name])) || null;
function hasAgentActivity(a) {
  const m = (a && a.metrics) || {};
  const lf = a && a.leadFunnel;
  const leads = lf && lf.contacted != null ? lf.contacted : ((a && a.report && a.report.leadsAttempted) ?? 0);
  return N(m.calls) + N(m.conversations) + N(m.qualified) + N(m.appointments) + N(m.smsSent) + N(leads) > 0;
}
function normalizeRooftop(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const leadsAttempted = fin(raw.leadsAttempted), engaged = fin(raw.engaged), qualified = fin(raw.qualified);
  if (leadsAttempted === undefined || engaged === undefined || qualified === undefined) return undefined;
  if (typeof raw.dept !== "string" || !raw.dept) return undefined;
  if (!Array.isArray(raw.agentTypes) || !raw.agentTypes.every((t) => typeof t === "string")) return undefined;
  const triple = (v, keepNull) => {
    if (!v || typeof v !== "object") return undefined;
    const g = (k) => (keepNull && v[k] === null ? null : fin(v[k]));
    const a = g("leadsAttempted"), b = g("engaged"), c = g("qualified");
    return a === undefined || b === undefined || c === undefined ? undefined : { leadsAttempted: a, engaged: b, qualified: c };
  };
  return { dept: raw.dept, agentTypes: raw.agentTypes, leadsAttempted, engaged, qualified, prior: triple(raw.prior, false), deltaPct: triple(raw.deltaPct, true) };
}
// The rooftop's DISTINCT rungs, only when `agents` is exactly the agent set the canonical API counted.
// Fails closed (undefined → keep summing the agent rows), exactly like the Overview.
function rooftopRungsFor(j, dept, agents) {
  const r = normalizeRooftop(j && j.rooftop);
  if (!r) return undefined;
  if (dept !== r.dept) return undefined;
  const mapped = r.agentTypes.map((t) => AGENT_ID[t]);
  if (mapped.some((id) => !id)) return undefined;
  const covered = new Set(mapped);
  if (!covered.size) return undefined;
  const live = (agents || []).filter(hasAgentActivity);
  if (live.some((a) => !covered.has(agentIdOf(a)))) return undefined;
  const present = new Set(live.map(agentIdOf));
  for (const id of covered) if (!present.has(id)) return undefined;
  return r;
}
function unattributedApptsFor(j, dept) {
  if (!j) return 0;
  const by = j.appointmentsUnattributedBy;
  if (by && typeof by === "object") return N(dept === "service" ? by.service : by.sales);
  return 0; // an older payload carries only a rooftop scalar, which belongs to no department
}
function assistedApptsFor(j, dept) {
  const by = j && j.appointmentsAssistedBy;
  if (!by || typeof by !== "object") return undefined;
  return N(dept === "service" ? by.service : by.sales);
}

async function apiMetrics(teamId, dept, start, end, entId) {
  const rep = await apiReport(teamId, start, end, entId);
  const j = rep.j || {};
  const { ib, ob } = apiPickDept(rep, dept);
  const n = (v) => Number(v) || 0;
  const im = ib.metrics || {}, om = ob.metrics || {}, ir = ib.report || {}, or = ob.report || {};
  const sm = ir.summary || {};
  // SMS counts = MESSAGES (metrics.smsSent), matching the console / reporting-vini dashboard's
  // "Total SMS" — NOT channelSplit.sms (conversation threads), which undercounts (1 thread = many
  // messages). smsSent is scoped to real agent conversations, so automated blasts are excluded.
  // Verified: Dream Nissan Lawrence 6/25 console out 24 = om.smsSent 24; in 36 ≈ im.smsSent 37.
  // Calls = metrics.calls, the figure the Overview's agent cards and the connect rate use (canonical for
  // Sales). channelSplit.voice is the aggregate's pre-overlay count and, on an agent with activity rows
  // but no calls, still carries the cloned MOCK value (22 digests printed a fabricated "Call 90").
  const callIn = n(im.calls), smsIn = n(im.smsSent), callOut = n(om.calls), smsOut = n(om.smsSent);
  const obCalls = n(om.calls), obRate = n(om.connectRate), cf = ir.callFlow || {}, ocf = or.callFlow || {};
  const calls = n(im.calls), after = n(im.afterHours);
  // Leads WORKED = inbound + outbound (leadFunnel.contacted is the funnel top; falls back to the
  // report's leadsAttempted). On an outbound-heavy rooftop the inbound count is tiny, so the hero's
  // no-appointment fallback must include outbound or it collapses to ~0 (e.g. Corn Husker: 2 inbound
  // vs 1,830 outbound leads). "Warm" = qualified across both funnels.
  const ibf = ib.leadFunnel || {}, obf = ob.leadFunnel || {};
  const ibLeads = n(ibf.contacted) || n(ir.leadsAttempted);
  const obLeads = n(obf.contacted) || n(or.leadsAttempted);
  // SALES: the rooftop's own DISTINCT counts when the Overview would use them (same gate, ported above).
  // Summing the two agents counts a lead both worked twice (Dream Nissan Midwest week of 09-21: 6,245 vs
  // the Overview's 6,215 leads, 161 vs 155 conversations). Service keeps the sum, as the Overview does.
  const deptAgents = [ib, ob].filter((a) => a && a.name);
  const rungs = rooftopRungsFor(j, dept, deptAgents);
  const totalLeadsWorked = rungs ? rungs.leadsAttempted : ibLeads + obLeads;
  const warmWorked = rungs ? rungs.qualified : n(ibf.qualified) + n(obf.qualified);
  const reached = rungs ? rungs.engaged : n(ibf.connected) + n(obf.connected);
  // AI-booked = every agent's PLUS this department's bookings no agent owns, and AI-assisted = the
  // department's snapshot total — both exactly the Overview's tile (aggregateFleet), and both counted
  // from the same rows as the j.namedAppointments list the email shows beneath them.
  const unattributed = unattributedApptsFor(j, dept);
  const apptsBooked = n(im.appointments) + n(om.appointments) + unattributed;
  const assistedTotal = assistedApptsFor(j, dept);
  // Delta chips. Sales on distinct rungs: the API's own rooftop deltaPct, then its prior block, else none
  // (never a distinct current over a summed prior). Otherwise the prior basis summed over this
  // department's agents — the Overview's rungDelta / pSum, field for field.
  const prior = (j && j.prior) || {};
  const pSum = (f) => deptAgents.reduce((s, a) => { const p = prior[agentIdOf(a)]; return s + (p ? n(f(p)) : 0); }, 0);
  let kpiDeltas;
  if (rungs) {
    if (rungs.deltaPct) kpiDeltas = { leads: rungs.deltaPct.leadsAttempted, conversations: rungs.deltaPct.engaged, qualified: rungs.deltaPct.qualified };
    else if (rungs.prior) kpiDeltas = { leads: pctDelta(totalLeadsWorked, rungs.prior.leadsAttempted), conversations: pctDelta(reached, rungs.prior.engaged), qualified: pctDelta(warmWorked, rungs.prior.qualified) };
    else kpiDeltas = { leads: null, conversations: null, qualified: null };
  } else {
    kpiDeltas = { leads: pctDelta(totalLeadsWorked, pSum((b) => b.leads)), conversations: pctDelta(reached, pSum((b) => b.conversations)), qualified: pctDelta(warmWorked, pSum((b) => b.qualified)) };
  }
  kpiDeltas.appointments = pctDelta(apptsBooked, pSum((b) => b.appointments));
  // Per-section chips: each agent's own deltas, plus a lead-grain conversations delta (the per-agent
  // deltas carry none, and a calls delta under a conversation count is a different number).
  const priorOf = (a) => prior[agentIdOf(a)] || null;
  const inboundDeltas = Object.assign({}, ir.deltas || {}, { conversations: priorOf(ib) ? pctDelta(n(ibf.connected), priorOf(ib).conversations) : null });
  const outboundDeltas = Object.assign({}, or.deltas || {}, { conversations: priorOf(ob) ? pctDelta(n(obf.connected) || n(om.conversations), priorOf(ob).conversations) : null });
  return {
    appointmentsYesterday: apptsBooked, appointmentsInbound: n(im.appointments), appointmentsUnattributed: unattributed,
    // canonical: AI-assisted (CRM) appointments — SECONDARY metric, shown small under the AI-booked
    // headline, never folded in. The department's snapshot total when the API sends it (the Overview's
    // tile), else the per-agent attributed sum.
    assistedAppointments: assistedTotal != null ? assistedTotal : n(im.appointmentsAssisted) + n(om.appointmentsAssisted),
    rooftopRungs: !!rungs,
    kpiDeltas, inboundDeltas, outboundDeltas,
    inboundUniqueLeads: ibLeads, totalLeads: totalLeadsWorked,
    // Legacy inbound-leads value (report.leadsAttempted) — what the classic v1 email + its
    // guardrail used before the leadFunnel.contacted switch. Kept so a rooftop still on the
    // 'v1' (classic) daily template renders byte-for-byte the same numbers it does in prod.
    inboundUniqueLeadsLegacy: n(ir.leadsAttempted),
    // warm leads kept moving even when nothing booked (drives the no-appointment hero) — both funnels.
    // NOTE: `warmLeads` is OVERWRITTEN downstream (metricsFull) with the enrichment LIST that feeds the
    // "work these now" card, so the v2 hero must read the numeric `warmCount` below — never
    // num(m.warmLeads) (that reads the array → NaN → 0, which silently mislabels total leads as "warmed").
    warmLeads: warmWorked || totalLeadsWorked,
    warmCount: warmWorked,
    conversationsCall: callIn + callOut, conversationsSms: smsIn + smsOut, conversationsChat: 0, conversationsHandled: callIn + callOut + smsIn + smsOut,
    // DISPLAYED "Conversations" = reached/two-way conversations, deduped per lead (the funnel's
    // `connected` stage: a connected call OR an SMS that got a human reply). This is what the console's
    // Conversations metric counts. The channelSplit-based conversationsHandled above stays as raw
    // call/SMS activity (channel-breakdown bars + the send guardrail) — see Jun-2026 console-vs-digest bug.
    conversationsReached: reached, conversationsInbound: n(ibf.connected),
    conversationsCallIn: callIn, conversationsSmsIn: smsIn, conversationsChatIn: 0,
    conversationsCallOut: callOut, conversationsSmsOut: smsOut, conversationsChatOut: 0,
    // ── redesign fields (Conversational AI 2.0) ──────────────────────────────
    agentPerson: sm.person || "",
    callsHandled: calls,                                   // "total calls handled"
    // "Leads Qualified" = distinct qualified LEADS (funnel stage), matching the console. Was
    // metrics.qualified = per-conversation qualified EVENTS, which over-counts a lead qualified on
    // multiple conversations (e.g. Covina Kia 6/27: console 31 = leadFunnel.qualified vs event 50).
    qualifiedLeads: ib.leadFunnel ? n(ibf.qualified) : n(im.qualified), qualifiedPct: n(ir.qualifiedPct),
    bookingRate: n(ir.abr != null ? ir.abr : sm.bookingRate), // ABR % for the booking-rate tile
    deltas: ir.deltas || {},                               // ▲▼ vs prior period
    intent: Array.isArray(ir.intent) ? ir.intent : [],     // query-resolution donut
    queries: Array.isArray(ir.queries) ? ir.queries : [],  // resolution rate (resolved/total)
    leadsBySource: Array.isArray(ir.leadsBySource) ? ir.leadsBySource : [], // lead activity
    leadFunnel: ib.leadFunnel || null, // legacy (= inbound funnel); kept for back-compat
    // Per-agent funnels — Leads → Real conversations → Qualified → Appointments, EACH from its own
    // agent (inbound vs outbound). Previously only ib.leadFunnel was passed and the template consumed it
    // in the OUTBOUND section (mislabelled inbound numbers), and INBOUND had no funnel at all. `appt` is
    // taken from the agent's booked-meetings metric (im/om.appointments), not the funnel's own appt flag.
    inboundFunnel: ib.leadFunnel ? { contacted: n(ibf.contacted) || n(ir.leadsAttempted), connected: n(ibf.connected), qualified: n(ibf.qualified), appt: n(im.appointments) } : null,
    outboundFunnel: ob.leadFunnel ? { contacted: n(obf.contacted) || n(or.leadsAttempted) || obCalls, connected: n(obf.connected) || n(om.conversations), qualified: n(obf.qualified), appt: n(om.appointments) } : null,
    outcomes: Array.isArray(ob.outcomes) ? ob.outcomes : [], // outbound outcomes bars
    callingDuring: Math.max(0, calls - after), callingAfter: after, // calling hours during/after
    // ── outbound ──────────────────────────────────────────────────────────────
    outboundUniqueReached: n(om.conversations), outboundTotalCalls: obCalls, outboundConnected: Math.round((obCalls * obRate) / 100),
    outboundConnectRate: obRate, outboundAppointmentsSet: n(om.appointments),
    warmTransfers: n(cf.transferred), transferTotalCalls: n(cf.total), transferCount: n(cf.transferred), transferRate: 0,
    // Inbound "what the agent did" outputs (cf = INBOUND callFlow). Transfers feed the inbound outputs
    // row; callbacks the template derives from the action-item list (request_callback). cf.transferred
    // is console-aligned: reporting-vini derives it from endcallreports.callDetails_endedReason='transferred'
    // (matches the Calls tab, e.g. Honda DTLA 94≈93) — NOT the zero-filled endcallreports.callTransferred.
    inboundTransfers: n(cf.transferred), inboundTransferTotal: n(cf.total),
    // Hand-offs to team = transfers + callbacks across BOTH agents, read from the same callFlow fields the
    // Overview sums (aggregateFleet: callFlow.transferred + callFlow.callbacks). The template used to derive
    // callbacks from two legacy action-item intent names that no agent emits any more (0 of 1,178 sends).
    handoffTransfers: n(cf.transferred) + n(ocf.transferred), handoffCallbacks: n(cf.callbacks) + n(ocf.callbacks),
    inboundCallbacks: n(cf.callbacks), outboundTransfers: n(ocf.transferred),
  };
}
// Created-in-window action items, grouped by intent. Pages through the route's 200-row cap (offset +
// hasMore) instead of silently stopping at 200; past ACTION_ITEMS_MAX_PAGES it flags `truncated` so the
// email can say "200+" rather than print a capped number as if it were the total.
const ACTION_ITEMS_PAGE = 200, ACTION_ITEMS_MAX_PAGES = 10;
async function apiActionItems(teamId, dept, start, end, entId) {
  // REAL action items from dealer_leads.actionItems, created in the report window, grouped by intent.
  // Fetched via reporting-vini /api/action-items?scope=created — the faithful successor to the old
  // getActionItems() "createdAt BETWEEN start/end GROUP BY intent" query.
  //   Was: ib.report.intent (INBOUND conversation-intent) — a different, much smaller signal that
  //   under-counted by 3-5× and read 0 on quiet-inbound days despite dozens of real CRM action items.
  const svc = dept === "service" ? "service" : "sales";
  try {
    const rows = [];
    let truncated = false;
    for (let page = 0; ; page++) {
      const url = `${REPORTING_API_BASE}/api/action-items?team_id=${encodeURIComponent(teamId)}&serviceType=${svc}&scope=created&start=${start}&end=${end}&limit=${ACTION_ITEMS_PAGE}&offset=${page * ACTION_ITEMS_PAGE}${entQS(entId)}`;
      const res = await fetch(url, { headers: REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {}, signal: AbortSignal.timeout(REPORTING_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`action-items ${res.status} (${teamId} ${start}..${end})`);
      const j = await res.json();
      if (j && j.degraded) throw new Error(`action-items degraded (${teamId})`);
      const got = Array.isArray(j && j.actionItems) ? j.actionItems : [];
      rows.push(...got);
      // hasMore is the route's "got a full page" flag; an older deploy without it never pages.
      if (!(j && j.hasMore) || got.length === 0) break;
      if (page + 1 >= ACTION_ITEMS_MAX_PAGES) { truncated = true; break; }
    }
    // Group the row-level items by intent → [{intent, count}] (blank intents already dropped server-side).
    const byIntent = new Map();
    for (const it of rows) {
      const k = (it.intent || "").trim();
      if (!k) continue;
      byIntent.set(k, (byIntent.get(k) || 0) + 1);
    }
    const items = [...byIntent.entries()].map(([intent, count]) => ({ intent, count })).sort((a, b) => b.count - a.count);
    return { total: items.reduce((s, i) => s + i.count, 0), items, truncated };
  } catch { return { total: 0, items: [], truncated: false }; }
}
// Action-item scoreboard (scope=stats): current-state `open` / `overdue` and `completed` (closed within
// [start,end)). Feeds the "N still open", "N overdue" and "N closed" lines. Never throws: an unreachable
// or degraded stats call returns null, which the email renders as nothing (never as a false 0).
async function apiActionItemStats(teamId, dept, start, end, entId) {
  const svc = dept === "service" ? "service" : "sales";
  try {
    const url = `${REPORTING_API_BASE}/api/action-items?team_id=${encodeURIComponent(teamId)}&serviceType=${svc}&scope=stats&start=${start}&end=${end}${entQS(entId)}`;
    const res = await fetch(url, { headers: REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {}, signal: AbortSignal.timeout(REPORTING_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`action-items stats ${res.status} (${teamId})`);
    const j = await res.json();
    if (j && j.degraded) throw new Error(`action-items stats degraded (${teamId})`);
    if (!j || !j.stats || typeof j.stats !== "object") return null;
    return { stats: j.stats, source: j.source || null };
  } catch { return null; }
}
// Stats that cannot be right. Since 2026-10-01 the route answers scope=stats from the dealer-leads API
// first; without the rooftop's enterprise it got all zeros back and returned them as real (0 of 335 sends
// had an overdue chip, against ~95% before). All-zero dealer-leads stats on a window where items WERE
// created is that failure, not a quiet day.
function actionItemStatsDegraded(st, createdTotal) {
  if (!st || !st.stats) return true;
  const s = st.stats;
  const allZero = ["created", "completed", "open", "overdue"].every((k) => !(Number(s[k]) > 0));
  return st.source === "dealer-leads" && allZero && createdTotal > 0;
}
async function apiCampaigns(teamId, dept, start, end, entId) {
  try {
    const { ob } = apiPickDept(await apiReport(teamId, start, end, entId), dept);
    const mapped = ((ob.report || {}).activeCampaigns || []).map((c) => {
      const dials = Number(c.enrolled) || 0, appts = Number(c.appts) || 0;
      const conversion = c.apptRate != null ? `${Number(c.apptRate).toFixed(1)}%` : dials > 0 ? `${((appts * 100) / dials).toFixed(1)}%` : "0%";
      // warmLeads = distinct enrolled leads with a buying-intent outcome (reporting-vini canonical);
      // MUST carry through or the digest's "Warm" stat reads 0.
      return { name: (c.name || "").trim() || "Campaign", dials, appts, conversion, warm: Number(c.warmLeads) || 0 };
    }).filter((c) => c.dials > 0);
    // dedupe by name (keep the highest-enrolled row), then surface the most productive — sorted by
    // appts desc then enrolled desc, capped — so a long recall list can't bloat the email.
    const byName = new Map();
    for (const c of mapped) { const e = byName.get(c.name); if (!e || c.dials > e.dials) byName.set(c.name, c); }
    return [...byName.values()].sort((a, b) => b.appts - a.appts || b.dials - a.dials).slice(0, 8);
  } catch { return []; }
}
// metric fetchers — Reporting API only (day window = apiStart..apiEnd, MTD = apiMonthStart..apiEnd)
const getMetrics = (teamId, dept, w, win, entId) => apiMetrics(teamId, dept, win === "mtd" ? w.apiMonthStart : w.apiStart, w.apiEnd, entId);

// ── Department liveness (lull-tolerant 90-day lifecycle signal) ──────────────
// A digest section (Sales/Service · Inbound/Outbound) shows when its direction is genuinely ALIVE — i.e. it
// had ANY real activity within the last LIFE_DAYS. This is deliberately NOT the single-day window (which
// would hide a live-but-quiet dept on a slow day) and NOT a config/provisioning flag (Paragon's inbound
// agent IS provisioned yet does no real inbound — all its calls are outbound call-backs). An activity lull
// is not churn; only genuine ~90-day silence (or an upstream-churned rooftop, already excluded) hides it.
const LIFE_DAYS = 90;
const N = (v) => Number(v) || 0;
const ibActivity = (x) => { x = x || {}; return N(x.appointmentsInbound) + N(x.inboundUniqueLeads) + N(x.conversationsInbound) + N(x.conversationsCallIn) + N(x.conversationsSmsIn) + N(x.conversationsChatIn) + N(x.warmTransfers); };
const obActivity = (x) => { x = x || {}; return N(x.outboundTotalCalls) + N(x.outboundUniqueReached) + N(x.outboundConnected) + N(x.outboundAppointmentsSet); };
const subDaysISO = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };
// Returns {inboundLive, outboundLive}. LAZY: day-activity ⊆ 90d-activity, so a direction that was active in
// the current window is trivially alive (no extra fetch); we only pay the 90d /api/reports round-trip for a
// direction that had ZERO activity this window (to tell "quiet today but alive" from "genuinely dead").
// FAIL-OPEN to the day-window verdict if the 90d fetch errors (never blocks a send on a monitoring blip).
async function deriveLiveness(teamId, dept, w, day, entId) {
  let inboundLive = ibActivity(day) > 0, outboundLive = obActivity(day) > 0;
  if (!inboundLive || !outboundLive) {
    try {
      const life = await apiMetrics(teamId, dept, subDaysISO(w.apiEnd, LIFE_DAYS), w.apiEnd, entId);
      if (!inboundLive) inboundLive = ibActivity(life) > 0;
      if (!outboundLive) outboundLive = obActivity(life) > 0;
    } catch (e) { console.warn("[roi-cron] liveness 90d probe failed (fail-open to day window):", String(e && e.message ? e.message : e).slice(0, 100)); }
  }
  return { inboundLive, outboundLive };
}
// Day-window metrics with the 90d liveness flags folded in, so every downstream `{ ...day }` spread carries
// inboundLive/outboundLive into the stored metrics `m` (templates gate their IB/OB sections on these).
const getDayWithLiveness = async (teamId, dept, w, entId) => {
  const day = await getMetrics(teamId, dept, w, "day", entId);
  const live = await deriveLiveness(teamId, dept, w, day, entId);
  return { ...day, inboundLive: live.inboundLive, outboundLive: live.outboundLive };
};

// ── Aggregate freshness probe (send-time staleness gate) ─────────────────────
// The digest reads agent_daily via /api/reports. A STALLED sync leaves agent_daily
// frozen-but-READABLE, so /api/reports returns degraded:false with ZEROS — byte-for-byte
// identical to a genuine quiet day (the `degraded` flag only catches a read FAILURE, not
// staleness — verified on prod). This probe reads reporting-vini's /api/sync-health (the
// newest agent_daily day) so the send path can REFUSE to email stale zeros: if the
// aggregate hasn't reached the day being reported, HOLD + alert instead of shipping a
// frozen snapshot. Best-effort / FAIL-OPEN: on a probe failure we do NOT block sends — the
// sync fixes + watchdog stay the primary guard, and holding every customer digest on a
// monitoring blip is the worse failure. Fetched ONCE per pass, passed into processOne.
async function probeAggregateFreshness() {
  try {
    const res = await fetch(`${REPORTING_API_BASE}/api/sync-health`, { headers: REPORTING_AUTH ? { Authorization: `Bearer ${REPORTING_AUTH}` } : {}, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j && j.ok && j.maxActivityDay) return { maxActivityDay: String(j.maxActivityDay), lastRunAt: j.lastRunAt || null, known: true };
    return { known: false };
  } catch (e) {
    console.warn("[roi-cron] aggregate freshness probe unreachable — sends proceed (fail-open):", String(e && e.message ? e.message : e).slice(0, 120));
    return { known: false };
  }
}
// Stale = we KNOW the newest aggregated day and it is BEFORE the LAST day being reported → the sync has
// not processed that day yet, so any figure for it would be frozen/zero, not real. For a daily digest
// the last day is the report date; for a weekly/monthly one it is the period's final day.
function aggregateStaleForDate(freshness, reportLastDay) {
  return !!(freshness && freshness.known && freshness.maxActivityDay < reportLastDay);
}
const getActionItems = async (teamId, dept, w, entId) => {
  const [items, st] = await Promise.all([
    apiActionItems(teamId, dept, w.apiStart, w.apiEnd, entId),
    apiActionItemStats(teamId, dept, w.apiStart, w.apiEnd, entId),
  ]);
  const degraded = actionItemStatsDegraded(st, items.total);
  if (degraded && st) console.warn(`[roi-cron] ${teamId} [${dept}] action-item stats look wrong (all zero from ${st.source || "?"} while ${items.total} were created) — holding the open/overdue/closed figures`);
  const s = (!degraded && st && st.stats) || {};
  const val = (k) => (degraded ? null : Number(s[k]) || 0);
  return { ...items, statsDegraded: degraded, open: val("open"), overdue: val("overdue"), closedYesterday: val("completed") };
};
const getCampaigns = (teamId, dept, w, entId) => apiCampaigns(teamId, dept, w.apiStart, w.apiEnd, entId);

// ── ONE metric build for every send path ────────────────────────────────────────────────────────
// The daily, weekly, monthly, on-demand, preview and backfill paths each used to assemble `m` by hand
// and they drifted (weekly/monthly/on-demand never carried conversationsReachedMTD, so their hero fell
// back to "leads worked this month"). They all call this now. Returns the metrics, the action-item
// list, and the day window's full /api/reports response (the appointment list is read from it).
async function buildDigestMetrics({ teamId, entId, dept, w }) {
  const day = await getDayWithLiveness(teamId, dept, w, entId);
  const mtd = await getMetrics(teamId, dept, w, "mtd", entId);
  const ai = await getActionItems(teamId, dept, w, entId);
  let report = null;
  try { report = (await apiReport(teamId, w.apiStart, w.apiEnd, entId)).j; } catch { /* cached success above; never reached */ }
  const m = {
    ...day,
    actionItemsTotal: ai.total, actionItemsTruncated: ai.truncated === true,
    actionItemsOpen: ai.open, actionItemsOverdue: ai.overdue, actionItemsClosedYesterday: ai.closedYesterday,
    actionItemStatsDegraded: ai.statsDegraded === true,
    appointmentsYesterdayMTD: mtd.appointmentsYesterday,
    appointmentsInboundMTD: mtd.appointmentsInbound,
    warmTransfersMTD: mtd.warmTransfers,
    inboundUniqueLeadsMTD: mtd.inboundUniqueLeads,
    // combined (IB+OB, or the rooftop's distinct count) leads MTD — the sub-line under "Leads touched",
    // which is itself combined. It used to pair a combined daily number with an inbound-only MTD.
    totalLeadsMTD: mtd.totalLeads,
    // real-conversations MTD drives the hero's "…this month" pop-out; without it the hero
    // silently falls back to "leads worked this month" on conversation-focus rooftops.
    conversationsReachedMTD: mtd.conversationsReached,
    outboundUniqueReachedMTD: mtd.outboundUniqueReached,
    outboundConnectRateMTD: mtd.outboundConnectRate,
    outboundAppointmentsSetMTD: mtd.outboundAppointmentsSet,
    // redesign MTD figures (calling hours + qualified)
    callingDuringMTD: mtd.callingDuring,
    callingAfterMTD: mtd.callingAfter,
    qualifiedLeadsMTD: mtd.qualifiedLeads,
  };
  return { m, ai, report };
}

// ── guardrails ──────────────────────────────────────────────────────────────
// Send whenever there is ANY activity — calls handled, leads, appointments,
// outbound dials or action items. A low-ABR / zero-appointment day is NOT
// suppressed: the email still goes out and leads the story with lead activity
// (warm leads, leads-by-source) instead of appointments. Only a truly empty
// day (no signal at all) is held back as no_data.
function guardrail(m) {
  const signal =
    (m.appointmentsYesterday || 0) +
    (m.conversationsHandled || 0) +
    (m.callsHandled || 0) +
    (m.inboundUniqueLeads || 0) +
    (m.outboundTotalCalls || 0) +
    (m.actionItemsTotal || 0);
  if (signal === 0) return { ok: false, reason: "no_data" };
  return { ok: true };
}

// Classic (v1) guardrail — the ORIGINAL production send rule: holds back both empty
// days (no_data) AND "not_actionable" days (no appts, no leads, no action items).
// A rooftop on the 'v1' daily template uses THIS so its send-cadence is unchanged.
// Reads inboundUniqueLeads (callers pass the legacy-shimmed metrics for v1).
function guardrailV1(m) {
  const signal = (m.appointmentsYesterday || 0) + (m.conversationsHandled || 0) + (m.inboundUniqueLeads || 0) + (m.actionItemsTotal || 0);
  if (signal === 0) return { ok: false, reason: "no_data" };
  if ((m.appointmentsYesterday || 0) === 0 && (m.actionItemsTotal || 0) === 0 && (m.inboundUniqueLeads || 0) === 0) return { ok: false, reason: "not_actionable" };
  return { ok: true };
}

// ── email HTML (email-safe table; real console links) ───────────────────────
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Console deep links for ONE digest. They carry the email's OWN window, so the numbers in the email can
// be found on the page the dealer clicks through to:
//   · the reporting page (reporting-vini Overview, embedded at /converse-ai/reports) reads ?range=<preset>
//     or ?start=YYYY-MM-DD&end=YYYY-MM-DD with an INCLUSIVE end (reporting-vini dateRange.ts). Daily →
//     range=yesterday (the Overview's Yesterday preset is exactly the digest's day); weekly/monthly →
//     the explicit period. With no range it opened on its "Last 30 days" default (audit F11).
//   · the console's appointments / action-items lists take UTC instants: the period's store-local
//     midnight bounds (they used to assume Eastern time for every rooftop).
// `w` is the period window (localDate/apiStart/apiEnd); a bare localDate string is read as a daily day.
function links(ent, team, dept, w, tz, cadence) {
  const enc = encodeURIComponent;
  const cad = cadence === "weekly" || cadence === "monthly" ? cadence : "daily";
  if (typeof w === "string") w = { localDate: w, apiStart: w, apiEnd: addDaysISO(w, 1) };
  const zone = isValidTz(tz) ? tz : "America/New_York";
  const ymd = (iso) => iso.split("-").map(Number);
  const [sy, sm, sd] = ymd(w.apiStart), [ey, em, ed] = ymd(w.apiEnd);
  const start = localToUTC(sy, sm, sd, zone).toISOString();
  const end = new Date(localToUTC(ey, em, ed, zone).getTime() - 1).toISOString();
  const lastDay = addDaysISO(w.apiEnd, -1);
  const rangeQS = cad === "daily" ? "range=yesterday" : `start=${w.apiStart}&end=${lastDay}`;
  const b = "https://console.spyne.ai/converse-ai";
  return {
    appts: `${b}/appointments?enterprise_id=${ent}&team_id=${team}&all_createdAtStart=${enc(start)}&all_createdAtEnd=${enc(end)}${cad === "daily" ? "&all_createdAtDateValue=yesterday" : ""}&page=1&serviceType=${dept}&tab=all`,
    conv: `${b}/conversations?enterprise_id=${ent}&team_id=${team}`,
    action: `${b}/action-items?enterprise_id=${ent}&team_id=${team}&serviceType=${dept}&createdAtStart=${enc(start)}&createdAtEnd=${enc(end)}&page=1`,
    // "Open console" deep-link → the rooftop's reports page, on the email's own window.
    reports: `${b}/reports?enterprise_id=${ent}&team_id=${team}&serviceType=${dept}&${rangeQS}`,
  };
}
// "7:00 AM" from the configured send time (the footer used to hard-code 7:00 AM for every rooftop).
function fmtSendTime(hour, minute) {
  const h = Number.isFinite(Number(hour)) ? Number(hour) : 7, mi = Number.isFinite(Number(minute)) ? Number(minute) : 0;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
function nextReportLabel(cadence, cfg) {
  const at = fmtSendTime(cfg && cfg.digest_send_hour != null ? cfg.digest_send_hour : 7, cfg && cfg.digest_send_minute != null ? cfg.digest_send_minute : 0);
  if (cadence === "weekly") {
    const dow = cfg && Number.isInteger(cfg.weekly_send_dow) && cfg.weekly_send_dow >= 0 && cfg.weekly_send_dow <= 6 ? cfg.weekly_send_dow : 1;
    return `next ${WEEKDAYS[dow]} · ${at}`;
  }
  if (cadence === "monthly") {
    const day = cfg && Number.isInteger(cfg.monthly_send_day) && cfg.monthly_send_day >= 1 && cfg.monthly_send_day <= 31 ? cfg.monthly_send_day : 1;
    return `${ordinal(day)} of next month · ${at}`;
  }
  return `tomorrow · ${at}`;
}
// Map raw action-item intent → human label (matches the v1 template wording).
const INTENT_LABELS = {
  sms_takeover: "SMS takeover requested", REQUEST_CALLBACK: "Callback requests", callback_request: "Callback requests",
  appt_confirmed: "Appointments confirmed today", failed_booking: "Failed bookings to review",
  specific_salesperson: "Customers asked for a salesperson", compliance_alert: "Compliance alerts",
  recall_response: "Recall responses", pending_status_update: "Pending repair-order status", no_show: "No-shows yesterday",
  SERVICE_SCHEDULE_APPOINTMENT: "Service appointments to schedule", SERVICE_RECALL_FOLLOW_UP: "Recall follow-ups",
  SERVICE_STATUS_UPDATE: "Pending status updates", SERVICE_ESCALATE_TO_ADVISOR: "Escalations to advisor",
  SERVICE_SEND_ESTIMATE: "Estimates to send", SERVICE_PARTS_CALLBACK: "Parts callbacks", CUSTOM: "Other action items",
};
const humanizeIntent = (k) => INTENT_LABELS[k] || String(k || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// Canonical email template — delegates to the shared, Figma-faithful renderer in
// src/email/digestTemplate.cjs (the SAME module the SPA preview uses, so the sent
// bytes never drift). This wrapper just builds the view-model: console deep links,
// the open-tracking pixel URL, and the enrichment that rides on the metrics object
// (upcoming appointments, top vehicles, $/appt) populated by processOne().
// ── Open-tracking pixel ───────────────────────────────────────────────────────
// Points at the track-open Edge Function on reporting-vini (qludn). Override the
// host with DIGEST_TRACK_BASE if it ever moves. Used by BOTH digest templates
// (v1 classic + v2 redesign) so every sent mail is trackable.
const TRACK_OPEN_URL = (process.env.DIGEST_TRACK_BASE || "https://qludnojfibguobgeeujw.supabase.co/functions/v1/track-open").replace(/\/$/, "");
function pixelUrlFor(team, dept, localDate, cadence) {
  const enc = encodeURIComponent;
  return `${TRACK_OPEN_URL}?t=${enc(team)}&d=${enc(dept)}&c=${enc(cadence || "daily")}&dt=${enc(localDate)}`;
}
function pixelImg(team, dept, localDate, cadence) {
  return `<img src="${pixelUrlFor(team, dept, localDate, cadence)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
}

// ── Per-recipient open attribution (Option B) ──────────────────────────────────
// Digests go to a comma-joined To: with ONE shared body → ONE shared pixel, so an open on a
// mixed list (a Spyne CSM + the dealer) can't be attributed to a side. When PER_RECIPIENT_PIXEL
// is on, each recipient instead gets their OWN copy whose pixel is keyed &r=<their email>; the
// track-open edge fn (already deployed with &r= support) then flips only THAT recipient's opened
// flag, giving exact dealer-vs-Spyne attribution in the tracker. DEFAULT OFF — flipping it changes
// outbound sends (N copies instead of 1, and recipients no longer share a To: line). The fan-out
// happens AFTER the atomic send-claim, so at-most-once idempotency (one digest_run row) is unchanged.
const PER_RECIPIENT_PIXEL = /^(1|true|yes)$/i.test(String(process.env.PER_RECIPIENT_PIXEL || ""));
// Append &r=<email> to the single track-open pixel URL already in the html (idempotent — a URL that
// already carries r= is left as-is). Only touches the pixel <img src>, nothing else in the body.
function withRecipientPixel(html, email) {
  if (!html || !email) return html;
  const enc = encodeURIComponent(email);
  return html.replace(/(https?:\/\/[^"']*\/functions\/v1\/track-open\?[^"']*?)(["'])/i, (_m, url, q) =>
    (/[?&]r=/.test(url) ? url : `${url}&r=${enc}`) + q);
}
// Send one attributed copy per recipient when the flag is on (else a single shared send — identical
// to prior behaviour). A per-recipient failure (e.g. the v2 @spyne.ai lock filtering a dealer) is
// logged and skipped so it never aborts the rooftop's other recipients. Returns the first messageId.
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
      console.warn(`  ⚠ per-recipient send skipped ${em}: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }
  return firstId;
}

// The period window for links when the caller has none (re-renders of a stored row): rebuilt from the
// row's own cadence + local_date. Never throws — a bad zone or date falls back to the day itself.
function periodWindowFor(tz, cadence, localDate) {
  try { return windowForPeriod(isValidTz(tz) ? tz : "America/New_York", cadence, localDate); } catch { return localDate; }
}
// ctx (optional): { w: period window, cfg: roi_rooftop_config row (send time for the footer) }.
function renderHtml(name, dept, dateLabel, ent, team, localDate, tz, m, campaigns, cadence, ctx) {
  ctx = ctx || {};
  const L = links(ent, team, dept, ctx.w || periodWindowFor(tz, cadence, localDate), tz, cadence);
  // First-party open pixel → the track-open Edge Function (always reachable from an
  // inbox; deterministic from team/dept/cadence/date so a re-render reproduces it).
  const pixelUrl = pixelUrlFor(team, dept, localDate, cadence);
  // Email images need ABSOLUTE URLs — DIGEST_ASSET_BASE (CDN/app URL) when configured.
  const assetBase = (process.env.DIGEST_ASSET_BASE || "").replace(/\/$/, "");
  const campaignImages = assetBase ? [`${assetBase}/digest-assets/campaign-honda.jpg`, `${assetBase}/digest-assets/campaign-tata.jpg`] : [];
  const mm = Object.assign({}, m, { campaigns: campaigns || m.campaigns || [] });
  return renderDigestHtml(mm, {
    rooftopName: name,
    dept: dept === "service" ? "service" : "sales",
    dateLabel,
    agentPerson: m.agentPerson || "",
    links: { appointments: L.appts, conversations: L.conv, actionItems: L.action, console: L.reports },
    appointments: Array.isArray(m.appointments) ? m.appointments : [],
    // AI-assisted (CRM) bookings, listed apart from the AI-booked ones (never under the AI-booked heading).
    assistedAppointments: Array.isArray(m.assistedAppointmentList) ? m.assistedAppointmentList : [],
    topVehicles: Array.isArray(m.topVehicles) ? m.topVehicles : [],
    topVehiclesDays: Number(m.topVehiclesDays) || undefined,
    nextReportLabel: ctx.cfg ? nextReportLabel(cadence, ctx.cfg) : undefined,
    warmLeads: Array.isArray(m.warmLeads) ? m.warmLeads : [],
    dollarRate: Number(m.dollarRate) || 0,
    // Upsell banner is driven by agent deployment state when it's present on the
    // stored metrics; absent → the template falls back to the speed-to-lead CTA.
    deployment: m.deployment || undefined,
    // CONTENT FOCUS — 'appointment' (top closers) vs 'conversation' (the ~90%). Stable per rooftop,
    // resolved by pickFocus() from roi_rooftop_config.digest_focus and stamped onto the metrics.
    focus: m.digest_focus || m.focus || undefined,
    // daily → undefined ("yesterday" wording); weekly/monthly switch the template's period nouns.
    period: cadence === "weekly" || cadence === "monthly" ? cadence : undefined,
    pixelUrl, assetBase, campaignImages,
  });
}

// ── CLASSIC daily template (v1) ───────────────────────────────────────────────
// The ORIGINAL production email — self-contained email-safe HTML (colors #0369A1/
// #0891B2/#0D9488). Preserved verbatim so a rooftop on the 'v1' daily template keeps
// getting the exact email it gets today. Selected per-rooftop via roi_rooftop_config
// .daily_template; v2 is renderHtml() above (the Conversational-AI-2.0 redesign).
function renderHtmlV1(name, dept, dateLabel, ent, team, localDate, tz, m, campaigns, ctx) {
  ctx = ctx || {};
  const L = links(ent, team, dept, ctx.w || periodWindowFor(tz, "daily", localDate), tz, "daily");
  const isSvc = dept === "service";
  const camps = (campaigns || []).filter((c) => Number(c.dials) > 0); // drop zero-dial campaigns
  const items = (m.actionItems || []).slice(0, 6);
  const tv = m.topVehicles || [];
  // total conversations (hero "Conversations handled") + inbound-only split (channel breakdown)
  const call = m.conversationsCall || 0, sms = m.conversationsSms || 0, chat = m.conversationsChat || 0;
  const callIn = m.conversationsCallIn || 0, smsIn = m.conversationsSmsIn || 0, chatIn = m.conversationsChatIn || 0;
  const callOut = m.conversationsCallOut || 0, smsOut = m.conversationsSmsOut || 0, chatOut = m.conversationsChatOut || 0;
  // presence flags — drive section removal (HTML handling rules)
  const hasConv = (call + sms + chat) > 0;                 // hero (total)
  const hasInboundConv = (callIn + smsIn + chatIn) > 0;    // inbound channel breakdown
  const hasOutboundConv = (callOut + smsOut + chatOut) > 0; // outbound channel breakdown
  const hasOutbound = (m.outboundLive != null) ? !!m.outboundLive : ((m.outboundTotalCalls || 0) + (m.outboundUniqueReached || 0) + (m.outboundConnected || 0) + (m.outboundAppointmentsSet || 0) > 0);
  // Inbound section gate — mirror hasOutbound. Prefer the lull-tolerant 90d liveness flag (m.inboundLive,
  // set in getDayWithLiveness): show the section when an inbound agent is genuinely ALIVE over the lifecycle
  // window, NOT just when it happened to have activity in this single day (a live-but-quiet inbound must
  // still show). Falls back to the day-window inbound-only signal for older stored runs that predate the
  // flag. Without this, an outbound-only rooftop (e.g. Paragon — its only "inbound" is outbound call-backs,
  // re-attributed to Outbound upstream) rendered a phantom inbound panel whose Appointments tile showed the
  // COMBINED total (mislabeling outbound bookings as inbound).
  const hasInbound = (m.inboundLive != null) ? !!m.inboundLive : ((m.appointmentsInbound || 0) + (m.inboundUniqueLeads || 0) + (m.conversationsInbound || 0) + callIn + smsIn + chatIn + (m.warmTransfers || 0) > 0);
  // channel bar + legend for any (call,sms,chat) triple
  const mkBar = (cc, ss, hh) => { const t = cc + ss + hh || 1; const p = (x) => `${(x / t) * 100}%`; return `<table width="100%" cellpadding="0" cellspacing="0" style="height:8px;border-radius:9999px;overflow:hidden;margin-top:8px;"><tr>${cc > 0 ? `<td style="width:${p(cc)};background:#0369A1;font-size:0;line-height:0;">&nbsp;</td>` : ""}${ss > 0 ? `<td style="width:${p(ss)};background:#0891B2;font-size:0;line-height:0;">&nbsp;</td>` : ""}${hh > 0 ? `<td style="width:${p(hh)};background:#0D9488;font-size:0;line-height:0;">&nbsp;</td>` : ""}</tr></table><div style="margin-top:8px;"><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0369A1;margin-right:5px;"></span>Call <span style="color:#525252;">${cc}</span></span><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0891B2;margin-right:5px;"></span>Sms <span style="color:#525252;">${ss}</span></span><span style="display:inline-block;margin-right:14px;font-size:11px;color:#171717;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#0D9488;margin-right:5px;"></span>Chat <span style="color:#525252;">${hh}</span></span></div>`; };
  const channelBar = mkBar(call, sms, chat); // hero = total
  const mini = (l, v, sub) => `<td class="col" width="33%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px;"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;font-weight:600;">${esc(l)}</div><div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${esc(v)}</div><div style="font-size:11px;color:#6B7280;margin-top:2px;">${esc(sub)}</div></div></td>`;
  const btnP = (l, h) => `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#4600F2;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 18px;border-radius:8px;">${l}</a>`;
  const btnS = (l, h) => `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;color:#4600F2;text-decoration:underline;font-size:13px;font-weight:600;padding:11px 8px;">${l}</a>`;
  const sect = (t) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700;margin:22px 0 10px;">${t}</div>`;
  const rule = `<div style="border-top:1px solid #E5E7EB;margin:22px 0;"></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;}@media only screen and (max-width:600px){.wrap{width:100%!important;border-radius:0!important;}.col{display:block!important;width:100%!important;}.pad{padding-left:16px!important;padding-right:16px!important;}}</style></head>
<body style="margin:0;background:#F3F4F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;"><tr><td align="center">
<table class="wrap" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#fff;border-radius:14px;border:1px solid #E5E7EB;overflow:hidden;">
  <tr><td class="pad" style="padding:24px 28px 8px;"><table width="100%"><tr>
    <td valign="top"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4600F2;font-weight:700;">Vini · Dealer Reporting</div><div style="font-size:24px;font-weight:800;margin-top:4px;">${isSvc ? "Service" : "Sales"} Daily Digest</div></td>
    <td valign="top" align="right"><div style="font-size:13px;font-weight:700;">${esc(name)}</div><div style="font-size:12px;color:#6B7280;">${esc(dateLabel)}</div></td>
  </tr></table></td></tr>
  <tr><td class="pad" style="padding:8px 22px 0;"><table width="100%"><tr>
    <td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;height:100%;box-sizing:border-box;min-height:150px;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">${(m.appointmentsYesterday || 0) > 0 ? "Appointments yesterday" : "Leads warmed"}</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${(m.appointmentsYesterday || 0) > 0 ? (m.appointmentsYesterday || 0) : (m.inboundUniqueLeads || 0)}</div><div style="margin-top:12px;"><span style="display:inline-block;font-size:11px;font-weight:600;color:#4600F2;background:#EEF0FF;border-radius:9999px;padding:4px 10px;">${m.appointmentsYesterdayMTD || 0} ${(m.appointmentsYesterday || 0) > 0 ? "month to date" : "appointments MTD"}</span></div></div></td>
    <td class="col" width="50%" valign="top" style="padding:6px;"><div style="border:1px solid #E5E7EB;border-radius:10px;padding:18px;background:#F9FAFB;height:100%;box-sizing:border-box;min-height:150px;"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:600;">Conversations handled</div><div style="font-size:34px;font-weight:800;color:#111827;line-height:1;margin-top:6px;">${(m.conversationsReached != null ? m.conversationsReached : m.conversationsHandled) || 0}</div>${hasConv ? channelBar : `<div style="font-size:11px;color:#9CA3AF;margin-top:10px;">No conversations yesterday</div>`}</div></td>
  </tr></table></td></tr>
  <tr><td class="pad" style="padding:14px 28px 4px;">${btnP("View appointments", L.appts)} ${btnS("Open conversation inbox", L.conv)}</td></tr>
  ${items.length ? `<tr><td class="pad" style="padding:4px 28px;">${rule}${sect("Action required")}<table width="100%">${items.map((it) => `<tr><td style="padding:7px 0;"><span style="display:inline-block;min-width:22px;height:22px;line-height:22px;text-align:center;background:#111827;color:#fff;border-radius:6px;font-size:12px;font-weight:700;">${it.count}</span><span style="font-size:13px;color:#111827;margin-left:10px;">${esc(humanizeIntent(it.intent))}</span></td></tr>`).join("")}</table><div style="margin-top:12px;">${btnP("Review action items", L.action)}</div></td></tr>` : ""}
  ${hasInbound ? `<tr><td class="pad" style="padding:4px 22px;">
    <div style="padding:0 6px;">${rule}${sect("Inbound activity")}</div>
    <table width="100%"><tr>
      ${mini("Appointments", m.appointmentsInbound || 0, `Yesterday · ${m.appointmentsInboundMTD || 0} MTD`)}
      ${mini("Unique leads", m.inboundUniqueLeads || 0, `Yesterday · ${m.inboundUniqueLeadsMTD || 0} MTD`)}
      ${mini("Warm transfers", m.warmTransfers || 0, `Yesterday · ${m.warmTransfersMTD || 0} MTD`)}
    </tr></table>
    ${hasInboundConv ? `<div style="padding:0 6px;">${sect("Channel breakdown")}${mkBar(callIn, smsIn, chatIn)}</div>` : ""}
  </td></tr>` : ""}
  ${tv.length ? `<tr><td class="pad" style="padding:4px 22px;"><div style="padding:0 6px;">${rule}${sect("Top vehicles of interest")}<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">${tv.map((v, i) => `<tr><td style="padding:12px 14px;${i ? "border-top:1px solid #E5E7EB;" : ""}"><table width="100%"><tr><td style="font-size:13px;color:#111827;">${esc(v.name)}</td><td align="right" style="font-size:13px;font-weight:700;color:#111827;">${v.count}</td></tr></table></td></tr>`).join("")}</table></div></td></tr>` : ""}
  ${hasOutbound ? `<tr><td class="pad" style="padding:4px 22px;">
    <div style="padding:0 6px;">${rule}${sect("Outbound activity")}<div style="font-size:11px;color:#9CA3AF;margin:-4px 0 4px;">Yesterday's activity</div></div>
    <table width="100%"><tr>
      ${mini("Unique reached", m.outboundUniqueReached || 0, `Yesterday · ${m.outboundUniqueReachedMTD || 0} MTD`)}
      ${mini("Connect rate", `${Math.round(Number(m.outboundConnectRate) || 0)}%`, `Yesterday · ${Math.round(Number(m.outboundConnectRateMTD) || 0)}% MTD`)}
      ${mini("Appointments set", m.outboundAppointmentsSet || 0, `Yesterday · ${m.outboundAppointmentsSetMTD || 0} MTD`)}
    </tr></table>
    ${hasOutboundConv ? `<div style="padding:0 6px;">${sect("Channel breakdown")}${mkBar(callOut, smsOut, chatOut)}</div>` : ""}
    ${camps.length ? `<div style="padding:0 6px;">${sect("Active campaigns")}<div style="font-size:11px;color:#9CA3AF;margin:-4px 0 4px;">Last 120 days</div>${camps.map((c) => `<div style="border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;margin-top:8px;"><div><span style="font-size:13px;font-weight:600;color:#111827;">${esc(c.name)}</span><span style="font-size:9px;font-weight:700;letter-spacing:.06em;color:#16A34A;background:#DCFCE7;border-radius:4px;padding:2px 6px;margin-left:8px;">ACTIVE</span></div><div style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(c.dials)} dials · ${esc(c.appts)} appts · ${esc(c.conversion)} conversion</div></div>`).join("")}</div>` : ""}
  </td></tr>` : ""}
  <tr><td class="pad" style="padding:18px 28px 26px;border-top:1px solid #E5E7EB;"><table width="100%"><tr>
    <td valign="top" style="font-size:11px;color:#9CA3AF;line-height:1.6;">Reporting period: ${esc(dateLabel)}<br/>Next report: ${esc(nextReportLabel("daily", ctx.cfg || {}))}</td>
    <td valign="top" align="right" style="font-size:11px;color:#9CA3AF;">© Vini · 2026</td>
  </tr></table></td></tr>
</table></td></tr></table></body></html>`;
}

// ── Daily-template dispatch ───────────────────────────────────────────────────
// Pick the template for a given rooftop-config + cadence. Only the DAILY digest is
// switchable per-rooftop (redesign 'v2' vs classic 'v1'); weekly/monthly are new and
// only exist in v2. Default 'v2' — the redesigned "Conversational AI 2.0" digest is
// now the product default for EVERY rooftop (go-live Jul 2026). A rooftop gets the
// CLASSIC email only if it's explicitly opted back to 'v1' via the tracker.
function pickTemplate(cfg, cadence) {
  if (cadence === "weekly" || cadence === "monthly") return "v2";
  return (cfg && cfg.daily_template === "v1") ? "v1" : "v2";
}
// ── Content-focus dispatch (the appointment/conversation checker) ────────────
// Stable, per-rooftop choice of what the digest LEADS with:
//   • 'appointment' — appointments are the headline (the top closers: STL / during-hours / strong
//     daily booking cadence). This is the current redesign layout.
//   • 'conversation' — conversations handled are the headline and appointments demote to a down-funnel
//     widget. The ~90% of rooftops whose offering rarely books a daily appointment.
// Set explicitly per rooftop in the tracker (roi_rooftop_config.digest_focus); the explicit choice
// always wins. 'auto' (the default) resolves from the one console-aligned signal available across all
// send paths — APPOINTMENT CADENCE. (There is no clean per-rooftop STL/coverage feature flag upstream
// — verified in reporting-vini; STL/after-hours are per-event classifications, not enablement flags —
// so cadence is the honest auto signal.) Appointment-focus only for rooftops that actually book at a
// daily clip (≈2+/business-day, e.g. a busy service drive); the ~90% that rarely book get conversation.
// MTD-based, so it's STABLE day-to-day (never a daily flip on yesterday's count). Spans daily/weekly/monthly.
const FOCUS_APPT_PER_DAY = 2;           // appts/business-day above which 'auto' → appointment-focus
function pickFocus(cfg, m) {
  const f = cfg && cfg.digest_focus;
  if (f === "appointment" || f === "conversation") return f;   // explicit override wins
  const apptMTD = Number((m || {}).appointmentsYesterdayMTD) || 0;
  if (apptMTD / 22 >= FOCUS_APPT_PER_DAY) return "appointment"; // ~22 business days/month
  return "conversation";                                        // the safe 90% default (incl. unknown MTD)
}
// Render the right template. v1 shims inboundUniqueLeads back to its legacy value so
// the classic email stays byte-faithful to production.
// ctx (optional): { w, cfg } — see renderHtml.
function renderDigest(tpl, name, dept, dateLabel, ent, team, localDate, tz, m, campaigns, cadence, ctx) {
  let html, gateM = m;
  if (tpl === "v2") {
    html = renderHtml(name, dept, dateLabel, ent, team, localDate, tz, m, campaigns, cadence, ctx);
  } else {
    const m1 = Object.assign({}, m, { inboundUniqueLeads: (m.inboundUniqueLeadsLegacy != null ? m.inboundUniqueLeadsLegacy : m.inboundUniqueLeads) });
    gateM = m1;   // gate v1 on the SAME shimmed metrics it renders from, so the no-value
                  // marker can't disagree with the numbers actually shown in the email.
    // v1 classic has no built-in pixel slot — inject the open-tracking pixel before </body>.
    html = renderHtmlV1(name, dept, dateLabel, ent, team, localDate, tz, m1, campaigns, ctx)
      .replace("</body></html>", `${pixelImg(team, dept, localDate, cadence)}</body></html>`);
  }
  // Stamp the no-value marker for the v1 path too (the v2 renderer self-stamps);
  // sendMail refuses a marked email unless overridden. Idempotent.
  return emailValue.digestHasValue(gateM) ? html : emailValue.markNoValue(html);
}
// Apply the matching guardrail. v1 uses the original (stricter) send rule on the
// legacy-shimmed leads value; v2 uses the permissive "any activity" rule.
function guardrailFor(tpl, m) {
  if (tpl === "v2") return guardrail(m);
  const m1 = Object.assign({}, m, { inboundUniqueLeads: (m.inboundUniqueLeadsLegacy != null ? m.inboundUniqueLeadsLegacy : m.inboundUniqueLeads) });
  return guardrailV1(m1);
}

// ── Send queue: serialize mail sends with domain-reputation protection delays ──────────────────
// Rendering/metrics fetch happens in parallel (that's expensive), but the actual mail send
// goes through a single queue with delays between rooftops to avoid ISP filtering on bursts.
let _sendQueue = Promise.resolve();
let _lastSendAt = 0;
function enqueueSend(to, subject, html, opts) {
  const run = async () => {
    const now = Date.now();
    const elapsed = now - _lastSendAt;
    if (MAIL_SEND_DELAY_MS > 0 && _lastSendAt > 0 && elapsed < MAIL_SEND_DELAY_MS) {
      const wait = MAIL_SEND_DELAY_MS - elapsed;
      await new Promise(r => setTimeout(r, wait));
    }
    _lastSendAt = Date.now();
    return sendMailRaw(to, subject, html, opts);
  };
  // .then(run, run) — run whether or not the PREVIOUS send settled ok. This used to be a plain
  // .then(run) on a queue that keeps its rejection: once any rooftop's send failed, every later
  // .then skipped `run` altogether and re-threw the FIRST rooftop's error, so a single mail 4xx
  // silently killed every remaining digest in the pass without even attempting them.
  const result = _sendQueue.then(run, run);
  _sendQueue = result.catch(() => {});   // keep the chain settled; the caller still sees the real error
  return result;
}

async function sendMailRaw(to, subject, html, opts) {
  // Anti-churn gate: refuse to send a no-value digest (stamped by the renderer)
  // unless the caller passes { force: true } (a deliberate DANGER override). The
  // marker is stripped so a customer never sees it.
  const force = opts && opts.force === true;
  if (emailValue.isNoValue(html)) {
    if (!force) { const e = new Error("This email shows no value — blocked to avoid churn. Override with the password to send."); e.code = "BLOCKED_NO_VALUE"; throw e; }
  }
  // SAFETY LOCK: the redesigned (v2) digest may ONLY reach @spyne.ai while in testing. Even if a
  // rooftop is live with real recipients, a v2 email is filtered to its @spyne.ai addresses (none →
  // nothing sent). Lift deliberately with V2_TO_CUSTOMERS=true. Not overridable by the DANGER force.
  const lock = emailValue.lockV2Recipients(html, to);
  if (lock.locked) {
    if (!lock.allowed.length) { const e = new Error("New (v2) template is @spyne.ai-only in testing — no @spyne.ai recipient for this rooftop, nothing sent."); e.code = "V2_SPYNE_ONLY"; throw e; }
    if (lock.allowed.length !== to.length) console.log(`  🔒 v2 spyne-only lock → recipients restricted to ${lock.allowed.join(", ")}`);
    to = lock.allowed;
  }
  html = emailValue.stripMarker(html); // strip no-value + v2 markers off the wire
  // Last line of defence before the wire: drop any address the deliverability gate rejects. The
  // recipient filters upstream already do this, but manual/backfill callers hand us raw address
  // lists, and one malformed address in the comma-joined `to` fails the send for everyone on it.
  const bad = to.filter((e) => !emailHealth.isDeliverableAddress(e));
  if (bad.length) {
    to = to.filter((e) => emailHealth.isDeliverableAddress(e));
    console.warn(`  ⚠ dropped undeliverable address(es): ${bad.join(", ")}`);
    if (!to.length) { const e = new Error(`No deliverable address left (${bad.join(", ")})`); e.code = "NO_DELIVERABLE_RECIPIENT"; throw e; }
  }
  const post = (addrs) => fetch(MAIL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(MAIL_TOKEN ? { Authorization: `Bearer ${MAIL_TOKEN}` } : {}) },
    body: JSON.stringify({ to: addrs.join(","), subject, template: MAIL_TEMPLATE, templateData: { HTMLdata: html } }),
  });
  let lastErr = "", lastBody = "";
  // retry transient mail-gateway failures (5xx / 429) a couple times with backoff
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await post(to);
    if (res.ok) { const j = await res.json().catch(() => ({})); return j.messageId ?? j.id ?? null; }
    lastBody = await res.text().catch(() => "");
    lastErr = `mail ${res.status}: ${lastBody.slice(0, 120)}`;
    if (res.status < 500 && res.status !== 429) break; // non-transient (4xx) — don't retry
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  // The proxy rejected a RECIPIENT (not the template, not our auth). Suppress the offender so we
  // never mail it again, and — when it was a batch — deliver to everyone else rather than letting
  // one dead address silence the whole rooftop. See isolateAndSuppress.
  if (emailHealth.classifySendFailure(lastBody) === "hard") {
    const rescued = await emailHealth.isolateAndSuppress(sb, { to, errBody: lastBody, post });
    if (rescued.messageId) return rescued.messageId;
  }
  throw new Error(lastErr);
}

// Public sendMail routes through the send queue for domain reputation protection.
function sendMail(to, subject, html, opts) {
  return enqueueSend(to, subject, html, opts);
}

// Slack breakage alert — shared with eventRunner.cjs (transactional emails) so BOTH pipelines alert the
// same way. Tiered warn/crit thresholds live in slackAlert.cjs (DIGEST_ALERT_WARN / DIGEST_ALERT_CRIT).
const { postBreakageAlert, postSystemicAlert } = require("./slackAlert.cjs");

// ── Dead-man's-switch for the TRANSACTIONAL events pipeline ────────────────────
// The events cron (/api/cron/roi-events) can stop producing entirely — a degraded feed, a crashed
// pass, or Vercel simply not firing it — and when it does, NOTHING in that job is running to alert us
// (that's exactly how the transactional pipeline went dark for 13 days unnoticed). So we pigg-back a
// staleness heartbeat on THIS digest cron, which is proven to run reliably every hour: if no
// roi_event_emails row has been written in far too long, shout. Gated to a few UTC hours so an ongoing
// outage pings a handful of times/day (not hourly), and a threshold wide enough (default 12h) that a
// quiet overnight window never false-alarms. Best-effort; never affects the digest send.
const EVENT_STALE_HOURS = Number(process.env.EVENT_STALE_HOURS || 12);
const EVENT_HEARTBEAT_UTC_HOURS = (process.env.EVENT_HEARTBEAT_UTC_HOURS || "16,20,23")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
async function eventPipelineHeartbeat() {
  try {
    if (!EVENT_HEARTBEAT_UTC_HOURS.includes(new Date().getUTCHours())) return; // only check a few times/day
    const { data, error } = await sb.from("roi_event_emails")
      .select("created_at").order("created_at", { ascending: false }).limit(1);
    if (error) return; // can't read → don't guess
    const last = data && data[0] && data[0].created_at ? new Date(data[0].created_at) : null;
    const ageH = last ? (Date.now() - last.getTime()) / 3600000 : Infinity;
    if (ageH < EVENT_STALE_HOURS) return; // healthy
    const lastStr = last ? `${ageH.toFixed(1)}h ago (${last.toISOString()})` : "never";
    await postSystemicAlert({
      source: "Transactional email",
      title: "events pipeline STALE — no transactional email in " + (last ? `${ageH.toFixed(0)}h` : "a very long time"),
      detail: `Last roi_event_emails row: ${lastStr} (threshold ${EVENT_STALE_HOURS}h). The 15-min /api/cron/roi-events job is likely not firing, crashing, or its reporting-vini feed is down. Check the Vercel cron + reporting-vini feed auth/ClickHouse.`,
      windowLabel: "events-pipeline heartbeat (from the hourly digest cron)",
    });
  } catch (e) { console.warn("[roi-cron] heartbeat skipped:", String(e).slice(0, 140)); }
}

// ── Recipient-verification audit ───────────────────────────────────────────────
// The other half of the cross-rooftop guard: the send gate HOLDS enabled-but-unverified
// recipients (a newly-added address stays unverified until a human confirms it for that rooftop).
// This surfaces them so they don't sit silently un-emailed — a daily Slack digest of every recipient
// that is enabled + subscribed-capable but not yet verified, grouped by rooftop. WARNING (no @channel):
// it's a to-do, not an outage. Rides this reliable hourly cron; gated to one UTC hour so it's daily.
const RECIPIENT_AUDIT_UTC_HOUR = Number(process.env.RECIPIENT_AUDIT_UTC_HOUR || 15);
async function recipientVerificationAudit() {
  try {
    if (new Date().getUTCHours() !== RECIPIENT_AUDIT_UTC_HOUR) return;
    const { data, error } = await sb.from("roi_recipients")
      .select("team_id,email,email_enabled,sms_enabled,verified_at")
      .is("verified_at", null);
    if (error) return;
    const pending = (data || []).filter((r) => r.email_enabled || r.sms_enabled);
    if (!pending.length) return; // all clear
    const byTeam = new Map();
    for (const r of pending) { const a = byTeam.get(r.team_id) || []; a.push(r.email); byTeam.set(r.team_id, a); }
    const failures = [...byTeam.entries()].map(([team, emails]) => ({
      rooftop: team, dept: "recipients", error: `${emails.length} unverified & held: ${emails.slice(0, 8).join(", ")}${emails.length > 8 ? "…" : ""}`,
    }));
    await postBreakageAlert({
      source: "Recipient verification",
      failures,
      sentOk: null,
      windowLabel: "daily recipient audit — verify each recipient belongs to its rooftop before it can be emailed",
    });
  } catch (e) { console.warn("[roi-cron] recipient audit skipped:", String(e).slice(0, 140)); }
}

// ── Deliverability sweep ───────────────────────────────────────────────────────
// The bounce/rejection paths suppress an address the moment it fails. This is the other half:
// a daily pass over the whole recipient book that finds addresses which are undeliverable BY
// CONSTRUCTION — a typo'd @gmial.com, a @dealer.lan, a display name pasted into the email field —
// and puts them on hold before they ever produce their first bounce. Also folds in any bounce /
// complaint events the mail provider has reported (roi_engagement_events), which is where an
// asynchronous bounce lands once the provider webhook is wired to /api/email/bounce.
// Rides the reliable hourly digest cron, gated to one UTC hour so it runs once a day.
const DELIVERABILITY_AUDIT_UTC_HOUR = Number(process.env.DELIVERABILITY_AUDIT_UTC_HOUR || 15);
async function deliverabilityAudit() {
  try {
    if (new Date().getUTCHours() !== DELIVERABILITY_AUDIT_UTC_HOUR) return;
    const { data, error } = await selectRecipients(sb, "team_id,email,email_enabled,verified_at");
    if (error) return;
    const suppressed = [];
    for (const r of data || []) {
      if (!r.email_enabled || r.suppressed_at) continue;   // paused or already held → nothing to do
      const p = emailHealth.addressProblem(r.email);
      // 'placeholder' is a phone-only recipient — deliberate, not a bad address.
      if (!p || p.code === "placeholder") continue;
      const res = await emailHealth.suppressAddress(sb, { teamId: r.team_id, email: r.email, reason: p.label });
      if (res.count) suppressed.push({ team: r.team_id, email: r.email, why: p.label });
    }
    // Bounce / complaint events the provider has reported since the last sweep.
    const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    const { data: ev } = await sb.from("roi_engagement_events")
      .select("recipient_email,event_type,occurred_at").gte("occurred_at", since)
      .in("event_type", ["bounce", "complaint", "dropped"]);
    for (const e of ev || []) {
      if (!e.recipient_email) continue;
      const kind = e.event_type === "complaint" ? "complaint" : "hard";
      const res = await emailHealth.recordFailure(sb, { teamId: null, email: e.recipient_email, kind, detail: `${e.event_type} reported ${String(e.occurred_at).slice(0, 10)}` });
      if (res.suppressed) suppressed.push({ team: "—", email: e.recipient_email, why: res.reason || e.event_type });
    }
    if (!suppressed.length) return;
    console.log(`[roi-cron] deliverability sweep suppressed ${suppressed.length} address(es)`);
    await postBreakageAlert({
      source: "Email deliverability",
      failures: suppressed.slice(0, 20).map((s) => ({ rooftop: s.team, dept: "recipient", error: `${s.email} — ${s.why}` })),
      sentOk: null,
      windowLabel: `daily deliverability sweep — ${suppressed.length} address(es) put on hold so their bounces stop costing the sending domain. Fix the address in the tracker to restore it.`,
    });
  } catch (e) { console.warn("[roi-cron] deliverability sweep skipped:", String(e).slice(0, 140)); }
}

// ── Pass ordering + budget (shared by the daily and weekly/monthly passes) ─────────────────────
const isoDaysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
// Every department's current run row for one cadence, in ONE paged read: team|dept|local_date →
// { status, reason, message_id }. Never throws: without it the pass just keeps table order.
async function readRunIndex(cadence, sinceLocalDate) {
  const out = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("roi_digest_runs").select("team_id,department,local_date,status,reason,message_id")
      .eq("cadence", cadence).gte("local_date", sinceLocalDate).order("id", { ascending: true }).range(from, from + 999);
    if (error) { console.warn(`[roi-cron] ${cadence} run-status read failed, keeping table order:`, error.message); return out; }
    for (const r of data ?? []) out.set(`${r.team_id}|${r.department}|${r.local_date}`, { status: r.status, reason: r.reason ?? null, message_id: r.message_id ?? null });
    if (!data || data.length < 1000) return out;
  }
}
// Spend the hour on work that is still due. Walking roi_live_departments in table order meant the
// same head rows (re-checks of departments already decided) ate every hourly budget and the tail was
// never reached. Tiers: not visited yet for this period, or waiting on its send time → failed, retry →
// already decided (not_sent / dry-run suppressed), re-check → finished (exits on one read). Within a
// tier, departments that really email dealers (dry_run=false) first. Stable: table order breaks ties.
function prioritize(targets, index, localDateOf) {
  const tier = (L) => {
    const row = index.get(`${L.team_id}|${L.department}|${localDateOf(L)}`);
    const st = row && (typeof row === "string" ? row : row.status);
    const reason = row && typeof row === "object" ? row.reason : null;
    if (row && typeof row === "object" && row.message_id) return 3;  // claimed: finished, whatever its status
    if (!st || st === "scheduled" || st === "queued") return 0;
    if (st === "not_sent" && reason === "backfilled") return 0;      // history rebuilt by backfill, never emailed
    if (st === "suppressed" && L.dry_run === false) return 0;        // went live after it was held: real work now
    if (st === "error") return 1;
    if (st === "sent" || st === "sending") return 3;
    return 2;
  };
  return targets.map((L, i) => ({ L, i, t: tier(L), live: L.dry_run === false ? 0 : 1 }))
    .sort((a, b) => a.t - b.t || a.live - b.live || a.i - b.i).map((x) => x.L);
}
// Run `work` over `targets` on `pool` workers, launching nothing new once the pass budget has passed
// since `startedAt`. The first target is always launched, so a pass whose setup ate the budget still
// moves the fleet forward by its most-due rooftop. Returns the targets never launched.
async function runBudgetedPool(targets, pool, startedAt, work) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(pool, targets.length || 1)) }, async () => {
    while (i < targets.length && (i === 0 || Date.now() - startedAt <= DIGEST_PASS_BUDGET_MS)) await work(targets[i++]);
  }));
  return targets.slice(i);
}
async function reportUnreached(source, unreached, total, nameOf) {
  if (!unreached.length) return;
  const names = unreached.map((L) => `${nameOf(L)} [${L.department}]`);
  console.error(`  ⚠️  ${source} pass ran out of time: ${unreached.length} of ${total} rooftop-departments not reached: ${names.slice(0, 20).join(", ")}${names.length > 20 ? " …" : ""}`);
  try {
    await postSystemicAlert({
      source, title: `${source} pass INCOMPLETE: ${unreached.length} of ${total} rooftop-departments not reached`,
      detail: `The pass hit its ${Math.round(DIGEST_PASS_BUDGET_MS / 1000)}s budget before reaching: ${names.slice(0, 30).join(", ")}${names.length > 30 ? ` and ${names.length - 30} more` : ""}. The next hourly pass takes them first. If this repeats, /api/reports is too slow for the fleet.`,
      windowLabel: `${source} cron`,
    });
  } catch (e) { console.warn("[roi-cron] unreached alert skipped:", String(e).slice(0, 140)); }
}

// ── Pass trail (roi_cron_runs) ───────────────────────────────────────────────────────────────────
// One row per digest pass, so a pass that ran (or crashed) leaves a record the health checks can read.
// A pass Vercel kills at 300s writes nothing; its ABSENCE is the signal. Never throws.
async function writeCronTrail(source, ok, summary) {
  try {
    const { error } = await sb.from("roi_cron_runs").insert({ source, ok, summary });
    if (error) console.warn(`[roi-cron] ${source} trail write failed:`, String(error.message || error).slice(0, 140));
  } catch (e) { console.warn(`[roi-cron] ${source} trail write failed:`, String(e).slice(0, 140)); }
}
async function withPassTrail(source, opts, fn) {
  const startedAt = new Date();
  const trail = !(opts && opts.cli === true); // a CLI run is an operator's, not the scheduled cron's
  try {
    const out = await fn();
    if (trail) await writeCronTrail(source, true, { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt.getTime(), ...out });
    return out;
  } catch (e) {
    if (trail) await writeCronTrail(source, false, { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt.getTime(), error: String(e && e.message ? e.message : e).slice(0, 300) });
    throw e;
  }
}

// ── Orphan reaper (start of every daily pass) ───────────────────────────────────────────────────
// A pass killed mid-flight leaves rows that no later pass will ever finish: 'queued'/'scheduled' for a
// report day that is over, and 'sending' rows whose claim was taken but whose send outcome was never
// written (2 sending + 3 queued + 13 scheduled in the week to 2026-10-08). They read as "in flight"
// forever. The claim time is stamped into reason_detail when a claim is taken, so a hung 'sending' row
// is recognisable after SENDING_STALE_MS. A reaped 'sending' row KEEPS its claim (message_id): the
// email may have gone out, so it is never resent automatically.
const SENDING_STALE_MS = 2 * 3600 * 1000;
const CLAIM_STAMP_RE = /claimed (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/;
const claimDetail = () => `claimed ${new Date().toISOString()}`;
async function reapOrphans(cutoff) {
  const out = { queued: 0, scheduled: 0, sending: 0 };
  if (!cutoff) return out;
  try {
    const { data: stuck, error } = await readAll("roi_digest_runs", "id,status,local_date",
      { filter: (q) => q.eq("cadence", "daily").in("status", ["queued", "scheduled"]).lt("local_date", cutoff).is("message_id", null), order: ["id"] });
    if (error) throw new Error(error.message);
    for (const st of ["queued", "scheduled"]) {
      const ids = (stuck || []).filter((r) => r.status === st).map((r) => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await sb.from("roi_digest_runs")
          .update({ status: "not_sent", reason: "pass_killed", reason_detail: `left '${st}' by a digest pass that never finished; the report day is over, so it was not sent` })
          .in("id", ids.slice(i, i + 200)).eq("status", st).is("message_id", null).select("id");
        out[st] += (data || []).length;
      }
    }
    const { data: sending, error: sErr } = await readAll("roi_digest_runs", "id,cadence,local_date,reason_detail",
      { filter: (q) => q.eq("status", "sending"), order: ["id"] });
    if (sErr) throw new Error(sErr.message);
    const now = Date.now();
    const dead = (sending || []).filter((r) => {
      const hit = CLAIM_STAMP_RE.exec(r.reason_detail || "");
      if (hit) return now - Date.parse(hit[1]) > SENDING_STALE_MS;
      return r.cadence === "daily" && r.local_date < cutoff; // claimed before claims were stamped: once its day is over
    }).map((r) => r.id);
    for (let i = 0; i < dead.length; i += 200) {
      const { data } = await sb.from("roi_digest_runs")
        .update({ status: "error", reason: "pass_killed", reason_detail: "claimed for sending by a pass that never finished; delivery unknown, so it is not resent automatically. Check the mail log before sending it by hand." })
        .in("id", dead.slice(i, i + 200)).eq("status", "sending").select("id");
      out.sending += (data || []).length;
    }
    if (out.queued + out.scheduled + out.sending) console.warn(`[roi-cron] reaped orphaned digest rows: ${JSON.stringify(out)} (cutoff local_date < ${cutoff})`);
  } catch (e) { console.warn("[roi-cron] orphan reaper skipped:", String(e && e.message ? e.message : e).slice(0, 140)); }
  return out;
}

// ── Timezone drift check (warning only) ─────────────────────────────────────────────────────────
// The digest computes "yesterday" and the send hour in roi_rooftop_config.timezone (a manual override)
// while reporting-vini buckets the numbers by the team's own setting. Where the two differ in UTC offset
// the email's day and the data's day can split (Landers: Costa_Rica vs Chicago). No behaviour change:
// logged and carried in the pass summary for a human to fix.
function utcOffsetMin(tz, at) {
  at = at || new Date();
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at);
  const g = (t) => +p.find((x) => x.type === t).value;
  return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute")) - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}
// Checked at most every TZ_DRIFT_EVERY_MS per warm instance: the answer changes only when someone edits a
// zone, and an hourly ClickHouse read + warning burst for the same few rooftops is noise.
const TZ_DRIFT_EVERY_MS = 6 * 3600 * 1000;
let _tzDrift = { at: 0, out: [] };
async function timezoneDrift(targets, cfgOf) {
  const teams = [...new Set(targets.map((L) => L.team_id))].filter((t) => isValidTz(cfgOf.get(t)?.timezone));
  if (!teams.length) return [];
  if (Date.now() - _tzDrift.at < TZ_DRIFT_EVERY_MS) return _tzDrift.out;
  let det;
  try { det = await fetchTeamDetailsCH(teams); } catch { return []; }
  const out = [];
  for (const t of teams) {
    const cfgTz = cfgOf.get(t).timezone, teamTz = det.get(t)?.timezone;
    if (!teamTz || teamTz === cfgTz || !isValidTz(teamTz)) continue;
    if (utcOffsetMin(teamTz) !== utcOffsetMin(cfgTz)) out.push({ team: t, name: cfgOf.get(t)?.rooftop_name || cfgOf.get(t)?.team_name || "", config: cfgTz, teamSetting: teamTz });
  }
  if (out.length) console.warn(`[roi-cron] ${out.length} rooftop(s) have a config timezone on a different UTC offset than the team setting the numbers are bucketed by: ${out.slice(0, 10).map((x) => `${x.name || x.team} (${x.config} vs ${x.teamSetting})`).join(", ")}`);
  if (det.size) _tzDrift = { at: Date.now(), out: out.slice(0, 25) };
  return out.slice(0, 25);
}

// Operator knobs (FORCE_RESEND, IGNORE_SEND_HOUR, IGNORE_SEND_DAY, ONLY_TEAMS, RUN_LOCAL_DATE) are read
// ONLY when a CLI entry passes { cli: true }. The scheduled cron ignores them, so a stray value left in
// the deployment can't cause hourly re-sends, midnight sends or a silently partial fleet.
// Hours after the dealer's send time during which a digest may still go out (read per call so tests and
// ops can change it). Past it, nothing is sent: see the SEND WINDOW note in runOnce.
function sendWindowMinutes() {
  const h = Number(process.env.DIGEST_SEND_WINDOW_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 4) * 60;
}
function pastSendWindow(w, sendHour, sendMinute) {
  const since = (w.localHour * 60 + (w.localMinute ?? 0)) - (sendHour * 60 + sendMinute);
  return since > sendWindowMinutes();
}
const OPERATOR_KNOBS = ["FORCE_RESEND", "IGNORE_SEND_HOUR", "IGNORE_SEND_DAY", "ONLY_TEAMS", "RUN_LOCAL_DATE"];
function operatorKnobs(opts) {
  const cli = !!(opts && opts.cli === true);
  const get = (k) => (cli ? process.env[k] : undefined);
  const ignored = cli ? [] : OPERATOR_KNOBS.filter((k) => process.env[k]);
  if (ignored.length) console.warn(`[roi-cron] ignoring operator knob(s) ${ignored.join(", ")} on the scheduled pass (honoured only by the CLI: node server/roi-cron/runner.cjs)`);
  return {
    cli, ignored,
    ONLY: (get("ONLY_TEAMS") || "").split(",").map((s) => s.trim()).filter(Boolean),
    IGNORE_HOUR: get("IGNORE_SEND_HOUR") === "true",
    IGNORE_DAY: get("IGNORE_SEND_DAY") === "true",
    RUN_LOCAL_DATE: get("RUN_LOCAL_DATE") || null,
    FORCE_RESEND: get("FORCE_RESEND") === "true",
  };
}
// Enrichment for the email body: the appointment lists (from the SAME /api/reports response the KPI
// numbers came from), top vehicles and the warm-lead list. Degrades to empty sections, never throws.
async function enrichFor({ teamId, entId, dept, tz, w, report, cadence }) {
  const dollarRate = digestDollarRate(dept);
  let enr = { appointments: [], assistedAppointments: [], topVehicles: [], topVehiclesDays: null, warmLeads: [] };
  try {
    const { enrichRooftop } = await import("./digestEnrich.js");
    enr = await enrichRooftop(teamId, {
      dollarRate, dept, enterpriseId: entId, tz, start: w.apiStart, end: w.apiEnd, report,
      topVehiclesDays: cadence === "weekly" ? 7 : 30,
      apiBase: REPORTING_API_BASE, token: process.env.DIGEST_SPYNE_TOKEN || process.env.SPYNE_API_TOKEN || undefined,
    });
  } catch (e) { console.warn("[roi-cron] enrich skipped:", String(e).slice(0, 120)); }
  return { dollarRate, enr };
}
const enrichedFields = (enr) => ({
  appointments: enr.appointments || [], assistedAppointmentList: enr.assistedAppointments || [],
  topVehicles: enr.topVehicles || [], topVehiclesDays: enr.topVehiclesDays || null, warmLeads: enr.warmLeads || [],
});
// The SMS renderer (transactionalTemplates.renderDigestSms) reads a few legacy fields under rooftop labels:
// "Qualified leads" ← qualifiedLeads (inbound only), "Hand-offs to team" ← warmTransfers (inbound transfers
// only), "Open action items" ← actionItemsTotal (a CREATED count). Hand it the rooftop figures the email
// headlines instead, so the text and the email say the same thing.
function smsView(m) {
  const v = Object.assign({}, m);
  if (m.warmCount != null) { v.qualifiedLeads = m.warmCount; v.qualifiedPct = null; }
  if (m.handoffTransfers != null || m.handoffCallbacks != null) v.warmTransfers = N(m.handoffTransfers) + N(m.handoffCallbacks);
  if (!m.actionItemStatsDegraded && m.actionItemsOpen != null) v.actionItemsTotal = m.actionItemsOpen;
  return v;
}
// Digest SMS, sent only AFTER the email itself went out: a held email (no-value, guardrail, dry-run,
// v2 lock) used to still text its headline. Never throws.
async function smsAfterSend({ L, c, recOf, cadence, w, tz, name, m, smsFailures }) {
  const smsRecips = subscribedSmsRecips(recOf.get(L.team_id), L.department, cadence, c && c.sms_enabled);
  if (!smsRecips.length || SMS_DRY_RUN || L.dry_run === true) return;
  const reportLink = links(L.enterprise_id, L.team_id, L.department, w, tz, cadence).reports;
  const smsRes = await sendDigestSms(sb, { team_id: L.team_id, enterprise_id: L.enterprise_id, department: L.department }, cadence, w.localDate, smsRecips, T.renderDigestSms({ cadence, rooftopName: name, dept: L.department, metrics: smsView(m), link: reportLink }));
  if (smsRes && smsRes.error) smsFailures.push({ rooftop: name, dept: L.department, error: smsRes.error });
}
// Map a thrown send error to the row it leaves: deliberate holds are not_sent, anything else is a failure.
const HOLD_REASON = { BLOCKED_NO_VALUE: "no_value", V2_SPYNE_ONLY: "v2_spyne_only", NO_DELIVERABLE_RECIPIENT: "recipients_missing" };
// Rows a pass re-evaluates (fetches again) before the send time, because they were held for a reason
// unrelated to the numbers that a human may have fixed since.
const REEVALUATE_REASONS = ["recipients_missing", "unsubscribed", "churned", "aggregate_stale", "disabled", "backfilled"];

async function runOnce(opts = {}) {
  return withPassTrail("roi-email-daily", opts, () => runDailyPass(opts));
}
async function runDailyPass(opts) {
  const passStart = Date.now();
  resetApiCache();
  const ts = new Date().toISOString();
  console.log(`\n── ROI cron pass @ ${ts} · DRY_RUN=${DRY_RUN} ──`);
  // FAIL LOUD: a misconfigured serverless function (missing ROI_SUPABASE_*) used to
  // silently return an all-zero summary because the Supabase error was swallowed. Surface it.
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY (set them as server env vars on Vercel — NOT VITE_-prefixed).");
  const { live, cfgOf, recOf } = await loadFleet("team_id,enterprise_id,rooftop_name,team_name,timezone,digest_send_hour,digest_send_minute,daily_enabled,daily_template,digest_focus,sms_enabled,lifecycle_status,churn_date");
  if (!live.length) console.warn("[roi-cron] WARNING: roi_live_departments.is_live=true returned 0 rows — nothing to process (check data / env).");
  const knobs = operatorKnobs(opts);
  const out = { targets: 0, sent: 0, queued: 0, suppressed: 0, no_data: 0, before_hour: 0, no_recipients: 0, unsubscribed: 0, already_sent: 0, errors: 0, stale_held: 0, churned: 0, disabled: 0, unreached: 0, reaped: null, tzMismatches: [], ignoredEnv: knobs.ignored };
  const failures = []; // genuine send failures this pass → the Slack breakage alert (postSlackAlert)
  const smsFailures = []; // genuine digest-SMS send failures this pass → shared Slack breakage alert (SMS)
  const staleHeld = []; // rooftops held this pass because the aggregate hadn't reached the report day
  // Probe the aggregate's freshness ONCE for the whole pass (not per rooftop). If the sync is stalled,
  // agent_daily is frozen and every rooftop would read stale zeros — we hold them all rather than email
  // frozen snapshots (see probeAggregateFreshness). One fetch, shared by every processOne below.
  const freshness = await probeAggregateFreshness();
  if (freshness.known) console.log(`  aggregate freshness: newest day = ${freshness.maxActivityDay} (last sync ${freshness.lastRunAt || "?"})`);
  const { ONLY, IGNORE_HOUR, RUN_LOCAL_DATE, FORCE_RESEND } = knobs;
  const scoped = live.filter((L) => !ONLY.length || ONLY.includes(L.team_id));
  if (ONLY.length) console.log(`  scope: ONLY_TEAMS → ${scoped.length} dept-rows across ${ONLY.length} team(s)`);
  // Orphans first, against a FLEET-wide cutoff (never a scoped subset's): the earliest dealer-local
  // "yesterday" anywhere, with Hawaii always counted so an unresolved zone can't move it later.
  // The reaper only touches rows of report days that are over, so it runs alongside the reads that order
  // today's work. Team timezones for every rooftop without one in config come in ONE ClickHouse read, so
  // resolveTz below reads memory instead of calling out once per rooftop.
  const cutoff = [...new Set(["Pacific/Honolulu", ...live.map((L) => cfgOf.get(L.team_id)?.timezone).filter(isValidTz)])].map(safeLocalDate).sort()[0];
  const [reaped, , tzMismatches, index] = await Promise.all([
    reapOrphans(cutoff),
    primeTeamDetails(scoped.filter((L) => !cfgOf.get(L.team_id)?.timezone).map((L) => L.team_id)),
    timezoneDrift(scoped, cfgOf),
    readRunIndex("daily", isoDaysAgo(3)),
  ]);
  out.reaped = reaped;
  out.tzMismatches = tzMismatches;
  const targets = prioritize(scoped, index, (L) => RUN_LOCAL_DATE || safeLocalDate(cfgOf.get(L.team_id)?.timezone));
  out.targets = targets.length;

  // Process ONE rooftop·dept. Independent per row → safe to run many in parallel.
  const processOne = async (L) => {
    const c = cfgOf.get(L.team_id);
    const name = c?.rooftop_name || c?.team_name || "";
    let tz = null, w = null, base = null;
    // FAIL LOUD on write failure. The 'queued' upsert runs BEFORE the send, so if the DB write
    // is blocked (e.g. ROI_SUPABASE_SERVICE_KEY is the anon key → RLS denies the insert), this
    // throws and we NEVER send — preventing the silent "no row written → re-send every hour" loop.
    const upsert = async (extra) => {
      const { data, error } = await sb
        .from("roi_digest_runs")
        .upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" })
        .select("id");
      if (error) throw new Error(`roi_digest_runs write failed — is ROI_SUPABASE_SERVICE_KEY the service_role key (not anon)? ${error.message}`);
      if (!data || data.length === 0) throw new Error("roi_digest_runs write affected 0 rows (RLS blocked — service_role key required)");
    };
    try {
      // Zone + window INSIDE the try: one malformed timezone fails this row (an error row the tracker
      // shows), not the whole pass, which used to reject Promise.all and stop every rooftop.
      tz = await resolveTz(sb, L.team_id, c?.timezone, name);
      assertValidTz(tz);
      w = RUN_LOCAL_DATE
        ? { ...windowsForDate(RUN_LOCAL_DATE, tz), localHour: localParts(tz).localHour, localMinute: localParts(tz).localMinute }
        : localParts(tz);
      base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence: "daily", local_date: w.localDate, dealer_timezone: tz, trigger: "cron" };
      // PAUSED (daily_enabled=false): one cheap not_sent/disabled row per report day, no numbers fetched,
      // so a paused rooftop is visible in the tracker instead of an empty cell.
      if (c && c.daily_enabled === false) {
        const row = index.get(`${L.team_id}|${L.department}|${w.localDate}`);
        out.disabled++;
        if (row && (row.message_id || row.status === "sent" || row.status === "sending" || (row.status === "not_sent" && row.reason === "disabled"))) return;
        await upsert({ status: "not_sent", reason: "disabled", reason_detail: "daily digest switched off for this rooftop (daily_enabled=false)" });
        console.log(`  · ${name} [${L.department}] not_sent → disabled (daily digest switched off)`);
        return;
      }
      // already sent (or claimed by a sender) for this day? A claimed row (message_id set) is finished
      // whatever its status: a send that failed after its claim stays a red "Failed" in the tracker
      // instead of being flipped back to 'queued' by this pass and then skipped at the claim.
      const { data: prior } = await sb.from("roi_digest_runs").select("id,status,reason,message_id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", w.localDate).maybeSingle();
      if (prior && (prior.status === "sent" || prior.status === "sending" || prior.message_id) && !FORCE_RESEND) { out.already_sent++; console.log(`  · ${name} [${L.department}] skipped → already ${prior.status}${prior.message_id && prior.status !== "sent" ? " (claimed)" : ""} for ${w.localDate}`); return; }
      // ── CHURN GATE ───────────────────────────────────────────────────────────────────────────────
      // Stage never gates a send (onboarding/contracting rooftops are often live for the dealer) —
      // churn is the sole exception. Deliberately AFTER the already-sent check so it can never
      // overwrite a genuine 'sent' audit row with a suppression on the day a rooftop churns.
      // FORCE_RESEND does NOT bypass this: un-churn the rooftop if a send is really intended.
      if (isChurned(c, w.localDate)) {
        await upsert({ status: "not_sent", reason: "churned", reason_detail: `lifecycle=${c?.lifecycle_status ?? "?"} churn_date=${c?.churn_date ? String(c.churn_date).slice(0, 10) : "none"}` });
        out.churned++;
        console.log(`  · ${name} [${L.department}] not_sent → churned (lifecycle=${c?.lifecycle_status ?? "?"})`);
        return;
      }
      // recipients (step 1 finalized) for this dept — email filtered by the subscription matrix.
      const emails = subscribedEmails(recOf.get(L.team_id), L.department, "daily");
      if (!emails.length) {
        const unsub = eligibleButUnsubscribed(recOf.get(L.team_id), L.department);
        await upsert({ status: "not_sent", reason: unsub ? "unsubscribed" : "recipients_missing", reason_detail: unsub ? "verified recipients exist but none is subscribed to the daily digest" : null });
        if (unsub) out.unsubscribed++; else out.no_recipients++;
        console.log(`  · ${name} [${L.department}] not_sent → ${unsub ? "unsubscribed (verified recipients, none subscribed to daily)" : "recipients_missing (no enabled recipient for this dept)"}`);
        return;
      }
      // ── BEFORE THE SEND TIME, EVALUATE ONCE ──────────────────────────────────────────────────────
      // The first visit for a report day fetches and stores the numbers (the tracker previews them);
      // later pre-send visits don't re-fetch, because the send-time visit reads everything again
      // anyway. Re-fetching every hour from local midnight was ~7 visits per department per day, each
      // up to 5 reporting-api calls, and that is what ran the hourly pass past 300s. A row held for a
      // reason unrelated to the numbers is re-evaluated, so the tracker catches up once it's fixed.
      const sendHour = c?.digest_send_hour ?? 7;
      const sendMinute = c?.digest_send_minute ?? 0;
      const beforeSendTime = w.localHour < sendHour || (w.localHour === sendHour && (w.localMinute ?? 0) < sendMinute);
      // ── SEND WINDOW ──────────────────────────────────────────────────────────────────────────────
      // A digest goes out only within DIGEST_SEND_WINDOW_HOURS (default 4) of the dealer's send time.
      // Past it, the day is recorded as missed instead of landing hours late; otherwise the first pass
      // after a fix (or any recovery) mails every department that missed the morning in one evening burst.
      // A failed row keeps its error (already visible); only an unfinished/empty row is marked.
      if (!IGNORE_HOUR && pastSendWindow(w, sendHour, sendMinute)) {
        if (!prior || ((prior.status === "scheduled" || prior.status === "queued") && !prior.message_id)) {
          await upsert({ status: "not_sent", reason: "send_window_passed", reason_detail: `not sent within ${sendWindowMinutes() / 60}h of the ${String(sendHour).padStart(2, "0")}:${String(sendMinute).padStart(2, "0")} send time; never sent late` });
        }
        out.window_passed = (out.window_passed || 0) + 1;
        return;
      }
      if (!IGNORE_HOUR && beforeSendTime && prior && !(prior.status === "not_sent" && REEVALUATE_REASONS.includes(prior.reason))) {
        out.before_hour++;
        console.log(`  · ${name} [${L.department}] ${prior.status} → evaluated earlier today, waiting for send ${String(sendHour).padStart(2, "0")}:${String(sendMinute).padStart(2, "0")}`);
        return;
      }
      // ── AGGREGATE FRESHNESS HARD-GATE ────────────────────────────────────────────────────────────
      // Before we read /api/reports: if the sync hasn't reached the day we're reporting, agent_daily is
      // frozen and would hand us stale ZEROS with degraded:false (indistinguishable from a quiet day —
      // the Sport Durst incident). Refuse to email a frozen snapshot: HOLD (not_sent/aggregate_stale) and
      // let the pass raise ONE systemic alert. Sends resume automatically next pass once the sync catches
      // up (the held row is re-evaluated). Fail-open: if freshness is unknown, we proceed as before.
      if (aggregateStaleForDate(freshness, w.localDate)) {
        await upsert({ status: "not_sent", reason: "aggregate_stale", reason_detail: `agg newest day ${freshness.maxActivityDay} < report ${w.localDate}` });
        out.stale_held++; staleHeld.push(name);
        console.log(`  · ${name} [${L.department}] HELD → aggregate_stale (agg max=${freshness.maxActivityDay} < report ${w.localDate}) — not emailing frozen zeros`);
        return;
      }
      // step 2 — fetch (day window + MTD window + action items), store queued
      const { m, ai, report } = await buildDigestMetrics({ teamId: L.team_id, entId: L.enterprise_id, dept: L.department, w });
      const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate };
      const subject = `${L.department === "service" ? "Service" : "Sales"} Daily Digest — ${name}`;
      await upsert({ status: "queued", reason: null, reason_detail: null, metrics, subject, recipients: emails.map((e) => ({ email: e, received: false })) });
      out.queued++;
      // daily-template selection (redesign v2 / classic v1) — per rooftop, default v2
      const tpl = pickTemplate(c, "daily");
      // step 3 — guardrails (v1 keeps the original stricter send rule)
      const g = guardrailFor(tpl, m);
      if (!g.ok) { await upsert({ status: "not_sent", reason: g.reason, metrics, subject }); out.no_data++; console.log(`  · ${name} [${L.department}] not_sent → ${g.reason} (appts ${m.appointmentsYesterday} · conv ${m.conversationsHandled} · leads ${m.inboundUniqueLeads} · actions ${m.actionItemsTotal})`); return; }
      // step 4 — send-hour gate (sendHour / beforeSendTime computed above)
      if (!IGNORE_HOUR && beforeSendTime) { await upsert({ status: "scheduled", reason: "before_send_hour", metrics, subject }); out.before_hour++; console.log(`  · ${name} [${L.department}] scheduled → before_send_hour (local ${tz} ${String(w.localHour).padStart(2, "0")}:${String(w.localMinute ?? 0).padStart(2, "0")} < send ${String(sendHour).padStart(2, "0")}:${String(sendMinute).padStart(2, "0")})`); return; }
      // active campaigns — only now, just before render
      const camps = await getCampaigns(L.team_id, L.department, w, L.enterprise_id);
      // Enrichment: the appointment lists + top vehicles + warm leads, from the same Reporting service
      // (and, for the lists, the same response) as every number above. Degrades to empty sections.
      const { dollarRate, enr } = await enrichFor({ teamId: L.team_id, entId: L.enterprise_id, dept: L.department, tz, w, report, cadence: "daily" });
      // canonical stored payload — carries everything the template reads so a later
      // re-render (and the SPA preview) reproduce the exact email.
      const metricsFull = { ...metrics, campaigns: camps, ...enrichedFields(enr), dollarRate, daily_template: tpl, digest_focus: pickFocus(c, m) };
      const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, w.localDate, tz, metricsFull, camps, "daily", { w, cfg: c });
      const dry = DRY_RUN || L.dry_run === true;
      if (dry) { await upsert({ status: "suppressed", reason: "dry_run", metrics: metricsFull, subject, rendered_html: html }); out.suppressed++; console.log(`  · ${name} [${L.department}] suppressed (dry-run)`); return; }
      // ── ATOMIC SEND-CLAIM (idempotency: at-most-once per customer · dept · cadence · day) ──────────
      // The "already sent?" read above is a cheap early-out but races. This conditional UPDATE is the real
      // guarantee: it flips message_id from NULL → a per-row lock id in ONE atomic Postgres op, so exactly
      // one racer wins — even if the hourly cron overlaps itself OR the cron4-send edge backstop runs at
      // the same time. Lost the claim (0 rows) → someone else already owns this send → skip, never double.
      // On a send FAILURE the lock is deliberately KEPT (no same-day auto-retry) so we never double-send an
      // email that may have gone out; the failure surfaces as "Failed" + a Slack alert for manual retry.
      // The claim time rides in reason_detail so the orphan reaper can tell a hung claim from a live one.
      const sentAt = new Date().toISOString();
      const lockId = `cron-${L.team_id}-${L.department}-daily-${w.localDate}`;
      if (!FORCE_RESEND) {
        const { data: claim, error: claimErr } = await sb.from("roi_digest_runs")
          .update({ status: "sending", message_id: lockId, reason_detail: claimDetail() })
          .eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", w.localDate)
          .is("message_id", null)
          .select("id");
        if (claimErr) throw new Error(`send-claim failed: ${claimErr.message}`);
        if (!claim || !claim.length) { out.already_sent++; console.log(`  · ${name} [${L.department}] skipped → already sent/claimed for ${w.localDate}`); return; }
      }
      // SEND (we own the claim; message_id is now non-null so no other sender will re-send this row)
      const messageId = await sendMailAttributed(emails, subject, html);
      const finalId = messageId || lockId;
      await upsert({ status: "sent", reason: null, reason_detail: null, metrics: metricsFull, subject, rendered_html: html, send_path: "raw_html", sent_at: sentAt, message_id: finalId, recipients: emails.map((e) => ({ email: e, received: true })) });
      out.sent++;
      console.log(`  ✓ SENT ${name} [${L.department}] → ${emails.join(", ")}`);
      // Digest SMS — only now that the email really went out.
      await smsAfterSend({ L, c, recOf, cadence: "daily", w, tz, name, m, smsFailures });
    } catch (e) {
      out.errors++;
      const code = e && e.code;
      // Deliberate business holds (no-value gate / v2 spyne-lock) are NOT failures — record as not_sent.
      // Anything else is a genuine send failure → status="error" so the tracker shows a red "Failed" and
      // it feeds the Slack breakage alert below.
      // NO_DELIVERABLE_RECIPIENT is a hold too — the deliverability gate left nobody to mail. It is
      // a backstop (subscribedEmails already filters, so the pass normally exits at
      // recipients_missing first), but if it ever trips it must not page anyone as a send failure.
      const isHold = !!HOLD_REASON[code];
      const detail = String(e && e.message ? e.message : e).slice(0, 400);
      console.log(`  ✗ ${name} [${L.department}] ${isHold ? "held" : "FAILED"}: ${detail.slice(0, 160)}`);
      // The zone/window itself failed: key the error row on the Eastern report date so it still shows.
      if (!base) base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence: "daily", local_date: RUN_LOCAL_DATE || safeLocalDate(null), dealer_timezone: String(tz || c?.timezone || "") || null, trigger: "cron" };
      try {
        await upsert(isHold
          ? { status: "not_sent", reason: HOLD_REASON[code], reason_detail: detail }
          : { status: "error", reason: "error", reason_detail: detail });
      } catch { /* swallow — one failure must not halt the pass */ }
      if (!isHold) failures.push({ rooftop: name, dept: L.department, error: detail.slice(0, 200) });
    }
  };
  // Concurrency pool, stopped at the pass budget so the end-of-pass work below always runs.
  const POOL = Number(process.env.CRON_POOL || 10);
  const unreached = await runBudgetedPool(targets, POOL, passStart, processOne);
  out.unreached = unreached.length;
  console.log("  summary:", JSON.stringify(out));
  await reportUnreached("Daily digest", unreached, targets.length, (L) => cfgOf.get(L.team_id)?.rooftop_name || cfgOf.get(L.team_id)?.team_name || L.team_id);
  // Systemic alert (ONCE) when the aggregate was stale enough to hold sends. Distinct from send failures:
  // nothing broke in the digest — the UPSTREAM sync is behind, so we deliberately withheld frozen zeros.
  // The sync-health watchdog also pages, but this fires at the exact moment a customer would have gotten
  // stale numbers, and names the affected rooftops. Best-effort; never throws.
  if (staleHeld.length) {
    try {
      await postSystemicAlert({
        source: "Daily digest",
        title: `${staleHeld.length} digest(s) HELD — reporting aggregate is stale`,
        detail: `agent_daily's newest day (${freshness.maxActivityDay}) is behind the report date, so the digest would have emailed frozen zeros. Held instead — sends resume automatically once the sync catches up. Rooftops: ${staleHeld.slice(0, 12).join(", ")}${staleHeld.length > 12 ? ` +${staleHeld.length - 12} more` : ""}.`,
        windowLabel: "daily digest cron",
      });
    } catch (e) { console.warn("[roi-cron] stale-hold alert skipped:", String(e).slice(0, 140)); }
  }
  // Breakage alert → Slack when any digest genuinely failed to send this pass. Best-effort; never throws.
  await postBreakageAlert({ source: "Daily digest", failures, sentOk: out.sent, windowLabel: "daily digest send pass" })
    .catch((e) => console.warn("[roi-cron] slack alert skipped:", String(e).slice(0, 140)));
  // Same tiered warn/crit alert for the daily digest SMS channel.
  await postBreakageAlert({ source: "Digest SMS", failures: smsFailures, sentOk: null, windowLabel: "daily digest send pass" })
    .catch((e) => console.warn("[roi-cron] digest sms slack alert skipped:", String(e).slice(0, 140)));
  // Dead-man's-switch: ride this reliable hourly cron to catch a silently-dead events pipeline.
  await eventPipelineHeartbeat();
  // Daily audit: surface any enabled recipient still awaiting rooftop verification (held by the gate).
  await recipientVerificationAudit();
  // Daily sweep: hold any address that can never be delivered to, before it bounces on our domain.
  await deliverabilityAudit();
  return out;
}

// ── BACKFILL (record-only, NO emails) — one pass over a date range, all team·dept ──
function windowsForDate(localDate, tz) {
  const [y, m, d] = localDate.split("-").map(Number);
  const yStart = localToUTC(y, m, d, tz);
  const yEnd = new Date(localToUTC(y, m, d + 1, tz).getTime() - 1000);
  const monthStart = localToUTC(y, m, 1, tz);
  const dateLabel = dateLabelFor(y, m, d);
  const apiEnd = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { localDate, dateLabel, yStart: fmtUTC(yStart), yEnd: fmtUTC(yEnd), monthStart: fmtUTC(monthStart),
    apiStart: localDate, apiEnd, apiMonthStart: `${y}-${String(m).padStart(2, "0")}-01` };
}
function dateRange(start, end) {
  const out = []; const d = new Date(`${start}T00:00:00Z`); const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
async function backfill(start, end) {
  console.log(`\n── BACKFILL ${start}…${end} (record-only, NO emails) ──`);
  const { live, cfgOf, recOf } = await loadFleet("team_id,enterprise_id,rooftop_name,team_name,timezone,digest_send_hour,digest_send_minute,daily_enabled,daily_template,digest_focus,lifecycle_status,churn_date");
  const days = dateRange(start, end);
  const out = { backfilled: 0, not_sent: 0, preserved: 0, errors: 0 };
  const POOL = 8;
  // NO churn gate here on purpose: backfill is record-only (it synthesizes roi_digest_runs history
  // and never calls sendMail), so gating it would only erase a churned rooftop's historical rows
  // without preventing any email. The gate belongs on the paths that actually send.
  const tasks = live.filter((L) => (cfgOf.get(L.team_id)?.daily_enabled) !== false);

  async function worker(L) {
    const c = cfgOf.get(L.team_id);
    const name = c?.rooftop_name || c?.team_name || "";
    const tz = await resolveTz(sb, L.team_id, c?.timezone, name);
    if (!isValidTz(tz)) { out.errors += days.length; console.log(`  ✗ ${name} [${L.department}] invalid timezone "${tz}", skipped`); return; }
    const emails = subscribedEmails(recOf.get(L.team_id), L.department, "daily");
    for (const day of days) {
      const w = windowsForDate(day, tz);
      const base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence: "daily", local_date: day, dealer_timezone: tz, trigger: "backfill" };
      try {
        const { m, ai } = await buildDigestMetrics({ teamId: L.team_id, entId: L.enterprise_id, dept: L.department, w });
        const camps = await getCampaigns(L.team_id, L.department, w, L.enterprise_id);
        const tpl = pickTemplate(c, "daily");
        const metrics = { ...m, actionItems: ai.items, campaigns: camps, reportDate: day, daily_template: tpl, digest_focus: pickFocus(c, m) };
        const subject = `${L.department === "service" ? "Service" : "Sales"} Daily Digest — ${name}`;
        const g = guardrailFor(tpl, m);
        // backfill is historical → no future "upcoming appointments"; render from the
        // full metrics so follow-ups/campaigns still show.
        const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, day, tz, metrics, camps, "daily", { w, cfg: c || {} });
        // preserve a row already marked sent (or claimed by a sender) — just refresh its data
        const { data: ex } = await sb.from("roi_digest_runs").select("status,message_id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", day).maybeSingle();
        if (ex?.status === "sent" || ex?.message_id) {
          // LOCK: a really-emailed row (message_id set) keeps its exact sent body — refresh metrics only.
          const upd = ex.message_id ? { metrics, subject } : { metrics, rendered_html: html, subject };
          await sb.from("roi_digest_runs").update(upd).eq("team_id", L.team_id).eq("department", L.department).eq("cadence", "daily").eq("local_date", day); out.preserved++; continue;
        }
        // FAIL LOUD: surface a denied/failed write (e.g. a publishable key that can't write
        // roi_digest_runs) instead of silently counting a row that never persisted.
        const up = async (extra) => {
          const { error } = await sb.from("roi_digest_runs").upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" });
          if (error) throw new Error(`roi_digest_runs write failed (service_role key required?): ${error.message}`);
        };
        if (!emails.length) { await up({ status: "not_sent", reason: eligibleButUnsubscribed(recOf.get(L.team_id), L.department) ? "unsubscribed" : "recipients_missing", metrics, subject }); out.not_sent++; }
        else if (!g.ok) { await up({ status: "not_sent", reason: g.reason, metrics, subject }); out.not_sent++; }
        else {
          // Record-only: the digest that WOULD have gone out, rebuilt from the data. It is NEVER recorded
          // as 'sent' (that used to fake a delivery and, through the already-sent check, block a real
          // re-send of the same day). not_sent/backfilled keeps the body for the tracker preview, marks
          // every recipient as not received, and leaves message_id NULL so a real send can still claim it.
          await up({ status: "not_sent", reason: "backfilled", reason_detail: "history rebuilt from stored data by backfill; this digest was never emailed", metrics, subject, rendered_html: html, send_path: "raw_html", sent_at: null, recipients: emails.map((e) => ({ email: e, received: false })) });
          out.backfilled++;
        }
      } catch (e) { out.errors++; console.log(`  ✗ ${name} [${L.department}] ${day}: ${String(e).slice(0, 120)}`); }
    }
    console.log(`  ✓ ${name} [${L.department}] — ${days.length} days`);
  }

  // simple concurrency pool
  let i = 0;
  await Promise.all(Array.from({ length: POOL }, async () => { while (i < tasks.length) { const L = tasks[i++]; await worker(L); } }));
  console.log("  backfill summary:", JSON.stringify(out));
  return out;
}

// ── RERENDER — refresh rendered_html from ALREADY-STORED metrics (Supabase-only) ──
// No Metabase, no email, no metric/data change — only re-templates rows that already
// carry rendered_html (sent/suppressed) so the stored bytes match the latest template.
async function rerender() {
  console.log("\n── RERENDER stored rendered_html from stored metrics (Supabase-only · NO emails · NO data change) ──");
  const { data: cfg } = await readAll("roi_rooftop_config", "team_id,rooftop_name,team_name,daily_template,digest_focus,digest_send_hour,digest_send_minute,weekly_send_dow,monthly_send_day");
  const nameOf = new Map((cfg ?? []).map((c) => [c.team_id, c.rooftop_name || c.team_name || ""]));
  const cfgOf = new Map((cfg ?? []).map((c) => [c.team_id, c]));
  const out = { updated: 0, errors: 0 };
  const PAGE = 400;
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await sb.from("roi_digest_runs")
      .select("team_id,enterprise_id,department,cadence,local_date,dealer_timezone,metrics,rendered_html")
      .not("metrics", "is", null).not("rendered_html", "is", null)
      .is("message_id", null) // LOCK: never re-render rows that were really emailed (message_id set)
      .order("local_date", { ascending: false }).order("team_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("  read error:", error.message); break; }
    if (!rows || !rows.length) break;
    for (const r of rows) {
      try {
        const m = r.metrics || {};
        const name = nameOf.get(r.team_id) || "";
        const tz = await resolveTz(sb, r.team_id, r.dealer_timezone, name);
        const pw = periodWindowFor(tz, r.cadence, r.local_date);
        const dateLabel = (pw && pw.dateLabel) || new Date(`${r.local_date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
        const camps = Array.isArray(m.campaigns) ? m.campaigns : [];
        // re-render to the rooftop's CURRENT template choice (daily switchable; weekly/monthly always v2)
        const tpl = pickTemplate(cfgOf.get(r.team_id), r.cadence);
        const html = renderDigest(tpl, name, r.department, dateLabel, r.enterprise_id, r.team_id, r.local_date, tz, m, camps, r.cadence, { w: pw, cfg: cfgOf.get(r.team_id) || {} });
        const { error: ue } = await sb.from("roi_digest_runs").update({ rendered_html: html })
          .eq("team_id", r.team_id).eq("department", r.department).eq("cadence", r.cadence).eq("local_date", r.local_date);
        if (ue) out.errors++; else out.updated++;
      } catch { out.errors++; }
    }
    console.log(`  …${out.updated} updated`);
    if (rows.length < PAGE) break;
  }
  console.log("  rerender summary:", JSON.stringify(out));
  return out;
}

// ── Render ONE stored day in a CHOSEN template — render-only, NO send, NO write ──
// Powers the tracker's daily-digest "New / Classic" preview toggle: load the metrics already
// stored for (team, dept, cadence, local_date) and render them in the requested template, so any
// past day can be viewed under either design regardless of what actually went out. `tpl` ('v1'|'v2')
// overrides the rooftop's config; weekly/monthly are always v2. Returns null if no metrics are stored.
async function renderStoredDigest({ teamId, department, cadence = "daily", localDate, tpl }) {
  if (!teamId || !department || !localDate) throw new Error("teamId, department, localDate required");
  const dept = department === "service" ? "service" : "sales";
  const cad = cadence === "weekly" || cadence === "monthly" ? cadence : "daily";
  const { data: row, error } = await sb.from("roi_digest_runs")
    .select("enterprise_id,dealer_timezone,metrics")
    .eq("team_id", teamId).eq("department", dept).eq("cadence", cad).eq("local_date", localDate)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || !row.metrics) return null;
  const { data: cfg } = await sb.from("roi_rooftop_config")
    .select("rooftop_name,team_name,daily_template,digest_focus,digest_send_hour,digest_send_minute,weekly_send_dow,monthly_send_day").eq("team_id", teamId).maybeSingle();
  const m = row.metrics || {};
  const name = (cfg && (cfg.rooftop_name || cfg.team_name)) || "";
  const tz = await resolveTz(sb, teamId, row.dealer_timezone, name);
  const pw = periodWindowFor(tz, cad, localDate);
  const dateLabel = (pw && pw.dateLabel) || new Date(`${localDate}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const camps = Array.isArray(m.campaigns) ? m.campaigns : [];
  // daily honors the requested template (falls back to the rooftop's config); weekly/monthly always v2.
  const chosen = cad === "daily" ? (tpl === "v1" || tpl === "v2" ? tpl : pickTemplate(cfg, cad)) : "v2";
  const html = renderDigest(chosen, name, dept, dateLabel, row.enterprise_id, teamId, localDate, tz, m, camps, cad, { w: pw, cfg: cfg || {} });
  // strip the no-value marker AND the 1×1 open-tracking pixel — this is an on-screen preview, never a
  // send; leaving the pixel in fires the track-open Edge Function and inflates open_count on every preview.
  const preview = emailValue.stripMarker(html).replace(/<img[^>]*\/functions\/v1\/track-open[^>]*>/gi, "");
  return { html: preview, template: chosen };
}

// ── WEEKLY / MONTHLY cadence generation ─────────────────────────────────────
// The hourly cron also produces the weekly digest (sent Mondays) and the monthly
// digest (sent on the 1st), gated by roi_rooftop_config.weekly_enabled/monthly_enabled
// and the rooftop's send-hour. Reuses the SAME fetch + render pipeline as the daily
// pass; only the window + cadence + period wording differ. Idempotent: one row per
// (team, dept, cadence, local_date).
function localCadenceParts(tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  const Y = +g("year"), M = +g("month"), D = +g("day");
  // Numeric day-of-week (0=Sun..6=Sat, matches JS Date.getUTCDay() / the weekly_send_dow column)
  // derived from the dealer-local calendar date, not the Intl short-weekday string.
  const dowNum = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
  return { Y, M, D, H: (+g("hour")) === 24 ? 0 : +g("hour"), Min: +g("minute"), dow: g("weekday"), dowNum };
}
const isoD = (d) => d.toISOString().slice(0, 10);
const pad2 = (n) => String(n).padStart(2, "0");

// ── THE period window for a digest, from its period key (pure: no clock, no I/O) ──────────────────
// The key is the row's local_date in the cron's own convention:
//   daily   → the report date                       window [D, D+1)
//   weekly  → the LAST day of the 7-day window      window [D-6, D+1)
//   monthly → the 1st of the reported month         window [1st, 1st of next month)
// The scheduled passes and an explicit "send this period" request both go through here, so a manual
// send for a period covers exactly the days the cron would have. MTD runs from the 1st of the month of
// the period's last day (for a weekly sent on the 1st that is the previous month, not an empty window).
// Throws on a malformed date.
function windowForPeriod(tz, cadence, localDate) {
  const s = String(localDate || "");
  const [y, m, d] = s.split("-").map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isoD(new Date(Date.UTC(y, m - 1, d))) !== s) throw new Error(`invalid period date "${localDate}" (expected YYYY-MM-DD)`);
  if (cadence === "weekly") {
    const apiStart = addDaysISO(s, -6), apiEnd = addDaysISO(s, 1);
    return { cadence: "weekly", localDate: s, apiStart, apiEnd, apiMonthStart: `${s.slice(0, 7)}-01`, lastDay: s, dateLabel: `Week of ${apiStart} – ${s}` };
  }
  if (cadence === "monthly") {
    const first = `${s.slice(0, 7)}-01`, next = isoD(new Date(Date.UTC(y, m, 1)));
    return { cadence: "monthly", localDate: first, apiStart: first, apiEnd: next, apiMonthStart: first, lastDay: addDaysISO(next, -1),
      dateLabel: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
  }
  return { cadence: "daily", ...windowsForDate(s, tz), lastDay: s };
}

// The period a scheduled weekly/monthly pass works on NOW, and whether it is due. A period stays due from
// its send day until a 'sent' row exists, bounded: weekly ≤ WEEKLY_MAX_LATE_DAYS (the next period starts
// after 6), monthly ≤ MONTHLY_MAX_LATE_DAYS (then gaveUp → not_sent/missed_send_day). It used to be due on
// the exact send day only, so one bad day lost the period (the week ending 2026-10-04 wrote nothing).
// `cfg` (roi_rooftop_config row) is optional: defaults Monday / the 1st.
function cadenceWindow(tz, cadence, cfg) {
  const c = localCadenceParts(tz);
  const today = `${c.Y}-${pad2(c.M)}-${pad2(c.D)}`;
  const clock = { localHour: c.H, localMinute: c.Min };
  if (cadence === "weekly") {
    const dow = Number(cfg?.weekly_send_dow ?? 1);
    const valid = Number.isInteger(dow) && dow >= 0 && dow <= 6;
    const lateDays = valid ? (c.dowNum - dow + 7) % 7 : 0;
    const sendDate = addDaysISO(today, -lateDays);
    return { ...windowForPeriod(tz, "weekly", addDaysISO(sendDate, -1)), ...clock, sendDate, lateDays, sendDue: valid && lateDays <= WEEKLY_MAX_LATE_DAYS, gaveUp: false };
  }
  // monthly — the previous calendar month, sent on the configured day (default the 1st; a day the month
  // doesn't have, e.g. the 31st, means its last day)
  const day = Number(cfg?.monthly_send_day ?? 1);
  const valid = Number.isInteger(day) && day >= 1 && day <= 31;
  const dim = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // days in month mm (1-based)
  let sy = c.Y, sm = c.M;
  if (valid && c.D < Math.min(day, dim(sy, sm))) { sm -= 1; if (sm === 0) { sm = 12; sy -= 1; } }
  const sendDate = `${sy}-${pad2(sm)}-${pad2(valid ? Math.min(day, dim(sy, sm)) : 1)}`;
  const lateDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${sendDate}T00:00:00Z`)) / 86400000);
  const period = isoD(new Date(Date.UTC(sy, sm - 2, 1)));  // the month before the send month
  return { ...windowForPeriod(tz, "monthly", period), ...clock, sendDate, lateDays,
    sendDue: valid && lateDays <= MONTHLY_MAX_LATE_DAYS, gaveUp: valid && lateDays > MONTHLY_MAX_LATE_DAYS };
}

// On-demand window for the manual "generate & send now" path when no period is named. Unlike the
// scheduled cron (calendar-anchored), on-demand uses ROLLING windows ending yesterday:
// daily = yesterday · weekly = last 7 days · monthly = last 30 days. No send-day gate.
function onDemandWindow(tz, cadence) {
  const c = localCadenceParts(tz);
  const yesterday = addDaysISO(`${c.Y}-${pad2(c.M)}-${pad2(c.D)}`, -1);
  if (cadence === "weekly") return { ...windowForPeriod(tz, "weekly", yesterday), localHour: c.H, localMinute: c.Min };
  if (cadence === "monthly") {
    const start = addDaysISO(yesterday, -29), end = addDaysISO(yesterday, 1);
    return { cadence: "monthly", apiStart: start, apiEnd: end, apiMonthStart: `${c.Y}-${pad2(c.M)}-01`, lastDay: yesterday,
      localDate: yesterday, dateLabel: `Last 30 days · ${start} – ${yesterday}`, localHour: c.H, localMinute: c.Min };
  }
  return { ...localParts(tz), lastDay: yesterday }; // daily — yesterday window (apiStart/apiEnd/apiMonthStart present)
}

// ── ON-DEMAND generate + send (manual "create in real time and send") ────────
// Powers the tracker's per-rooftop and bulk "Generate & send {cadence}" buttons.
// opts: { cadence:'daily'|'weekly'|'monthly', teamId?, department?, localDate?, force?, dryRun? }
//
// WITH localDate (a named period, in the cron's own key convention — see windowForPeriod): builds
// exactly that period, upserts THAT row, honours weekly_enabled / monthly_enabled (daily_enabled for
// daily), skips a period already sent unless `force`, and takes the same atomic send-claim the cron
// takes, so the cron and a manual send can never both deliver one period.
//
// WITHOUT localDate (the original behaviour): rolling windows ending yesterday, no already-sent guard,
// bypassing the send-day/send-hour gates; can target ONE rooftop or ALL live rooftops.
//
// Both: dry-run respected (server DRY_RUN + the rooftop's dry_run; dryRun:true forces a held preview),
// churn gate, daily pause, and `force` is the DANGER override that also sends a no-value digest.
async function generateAndSendNow(opts) {
  opts = opts || {};
  resetApiCache(); // an explicit "generate now" always reads fresh numbers
  const cadence = (opts.cadence === "weekly" || opts.cadence === "monthly") ? opts.cadence : "daily";
  // DANGER override: when true, send even a no-value digest (manual force-send) / re-send a sent period.
  const force = opts.force === true;
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const onlyTeam = opts.teamId ? String(opts.teamId) : null;
  const onlyDept = opts.department === "service" ? "service" : opts.department === "sales" ? "sales" : null;
  const forceDry = opts.dryRun === true;
  const periodKey = opts.localDate ? String(opts.localDate) : null;
  if (periodKey) windowForPeriod("America/New_York", cadence, periodKey); // reject a malformed date before touching anything
  const enabledCol = cadence === "weekly" ? "weekly_enabled" : cadence === "monthly" ? "monthly_enabled" : "daily_enabled";

  const { live, cfgOf, recOf } = await loadFleet("team_id,enterprise_id,rooftop_name,team_name,timezone,digest_send_hour,digest_send_minute,daily_enabled,weekly_enabled,monthly_enabled,weekly_send_dow,monthly_send_day,daily_template,digest_focus,sms_enabled,lifecycle_status,churn_date");
  let targets = live;
  if (onlyTeam) targets = targets.filter((L) => L.team_id === onlyTeam);
  if (onlyDept) targets = targets.filter((L) => L.department === onlyDept);

  const out = { cadence, scope: onlyTeam ? "rooftop" : "all", localDate: periodKey, sent: 0, suppressed: 0, no_recipients: 0, no_data: 0, paused: 0, already_sent: 0, held: 0, errors: 0, churned: 0, details: [] };
  const smsFailures = []; // on-demand digest-SMS failures this pass → shared Slack breakage alert (SMS)

  const process1 = async (L) => {
    const c = cfgOf.get(L.team_id); const name = c?.rooftop_name || c?.team_name || "";
    const note = (status, extra) => out.details.push({ team: L.team_id, dept: L.department, name, status, ...(extra || {}) });
    // Same pause toggle the daily cron honors (roi_rooftop_config.daily_enabled) — a CSM who paused
    // a rooftop's digest must not have a manual "Generate & send now" bypass that hold. A named weekly /
    // monthly period also needs its cadence switched on.
    if (cadence === "daily" && c && c.daily_enabled === false) { out.paused++; note("paused", { reason: "daily_enabled=false" }); return; }
    if (periodKey && cadence !== "daily" && (!c || c[enabledCol] !== true)) { out.paused++; note("paused", { reason: `${enabledCol}=false` }); return; }
    const Dep = L.department === "service" ? "Service" : "Sales";
    const Cad = cadence === "weekly" ? "Weekly" : cadence === "monthly" ? "Monthly" : "Daily";
    const subject = `${Dep} ${Cad} Digest — ${name}`;
    let tz = null, w = null, base = null, prior = null;
    const upsert = async (extra) => {
      const { error } = await sb.from("roi_digest_runs").upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" }).select("id");
      if (error) throw new Error(`roi_digest_runs write failed: ${error.message}`);
    };
    // A hold never overwrites a period somebody already claimed or sent (only reachable with `force`).
    const writeHold = (extra) => (prior && prior.message_id ? Promise.resolve() : upsert(extra));
    try {
      tz = await resolveTz(sb, L.team_id, c?.timezone, name);
      assertValidTz(tz);
      w = periodKey ? windowForPeriod(tz, cadence, periodKey) : onDemandWindow(tz, cadence);
      base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence, local_date: w.localDate, dealer_timezone: tz, trigger: "manual" };
      if (periodKey) {
        ({ data: prior } = await sb.from("roi_digest_runs").select("id,status,reason,message_id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", cadence).eq("local_date", w.localDate).maybeSingle());
        // In flight right now: never, even forced (a second send would race the first).
        if (prior && prior.status === "sending") { out.already_sent++; note("in_flight"); return; }
        if (prior && (prior.status === "sent" || prior.message_id) && !force) { out.already_sent++; note("already_sent", { previous: prior.status }); return; }
      }
      // CHURN GATE — a manual "Generate & send now" must not bypass it either (same reasoning as
      // the daily_enabled pause above). See subscriptions.cjs isChurned.
      if (isChurned(c, w.localDate)) {
        await writeHold({ status: "not_sent", reason: "churned", reason_detail: `lifecycle=${c?.lifecycle_status ?? "?"}`, subject });
        out.churned++; note("churned");
        return;
      }
      const emails = subscribedEmails(recOf.get(L.team_id), L.department, cadence);
      if (!emails.length) {
        const unsub = eligibleButUnsubscribed(recOf.get(L.team_id), L.department);
        await writeHold({ status: "not_sent", reason: unsub ? "unsubscribed" : "recipients_missing", subject });
        out.no_recipients++; note(unsub ? "unsubscribed" : "no_recipients"); return;
      }
      const { m, ai, report } = await buildDigestMetrics({ teamId: L.team_id, entId: L.enterprise_id, dept: L.department, w });
      const tpl = pickTemplate(c, cadence);
      const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate, daily_template: tpl, digest_focus: pickFocus(c, m) };
      const g = guardrailFor(tpl, m);
      if (!g.ok && !force) { await writeHold({ status: "not_sent", reason: g.reason, metrics, subject }); out.no_data++; note("no_data", { reason: g.reason }); return; }
      const camps = await getCampaigns(L.team_id, L.department, w, L.enterprise_id);
      const { dollarRate, enr } = await enrichFor({ teamId: L.team_id, entId: L.enterprise_id, dept: L.department, tz, w, report, cadence });
      const metricsFull = { ...metrics, campaigns: camps, ...enrichedFields(enr), dollarRate };
      const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, w.localDate, tz, metricsFull, camps, cadence, { w, cfg: c || {} });
      const dry = forceDry || DRY_RUN || L.dry_run === true;
      if (dry) { await writeHold({ status: "suppressed", reason: forceDry ? "manual_dry_run" : (L.dry_run === true ? "dry_run" : "server_dry_run"), metrics: metricsFull, subject, rendered_html: html }); out.suppressed++; note("suppressed"); return; }
      const sentAt = new Date().toISOString();
      let lockId = null;
      if (periodKey && !(force && prior && prior.message_id)) {
        // The cron's own at-most-once claim: the row exists first (queued), then message_id NULL → lock.
        await upsert({ status: "queued", reason: null, reason_detail: null, metrics: metricsFull, subject, recipients: emails.map((e) => ({ email: e, received: false })) });
        lockId = `manual-${L.team_id}-${L.department}-${cadence}-${w.localDate}`;
        const { data: claim, error: claimErr } = await sb.from("roi_digest_runs")
          .update({ status: "sending", message_id: lockId, reason_detail: claimDetail() })
          .eq("team_id", L.team_id).eq("department", L.department).eq("cadence", cadence).eq("local_date", w.localDate)
          .is("message_id", null)
          .select("id");
        if (claimErr) throw new Error(`send-claim failed: ${claimErr.message}`);
        if (!claim || !claim.length) { out.already_sent++; note("already_sent"); return; }
        prior = { status: "sending", message_id: lockId, ownClaim: true };
      }
      const messageId = await sendMailAttributed(emails, subject, html, { force });
      await upsert({ status: "sent", reason: null, reason_detail: null, metrics: metricsFull, subject, rendered_html: html, send_path: "raw_html", sent_at: sentAt, message_id: messageId || lockId || `manual-${cadence}-${sentAt}`, recipients: emails.map((e) => ({ email: e, received: true })) });
      out.sent++; note("sent", { recipients: emails.length });
      console.log(`  ✓ SENT (on-demand) ${cadence} ${name} [${L.department}]`);
      // Digest SMS companion — only once the email itself went out.
      await smsAfterSend({ L, c, recOf, cadence, w, tz, name, m, smsFailures });
    } catch (e) {
      const code = e && e.code;
      const detail = String(e && e.message ? e.message : e).slice(0, 400);
      const isHold = !!HOLD_REASON[code];
      // A no-value block counts as no_data so the tracker offers the DANGER override (it keyed on that).
      if (code === "BLOCKED_NO_VALUE") out.no_data++; else if (isHold) out.held++; else out.errors++;
      note(isHold ? "held" : "error", isHold ? { reason: HOLD_REASON[code] } : { error: detail.slice(0, 160) });
      console.log(`  ✗ on-demand ${cadence} ${name} [${L.department}] ${isHold ? "held" : "error"}: ${detail.slice(0, 160)}`);
      // A named period records its outcome on its row, like the cron: a claimed row must not stay
      // 'sending' (it keeps its claim either way, so it is never resent automatically).
      if (periodKey && base && (!prior || !prior.message_id || prior.ownClaim)) {
        try { await upsert(isHold ? { status: "not_sent", reason: HOLD_REASON[code], reason_detail: detail } : { status: "error", reason: "error", reason_detail: detail }); } catch { /* best-effort */ }
      }
    }
  };

  const POOL = Number(process.env.CRON_POOL || 10); let _i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL, targets.length || 1)) }, async () => { while (_i < targets.length) { await process1(targets[_i++]); } }));
  console.log(`  on-demand ${cadence} summary:`, JSON.stringify({ ...out, details: undefined }));
  await postBreakageAlert({ source: `On-demand ${cadence} digest SMS`, failures: smsFailures, sentOk: null, windowLabel: `on-demand ${cadence} generate & send` })
    .catch((e) => console.warn("[roi-cron] on-demand sms slack alert skipped:", String(e).slice(0, 140)));
  return out;
}

// ── PREVIEW-ONLY (render, return HTML; NO DB write, NO send) ──────────────────
// Powers the tracker's "Generate preview" step: build the SAME metrics + render
// the SAME HTML the on-demand send would produce, for ONE rooftop+dept+cadence,
// and hand it back so the drawer can show it BEFORE the user manually triggers a
// send. Read-only by construction — it touches none of the send/upsert paths, so
// it can never email or mutate roi_digest_runs. Mirrors process1's build steps.
// opts: { cadence:'daily'|'weekly'|'monthly', teamId, department, localDate? }
async function previewDigestNow(opts) {
  opts = opts || {};
  resetApiCache();
  const cadence = (opts.cadence === "weekly" || opts.cadence === "monthly") ? opts.cadence : "daily";
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const teamId = String(opts.teamId || "");
  const department = opts.department === "service" ? "service" : "sales";
  if (!teamId) throw new Error("teamId is required");

  const cfgRes = await sb.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,team_name,timezone,daily_template,digest_focus,digest_send_hour,digest_send_minute,weekly_send_dow,monthly_send_day").eq("team_id", teamId).maybeSingle();
  const cfg = cfgRes.data || {};
  const name = cfg.rooftop_name || cfg.team_name || "";
  const tz = await resolveTz(sb, teamId, cfg.timezone, name);
  assertValidTz(tz);
  const enterpriseId = cfg.enterprise_id || ""; // enterprise_id is on roi_rooftop_config, not roi_live_departments
  const w = opts.localDate ? windowForPeriod(tz, cadence, String(opts.localDate)) : onDemandWindow(tz, cadence);
  const Dep = department === "service" ? "Service" : "Sales";
  const Cad = cadence === "weekly" ? "Weekly" : cadence === "monthly" ? "Monthly" : "Daily";
  const subject = `${Dep} ${Cad} Digest — ${name}`;

  // Same metric assembly as the send paths, so the preview is byte-identical to what sends.
  const { m, ai, report } = await buildDigestMetrics({ teamId, entId: enterpriseId, dept: department, w });
  const tpl = pickTemplate(cfg, cadence);
  const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate, daily_template: tpl, digest_focus: pickFocus(cfg, m) };
  const g = guardrailFor(tpl, m);
  const camps = await getCampaigns(teamId, department, w, enterpriseId);
  const { dollarRate, enr } = await enrichFor({ teamId, entId: enterpriseId, dept: department, tz, w, report, cadence });
  const metricsFull = { ...metrics, campaigns: camps, ...enrichedFields(enr), dollarRate };
  const html = renderDigest(tpl, name, department, w.dateLabel, enterpriseId, teamId, w.localDate, tz, metricsFull, camps, cadence, { w, cfg });
  return { ok: true, cadence, teamId, department, name, subject, dateLabel: w.dateLabel, localDate: w.localDate, hasData: g.ok, reason: g.ok ? null : g.reason, metrics: metricsFull, html };
}

// On a catch-up day (after the send day), a period is still OWED only when nothing decided it yet:
// not visited, waiting, failed before its claim, or held for a reason a human may have fixed since. A
// period decided on its send day (no data, dry-run, churned...) is not re-fetched every hour all week.
function owedOnCatchUp(prior, L) {
  if (!prior) return true;
  if (["scheduled", "queued", "error"].includes(prior.status)) return true;
  // (pass_killed is deliberately NOT owed: a reaped row is a missed send, never retried automatically.)
  if (prior.status === "not_sent" && REEVALUATE_REASONS.includes(prior.reason)) return true;
  return prior.status === "suppressed" && L.dry_run === false;
}

// ── Catch-up floor ──────────────────────────────────────────────────────────────────────────────────
// Catch-up (a period sent AFTER its send day) applies only to periods whose send day falls on or after
// the day this code first ran. Periods the old code missed (the 2026-10-01 monthly stuck in 'scheduled',
// the week ending 2026-10-04 that wrote nothing) are recorded as missed and NEVER sent automatically.
// Floor = the UTC date of the earliest roi_cron_runs row this cadence's pass has written (A21 trail);
// today when there is none yet (the first pass after deploy) or the read fails. CADENCE_CATCHUP_NOT_BEFORE
// (YYYY-MM-DD) overrides it, for an explicit human decision only.
async function catchupFloor(cadence) {
  const env = String(process.env.CADENCE_CATCHUP_NOT_BEFORE || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(env)) return env;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await sb.from("roi_cron_runs").select("created_at").eq("source", `roi-digest-${cadence}`)
      .order("created_at", { ascending: true }).limit(1);
    if (error || !data || !data[0] || !data[0].created_at) return today;
    const first = String(data[0].created_at).slice(0, 10);
    return first < today ? first : today;
  } catch { return today; }
}

async function runCadence(cadence, opts = {}) {
  if (cadence !== "weekly" && cadence !== "monthly") return { skipped: true };
  return withPassTrail(`roi-digest-${cadence}`, opts, () => runCadencePass(cadence, opts));
}
async function runCadencePass(cadence, opts) {
  const passStart = Date.now();
  resetApiCache();
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  const enabledCol = cadence === "weekly" ? "weekly_enabled" : "monthly_enabled";
  const Cad = cadence === "weekly" ? "Weekly" : "Monthly";
  const { live, cfgOf, recOf } = await loadFleet(`team_id,enterprise_id,rooftop_name,team_name,timezone,digest_send_hour,digest_send_minute,daily_enabled,daily_template,digest_focus,sms_enabled,weekly_send_dow,monthly_send_day,lifecycle_status,churn_date,${enabledCol}`);
  const knobs = operatorKnobs(opts);
  const { IGNORE_HOUR, IGNORE_DAY, ONLY, FORCE_RESEND } = knobs;
  const out = { targets: 0, sent: 0, suppressed: 0, not_due: 0, already_sent: 0, no_recipients: 0, unsubscribed: 0, no_data: 0, before_hour: 0, errors: 0, churned: 0, stale_held: 0, caught_up: 0, missed: 0, unreached: 0, ignoredEnv: knobs.ignored };
  const failures = []; // genuine weekly/monthly send failures → Slack breakage alert
  const smsFailures = []; // genuine weekly/monthly digest-SMS failures this pass → Slack breakage alert (SMS)
  const staleHeld = [];
  // Same freshness hard-gate as the daily pass: a period whose last day the aggregate hasn't reached is
  // held, not emailed as frozen zeros. One probe per pass; fail-open when unknown.
  const freshness = await probeAggregateFreshness();
  const scoped = live.filter((L) => (!ONLY.length || ONLY.includes(L.team_id)) && cfgOf.get(L.team_id)?.[enabledCol] === true);
  await primeTeamDetails(scoped.filter((L) => !cfgOf.get(L.team_id)?.timezone).map((L) => L.team_id));
  const index = await readRunIndex(cadence, isoDaysAgo(cadence === "weekly" ? 21 : 75));
  const winOf = (L) => { const c = cfgOf.get(L.team_id); try { return cadenceWindow(isValidTz(c?.timezone) ? c.timezone : "America/New_York", cadence, c); } catch { return {}; } };
  const targets = prioritize(scoped, index, (L) => winOf(L).localDate);
  out.targets = targets.length;
  const floor = await catchupFloor(cadence);
  out.catchupFloor = floor;

  const process1 = async (L) => {
    const c = cfgOf.get(L.team_id); const name = c?.rooftop_name || c?.team_name || "";
    let tz = null, w = null, base = null;
    const upsert = async (extra) => {
      const { error } = await sb.from("roi_digest_runs").upsert({ ...base, ...extra }, { onConflict: "team_id,department,cadence,local_date" }).select("id");
      if (error) throw new Error(`roi_digest_runs write failed: ${error.message}`);
    };
    try {
      tz = await resolveTz(sb, L.team_id, c?.timezone, name);
      assertValidTz(tz);
      w = cadenceWindow(tz, cadence, c);
      base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence, local_date: w.localDate, dealer_timezone: tz, trigger: "cron" };
      // A late period whose send day predates the catch-up floor was missed by code that had no catch-up:
      // recorded once as missed, never fetched, never sent. A sent or claimed row is never touched.
      if (w.lateDays > 0 && w.sendDate < floor) {
        const { data: pre } = await sb.from("roi_digest_runs").select("id,status,reason,message_id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", cadence).eq("local_date", w.localDate).maybeSingle();
        // Only an UNDECIDED, unclaimed row (none / scheduled / queued / error) becomes missed. A row that
        // was sent, claimed, or deliberately held (no data, dry-run, churned...) keeps what it says.
        if (pre && (pre.message_id || !["scheduled", "queued", "error"].includes(pre.status))) { out.not_due++; return; }
        await upsert({ status: "not_sent", reason: "missed_send_day", reason_detail: `missed before catch-up existed (send day ${w.sendDate}); not sent automatically` });
        out.missed++;
        console.log(`  · ${name} [${L.department}] ${cadence} not_sent → missed_send_day (send day ${w.sendDate} < catch-up floor ${floor})`);
        return;
      }
      if (!IGNORE_DAY && !w.sendDue) {
        // A monthly period past its catch-up window that never went out: recorded ONCE, so the tracker
        // shows a missed digest instead of an empty cell or a 'scheduled' that will never move.
        const row = index.get(`${L.team_id}|${L.department}|${w.localDate}`);
        if (w.gaveUp && !isChurned(c, w.localDate) && (!row || (["scheduled", "queued"].includes(row.status) && !row.message_id))) {
          await upsert({ status: "not_sent", reason: "missed_send_day", reason_detail: `not sent within ${MONTHLY_MAX_LATE_DAYS} days of its ${w.sendDate} send day` });
          out.missed++;
          console.log(`  · ${name} [${L.department}] ${cadence} not_sent → missed_send_day (${w.localDate})`);
        } else out.not_due++;
        return;
      }
      const { data: prior } = await sb.from("roi_digest_runs").select("id,status,reason,message_id").eq("team_id", L.team_id).eq("department", L.department).eq("cadence", cadence).eq("local_date", w.localDate).maybeSingle();
      // Sent, in flight, or claimed (message_id) → finished. Never flipped back to queued/scheduled.
      if (prior && (prior.status === "sent" || prior.status === "sending" || prior.message_id) && !FORCE_RESEND) { out.already_sent++; return; }
      if (w.lateDays > 0 && !owedOnCatchUp(prior, L)) { out.not_due++; return; }
      // CHURN GATE — see runOnce / subscriptions.cjs isChurned. After the already-sent check.
      if (isChurned(c, w.localDate)) {
        await upsert({ status: "not_sent", reason: "churned", reason_detail: `lifecycle=${c?.lifecycle_status ?? "?"} churn_date=${c?.churn_date ? String(c.churn_date).slice(0, 10) : "none"}` });
        out.churned++;
        console.log(`  · ${name} [${L.department}] ${cadence} not_sent → churned`);
        return;
      }
      const emails = subscribedEmails(recOf.get(L.team_id), L.department, cadence);
      if (!emails.length) {
        const unsub = eligibleButUnsubscribed(recOf.get(L.team_id), L.department);
        await upsert({ status: "not_sent", reason: unsub ? "unsubscribed" : "recipients_missing", reason_detail: unsub ? `verified recipients exist but none is subscribed to the ${cadence} digest` : null });
        if (unsub) out.unsubscribed++; else out.no_recipients++;
        return;
      }
      const subject = `${L.department === "service" ? "Service" : "Sales"} ${Cad} Digest — ${name}`;
      // Send-time gate BEFORE any numbers are fetched. A weekly/monthly window is a whole week or month
      // (34s for one rooftop's month on 2026-10-08), the tracker previews these on demand rather than
      // from stored metrics, and every pass until the send time used to re-fetch them just to write
      // "scheduled". Now that is one cheap write; the send-time visit does the work. A catch-up day waits
      // for the send time too. Only a fresh or already-scheduled row is (re)written as scheduled: a
      // failure stays visible until the send-time visit retries it.
      const sendHour = c?.digest_send_hour ?? 7;
      const sendMinute = c?.digest_send_minute ?? 0;
      const beforeSendTime = w.localHour < sendHour || (w.localHour === sendHour && (w.localMinute ?? 0) < sendMinute);
      // Same send window as the daily pass: never send a weekly/monthly hours after the send time.
      // Nothing is written, so a catch-up day (inside its window) can still send a period due after deploy.
      if (!IGNORE_HOUR && pastSendWindow(w, sendHour, sendMinute)) { out.window_passed = (out.window_passed || 0) + 1; return; }
      if (!IGNORE_HOUR && beforeSendTime) {
        if (!prior || prior.status === "scheduled") await upsert({ status: "scheduled", reason: "before_send_hour", subject, recipients: emails.map((e) => ({ email: e, received: false })) });
        out.before_hour++; return;
      }
      if (aggregateStaleForDate(freshness, w.lastDay)) {
        await upsert({ status: "not_sent", reason: "aggregate_stale", reason_detail: `agg newest day ${freshness.maxActivityDay} < period end ${w.lastDay}` });
        out.stale_held++; staleHeld.push(name);
        console.log(`  · ${name} [${L.department}] ${cadence} HELD → aggregate_stale (agg max=${freshness.maxActivityDay} < ${w.lastDay})`);
        return;
      }
      const { m, ai, report } = await buildDigestMetrics({ teamId: L.team_id, entId: L.enterprise_id, dept: L.department, w });
      const tpl = pickTemplate(c, cadence); // weekly/monthly → always v2
      const metrics = { ...m, actionItems: ai.items, reportDate: w.localDate, daily_template: tpl, digest_focus: pickFocus(c, m) };
      await upsert({ status: "queued", reason: null, reason_detail: null, metrics, subject, recipients: emails.map((e) => ({ email: e, received: false })) });
      const g = guardrailFor(tpl, m);
      if (!g.ok) { await upsert({ status: "not_sent", reason: g.reason, metrics, subject }); out.no_data++; return; }
      const camps = await getCampaigns(L.team_id, L.department, w, L.enterprise_id);
      const { dollarRate, enr } = await enrichFor({ teamId: L.team_id, entId: L.enterprise_id, dept: L.department, tz, w, report, cadence });
      const metricsFull = { ...metrics, campaigns: camps, ...enrichedFields(enr), dollarRate };
      const html = renderDigest(tpl, name, L.department, w.dateLabel, L.enterprise_id, L.team_id, w.localDate, tz, metricsFull, camps, cadence, { w, cfg: c });
      const dry = DRY_RUN || L.dry_run === true;
      if (dry) { await upsert({ status: "suppressed", reason: "dry_run", metrics: metricsFull, subject, rendered_html: html }); out.suppressed++; return; }
      // Atomic send-claim (at-most-once per customer · dept · cadence · period) — see runOnce for rationale.
      const sentAt = new Date().toISOString();
      const lockId = `cron-${L.team_id}-${L.department}-${cadence}-${w.localDate}`;
      if (!FORCE_RESEND) {
        const { data: claim, error: claimErr } = await sb.from("roi_digest_runs")
          .update({ status: "sending", message_id: lockId, reason_detail: claimDetail() })
          .eq("team_id", L.team_id).eq("department", L.department).eq("cadence", cadence).eq("local_date", w.localDate)
          .is("message_id", null)
          .select("id");
        if (claimErr) throw new Error(`send-claim failed: ${claimErr.message}`);
        if (!claim || !claim.length) { out.already_sent++; return; }
      }
      const messageId = await sendMailAttributed(emails, subject, html);
      await upsert({ status: "sent", reason: null, reason_detail: null, metrics: metricsFull, subject, rendered_html: html, send_path: "raw_html", sent_at: sentAt, message_id: messageId || lockId, recipients: emails.map((e) => ({ email: e, received: true })) });
      out.sent++;
      if (w.lateDays > 0) out.caught_up++;
      console.log(`  ✓ SENT ${cadence} ${name} [${L.department}]${w.lateDays > 0 ? ` (caught up ${w.lateDays}d after its send day)` : ""}`);
      await smsAfterSend({ L, c, recOf, cadence, w, tz, name, m, smsFailures });
    } catch (e) {
      out.errors++;
      // Same outcome mapping as the daily pass: holds → not_sent, anything else → error + Slack. Used to
      // only bump a counter, so a throw after the claim left the row 'sending' forever with no trace.
      const code = e && e.code;
      const isHold = !!HOLD_REASON[code];
      const detail = String(e && e.message ? e.message : e).slice(0, 400);
      console.log(`  ✗ ${cadence} ${name} [${L.department}] ${isHold ? "held" : "FAILED"}: ${detail.slice(0, 160)}`);
      if (!base) base = { enterprise_id: L.enterprise_id, team_id: L.team_id, department: L.department, cadence, local_date: winOf(L).localDate || safeLocalDate(null), dealer_timezone: String(tz || c?.timezone || "") || null, trigger: "cron" };
      try {
        await upsert(isHold ? { status: "not_sent", reason: HOLD_REASON[code], reason_detail: detail } : { status: "error", reason: "error", reason_detail: detail });
      } catch { /* one failure must not halt the pass */ }
      if (!isHold) failures.push({ rooftop: name, dept: L.department, error: detail.slice(0, 200) });
    }
  };
  const POOL = Number(process.env.CRON_POOL || 10);
  const unreached = await runBudgetedPool(targets, POOL, passStart, process1);
  out.unreached = unreached.length;
  console.log(`  ${cadence} summary:`, JSON.stringify(out));
  await reportUnreached(`${Cad} digest`, unreached, targets.length, (L) => cfgOf.get(L.team_id)?.rooftop_name || cfgOf.get(L.team_id)?.team_name || L.team_id);
  if (staleHeld.length) {
    try {
      await postSystemicAlert({ source: `${Cad} digest`, title: `${staleHeld.length} ${cadence} digest(s) HELD — reporting aggregate is stale`,
        detail: `agent_daily's newest day (${freshness.maxActivityDay}) is behind the period's last day. Held; the next pass retries while the period is still owed. Rooftops: ${staleHeld.slice(0, 12).join(", ")}${staleHeld.length > 12 ? ` +${staleHeld.length - 12} more` : ""}.`,
        windowLabel: `${cadence} digest cron` });
    } catch (e) { console.warn("[roi-cron] cadence stale-hold alert skipped:", String(e).slice(0, 140)); }
  }
  await postBreakageAlert({ source: `${Cad} digest`, failures, sentOk: out.sent, windowLabel: `${cadence} digest send pass` })
    .catch((e) => console.warn("[roi-cron] cadence slack alert skipped:", String(e).slice(0, 140)));
  // Slack breakage alert for the weekly/monthly digest SMS channel (same tiered thresholds).
  await postBreakageAlert({ source: `${Cad} digest SMS`, failures: smsFailures, sentOk: null, windowLabel: `${cadence} digest send pass` })
    .catch((e) => console.warn("[roi-cron] cadence sms slack alert skipped:", String(e).slice(0, 140)));
  return out;
}

// ── Rooftop DISCOVERY (sync-live) ────────────────────────────────────────────
// Pull the onboarded+active Sales/Service rooftops from the ClickHouse candidates
// endpoint and ADD any new ones to roi_live_departments as is_live=true, dry_run=true
// — i.e. visible in the tracker and processed by the hourly send, but SUPPRESSED
// (dry_run) so NO email goes out until a human flips dry_run off. Additive only:
// ON CONFLICT DO NOTHING preserves every existing human-set is_live/dry_run flag,
// and we never auto-deactivate a rooftop (that stays a deliberate human action).
// Live-candidate discovery SQL — onboarded + active Sales/Service (team, dept) pairs. Embedded mirror
// of vini-roi-daily-report/db/clickhouse-endpoints/candidates.sql so the serverless bundle carries it.
// Columns aliased e/t/d to match the row mapping below. runClickhouse appends `FORMAT JSONEachRow`, so
// no trailing semicolon / FORMAT here.
const CANDIDATES_SQL = `SELECT DISTINCT
  tam.enterpriseId        AS e,
  tam.teamId              AS t,
  lower(at.agentType)     AS d
FROM dealer_leads.teamAgentMappings tam
INNER JOIN dealer_leads.agentTypes at ON at.agentTypeId = tam.agentTypeId
WHERE tam.isOnboarded = 1
  AND ifNull(tam.isActive,1) = 1
  AND ifNull(tam.__deleted,0) = 0
  AND ifNull(at.__deleted,0) = 0
  AND at.agentType IN ('Sales','Service')`;

// SECOND candidate source — (team, dept) pairs derived from REAL CALL ACTIVITY.
//
// Why this exists: CANDIDATES_SQL gates on teamAgentMappings.isOnboarded = 1, a provisioning flag
// that lags the AI actually going live. A rooftop taking real dealer calls with isOnboarded = 0 gets
// no roi_live_departments row — and because the digest cron drives off `is_live = true`, it then
// writes NO roi_digest_runs row at all, not even not_sent. The rooftop is invisible in the tracker
// and silently unable to send, with no UI path to fix it (both browser writes are .update(), which
// no-ops when the row is absent). Five rooftops hit this in four days (2026-07-28…31): Lumos Honda
// (42 calls, 8 verified recipients, all 6 mappings isOnboarded=0, zero digest_runs ever), Pinegar
// service, Roanoke Ford sales, and World Car Hyundai South's SERVICE row — whose Sales mappings were
// isOnboarded=1 (row existed) while its Service ones were 0, so 135 of its 145 calls went unreported.
//
// Activity is the signal that can't lag: if the dealer's customers are talking to the AI, the rooftop
// is live regardless of what any stage or provisioning field claims. Rows still land HELD
// (dry_run = true) exactly like teamAgentMappings-derived ones, so discovery never sends an email —
// it only makes the rooftop visible and configurable.
//
// Threshold is deliberately 1 call: a held row costs nothing and invisibility is the expensive
// failure (Roanoke Ford had just 2 calls in 30d and genuinely needed its row). report_useCase is the
// same field the digest itself splits departments on; rows that don't classify as sales/service are
// dropped rather than guessed at.
const ACTIVITY_DEPT_MIN_CALLS = 1;
const ACTIVITY_DEPT_SQL = `SELECT
  teamId AS t,
  multiIf(lower(report_useCase) LIKE '%service%', 'service',
          lower(report_useCase) LIKE '%sales%',   'sales',
          '')                                   AS d,
  uniqExact(callId)                             AS calls
FROM dealer_leads.endcallreports
WHERE isTestCall = 0 AND createdAt >= today() - 30 AND teamId != ''
GROUP BY t, d
HAVING d != '' AND calls >= ${ACTIVITY_DEPT_MIN_CALLS}`;

// Name + test flags for a set of teams, in ONE ClickHouse read (eventila mirrors the Spyne team settings).
// Map team_id → { team_name, enterprise_id, enterprise_name, test }. Never throws (empty on failure).
const chLit = (v) => "'" + String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
async function teamInfoCH(runClickhouse, teamIds) {
  const ids = [...new Set((teamIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  try {
    const rows = await runClickhouse(
      "SELECT t.team_id AS t, t.team_name AS team_name, t.enterprise_id AS e, toUInt8(ifNull(t.is_test_account, 0)) AS team_test," +
      " ifNull(ed.name, '') AS enterprise_name, toUInt8(ifNull(ed.is_test, 0)) AS ent_test" +
      " FROM (SELECT team_id, team_name, enterprise_id, is_test_account FROM eventila.enterprise_team_details FINAL" +
      "   WHERE _peerdb_is_deleted = 0 AND team_id IN (" + ids.map(chLit).join(",") + ")) t" +
      " LEFT JOIN (SELECT enterprise_id, any(name) AS name, max(ifNull(is_test_account, 0)) AS is_test FROM eventila.enterprise_details" +
      "   WHERE _peerdb_is_deleted = 0 GROUP BY enterprise_id) ed ON t.enterprise_id = ed.enterprise_id");
    for (const r of rows || []) {
      const t = String(r.t || "").trim(); if (!t) continue;
      out.set(t, { team_name: String(r.team_name || "").trim(), enterprise_id: String(r.e || "").trim(), enterprise_name: String(r.enterprise_name || "").trim(), test: Number(r.team_test) === 1 || Number(r.ent_test) === 1 });
    }
  } catch (e) { console.warn("[sync-live] team-info lookup failed:", String(e && e.message ? e.message : e).slice(0, 140)); }
  return out;
}
// Internal test rooftops never enter the program: the known test team, eventila's test flag on the team
// or its enterprise, or "test" anywhere in either name.
function isTestTeam(teamId, info) {
  if (TEST_TEAM_IDS.has(teamId)) return true;
  const i = info && info.get(teamId);
  return !!(i && (i.test || /test/i.test(i.team_name) || /test/i.test(i.enterprise_name)));
}

async function syncLive() {
  const ts = new Date().toISOString();
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  // Discover candidates through the SAME ClickHouse client the rest of the app uses
  // (CLICKHOUSE_HOST/USER/PASSWORD — already provisioned in prod), NOT a bespoke ClickHouse Cloud
  // query-endpoint. The endpoint path needed 3 extra secrets (CLICKHOUSE_CANDIDATES_ENDPOINT/KEY_ID/
  // KEY_SECRET) that were never set, so this cron errored every run — the identical fix already applied
  // to syncLifecycle. dealer_leads is reachable by that client. Rows come back keyed e/t/d.
  //
  // SCOPE (2026-07-16): CANDIDATES_SQL (teamAgentMappings.isOnboarded) matches the ENTIRE onboarded
  // Spyne voice-AI fleet — ~2,300 teams / ~4,500 (team,dept) pairs — NOT the ROI-digest program (~320
  // configured rooftops). Unfiltered it floods roi_live_departments (it inserted 4,372 dry_run rows in a
  // single run the morning the long-broken endpoint was revived) and buries real customers in the
  // tracker. The tracker's live universe is "rooftops that are Live OR have activity going on, minus
  // churn", so scope discovery to exactly that: an eligible team is (lifecycle bucket 'Live' OR ≥1
  // call/SMS in the last 30d) AND NOT 'Churned'. teamAgentMappings stays the SOLE source of the
  // Sales/Service dept split — keep it for enumeration, then intersect its teams with the eligible set.
  // LIFECYCLE_SQL/ACTIVITY_SQL are the same proven queries syncLifecycle runs.
  const { runClickhouse } = await import("../agentMetrics.js");
  const [rows, lifeRows, actRows, actDeptRows] = await Promise.all([
    runClickhouse(CANDIDATES_SQL),
    runClickhouse(LIFECYCLE_SQL),
    runClickhouse(ACTIVITY_SQL),
    runClickhouse(ACTIVITY_DEPT_SQL),
  ]);

  // eligible-team gate — (Live ∪ 30d-active) \ Churned
  const churned = new Set(), liveT = new Set();
  for (const r of (lifeRows || [])) {
    const t = String(r.t ?? r.teamId ?? "").trim(); if (!t) continue;
    const b = ARR_BUCKET_TO_LIFECYCLE[r.arr_bucket] || "";
    if (b === "churn") churned.add(t); else if (b === "live") liveT.add(t);
  }
  const activeT = new Set();
  for (const r of (actRows || [])) {
    const t = String(r.t ?? r.teamId ?? "").trim(); if (!t) continue;
    if ((Number(r.calls_30d) || 0) + (Number(r.sms_30d) || 0) > 0) activeT.add(t);
  }
  // Also honour STICKY MANUAL churn, which lives only in Postgres: syncLifecycle preserves a
  // human-confirmed churn that the ARR ledger has no signal for (the Edwards group), so the
  // ledger-derived `churned` set above misses it. Without this, discovery re-adds a manually
  // churned rooftop's departments from its own wind-down traffic. Best-effort: a read failure
  // must not break discovery, it just falls back to the ledger-only set.
  try {
    const { data: cfgChurn } = await readAll("roi_rooftop_config", "team_id,lifecycle_status,churn_date");
    const today = ts.slice(0, 10);
    for (const c of (cfgChurn ?? [])) if (isChurned(c, today)) churned.add(c.team_id);
  } catch (e) { console.warn("[sync-live] sticky-churn read skipped:", String(e).slice(0, 120)); }
  const eligible = (t) => (liveT.has(t) || activeT.has(t)) && !churned.has(t);

  // normalize → {team_id, department}; held as is_live=true + dry_run=true — eligible teams only
  const entOf = new Map(); // team → enterprise, from the onboarding candidates (for a new config row)
  const seen = new Set();
  const cand = [];
  let skipped = 0;
  for (const r of rows) {
    const team_id = String(r.t ?? r.team_id ?? "").trim();
    const department = String(r.d ?? r.department ?? "").trim().toLowerCase();
    if (!team_id || (department !== "sales" && department !== "service")) continue;
    if (!eligible(team_id)) { skipped++; continue; }   // outside the Live/active-minus-churn universe
    if (r.e && !entOf.has(team_id)) entOf.set(team_id, String(r.e).trim());
    const k = `${team_id}|${department}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // enterprise_id lives on roi_rooftop_config, not roi_live_departments (canonical schema) —
    // don't write it here or the upsert 400s on reporting-vini. Set at rooftop onboarding instead.
    cand.push({ team_id, department, is_live: true, dry_run: true });
  }

  // Second pass — the activity-derived pairs (see ACTIVITY_DEPT_SQL). Same `seen` dedupe and the same
  // eligible() gate, so a churned rooftop is never resurrected by its own wind-down traffic. These are
  // by construction in activeT, so the gate only ever removes churn here. Held (dry_run: true) like
  // every other discovered row — a human still flips it on.
  let fromActivity = 0;
  for (const r of (actDeptRows || [])) {
    const team_id = String(r.t ?? r.team_id ?? "").trim();
    const department = String(r.d ?? r.department ?? "").trim().toLowerCase();
    if (!team_id || (department !== "sales" && department !== "service")) continue;
    if (!eligible(team_id)) { skipped++; continue; }
    const k = `${team_id}|${department}`;
    if (seen.has(k)) continue;              // teamAgentMappings already covered this pair
    seen.add(k);
    cand.push({ team_id, department, is_live: true, dry_run: true });
    fromActivity++;
  }

  // Test rooftops never enter the program (one ClickHouse read gives names + test flags for every
  // candidate team; the same names seed the config rows below).
  const info = await teamInfoCH(runClickhouse, cand.map((c) => c.team_id));
  const testTeams = new Set(cand.map((c) => c.team_id).filter((t) => isTestTeam(t, info)));
  if (testTeams.size) {
    for (let i = cand.length - 1; i >= 0; i--) if (testTeams.has(cand[i].team_id)) cand.splice(i, 1);
    console.log(`[sync-live] skipped ${testTeams.size} test team(s): ${[...testTeams].slice(0, 10).join(", ")}`);
  }

  // figure out which (team,dept) are genuinely new (for reporting)
  const { data: existing, error: exErr } = await readAll("roi_live_departments", "team_id,department", { order: ["team_id", "department"] });
  if (exErr) throw new Error(`read roi_live_departments failed: ${exErr.message}`);
  const have = new Set((existing ?? []).map((e) => `${e.team_id}|${e.department}`));
  const fresh = cand.filter((c) => !have.has(`${c.team_id}|${c.department}`));

  // insert — ignoreDuplicates so existing rows (and their human flags) are untouched
  for (let i = 0; i < cand.length; i += 500) {
    const { error } = await sb.from("roi_live_departments")
      .upsert(cand.slice(i, i + 500), { onConflict: "team_id,department", ignoreDuplicates: true });
    if (error) throw new Error(`upsert roi_live_departments failed: ${error.message}`);
  }

  // A discovered team with no roi_rooftop_config row could not be configured at all (the tracker's
  // config endpoint 404s) and would send under a blank name if flipped live (58 teams on 2026-10-09).
  // Seed a default row: identifiers + the team's name, every toggle at its column default. Sending stays
  // held by the live row's dry_run=true. ignoreDuplicates: an existing row is never touched.
  let configsCreated = 0;
  try {
    const { data: cfgRows, error: cfgErr } = await readAll("roi_rooftop_config", "team_id");
    if (cfgErr) throw new Error(cfgErr.message);
    const haveCfg = new Set((cfgRows || []).map((r) => r.team_id));
    const seeds = [...new Set(cand.map((c) => c.team_id))]
      .filter((t) => !haveCfg.has(t) && info.has(t) && info.get(t).team_name && !isTestTeam(t, info))
      .map((t) => ({ team_id: t, enterprise_id: entOf.get(t) || info.get(t).enterprise_id || null, team_name: info.get(t).team_name, rooftop_name: info.get(t).team_name }));
    for (let i = 0; i < seeds.length; i += 500) {
      const { error } = await sb.from("roi_rooftop_config").upsert(seeds.slice(i, i + 500), { onConflict: "team_id", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    configsCreated = seeds.length;
    if (seeds.length) console.log(`[sync-live] created ${seeds.length} default roi_rooftop_config row(s): ${seeds.slice(0, 10).map((x) => x.team_name).join(", ")}`);
  } catch (e) { console.warn("[sync-live] default config rows skipped:", String(e && e.message ? e.message : e).slice(0, 140)); }

  const summary = { candidates: cand.length, skipped_ineligible: skipped, skipped_test: testTeams.size, from_activity: fromActivity, new_rooftops: fresh.length, configs_created: configsCreated, new_list: fresh.map((c) => `${c.team_id}:${c.department}`).slice(0, 100) };
  await sb.from("roi_cron_runs").insert({ source: "sync-live", ok: true, summary }).then(() => {}, () => {});
  console.log(`[sync-live] eligible candidates=${cand.length} (${fromActivity} from call activity, skipped ${skipped} outside Live/active-minus-churn) new=${fresh.length}`);
  return { ranAt: ts, ...summary };
}

// ── Rooftop LIFECYCLE sync (onboarding/contracting/live/churn) ──────────────
// Pulls EVERY Vini rooftop's ARR/lifecycle bucket from ClickHouse (the canonical
// Contract-Initiated → PWS → Onboarding → OB-Live → Live → Churned progression —
// see db/clickhouse-endpoints/lifecycle.sql) and upserts it into roi_rooftop_config.
// Unlike syncLive (additive-only, ignoreDuplicates), this OVERWRITES the lifecycle
// columns every run — they're meant to reflect the CURRENT bucket, not a one-time
// discovery. Safe because the upsert payload below ONLY ever contains these
// lifecycle columns: Postgres `ON CONFLICT DO UPDATE` only touches columns present
// in the payload, so daily_enabled/recipients/template/etc. (human-set config) are
// never touched — this is what lets a rooftop be pre-configured during onboarding
// without the lifecycle sync clobbering it later.
//
// >>> DO NOT add lifecycle_status_override to the patch payload below. <<<
// That column is a human's durable answer to "what stage is this really in", and it survives this
// cron precisely BECAUSE the payload omits it (ON CONFLICT DO UPDATE only touches columns present).
// Adding it here would silently reintroduce the flapping it exists to fix — four rooftops set to
// 'live' on 2026-07-30 were back to 'onboarding' by the next 05:10 run. Read paths use the generated
// lifecycle_effective column instead; see src/programs/schema-lifecycle-override.sql. lifecycle_status
// itself SHOULD keep being overwritten here — it stays the ledger's own value, underneath.
const ARR_BUCKET_TO_LIFECYCLE = {
  "Contract-Initiated": "contracting",
  "PWS": "contracting",
  "Onboarding": "onboarding",
  "OB-Live": "onboarding",
  "Live": "live",
  "Churned": "churn",
};
// ARR/lifecycle ledger query — every Vini rooftop's Contract-Initiated → PWS → Onboarding → OB-Live →
// Live → Churned bucket, from the canonical ARR change-event ledger. Embedded (mirror of
// db/clickhouse-endpoints/lifecycle.sql) so the serverless bundle carries it. Column aliases match the
// row mapping below. runClickhouse appends `FORMAT JSONEachRow`, so no trailing semicolon / FORMAT here.
const LIFECYCLE_SQL = `WITH vini_teams AS (
  SELECT DISTINCT ace.teamId
  FROM credit_v2.arrChangeEvents ace
  INNER JOIN (
    SELECT DISTINCT product_line_details_id
    FROM aggregated_data.aggregated_product_line_details
    WHERE product_line_registry_id = '68ff7a65befb847b44b6d1b8'
      AND _peerdb_is_deleted = 0
  ) ids ON ace.entityId = ids.product_line_details_id
  WHERE ace.entityType = 'product-line'
    AND ace.arrType    = 'CARR'
    AND ace.__deleted  = 0
),
product_curr AS (
  SELECT
    ace.teamId,
    ace.enterpriseId,
    ace.entityId                                     AS product_id,
    argMax(toFloat64OrNull(ace.newArr), ace.eventAt) AS curr_arr,
    countIf(ace.eventType = 'churn') > 0             AS is_product_churned
  FROM credit_v2.arrChangeEvents ace
  INNER JOIN vini_teams vt ON ace.teamId = vt.teamId
  WHERE ace.entityType = 'product'
    AND ace.arrType    = 'CARR'
    AND ace.__deleted  = 0
  GROUP BY ace.teamId, ace.enterpriseId, ace.entityId
),
team_product_agg AS (
  SELECT
    teamId,
    any(enterpriseId)                         AS enterpriseId,
    sumIf(curr_arr, is_product_churned = 0)   AS contracted_arr,
    (countIf(is_product_churned = 0) = 0)     AS is_churned
  FROM product_curr
  GROUP BY teamId
)
SELECT
  tpa.teamId                                                   AS t,
  tpa.enterpriseId                                             AS e,
  COALESCE(apld.enterprise_name, ed.name, tpa.enterpriseId)    AS enterprise_name,
  COALESCE(apld.team_name, etd.team_name, tpa.teamId)          AS team_name,
  apld.ae_poc_email                                            AS ae_poc,
  apld.ob_poc_email                                            AS ob_poc,
  CASE
    WHEN tpa.is_churned = 1                                       THEN 'Churned'
    WHEN apld.live_date IS NOT NULL                               THEN 'Live'
    WHEN apld.ob_live_date IS NOT NULL AND apld.live_date IS NULL THEN 'OB-Live'
    WHEN apld.onboarding_date IS NOT NULL                         THEN 'Onboarding'
    WHEN apld.contracted_date IS NOT NULL                         THEN 'PWS'
    ELSE 'Contract-Initiated'
  END                                                          AS arr_bucket,
  apld.contracted_date,
  apld.onboarding_date                                         AS ob_start_date,
  apld.ob_live_date,
  apld.live_date,
  apld.churn_date
FROM team_product_agg tpa
LEFT JOIN aggregated_data.aggregated_product_line_details apld
  ON tpa.teamId = apld.team_id
  AND apld.product_line_registry_id = '68ff7a65befb847b44b6d1b8'
  AND apld.is_test_account = 0
  AND apld._peerdb_is_deleted = 0
LEFT JOIN eventila.enterprise_team_details etd
  ON tpa.teamId = etd.team_id
  AND etd.is_test_account = 0
LEFT JOIN eventila.enterprise_details ed
  ON tpa.enterpriseId = ed.enterprise_id`;

// Operational-activity rollup — per-team calls + SMS in the last 30 days, from dealer_leads (calls from
// endcallreports, SMS conversations from conversations). UNION-ALL then aggregate so one pass covers both
// tables. Orthogonal to lifecycle: answers "is the AI actually working for this rooftop right now" — a
// contracting/onboarding rooftop can already be handling live traffic.
const ACTIVITY_SQL = `SELECT
  t,
  sum(calls_30d)     AS calls_30d,
  sum(sms_30d)       AS sms_30d,
  max(last_activity) AS last_activity_at
FROM (
  SELECT teamId AS t, uniqExact(callId) AS calls_30d, 0 AS sms_30d, max(createdAt) AS last_activity
  FROM dealer_leads.endcallreports
  WHERE isTestCall = 0 AND createdAt >= today() - 30 AND teamId != ''
  GROUP BY teamId
  UNION ALL
  SELECT teamId AS t, 0 AS calls_30d, count(DISTINCT conversationId) AS sms_30d, max(createdAt) AS last_activity
  FROM dealer_leads.conversations
  WHERE type = 'sms' AND createdAt >= today() - 30 AND teamId != ''
  GROUP BY teamId
)
GROUP BY t`;

async function syncLifecycle() {
  const ts = new Date().toISOString();
  if (!SB_URL || !SB_KEY) throw new Error("Missing ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY");
  // Query the ARR/lifecycle ledger through the SAME ClickHouse client the rest of the app uses
  // (CLICKHOUSE_HOST/USER/PASSWORD — already provisioned in prod), NOT a bespoke ClickHouse Cloud
  // query-endpoint. The endpoint path needed 3 extra secrets (CLICKHOUSE_LIFECYCLE_ENDPOINT/KEY_ID/
  // KEY_SECRET) that were never set, so this cron errored every morning. credit_v2 + aggregated_data
  // are reachable by that client (verified). Falls through the shared concurrency cap in agentMetrics.
  const { runClickhouse } = await import("../agentMetrics.js");
  const rows = await runClickhouse(LIFECYCLE_SQL);

  const patches = [];
  for (const r of rows) {
    const team_id = String(r.t ?? r.team_id ?? "").trim();
    if (!team_id) continue;
    const arr_bucket = r.arr_bucket ?? null;
    const lifecycle_status = ARR_BUCKET_TO_LIFECYCLE[arr_bucket] ?? "live";
    patches.push({
      team_id,
      enterprise_id: r.e ?? r.enterprise_id ?? null,
      enterprise_name: r.enterprise_name ?? null,
      team_name: r.team_name ?? null,
      ae_poc: r.ae_poc || null,
      ob_poc: r.ob_poc || null,
      arr_bucket,
      lifecycle_status,
      contracted_date: r.contracted_date ?? null,
      onboarding_date: r.ob_start_date ?? r.onboarding_date ?? null,
      ob_live_date: r.ob_live_date ?? null,
      live_date: r.live_date ?? null,
      churn_date: r.churn_date ?? null,
      lifecycle_synced_at: ts,
    });
  }

  // LIFECYCLE_SQL fans out CDC-duplicate ledger rows (2026-07-17: 804 rows over 321 teams — 278
  // exact-duplicate groups, 2 teams with differing copies). An upsert batch holding the same
  // team_id twice makes Postgres throw 21000 ("ON CONFLICT DO UPDATE command cannot affect row a
  // second time") — the crash that kept this cron from ever completing in prod. Merge per team:
  // non-null wins, the later value wins for lifecycle dates, a Churned copy wins the bucket.
  const LIFECYCLE_DATE_FIELDS = ["contracted_date", "onboarding_date", "ob_live_date", "live_date", "churn_date"];
  const byTeam = new Map();
  for (const p of patches) {
    const prev = byTeam.get(p.team_id);
    if (!prev) { byTeam.set(p.team_id, p); continue; }
    for (const [k, v] of Object.entries(p)) {
      if (v == null) continue;
      if (prev[k] == null) { prev[k] = v; continue; }
      if (LIFECYCLE_DATE_FIELDS.includes(k) && String(v) > String(prev[k])) prev[k] = v;
    }
    if (p.arr_bucket === "Churned") { prev.arr_bucket = "Churned"; prev.lifecycle_status = "churn"; }
  }
  const merged = [...byTeam.values()];

  // A past churn_date always means Churned. The ledger's bucket CASE lags it — is_churned needs
  // product-level churn events that are often missing, which is why 12 rooftops sat Live/Onboarding
  // with a past churn_date (the 2026-07-15 manual fix-up) and would be resurrected on every sync.
  for (const p of merged) {
    if (p.churn_date && String(p.churn_date).slice(0, 10) <= ts.slice(0, 10)) {
      p.arr_bucket = "Churned";
      p.lifecycle_status = "churn";
    }
  }

  // Manual churn is sticky: user-confirmed churns (e.g. the Edwards group) can have NO churn
  // signal in the ledger at all. Never downgrade a rooftop already churn in roi_rooftop_config,
  // and never blank a stored churn_date. (~320 rows — under PostgREST's 1000-row cap.)
  const { data: existingRows, error: exErr } = await readAll("roi_rooftop_config", "team_id,lifecycle_status,churn_date");
  if (exErr) throw new Error(`read roi_rooftop_config (churn guard) failed: ${exErr.message}`);
  const existing = new Map((existingRows ?? []).map((e) => [e.team_id, e]));
  let preservedChurn = 0;
  for (const p of merged) {
    const ex = existing.get(p.team_id);
    if (!ex) continue;
    if (ex.churn_date && !p.churn_date) p.churn_date = ex.churn_date;
    if (ex.lifecycle_status === "churn" && p.lifecycle_status !== "churn") {
      p.arr_bucket = "Churned";
      p.lifecycle_status = "churn";
      preservedChurn++;
    }
  }

  // Merge the operational-activity rollup onto the same rows (best-effort — a failure here must not
  // break the lifecycle sync). Epoch/1970 timestamps (no real activity) are nulled.
  try {
    const actRows = await runClickhouse(ACTIVITY_SQL);
    const act = new Map(actRows.map((a) => [String(a.t ?? "").trim(), a]));
    for (const p of merged) {
      const a = act.get(p.team_id);
      p.calls_30d = a ? (Number(a.calls_30d) || 0) : 0;
      p.sms_30d = a ? (Number(a.sms_30d) || 0) : 0;
      p.last_activity_at = (a && a.last_activity_at && !/^(0000|1970)/.test(String(a.last_activity_at))) ? a.last_activity_at : null;
      p.activity_synced_at = ts;
    }
  } catch (e) { console.warn("[sync-lifecycle] activity rollup skipped:", String(e).slice(0, 140)); }

  for (let i = 0; i < merged.length; i += 500) {
    const { error } = await sb.from("roi_rooftop_config")
      .upsert(merged.slice(i, i + 500), { onConflict: "team_id" });
    if (error) throw new Error(`upsert roi_rooftop_config (lifecycle) failed: ${error.message}`);
  }

  const byStatus = merged.reduce((acc, p) => { acc[p.lifecycle_status] = (acc[p.lifecycle_status] ?? 0) + 1; return acc; }, {});
  const activeRooftops = merged.filter((p) => (p.calls_30d || 0) + (p.sms_30d || 0) > 0).length;
  const summary = { rooftops: merged.length, dedupedFrom: patches.length, preservedChurn, activeRooftops, byStatus };
  await sb.from("roi_cron_runs").insert({ source: "sync-lifecycle", ok: true, summary }).then(() => {}, () => {});
  console.log(`[sync-lifecycle] rooftops=${merged.length} (deduped from ${patches.length}, preserved ${preservedChurn} manual churn)`, JSON.stringify(byStatus));
  return { ranAt: ts, ...summary };
}

// Failure trail for the sync crons. Success writes its own ok:true roi_cron_runs row inside each
// sync — but a crash used to vanish (the trail was success-only and the route just 500s into
// Vercel logs nobody watches): sync-lifecycle failed every scheduled prod run since it shipped
// with zero trace. Record ok:false + raise the systemic Slack alert, then rethrow so the route
// still returns 500.
function withCronTrail(source, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const detail = String(err?.message ?? err).slice(0, 300);
      await sb.from("roi_cron_runs").insert({ source, ok: false, summary: { error: detail } }).then(() => {}, () => {});
      try {
        const { postSystemicAlert } = require("./slackAlert.cjs");
        await postSystemicAlert({ source, title: `${source} cron FAILED`, detail, windowLabel: "daily sync cron" });
      } catch { /* best-effort */ }
      throw err;
    }
  };
}

// Importable surface for the Vercel serverless cron + tests.
module.exports = {
  runOnce, runCadence, generateAndSendNow, previewDigestNow, backfill, rerender, renderStoredDigest, renderHtml, renderHtmlV1, renderDigest, pickTemplate, sendMail,
  syncLive: withCronTrail("sync-live", syncLive), syncLifecycle: withCronTrail("sync-lifecycle", syncLifecycle),
  apiMetrics, apiActionItems, apiCampaigns, buildDigestMetrics,
  // pure helpers (tests + the tracker routes)
  windowForPeriod, cadenceWindow, onDemandWindow, links, rooftopRungsFor, nextReportLabel, prioritize,
};

// CLI entrypoint — only runs when invoked directly (`node runner.cjs ...`), never on require.
if (IS_CLI) {
  (async () => {
    if (RERENDER_ONLY) { await rerender(); return; }
    const bf = process.argv.indexOf("--backfill");
    if (bf !== -1) {
      const start = process.argv[bf + 1], end = process.argv[bf + 2];
      if (!start || !end) { console.error("usage: node runner.cjs --backfill 2026-06-03 2026-06-09"); process.exit(1); }
      await backfill(start, end);
      return;
    }
    // The CLI is the ONE entry that honours the operator knobs (ONLY_TEAMS, IGNORE_SEND_HOUR,
    // RUN_LOCAL_DATE, FORCE_RESEND, IGNORE_SEND_DAY); the scheduled cron ignores them.
    const cad = process.argv.indexOf("--cadence");
    if (cad !== -1) { await runCadence(process.argv[cad + 1], { cli: true }); return; }
    await runOnce({ cli: true });
    if (process.argv.includes("--loop")) {
      console.log("\n[loop] next pass in 60 min …");
      setInterval(() => { runOnce({ cli: true }).catch((e) => console.error("pass failed:", e)); }, 60 * 60 * 1000);
    }
  })();
}
