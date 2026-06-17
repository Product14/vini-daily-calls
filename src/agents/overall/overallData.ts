// Data layer for the "Overall" view on /agents — a native React port of the
// Vini-Product-Metrics dashboard (Period snapshot · Trend matrix · TV wall).
// The numbers come from Prod-ClickHouse via /api/metrics; when that endpoint is
// unavailable (no ClickHouse creds on this deploy) we fall back to the bundled
// snapshot at /agent-overall-snapshot.json. Metric definitions mirror Metabase
// question 12227 exactly — see the metrics repo README.
import { useCallback, useEffect, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const SNAPSHOT_URL = "/agent-overall-snapshot.json";

// ─── Types ──────────────────────────────────────────────────────────────────
export type Grain = "day" | "week" | "month";
export const GRAINS: Grain[] = ["day", "week", "month"];

// The four agent types plus the "Total" all-agent rollup column.
export type AgentCol =
  | "Sales Inbound" | "Sales Outbound" | "Service Inbound" | "Service Outbound" | "Total";
export const AGENTS: AgentCol[] = ["Sales Inbound", "Sales Outbound", "Service Inbound", "Service Outbound"];
export const COLS: AgentCol[] = [...AGENTS, "Total"];

// One ClickHouse aggregation row. All numeric fields arrive as JS numbers
// (uniqExact counts included). We read them through `num()` to be safe.
export type MetricRow = Record<string, number | string | null | undefined> & {
  period: string;
  agent_type: string;
};
export type GrainBundle = {
  periods: string[]; // ISO yyyy-mm-dd, newest first
  data: Record<string, Partial<Record<AgentCol, MetricRow>>>; // period -> agent -> row
  intent: Record<string, Partial<Record<AgentCol, [string, number][]>>>; // period -> agent -> [[intent, calls]]
};
export type Bundle = Record<Grain, GrainBundle>;
export type Meta = { generated: string; windows: Record<Grain, string>; source: string };

// Agent colours — shared with the Rooftop view (AgentsDashboard AGENT_COLORS)
// so the two tabs stay visually consistent. "Total" is the dark slate accent.
export const AGENT_COLOR: Record<AgentCol, string> = {
  "Sales Inbound": "#f59e0b",
  "Sales Outbound": "#6366f1",
  "Service Inbound": "#22c55e",
  "Service Outbound": "#0ea5e9",
  "Total": "#0f172a",
};

// How many periods each view shows (newest first). Mirrors the metrics repo.
export const TREND_LIMITS: Record<Grain, number> = { day: 30, week: 12, month: 5 };
export const TV_LIMITS: Record<Grain, number> = { day: 6, week: 6, month: 6 };

// ─── Formatters ───────────────────────────────────────────────────────────────
export const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const fmtInt = (v: unknown): string => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString();
};
export const fmtNum = (v: unknown, d = 0): string => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d });
};
export const fmtPct = (n: unknown, den: unknown): string => {
  const d = Number(den);
  if (!d) return "—";
  return ((100 * Number(n)) / d).toFixed(1) + "%";
};
export const safeDiv = (n: unknown, den: unknown): number | null => {
  const d = Number(den);
  if (!d) return null;
  return Number(n) / d;
};
// Compact dollars for the TV-wall header chips (e.g. $1.2M, $840K, $0).
export const fmtMoneyCompact = (n: unknown): string => {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};

