/* What every digest cell MEANS, and every number the tracker headlines.
 *
 * The 2026-10-08 audit (A4) found the tracker's numbers wrong in ways no single fix covers:
 *   · F1  the grid anchor was the latest run date across ALL rooftops, so a churned rooftop in Guam
 *         turned column 0 into an empty "today" and the headline read "0% · 0 of 0" for ten hours;
 *   · F2  a department that should have been emailed and wasn't showed "—", counted as "not
 *         eligible", and left the rate (25/155 shown, 25/96 true);
 *   · F7  every reason the UI didn't know became "Scheduler skipped → Send now", churned included;
 *   · F5/F6 four different "rooftop" counts, and an action board over the wrong rows.
 * This module is the one place those answers are computed. Pure (no React, no fetch) so it is unit
 * tested under plain node: node --experimental-strip-types --test src/email/__tests__/*.test.mjs
 *
 * Vocabulary:
 *   due       — the period's send time (dealer zone, roi_rooftop_config send hour + weekly/monthly
 *               send day) has passed, plus DUE_GRACE_MINUTES for the hourly pass to get there.
 *   expected  — the cron should have emailed it: the department is live and not in dry run, the
 *               cadence is switched on, the rooftop isn't churned, and someone is eligible.
 *   bucket    — how a cell counts: sent / not_sent (counts against the rate) / setup (not set up:
 *               dry run, nobody eligible) / silent (no activity) / pending / excluded.
 */
import { bucketRuns, columnDate, columnIndexFor, periodKeyForColumn, scheduledIsStale, type PeriodCadence } from "./periodBuckets.ts";
import type { CellRun, SendCell, SendStatus } from "./mockData.ts";

export type Cadence = PeriodCadence;
export const CADENCE_LEN: Record<Cadence, number> = { daily: 14, weekly: 8, monthly: 6 };
/** The hourly digest pass may reach a department up to a pass later than its send time (it stops
 * launching rooftops at its budget and the next pass picks up the rest). A cell is not "missed"
 * until this long after the send time. */
export const DUE_GRACE_MINUTES = 90;

const DAY_MS = 86_400_000;
export function shiftIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The dealer's local calendar date, minutes past midnight and weekday. An unusable zone reads as
 * New York, the same default the tracker always showed, instead of throwing. */
export function dealerClock(now: Date, tz?: string | null): { date: string; minutes: number; dow: number } {
  const read = (zone: string) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    const date = `${g("year")}-${String(g("month")).padStart(2, "0")}-${String(g("day")).padStart(2, "0")}`;
    return { date, minutes: (g("hour") % 24) * 60 + g("minute"), dow: new Date(`${date}T00:00:00Z`).getUTCDay() };
  };
  try { return read(tz || "America/New_York"); } catch { return read("America/New_York"); }
}

export type SendTiming = {
  timezone?: string | null;
  sendHour?: number | null;
  sendMinute?: number | null;
  weeklySendDow?: number | null;
  monthlySendDay?: number | null;
};

/** The newest period (cron key) whose send time has passed for this department.
 *   daily   → the report date (sent the next morning);
 *   weekly  → the day before the latest weekly send day;
 *   monthly → the 1st of the month reported by the latest monthly send. */
export function latestDueKey(cadence: Cadence, t: SendTiming, now: Date, graceMinutes = DUE_GRACE_MINUTES): string {
  const c = dealerClock(new Date(now.getTime() - graceMinutes * 60_000), t.timezone);
  const sendAt = (t.sendHour ?? 7) * 60 + (t.sendMinute ?? 0);
  const past = c.minutes >= sendAt;
  if (cadence === "daily") return shiftIso(c.date, past ? -1 : -2);
  if (cadence === "weekly") {
    const dow = (((t.weeklySendDow ?? 1) % 7) + 7) % 7;
    const delta = (c.dow - dow + 7) % 7;
    let sendDay = shiftIso(c.date, -delta);
    if (delta === 0 && !past) sendDay = shiftIso(sendDay, -7);
    return shiftIso(sendDay, -1);
  }
  const [y, m, d] = c.date.split("-").map(Number);
  const sendDay = Math.min(28, Math.max(1, t.monthlySendDay ?? 1));
  const sentThisMonth = d > sendDay || (d === sendDay && past);
  // The send in month M reports month M-1.
  const reported = new Date(Date.UTC(y, m - 1 - (sentThisMonth ? 1 : 2), 1));
  return reported.toISOString().slice(0, 10);
}

