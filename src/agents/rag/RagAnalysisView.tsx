// "RAG Analysis" tab on /rag-analysis — red/amber/green health read across the
// same critical metrics already tracked in the Overall view (qualified rate,
// ABR, connect/transfer/callback rate), for the most recent Week or Month.
// Reuses `useOverallData()` verbatim (live ClickHouse → snapshot fallback) —
// no new API route, no new ClickHouse query. Pure presentation on top of data
// the app already fetches for the Overall tab.
import { useState, type CSSProperties } from "react";
import RagBadge from "../../vini/components/RagBadge";
import type { RagStatus } from "../../vini/lib/ragLogic";
import { AGENTS, AGENT_COLOR, useOverallData, type AgentCol, type Grain } from "../overall/overallData";
import { computeRagRows, rollupByAgent, type RagRow } from "./ragAnalysisData";

const ACCENT = "#4f46e5";
const BORDER = "#e5e7eb";
const GRAIN_LABEL: Record<Grain, string> = { week: "Week", month: "Month" };
const RAG_GRAINS: Grain[] = ["week", "month"];

function Seg<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{ display: "inline-flex", background: "#f3f4f6", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            style={{
              padding: "6px 13px", border: "none", borderRadius: 8, cursor: "pointer",
              fontSize: 13, fontWeight: 600, transition: "all .15s",
              background: active ? "#fff" : "transparent",
              color: active ? ACCENT : "#6b7280",
              boxShadow: active ? "0 1px 3px rgba(0,0,0,.12)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const cardStyle: CSSProperties = { background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16 };

function RollupStrip({ rollup }: { rollup: Partial<Record<AgentCol, RagStatus>> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${AGENTS.length}, 1fr)`, gap: 12, marginBottom: 18 }}>
      {AGENTS.map((agent) => (
        <div key={agent} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: AGENT_COLOR[agent] }}>{agent}</span>
          <RagBadge status={rollup[agent] ?? "N/A"} />
        </div>
      ))}
    </div>
  );
}

function RagGrid({ rows }: { rows: RagRow[] }) {
  if (!rows.length) {
    return <div style={{ ...cardStyle, color: "#6b7280", fontSize: 13 }}>No data for this period yet.</div>;
  }
  return (
    <div style={{ ...cardStyle, overflowX: "auto", padding: 0 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "10px 14px", borderBottom: `1px solid ${BORDER}`, color: "#6b7280", fontWeight: 600, whiteSpace: "nowrap" }}>Metric</th>
            {AGENTS.map((agent) => (
              <th key={agent} style={{ textAlign: "center", padding: "10px 14px", borderBottom: `1px solid ${BORDER}`, color: AGENT_COLOR[agent], fontWeight: 700, whiteSpace: "nowrap" }}>
                {agent}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric}>
              <td style={{ padding: "10px 14px", borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" }}>
                {row.metric}
                <span style={{ display: "block", fontSize: 10.5, color: "#9ca3af" }}>red line {(row.floor * 100).toFixed(1)}%</span>
              </td>
              {AGENTS.map((agent) => {
                const cell = row.cells[agent];
                return (
                  <td key={agent} style={{ padding: "10px 14px", borderBottom: `1px solid ${BORDER}`, textAlign: "center" }}>
                    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                      <RagBadge status={cell?.status ?? "N/A"} size="sm" />
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>{cell?.note ?? "—"}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RagAnalysisView() {
  const { bundle, meta, loading, error, live } = useOverallData();
  const [grain, setGrain] = useState<Grain>("week");

  const rows = bundle ? computeRagRows(bundle, grain) : [];
  const rollup = rollupByAgent(rows);
  const period = bundle?.[grain]?.periods?.[0];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            {loading ? "Loading…" : period ? `Latest ${GRAIN_LABEL[grain].toLowerCase()}: ${period}` : "No data"}
            {!loading && !live && " · offline snapshot"}
          </div>
        </div>
        <Seg options={RAG_GRAINS.map((g) => ({ key: g, label: GRAIN_LABEL[g] }))} value={grain} onChange={setGrain} />
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          Failed to load: {error}
        </div>
      )}

      <RollupStrip rollup={rollup} />
      <RagGrid rows={rows} />

      <div style={{ marginTop: 14, fontSize: 11.5, color: "#9ca3af", lineHeight: 1.6 }}>
        Each row's red line is the existing floor already used elsewhere in this app (Overall view's critical-metric thresholds). ABR rows use the same green/amber bands as the Rooftop-level ABR coloring; the other rows use a default RED &lt; floor, AMBER floor–2×floor, GREEN ≥2×floor band — flag if a different multiplier should replace that default.
      </div>
    </div>
  );
}

export default RagAnalysisView;
