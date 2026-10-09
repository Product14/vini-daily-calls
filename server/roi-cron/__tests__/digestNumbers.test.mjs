/* The digest prints the numbers the reporting-vini Overview shows for the same rooftop, department and
 * window. Regression guard for the 2026-10-08 parity audit (A2 F1-F20):
 *   · every reporting call carries the rooftop's enterprise_id (the cron's credential otherwise resolved
 *     the env token's enterprise and action-item stats came back all zero from 2026-10-01);
 *   · all-zero dealer-leads stats on a day items were created are held, never printed as 0;
 *   · the outbound section reads the OUTBOUND funnel; inbound "Leads reached" is inbound only;
 *   · the appointment list is the KPI's own rows (same response), AI-booked and AI-assisted apart, and the
 *     footer states the KPI, not the list length;
 *   · hand-offs = transfers + callbacks across both agents; no turn rate on Sales Inbound; close rate on
 *     one basis; delta chips are the rooftop's, never a calls delta under conversations;
 *   · Sales uses the rooftop's distinct rungs exactly when the Overview's rooftopRungsFor would.
 *
 * Fully offline: fake Supabase via require.cache, fetch routed to fakes, DRY_RUN on.
 * Run: node --test server/roi-cron/__tests__/digestNumbers.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RUNNER = require.resolve("../runner.cjs");
const SUPABASE = require.resolve("@supabase/supabase-js", { paths: [RUNNER] });
const { renderDigestHtml } = require("../../../src/email/digestTemplate.cjs");
const TZ = "America/New_York";

function localNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return { Y: g("year"), M: g("month"), D: g("day"), H: g("hour") === 24 ? 0 : g("hour") };
}
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const NOW = localNow();
const YESTERDAY = iso(NOW.Y, NOW.M, NOW.D - 1);
const TODAY = iso(NOW.Y, NOW.M, NOW.D);
const AFTER_SEND = { digest_send_hour: 0, digest_send_minute: 0 };

// ── fake Supabase (in-memory, enough of the builder for the runner) ──────────────────────────────
function fakeSupabase(db, log) {
  let seq = 0;
  const runKey = (r) => `${r.team_id}|${r.department}|${r.cadence}|${r.local_date}`;
  const conflictKey = (table, r) => table === "roi_digest_runs" ? runKey(r) : table === "roi_rooftop_config" ? r.team_id : table === "roi_live_departments" ? `${r.team_id}|${r.department}` : null;
  return {
    createClient: () => ({
      from(table) {
        const q = { op: "select", f: [], single: false, opts: {} };
        const b = {
          select() { return b; },
          eq(k, v) { q.f.push((r) => r[k] === v); return b; },
          neq(k, v) { q.f.push((r) => r[k] !== v); return b; },
          in(k, vs) { q.f.push((r) => vs.includes(r[k])); return b; },
          is(k, v) { q.f.push((r) => (r[k] ?? null) === v); return b; },
          gte(k, v) { q.f.push((r) => r[k] >= v); return b; },
          lte(k, v) { q.f.push((r) => r[k] <= v); return b; },
          lt(k, v) { q.f.push((r) => r[k] < v); return b; },
          not() { return b; }, filter() { return b; }, ilike() { return b; }, or() { return b; },
          order() { return b; }, limit() { return b; }, range() { return b; },
          maybeSingle() { q.single = true; return b; }, single() { q.single = true; return b; },
          upsert(row, opts) { q.op = "upsert"; q.row = row; q.opts = opts || {}; return b; },
          update(patch) { q.op = "update"; q.patch = patch; return b; },
          insert(row) { q.op = "insert"; q.row = row; return b; },
          delete() { q.op = "delete"; return b; },
          then(res, rej) {
            log.sb.push({ table, op: q.op });
            const rows = db[table] || (db[table] = []);
            let data;
            if (q.op === "upsert") {
              data = [];
              for (const row of Array.isArray(q.row) ? q.row : [q.row]) {
                const k = conflictKey(table, row);
                const hit = k != null ? rows.find((r) => conflictKey(table, r) === k) : null;
                if (hit) { if (!q.opts.ignoreDuplicates) Object.assign(hit, row); }
                else rows.push({ id: `${table}-${++seq}`, ...(table === "roi_digest_runs" ? { message_id: null } : {}), ...row });
                if (table === "roi_digest_runs") log.writes.push({ ...row });
                data.push({ id: (hit || rows[rows.length - 1]).id });
              }
            } else if (q.op === "update") {
              const hit = rows.filter((r) => q.f.every((fn) => fn(r)));
              for (const r of hit) Object.assign(r, q.patch);
              data = hit.map((r) => ({ id: r.id }));
            } else if (q.op === "insert") {
              data = [];
              for (const row of Array.isArray(q.row) ? q.row : [q.row]) { const r = { id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...row }; rows.push(r); data.push({ id: r.id }); }
            } else {
              data = rows.filter((r) => q.f.every((fn) => fn(r)));
              if (q.single) data = data[0] ?? null;
            }
            return Promise.resolve({ data, error: null }).then(res, rej);
          },
        };
        return b;
      },
    }),
  };
}

// ── /api/reports fixtures ─────────────────────────────────────────────────────────────────────────
const IDS = { "Sales Inbound": "sales_ib", "Sales Outbound": "sales_ob", "Service Inbound": "service_ib", "Service Outbound": "service_ob" };
function agent(name, o = {}) {
  const contacted = o.contacted ?? 0, connected = o.connected ?? 0, qualified = o.qualified ?? 0;
  return {
    id: IDS[name], name,
    metrics: { calls: o.calls ?? 0, smsSent: o.sms ?? 0, appointments: o.appts ?? 0, appointmentsAssisted: o.assisted ?? 0, conversations: o.conv ?? connected, qualified, connectRate: 50, afterHours: 0 },
    channelSplit: { voice: o.voice ?? o.calls ?? 0, sms: 0 },
    leadFunnel: { contacted, connected, qualified },
    report: { summary: {}, leadsAttempted: contacted, callFlow: { transferred: o.transferred ?? 0, callbacks: o.callbacks ?? 0, total: 0 }, deltas: o.deltas ?? {} },
  };
}
const quietAgents = () => ["Sales Inbound", "Sales Outbound", "Service Inbound", "Service Outbound"].map((n) => agent(n));

function installFetch(log, { report, stats, created = [], hasMore = false } = {}) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("http://rv.test")) {
      const p = new URL(u);
      log.api.push(p.pathname + p.search);
      const sp = Object.fromEntries(p.searchParams);
      if (p.pathname === "/api/reports") return json(typeof report === "function" ? report(sp) : (report || { agents: quietAgents() }));
      if (p.pathname === "/api/sync-health") return json({ ok: false }, 503);
      if (p.pathname === "/api/action-items" && sp.scope === "stats") return json(stats || { scope: "stats", stats: { created: 0, completed: 0, open: 0, overdue: 0 }, source: "clickhouse" });
      if (p.pathname === "/api/action-items") return json({ actionItems: created, total: created.length, scope: "created", hasMore });
      if (p.pathname === "/api/meetings") return json({ vehicles: [{ name: "2024 Honda Civic", count: 3 }] });
      return json({});
    }
    if (u.startsWith("http://mail.test")) { log.mail.push(JSON.parse(init.body)); return json({ messageId: `mid-${log.mail.length}` }); }
    log.other.push(u);
    return json({ ok: true });
  };
}

function load({ teams = ["t1"], dept = "service", cfg = {}, runs = [], env = {} } = {}) {
  Object.assign(process.env, {
    ROI_SUPABASE_URL: "http://sb.test", ROI_SUPABASE_SERVICE_KEY: "fake", REPORTING_API_BASE: "http://rv.test",
    CLICKHOUSE_HOST: "", CLICKHOUSE_PASSWORD: "", SPYNE_API_BASE: "http://spyne.test", MAIL_PROXY_URL: "http://mail.test/send",
    DRY_RUN: "true", SMS_DRY_RUN: "true", SLACK_BOT_TOKEN: "", DIGEST_SPYNE_TOKEN: "", SPYNE_API_TOKEN: "",
    CRON_POOL: "1", DIGEST_PASS_BUDGET_MS: "200000", DIGEST_SEND_WINDOW_HOURS: "24", MAIL_SEND_DELAY_MS: "0",
  }, env);
  const db = {
    roi_live_departments: teams.map((t) => ({ team_id: t, department: dept, dry_run: true, is_live: true })),
    roi_rooftop_config: teams.map((t) => ({
      team_id: t, enterprise_id: `ent-${t}`, rooftop_name: `Rooftop ${t}`, timezone: TZ, daily_enabled: true,
      weekly_enabled: false, monthly_enabled: false, lifecycle_status: "live", churn_date: null, ...AFTER_SEND, ...cfg,
    })),
    roi_recipients: teams.map((t) => ({ team_id: t, email: `gm@${t}.example.com`, receives_sales: true, receives_service: true, email_enabled: true, verified_at: "2026-01-01", subscriptions: null })),
    roi_digest_runs: runs.map((r, i) => ({ id: `seed-${i}`, message_id: null, ...r })),
    roi_cron_runs: [],
  };
  const log = { sb: [], api: [], other: [], writes: [], mail: [] };
  delete require.cache[RUNNER];
  require.cache[SUPABASE] = { id: SUPABASE, filename: SUPABASE, loaded: true, exports: fakeSupabase(db, log) };
  return { runner: require(RUNNER), db, log };
}
const quiet = async (fn) => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };
const dailyRow = (db) => db.roi_digest_runs.find((r) => r.cadence === "daily" && r.local_date === YESTERDAY);

// ── A1 ────────────────────────────────────────────────────────────────────────────────────────────
test("A1: every reporting-vini call the digest makes carries the rooftop's own enterprise_id", async () => {
  const { runner, log } = load();
  installFetch(log, { report: { agents: [agent("Service Inbound", { calls: 5, contacted: 4, connected: 3 }), agent("Service Outbound")] } });
  await quiet(() => runner.runOnce());
  const calls = log.api.filter((p) => !p.startsWith("/api/sync-health"));
  assert.ok(calls.some((p) => p.startsWith("/api/reports")) && calls.some((p) => p.startsWith("/api/action-items")) && calls.some((p) => p.startsWith("/api/meetings")), calls.join("\n"));
  for (const p of calls) assert.equal(new URL("http://x" + p).searchParams.get("enterprise_id"), "ent-t1", p);
  // the digest never shows lead sources, so that upstream is skipped; hotLeads (the Sales call list) is not
  for (const p of calls.filter((x) => x.startsWith("/api/reports"))) assert.equal(new URL("http://x" + p).searchParams.get("omit"), "leadSources", p);
  assert.ok(!calls.some((p) => p.includes("auth_key=")), "no Spyne token in any URL");
});

test("A1: a canonical-timeout degraded report holds the digest (error row), never emails partial numbers", async () => {
  const { runner, db, log } = load();
  installFetch(log, { report: { agents: quietAgents(), degraded: true, degradedReason: "canonical-timeout" } });
  await quiet(() => runner.runOnce());
  const row = dailyRow(db);
  assert.equal(row.status, "error");
  assert.match(row.reason_detail, /degraded \(canonical-timeout\)/);
  assert.equal(log.mail.length, 0);
});

test("A4: the appointment list is read from the SAME /api/reports response (no second day-window fetch)", async () => {
  const { runner, log } = load();
  installFetch(log, { report: { agents: [agent("Service Inbound", { calls: 5, appts: 1, contacted: 4 }), agent("Service Outbound")] } });
  await quiet(() => runner.runOnce());
  const dayCalls = log.api.filter((p) => p.startsWith("/api/reports") && p.includes(`start=${YESTERDAY}&end=${TODAY}`));
  assert.equal(dayCalls.length, 1, dayCalls.join("\n"));
  assert.ok(!log.api.some((p) => p.includes("scope=window")), "no /api/meetings?scope=window");
});

// ── A2 ────────────────────────────────────────────────────────────────────────────────────────────
test("A2: all-zero dealer-leads stats on a day items were created are held: no false 0 overdue / open / closed", async () => {
  const { runner, db, log } = load();
  installFetch(log, {
    report: { agents: [agent("Service Inbound", { calls: 5, contacted: 4 }), agent("Service Outbound")] },
    created: [{ intent: "SERVICE_REQUEST_CALLBACK" }, { intent: "SERVICE_REQUEST_CALLBACK" }, { intent: "SERVICE_SEND_ESTIMATE" }],
    stats: { scope: "stats", stats: { created: 0, completed: 0, open: 0, overdue: 0, dueToday: 0 }, source: "dealer-leads" },
  });
  await quiet(() => runner.runOnce());
  const row = dailyRow(db);
  assert.equal(row.metrics.actionItemStatsDegraded, true);
  assert.equal(row.metrics.actionItemsOverdue, null);
  assert.equal(row.metrics.actionItemsOpen, null);
  assert.equal(row.metrics.actionItemsClosedYesterday, null);
  assert.equal(row.metrics.actionItemsTotal, 3);
  assert.match(row.rendered_html, /Action items created/);
  assert.doesNotMatch(row.rendered_html, /still open|overdue/);
});

test("A2/A9: healthy stats print 'N still open' and the overdue chip; the created list pages past 200", async () => {
  const { runner, db, log } = load();
  let page = 0;
  installFetch(log, {
    report: { agents: [agent("Service Inbound", { calls: 5, contacted: 4 }), agent("Service Outbound")] },
    stats: { scope: "stats", stats: { created: 9, completed: 8, open: 405, overdue: 402 }, source: "dealer-leads" },
  });
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/api/action-items") && u.includes("scope=created")) {
      log.api.push(new URL(u).pathname + new URL(u).search);
      page++;
      const items = Array.from({ length: page === 1 ? 200 : 7 }, () => ({ intent: "SERVICE_SEND_ESTIMATE" }));
      return new Response(JSON.stringify({ actionItems: items, hasMore: page === 1, scope: "created" }), { status: 200 });
    }
    return base(url, init);
  };
  await quiet(() => runner.runOnce());
  const row = dailyRow(db);
  assert.equal(row.metrics.actionItemsTotal, 207, "both pages counted, no silent cap at 200");
  const createdCalls = log.api.filter((p) => p.includes("scope=created"));
  assert.ok(createdCalls.some((p) => p.includes("offset=200")), createdCalls.join("\n"));
  assert.match(row.rendered_html, /405 still open/);
  assert.match(row.rendered_html, /402 overdue/);
  assert.doesNotMatch(row.rendered_html, /Due action items/);
});

// ── A4 (lists + footer) ───────────────────────────────────────────────────────────────────────────
test("A4: AI-booked and AI-assisted rows are listed apart, department-filtered, and the footer states the KPI", async () => {
  const { runner, db, log } = load();
  installFetch(log, { report: {
    agents: [agent("Service Inbound", { calls: 5, appts: 1, contacted: 4, connected: 3, qualified: 2 }), agent("Service Outbound")],
    appointmentsUnattributedBy: { sales: 0, service: 1, unknown: 0 },
    appointmentsAssistedBy: { sales: 4, service: 2, unknown: 0 },
    namedAppointments: [
      { customer: "Ann Booked", serviceType: "service", assisted: false, when: "2026-10-07T18:00:00Z", leadId: "l1" },
      { customer: "Noah Agent", serviceType: "service", assisted: false, when: "2026-10-07T19:00:00Z", leadId: "l4" },
      { customer: "Bob Assisted", serviceType: "service", assisted: true, when: "2026-10-08T15:00:00Z", leadId: "l2" },
      { customer: "Cat Sales", serviceType: "sales", assisted: false, when: "2026-10-07T18:00:00Z", leadId: "l3" },
    ],
  } });
  await quiet(() => runner.runOnce());
  const m = dailyRow(db).metrics;
  // KPI = per-agent + this department's unattributed (the Overview's tile); assisted = the department total
  assert.equal(m.appointmentsYesterday, 2);
  assert.equal(m.assistedAppointments, 2);
  assert.deepEqual(m.appointments.map((a) => a.customer), ["Ann Booked", "Noah Agent"]);
  assert.deepEqual(m.assistedAppointmentList.map((a) => a.customer), ["Bob Assisted"]);
  const html = dailyRow(db).rendered_html;
  assert.match(html, /2<\/span> AI-booked yesterday/);
  assert.match(html, /2<\/span> AI-assisted \(CRM\)/);
  assert.match(html, /AI-assisted \(CRM\) · booked by your team/);
  assert.doesNotMatch(html, /Cat Sales/);
});

test("A4: the template footer never counts the list (KPI 0, seven assisted rows → '0 AI-booked')", () => {
  const assistedRows = Array.from({ length: 7 }, (_, i) => ({ customer: `C${i}`, assisted: true, sched: "Tue · 9:00 AM" }));
  const html = renderDigestHtml({ appointmentsYesterday: 0, assistedAppointments: 7, conversationsHandled: 3 }, { dept: "sales", appointments: [], assistedAppointments: assistedRows, focus: "appointment" });
  assert.match(html, /0<\/span> AI-booked yesterday/);
  assert.match(html, /7<\/span> AI-assisted \(CRM\)/);
  assert.doesNotMatch(html, /AI-booked · customer/, "no AI-booked table when none were AI-booked");
});

// ── A3 / A5 ───────────────────────────────────────────────────────────────────────────────────────
test("A3: the outbound section reads the outbound funnel, not the inbound one", () => {
  const m = { outboundLive: true, inboundLive: false, outboundTotalCalls: 40, outboundUniqueReached: 5,
    leadFunnel: { contacted: 18, connected: 16, qualified: 8 }, warmCount: 8,
    outboundFunnel: { contacted: 30, connected: 5, qualified: 0, appt: 0 }, conversationsHandled: 10 };
  const html = renderDigestHtml(m, { dept: "service", focus: "conversation" });
  const ob = html.slice(html.indexOf("Outbound service performance"));
  assert.match(ob, /Qualified leads<\/div><div style="margin-top:4px;line-height:1;"><span style="font-size:46px;font-weight:900;color:#0F172A;">0</);
  assert.match(ob, /Leads dialed/); // fallback bars are the outbound funnel's
  assert.doesNotMatch(ob.slice(0, ob.indexOf("Outbound funnel") + 2000), />8<\/td>/);
});

test("A3: a stored run from before outboundFunnel existed keeps its old read", () => {
  const html = renderDigestHtml({ outboundLive: true, outboundTotalCalls: 4, leadFunnel: { qualified: 3 }, conversationsHandled: 2 }, { dept: "sales" });
  assert.match(html.slice(html.indexOf("Outbound sales performance")), /font-size:46px;font-weight:900;color:#0F172A;">3</);
});

test("A5: inbound 'Leads reached' is the inbound agent's, not the rooftop total", () => {
  const html = renderDigestHtml({ inboundLive: true, totalLeads: 178, inboundUniqueLeads: 14, inboundFunnel: { contacted: 14, connected: 5, qualified: 6, appt: 1 }, conversationsInbound: 5, conversationsHandled: 9 }, { dept: "sales", focus: "conversation" });
  const ib = html.slice(html.indexOf("Inbound sales performance"));
  assert.match(ib, /Leads reached<\/div><div style="margin-top:6px;line-height:1.1;"><span style="font-size:20px;font-weight:800;color:#0F172A;">14</);
});

// ── A6 / A7 / A8 / A12 / A13 via apiMetrics ──────────────────────────────────────────────────────
test("A6/A12: hand-offs are IB+OB transfers + callbacks; calls come from metrics.calls, not the mock channelSplit", async () => {
  const { runner, log } = load();
  installFetch(log, { report: { agents: [
    agent("Service Inbound", { calls: 0, voice: 88, contacted: 4, connected: 3, transferred: 8, callbacks: 1 }),
    agent("Service Outbound", { calls: 20, voice: 21, contacted: 30, connected: 5, transferred: 2, callbacks: 3 }),
  ] } });
  const m = await runner.apiMetrics("t1", "service", YESTERDAY, TODAY, "ent-t1");
  assert.equal(m.handoffTransfers, 10);
  assert.equal(m.handoffCallbacks, 4);
  assert.equal(m.inboundCallbacks, 1);
  assert.equal(m.conversationsCallIn, 0, "no fabricated 'Call 88'");
  assert.equal(m.conversationsCallOut, 20);
  const html = renderDigestHtml(m, { dept: "service" });
  assert.match(html, /Hand-offs to team<\/div><div[^>]*>14</);
  assert.match(html, /10 transfers · 4 callbacks/);
});

test("A7: no turn rate on Sales Inbound; Sales shows the outbound turn rate; close rate on one per-agent basis", () => {
  const ibOnly = renderDigestHtml({ inboundFunnel: { contacted: 9, connected: 5, qualified: 6, appt: 1 }, outboundFunnel: null, appointmentsYesterday: 1, conversationsHandled: 5 }, { dept: "sales" });
  assert.doesNotMatch(ibOnly, /Turn rate/, "Sales Inbound qualified is not nested in conversations (printed 120%)");
  assert.match(ibOnly, /Close rate<\/div><div[^>]*>17%</);
  assert.match(ibOnly, /1 booked of 6 qualified/);
  const both = renderDigestHtml({ inboundFunnel: { contacted: 9, connected: 5, qualified: 6, appt: 1 }, outboundFunnel: { contacted: 50, connected: 16, qualified: 3, appt: 1 }, appointmentsYesterday: 2, conversationsHandled: 5 }, { dept: "sales" });
  assert.match(both, /Turn rate<\/div><div[^>]*>19%</);
  assert.match(both, /outbound: 3 qualified of 16 conversations/);
  assert.match(both, /Close rate<\/div><div[^>]*>22%</);
  assert.match(both, /inbound 1\/6 · outbound 1\/3/);
  const svc = renderDigestHtml({ inboundFunnel: { contacted: 18, connected: 16, qualified: 8, appt: 4 }, outboundFunnel: { contacted: 0, connected: 0, qualified: 0, appt: 0 }, appointmentsYesterday: 4, conversationsHandled: 5 }, { dept: "service" });
  assert.match(svc, /Turn rate<\/div><div[^>]*>50%</);
  assert.match(svc, /Close rate<\/div><div[^>]*>50%</);
});

test("A8: KPI chips are the rooftop's own deltas (summed prior), never a calls delta under conversations", async () => {
  const { runner, log } = load();
  installFetch(log, { report: {
    agents: [
      agent("Service Inbound", { calls: 30, contacted: 10, connected: 6, qualified: 3, appts: 2, deltas: { totalCalls: -100, leadsQualified: -50, leadsAttempted: 5, appointments: 0 } }),
      agent("Service Outbound", { calls: 10, contacted: 10, connected: 4, qualified: 1 }),
    ],
    prior: { service_ib: { calls: 10, conversations: 12, qualified: 4, appointments: 2, leads: 10, sms: 0 }, service_ob: { calls: 5, conversations: 8, qualified: 4, appointments: 0, leads: 10, sms: 0 } },
  } });
  const m = await runner.apiMetrics("t1", "service", YESTERDAY, TODAY, "ent-t1");
  assert.deepEqual(m.kpiDeltas, { leads: 0, conversations: -50, qualified: -50, appointments: 0 });
  assert.equal(m.inboundDeltas.conversations, -50, "lead-grain, from the prior basis");
  const html = renderDigestHtml(m, { dept: "service", focus: "conversation" });
  assert.match(html, /Real conversations<\/div><div[^>]*><span[^>]*>10<\/span><\/div><div style="margin-top:11px;"><span[^>]*>▼ 50%/);
  assert.doesNotMatch(html, /▼ 100%/, "the inbound calls delta never chips a conversation count");
});

test("A10: Sales uses the rooftop's distinct rungs and its deltaPct exactly when the agent sets match", async () => {
  const rooftop = { dept: "sales", agentTypes: ["Sales Inbound", "Sales Outbound"], leadsAttempted: 6215, engaged: 155, qualified: 72, deltaPct: { leadsAttempted: 3, engaged: -51, qualified: null } };
  const agents = [agent("Sales Inbound", { calls: 9, contacted: 245, connected: 62, qualified: 40 }), agent("Sales Outbound", { calls: 900, contacted: 6000, connected: 99, qualified: 32 })];
  let { runner, log } = load({ dept: "sales" });
  installFetch(log, { report: { agents, rooftop } });
  let m = await runner.apiMetrics("t1", "sales", YESTERDAY, TODAY, "ent-t1");
  assert.equal(m.rooftopRungs, true);
  assert.deepEqual([m.totalLeads, m.conversationsReached, m.warmCount], [6215, 155, 72]);
  assert.deepEqual([m.kpiDeltas.leads, m.kpiDeltas.conversations, m.kpiDeltas.qualified], [3, -51, null]);
  // The API counted only Sales Inbound while Sales Outbound is active → the Overview keeps summing.
  ({ runner, log } = load({ dept: "sales" }));
  installFetch(log, { report: { agents, rooftop: { ...rooftop, agentTypes: ["Sales Inbound"] } } });
  m = await runner.apiMetrics("t1", "sales", YESTERDAY, TODAY, "ent-t1");
  assert.equal(m.rooftopRungs, false);
  assert.deepEqual([m.totalLeads, m.conversationsReached, m.warmCount], [6245, 161, 72]);
  // Service never takes the sales-only rungs.
  ({ runner, log } = load());
  installFetch(log, { report: { agents: [agent("Service Inbound", { contacted: 5, connected: 2, qualified: 1 }), agent("Service Outbound")], rooftop } });
  m = await runner.apiMetrics("t1", "service", YESTERDAY, TODAY, "ent-t1");
  assert.equal(m.rooftopRungs, false);
  assert.equal(m.totalLeads, 5);
});

test("A13/A14: the 'Leads touched' MTD sub-line is the combined MTD; every path carries conversationsReachedMTD", async () => {
  const { runner, db, log } = load({ cfg: { digest_focus: "appointment" } });
  installFetch(log, { report: { agents: [agent("Service Inbound", { calls: 4, contacted: 3, connected: 2 }), agent("Service Outbound", { calls: 50, contacted: 40, connected: 9 })] } });
  await quiet(() => runner.runOnce());
  const m = dailyRow(db).metrics;
  assert.equal(m.totalLeadsMTD, 43);
  assert.equal(m.conversationsReachedMTD, 11);
  assert.match(dailyRow(db).rendered_html, /43 MTD/);
  // the on-demand preview path builds the same metric set (one shared builder)
  const pv = await quiet(() => runner.previewDigestNow({ cadence: "weekly", teamId: "t1", department: "service" }));
  assert.equal(pv.metrics.conversationsReachedMTD, 11);
  assert.equal(pv.metrics.totalLeadsMTD, 43);
});

// ── A11 / A16 / A28 ───────────────────────────────────────────────────────────────────────────────
test("A11: report links carry the email's own window (daily: range=yesterday; weekly/monthly: inclusive start/end)", () => {
  const { runner } = load();
  const daily = runner.links("e1", "t1", "sales", { localDate: "2026-10-07", apiStart: "2026-10-07", apiEnd: "2026-10-08" }, "America/Chicago", "daily");
  assert.match(daily.reports, /[?&]range=yesterday(&|$)/);
  assert.match(daily.appts, /all_createdAtStart=2026-10-07T05%3A00%3A00.000Z/, "store-local midnight, not a fixed Eastern offset");
  const weekly = runner.links("e1", "t1", "sales", runner.windowForPeriod("America/Chicago", "weekly", "2026-10-04"), "America/Chicago", "weekly");
  assert.match(weekly.reports, /start=2026-09-28&end=2026-10-04/);
  const monthly = runner.links("e1", "t1", "service", runner.windowForPeriod("America/Chicago", "monthly", "2026-09-01"), "America/Chicago", "monthly");
  assert.match(monthly.reports, /start=2026-09-01&end=2026-09-30/);
});

test("A16: blocks that are not windowed to the period say which window they are", () => {
  const html = renderDigestHtml({ outboundLive: true, outboundTotalCalls: 3, outcomes: [{ label: "No reach", value: 4 }], campaigns: [{ name: "Recall", dials: 10, appts: 1, warm: 2 }], conversationsHandled: 2 },
    { dept: "sales", topVehicles: [{ name: "2024 Honda Civic", count: 3 }], topVehiclesDays: 30 });
  assert.match(html, /Top vehicles of interest · last 30 days/);
  assert.match(html, /Outbound outcomes · all time/);
  assert.match(html, /Top campaign · last 120 days/);
});

test("A28: the footer states the configured send time (v1 and v2), not a hard-coded 7:00 AM", () => {
  const { runner } = load();
  const cfg = { digest_send_hour: 8, digest_send_minute: 30 };
  const m = { appointmentsYesterday: 1, conversationsHandled: 4, inboundUniqueLeads: 2 };
  for (const tpl of ["v1", "v2"]) {
    const html = runner.renderDigest(tpl, "Rooftop", "sales", "Wednesday, October 7, 2026", "e1", "t1", "2026-10-07", TZ, m, [], "daily", { cfg });
    assert.match(html, /Next report: tomorrow · 8:30 AM/, tpl);
    assert.doesNotMatch(html, /7:00 AM/, tpl);
  }
  assert.equal(runner.nextReportLabel("weekly", { weekly_send_dow: 2, digest_send_hour: 13, digest_send_minute: 5 }), "next Tuesday · 1:05 PM");
  assert.equal(runner.nextReportLabel("monthly", { monthly_send_day: 3 }), "3rd of next month · 7:00 AM");
});

test("render smoke: daily/weekly/monthly × sales/service × v1/v2 render without throwing", () => {
  const { runner } = load();
  const m = { appointmentsYesterday: 2, assistedAppointments: 1, conversationsHandled: 9, inboundLive: true, outboundLive: true, inboundFunnel: { contacted: 5, connected: 3, qualified: 2, appt: 1 }, outboundFunnel: { contacted: 9, connected: 4, qualified: 1, appt: 1 },
    kpiDeltas: { leads: 4, conversations: -3, qualified: null, appointments: 0 }, actionItems: [{ intent: "SALES_SCHEDULE_CALLBACK", count: 2 }], actionItemsTotal: 2, actionItemsOpen: 5, actionItemsOverdue: 1,
    appointments: [{ customer: "A", sched: "Wed · 9:00 AM" }], assistedAppointmentList: [{ customer: "B", assisted: true }], topVehicles: [{ name: "Civic", count: 2 }], topVehiclesDays: 7 };
  for (const cadence of ["daily", "weekly", "monthly"]) for (const dept of ["sales", "service"]) for (const tpl of ["v1", "v2"]) {
    if (cadence !== "daily" && tpl === "v1") continue; // weekly/monthly exist only in v2
    const localDate = cadence === "monthly" ? "2026-09-01" : "2026-10-04";
    const html = runner.renderDigest(tpl, "Rooftop", dept, "label", "e1", "t1", localDate, TZ, m, [], cadence, { cfg: {} });
    assert.ok(html.length > 2000, `${cadence}/${dept}/${tpl}`);
    assert.doesNotMatch(html, /NaN|undefined/, `${cadence}/${dept}/${tpl}`);
  }
});
