// ── Cron PREFLIGHT + cron auth ────────────────────────────────────────────────────────────────
// Each past "silent for days" incident had a cause that was knowable before the pass started: the
// Slack token was never set (every alert went to a log), Twilio's credentials had been revoked (SMS
// 401 for a week), a migration re-run narrowed a status check or dropped a column (every send 400'd),
// a secret was misnamed. preflight() checks those things cheaply at the start of every email-tracker
// cron pass and reports them ONCE per 6h, then lets the pass continue: a missing Slack token must
// not stop dealers' emails. Only a problem the pass cannot survive (no Supabase credentials) is fatal.
//
//   const { ok, problems } = await preflightGate({ source: "roi-email-daily" });
//
// Cost: memoised per warm instance for 10 min. A fresh check is ~8 parallel `limit(0)` selects
// (PostgREST still validates every column against the schema with LIMIT 0) plus, at most once a day
// across all instances, one read-only Twilio account fetch (no SMS is sent).
//
// Not checked: the check-constraint VALUES (e.g. that roi_digest_runs.status accepts 'sending').
// That needs pg_constraint, which PostgREST only exposes through an RPC, and none exists. The status
// writes themselves fail loudly per row (they surface as send errors), so this is a gap in early
// warning only.
"use strict";

const crypto = require("node:crypto");

const MIN = 60_000;
const HOUR = 60 * MIN;
const TTL_MS = 10 * MIN;
const DEDUPE_MS = 6 * HOUR;
const TWILIO_PROBE_EVERY_MS = 24 * HOUR;
const PREFLIGHT_SOURCE = "roi-preflight";
const TWILIO_SOURCE = "roi-preflight-twilio";

// Columns the send paths read or write, per table (runner.cjs, eventRunner.cjs, emailHealth.cjs,
// subscriptions.cjs, the watchdog). A column dropped or renamed here breaks a pass at run time.
const REQUIRED_COLUMNS = {
  roi_live_departments: "team_id,department,is_live,dry_run",
  roi_rooftop_config: "team_id,enterprise_id,rooftop_name,team_name,timezone,digest_send_hour,digest_send_minute,daily_enabled,weekly_enabled,monthly_enabled,daily_template,digest_focus,sms_enabled,weekly_send_dow,monthly_send_day,lifecycle_status,churn_date,post_appointment_enabled,post_conversation_enabled,chat_enabled,action_item_enabled,action_item_overdue_enabled,post_conversation_mode,post_conversation_outbound_requires_reply,post_conversation_template,action_item_sla_minutes,sms_post_conversation_cadence,working_hours",
  roi_recipients: "id,team_id,email,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at,suppressed_at,suppression_reason,bounce_count,last_bounce_at",
  roi_digest_runs: "id,enterprise_id,team_id,department,cadence,local_date,dealer_timezone,status,reason,reason_detail,metrics,rendered_html,subject,recipients,send_path,trigger,message_id,sent_at,created_at",
  roi_event_emails: "id,team_id,enterprise_id,department,email_type,event_key,status,reason,recipients,subject,rendered_html,message_id,sent_at,created_at",
  roi_event_sms: "id,team_id,enterprise_id,department,email_type,event_key,status,reason,recipients,body,message_sid,sent_at,created_at",
  roi_cron_runs: "id,source,ok,summary,created_at",
};

const isMissingColumn = (e) => e && (String(e.code) === "42703" || /column .* does not exist/i.test(String(e.message || "")));
const short = (s, n = 200) => String(s ?? "").slice(0, n);

// ── E4: cron routes fail CLOSED ───────────────────────────────────────────────────────────────
// Was `if (secret && header !== …)`: with CRON_SECRET unset every cron route (including the ones that
// email dealers) answered anyone on the internet. Now an unset secret refuses every caller, and says
// so in Slack once per 6h per instance, because Vercel's own cron calls are refused too.
let _secretAlertAt = 0;
function cronAuthorized(req, { post } = {}) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set: refusing the request (cron routes fail closed). Set CRON_SECRET in the Vercel project.");
    if (Date.now() - _secretAlertAt > DEDUPE_MS) {
      _secretAlertAt = Date.now();
      const poster = post || require("./slackAlert.cjs").postSystemicAlert;
      Promise.resolve().then(() => poster({ source: "Cron auth", title: "CRON_SECRET is not set: every cron is refused", detail: "All /api/cron/* routes fail closed without CRON_SECRET, so no digest, event email or SMS pass is running. Set CRON_SECRET in the Vercel project env.", windowLabel: "cron auth" })).catch(() => {});
    }
    return false;
  }
  const got = Buffer.from(String((req && req.headers && req.headers.authorization) || ""));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ── env ───────────────────────────────────────────────────────────────────────────────────────
