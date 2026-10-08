/* The events pass must FINISH, and when it can't, it must say so — never die silently mid-list.
 *
 * Regression guard for 2026-10-08: /api/cron/roi-events was killed at Vercel's 300s on every pass,
 * around target ~300 of 401, so the tail of roi_live_departments (the newest go-lives, Stillwell Ford
 * among them) got no transactional email at all and the end-of-pass alerts never ran. The time went
 * to /api/reports (the MTD count, 2.6-18s, fetched for every rooftop whether or not anything was
 * booked) and to a timezone "self-heal" whose Spyne endpoint now 401s, retried every pass.
 *
 * Fully offline: fake Supabase via require.cache, fetch routed to fakes, DRY_RUN on, no Slack token
 * reaching the network. Run: node --test server/roi-cron/__tests__/eventsPass.budget.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RUNNER = require.resolve("../eventRunner.cjs");
const RESOLVE_TZ = require.resolve("../resolveTz.cjs");
const LEAD_CH = require.resolve("../leadCaptureCH.cjs");
const SUPABASE = require.resolve("@supabase/supabase-js", { paths: [RUNNER] });

// ── fixtures: 10 rooftops × sales/service; odd ones have no timezone / working hours in config ──
const TEAMS = Array.from({ length: 10 }, (_, i) => `team${String(i).padStart(2, "0")}`);
const live = TEAMS.flatMap((t) => [{ team_id: t, department: "service", dry_run: true }, { team_id: t, department: "sales", dry_run: true }]);
const cfg = TEAMS.map((t, i) => ({
  team_id: t, enterprise_id: "ent", rooftop_name: `Rooftop ${t}`,
  timezone: i % 2 ? null : "America/Chicago", working_hours: i % 2 ? null : { monday: { is_working: true, start_time: "08:00", end_time: "18:00" } },
  post_appointment_enabled: true, post_conversation_enabled: false, chat_enabled: false,
  action_item_enabled: false, action_item_overdue_enabled: false, sms_enabled: false, lifecycle_status: "live",
}));

function fakeSupabase(log) {
  const tables = { roi_live_departments: live, roi_rooftop_config: cfg, roi_recipients: [] };
  return {
    createClient: () => ({
      from(table) {
        const q = { table, op: "select", filters: [] };
        const b = {
          select() { return b; }, eq(k, v) { q.filters.push([k, v]); return b; }, in() { return b; },
          gte() { return b; }, lt() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
          maybeSingle() { return b; }, single() { return b; },
          insert(row) { q.op = "insert"; q.row = row; return b; },
          update(patch) { q.op = "update"; q.patch = patch; return b; },
          then(res, rej) {
            log.sb.push(q);
            let data = tables[table] || [];
            if (q.op === "select" && table === "roi_live_departments") data = data.filter((r) => q.filters.every(([k, v]) => k !== "is_live" || v === true));
            if (q.op === "insert") data = [{ id: `row-${log.sb.length}` }];
            if (q.op === "update") data = [];
            return Promise.resolve({ data, error: null }).then(res, rej);
          },
        };
        return b;
      },
    }),
  };
}

// fetch router. `meetingsFor(team, dept)` decides what the meetings feed returns; `delayMs` slows it.
function installFetch(log, { meetingsFor = () => [], delayMs = 0, chKnows = (t) => t !== "team09", chTz = () => "America/Los_Angeles" } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://ch.test")) {
      const sql = String(init.body || "");
      log.ch.push(sql);
      if (sql.includes("eventila.enterprise_team_details")) {
        const ids = [...sql.matchAll(/'(team\d\d)'/g)].map((m) => m[1]).filter(chKnows);
        const rows = ids.map((t) => JSON.stringify({ team_id: t, timezone: chTz(t), working_days: JSON.stringify({ monday: { is_working: true, start_time: "09:00", end_time: "17:00" } }) }));
        return new Response(rows.join("\n"), { status: 200 });
      }
      return new Response("", { status: 200 });
    }
    if (u.startsWith("http://spyne.test")) { log.spyne.push(u); return json({ message: "unauthorized" }, 401); }
    if (u.startsWith("http://rv.test")) {
      const p = new URL(u);
      log.api.push(p.pathname + p.search);
      if (p.pathname === "/api/meetings") {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const meetings = meetingsFor(p.searchParams.get("team_id"), p.searchParams.get("serviceType"));
        return json({ meetings, total: meetings.length });
      }
      if (p.pathname === "/api/reports") return json({ agents: [] });
      return json({ actionItems: [], conversations: [], total: 0 });
    }
    if (u.includes("slack.com")) { log.slack.push(String(init.body || "")); return json({ ok: true }); }
    log.other.push(u);
    return json({}, 404);
  };
}

function load(env = {}) {
  Object.assign(process.env, {
    ROI_SUPABASE_URL: "http://sb.test", ROI_SUPABASE_SERVICE_KEY: "fake", REPORTING_API_BASE: "http://rv.test",
    CLICKHOUSE_HOST: "ch.test", CLICKHOUSE_PASSWORD: "fake", CLICKHOUSE_USER: "fake", SPYNE_API_BASE: "http://spyne.test",
    MAIL_PROXY_URL: "http://mail.test/send", DRY_RUN: "true", SLACK_BOT_TOKEN: "xoxb-fake", EVENT_PASS_BUDGET_MS: "230000",
    DIGEST_SPYNE_TOKEN: "", SPYNE_API_TOKEN: "",
  }, env);
  const log = { sb: [], ch: [], spyne: [], api: [], slack: [], other: [] };
  for (const k of [RUNNER, RESOLVE_TZ, LEAD_CH]) delete require.cache[k];
  require.cache[SUPABASE] = { id: SUPABASE, filename: SUPABASE, loaded: true, exports: fakeSupabase(log) };
  const runner = require(RUNNER);
  return { runner, log };
}
const quiet = async (fn) => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const reportsCalls = (log) => log.api.filter((p) => p.startsWith("/api/reports")).length;
const visited = (log) => log.api.filter((p) => p.startsWith("/api/meetings")).map((p) => { const s = new URL("http://x" + p).searchParams; return `${s.get("team_id")}:${s.get("serviceType")}`; });

test("no booking → the MTD count (/api/reports) is never fetched", async () => {
  const { runner, log } = load();
  installFetch(log);
  const out = await quiet(() => runner.runOnce());
  assert.equal(visited(log).length, 20, "every target visited");
  assert.equal(reportsCalls(log), 0);
  assert.equal(out.unreached, 0);
});

test("a booking → the MTD count is fetched once, for that rooftop only", async () => {
  const { runner, log } = load();
  installFetch(log, { meetingsFor: (t, d) => (t === "team03" && d === "sales"
    ? [{ id: "meeting_x", leadId: "lead_x", customer: "A Customer", phone: "+15555550100", source: "spyne", when: "2026-10-09T15:00:00Z" }] : []) });
  await quiet(() => runner.runOnce());
  assert.equal(reportsCalls(log), 1);
  assert.ok(log.api.some((p) => p.startsWith("/api/reports?team_id=team03")));
});

test("missing timezones come from ONE ClickHouse read, are saved once, and a miss is not re-asked", async () => {
  const { runner, log } = load();
  installFetch(log); // team09 is unknown to ClickHouse
  await quiet(() => runner.runOnce());
  const teamReads = log.ch.filter((s) => s.includes("eventila.enterprise_team_details"));
  assert.equal(teamReads.length, 2, "one batched prime + one single-team retry for the rooftop it lacked");
  assert.equal(log.spyne.length, 1, "the Spyne API is only the fallback, asked once for team09");
  const tzWrites = log.sb.filter((q) => q.table === "roi_rooftop_config" && q.op === "update" && q.patch.timezone);
  assert.deepEqual(tzWrites.map((q) => q.patch.timezone), Array(4).fill("America/Los_Angeles"), "4 resolvable rooftops, one write each (not one per department)");
  log.ch.length = 0; log.spyne.length = 0;
  await quiet(() => runner.runOnce()); // same warm instance, config snapshot still empty
  assert.equal(log.spyne.length, 0, "an unresolvable rooftop is remembered, not re-asked every pass");
  assert.equal(log.ch.filter((s) => s.includes("eventila.enterprise_team_details")).length, 0);
});

test("a non-North-American team timezone is ignored, not saved over the default", async () => {
  const { runner, log } = load();
  installFetch(log, { chTz: (t) => (t === "team07" ? "Africa/Abidjan" : "America/Los_Angeles") }); // Evansville, 2026-10-08
  await quiet(() => runner.runOnce());
  const tzWrites = log.sb.filter((q) => q.table === "roi_rooftop_config" && q.op === "update" && q.patch.timezone);
  assert.equal(tzWrites.length, 3);
  assert.ok(tzWrites.every((q) => q.patch.timezone === "America/Los_Angeles"));
});

test("shards partition the fleet: every target exactly once, a team's departments together", async () => {
  const { runner, log } = load();
  installFetch(log);
  const seen = [];
  for (let s = 0; s < 4; s++) { log.api.length = 0; await quiet(() => runner.runOnce({ shard: s, shards: 4 })); seen.push(visited(log)); }
  const all = seen.flat();
  assert.equal(all.length, 20);
  assert.equal(new Set(all).size, 20);
  for (const part of seen) for (const k of part) assert.ok(part.includes(k.replace(/:(sales|service)$/, (_, d) => `:${d === "sales" ? "service" : "sales"}`)), `${k} split from its other department`);
});

test("out of time → stops cleanly, alerts with the unreached rooftops, and the next pass starts there", async () => {
  const { runner, log } = load({ EVENT_PASS_BUDGET_MS: "120" });
  installFetch(log, { delayMs: 40 });
  const out = await quiet(() => runner.runOnce());
  assert.ok(out.unreached > 0 && out.unreached < 20, `unreached=${out.unreached}`);
  assert.equal(visited(log).length, 20 - out.unreached);
  assert.equal(log.slack.length >= 1 && log.slack.some((b) => b.includes("INCOMPLETE")), true, "Slack alert names the incomplete pass");
  const firstUnreached = (() => { const sorted = live.map((L) => `${L.team_id}:${L.department}`).sort(); return sorted[20 - out.unreached]; })();
  log.api.length = 0;
  await quiet(() => runner.runOnce());
  assert.equal(visited(log)[0], firstUnreached, "resumes at the first rooftop the last pass missed");
});
