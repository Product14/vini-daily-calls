import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  AGENTS, COLS, AGENT_COLOR, GRAINS, TREND_LIMITS, TV_LIMITS, SECTIONS, TV_METRICS,
  periodLabel, colLabel, periodEnd, swing, fmtInt, fmtPct, fmtMoneyCompact, abrColor,
  agentsLiveAsOf, useOverallData, useAgentSheetSummary,
  type Grain, type AgentCol, type GrainBundle, type MetricRow, type AgentSummaryMap,
} from "./overallData";

// Conditional formatting for the at-a-glance views (snapshot + TV wall):
//   • heat  → ABR cells get a red/amber/green band (abrColor, per agent type) + white bold text
//   • emph  → appointment-count cells get a solid highlight + white bold text
// Both also enlarge the row (ov-big) so they read from across the room.
const EMPH_BG = "#1d4ed8";
type FmtMeta = { heat?: (r: MetricRow, agent: AgentCol) => number | null; emph?: boolean };
function fmtCellStyle(m: FmtMeta, r: MetricRow | undefined, agent: AgentCol): CSSProperties | undefined {
  if (m.heat && r) {
    const c = abrColor(m.heat(r, agent), agent);
    if (c) return { background: c.bg, color: c.fg, fontWeight: 800 };
  }
  if (m.emph) return { background: EMPH_BG, color: "#fff", fontWeight: 800 };
  return undefined;
}
const isBig = (m: FmtMeta) => Boolean(m.heat || m.emph);

// "Overall" view on /agents — company-wide, agent-type-level performance, ported
// natively from the Vini-Product-Metrics dashboard. Three sub-views:
//   • Period snapshot — one period; metrics as rows, the 4 agents + Total as cols.
//   • Trend matrix    — metric-per-row × period-per-column, one agent at a time,
//                       with period-over-period swing alerts on critical metrics.
//   • TV wall         — 2×2 agent grid of a focused KPI set over the last 6 periods,
//                       with per-agent ARR + rooftop chips. On the TV wall the view
//                       auto-goes immersive (full-viewport, chrome hidden) after 10s
//                       idle and auto-rotates Day → Week → Month every 60s.

const ACCENT = "#4f46e5";
const BORDER = "#e5e7eb";
const GRAIN_LABEL: Record<Grain, string> = { day: "Day", week: "Week", month: "Month" };

type ViewKind = "snapshot" | "trend" | "tv";
const VIEWS: { key: ViewKind; label: string }[] = [
  { key: "snapshot", label: "Period snapshot" },
  { key: "trend", label: "Trend matrix" },
  { key: "tv", label: "📺 TV wall" },
];

const IMMERSIVE_IDLE_MS = 10_000; // go full-screen after 10s of no interaction
const ROTATE_MS = 60_000;         // cycle Day → Week → Month every minute

