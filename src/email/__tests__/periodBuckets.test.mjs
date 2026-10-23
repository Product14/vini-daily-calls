/* Which tracker column a digest run lands in.
 *
 * Regression guard for 2026-10-08: the weekly and monthly grids were blank for every rooftop because a
 * cell only matched a run whose local_date was EXACTLY the column date (anchor − i weeks / months, same
 * weekday / day-of-month as "today"). The cron writes a weekly run on the Sunday before the send and a
 * monthly run on the 1st of the reported month, so on a Thursday the 8th neither could ever match: the
 * 20 weekly digests sent on 2026-09-28 showed as "✓0", and the stuck October monthly was invisible.
 *
 * Run: node --experimental-strip-types --test src/email/__tests__/periodBuckets.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { columnDate, columnIndexFor, bucketRuns, periodLabel, scheduledIsStale } from "../periodBuckets.ts";

const ANCHOR = "2026-10-08"; // the grid's "today" in the 2026-10-08 screenshots (a Thursday)

test("monthly: the cron's run (1st of the reported month) lands in that month's column", () => {
  assert.equal(columnIndexFor("2026-09-01", "monthly", ANCHOR, 6), 1); // September report, sent Oct 1
  assert.equal(columnIndexFor("2026-08-01", "monthly", ANCHOR, 6), 2);
  assert.equal(columnIndexFor("2026-10-07", "monthly", ANCHOR, 6), 0); // on-demand send on Oct 8 (local_date = yesterday)
  assert.equal(columnIndexFor("2026-05-31", "monthly", ANCHOR, 6), 5); // oldest visible month
  assert.equal(columnIndexFor("2026-04-30", "monthly", ANCHOR, 6), -1); // out of the window
  assert.equal(columnIndexFor("2026-11-01", "monthly", ANCHOR, 6), -1); // after the anchor
});

test("weekly: a column is the 7 days ending on its date", () => {
  // column 0 = Oct 2..Oct 8, column 1 = Sep 25..Oct 1, column 2 = Sep 18..Sep 24
  assert.equal(columnIndexFor("2026-10-08", "weekly", ANCHOR, 8), 0);
  assert.equal(columnIndexFor("2026-10-04", "weekly", ANCHOR, 8), 0); // the (missing) Oct 5 weekly
  assert.equal(columnIndexFor("2026-10-02", "weekly", ANCHOR, 8), 0);
  assert.equal(columnIndexFor("2026-10-01", "weekly", ANCHOR, 8), 1);
  assert.equal(columnIndexFor("2026-09-27", "weekly", ANCHOR, 8), 1); // sent Mon Sep 28 (20 rooftops)
  assert.equal(columnIndexFor("2026-09-20", "weekly", ANCHOR, 8), 2);
  assert.equal(columnIndexFor("2026-08-14", "weekly", ANCHOR, 8), 7);  // 55 days back = oldest day of column 7
  assert.equal(columnIndexFor("2026-08-13", "weekly", ANCHOR, 8), -1); // 56 days back, past the window
  assert.equal(columnIndexFor("2026-10-09", "weekly", ANCHOR, 8), -1);
});

test("daily: unchanged — one column per exact date", () => {
  assert.equal(columnIndexFor("2026-10-08", "daily", ANCHOR, 14), 0);
  assert.equal(columnIndexFor("2026-10-07", "daily", ANCHOR, 14), 1);
  assert.equal(columnIndexFor("2026-09-25", "daily", ANCHOR, 14), 13);
  assert.equal(columnIndexFor("2026-09-24", "daily", ANCHOR, 14), -1);
});

test("columnDate steps back by the cadence, clamping month-end overflow", () => {
  assert.equal(columnDate(ANCHOR, "daily", 1), "2026-10-07");
  assert.equal(columnDate(ANCHOR, "weekly", 1), "2026-10-01");
  assert.equal(columnDate(ANCHOR, "monthly", 1), "2026-09-08");
  assert.equal(columnDate("2026-03-31", "monthly", 1), "2026-02-28"); // not Mar 3
  assert.equal(columnDate("2026-01-15", "monthly", 2), "2025-11-15");
  assert.equal(columnIndexFor("2026-02-01", "monthly", "2026-03-31", 6), 1);
});

test("bucketRuns: one column per period, every run of the cadence in the window kept, newest order preserved", () => {
  const runs = [
    { id: "a", cadence: "monthly", local_date: "2026-10-07", status: "sent" },      // manual, Oct
    { id: "b", cadence: "monthly", local_date: "2026-09-01", status: "scheduled" }, // cron, Sep (stuck)
    { id: "c", cadence: "weekly", local_date: "2026-09-27", status: "sent" },       // other cadence
    { id: "d", cadence: "monthly", local_date: "2026-08-01", status: "sent" },
    { id: "e", cadence: "monthly", local_date: "2026-08-20", status: "not_sent" },  // a 2nd August run
  ];
  const cols = bucketRuns(runs, "monthly", ANCHOR, 6);
  assert.equal(cols.length, 6);
  assert.deepEqual(cols.map((c) => c.map((r) => r.id)), [["a"], ["b"], ["d", "e"], [], [], []]);
});

test("scheduledIsStale: a run still 'scheduled' after its send day (+1 day of zone slack) was never sent", () => {
  // the stuck October monthly: September's report (local_date 09-01) was due Oct 1
  assert.equal(scheduledIsStale("monthly", "2026-09-01", "2026-10-09"), true);
  assert.equal(scheduledIsStale("monthly", "2026-09-01", "2026-10-02"), false); // still within the slack day
  assert.equal(scheduledIsStale("monthly", "2026-09-01", "2026-10-03"), true);
  // a rooftop that sends its monthly on the 15th is not "missed" on the morning of the 15th
  assert.equal(scheduledIsStale("monthly", "2026-10-01", "2026-11-15", 15), false);
  assert.equal(scheduledIsStale("monthly", "2026-10-01", "2026-11-17", 15), true);
  // December report → due January (year rollover)
  assert.equal(scheduledIsStale("monthly", "2026-12-01", "2027-01-02"), false);
  // daily: report day D is sent on D+1; the 16 rows stuck on 2026-09-30
  assert.equal(scheduledIsStale("daily", "2026-09-30", "2026-10-09"), true);
  assert.equal(scheduledIsStale("daily", "2026-10-08", "2026-10-09"), false); // today's pending sends
  assert.equal(scheduledIsStale("daily", "2026-10-07", "2026-10-09"), false); // slack day
  // weekly: the cron stamps the day before the send day
  assert.equal(scheduledIsStale("weekly", "2026-10-04", "2026-10-06"), false);
  assert.equal(scheduledIsStale("weekly", "2026-10-04", "2026-10-07"), true);
});

test("an empty anchor (the grid before its first load) never throws", () => {
  // The header renders before the data arrives, with today = "". toISOString() on that date threw
  // "Invalid time value" and took the whole tracker down (caught in the local browser check).
  assert.equal(columnDate("", "monthly", 1), "");
  assert.equal(columnDate("", "weekly", 0), "");
  assert.equal(columnIndexFor("2026-09-01", "monthly", "", 6), -1);
  assert.equal(periodLabel("weekly", ""), "");
  assert.equal(scheduledIsStale("daily", "", "2026-10-09"), false);
});

test("periodLabel names the period a column covers", () => {
  assert.equal(periodLabel("monthly", "2026-09-08"), "September 2026");
  assert.equal(periodLabel("weekly", "2026-10-01"), "Sep 25 – Oct 1");
  assert.equal(periodLabel("weekly", "2026-01-03"), "Dec 28 – Jan 3");
});
