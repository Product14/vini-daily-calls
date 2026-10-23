/* Route-level guards on server/app.js that must hold before any database or mail call.
 *
 *   · C18 / A5-10 — /api/programs/send-report was an open relay (no auth, caller-chosen recipients,
 *     subject and CTA link on a Spyne-branded email from mail.spyne.ai).
 *   · C16 / A4 F4 — /api/rooftop-config saved any timezone string; one bad value stops the hourly
 *     digest pass for every rooftop.
 *   · C26 / A5-21 — /api/email/bounce accepted its secret as ?secret= (it lands in access logs).
 *   · Manual send routes are signed-in only.
 *
 * Offline: no Supabase credentials are set (any route that got as far as the database would answer
 * 500 "not set"), and global fetch throws, so nothing can leave the process.
 * Run: node --test server/roi-cron/__tests__/trackerRoutes.test.mjs
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

let server, base, token;
const outbound = [];

before(async () => {
  Object.assign(process.env, {
    TRACKER_USER: "route-test", TRACKER_PASSWORD: "route-test-pass", TRACKER_AUTH_SECRET: "route-test-secret",
    MAIL_WEBHOOK_SECRET: "hook-secret", DRY_RUN: "true", SMS_DRY_RUN: "true",
  });
  for (const k of ["ROI_SUPABASE_URL", "VITE_ROI_SUPABASE_URL", "ROI_SUPABASE_SERVICE_KEY", "VITE_PROGRAMS_SUPABASE_URL", "VITE_PROGRAMS_SUPABASE_KEY", "MAIL_TOKEN"]) delete process.env[k];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, init);
    outbound.push(u);
    throw new Error(`blocked outbound request in test: ${u}`);
  };
  const quiet = console.log; console.log = () => {};
  const { default: app } = await import("../../app.js");
  console.log = quiet;
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await (await fetch(`${base}/api/tracker/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "route-test", password: "route-test-pass" }) })).json();
  token = login.token;
  assert.ok(token, "login works with the test credentials");
});
after(() => new Promise((r) => server.close(r)));

const post = (path, body, { auth = true, headers = {} } = {}) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: JSON.stringify(body ?? {}),
});
const band = { count: 0, arr: 0 };
const payload = { perAgent: [], section2: [], overall: { totalCount: 0, totalArr: 0, red: band, amber: band, green: band } };

test("programs send-report requires the tracker sign-in", async () => {
  const r = await post("/api/programs/send-report", { payload, recipientsOverride: ["a@spyne.ai"] }, { auth: false });
  assert.equal(r.status, 401);
});

test("programs send-report refuses non-@spyne.ai recipients and foreign links before sending", async () => {
  let r = await post("/api/programs/send-report", { payload, recipientsOverride: ["victim@dealer.com"] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /@spyne\.ai/);
  r = await post("/api/programs/send-report", { payload, recipientsOverride: ["a@spyne.ai"], dashboardUrl: "https://evil.example/phish" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /dashboardUrl/);
  assert.deepEqual(outbound, [], "nothing left the process");
});

test("programs preview drops a foreign link instead of rendering it", async () => {
  const r = await post("/api/programs/send-report?preview=1", { payload, dashboardUrl: "https://evil.example/phish" });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.equal(html.includes("evil.example"), false);
});

test("rooftop-config rejects a timezone the digest pass would crash on (400, before any write)", async () => {
  for (const tz of ["America/NewYork", "Central", "Asia/Kolkata", "America/New York"]) {
    const r = await post("/api/rooftop-config", { teamId: "t1", timezone: tz });
    assert.equal(r.status, 400, tz);
    assert.match((await r.json()).error, /timezone/);
  }
  // A valid zone passes validation and only then needs the database (absent here → 500 "not set").
  const ok = await post("/api/rooftop-config", { teamId: "t1", timezone: "America/Chicago" });
  assert.equal(ok.status, 500);
  assert.match((await ok.json()).error, /ROI_SUPABASE_SERVICE_KEY/);
});

test("bounce webhook takes its secret from the Authorization header only", async () => {
  let r = await fetch(`${base}/api/email/bounce?secret=hook-secret`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/email/bounce`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer hook-secret" }, body: "{}" });
  assert.notEqual(r.status, 401);
});

test("manual send routes are signed-in only", async () => {
  for (const path of ["/api/email/roi-send-now", "/api/email/roi-generate-send", "/api/email/roi-event-send-now", "/api/email/roi-event-generate-send", "/api/recipients", "/api/recipients/toggle"]) {
    const r = await post(path, {}, { auth: false });
    assert.equal(r.status, 401, path);
  }
});

test("generate-send no longer has a bulk mode: teamId is required", async () => {
  const r = await post("/api/email/roi-generate-send", { cadence: "daily" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /teamId/);
});

test("roi-send-now validates the period key before it does anything", async () => {
  const r = await post("/api/email/roi-send-now", { teamId: "t", department: "sales", localDate: "Oct 7", to: ["a@b.com"], html: "<p>x</p>" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /YYYY-MM-DD/);
});