// ── Segmented control ─────────────────────────────────────────────────────────
function Seg<T extends string>({ options, value, onChange, big }: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  big?: boolean;
}) {
  return (
    <div style={{ display: "inline-flex", background: "#f3f4f6", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            style={{
              padding: big ? "8px 16px" : "6px 13px", border: "none", borderRadius: 8, cursor: "pointer",
              fontSize: big ? 13.5 : 13, fontWeight: 600, transition: "all .15s",
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

const Dot = ({ c }: { c: string }) => (
  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: c, marginRight: 6, verticalAlign: "middle" }} />
);

const lbl: CSSProperties = { textTransform: "uppercase", letterSpacing: ".06em", fontSize: 10, fontWeight: 700, color: "#9ca3af", marginRight: 8 };
const group: CSSProperties = { display: "flex", alignItems: "center" };

export function OverallView() {
  const { bundle, meta, loading, error, live, refresh, reload } = useOverallData();
  const sheetSummary = useAgentSheetSummary();
  const [view, setView] = useState<ViewKind>("snapshot");
  const [grain, setGrain] = useState<Grain>("week");
  const [period, setPeriod] = useState<string | null>(null);
  const [trendAgent, setTrendAgent] = useState<AgentCol>("Sales Inbound");
  const [intentAgent, setIntentAgent] = useState<AgentCol>("Total");
  // Immersive (full-viewport, chrome hidden) has two independent sources:
  //   • idleImmersive — auto, after 10s with no interaction on the TV wall
  //   • isFs          — the browser Fullscreen API (the ⛶ button / Esc)
  // Either one is immersive; keeping them separate is what stops the manual
  // fullscreen button from cancelling the auto-fullscreen (and vice-versa).
  const [idleImmersive, setIdleImmersive] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const immersive = idleImmersive || isFs;
  const rootRef = useRef<HTMLDivElement>(null);

  // Auto-sync every 20 min so an always-on screen never goes stale. Visible-tab
  // only and silent (keeps the current data on screen until the fresh read
  // lands). Uses reload() — re-reads the cron-precomputed cache rather than
  // forcing a live ~50s ClickHouse scan on every interval tick. A ref keeps the
  // interval (set up once) calling the latest closure.
  const refreshRef = useRef(reload);
  refreshRef.current = reload;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, 20 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-rotate the granularity while the TV wall is open (set up once per entry).
  useEffect(() => {
    if (view !== "tv") return;
    const t = setInterval(() => {
      setGrain((g) => GRAINS[(GRAINS.indexOf(g) + 1) % GRAINS.length]);
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [view]);

  // Auto-immersive after IMMERSIVE_IDLE_MS idle on the TV wall. Pointer/key
  // activity exits and re-arms it — EXCEPT activity on the fullscreen button
  // (data-ov-fs), so clicking ⛶ never kicks us out of the auto-fullscreen.
  useEffect(() => {
    if (view !== "tv") { setIdleImmersive(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => setIdleImmersive(true), IMMERSIVE_IDLE_MS); };
    const onActivity = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest && t.closest("[data-ov-fs]")) return; // ignore the fullscreen button
      setIdleImmersive(false);
      schedule();
    };
    schedule();
    const evs: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"];
    evs.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, onActivity)); };
  }, [view]);

  // Track the browser Fullscreen API so isFs reflects ⛶ / Esc.
  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Fit the TV tables to whatever screen they're on: measure the real table
  // height and shrink the font until it fits with NO scroll, then grow to fill.
  // Measurement-based (not a formula), so it's correct on any aspect ratio /
  // resolution and accounts for the taller ABR/appointment rows automatically.
  // Re-runs when immersive turns on, on grain rotation, on data refresh, on
  // resize, and again ~300ms later to catch the fullscreen layout settling.
  useEffect(() => {
    if (!immersive) return;
    const fitOne = (wrap: HTMLElement, tbl: HTMLElement) => {
      const avail = wrap.clientHeight;
      if (!avail) return;
      let fs = 16, guard = 80;
      tbl.style.fontSize = fs + "px";
      while (tbl.offsetHeight > avail && fs > 8 && guard-- > 0) { fs -= 1; tbl.style.fontSize = fs + "px"; }      // shrink to fit
      while (tbl.offsetHeight < avail - 2 && fs < 34 && guard-- > 0) {                                            // grow to fill
        fs += 1; tbl.style.fontSize = fs + "px";
        if (tbl.offsetHeight > avail) { fs -= 1; tbl.style.fontSize = fs + "px"; break; }
      }
    };
    const fit = () => {
      document.querySelectorAll<HTMLElement>(".ov-immersive .ov-tvblock").forEach((block) => {
        const wrap = block.querySelector<HTMLElement>(".ov-tvwrap");
        const tbl = block.querySelector<HTMLElement>(".ov-tvtable");
        if (wrap && tbl) fitOne(wrap, tbl);
      });
    };
    const raf = requestAnimationFrame(fit);
    const settle = setTimeout(fit, 300);
    window.addEventListener("resize", fit);
    return () => { cancelAnimationFrame(raf); clearTimeout(settle); window.removeEventListener("resize", fit); };
  }, [immersive, grain, bundle]);

  // Manual browser fullscreen (needs the click as a user gesture). Esc / the
  // fullscreenchange listener clears isFs. This is independent of idleImmersive.
  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => { /* not permitted — immersive CSS still covers the screen */ });
  };

  const gb: GrainBundle | undefined = bundle?.[grain];
  const periods = gb?.periods ?? [];
  const selectedPeriod = period && gb?.data[period] ? period : periods[0];
  const win = view === "snapshot"
    ? `${GRAIN_LABEL[grain]} = ${meta?.windows?.[grain] ?? ""}`
    : `last ${(view === "tv" ? TV_LIMITS : TREND_LIMITS)[grain]} ${grain}s`;

  if (loading && !bundle) {
    return <div style={{ padding: 40, textAlign: "center", color: "#6b7280", fontSize: 14 }}>Loading agent metrics…</div>;
  }
  if (error && !bundle) {
    return (
      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "12px 16px", borderRadius: 8, fontSize: 13 }}>
        Couldn’t load overall metrics: {error}
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <style>{`
        .ov-table{border-collapse:collapse;background:#fff;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;width:100%;font-variant-numeric:tabular-nums;box-shadow:0 1px 3px rgba(0,0,0,.04)}
        .ov-table caption{caption-side:top;text-align:left;font-weight:700;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;padding:13px 14px 9px}
        .ov-table th,.ov-table td{padding:9px 13px;text-align:right;border-bottom:1px solid ${BORDER};white-space:nowrap;font-size:13px}
        .ov-table th:first-child,.ov-table td:first-child{text-align:left}
        .ov-table thead th{background:#f9fafb;color:#6b7280;font-weight:700;font-size:12px;border-bottom:2px solid ${BORDER}}
        .ov-table tbody tr:last-child td{border-bottom:0}
        .ov-table td.metric{color:#6b7280}
        .ov-table td.tot{background:#f8fafc;font-weight:700}
        .ov-table tbody tr:hover td{background:#f5f3ff}
        .ov-sec td{background:#f3f4f6;color:#6b7280;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.05em;border-left:3px solid ${ACCENT}}
        .ov-crit td.metric{font-weight:700;color:#111827;border-left:3px solid ${ACCENT}}
        .ov-crit td{background:#f5f3ff}
        .ov-badge{font-size:9px;color:${ACCENT};border:1px solid ${ACCENT};border-radius:4px;padding:1px 5px;margin-left:8px;vertical-align:middle;text-transform:uppercase;letter-spacing:.04em;opacity:.85}
        .ov-pct{font-weight:700}
        /* conditional-formatting rows (ABR heatmap + appointment highlight): bigger for 10m reads */
        .ov-table tr.ov-big td{font-size:15px}
        .ov-tvtable tr.ov-big td{font-size:1.3em;line-height:1.3}
        /* trend matrix */
        .ov-scroll{overflow:auto;border:1px solid ${BORDER};border-radius:10px;max-height:70vh}
        .ov-matrix{border:0;border-radius:0}
        .ov-matrix th.stick,.ov-matrix td.stick{position:sticky;left:0;z-index:2;background:#fff;text-align:left;min-width:240px;border-right:1px solid ${BORDER}}
        .ov-matrix thead th{position:sticky;top:0;z-index:1;min-width:74px}
        .ov-matrix thead th.stick{z-index:3}
        .ov-matrix thead th.latest,.ov-matrix td.latest{background:#eef2ff;color:${ACCENT}}
        .ov-matrix td.latest{font-weight:700}
        .ov-sec td.stick{background:#f3f4f6}
        .ov-flux-amber{color:#b45309;font-weight:700;background:#fffbeb}
        .ov-flux-red{color:#dc2626;font-weight:700;background:#fef2f2}
        .ov-arrow{font-size:9px;margin-left:3px;opacity:.9}
        /* TV wall */
        .ov-tvgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        .ov-tvblock{border:1px solid ${BORDER};border-radius:12px;overflow:hidden;background:#fff;display:flex;flex-direction:column;min-height:0;box-shadow:0 1px 3px rgba(0,0,0,.05)}
        .ov-tvhead{display:flex;align-items:center;gap:10px;padding:8px 13px;font-weight:700;font-size:14px;border-bottom:2px solid ${BORDER};flex:0 0 auto}
        .ov-tvhead .sub{margin-left:auto;color:#9ca3af;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
        .ov-chip{display:inline-flex;align-items:baseline;gap:4px;background:#f5f3ff;border:1px solid #e0e7ff;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700;color:#4338ca}
        .ov-chip b{font-size:12px}
        .ov-chip.arr{background:#ecfdf5;border-color:#d1fae5;color:#047857}
        .ov-tvwrap{flex:1 1 auto;overflow:auto;min-height:0}
        .ov-tvtable{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12px}
        .ov-tvtable th,.ov-tvtable td{padding:3px 10px;text-align:right;border-bottom:1px solid #f1f3f5;white-space:nowrap}
        .ov-tvtable td.m,.ov-tvtable th.m{text-align:left;font-weight:600}
        .ov-tvtable thead th{background:#f9fafb;color:#6b7280;font-weight:700;border-bottom:2px solid ${BORDER};position:sticky;top:0}
        .ov-tvtable td.latest,.ov-tvtable th.latest{background:#eef2ff;font-weight:700}
        .ov-tvtable tr.pct td{background:#f5f3ff;font-weight:700}
        .ov-tvtable tr.pct td.latest{background:#e0e7ff}
        .ov-tvtable tr.grp td{border-top:2px solid ${BORDER}}
        .ov-tvtable tr.agentrow td{font-weight:800;background:#fafaff}
        .ov-tvtable tr.agentrow td.m{color:#111827}
        .ov-tvtable tr.agentrow td.latest{background:#eef2ff}
        .ov-bar{height:14px;border-radius:3px;display:inline-block;vertical-align:middle;min-width:2px}
        /* immersive (auto full-screen) TV wall */
        .ov-immersive{position:fixed;inset:0;z-index:9999;background:#f6f7f9;display:flex;flex-direction:column;padding:16px 20px;gap:12px}
        .ov-immersive .ov-itop{display:flex;align-items:center;gap:12px;font-weight:800;font-size:20px;color:#111827}
        .ov-immersive .ov-itop .sub{margin-left:auto;color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
        .ov-immersive .ov-tvgrid{flex:1 1 auto;grid-template-rows:1fr 1fr;min-height:0}
        .ov-immersive .ov-tvhead{font-size:16px;padding:8px 15px;flex:0 0 auto}
        .ov-immersive .ov-tvwrap{overflow:hidden}          /* no scroll — the fit routine measures & scales */
        .ov-immersive .ov-tvtable{font-size:14px}          /* base; the fit routine overrides per screen */
        .ov-immersive .ov-tvtable th,.ov-immersive .ov-tvtable td{padding:2px 12px;line-height:1.15}
      `}</style>

      {!immersive && (
        <div style={{
          display: "flex", gap: 0, alignItems: "center", flexWrap: "wrap",
          background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 14,
          padding: "11px 16px", marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,.05)",
        }}>
          <div style={{ ...group, paddingRight: 18 }}>
            <span style={lbl}>View</span><Seg options={VIEWS} value={view} onChange={setView} big />
          </div>
          <div style={{ ...group, paddingLeft: 18, borderLeft: `1px solid ${BORDER}`, paddingRight: 18 }}>
            <span style={lbl}>Granularity</span>
            <Seg options={GRAINS.map((g) => ({ key: g, label: GRAIN_LABEL[g] }))} value={grain} onChange={setGrain} />
          </div>
          {view === "snapshot" && (
            <>
              <div style={{ ...group, paddingLeft: 18, borderLeft: `1px solid ${BORDER}`, paddingRight: 18 }}>
                <span style={lbl}>Period</span>
                <select value={selectedPeriod} onChange={(e) => setPeriod(e.target.value)}
                  style={{ padding: "7px 10px", borderRadius: 9, border: `1px solid ${BORDER}`, fontSize: 13, background: "#fff" }}>
                  {periods.map((p) => <option key={p} value={p}>{periodLabel(grain, p)}</option>)}
                </select>
              </div>
              <div style={{ ...group, paddingLeft: 18, borderLeft: `1px solid ${BORDER}` }}>
                <span style={lbl}>Intent for</span>
                <select value={intentAgent} onChange={(e) => setIntentAgent(e.target.value as AgentCol)}
                  style={{ padding: "7px 10px", borderRadius: 9, border: `1px solid ${BORDER}`, fontSize: 13, background: "#fff" }}>
                  {COLS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
            </>
          )}
          {view === "tv" && (
            <div style={{ ...group, paddingLeft: 18, borderLeft: `1px solid ${BORDER}`, gap: 10 }}>
              <button data-ov-fs onClick={toggleFullscreen}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 9, border: `1px solid ${ACCENT}`, background: ACCENT, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                ⛶ Fullscreen
              </button>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>Auto-fullscreen after 10s · rotates every 1m</span>
            </div>
          )}
          {selectedPeriod === periods[0] && view === "snapshot" && (
            <span style={{ marginLeft: 14, background: "#fffbeb", color: "#b45309", padding: "4px 11px", borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
              ⚠ latest {grain} is in progress (partial)
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, paddingLeft: 18 }}>
            <span style={{ fontSize: 11.5, color: "#9ca3af" }}>
              {meta?.generated ? `as of ${meta.generated} · ` : ""}{win}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, ...(live
              ? { background: "#dcfce7", color: "#166534" }
              : { background: "#f1f5f9", color: "#64748b" }) }}
              title={live ? "Live from ClickHouse" : "Bundled snapshot — set CLICKHOUSE_* env vars for live data"}>
              {live ? "● live" : "snapshot"}
            </span>
            <button onClick={refresh} disabled={loading}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: `1px solid ${BORDER}`, background: loading ? "#f3f4f6" : "#fff", fontSize: 12, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", color: loading ? "#9ca3af" : "#374151" }}>
              ↻ {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      )}

      {!gb || !selectedPeriod ? (
        <div style={{ padding: 30, color: "#6b7280", fontSize: 14 }}>No data for this granularity.</div>
      ) : view === "snapshot" ? (
        <SnapshotView gb={gb} grain={grain} period={selectedPeriod} intentAgent={intentAgent} />
      ) : view === "trend" ? (
        <TrendView gb={gb} grain={grain} agent={trendAgent} onAgent={setTrendAgent} />
      ) : (
        <TvView gb={gb} grain={grain} generated={meta?.generated ?? ""} summary={sheetSummary} immersive={immersive} />
      )}
    </div>
  );
}