// ─── Period labels ─────────────────────────────────────────────────────────────
// Parse "YYYY-MM-DD" as local midnight (T00:00) so the displayed day matches the
// viewer's calendar rather than shifting under UTC.
const asDate = (p: string) => new Date(p + "T00:00");
export function periodLabel(grain: Grain, p: string): string {
  const d = asDate(p);
  if (grain === "month") return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  if (grain === "week") return "Week of " + d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
export function colLabel(grain: Grain, p: string): string {
  const d = asDate(p);
  if (grain === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Last calendar day covered by a period (ISO yyyy-mm-dd). The period key is the
// period's START (day / Monday / 1st), so the end is +0 / +6 days / month-end.
// Used to count "agents live as of this column" against their go-live dates.
export function periodEnd(grain: Grain, p: string): string {
  const d = asDate(p);
  if (grain === "day") return p;
  if (grain === "week") { const e = new Date(d); e.setDate(d.getDate() + 6); return isoOf(e); }
  return isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)); // last day of the month
}

// ─── Metric definitions ────────────────────────────────────────────────────────
// `value(row)` -> display string. `crit` marks a critical product metric that
// gets highlighted and gets period-over-period swing alerting in the trend view;
// `numv(row)` is the numeric basis for that swing check and `floor` suppresses
// noise below a magnitude.
export type Metric = {
  label: string;
  value: (r: MetricRow) => string;
  pct?: boolean;          // render as a bold percentage cell
  crit?: boolean;
  numv?: (r: MetricRow) => number | null;
  floor?: number;
};
export type Section = { name: string; metrics: Metric[] };

export const SECTIONS: Section[] = [
  {
    name: "Rooftop counts",
    metrics: [
      { label: "Rooftops w/ any activity", value: (r) => fmtInt(r.rooftops_any) },
      { label: "Rooftops w/ any appointment", value: (r) => fmtInt(r.rooftops_appt) },
      { label: "Rooftops w/ call activity", value: (r) => fmtInt(r.rooftops_call) },
      { label: "Rooftops w/ SMS activity", value: (r) => fmtInt(r.rooftops_sms) },
    ],
  },
  {
    name: "Leads & product (overall)",
    metrics: [
      { label: "Unique leads touched", value: (r) => fmtInt(r.leads_touched) },
      { label: "Qualified leads (#)", value: (r) => fmtInt(r.leads_qualified) },
      { label: "% qualified leads", pct: true, value: (r) => fmtPct(r.leads_qualified, r.leads_touched), crit: true, numv: (r) => safeDiv(r.leads_qualified, r.leads_touched), floor: 0.03 },
      { label: "Appointments (#)", value: (r) => fmtInt(r.appts) },
      { label: "ABR % (appts / leads touched)", pct: true, value: (r) => fmtPct(r.appts, r.leads_touched), crit: true, numv: (r) => safeDiv(r.appts, r.leads_touched), floor: 0.02 },
    ],
  },
  {
    name: "Call — leads & product",
    metrics: [
      { label: "Unique leads touched (call)", value: (r) => fmtInt(r.leads_touched_call) },
      { label: "Qualified leads (call) (#)", value: (r) => fmtInt(r.leads_qualified_call) },
      { label: "% qualified leads (call)", pct: true, value: (r) => fmtPct(r.leads_qualified_call, r.leads_touched_call), crit: true, numv: (r) => safeDiv(r.leads_qualified_call, r.leads_touched_call), floor: 0.03 },
      { label: "Appointments (call) (#)", value: (r) => fmtInt(r.appts_call) },
      { label: "ABR (call) % (appts / leads touched)", pct: true, value: (r) => fmtPct(r.appts_call, r.leads_touched_call), crit: true, numv: (r) => safeDiv(r.appts_call, r.leads_touched_call), floor: 0.02 },
      { label: "Call connect rate", pct: true, value: (r) => fmtPct(r.connected_calls, r.total_calls), crit: true, numv: (r) => safeDiv(r.connected_calls, r.total_calls), floor: 0.05 },
      { label: "Transfer rate", pct: true, value: (r) => fmtPct(r.transfers, r.total_calls), crit: true, numv: (r) => safeDiv(r.transfers, r.total_calls), floor: 0.03 },
      { label: "Callback rate", pct: true, value: (r) => fmtPct(r.callbacks, r.total_calls), crit: true, numv: (r) => safeDiv(r.callbacks, r.total_calls), floor: 0.03 },
    ],
  },
  {
    name: "SMS — leads & product",
    metrics: [
      { label: "Unique leads touched (SMS)", value: (r) => fmtInt(r.leads_touched_sms) },
      { label: "Qualified leads (SMS) (#)", value: (r) => fmtInt(r.leads_qualified_sms) },
      { label: "% qualified leads (SMS)", pct: true, value: (r) => fmtPct(r.leads_qualified_sms, r.leads_touched_sms), crit: true, numv: (r) => safeDiv(r.leads_qualified_sms, r.leads_touched_sms), floor: 0.03 },
      { label: "Appointments (SMS) (#)", value: (r) => fmtInt(r.appts_sms) },
      { label: "ABR (SMS) % (appts / leads touched)", pct: true, value: (r) => fmtPct(r.appts_sms, r.leads_touched_sms), crit: true, numv: (r) => safeDiv(r.appts_sms, r.leads_touched_sms), floor: 0.02 },
    ],
  },
  {
    name: "Usage",
    metrics: [
      { label: "Total calls", value: (r) => fmtInt(r.total_calls) },
      { label: "Connected calls", value: (r) => fmtInt(r.connected_calls) },
      { label: "Total talk minutes", value: (r) => fmtNum(r.talk_minutes, 0) },
      { label: "Total SMS messages", value: (r) => fmtInt(r.sms_total) },
      { label: "SMS outbound", value: (r) => fmtInt(r.sms_outbound) },
      { label: "SMS inbound", value: (r) => fmtInt(r.sms_inbound) },
    ],
  },
];

// TV-wall metric set: a focused KPI %-group on top, then a raw-count group.
// `grp` starts the second (raw-count) group with a divider.
export type TvMetric = { label: string; value: (r: MetricRow) => string; pct?: boolean; grp?: boolean };
export const TV_METRICS: TvMetric[] = [
  { label: "% Rooftops w/ appt", pct: true, value: (r) => fmtPct(r.rooftops_appt, r.rooftops_any) },
  { label: "ABR %", pct: true, value: (r) => fmtPct(r.appts, r.leads_touched) },
  { label: "Transfer %", pct: true, value: (r) => fmtPct(r.transfers, r.total_calls) },
  { label: "Call connection %", pct: true, value: (r) => fmtPct(r.connected_calls, r.total_calls) },
  { label: "SMS reply %", pct: true, value: (r) => fmtPct(r.sms_inbound, r.sms_outbound) },
  { label: "Rooftops w/ activity", grp: true, value: (r) => fmtInt(r.rooftops_any) },
  { label: "Rooftops w/ appointment", value: (r) => fmtInt(r.rooftops_appt) },
  { label: "Unique leads touched", value: (r) => fmtInt(r.leads_touched) },
  { label: "Qualified calls", value: (r) => fmtInt(r.leads_qualified_call) },
  { label: "Appointments", value: (r) => fmtInt(r.appts) },
  { label: "Total calls", value: (r) => fmtInt(r.total_calls) },
  { label: "Total SMS outbound", value: (r) => fmtInt(r.sms_outbound) },
];

// ─── Swing detection (trend view) ───────────────────────────────────────────────
// Period-over-period relative move vs the previous (older) period. Amber ≥20%,
// red ≥40%. `floor` ignores swings whose magnitude is below the noise threshold.
const SWING_AMBER = 0.2, SWING_RED = 0.4;
export type Swing = { level: "amber" | "red"; dir: "▲" | "▼"; pct: string };
export function swing(v: number | null, pv: number | null, floor = 0): Swing | null {
  if (v == null || pv == null || pv === 0) return null;
  if (Math.max(Math.abs(v), Math.abs(pv)) < floor) return null;
  const rel = Math.abs(v - pv) / Math.abs(pv);
  if (!isFinite(rel) || rel < SWING_AMBER) return null;
  return {
    level: rel >= SWING_RED ? "red" : "amber",
    dir: v < pv ? "▼" : "▲",
    pct: (v < pv ? "-" : "+") + (rel * 100).toFixed(0) + "%",
  };
}

// ─── Data hook ───────────────────────────────────────────────────────────────
// Tries the live ClickHouse endpoint first, then the bundled snapshot. `live`
// reflects which source won so the UI can label it. refresh() re-runs the live
// query (≈30s) when available, otherwise just re-reads the snapshot.
export type OverallData = {
  bundle: Bundle | null;
  meta: Meta | null;
  loading: boolean;
  error: string | null;
  live: boolean;
  refresh: () => void;
};

export function useOverallData(): OverallData {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // 1) live ClickHouse
    try {
      const r = await fetch(`${API_BASE}/api/metrics`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.bundle) {
          setBundle(j.bundle);
          setMeta(j.meta ?? null);
          setLive(true);
          setLoading(false);
          return;
        }
      }
    } catch {
      /* fall through to snapshot */
    }
    // 2) bundled snapshot
    try {
      const r = await fetch(SNAPSHOT_URL, { cache: "no-cache" });
      if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
      const j = await r.json();
      setBundle(j.bundle);
      setMeta(j.meta ?? null);
      setLive(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { bundle, meta, loading, error, live, refresh: load };
}

// ─── Per-agent ARR + go-live roster (Vini funnel master sheet) ──────────────────
// The ClickHouse bundle has no revenue or roster, so ARR and the agent count come
// from the funnel master sheet (Google Sheet 15BScf… via /api/accounts-sheet —
// the same source the Rooftop view uses). Restricted to LIVE deployments per
// "Agent Opted" type (churned accounts have $0 recurring revenue):
//   arr          = Σ(monthly MRR) × 12 over the live deployments
//   goLiveDates  = each live deployment's go-live date (ISO yyyy-mm-dd), so the
//                  TV wall can show the agent count *as of each period* rather
//                  than one static number. Live agents with no recorded date get
//                  a far-past sentinel so they count toward every period.
// Flip LIVE_ONLY to false to count the full book (all stages). Degrades to {}.
const LIVE_ONLY = true;
const NO_DATE_SENTINEL = "0000-01-01"; // sorts before any real ISO date
export type AgentSummary = { arr: number; goLiveDates: string[] };
export type AgentSummaryMap = Partial<Record<AgentCol, AgentSummary>>;

// Number of agents live on/before `endIso` (ISO compares lexicographically).
export function agentsLiveAsOf(s: AgentSummary | undefined, endIso: string): number | null {
  if (!s) return null;
  return s.goLiveDates.reduce((n, d) => (d <= endIso ? n + 1 : n), 0);
}

export function useAgentSheetSummary(): AgentSummaryMap {
  const [summary, setSummary] = useState<AgentSummaryMap>({});
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/accounts-sheet`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j || !Array.isArray(j.rows)) return;
        const out: AgentSummaryMap = {};
        for (const row of j.rows) {
          const agent = String(row.agentType ?? "").trim() as AgentCol;
          if (!AGENTS.includes(agent)) continue;
          if (LIVE_ONLY && String(row.currentStage ?? "").trim().toLowerCase() !== "live") continue;
          const mrr = Number(row.agentMrr) || 0;
          const goLive = typeof row.goLiveDate === "string" && row.goLiveDate ? row.goLiveDate : NO_DATE_SENTINEL;
          const cur = out[agent] ?? (out[agent] = { arr: 0, goLiveDates: [] });
          cur.arr += mrr * 12;
          cur.goLiveDates.push(goLive);
        }
        if (!cancelled) setSummary(out);
      })
      .catch(() => { /* sheet unconfigured / unreachable — chips fall back */ });
    return () => { cancelled = true; };
  }, []);
  return summary;
}
