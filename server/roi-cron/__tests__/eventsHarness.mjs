/* Shared OFFLINE harness for the events-pass tests (events*.test.mjs, sms*.test.mjs, appt*.test.mjs).
 *
 * Nothing here reaches a network: Supabase is a stateful in-memory fake installed through require.cache
 * (with the ledger's unique (team_id, email_type, event_key) enforced), and every fetch is routed to a
 * fake — reporting-vini feeds, ClickHouse (answered per query shape), the mail proxy and Twilio. Modules
 * that read env at load are dropped from require.cache on every load(), so each test gets its own env.
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
export const RUNNER = require.resolve("../eventRunner.cjs");
const SUPABASE = require.resolve("@supabase/supabase-js", { paths: [RUNNER] });
const ROI_DIR = path.dirname(RUNNER);
const EMAIL_DIR = path.resolve(ROI_DIR, "../../src/email");

// ── stateful fake Supabase ────────────────────────────────────────────────────────────────────────
export function fakeSupabase(log, tables) {
  const UNIQUE = { roi_event_emails: ["team_id", "email_type", "event_key"], roi_event_sms: ["team_id", "email_type", "event_key"] };
  let seq = 0;
  const match = (row, filters) => filters.every(([op, k, v]) => {
    if (op === "eq") return row[k] === v;
    if (op === "in") return v.includes(row[k]);
    if (op === "lt") return String(row[k]) < String(v);
    if (op === "gte") return String(row[k]) >= String(v);
    return true;
  });
  return {
    createClient: () => ({
      from(table) {
        const q = { table, op: "select", filters: [], returning: false };
        const b = {
          select() { if (q.op !== "select") q.returning = true; return b; },
          eq(k, v) { q.filters.push(["eq", k, v]); return b; },
          in(k, v) { q.filters.push(["in", k, v]); return b; },
          lt(k, v) { q.filters.push(["lt", k, v]); return b; },
          gte(k, v) { q.filters.push(["gte", k, v]); return b; },
          order() { return b; }, limit(n) { q.limit = n; return b; }, range(a, z) { q.range = [a, z]; return b; },
          maybeSingle() { return b; }, single() { return b; },
          insert(row) { q.op = "insert"; q.row = row; return b; },
          update(patch) { q.op = "update"; q.patch = patch; return b; },
          then(res, rej) {
            log.sb.push(q);
            const rows = tables[table] || (tables[table] = []);
            let out = { data: null, error: null };
            if (q.op === "select" && tables.__selectError && tables.__selectError[table]) {
              out = { data: null, error: tables.__selectError[table] };
            } else if (q.op === "select") {
              let data = rows.filter((r) => match(r, q.filters));
              if (q.range) data = data.slice(q.range[0], q.range[1] + 1);
              if (q.limit) data = data.slice(0, q.limit);
              out = { data: data.map((r) => ({ ...r })), error: null };
            } else if (q.op === "insert") {
              const keys = UNIQUE[table];
              if (keys && rows.some((r) => keys.every((k) => r[k] === q.row[k]))) {
                out = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
              } else {
                const row = { id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...q.row };
                rows.push(row);
                out = { data: [{ id: row.id }], error: null };
              }
            } else if (q.op === "update") {
              const hit = rows.filter((r) => match(r, q.filters));
              for (const r of hit) Object.assign(r, q.patch);
              out = { data: hit.map((r) => ({ id: r.id })), error: null };
            }
            return Promise.resolve(out).then(res, rej);
          },
        };
        return b;
      },
    }),
  };
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
export const recipient = (team, email, o = {}) => ({
  id: `rec-${team}-${email}`, team_id: team, email, receives_sales: !!o.sales, receives_service: !!o.service,
  email_enabled: true, verified_at: "2026-09-01T00:00:00Z", phone: o.phone || null, sms_enabled: !!o.sms,
  role: o.role || "bdc", subscriptions: o.subscriptions || null,
});
export const config = (team, o = {}) => ({
  team_id: team, enterprise_id: "ent1", rooftop_name: o.name || `Rooftop ${team}`, timezone: o.timezone || "America/Chicago",
  working_hours: o.working_hours || null,
  post_appointment_enabled: !!o.appt, post_conversation_enabled: !!o.conv, chat_enabled: o.chat === true,
  action_item_enabled: !!o.ai, action_item_overdue_enabled: !!o.overdue, sms_enabled: !!o.sms,
  sms_post_conversation_cadence: o.cadence || "daily", lifecycle_status: "live", post_conversation_template: o.template || "",
});

// ── fake network ──────────────────────────────────────────────────────────────────────────────────
// h: { meetings(team, dept, params), conversations(team, channel, params) → {conversations, hasMore?, nextOffset?},
//      actionItems(team, dept, scope, params) → {actionItems, hasMore?}, chMeetings(ids) → rows,
//      chLeadDepts → { leadId: 'sales'|'service' }, chCount → { overdue, open } | null,
//      twilio(body) → { status, body }, mailFails(subject) → Error-ish body | null }
export function installFetch(log, h = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://ch.test")) {
      const sql = String(init.body || "");
      log.ch.push(sql);
      const rows = (arr) => new Response((arr || []).map((r) => JSON.stringify(r)).join("\n"), { status: 200 });
      if (sql.includes("dealer_leads.meetings AS m FINAL")) {
        if (h.chMeetingsFail) return new Response("boom", { status: 500 });
        // only the values inside the IN (...) lists — the SQL also carries quoted format strings
        const ids = [...sql.matchAll(/IN \(([^)]*)\)/g)].flatMap((g) => [...g[1].matchAll(/'([^']*)'/g)].map((m) => m[1]));
        return rows((h.chMeetings ? h.chMeetings(ids, sql) : []));
      }
      if (sql.includes("FROM dealer_leads.leads") && sql.includes(" svc ")) {
        const map = h.chLeadDepts || {};
        return rows(Object.entries(map).filter(([k]) => sql.includes(`'${k}'`)).map(([leadId, svc]) => ({ leadId, svc })));
      }
      if (sql.includes("uniqExactIf(lead_id")) {
        if (h.chCount === null) return new Response("boom", { status: 500 });
        return rows([h.chCount || { overdue: 0, open: 0 }]);
      }
      return rows([]);
    }
    if (u.startsWith("http://rv.test")) {
      const p = new URL(u);
      log.api.push({ path: p.pathname + p.search, headers: { ...(init.headers || {}) } });
      const team = p.searchParams.get("team_id"), dept = p.searchParams.get("serviceType");
      if (p.pathname === "/api/meetings") {
        const r = h.meetings ? h.meetings(team, dept, p.searchParams) : [];
        return json(Array.isArray(r) ? { meetings: r, total: r.length } : r);
      }
      if (p.pathname === "/api/conversations") {
        const r = h.conversations ? h.conversations(team, p.searchParams.get("channel") || "call", p.searchParams) : null;
        return json(r || { conversations: [], total: 0 });
      }
      if (p.pathname === "/api/action-items") {
        const r = h.actionItems ? h.actionItems(team, dept, p.searchParams.get("scope"), p.searchParams) : null;
        return json(r || { actionItems: [], total: 0, hasMore: false });
      }
      if (p.pathname === "/api/reports") return json(h.reports ? h.reports(p.searchParams) : { agents: [] });
      return json({});
    }
    if (u.startsWith("http://mail.test")) {
      const body = JSON.parse(String(init.body || "{}"));
      log.mail.push(body);
      return json({ messageId: `msg-${log.mail.length}` });
    }
    if (u.startsWith("https://api.twilio.com")) {
      log.twilio.push(String(init.body || ""));
      const r = h.twilio ? h.twilio(String(init.body || "")) : { status: 401, body: { code: 20003, message: "Authenticate", status: 401 } };
      return json(r.body, r.status);
    }
    if (u.includes("slack.com")) { log.slack.push(String(init.body || "")); return json({ ok: true }); }
    if (u.startsWith("http://spyne.test")) return json({ message: "unauthorized" }, 401);
    log.other.push(u);
    return json({}, 404);
  };
}

export function load(tables, env = {}) {
  for (const k of Object.keys(process.env)) if (/^(TWILIO_|SMS_DRY_RUN|DRY_RUN|REPORTING_|DIGEST_SPYNE_TOKEN|SPYNE_API_TOKEN|CRON_SECRET|EVENT_)/.test(k)) delete process.env[k];
  Object.assign(process.env, {
    ROI_SUPABASE_URL: "http://sb.test", ROI_SUPABASE_SERVICE_KEY: "fake", REPORTING_API_BASE: "http://rv.test",
    CLICKHOUSE_HOST: "ch.test", CLICKHOUSE_PASSWORD: "fake", CLICKHOUSE_USER: "fake", SPYNE_API_BASE: "http://spyne.test",
    MAIL_PROXY_URL: "http://mail.test/send", DRY_RUN: "false", SMS_DRY_RUN: "true", SLACK_BOT_TOKEN: "xoxb-fake",
    EVENT_SEND_DELAY_ACTIVE_MS: "0", EVENT_SEND_DELAY_NIGHT_MS: "0", EVENT_SMS_SEND_STAGGER_MS: "0",
    TWILIO_ACCOUNT_SID: "ACfake", TWILIO_AUTH_TOKEN: "fake", TWILIO_FROM: "+15555550000",
  }, env);
  const log = { sb: [], ch: [], api: [], mail: [], twilio: [], slack: [], other: [] };
  for (const k of Object.keys(require.cache)) if (k.startsWith(ROI_DIR + path.sep) || k.startsWith(EMAIL_DIR + path.sep)) delete require.cache[k];
  require.cache[SUPABASE] = { id: SUPABASE, filename: SUPABASE, loaded: true, exports: fakeSupabase(log, tables) };
  const runner = require(RUNNER);
  return { runner, log };
}

export const quiet = async (fn) => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };
export const rowsOf = (tables, table, pred = () => true) => (tables[table] || []).filter(pred);
// ISO for "n minutes from now" — keeps appointment fixtures clear of the past-start gate.
export const inMinutes = (n) => new Date(Date.now() + n * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