function checkEnv(env) {
  const p = [];
  const add = (key, detail, fatal = false) => p.push({ check: "env", key: `env:${key}`, fatal, detail });
  if (!env.ROI_SUPABASE_URL || !env.ROI_SUPABASE_SERVICE_KEY) add("supabase", "ROI_SUPABASE_URL / ROI_SUPABASE_SERVICE_KEY not set: no pass can read or record anything", true);
  if (!env.MAIL_TOKEN) add("MAIL_TOKEN", "MAIL_TOKEN not set: the mail gateway call goes out unauthenticated");
  if (!env.CRON_SECRET) add("CRON_SECRET", "CRON_SECRET not set: every /api/cron/* route refuses Vercel's calls");
  if (!env.REPORTING_CRON_SECRET && !env.CRON_SECRET) add("REPORTING_CRON_SECRET", "neither REPORTING_CRON_SECRET nor CRON_SECRET is set: reporting-vini /api/reports calls are unauthenticated (digests hold as no_data)");
  if (!env.SLACK_BOT_TOKEN) add("SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN not set: every breakage/systemic alert (this one included) only goes to the function log");
  // Overrides that are for local testing only and silently change who gets mailed in production.
  if (env.FORCE_RESEND === "true") add("FORCE_RESEND", "FORCE_RESEND=true: every hourly pass re-sends digests that were already sent");
  if (env.IGNORE_SEND_HOUR === "true") add("IGNORE_SEND_HOUR", "IGNORE_SEND_HOUR=true: digests go out at whatever hour the pass runs, including overnight");
  if (env.IGNORE_SEND_DAY === "true") add("IGNORE_SEND_DAY", "IGNORE_SEND_DAY=true: weekly/monthly digests send every day");
  if (env.ONLY_TEAMS) add("ONLY_TEAMS", `ONLY_TEAMS is set (${short(env.ONLY_TEAMS, 60)}): every other rooftop is silently skipped`);
  if (env.RUN_LOCAL_DATE) add("RUN_LOCAL_DATE", `RUN_LOCAL_DATE=${short(env.RUN_LOCAL_DATE, 20)}: the scheduled pass is pinned to one date`);
  return p;
}
function checkTwilioEnv(env) {
  const p = [];
  const add = (key, detail) => p.push({ check: "twilio", key: `twilio:${key}`, fatal: false, detail });
  if (!env.TWILIO_ACCOUNT_SID) add("TWILIO_ACCOUNT_SID", "SMS is enabled for a rooftop but TWILIO_ACCOUNT_SID is not set");
  if (!env.TWILIO_API_KEY_SECRET && !env.TWILIO_AUTH_TOKEN) add("secret", "SMS is enabled for a rooftop but neither TWILIO_API_KEY_SECRET nor TWILIO_AUTH_TOKEN is set");
  if (!env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM) add("from", "SMS is enabled for a rooftop but neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_FROM is set");
  return p;
}

// ── schema ────────────────────────────────────────────────────────────────────────────────────
// One `limit(0)` select per table. On a missing column Postgres names only the first, so the failing
// table is re-probed column by column to list every missing one in a single alert.
async function checkSchema(sb, required = REQUIRED_COLUMNS) {
  const p = [];
  await Promise.all(Object.entries(required).map(async ([table, cols]) => {
    const { error } = await sb.from(table).select(cols).limit(0);
    if (!error) return;
    if (isMissingColumn(error)) {
      const list = cols.split(",");
      const res = await Promise.all(list.map(async (c) => ({ c, e: (await sb.from(table).select(c).limit(0)).error })));
      const missing = res.filter((r) => isMissingColumn(r.e)).map((r) => r.c);
      p.push({ check: "schema", key: `schema:${table}`, fatal: false, detail: `${table} is missing column(s) the send path uses: ${(missing.length ? missing : [short(error.message, 120)]).join(", ")}. A migration was not applied or was re-run out of order.` });
      return;
    }
    p.push({ check: "schema", key: `schema:${table}`, fatal: false, detail: `${table}: ${short(error.message)}` });
  }));
  return p;
}

// ── Twilio auth probe (read-only account fetch; never sends) ──────────────────────────────────
const twilioCredFingerprint = (env) => crypto.createHash("sha256")
  .update(`${env.TWILIO_ACCOUNT_SID || ""}|${env.TWILIO_API_KEY_SID || ""}|${env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN || ""}`).digest("hex").slice(0, 12);