export function rowDueKeys(t: SendTiming, now: Date): Record<Cadence, string> {
  return { daily: latestDueKey("daily", t, now), weekly: latestDueKey("weekly", t, now), monthly: latestDueKey("monthly", t, now) };
}

/** The live grid's right-most date, from the rows on screen only: the LOWER median of their latest
 * due report dates. One rooftop (a churned one, or one far ahead of the US day) cannot move it, and
 * column 0 is due for at least half the rows. No rows → UTC yesterday. */
export function liveAnchor(dueDailyKeys: string[], now: Date): string {
  const keys = dueDailyKeys.filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse();
  if (!keys.length) return shiftIso(now.toISOString().slice(0, 10), -1);
  return keys[Math.floor(keys.length / 2)];
}

// ── Cell states ─────────────────────────────────────────────────────────────────────────────
export type CellState =
  | "sent" | "failed" | "missed" | "missed_send_day" | "delivery_unknown" | "data_not_ready"
  | "in_flight" | "scheduled" | "not_due"
  | "held_dry_run" | "held" | "recipients_missing" | "unsubscribed" | "not_classified" | "not_set_up"
  | "no_activity" | "churned" | "paused" | "history_only" | "no_run" | "unknown";
export type Bucket = "sent" | "not_sent" | "setup" | "silent" | "pending" | "excluded";
export type Tone = "positive" | "negative" | "warn" | "info" | "muted";

export const STATE_META: Record<CellState, { label: string; bucket: Bucket; tone: Tone; cta: string | null; help: string }> = {
  sent: { label: "Sent", bucket: "sent", tone: "positive", cta: null, help: "The digest was emailed." },
  failed: { label: "Failed", bucket: "not_sent", tone: "negative", cta: "Retry", help: "The send was attempted and failed (mail gateway, render or an unexpected error). Retry rebuilds this period's digest and sends it." },
  missed: { label: "Missed", bucket: "not_sent", tone: "negative", cta: "Send now", help: "This department should have been emailed for this period and nothing was sent. Send now builds the digest for this period and sends it." },
  missed_send_day: { label: "Missed send day", bucket: "not_sent", tone: "negative", cta: "Send now", help: "The scheduled send day passed without a send. Send now builds the digest for this period and sends it." },
  delivery_unknown: { label: "Delivery unknown", bucket: "not_sent", tone: "negative", cta: null, help: "A send was started and never finished (the pass was interrupted). The email may or may not have reached the dealer. Check before sending again." },
  data_not_ready: { label: "Data not ready", bucket: "not_sent", tone: "negative", cta: null, help: "The reporting data for this period was not ready, so the digest was held rather than sent with stale numbers." },
  in_flight: { label: "Sending", bucket: "pending", tone: "info", cta: null, help: "A pass is sending this right now. Wait for it to finish." },
  scheduled: { label: "Scheduled", bucket: "pending", tone: "info", cta: null, help: "Waiting for this rooftop's send time. Nothing has been sent yet." },
  not_due: { label: "Not due", bucket: "pending", tone: "muted", cta: null, help: "This period's send time has not come yet for this rooftop." },
  held_dry_run: { label: "Held: dry run", bucket: "setup", tone: "warn", cta: null, help: "The digest was built, but the department is in dry run, so the dealer was not emailed." },
  held: { label: "Held", bucket: "setup", tone: "warn", cta: null, help: "The digest was built and held back." },
  recipients_missing: { label: "Recipients missing", bucket: "setup", tone: "warn", cta: "+ Add recipients", help: "Nobody on this department's list can be emailed. Add and verify a recipient." },
  unsubscribed: { label: "Recipients opted out", bucket: "setup", tone: "warn", cta: null, help: "Everyone on this department's list has opted out of this email." },
  not_classified: { label: "Department not classified", bucket: "setup", tone: "warn", cta: null, help: "This rooftop isn't classified into Sales or Service yet." },
  not_set_up: { label: "Not set up", bucket: "setup", tone: "warn", cta: null, help: "This department isn't set up to send." },
  no_activity: { label: "No activity", bucket: "silent", tone: "muted", cta: null, help: "There was nothing worth sending for this period, so no email went out." },
  churned: { label: "Churned", bucket: "excluded", tone: "muted", cta: null, help: "This rooftop has churned. Scheduled emails skip it." },
  paused: { label: "Paused", bucket: "excluded", tone: "muted", cta: null, help: "This email type is turned off for the rooftop." },
  history_only: { label: "History only", bucket: "excluded", tone: "muted", cta: null, help: "A record written for history. No email was sent." },
  no_run: { label: "No run", bucket: "excluded", tone: "muted", cta: null, help: "No digest for this period, and none was expected." },
  unknown: { label: "Not sent", bucket: "not_sent", tone: "negative", cta: null, help: "Not sent, for a reason the tracker doesn't recognise." },
};

