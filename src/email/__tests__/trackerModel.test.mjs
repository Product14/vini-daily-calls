/* The tracker's numbers: anchor, due cells, missed vs not set up, labels, counts, transactional KPIs.
 *
 * Regression guard for the 2026-10-08 audit (A4):
 *   F1  a churned Guam rooftop moved the grid's anchor to an empty "today" → "Sent today 0 · 0 of 0";
 *   F2  38 live departments with no digest row read "—" and sat outside the rate (25/155 vs 25/96);
 *   F7  churned / data-stale / dry-run / in-flight rows all read "Scheduler skipped → Send now";
 *   F5  four "rooftop" counts;  F12 transactional "Sent" read 205% (ledger ÷ ClickHouse);
 *   F11 opening a stored email in the tracker fired its open pixel.
 *
 * Run: node --experimental-strip-types --test src/email/__tests__/*.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  latestDueKey, liveAnchor, buildCells, summarizeDue, columnStats, rooftopCounts, actionBoard, rowMatchesBoard,
  txKpi, neutralizeTracking, STATE_META, REASON_STATE, classifyCell, dueCellIndex, rowDueKeys,
  eventReasonLabel, isAliasRow,
} from "../trackerModel.ts";
import { periodKeyForColumn } from "../periodBuckets.ts";

const ET = { timezone: "America/New_York", sendHour: 7, sendMinute: 0, weeklySendDow: 1, monthlySendDay: 1 };
const GUAM = { ...ET, timezone: "Pacific/Guam" };
const PT = { ...ET, timezone: "America/Los_Angeles" };
const at = (iso) => new Date(iso);
const facts = (o = {}) => ({ dryRun: false, churnedOn: () => false, toggleOn: { daily: true, weekly: true, monthly: true }, configured: true, eligible: { daily: 2, weekly: 2, monthly: 2 }, ...o });
const run = (local_date, status, reason = null, o = {}) => ({ id: `${local_date}-${status}`, department: "sales", cadence: "daily", local_date, status, reason, ...o });

// ── C1: due keys and the anchor ──────────────────────────────────────────────────────────────
test("latestDueKey daily: yesterday once the send time (+ grace) has passed in the dealer's zone, else the day before", () => {
  assert.equal(latestDueKey("daily", ET, at("2026-10-08T14:00:23Z")), "2026-10-07"); // 10:00 ET
  assert.equal(latestDueKey("daily", ET, at("2026-10-08T05:00:00Z")), "2026-10-06"); // 01:00 ET, not sent yet
  assert.equal(latestDueKey("daily", ET, at("2026-10-08T11:30:00Z")), "2026-10-06"); // 07:30 ET, inside the grace
  assert.equal(latestDueKey("daily", ET, at("2026-10-08T12:31:00Z")), "2026-10-07"); // 08:31 ET
  assert.equal(latestDueKey("daily", PT, at("2026-10-08T14:00:23Z")), "2026-10-06"); // 07:00 PT, grace not over
  assert.equal(latestDueKey("daily", { ...ET, timezone: "Not/AZone" }, at("2026-10-08T14:00:23Z")), "2026-10-07"); // bad zone → New York
});

test("latestDueKey weekly/monthly follow the send day and stamp the cron's key", () => {
  // Thu 2026-10-08: last Monday send was Oct 5 → key Sun Oct 4.
  assert.equal(latestDueKey("weekly", ET, at("2026-10-08T14:00:00Z")), "2026-10-04");
  // Mon Oct 5 before the send → the previous week's key (Sep 27).
  assert.equal(latestDueKey("weekly", ET, at("2026-10-05T10:00:00Z")), "2026-09-27");
  assert.equal(latestDueKey("weekly", ET, at("2026-10-05T13:00:00Z")), "2026-10-04");
  // Monthly on the 1st: on Oct 8 the September report is due (key Sep 1); on Oct 1 at 06:00 it isn't yet.
  assert.equal(latestDueKey("monthly", ET, at("2026-10-08T14:00:00Z")), "2026-09-01");
  assert.equal(latestDueKey("monthly", ET, at("2026-10-01T10:00:00Z")), "2026-08-01");
  assert.equal(latestDueKey("monthly", { ...ET, monthlySendDay: 15 }, at("2026-10-08T14:00:00Z")), "2026-08-01");
});

test("liveAnchor: one far-timezone rooftop can never move the grid (lower median)", () => {
  const now = at("2026-10-08T23:30:00Z"); // 09:30 Oct 9 in Guam, 19:30 Oct 8 in New York
  const us = Array.from({ length: 10 }, () => latestDueKey("daily", ET, now));
  assert.equal(us[0], "2026-10-07");
  assert.equal(latestDueKey("daily", GUAM, now), "2026-10-08");
  assert.equal(liveAnchor([...us, latestDueKey("daily", GUAM, now)], now), "2026-10-07");
  assert.equal(liveAnchor([latestDueKey("daily", ET, now), latestDueKey("daily", GUAM, now)], now), "2026-10-07");
  assert.equal(liveAnchor([], at("2026-10-08T23:30:00Z")), "2026-10-07");
});

test("KPI strip reads each department's latest DUE cell, so the US morning is never '0 of 0'", () => {
  const now = at("2026-10-08T05:00:00Z"); // 01:00 ET: Oct 7 not sent yet anywhere
  const anchor = "2026-10-07"; // even if some other process put the anchor on the pending day
  const rows = ["a", "b", "c"].map((t, i) => {
    const runs = [run("2026-10-07", "scheduled"), ...(i < 2 ? [run("2026-10-06", "sent")] : [])];
    const dueKey = latestDueKey("daily", ET, now);
    return { team_id: t, rooftop_id: t, department: "sales", name: t, dueKey, cells: buildCells(runs, "daily", anchor, facts(), ET, now, dueKey) };
  });
  assert.equal(rows[0].cells[0].state, "scheduled"); // column 0 is pending, not a failure
  const k = summarizeDue(rows, "daily", anchor);
  assert.deepEqual([k.sent, k.notSent, k.rated, k.sentRatePct], [2, 1, 3, 67]); // Oct 6: 2 sent, 1 missed
});

// ── C2: missed vs not set up ─────────────────────────────────────────────────────────────────
test("an expected department with no row on a due day is Missed and counts against the rate", () => {
  const now = at("2026-10-08T14:00:00Z");
  const due = latestDueKey("daily", ET, now);
  const mk = (f, runs = []) => buildCells(runs, "daily", "2026-10-07", facts(f), ET, now, due)[0];
  assert.equal(mk({}).state, "missed");
  assert.equal(STATE_META.missed.label, "Missed");
  assert.equal(STATE_META.missed.tone, "negative");
  assert.equal(mk({ dryRun: true }).state, "not_set_up");
  assert.equal(mk({ eligible: { daily: 0 } }).state, "not_set_up");
  assert.equal(mk({ toggleOn: { daily: false, weekly: false, monthly: false } }).state, "no_run");
  assert.equal(mk({ churnedOn: () => true }).state, "churned");
  assert.equal(mk({}, [run("2026-10-07", "error", "error")]).state, "failed");
  // the not-due pending column is not missed
  const pending = buildCells([], "daily", "2026-10-08", facts(), ET, now, due)[0];
  assert.equal(pending.state, "not_due");
});

test("summarizeDue: error and missed are not sent; dry run / nobody eligible are not set up; no activity is out of the rate", () => {
  const now = at("2026-10-08T14:00:00Z");
  const due = latestDueKey("daily", ET, now);
  const row = (t, f, runs) => ({ team_id: t, rooftop_id: t, department: "sales", name: t, dueKey: due, cells: buildCells(runs, "daily", "2026-10-07", facts(f), ET, now, due) });
  const rows = [
    row("sent1", {}, [run("2026-10-07", "sent", null, { opened_at: "2026-10-07T13:00:00Z" })]),
    row("sent2", {}, [run("2026-10-07", "sent")]),
    row("missed", {}, []),
    row("failed", {}, [run("2026-10-07", "error", "error")]),
    row("stale", {}, [run("2026-10-07", "scheduled")]),
    row("dry", { dryRun: true }, [run("2026-10-07", "suppressed", "dry_run")]),
    row("dry-empty", { dryRun: true }, []),
    row("nobody", { eligible: { daily: 0 } }, []),
    row("quiet", {}, [run("2026-10-07", "not_sent", "no_data")]),
    row("churn", {}, [run("2026-10-07", "not_sent", "churned")]),
  ];
  const k = summarizeDue(rows, "daily", "2026-10-07");
  assert.deepEqual({ sent: k.sent, notSent: k.notSent, setup: k.setup, silent: k.silent, excluded: k.excluded, rated: k.rated, rate: k.sentRatePct, opened: k.opened },
    { sent: 2, notSent: 3, setup: 3, silent: 1, excluded: 1, rated: 5, rate: 40, opened: 1 });
  const cols = columnStats(rows, 14);
  assert.deepEqual([cols[0].sent, cols[0].notSent], [2, 3], "the column header's ✕ includes the missed cell");
});

test("weekly/monthly KPI reads the latest due period, not the unfinished current one (C24)", () => {
  const now = at("2026-10-08T14:00:00Z");
  const due = latestDueKey("monthly", ET, now); // 2026-09-01
  const sep = [{ ...run("2026-09-01", "scheduled"), cadence: "monthly" }];
  const cells = buildCells(sep, "monthly", "2026-10-07", facts(), ET, now, due);
  assert.equal(cells[0].state, "not_due"); // October: not due until Nov 1
  assert.equal(cells[1].state, "missed");  // September: scheduled and never sent
  assert.equal(dueCellIndex(due, "monthly", "2026-10-07"), 1);
  const k = summarizeDue([{ team_id: "t", rooftop_id: "t", department: "sales", dueKey: due, cells }], "monthly", "2026-10-07");
  assert.deepEqual([k.sent, k.notSent], [0, 1]);
  // weekly: the Oct 5 weekly wrote nothing → the column holding Oct 4 is Missed
  const wdue = latestDueKey("weekly", ET, now);
  const w = buildCells([], "weekly", "2026-10-07", facts(), ET, now, wdue);
  assert.equal(w[dueCellIndex(wdue, "weekly", "2026-10-07")].state, "missed");
  assert.equal(w[dueCellIndex(wdue, "weekly", "2026-10-07")].periodKey, "2026-10-04");
});

// ── C3: explicit labels ──────────────────────────────────────────────────────────────────────
test("every reason the crons write has an explicit label, and holds carry no Send now", () => {
  const label = (reason, status = "not_sent") => {
    const c = classifyCell([run("2026-10-01", status, reason)], { ...facts(), cadence: "daily", due: true, periodKey: "2026-10-01", todayIso: "2026-10-08" });
    return { state: c.state, label: STATE_META[c.state].label, cta: STATE_META[c.state].cta, detail: c.detail };
  };
  assert.deepEqual(label("churned"), { state: "churned", label: "Churned", cta: null, detail: undefined });
  assert.equal(label("dry_run", "suppressed").label, "Held: dry run");
  assert.equal(label("dry_run", "suppressed").cta, null);
  assert.equal(label("aggregate_stale").label, "Data not ready");
  assert.equal(label("aggregate_stale").cta, null);
  assert.equal(label("disabled").label, "Paused");
  assert.equal(label("unsubscribed").label, "Recipients opted out");
  assert.equal(label("pass_killed").label, "Delivery unknown");
  assert.equal(label("pass_killed").cta, null);
  assert.equal(label("backfilled").label, "History only");
  assert.equal(label("recipients_missing").label, "Recipients missing");
  for (const r of ["no_data", "not_actionable", "guardrail_failed"]) assert.equal(label(r).label, "No activity", r);
  assert.equal(label("missed_send_day").label, "Missed send day");
  for (const s of ["queued", "sending"]) {
    const fresh = classifyCell([run("2026-10-07", s)], { ...facts(), cadence: "daily", due: true, periodKey: "2026-10-07", todayIso: "2026-10-08" });
    assert.equal(STATE_META[fresh.state].label, "Sending", s);
    assert.equal(STATE_META[fresh.state].cta, null);
    const old = classifyCell([run("2026-10-03", s)], { ...facts(), cadence: "daily", due: true, periodKey: "2026-10-03", todayIso: "2026-10-08" });
    assert.equal(STATE_META[old.state].label, "Delivery unknown", `${s} long past its day`);
  }
  // An unknown reason shows itself instead of borrowing another label.
  const odd = label("something_new");
  assert.equal(odd.state, "unknown");
  assert.equal(odd.cta, null);
  assert.match(odd.detail, /something_new/);
  assert.ok(Object.values(STATE_META).every((m) => !/Scheduler skipped/.test(m.label)));
  assert.ok(Object.values(STATE_META).every((m) => !/—/.test(m.label + m.help)), "no em dashes in copy");
  for (const [reason, state] of Object.entries(REASON_STATE)) assert.ok(STATE_META[state], reason);
});

// ── C4: one rooftop definition ───────────────────────────────────────────────────────────────
test("rooftopCounts: rooftops are distinct teams; department rows are departments", () => {
  const rows = [
    { team_id: "t1", rooftop_id: "t1::sales", department: "sales" },
    { team_id: "t1", rooftop_id: "t1::service", department: "service" },
    { team_id: "t2", rooftop_id: "t2::service", department: "service" },
  ];
  assert.deepEqual(rooftopCounts(rows), { rooftops: 2, departments: 3, sales: 1, service: 2 });
  assert.deepEqual(rooftopCounts([{ rooftop_id: "x::lifecycle" }]), { rooftops: 1, departments: 0, sales: 0, service: 0 });
});

// ── C5: action board ─────────────────────────────────────────────────────────────────────────
test("action board: distinct rooftops, failures vs setup gaps, dry run off the board", () => {
  const now = at("2026-10-08T14:00:00Z");
  const due = latestDueKey("daily", ET, now);
  const row = (t, dept, f, runs) => ({ team_id: t, rooftop_id: `${t}::${dept}`, department: dept, name: t, dueKey: due, cells: buildCells(runs, "daily", "2026-10-07", facts(f), ET, now, due) });
  const rows = [
    row("A", "sales", {}, []), row("A", "service", {}, []),          // one rooftop, two missed departments
    row("B", "sales", {}, [run("2026-10-07", "error", "error")]),
    row("C", "sales", {}, [run("2026-10-07", "not_sent", "recipients_missing")]),
    row("D", "sales", { eligible: { daily: 0 } }, []),
    row("E", "sales", { dryRun: true }, [run("2026-10-07", "suppressed", "dry_run")]),
    { ...row("G", "sales", { dryRun: true }, [run("2026-10-07", "not_sent", "recipients_missing")]), dryRun: true }, // go-live prep, off the board
    row("F", "sales", {}, [run("2026-10-07", "sent")]),
  ];
  const board = actionBoard(rows, "daily", "2026-10-07");
  const chip = (k) => board.flatMap((g) => g.chips).find((c) => c.key === k);
  assert.equal(board[0].title, "Send failures");
  assert.deepEqual([chip("missed").rooftops, chip("missed").departments], [1, 2]);
  assert.equal(chip("failed").rooftops, 1);
  assert.equal(chip("recipients_missing").rooftops, 2); // C (cron said so) + D (nobody eligible)
  assert.equal(board.flatMap((g) => g.chips).some((c) => c.names.includes("E") || c.names.includes("G")), false);
  assert.equal(rows.filter((r) => rowMatchesBoard(r, "missed", "daily", "2026-10-07")).length, 2);
});

// ── C6: transactional KPIs ───────────────────────────────────────────────────────────────────
test("txKpi: one ledger, one window — never above 100%", () => {
  assert.deepEqual(txKpi({ sent: 349, not_sent: 10, error: 2, suppressed: 40, queued: 1, opened: 120 }),
    { sent: 349, notSent: 12, held: 40, inFlight: 1, attempted: 361, sentRatePct: 97, opened: 120, openRatePct: 34 });
  assert.equal(txKpi({ sent: 0 }).sentRatePct, 0);
  assert.equal(txKpi({ sent: 5, opened: 9 }).openRatePct, 100);
  assert.equal(txKpi(null).attempted, 0);
});

// ── C13: the tracker never fires the open pixel ──────────────────────────────────────────────
test("neutralizeTracking strips track-open pixels and URLs, keeps everything else", () => {
  const html = `<html><body><img src="https://cdn.spyne.ai/logo.png" width="80"><p>Hi</p>
<img src="https://qludnojfibguobgeeujw.supabase.co/functions/v1/track-open?t=a&d=sales&c=daily&dt=2026-10-07" width="1" height="1" alt="" />
<img alt="" src='/api/email/track-open?t=a&dt=2026-10-07'>
<div style="background:url(https://x.supabase.co/functions/v1/track-open?id=9)"></div></body></html>`;
  const out = neutralizeTracking(html);
  assert.equal(/track-open/.test(out), false);
  assert.ok(out.includes("https://cdn.spyne.ai/logo.png"));
  assert.ok(out.includes("<p>Hi</p>"));
  assert.equal(neutralizeTracking(null), "");
});

// ── C14: the clicked period's key ────────────────────────────────────────────────────────────
test("periodKeyForColumn: the cron's key for a column (weekly = the day before the send day)", () => {
  assert.equal(periodKeyForColumn("daily", "2026-10-07"), "2026-10-07");
  assert.equal(periodKeyForColumn("weekly", "2026-10-08", 1), "2026-10-04"); // Oct 2..8 holds Sun Oct 4
  assert.equal(periodKeyForColumn("weekly", "2026-10-01", 1), "2026-09-27");
  assert.equal(periodKeyForColumn("weekly", "2026-10-08", 0), "2026-10-03"); // Sunday sends → Saturday key
  assert.equal(periodKeyForColumn("monthly", "2026-09-08"), "2026-09-01");
  assert.equal(periodKeyForColumn("monthly", ""), "");
  assert.deepEqual(Object.keys(rowDueKeys(ET, at("2026-10-08T14:00:00Z"))), ["daily", "weekly", "monthly"]);
});

// ── C16: the editor's zone list is the server's allowlist ────────────────────────────────────
test("timezones.ts mirrors sendGates.NA_TIMEZONES exactly", async () => {
  const { NA_TIMEZONES } = await import("../timezones.ts");
  const { createRequire } = await import("node:module");
  const gates = createRequire(import.meta.url)("../../../server/roi-cron/sendGates.cjs");
  assert.deepEqual(NA_TIMEZONES, gates.NA_TIMEZONES);
  for (const tz of NA_TIMEZONES) assert.equal(gates.timezoneProblem(tz), null, tz);
});

test("sent cells carry no leftover failure detail; long details are trimmed", () => {
  const ctx = { ...facts(), cadence: "daily", due: true, periodKey: "2026-10-05", todayIso: "2026-10-08" };
  assert.equal(classifyCell([run("2026-10-05", "sent", null, { reason_detail: "reporting-api 504 FUNCTION_INVOCATION_TIMEOUT" })], ctx).detail, undefined);
  const long = classifyCell([run("2026-10-05", "error", "error", { reason_detail: "x\n".repeat(400) })], ctx).detail;
  assert.ok(long.length <= 220 && !/\n/.test(long));
});

test("transactional reasons read as words; alias rows are bookkeeping", () => {
  assert.equal(eventReasonLabel("dept_fallback:service"), "Sent to the service team: this department has no live row");
  assert.equal(eventReasonLabel("pass_killed"), "Not sent: the pass was interrupted");
  assert.equal(eventReasonLabel("manual_override:dry_run+already_sent"), "Sent by hand, override: dry run, already sent");
  assert.equal(eventReasonLabel(null), "");
  assert.equal(isAliasRow({ reason: "alias_of:call:lead:x:2026-10-07:t1" }), true);
  assert.equal(isAliasRow({ reason: "dry_run" }), false);
});