async function probeTwilio(env, fetchImpl = globalThis.fetch) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const user = env.TWILIO_API_KEY_SID || sid;
  const secret = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;
  try {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      method: "GET",
      headers: { Authorization: "Basic " + Buffer.from(`${user}:${secret}`).toString("base64") },
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) return { ok: false, httpStatus: res.status, code: body.code ?? null };
    if (!res.ok) return { ok: null, httpStatus: res.status, code: body.code ?? null };
    return { ok: body.status ? body.status === "active" : true, httpStatus: res.status, accountStatus: body.status ?? null };
  } catch (e) {
    return { ok: null, error: short(e?.message ?? e, 120) };
  }
}
let _twilioMemo = null; // { at, fp, result }
async function twilioStatus(sb, env, fetchImpl, now) {
  const fp = twilioCredFingerprint(env);
  if (_twilioMemo && _twilioMemo.fp === fp && now - _twilioMemo.at < TWILIO_PROBE_EVERY_MS) return _twilioMemo.result;
  // Shared across instances: reuse a probe any instance ran in the last 24h with these credentials.
  try {
    const { data } = await sb.from("roi_cron_runs").select("summary,created_at").eq("source", TWILIO_SOURCE).order("created_at", { ascending: false }).limit(1);
    const last = data && data[0];
    if (last && last.summary && last.summary.fp === fp && now - new Date(last.created_at).getTime() < TWILIO_PROBE_EVERY_MS) {
      _twilioMemo = { at: new Date(last.created_at).getTime(), fp, result: last.summary.result };
      return last.summary.result;
    }
  } catch { /* fall through to a probe */ }
  const result = await probeTwilio(env, fetchImpl);
  _twilioMemo = { at: now, fp, result };
  if (result.ok !== null) { // record only a definite answer, so a network blip re-probes next time
    try { await sb.from("roi_cron_runs").insert({ source: TWILIO_SOURCE, ok: result.ok === true, summary: { fp, result } }); } catch { /* best-effort */ }
  }
  return result;
}