/** Explicit map from the reasons the crons write (roi_digest_runs.reason) to a state. Anything not
 * listed is "unknown" and shows its raw reason: an unrecognised reason is never relabelled as
 * something it isn't (the old default turned churned into "Scheduler skipped → Send now"). */
export const REASON_STATE: Record<string, CellState> = {
  churned: "churned",
  dry_run: "held_dry_run", server_dry_run: "held_dry_run", manual_dry_run: "held_dry_run",
  aggregate_stale: "data_not_ready",
  disabled: "paused",
  unsubscribed: "unsubscribed", not_subscribed: "unsubscribed",
  pass_killed: "delivery_unknown", unknown_outcome: "delivery_unknown",
  backfilled: "history_only",
  recipients_missing: "recipients_missing", recipient_placeholder: "recipients_missing", bounced: "recipients_missing",
  no_data: "no_activity", not_actionable: "no_activity", guardrail_failed: "no_activity", silent_day: "no_activity", no_value: "no_activity",
  missed_send_day: "missed_send_day",
  not_eligible: "not_classified", tag_missing: "not_classified",
  spyne_preview: "held", v2_spyne_only: "held",
  error: "failed", mail_error: "failed", send_failed: "failed", smtp_timeout: "failed",
};

export type RunLite = {
  id?: string | number | null;
  department?: string;
  cadence: string;
  local_date: string;
  status: string;
  reason?: string | null;
  reason_detail?: string | null;
  trigger?: string | null;
  recipients?: { email: string; name?: string; received?: boolean; bounced?: boolean; opened?: boolean; opened_at?: string }[] | null;
  sent_at?: string | null;
  opened_at?: string | null;
  open_count?: number | null;
};

/** What a department's cells need to know beyond its runs. */
export type RowFacts = {
  /** roi_live_departments.dry_run === true (null sends on the cron, so it is NOT dry here). */
  dryRun: boolean;
  /** Churned on that date (lifecycle churn, or a churn_date on/before it), as the cron's isChurned. */
  churnedOn: (isoDate: string) => boolean;
  toggleOn: Record<Cadence, boolean>;
  /** Has a roi_rooftop_config row. Weekly/monthly never send without one. */
  configured: boolean;
  /** Recipients the cron would email per cadence (server-computed). Unknown → assume someone. */
  eligible?: Partial<Record<Cadence, number>>;
};

export type CellContext = RowFacts & { cadence: Cadence; due: boolean; periodKey: string; todayIso: string; monthlySendDay?: number | null };

export type Classified = { state: CellState; detail?: string; rawReason?: string | null; primary?: RunLite };

const PRIORITY: CellState[] = [
  "sent", "in_flight", "scheduled", "failed", "delivery_unknown", "missed", "missed_send_day", "data_not_ready",
  "held_dry_run", "held", "recipients_missing", "unsubscribed", "not_classified", "no_activity",
  "churned", "paused", "history_only", "unknown", "not_set_up", "not_due", "no_run",
];

/** One run's state. */
export function runState(run: RunLite, ctx: CellContext): CellState {
  const st = run.status;
  const reason = run.reason ?? "";
  if (st === "sent") return "sent";
  if (st === "error") return "failed";
  if (st === "backfilled") return "history_only";
  if (st === "queued" || st === "sending") {
    // A claim that outlived its period by a day was never finished by any pass.
    return scheduledIsStale(ctx.cadence, run.local_date, ctx.todayIso, ctx.monthlySendDay ?? 1) ? "delivery_unknown" : "in_flight";
  }
  if (st === "scheduled") return ctx.due ? "missed" : "scheduled";
  if (st === "suppressed") return REASON_STATE[reason] === "held_dry_run" ? "held_dry_run" : "held";
  if (st === "not_subscribed") return "no_run";
  // not_sent (and anything else): by reason.
  if (reason === "before_send_hour") return ctx.due ? "missed" : "scheduled";
  return REASON_STATE[reason] ?? "unknown";
}

