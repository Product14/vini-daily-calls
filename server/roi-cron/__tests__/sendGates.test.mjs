/* The manual send paths must ask the cron's questions before they email anyone.
 *
 * Regression guard for the 2026-10-08 audit (A4 §2, A5-08): roi-send-now, roi-event-send-now and
 * roi-event-generate-send skipped churn, department dry run, the type toggles and the subscription
 * matrix, so one click on a dry-run department's "Send now" emailed nine dealer addresses, and the
 * key-less event path emailed a type the rooftop had switched off.
 *
 * Pure: no I/O. Run: node --test server/roi-cron/__tests__/sendGates.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const G = require("../sendGates.cjs");
const LIVE_ENV = { DRY_RUN: "false" };
const live = (o = {}) => ({ team_id: "t", department: "sales", is_live: true, dry_run: false, ...o });
const cfg = (o = {}) => ({ team_id: "t", daily_enabled: true, weekly_enabled: true, monthly_enabled: true, post_appointment_enabled: true, post_conversation_enabled: true, action_item_enabled: true, action_item_overdue_enabled: true, lifecycle_status: "live", churn_date: null, ...o });

test("digest: a live, configured, enabled department passes", () => {
  for (const cadence of ["daily", "weekly", "monthly"]) {
    assert.deepEqual(G.canSendDigest({ cfg: cfg(), live: live(), cadence, localDate: "2026-10-07", env: LIVE_ENV }), { ok: true });
  }
});

test("digest: server DRY_RUN refuses and cannot be overridden (same parse as the runner)", () => {
  for (const v of [undefined, "", "true", "1", "yes"]) {
    const g = G.canSendDigest({ cfg: cfg(), live: live(), cadence: "daily", localDate: "2026-10-07", env: { DRY_RUN: v } });
    assert.equal(g.reason, "server_dry_run", String(v));
    assert.equal(G.decide(g, "DANGER").send, false);
  }
  for (const v of ["false", "0", " FALSE "]) assert.equal(G.canSendDigest({ cfg: cfg(), live: live(), localDate: "2026-10-07", env: { DRY_RUN: v } }).ok, true);
});

test("digest: department dry run holds only when dry_run === true, exactly as the cron reads it (C25)", () => {
  assert.equal(G.canSendDigest({ cfg: cfg(), live: live({ dry_run: true }), localDate: "2026-10-07", env: LIVE_ENV }).reason, "dry_run");
  assert.equal(G.canSendDigest({ cfg: cfg(), live: live({ dry_run: null }), localDate: "2026-10-07", env: LIVE_ENV }).ok, true);
  assert.equal(G.canSendDigest({ cfg: cfg(), live: live({ dry_run: undefined }), localDate: "2026-10-07", env: LIVE_ENV }).ok, true);
});

test("digest: churn by stage or by a past churn_date refuses; override is allowed and named", () => {
  const byStage = G.canSendDigest({ cfg: cfg({ lifecycle_status: "churn" }), live: live(), localDate: "2026-10-07", env: LIVE_ENV });
  assert.equal(byStage.reason, "churned");
  assert.equal(byStage.overridable, true);
  const byDate = G.canSendDigest({ cfg: cfg({ churn_date: "2026-10-01" }), live: live(), localDate: "2026-10-07", env: LIVE_ENV });
  assert.equal(byDate.reason, "churned");
  assert.equal(G.canSendDigest({ cfg: cfg({ churn_date: "2026-10-09" }), live: live(), localDate: "2026-10-07", env: LIVE_ENV }).ok, true);
  assert.deepEqual(G.decide(byStage, "DANGER"), { send: true, overridden: "churned" });
  assert.deepEqual(G.decide(byStage, "danger"), { send: false, overridden: null });
  assert.deepEqual(G.decide(byStage, undefined), { send: false, overridden: null });
});

test("digest: a department removed from the emailer (or never live) refuses and cannot be overridden", () => {
  for (const l of [null, live({ is_live: false })]) {
    const g = G.canSendDigest({ cfg: cfg(), live: l, localDate: "2026-10-07", env: LIVE_ENV });
    assert.equal(g.reason, "not_live");
    assert.equal(G.decide(g, "DANGER").send, false);
  }
});

test("digest toggles mirror runner.cjs: daily off only on false; weekly/monthly need true and a config row", () => {
  assert.equal(G.canSendDigest({ cfg: cfg({ daily_enabled: false }), live: live(), cadence: "daily", localDate: "x", env: LIVE_ENV }).reason, "disabled");
  assert.equal(G.canSendDigest({ cfg: cfg({ daily_enabled: null }), live: live(), cadence: "daily", localDate: "x", env: LIVE_ENV }).ok, true);
  assert.equal(G.canSendDigest({ cfg: null, live: live(), cadence: "daily", localDate: "x", env: LIVE_ENV }).ok, true);
  assert.equal(G.canSendDigest({ cfg: cfg({ weekly_enabled: null }), live: live(), cadence: "weekly", localDate: "x", env: LIVE_ENV }).reason, "disabled");
  assert.equal(G.canSendDigest({ cfg: null, live: live(), cadence: "monthly", localDate: "x", env: LIVE_ENV }).reason, "disabled");
  assert.match(G.canSendDigest({ cfg: cfg({ monthly_enabled: false }), live: live(), cadence: "monthly", localDate: "x", env: LIVE_ENV }).label, /Monthly digest is turned off/);
});

test("events: type toggle, missing config, and the lead-capture template", () => {
  const ok = { cfg: cfg(), live: live(), localDate: "2026-10-07", env: LIVE_ENV };
  for (const t of G.EVENT_TYPES) assert.equal(G.canSendEvent({ ...ok, emailType: t }).ok, true, t);
  assert.equal(G.canSendEvent({ ...ok, cfg: cfg({ action_item_enabled: false }), emailType: "action_item" }).reason, "disabled");
  assert.equal(G.canSendEvent({ ...ok, cfg: null, emailType: "post_conversation" }).reason, "disabled");
  const lc = cfg({ post_conversation_template: "lead_capture" });
  for (const t of ["post_appointment", "action_item", "action_item_overdue"]) assert.equal(G.canSendEvent({ ...ok, cfg: lc, emailType: t }).reason, "lead_capture", t);
  assert.equal(G.canSendEvent({ ...ok, cfg: lc, emailType: "post_conversation" }).ok, true);
  assert.equal(G.canSendEvent({ ...ok, emailType: "chat" }).reason, "bad_type");
  assert.equal(G.canSendEvent({ ...ok, live: live({ dry_run: true }), emailType: "post_appointment" }).reason, "dry_run");
});

test("refusalBody tells the tracker whether to offer the typed override", () => {
  const g = G.canSendEvent({ cfg: cfg({ lifecycle_status: "churn" }), live: live(), emailType: "post_appointment", localDate: "x", env: LIVE_ENV });
  assert.deepEqual(G.refusalBody(g), { ok: false, gated: true, reason: "churned", overridable: true, error: g.label });
  const dry = G.canSendEvent({ cfg: cfg(), live: live(), emailType: "post_appointment", localDate: "x", env: {} });
  assert.equal(G.refusalBody(dry).overridable, false);
});

// ── recipients: the cron's predicate, clause for clause ─────────────────────────────────────
const R = (o = {}) => ({ email: "gm@dealer.com", receives_sales: true, receives_service: false, email_enabled: true, verified_at: "2026-01-01", subscriptions: null, ...o });

test("eligibleRecipients = verified ∧ deliverable ∧ dept list ∧ email on ∧ subscribed", () => {
  const people = [
    R({ email: "ok@dealer.com" }),
    R({ email: "unverified@dealer.com", verified_at: null }),
    R({ email: "off@dealer.com", email_enabled: false }),
    R({ email: "service-only@dealer.com", receives_sales: false, receives_service: true }),
    R({ email: "held@dealer.com", suppressed_at: "2026-09-01", suppression_reason: "Hard bounce" }),
    R({ email: "typo@gmial.com" }),
    R({ email: "ph.15550001111@phone.invalid" }),
    R({ email: "optout@dealer.com", subscriptions: { daily: { email: false } } }),
    R({ email: "weekly-only-out@dealer.com", subscriptions: { weekly: { email: false } } }),
  ];
  assert.deepEqual(G.eligibleRecipients(people, "sales", "daily").map((r) => r.email), ["ok@dealer.com", "weekly-only-out@dealer.com"]);
  assert.deepEqual(G.eligibleRecipients(people, "sales", "weekly").map((r) => r.email), ["ok@dealer.com", "optout@dealer.com"]);
  assert.deepEqual(G.eligibleRecipients(people, "service", "daily").map((r) => r.email), ["service-only@dealer.com"]);
  const ex = G.explainRecipients(people, "sales", "daily");
  assert.equal(ex.eligible.length, 2);
  assert.equal(ex.held.find((h) => h.email === "unverified@dealer.com").why, "Not verified for this rooftop");
  assert.equal(ex.held.find((h) => h.email === "off@dealer.com").why, "Paused (email off)");
  assert.equal(ex.held.find((h) => h.email === "held@dealer.com").why, "Hard bounce");
  assert.match(ex.held.find((h) => h.email === "typo@gmial.com").why, /typo/);
  assert.equal(ex.held.find((h) => h.email === "optout@dealer.com").why, "Opted out of Daily digest");
  assert.equal(ex.held.some((h) => h.email === "service-only@dealer.com"), false, "the other department's list is not this department's business");
});

test("drift alarm: the cron's digest predicate still reads exactly the clauses sendGates mirrors", () => {
  const src = readFileSync(new URL("../runner.cjs", import.meta.url), "utf8");
  assert.ok(src.includes('r.verified_at && canEmail(r) && (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled && isSubscribed(r, type, "email")'),
    "runner.cjs subscribedEmails changed: update sendGates.recipientHold to match");
  const ev = readFileSync(new URL("../eventRunner.cjs", import.meta.url), "utf8");
  assert.ok(ev.includes('r.verified_at && canEmail(r) && deptOk(r, d) && r.email_enabled && isSubscribed(r, type, "email")'),
    "eventRunner.cjs emailsForType changed: update sendGates.recipientHold to match");
  assert.ok(ev.includes("const dry = DRY_RUN || L.dry_run === true;"), "eventRunner dry-run rule changed");
});

// ── C8: adding an existing person to the other department ──────────────────────────────────
test("recipientAddPatch: an existing recipient only gains the department flag (never email_enabled)", () => {
  const existing = { id: "r1", receives_sales: true, receives_service: false, email_enabled: true };
  assert.deepEqual(G.recipientAddPatch(existing, { dept: "service", emailEnabled: false }), { receives_service: true });
  assert.deepEqual(G.recipientAddPatch(existing, { dept: "sales", emailEnabled: false, role: "gm" }), { receives_sales: true, role: "gm" });
  assert.deepEqual(G.recipientAddPatch(existing, { dept: "sales", phone: "" }), { receives_sales: true, phone: null });
});
test("recipientAddPatch: a new recipient is added paused on that list only", () => {
  assert.deepEqual(G.recipientAddPatch(null, { dept: "service", emailEnabled: false }), { receives_sales: false, receives_service: true, email_enabled: false });
  assert.deepEqual(G.recipientAddPatch(null, { dept: "sales" }), { receives_sales: true, receives_service: false, email_enabled: false });
  assert.equal(G.recipientAddPatch(null, { dept: "sales", emailEnabled: true }).email_enabled, true);
});

// ── C16: timezones ─────────────────────────────────────────────────────────────────────────
test("timezoneProblem accepts US/Canadian IANA zones only", () => {
  for (const tz of ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Indiana/Indianapolis"]) {
    assert.equal(G.timezoneProblem(tz), null, tz);
  }
  for (const tz of ["America/NewYork", "Central", "EST", "America/New York", "", "  ", null, 42, "Pacific/Guam", "Asia/Kolkata", "America/Cancun", "America/Costa_Rica", "UTC"]) {
    assert.ok(G.timezoneProblem(tz), String(tz));
  }
  assert.ok(G.ALLOWED_TIMEZONES.length >= 30, "Intl intersection unexpectedly small");
});

// ── C18: programs report relay ─────────────────────────────────────────────────────────────
test("programsReportProblem: @spyne.ai recipients and our own dashboard hosts only", () => {
  assert.equal(G.programsReportProblem({}), null);
  assert.equal(G.programsReportProblem({ recipientsOverride: ["a@spyne.ai", "B@Spyne.AI"], dashboardUrl: "https://vini-daily-calls.vercel.app/programs" }), null);
  assert.equal(G.programsReportProblem({ dashboardUrl: "https://reporting-vini.vercel.app/x" }), null);
  assert.equal(G.programsReportProblem({ dashboardUrl: "https://console.spyne.ai/x" }), null);
  assert.match(G.programsReportProblem({ recipientsOverride: ["victim@dealer.com"] }), /@spyne\.ai/);
  assert.match(G.programsReportProblem({ recipientsOverride: ["a@spyne.ai.evil.com"] }), /@spyne\.ai/);
  assert.match(G.programsReportProblem({ recipientsOverride: ["Bob <a@spyne.ai>"] }), /@spyne\.ai/);
  for (const u of ["https://evil.com", "http://vini-daily-calls.vercel.app", "https://vini-daily-calls.vercel.app.evil.com", "https://evilspyne.ai", "javascript:alert(1)", "not a url"]) {
    assert.match(G.programsReportProblem({ dashboardUrl: u }), /dashboardUrl/, u);
  }
});
