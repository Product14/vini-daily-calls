// Data layer for the "RAG Analysis" tab on /rag-analysis — a red/amber/green
// health read on the same Overall bundle (`useOverallData`), zero new network
// surface. Every metric here already exists in `SECTIONS` with a `crit`+`numv`+
// `floor` (the red line); this just bands the ratio into RagStatus and rolls it
// up per agent. ABR-shaped metrics reuse the explicit per-agent `ABR_BANDS`
// (green/amber already spec'd) instead of the generic floor×2 heuristic below.
import { AGENTS, ABR_BANDS, SECTIONS, type AgentCol, type Bundle, type Grain, type MetricRow } from "../overall/overallData";
import type { RagStatus } from "../../vini/lib/ragLogic";

export type RagCell = { status: RagStatus; value: number | null; note: string };
export type RagRow = { metric: string; floor: number; cells: Partial<Record<AgentCol, RagCell>> };

const ABR_LABELS = new Set(["ABR %", "ABR (call) %", "ABR (SMS) %"]);

// Generic band for non-ABR floor metrics: below floor = RED, floor–2×floor =
// AMBER, ≥2×floor = GREEN. Not spec'd anywhere else in the app — a reasonable
// default given each metric already has a red line (`floor`) but no upper band.
// Flag to the team if a different multiplier reads better in practice.
function floorToStatus(ratio: number | null, floor: number): RagStatus {
  if (ratio == null) return "N/A";
  if (ratio < floor) return "RED";
  if (ratio < floor * 2) return "AMBER";
  return "GREEN";
}

function abrToStatus(ratio: number | null, agent: AgentCol): RagStatus {
  if (ratio == null) return "N/A";
  const band = ABR_BANDS[agent];
  if (ratio < band.amber) return "RED";
  if (ratio < band.green) return "AMBER";
  return "GREEN";
}

// RAG rows for the most recent period of `grain`. Returns [] if the bundle
// has no periods yet for that grain (still loading, or a fresh deploy).
export function computeRagRows(bundle: Bundle, grain: Grain): RagRow[] {
  const periods = bundle[grain]?.periods ?? [];
  const period = periods[0];
  if (!period) return [];
  const dataForPeriod = bundle[grain].data[period] ?? {};

  const rows: RagRow[] = [];
  for (const section of SECTIONS) {
    for (const metric of section.metrics) {
      if (!metric.crit || !metric.numv || metric.floor == null) continue;
      const cells: Partial<Record<AgentCol, RagCell>> = {};
      for (const agent of AGENTS) {
        const row: MetricRow | undefined = dataForPeriod[agent];
        const ratio = row ? metric.numv(row, agent) : null;
        const status = ABR_LABELS.has(metric.label) ? abrToStatus(ratio, agent) : floorToStatus(ratio, metric.floor);
        cells[agent] = {
          status,
          value: ratio,
          note: ratio == null ? "no data" : `${(ratio * 100).toFixed(1)}%`,
        };
      }
      rows.push({ metric: metric.label, floor: metric.floor, cells });
    }
  }
  return rows;
}

// Worst-of rollup per agent, for a one-glance header strip above the grid.
const RANK: Record<RagStatus, number> = { RED: 0, AMBER: 1, GREEN: 2, "N/A": 3 };
export function rollupByAgent(rows: RagRow[]): Partial<Record<AgentCol, RagStatus>> {
  const out: Partial<Record<AgentCol, RagStatus>> = {};
  for (const agent of AGENTS) {
    let worst: RagStatus = "N/A";
    for (const row of rows) {
      const c = row.cells[agent];
      if (!c || c.status === "N/A") continue;
      if (worst === "N/A" || RANK[c.status] < RANK[worst]) worst = c.status;
    }
    out[agent] = worst;
  }
  return out;
}