/** A cell with no run at all: missed, or why it was never expected. */
export function emptyState(ctx: CellContext): Classified {
  const eligible = ctx.eligible?.[ctx.cadence];
  if (!ctx.due) return { state: ctx.toggleOn[ctx.cadence] && !ctx.churnedOn(ctx.periodKey) ? "not_due" : "no_run" };
  if (ctx.churnedOn(ctx.periodKey)) return { state: "churned" };
  if (!ctx.toggleOn[ctx.cadence] || (ctx.cadence !== "daily" && !ctx.configured)) return { state: "no_run", detail: "This email type is off for the rooftop." };
  if (ctx.dryRun) return { state: "not_set_up", detail: "The department is in dry run." };
  if (eligible === 0) return { state: "not_set_up", detail: "Nobody on the list is eligible (verified, switched on and subscribed)." };
  return { state: "missed" };
}

export function classifyCell(runs: RunLite[], ctx: CellContext): Classified {
  if (!runs.length) return emptyState(ctx);
  let best: { state: CellState; run: RunLite } | null = null;
  for (const run of runs) {
    const state = runState(run, ctx);
    if (!best || PRIORITY.indexOf(state) < PRIORITY.indexOf(best.state)) best = { state, run };
  }
  const b = best!;
  const detail = b.state === "unknown" ? `Reason: ${b.run.reason || b.run.status}` : (b.run.reason_detail || undefined);
  return { state: b.state, detail: detail ?? undefined, rawReason: b.run.reason ?? null, primary: b.run };
}

/** The legacy SendStatus a state maps to (drawer branches and old consumers still read it). */
export function legacyStatus(state: CellState): SendStatus {
  switch (state) {
    case "sent": return "sent";
    case "failed": return "error";
    case "held_dry_run": case "held": return "suppressed";
    case "scheduled": case "in_flight": return "scheduled";
    case "no_run": case "not_due": return "not_subscribed";
    default: return "not_sent";
  }
}

export type BuiltCell = SendCell & {
  state: CellState;
  due: boolean;
  periodKey: string;
  rawReason?: string | null;
  detail?: string;
};

function toCellRun(r: RunLite): CellRun {
  return {
    department: (r.department === "service" ? "service" : "sales"),
    status: r.status as SendStatus,
    reason: r.reason ?? undefined,
    localDate: r.local_date,
    runId: r.id != null ? String(r.id) : undefined,
    openedAt: r.opened_at ?? undefined,
    openCount: r.open_count ?? undefined,
    recipients: (r.recipients ?? undefined)?.map((rec) => ({
      email: rec.email, name: rec.name, received: rec.received, bounced: rec.bounced, opened: rec.opened, openedAt: rec.opened_at,
    })),
  };
}

/** One department's cells for a cadence, anchored at `anchor`. */
export function buildCells(runs: RunLite[], cadence: Cadence, anchor: string, facts: RowFacts, timing: SendTiming, now: Date, dueKey?: string): BuiltCell[] {
  const due = dueKey ?? latestDueKey(cadence, timing, now);
  const todayIso = now.toISOString().slice(0, 10);
  return bucketRuns(runs, cadence, anchor, CADENCE_LEN[cadence]).map((colRuns, i) => {
    const date = columnDate(anchor, cadence, i);
    const runKey = colRuns.find((r) => r.status !== "sent")?.local_date ?? colRuns[0]?.local_date;
    const periodKey = runKey ?? periodKeyForColumn(cadence, date, timing.weeklySendDow ?? 1);
    const ctx: CellContext = { ...facts, cadence, due: !!periodKey && periodKey <= due, periodKey, todayIso, monthlySendDay: timing.monthlySendDay };
    const c = classifyCell(colRuns, ctx);
    return {
      date, cadence, status: legacyStatus(c.state), runs: colRuns.map(toCellRun),
      state: c.state, due: ctx.due, periodKey, rawReason: c.rawReason ?? null, detail: c.detail,
    };
  });
}

/** Which column holds the department's latest due period: the KPI strip reads that cell, not
 * column 0 (column 0 is often a period that isn't due yet, which read "0 of 0"). History mode: a
 * due key after the anchor reads the anchor's own column. -1 = not in the window. */
export function dueCellIndex(dueKey: string, cadence: Cadence, anchor: string, count = CADENCE_LEN[cadence]): number {
  const i = columnIndexFor(dueKey, cadence, anchor, count);
  if (i >= 0) return i;
  return dueKey > anchor ? 0 : -1;
}

