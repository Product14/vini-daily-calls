// Data layer for the "Agent Scorecard" tab — a static snapshot (same pattern as
// the existing Scorecards button's public/fleet-scorecards.html) rather than a
// live query: these numbers come from a one-off ClickHouse pass (canonical
// spine + registry-based Live rooftop filter + STL/office-hours/overflow/
// campaign-use-case logic authored this session), not from this app's existing
// /api/agents or /api/metrics pipeline. Refreshing them means re-running that
// pass and swapping data/week.json + data/month.json — no code change needed.
import weekJson from "./data/week.json";
import monthJson from "./data/month.json";

export type ScorecardCell = {
  value: number | null;
  unit: string;
  sub: string;
  list?: { rooftop: string; count: number }[];
  pool?: boolean;
};
export type ScorecardRow = { metric: string; prev: ScorecardCell; cur: ScorecardCell; total: ScorecardCell };
export type ScorecardPayload = {
  rows: Record<string, ScorecardRow[]>;
  pools: Record<string, { rooftop: string; count: number }[]>;
};

export type ScorecardPeriod = "week" | "month";

export const SCORECARD_DATA: Record<ScorecardPeriod, ScorecardPayload> = {
  week: weekJson as ScorecardPayload,
  month: monthJson as ScorecardPayload,
};

export const PERIOD_LABEL: Record<ScorecardPeriod, { title: string; prev: string; cur: string; sub: string }> = {
  week: { title: "Week over Week", prev: "Previous (Jun 29–Jul 5)", cur: "Current (Jul 6–12)", sub: "Weekly windows, Mon–Sun" },
  month: { title: "Month over Month", prev: "Previous (June)", cur: "Current (July, MTD)", sub: "Calendar months; July is month-to-date" },
};

export const AGENTS_ORDER = ["Sales IB", "Sales OB", "Service IB", "Service OB"];
