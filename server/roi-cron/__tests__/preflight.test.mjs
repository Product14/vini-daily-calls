/* Cron preflight + fail-closed cron auth.
 *
 * Regression guards for configuration breakages that each ran silently for days:
 *   · SLACK_BOT_TOKEN unset in prod → every alert went to a log line (found 2026-10-08)
 *   · Twilio credentials rejected (401 / 20003) from 2026-10-02 → every SMS failed for a week
 *   · a migration re-run dropped/narrowed schema → every send 400'd (15185c7, dc8ece5, b75d326)
 *   · 9 cron routes answered anyone when CRON_SECRET was unset (`if (secret && …)`)
 *
 * Fully offline: fake Supabase client, fake fetch for Twilio + Slack.
 * Run: node --test server/roi-cron/__tests__/preflight.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const P = require("../preflight.cjs");

// Schema = the columns every table has. `drop` removes some to simulate drift.
function fakeSb({ drop = {}, smsEnabled = false, rows = {} } = {}) {
  const schema = Object.fromEntries(Object.entries(P.REQUIRED_COLUMNS).map(([t, c]) => [t, new Set(c.split(",").filter((x) => !(drop[t] || []).includes(x)))]));
  const db = { roi_cron_runs: [], ...rows };
  const writes = [];
  const sb = {
    db, writes,
    from(table) {
      const q = { cols: null, f: [], op: "select", limit: null, order: null };
      const b = {
        select(cols) { q.cols = cols; return b; },
        eq(k, v) { q.f.push((r) => r[k] === v); return b; },
        gte(k, v) { q.f.push((r) => r[k] >= v); return b; },
        order(k, o) { q.order = [k, o?.ascending !== false]; return b; },
        limit(n) { q.limit = n; return b; },
        range() { return b; },
        insert(row) { q.op = "insert"; q.row = row; return b; },
        then(res, rej) {
          if (q.op === "insert") { writes.push({ table, row: q.row }); db[table] = db[table] || []; db[table].push({ created_at: new Date().toISOString(), ...q.row }); return Promise.resolve({ data: null, error: null }).then(res, rej); }
          if (!schema[table] && table !== "roi_cron_runs") return Promise.resolve({ data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}'` } }).then(res, rej);
          const missing = (q.cols || "").split(",").find((c) => c && schema[table] && !schema[table].has(c));
          if (missing) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } }).then(res, rej);
          let data = table === "roi_rooftop_config" ? (smsEnabled ? [{ team_id: "t1", sms_enabled: true }] : []) : (db[table] || []);
          data = data.filter((r) => q.f.every((fn) => fn(r)));
          if (q.order) { const [k, asc] = q.order; data = [...data].sort((x, y) => (x[k] < y[k] ? -1 : 1) * (asc ? 1 : -1)); }
          if (q.limit != null) data = data.slice(0, q.limit);
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
  return sb;
}
const GOOD_ENV = { ROI_SUPABASE_URL: "http://sb.test", ROI_SUPABASE_SERVICE_KEY: "k", MAIL_TOKEN: "m", CRON_SECRET: "c", REPORTING_CRON_SECRET: "r", SLACK_BOT_TOKEN: "xoxb", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+15555550100", SMS_DRY_RUN: "false" };
function twilioFetch(status, body) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization }); return new Response(JSON.stringify(body), { status }); };
  f.calls = calls;
  return f;
}
const keys = (r) => r.problems.map((p) => p.key).sort();

test("healthy config → ok, no problems, and the Twilio check is one read-only GET", async () => {
  P._reset();
  const f = twilioFetch(200, { status: "active" });
  const r = await P.preflight({ sb: fakeSb({ smsEnabled: true }), env: GOOD_ENV, fetch: f, fresh: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC1\.json$/);
  assert.equal(f.calls[0].method, "GET", "read-only account fetch, never Messages.json");
});

test("env missing: no Supabase creds is FATAL; Slack/mail/secrets are reported but the pass continues", async () => {
  P._reset();
  const r = await P.preflight({ env: {}, fresh: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.find((p) => p.key === "env:supabase").fatal);
  for (const k of ["env:MAIL_TOKEN", "env:CRON_SECRET", "env:REPORTING_CRON_SECRET", "env:SLACK_BOT_TOKEN"]) {
    const p = r.problems.find((x) => x.key === k);
    assert.ok(p && !p.fatal, k);
  }
  P._reset();
  const r2 = await P.preflight({ sb: fakeSb(), env: { ...GOOD_ENV, SLACK_BOT_TOKEN: "" }, fresh: true });
  assert.equal(r2.ok, true, "a missing Slack token must not stop dealers' emails");
  assert.deepEqual(keys(r2), ["env:SLACK_BOT_TOKEN"]);
});

test("env: test-only overrides left on in production are flagged", async () => {
  P._reset();
  const r = await P.preflight({ sb: fakeSb(), env: { ...GOOD_ENV, FORCE_RESEND: "true", ONLY_TEAMS: "abc" }, fresh: true });
  assert.deepEqual(keys(r), ["env:FORCE_RESEND", "env:ONLY_TEAMS"]);
});

test("schema drift: every missing column is named, per table", async () => {
  P._reset();
  const sb = fakeSb({ drop: { roi_digest_runs: ["reason_detail", "dealer_timezone"], roi_recipients: ["verified_at"] } });
  const r = await P.preflight({ sb, env: GOOD_ENV, fresh: true });
  assert.equal(r.ok, true, "schema problems alert but do not abort");
  assert.deepEqual(keys(r), ["schema:roi_digest_runs", "schema:roi_recipients"]);
  const d = r.problems.find((p) => p.key === "schema:roi_digest_runs").detail;
  assert.match(d, /missing column\(s\) the send path uses: dealer_timezone, reason_detail|reason_detail, dealer_timezone/);
  assert.match(r.problems.find((p) => p.key === "schema:roi_recipients").detail, /verified_at/);
  assert.deepEqual(sb.writes, [], "schema check writes nothing");
});

test("Twilio 401 → problem; probed at most once a day, shared across instances; new credentials re-probe", async () => {
  P._reset();
  const sb = fakeSb({ smsEnabled: true });
  const f = twilioFetch(401, { code: 20003, message: "Authenticate" });
  const r = await P.preflight({ sb, env: GOOD_ENV, fetch: f, fresh: true });
  assert.deepEqual(keys(r), ["twilio:auth"]);
  assert.match(r.problems[0].detail, /HTTP 401, code 20003/);
  assert.equal(f.calls.length, 1);
  assert.equal(sb.writes.filter((w) => w.row.source === P.TWILIO_SOURCE).length, 1, "result recorded for other instances");
  assert.ok(!JSON.stringify(sb.writes).includes("tok"), "the secret is never stored");

  await P.preflight({ sb, env: GOOD_ENV, fetch: f, fresh: true });
  assert.equal(f.calls.length, 1, "same instance: no second probe within 24h");

  P._reset(); // a different warm instance: reuses the stored result
  const r3 = await P.preflight({ sb, env: GOOD_ENV, fetch: f, fresh: true });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(keys(r3), ["twilio:auth"]);

  const f2 = twilioFetch(200, { status: "active" }); // credentials rotated → probe again, clears
  const r4 = await P.preflight({ sb, env: { ...GOOD_ENV, TWILIO_AUTH_TOKEN: "rotated" }, fetch: f2, fresh: true });
  assert.equal(f2.calls.length, 1);
  assert.deepEqual(r4.problems, []);
});

test("Twilio: no rooftop has SMS on → no Twilio checks at all", async () => {
  P._reset();
  const f = twilioFetch(401, {});
  const r = await P.preflight({ sb: fakeSb({ smsEnabled: false }), env: { ...GOOD_ENV, TWILIO_AUTH_TOKEN: "" }, fetch: f, fresh: true });
  assert.deepEqual(r.problems, []);
  assert.equal(f.calls.length, 0);
});

test("Twilio: SMS on but credentials missing → env problem, no probe", async () => {
  P._reset();
  const f = twilioFetch(200, {});
  const r = await P.preflight({ sb: fakeSb({ smsEnabled: true }), env: { ...GOOD_ENV, TWILIO_AUTH_TOKEN: "" }, fetch: f, fresh: true });
  assert.deepEqual(keys(r), ["twilio:secret"]);
  assert.equal(f.calls.length, 0);
});

test("memoised per instance for 10 minutes", async () => {
  P._reset();
  const sb = fakeSb();
  let selects = 0;
  const from = sb.from.bind(sb);
  sb.from = (t) => { selects++; return from(t); };
  const t0 = Date.now();
  await P.preflight({ sb, env: GOOD_ENV, now: t0 });
  const n = selects;
  const r = await P.preflight({ sb, env: GOOD_ENV, now: t0 + 9 * 60_000 });
  assert.equal(r.cached, true);
  assert.equal(selects, n);
  await P.preflight({ sb, env: GOOD_ENV, now: t0 + 11 * 60_000 });
  assert.ok(selects > n);
});

test("preflightGate: alerts ONCE per 6h per problem, records it in roi_cron_runs, and the pass continues", async () => {
  P._reset();
  const sb = fakeSb({ drop: { roi_event_sms: ["body"] } });
  const posts = [];
  const post = async (m) => { posts.push(m); };
  const r = await P.preflightGate({ source: "roi-email-daily", sb, post, env: GOOD_ENV });
  assert.equal(r.ok, true);
  assert.equal(posts.length, 1);
  assert.match(posts[0].title, /1 configuration problem before roi-email-daily/);
  assert.match(posts[0].detail, /roi_event_sms is missing column\(s\) the send path uses: body/);
  const rec = sb.writes.find((w) => w.row.source === P.PREFLIGHT_SOURCE);
  assert.deepEqual(rec.row.summary.alerted, ["schema:roi_event_sms"]);

  P._reset(); // another instance, fresh check, same problem → deduped through roi_cron_runs
  await P.preflightGate({ source: "roi-events-shard-0-of-4", sb, post, env: GOOD_ENV });
  assert.equal(posts.length, 1);
});

test("preflightGate never throws: a broken client still lets the pass run", async () => {
  P._reset();
  const sb = { from() { throw new Error("boom"); } };
  const r = await P.preflightGate({ source: "x", sb, post: async () => {}, env: GOOD_ENV });
  assert.equal(r.ok, true);
});

// ── E4: fail closed ───────────────────────────────────────────────────────────────────────────
test("cronAuthorized: refuses everyone when CRON_SECRET is unset (and says so once), else needs the exact bearer", async () => {
  P._reset();
  const saved = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const posts = [];
    const post = async (m) => { posts.push(m); };
    assert.equal(P.cronAuthorized({ headers: {} }, { post }), false);
    assert.equal(P.cronAuthorized({ headers: { authorization: "Bearer undefined" } }, { post }), false);
    assert.equal(P.cronAuthorized({ headers: { authorization: "Bearer " } }, { post }), false);
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 1, "alerted once, not per request");
    process.env.CRON_SECRET = "s3cret";
    assert.equal(P.cronAuthorized({ headers: { authorization: "Bearer s3cret" } }), true);
    assert.equal(P.cronAuthorized({ headers: { authorization: "Bearer s3creT" } }), false);
    assert.equal(P.cronAuthorized({ headers: {} }), false);
  } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
});

test("app.js: no cron route is left failing open, and the email-tracker crons run the preflight", () => {
  const src = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.ok(!/if \(secret && req\.headers\.authorization/.test(src), "fail-open `if (secret && …)` check is gone");
  const routes = [...src.matchAll(/app\.get\((\[?"\/api\/cron\/[^)]*?), async \(req, res\) => \{([\s\S]*?)\n\}\);/g)];
  assert.ok(routes.length >= 9, `found ${routes.length} inline cron routes`);
  for (const [, path, body] of routes) assert.match(body, /cronAuthorized\(req\)/, `${path} checks cronAuthorized`);
  assert.match(src, /function makeAgentsRefreshRoute[\s\S]{0,400}cronAuthorized\(req\)/);
  for (const p of ['"/api/cron/roi-email"', '"/api/cron/roi-digest/:cadence"', '"/api/cron/roi-backfill"', '"/api/cron/roi-events/shard/:shard/:shards"', '"/api/cron/roi-watchdog"']) {
    const hit = routes.find(([, path]) => path.includes(p));
    assert.ok(hit, p);
    assert.match(hit[2], /preflightGate\(/, `${p} runs preflight`);
  }
});