// ── KPIs ─────────────────────────────────────────────────────────────────────────────────────
export type DueRow = { team_id?: string; rooftop_id?: string; department?: string; cells: BuiltCell[]; dueKey: string };
export type KpiSummary = {
  sent: number; notSent: number; setup: number; silent: number; pending: number; excluded: number;
  opened: number; rated: number; sentRatePct: number; openRatePct: number; departments: number;
};
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const wasOpened = (c: SendCell) => (c.runs ?? []).some((r) => r.openedAt || (r.openCount ?? 0) > 0 || (r.recipients ?? []).some((x) => x.opened));

/** The KPI strip: one cell per department, its latest due period. Sent rate = sent ÷ (sent + not
 * sent). Not sent = missed + failed + delivery unknown + data not ready + unknown; "not set up"
 * (dry run, nobody eligible, opted out) and "no activity" are counted, but kept out of the rate. */
export function summarizeDue(rows: DueRow[], cadence: Cadence, anchor: string): KpiSummary {
  const out: KpiSummary = { sent: 0, notSent: 0, setup: 0, silent: 0, pending: 0, excluded: 0, opened: 0, rated: 0, sentRatePct: 0, openRatePct: 0, departments: 0 };
  for (const r of rows) {
    const i = dueCellIndex(r.dueKey, cadence, anchor, r.cells.length || CADENCE_LEN[cadence]);
    const cell = i >= 0 ? r.cells[i] : undefined;
    if (!cell) continue;
    out.departments++;
    const b = STATE_META[cell.state].bucket;
    if (b === "sent") { out.sent++; if (wasOpened(cell)) out.opened++; }
    else if (b === "not_sent") out.notSent++;
    else if (b === "setup") out.setup++;
    else if (b === "silent") out.silent++;
    else if (b === "pending") out.pending++;
    else out.excluded++;
  }
  out.rated = out.sent + out.notSent;
  out.sentRatePct = pct(out.sent, out.rated);
  out.openRatePct = pct(out.opened, out.sent);
  return out;
}

export type ColumnStat = { sent: number; notSent: number; setup: number; silent: number; pending: number; excluded: number };
/** Per-column tallies for the header (✓ sent · ✕ not sent · – everything else). A missed cell is ✕. */
export function columnStats(rows: { cells: BuiltCell[] }[], colCount: number): ColumnStat[] {
  const arr = Array.from({ length: colCount }, () => ({ sent: 0, notSent: 0, setup: 0, silent: 0, pending: 0, excluded: 0 }));
  for (const r of rows) {
    for (let i = 0; i < colCount; i++) {
      const c = r.cells[i];
      if (!c) continue;
      const b = STATE_META[c.state].bucket;
      if (b === "sent") arr[i].sent++;
      else if (b === "not_sent") arr[i].notSent++;
      else arr[i][b]++;
    }
  }
  return arr;
}

// ── Rooftop counts (C4) ──────────────────────────────────────────────────────────────────────
/** One definition of "rooftop" everywhere: a distinct team. Department rows are departments. */
export function rooftopCounts(rows: { team_id?: string; rooftop_id: string; department?: string }[]): { rooftops: number; departments: number; sales: number; service: number } {
  const teams = new Set(rows.map((r) => r.team_id || r.rooftop_id));
  const depts = rows.filter((r) => r.department);
  return { rooftops: teams.size, departments: depts.length, sales: depts.filter((r) => r.department === "sales").length, service: depts.filter((r) => r.department === "service").length };
}

// ── Action board (C5) ────────────────────────────────────────────────────────────────────────
export type BoardKey = "missed" | "failed" | "delivery_unknown" | "data_not_ready" | "unknown" | "recipients_missing" | "unsubscribed" | "not_classified";
export const BOARD_GROUPS: { group: "failures" | "setup"; title: string; keys: BoardKey[] }[] = [
  { group: "failures", title: "Send failures", keys: ["missed", "failed", "delivery_unknown", "data_not_ready", "unknown"] },
  { group: "setup", title: "Setup gaps", keys: ["recipients_missing", "unsubscribed", "not_classified"] },
];
export const BOARD_LABEL: Record<BoardKey, string> = {
  missed: "Missed", failed: "Failed", delivery_unknown: "Delivery unknown", data_not_ready: "Data not ready", unknown: "Not sent (other)",
  recipients_missing: "No eligible recipients", unsubscribed: "Recipients opted out", not_classified: "Department not classified",
};
/** The board key a due cell files under, or null when it needs no action. Dry-run holds are a
 * deliberate state, so they are not on the board (they still count in "Not set up"). */
