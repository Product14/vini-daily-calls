/* Which tracker column a digest run belongs to.
 *
 * Columns are anchored to the grid's "today": column i is today − i days / weeks / months. A DAILY run
 * matches its column by exact date. WEEKLY and MONTHLY runs cannot: the cron stamps a weekly run with
 * the Sunday before the send and a monthly run with the 1st of the reported month (runner.cjs
 * cadenceWindow), and the on-demand path stamps either with "yesterday". So a periodic column is a
 * PERIOD — the 7 days ending on the column date, or the column date's calendar month — and a run lands
 * in the column whose period contains its local_date. Matching by exact date (the old rule) left every
 * weekly and monthly cell blank.
 *
 * Pure and dependency-free so it can be unit tested under plain node (see __tests__/periodBuckets).
 */
export type PeriodCadence = "daily" | "weekly" | "monthly";

const DAY_MS = 86_400_000;
const toUtc = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toIso = (dt: Date): string => dt.toISOString().slice(0, 10);
// The grid renders its headers before the first load, with an empty anchor. Every helper here
// answers "nothing" for an unparseable date instead of letting toISOString() throw.
const bad = (dt: Date): boolean => Number.isNaN(dt.getTime());

/** Column i's date: `anchor` stepped back i days / weeks / months. A month step clamps to the target
 * month's last day (Mar 31 − 1 month = Feb 28, not Mar 3). */
export function columnDate(anchor: string, cadence: PeriodCadence, i: number): string {
  const dt = toUtc(anchor);
  if (bad(dt)) return "";
  if (cadence === "daily") dt.setUTCDate(dt.getUTCDate() - i);
  else if (cadence === "weekly") dt.setUTCDate(dt.getUTCDate() - i * 7);
  else {
    const day = dt.getUTCDate();
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() - i);
    const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(day, lastDay));
  }
  return toIso(dt);
}

/** Index of the column whose period contains `localDate`, or −1 when it falls outside the `count`
 * columns ending at `anchor` (including anything dated after the anchor). */
export function columnIndexFor(localDate: string, cadence: PeriodCadence, anchor: string, count: number): number {
  if (bad(toUtc(anchor)) || bad(toUtc(localDate))) return -1;
  let i: number;
  if (cadence === "monthly") {
    const a = toUtc(anchor), d = toUtc(localDate);
    i = (a.getUTCFullYear() * 12 + a.getUTCMonth()) - (d.getUTCFullYear() * 12 + d.getUTCMonth());
  } else {
    const days = Math.round((toUtc(anchor).getTime() - toUtc(localDate).getTime()) / DAY_MS);
    if (days < 0) return -1;
    i = cadence === "weekly" ? Math.floor(days / 7) : days;
  }
  return i >= 0 && i < count ? i : -1;
}

/** Runs of one cadence grouped into `count` columns (index 0 = the anchor's period). Runs of other
 * cadences, or outside the window, are dropped. Input order is kept within a column. */
export function bucketRuns<R extends { cadence: string; local_date: string }>(
  runs: R[], cadence: PeriodCadence, anchor: string, count: number,
): R[][] {
  const cols: R[][] = Array.from({ length: count }, () => []);
  for (const r of runs) {
    if (r.cadence !== cadence) continue;
    const i = columnIndexFor(r.local_date, cadence, anchor, count);
    if (i >= 0) cols[i].push(r);
  }
  return cols;
}

/** A run in status "scheduled" is waiting for its send time. Once the day it was due has passed, no pass
 * is coming back for it: it was missed. Due = the day after the report for daily and weekly (the cron
 * stamps the day before it sends), and `monthlySendDay` of the following month for monthly (the cron
 * stamps the 1st of the reported month). One extra day of slack, because `today` is a UTC date while
 * the dealer's own day runs up to 10 hours behind it. */
export function scheduledIsStale(cadence: PeriodCadence, localDate: string, today: string, monthlySendDay = 1): boolean {
  const d = toUtc(localDate);
  if (bad(d) || bad(toUtc(today))) return false;
  const due = cadence === "monthly"
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, monthlySendDay))
    : new Date(d.getTime() + DAY_MS);
  return toUtc(today).getTime() > due.getTime() + DAY_MS;
}

/** Human name for the period a weekly/monthly column covers: "September 2026", "Sep 25 – Oct 1". */
export function periodLabel(cadence: PeriodCadence, colDate: string): string {
  const end = toUtc(colDate);
  if (bad(end)) return "";
  if (cadence === "monthly") return end.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (cadence === "weekly") return `${fmt(new Date(end.getTime() - 6 * DAY_MS))} – ${fmt(end)}`;
  return fmt(end);
}