// ── Period snapshot ────────────────────────────────────────────────────────────
function SnapshotView({ gb, grain, period, intentAgent }: { gb: GrainBundle; grain: Grain; period: string; intentAgent: AgentCol }) {
  const pd = gb.data[period] ?? {};
  const intent = (gb.intent[period]?.[intentAgent] ?? []) as [string, number][];
  const intentTotal = intent.reduce((s, [, c]) => s + c, 0);
  const intentMax = intent.length ? intent[0][1] : 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <table className="ov-table">
        <caption>Metrics — {periodLabel(grain, period)}</caption>
        <thead>
          <tr>
            <th>Metric</th>
            {COLS.map((c) => <th key={c}><Dot c={AGENT_COLOR[c]} />{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {SECTIONS.map((sec) => <SnapshotSection key={sec.name} sec={sec} pd={pd} />)}
        </tbody>
      </table>

      <table className="ov-table">
        <caption>Intent — call distribution · {intentAgent} · {periodLabel(grain, period)}</caption>
        <thead><tr><th>Primary intent</th><th>Calls</th><th style={{ width: "45%" }}>Share</th></tr></thead>
        <tbody>
          {intent.length === 0 ? (
            <tr><td className="metric" colSpan={3}>No classified call intents in this period.</td></tr>
          ) : intent.slice(0, 20).map(([name, calls]) => (
            <tr key={name}>
              <td className="metric">{name}</td>
              <td>{fmtInt(calls)}</td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-start" }}>
                  <span className="ov-bar" style={{ width: `${Math.max(2, (100 * calls) / intentMax)}%`, background: AGENT_COLOR[intentAgent] }} />
                  <span style={{ color: "#6b7280", fontSize: 12 }}>{fmtPct(calls, intentTotal)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SnapshotSection({ sec, pd }: { sec: typeof SECTIONS[number]; pd: Partial<Record<AgentCol, MetricRow>> }) {
  return (
    <>
      <tr className="ov-sec"><td colSpan={COLS.length + 1}>{sec.name}</td></tr>
      {sec.metrics.map((m) => (
        <tr key={m.label} className={[m.crit ? "ov-crit" : "", isBig(m) ? "ov-big" : ""].filter(Boolean).join(" ") || undefined}>
          <td className="metric">{m.label}{m.crit && <span className="ov-badge">critical</span>}</td>
          {COLS.map((c) => {
            const r = pd[c];
            return (
              <td key={c} className={c === "Total" ? "tot" : undefined} style={fmtCellStyle(m, r, c)}>
                <span className={m.pct ? "ov-pct" : undefined}>{r ? m.value(r, c) : "—"}</span>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

// ── Trend matrix ─────────────────────────────────────────────────────────────
function TrendView({ gb, grain, agent, onAgent }: { gb: GrainBundle; grain: Grain; agent: AgentCol; onAgent: (a: AgentCol) => void }) {
  const periods = gb.periods.slice(0, TREND_LIMITS[grain]);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {COLS.map((a) => {
          const active = a === agent;
          return (
            <button key={a} onClick={() => onAgent(a)}
              style={{
                display: "inline-flex", alignItems: "center", borderRadius: 20, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
                border: `1px solid ${active ? AGENT_COLOR[a] : BORDER}`,
                background: active ? AGENT_COLOR[a] : "#fff",
                color: active ? "#fff" : "#374151",
              }}>
              <Dot c={active ? "#fff" : AGENT_COLOR[a]} />{a}
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
        Each metric is a row, each {grain} a column (most recent on the left). Showing <b>{agent}</b> · last {periods.length} {grain}{periods.length > 1 ? "s" : ""}.
        <span style={{ marginLeft: 14, color: "#b45309", fontWeight: 600 }}>▲/▼ ≥20% swing</span>
        <span style={{ marginLeft: 10, color: "#dc2626", fontWeight: 600 }}>≥40% needs attention</span>
        <span style={{ marginLeft: 10 }}>vs the column to its right</span>
      </div>

      <div className="ov-scroll">
        <table className="ov-table ov-matrix">
          <thead>
            <tr>
              <th className="stick">Metric</th>
              {periods.map((p, i) => <th key={p} className={i === 0 ? "latest" : undefined}>{colLabel(grain, p)}</th>)}
            </tr>
          </thead>
          <tbody>
            {SECTIONS.map((sec) => (
              <Fragment key={sec.name}>
                <tr className="ov-sec"><td className="stick">{sec.name}</td>{periods.map((p) => <td key={p} />)}</tr>
                {sec.metrics.map((m) => {
                  const vals = periods.map((p) => {
                    const r = gb.data[p]?.[agent];
                    return m.crit && m.numv && r ? m.numv(r, agent) : null;
                  });
                  return (
                    <tr key={m.label} className={m.crit ? "ov-crit" : undefined}>
                      <td className="stick metric">{m.labelFor?.(agent) ?? m.label}{m.crit && <span className="ov-badge">critical</span>}</td>
                      {periods.map((p, i) => {
                        const r = gb.data[p]?.[agent];
                        const sw = m.crit ? swing(vals[i], vals[i + 1] ?? null, m.floor ?? 0) : null;
                        const cls = [i === 0 ? "latest" : "", sw ? (sw.level === "red" ? "ov-flux-red" : "ov-flux-amber") : ""].filter(Boolean).join(" ");
                        return (
                          <td key={p} className={cls || undefined} title={sw ? `${sw.pct} vs prior ${grain}` : undefined}>
                            <span className={m.pct ? "ov-pct" : undefined}>{r ? m.value(r, agent) : "—"}</span>
                            {sw && <span className="ov-arrow">{sw.dir}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── TV wall ──────────────────────────────────────────────────────────────────
function TvView({ gb, grain, generated, summary, immersive }: {
  gb: GrainBundle; grain: Grain; generated: string; summary: AgentSummaryMap; immersive: boolean;
}) {
  const periods = gb.periods.slice(0, TV_LIMITS[grain]); // newest first

  const grid = (
    <div className="ov-tvgrid">
      {AGENTS.map((agent) => {
        const s = summary[agent];
        const isOutbound = agent === "Sales Outbound" || agent === "Service Outbound";
        // Transfer is an inbound-only outcome — drop that KPI on outbound quadrants.
        const metrics = isOutbound ? TV_METRICS.filter((m) => m.label !== "Transfer %") : TV_METRICS;
        return (
          <div key={agent} className="ov-tvblock">
            <div className="ov-tvhead">
              <Dot c={AGENT_COLOR[agent]} />{agent}
              <span className="ov-chip arr" title="Annual recurring revenue from live agents (Σ MRR × 12)"><b>{s ? fmtMoneyCompact(s.arr) : "—"}</b> ARR</span>
              <span className="sub">{grain}-on-{grain}{generated ? ` · ${generated}` : ""}</span>
            </div>
            <div className="ov-tvwrap">
              <table className="ov-tvtable">
                <thead>
                  <tr>
                    <th className="m">Metric</th>
                    {periods.map((p, i) => <th key={p} className={i === 0 ? "latest" : undefined}>{colLabel(grain, p)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <Fragment key={m.label}>
                      {/* "Agent count" sits just above the first raw-count row
                          (Rooftops w/ activity, which carries the group divider).
                          Counted per column = agents live as of that period's end
                          (from each deployment's go-live date), so it ramps over
                          time instead of repeating one static number. */}
                      {m.grp && (
                        <tr className="grp agentrow">
                          <td className="m" title="Agents live as of each period (by go-live date)">Agent count</td>
                          {periods.map((p, i) => {
                            const n = agentsLiveAsOf(s, periodEnd(grain, p));
                            return <td key={p} className={i === 0 ? "latest" : undefined}>{n == null ? "—" : fmtInt(n)}</td>;
                          })}
                        </tr>
                      )}
                      <tr className={[m.pct ? "pct" : "", isBig(m) ? "ov-big" : ""].filter(Boolean).join(" ") || undefined}>
                        <td className="m">{m.labelFor?.(agent) ?? m.label}</td>
                        {periods.map((p, i) => {
                          const r = gb.data[p]?.[agent];
                          return <td key={p} className={i === 0 ? "latest" : undefined} style={fmtCellStyle(m, r, agent)}>{r ? m.value(r, agent) : "—"}</td>;
                        })}
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (!immersive) return grid;

  return (
    <div className="ov-immersive">
      <div className="ov-itop">
        <span>📞 Agent Performance · {GRAIN_LABEL[grain]}</span>
        <span className="sub">as of {generated} · auto-rotating Day → Week → Month · move mouse to exit</span>
      </div>
      {grid}
    </div>
  );
}

export default OverallView;