export function boardKey(cell: BuiltCell | undefined): BoardKey | null {
  if (!cell) return null;
  switch (cell.state) {
    case "missed": case "missed_send_day": return "missed";
    case "failed": return "failed";
    case "delivery_unknown": return "delivery_unknown";
    case "data_not_ready": return "data_not_ready";
    case "unknown": return "unknown";
    case "recipients_missing": return "recipients_missing";
    case "not_set_up": return /eligible/.test(cell.detail ?? "") ? "recipients_missing" : null;
    case "unsubscribed": return "unsubscribed";
    case "not_classified": return "not_classified";
    default: return null;
  }
}
export type BoardChip = { key: BoardKey; label: string; rooftops: number; departments: number; names: string[] };
/** Chips over the rows on screen, counted in distinct rooftops, split into failures vs setup. */
export function actionBoard(rows: (DueRow & { name: string })[], cadence: Cadence, anchor: string): { group: "failures" | "setup"; title: string; chips: BoardChip[] }[] {
  const by = new Map<BoardKey, { teams: Set<string>; depts: number; names: Set<string> }>();
  for (const r of rows) {
    const i = dueCellIndex(r.dueKey, cadence, anchor, r.cells.length || CADENCE_LEN[cadence]);
    const k = boardKey(i >= 0 ? r.cells[i] : undefined);
    if (!k) continue;
    const e = by.get(k) ?? { teams: new Set<string>(), depts: 0, names: new Set<string>() };
    e.teams.add(r.team_id || r.rooftop_id || r.name); e.depts++; e.names.add(r.name);
    by.set(k, e);
  }
  return BOARD_GROUPS.map((g) => ({
    group: g.group, title: g.title,
    chips: g.keys.filter((k) => by.has(k)).map((k) => {
      const e = by.get(k)!;
      return { key: k, label: BOARD_LABEL[k], rooftops: e.teams.size, departments: e.depts, names: [...e.names] };
    }),
  }));
}
/** Does this row's due cell sit under board chip `key`? (the chip's filter) */
export function rowMatchesBoard(r: DueRow, key: BoardKey, cadence: Cadence, anchor: string): boolean {
  const i = dueCellIndex(r.dueKey, cadence, anchor, r.cells.length || CADENCE_LEN[cadence]);
  return boardKey(i >= 0 ? r.cells[i] : undefined) === key;
}

// ── Transactional KPIs (C6) ──────────────────────────────────────────────────────────────────
export type TxStatusCounts = { sent: number; not_sent: number; error: number; suppressed: number; queued: number; opened: number };
export type TxKpi = { sent: number; notSent: number; held: number; inFlight: number; attempted: number; sentRatePct: number; opened: number; openRatePct: number };
/** Every number from roi_event_emails, one window, one grain (an email): sent ÷ (sent + not sent +
 * failed). Held (dry run) and in-flight rows are shown but kept out of the rate. The old strip
 * divided ledger emails by raw ClickHouse events and read 205% (A4 F12). */
export function txKpi(c: Partial<TxStatusCounts> | null | undefined): TxKpi {
  const n = (v?: number) => (Number.isFinite(v) ? Number(v) : 0);
  const sent = n(c?.sent), notSent = n(c?.not_sent) + n(c?.error), opened = Math.min(n(c?.opened), sent);
  const attempted = sent + notSent;
  return { sent, notSent, held: n(c?.suppressed), inFlight: n(c?.queued), attempted, sentRatePct: pct(sent, attempted), opened, openRatePct: pct(opened, sent) };
}

// ── The open pixel (C13) ─────────────────────────────────────────────────────────────────────
/** A stored email rendered inside the tracker must not fire its open-tracking pixel: every CSM view
 * counted as an open and ticked every recipient "Opened" (A4 F11). Drops <img> tags that point at a
 * track-open endpoint and blanks any other track-open URL. Apply to every srcDoc and new-tab render. */
export function neutralizeTracking(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<img\b[^>]*track-open[^>]*>/gi, "")
    .replace(/(["'(])\s*[^"'()\s]*track-open[^"'()\s]*\s*(["')])/gi, "$1about:blank$2");
}