function defaultSb(env) {
  if (!env.ROI_SUPABASE_URL || !env.ROI_SUPABASE_SERVICE_KEY) return null;
  const { createClient } = require("@supabase/supabase-js");
  return createClient(env.ROI_SUPABASE_URL, env.ROI_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

let _memo = null; // { at, result }
/**
 * @param {object} [o]
 * @param {string} [o.source]  the calling cron (roi_cron_runs source name)
 * @param {object} [o.sb]      Supabase client (default from env)
 * @param {Function} [o.fetch] fetch for the Twilio probe (tests)
 * @param {object} [o.env]     env (default process.env)
 * @param {boolean} [o.fresh]  skip the 10-min memo
 * @returns {Promise<{ok:boolean, problems:Array<{check,key,fatal,detail}>, notes:string[], cached:boolean, elapsedMs:number}>}
 */
async function preflight(o = {}) {
  const now = o.now ?? Date.now();
  if (!o.fresh && _memo && now - _memo.at < TTL_MS) return { ..._memo.result, cached: true };
  const started = Date.now();
  const env = o.env || process.env;
  const problems = checkEnv(env);
  const notes = ["check-constraint values not verified (no RPC exposes pg_constraint)"];
  const sb = o.sb || defaultSb(env);
  if (sb) {
    const guard = async (name, fn) => { try { return await fn(); } catch (e) { problems.push({ check: "supabase", key: `supabase:${name}`, fatal: false, detail: `${name} check failed: ${short(e?.message ?? e)}` }); return null; } };
    const [schema, smsOn] = await Promise.all([
      guard("schema", () => checkSchema(sb)),
      guard("sms_enabled", async () => {
        const { data, error } = await sb.from("roi_rooftop_config").select("team_id").eq("sms_enabled", true).limit(1);
        if (error) throw new Error(error.message);
        return Boolean(data && data.length);
      }),
    ]);
    if (schema) problems.push(...schema);
    if (smsOn) {
      const envP = checkTwilioEnv(env);
      problems.push(...envP);
      if (env.SMS_DRY_RUN !== "false") notes.push("SMS_DRY_RUN is on: SMS is held fleet-wide");
      if (!envP.some((p) => p.key !== "twilio:from")) {
        const t = await guard("twilio", () => twilioStatus(sb, env, o.fetch, now));
        if (t && t.ok === false) {
          problems.push({ check: "twilio", key: "twilio:auth", fatal: false,
            detail: t.httpStatus === 401 || t.httpStatus === 403
              ? `Twilio rejected the credentials (HTTP ${t.httpStatus}${t.code ? `, code ${t.code}` : ""}): every SMS fails. Rotate TWILIO_AUTH_TOKEN / the API key, or check the account.`
              : `Twilio account status is "${t.accountStatus}", not active: SMS will not send.` });
        } else if (t && t.ok === null) notes.push(`Twilio probe inconclusive (${t.httpStatus ?? t.error})`);
      }
    }
  }
  const result = { ok: !problems.some((p) => p.fatal), problems, notes, cached: false, elapsedMs: Date.now() - started, source: o.source || null };
  _memo = { at: now, result };
  return result;
}

// Alert once per 6h per problem key. Dedupe state: roi_cron_runs rows with source "roi-preflight"
// (summary.alerted), written only when an alert actually went out. Without Supabase, per instance.
const _memAlerted = new Map();
async function alertProblems(result, { sb, post, source, now = Date.now(), env = process.env } = {}) {
  if (!result.problems.length) return { alerted: [] };
  const done = new Set();
  for (const [k, at] of _memAlerted) if (now - at < DEDUPE_MS) done.add(k);
  if (sb) {
    try {
      const { data } = await sb.from("roi_cron_runs").select("summary,created_at").eq("source", PREFLIGHT_SOURCE).gte("created_at", new Date(now - DEDUPE_MS).toISOString()).order("created_at", { ascending: false }).range(0, 999);
      for (const r of data || []) for (const k of (r.summary && r.summary.alerted) || []) done.add(k);
    } catch { /* dedupe best-effort */ }
  }
  const fresh = result.problems.filter((p) => !done.has(p.key));
  if (!fresh.length) return { alerted: [] };
  const poster = post || require("./slackAlert.cjs").postSystemicAlert;
  const fatal = fresh.some((p) => p.fatal);
  try {
    await poster({
      source: "Cron preflight",
      title: `${fresh.length} configuration problem${fresh.length === 1 ? "" : "s"} before ${source || "a cron pass"}${fatal ? " (pass ABORTED)" : ""}`,
      detail: fresh.map((p) => `\n  • ${p.fatal ? "[FATAL] " : ""}${p.detail}`).join("") + (fatal ? "" : "\nThe pass continued."),
      windowLabel: `${source || "cron"} preflight`,
    });
  } catch (e) { console.error("[preflight] alert post failed:", short(e?.message ?? e)); return { alerted: [], error: short(e?.message ?? e) }; }
  // Without a Slack token the poster only logs; leave the keys un-alerted so they post once it is set.
  if (!env.SLACK_BOT_TOKEN && !post) return { alerted: [] };
  const keys = fresh.map((p) => p.key);
  for (const k of keys) _memAlerted.set(k, now);
  if (sb) { try { await sb.from("roi_cron_runs").insert({ source: PREFLIGHT_SOURCE, ok: !fatal, summary: { from: source || null, alerted: keys, problems: result.problems } }); } catch { /* best-effort */ } }
  return { alerted: keys };
}

/** Run at the start of each email-tracker cron route. Never throws; alerts at most once per 6h per
 *  problem; returns { ok:false } only when the pass cannot run at all. */
async function preflightGate({ source, sb, post, fetch, env } = {}) {
  try {
    const e = env || process.env;
    const client = sb || defaultSb(e);
    const r = await preflight({ source, sb: client, fetch, env: e });
    if (r.problems.length) {
      console.warn(`[preflight:${source}] ${r.problems.length} problem(s): ${r.problems.map((p) => p.key).join(", ")}`);
      if (!r.cached) await alertProblems(r, { sb: client, post, source, env: e });
    }
    return r;
  } catch (e) {
    console.error(`[preflight:${source}] threw (pass continues):`, short(e?.message ?? e));
    return { ok: true, problems: [], notes: [`preflight threw: ${short(e?.message ?? e)}`], cached: false };
  }
}

const _reset = () => { _memo = null; _twilioMemo = null; _memAlerted.clear(); _secretAlertAt = 0; };

module.exports = {
  preflight, preflightGate, alertProblems, cronAuthorized,
  checkEnv, checkTwilioEnv, checkSchema, probeTwilio,
  REQUIRED_COLUMNS, PREFLIGHT_SOURCE, TWILIO_SOURCE, _reset,
};
