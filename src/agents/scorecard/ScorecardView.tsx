// "Agent Scorecard" tab — Sales/Service × Inbound/Outbound metrics with a
// Week/Month toggle, click-to-drill-down rooftop lists, and an editable
// per-metric Target (saved to localStorage, browser-local only). Ported
// directly from the Claude-artifact scorecard prototype built this session —
// see scorecardData.ts for why this is a static snapshot, not a live query.
import { useState, type CSSProperties } from "react";
import {
  SCORECARD_DATA, PERIOD_LABEL, AGENTS_ORDER,
  type ScorecardPeriod, type ScorecardRow, type ScorecardCell,
} from "./scorecardData";

const BORDER = "#e5e7eb";
const HEADER_BG = "#2c4a7c";
const ACCENT = "#2c6e8f";
const LS_KEY = "vini-scorecard-targets";

function loadTargets(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}"); } catch { return {}; }
}
function saveTargets(t: Record<string, string>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

type DrawerState = { agent: string; row: ScorecardRow; column: "prev" | "cur" | "total" } | null;

function Seg({ options, value, onChange }: { options: { key: ScorecardPeriod; label: string }[]; value: ScorecardPeriod; onChange: (v: ScorecardPeriod) => void }) {
  return (
    <div style={{ display: "inline-flex", background: "#f3f4f6", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button key={o.key} onClick={() => onChange(o.key)}
            style={{
              padding: "6px 14px", border: "none", borderRadius: 8, cursor: "pointer",
              fontSize: 13, fontWeight: 600,
              background: active ? "#fff" : "transparent",
              color: active ? ACCENT : "#6b7280",
              boxShadow: active ? "0 1px 3px rgba(0,0,0,.12)" : "none",
            }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function cellButtonStyle(clickable: boolean): CSSProperties {
  return {
    background: "none", border: "none", cursor: clickable ? "pointer" : "default",
    font: "inherit", color: clickable ? ACCENT : "#9ca3af", padding: "2px 4px", borderRadius: 6,
    textAlign: "right", width: "100%",
  };
}

function Cell({ cell, onOpen }: { cell: ScorecardCell; onOpen: () => void }) {
  if (cell.value === null) return <span style={{ color: "#9ca3af" }}>—</span>;
  const hasList = Boolean(cell.list?.length) || cell.pool;
  return (
    <button onClick={hasList ? onOpen : undefined} style={cellButtonStyle(hasList)}>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{cell.value.toLocaleString()}</span>{" "}
      <span style={{ fontSize: 11, color: "#9ca3af" }}>{cell.unit}</span>
    </button>
  );
}

export function ScorecardView() {
  const [period, setPeriod] = useState<ScorecardPeriod>("week");
  const [targets, setTargets] = useState<Record<string, string>>(() => loadTargets());
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const payload = SCORECARD_DATA[period];
  const labels = PERIOD_LABEL[period];

  function setTarget(key: string, value: string) {
    const next = { ...targets, [key]: value };
    setTargets(next);
    saveTargets(next);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>{labels.sub}</div>
        <Seg options={[{ key: "week", label: "Week over Week" }, { key: "month", label: "Month over Month" }]} value={period} onChange={setPeriod} />
      </div>

      <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 2px rgba(15,23,42,.04)" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, minWidth: 780 }}>
            <thead>
              <tr>
                {["Agent", "Metrics", labels.prev, labels.cur, "Total Rooftops", "Target"].map((h, i) => (
                  <th key={h} style={{
                    background: HEADER_BG, color: "#eef3fb", textAlign: i >= 2 ? "right" : "left",
                    padding: "10px 14px", fontSize: 11.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AGENTS_ORDER.map((agent) => {
                const rows = payload.rows[agent] ?? [];
                return rows.map((row, i) => {
                  const targetKey = `${agent}|${row.metric}`;
                  return (
                    <tr key={row.metric} style={{ borderTop: i === 0 ? `2px solid ${BORDER}` : `1px solid ${BORDER}` }}>
                      {i === 0 && (
                        <td rowSpan={rows.length} style={{ background: "#f3f5f8", fontWeight: 700, padding: "10px 14px", verticalAlign: "top", whiteSpace: "nowrap", borderRight: `1px solid ${BORDER}` }}>
                          {agent}
                        </td>
                      )}
                      <td style={{ padding: "9px 14px" }}>{row.metric}</td>
                      <td style={{ padding: "9px 14px", textAlign: "right" }}>
                        <Cell cell={row.prev} onOpen={() => setDrawer({ agent, row, column: "prev" })} />
                      </td>
                      <td style={{ padding: "9px 14px", textAlign: "right" }}>
                        <Cell cell={row.cur} onOpen={() => setDrawer({ agent, row, column: "cur" })} />
                      </td>
                      <td style={{ padding: "9px 14px", textAlign: "right" }}>
                        <Cell cell={row.total} onOpen={() => setDrawer({ agent, row, column: "total" })} />
                      </td>
                      <td style={{ padding: "9px 14px", textAlign: "right" }}>
                        <input
                          value={targets[targetKey] ?? ""}
                          onChange={(e) => setTarget(targetKey, e.target.value)}
                          placeholder="—"
                          style={{ width: 64, textAlign: "right", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "4px 6px", fontSize: 13 }}
                        />
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 14, fontSize: 11.5, color: "#9ca3af", lineHeight: 1.6 }}>
        <strong>Reading the numbers.</strong> Most rows count distinct rooftops with a qualifying touch — click a cell to see a ✓ Counted / ✗ Not counted split against the full Total-Rooftop roster, so a bare number becomes an actionable list of who still needs a follow-up. Office-hrs Overflow (2nd+ simultaneous call) is a subset of Office-hrs All Calls. Total Rooftops is the contract-Live count for that exact product (Sales/Service × Inbound/Outbound), pulled from the master Live/Churned sheet at generation time — not just ClickHouse activity. Rooftops with unconfigured business hours are excluded from both After-hours and Office-hrs buckets (noted in each cell) rather than defaulting to After-hours. Campaigns/Rooftop counts distinct campaign use-cases, not campaign IDs; Appointments/Rooftop counts AI-booked (source=spyne) meetings only. Target is saved in this browser only.
      </div>

      {drawer && (
        <>
          <div onClick={() => setDrawer(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,26,38,.42)", zIndex: 20 }} />
          <div style={{
            position: "fixed", top: 0, right: 0, height: "100%", width: "min(380px,92vw)",
            background: "#fff", borderLeft: `1px solid ${BORDER}`, boxShadow: "-8px 0 24px rgba(0,0,0,.15)",
            zIndex: 21, display: "flex", flexDirection: "column",
          }}>
            <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${BORDER}`, position: "relative" }}>
              <button onClick={() => setDrawer(null)} style={{ position: "absolute", top: 14, right: 14, background: "#f3f5f8", border: "none", borderRadius: 7, width: 28, height: 28, cursor: "pointer" }}>✕</button>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: ACCENT }}>
                {drawer.agent} · {drawer.column === "prev" ? PERIOD_LABEL[period].prev : drawer.column === "cur" ? PERIOD_LABEL[period].cur : "Total Rooftops"}
              </div>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 19, fontWeight: 600, margin: "3px 0 6px" }}>{drawer.row.metric}</div>
              <div style={{ fontSize: 13, color: "#6b7280" }}>
                {drawer.row[drawer.column].value?.toLocaleString()} {drawer.row[drawer.column].unit} — {drawer.row[drawer.column].sub}
              </div>
            </div>
            <div style={{ overflowY: "auto", padding: "8px 0", flex: 1 }}>
              {drawer.column === "total" ? (
                payload.pools[drawer.agent].map((item) => (
                  <div key={item.team_id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 20px", borderBottom: `1px solid ${BORDER}`, fontSize: 13.5 }}>
                    <span>{item.rooftop}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "#6b7280" }}>{item.count.toLocaleString()}</span>
                  </div>
                ))
              ) : (() => {
                const matched = drawer.row[drawer.column].list ?? [];
                const matchedIds = new Set(matched.map((i) => i.team_id));
                const unmatched = (payload.pools[drawer.agent] ?? []).filter((p) => !matchedIds.has(p.team_id));
                return (
                  <>
                    <div style={{ padding: "10px 20px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#15803d" }}>
                      ✓ Counted ({matched.length})
                    </div>
                    {matched.map((item) => (
                      <div key={item.team_id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 20px", borderBottom: `1px solid ${BORDER}`, fontSize: 13.5 }}>
                        <span>{item.rooftop}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "#6b7280" }}>{item.count.toLocaleString()}</span>
                      </div>
                    ))}
                    <div style={{ padding: "14px 20px 4px", fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#b91c1c" }}>
                      ✗ Not counted ({unmatched.length})
                    </div>
                    {unmatched.map((item) => (
                      <div key={item.team_id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 20px", borderBottom: `1px solid ${BORDER}`, fontSize: 13.5, color: "#9ca3af" }}>
                        <span>{item.rooftop}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>0</span>
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ScorecardView;
