import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  NOT_SENT_REASON_CTA,
  NOT_SENT_REASON_LABEL,
  computeSummary,
  reasonBreakdown,
  type Cadence,
  type DeptKind,
  type NotSentReason,
  type RooftopRow,
  type SendCell,
} from "./mockData";
import { loadRooftops } from "./dataSource";
import { supabase } from "./supabaseClient";
import { RooftopCellDrawer } from "./RooftopCellDrawer";
import { isPipelineConfigured, runDryPipeline, runRespectPipeline } from "./pipeline";
import { reportMissingRooftopNow } from "./sendDigest";

export function EmailerTracker() {
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [search, setSearch] = useState("");
  const [csmFilter, setCsmFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState<"all" | "sales" | "service">("all");
  const [reasonFilter, setReasonFilter] = useState<NotSentReason | "all">("all");
  const [sentNow, setSentNow] = useState<Record<string, true>>({});
  const [activeCell, setActiveCell] = useState<{ rooftop: RooftopRow; cell: SendCell } | null>(null);

  // Live data from roi_digest_runs (+ mailservice engagement). No mock fallback — empty until loaded.
  const [rooftops, setRooftops] = useState<RooftopRow[]>([]);
  const [today, setToday] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [sourceKind, setSourceKind] = useState<"supabase" | "unconfigured" | "error" | "">("");
  const [lastSynced, setLastSynced] = useState<Date>(new Date());
  const [loading, setLoading] = useState(true); // start in loading so we never flash mock/empty
  const [loadedOnce, setLoadedOnce] = useState(false);
  // Global manual pipeline triggers
  const [dryRunState, setDryRunState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [dryRunMsg, setDryRunMsg] = useState("");
  const [liveState, setLiveState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [liveMsg, setLiveMsg] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await loadRooftops();
      setRooftops(res.rooftops);
      setToday(res.today);
      setSourceKind(res.source);
      setSource(res.source === "supabase" ? "Supabase · roi_digest_runs" : res.source === "error" ? "Connection error" : "Not connected");
      setLastSynced(res.lastSynced);
    } catch (e) {
      console.warn("[tracker] load failed:", e);
      setSourceKind("error");
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // DRY-RUN ALL (preview): forced dry — regenerates every rooftop's HTML, sends NOTHING.
  const runDryRunAll = useCallback(async () => {
    setDryRunState("running");
    setDryRunMsg("");
    const r = await runDryPipeline({}); // no team → all rooftops; dry=true is hard-coded
    if (r.simulated) {
      setDryRunState("done");
      setDryRunMsg("Simulated — no backend configured.");
    } else if (r.ok) {
      setDryRunState("done");
      setDryRunMsg(`Dry-run preview done · ${r.counts?.queued ?? 0} rendered · ${r.counts?.suppressed ?? 0} suppressed · 0 sent.`);
      await reload();
    } else {
      setDryRunState("error");
      setDryRunMsg(r.status === 404 ? "Functions not deployed yet." : r.error ?? `Error ${r.status ?? ""}`);
    }
    setTimeout(() => setDryRunState("idle"), 4000);
  }, [reload]);

  // SEND LIVE (respect flags): real emails to live rooftops (dry_run=false), dry ones suppressed.
  const runSendLiveAll = useCallback(async () => {
    const liveCount = rooftops.filter((r) => r.dryRun === false).length;
    if (liveCount === 0) {
      setLiveState("error");
      setLiveMsg("No live rooftops. Flip a rooftop's toggle to “Live” first — dry rooftops are never emailed.");
      setTimeout(() => setLiveState("idle"), 5000);
      return;
    }
    const ok = window.confirm(
      `Send REAL emails now?\n\n${liveCount} live rooftop(s) (dry_run = false) will receive their digest via mail.spyne.ai.\nDry-run rooftops are skipped. This is not a preview.`,
    );
    if (!ok) return;
    setLiveState("running");
    setLiveMsg("");
    const r = await runRespectPipeline({}); // no team → all rooftops; honours each dry_run flag
    if (r.simulated) {
      setLiveState("done");
      setLiveMsg("Simulated — no backend configured. Nothing sent.");
    } else if (r.authFailed || r.status === 401 || r.status === 403) {
      setLiveState("error");
      setLiveMsg("Mail token rejected/expired. Open a live rooftop’s “Send now” to paste a fresh token, then retry.");
    } else if (r.status === 404) {
      setLiveState("error");
      setLiveMsg("Functions not deployed yet.");
    } else if (r.ok) {
      setLiveState("done");
      setLiveMsg(`Sent · ${r.counts?.sent ?? 0} live · ${r.counts?.suppressed ?? 0} held (dry) · ${r.counts?.errors ?? 0} errors.`);
      await reload();
    } else {
      setLiveState("error");
      setLiveMsg(r.error ?? `Error ${r.status ?? ""}`);
    }
    setTimeout(() => setLiveState("idle"), 6000);
  }, [rooftops, reload]);

  const liveCount = useMemo(() => rooftops.filter((r) => r.dryRun === false).length, [rooftops]);

  const cellKey = (r: RooftopRow, c: SendCell) => `${r.rooftop_id}::${c.cadence}::${c.date}`;
  const colCount = cadence === "daily" ? 10 : cadence === "weekly" ? 8 : 6;
  const csms = useMemo(() => Array.from(new Set(rooftops.map((r) => r.csm))), [rooftops]);
  const syncedMinAgo = Math.max(0, Math.round((Date.now() - lastSynced.getTime()) / 60000));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rooftops.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.csm.toLowerCase().includes(q)) return false;
      if (csmFilter !== "all" && r.csm !== csmFilter) return false;
      if (deptFilter !== "all" && r.department !== deptFilter) return false;
      if (reasonFilter !== "all" && r.current_block !== reasonFilter) return false;
      return true;
    });
  }, [rooftops, search, csmFilter, deptFilter, reasonFilter]);

  const summary = useMemo(() => computeSummary(rooftops, cadence), [rooftops, cadence]);
  const breakdown = useMemo(() => reasonBreakdown(rooftops), [rooftops]);
  const teamCount = useMemo(() => new Set(rooftops.map((r) => r.team_id)).size, [rooftops]);
  const salesRows = rooftops.filter((r) => r.department === "sales").length;
  const serviceRows = rooftops.filter((r) => r.department === "service").length;

  // Loader while the first load is in flight — no mock dataset is ever shown.
  if (!loadedOnce && loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border-subtle border-t-brand-primary" />
        <div className="text-[13px] font-semibold">Loading rooftop tracker…</div>
      </div>
    );
  }
  // Explicit empty/error state instead of fake mock data.
  if (rooftops.length === 0) {
    const unconfigured = sourceKind === "unconfigured";
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-[15px] font-bold text-text-primary">{unconfigured ? "Tracker not connected" : "Couldn’t load rooftops"}</div>
        <p className="max-w-md text-[12px] text-text-secondary">
          {unconfigured
            ? "Supabase isn’t configured for this build — set VITE_ROI_SUPABASE_URL and VITE_ROI_SUPABASE_KEY, then reload."
            : "The roi_digest_runs read failed. Check the Supabase connection and try again."}
        </p>
        <button type="button" onClick={() => void reload()} disabled={loading} className="rounded-md bg-brand-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-brand-primary-hover disabled:opacity-60">
          {loading ? "Retrying…" : "↻ Retry"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface-background">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-border-subtle bg-surface-card px-6 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-bold tracking-tight text-text-primary">
              Rooftop Tracker
            </h1>
            <span className="text-[11px] text-text-secondary">
              {teamCount} rooftops · {rooftops.length} dept trackers
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <span className="tabular">{source}</span>
            <span>·</span>
            <span className="tabular">synced {syncedMinAgo} min ago</span>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={loading}
              className="ml-1 rounded-md border border-border-subtle bg-surface-card px-2.5 py-1 text-[11px] font-semibold text-text-primary hover:bg-surface-subtle disabled:opacity-50"
            >
              {loading ? "Refreshing…" : "⟳ Refresh"}
            </button>
            <button
              type="button"
              onClick={() => void runDryRunAll()}
              disabled={dryRunState === "running"}
              title="Fire cron1→4 for every rooftop with dry-run forced ON. Renders + records each digest as suppressed. No email is sent."
              className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                dryRunState === "error"
                  ? "border-negative/40 bg-negative-soft text-negative"
                  : dryRunState === "done"
                  ? "border-positive/40 bg-positive/10 text-positive"
                  : "border-border-subtle bg-surface-card text-text-primary hover:bg-surface-subtle"
              } disabled:opacity-60`}
            >
              {dryRunState === "running"
                ? "Running…"
                : dryRunState === "done"
                ? "✓ Dry-run done"
                : dryRunState === "error"
                ? "Dry-run failed"
                : "Dry-run all (preview)"}
            </button>
            <button
              type="button"
              onClick={() => void runSendLiveAll()}
              disabled={liveState === "running"}
              title={
                liveCount > 0
                  ? `Send REAL emails to the ${liveCount} live rooftop(s) (dry_run=false). Dry rooftops are skipped.`
                  : "No live rooftops — flip a rooftop to Live first. Dry rooftops are never emailed."
              }
              className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                liveState === "error"
                  ? "border-negative/40 bg-negative-soft text-negative"
                  : liveState === "done"
                  ? "border-positive/40 bg-positive/10 text-positive"
                  : liveCount > 0
                  ? "border-negative/50 bg-negative text-white hover:opacity-90"
                  : "border-border-subtle bg-surface-subtle text-text-muted"
              } disabled:opacity-60`}
            >
              {liveState === "running"
                ? "Sending…"
                : liveState === "done"
                ? "✓ Sent live"
                : liveState === "error"
                ? "Send failed"
                : `▶ Send live (${liveCount})`}
            </button>
            <MissingRooftopButton />
          </div>
        </div>
        {dryRunMsg || liveMsg ? (
          <div className="mt-1 text-right text-[10px] text-text-muted">
            {liveMsg || dryRunMsg}
            {!isPipelineConfigured ? " · set VITE_SUPABASE_URL + deploy functions to run for real" : ""}
          </div>
        ) : null}
      </header>

      {/* Compact stats strip — small, the daily tracker is the focus */}
      <div className="flex-shrink-0 border-b border-border-subtle bg-surface-background px-6 py-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <Stat label="Rooftops" value={teamCount} />
          <Stat label="Dept trackers" value={rooftops.length} />
          <Stat label="Sales / Service" value={`${salesRows} / ${serviceRows}`} />
          <span className="h-4 w-px bg-border-subtle" />
          <Stat label="Sent today" value={summary.emailStatus.sent} tone="positive" />
          <Stat label="Not sent" value={summary.emailStatus.notSent} tone="negative" />
          <Stat
            label="Sent rate"
            value={`${summary.emailStatus.sentRatePct}%`}
            tone={summary.emailStatus.sentRatePct >= 50 ? "positive" : "negative"}
          />
        </div>
      </div>

      {/* CSM action board */}
      {breakdown.length > 0 ? (
        <div className="flex-shrink-0 border-b border-border-subtle bg-warning-soft/40 px-6 py-2.5">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-warning">
              Action board · {breakdown.reduce((s, b) => s + b.count, 0)} rooftops blocked
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {breakdown.map((b) => {
                const active = reasonFilter === b.reason;
                return (
                  <button
                    key={b.reason}
                    type="button"
                    onClick={() => setReasonFilter(active ? "all" : b.reason)}
                    title={b.rooftops.join(", ")}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                      active
                        ? "border-warning bg-warning text-white"
                        : "border-warning/40 bg-surface-card text-warning hover:bg-warning-soft"
                    }`}
                  >
                    <span className="tabular">{b.count}</span>
                    {NOT_SENT_REASON_LABEL[b.reason]}
                  </button>
                );
              })}
              {reasonFilter !== "all" ? (
                <button
                  type="button"
                  onClick={() => setReasonFilter("all")}
                  className="text-[11px] font-semibold text-text-secondary hover:underline"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Filter strip */}
      <div className="flex-shrink-0 border-b border-border-subtle bg-surface-card px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rooftop or CSM…"
            className="w-[240px] rounded-md border border-border-subtle bg-surface-card px-3 py-1.5 text-[12px] placeholder:text-text-muted focus:border-brand-primary focus:outline-none"
          />
          <Select
            value={csmFilter}
            onChange={setCsmFilter}
            options={[{ value: "all", label: "All CSMs" }, ...csms.map((c) => ({ value: c, label: c }))]}
          />
          <Select
            value={deptFilter}
            onChange={(v) => setDeptFilter(v as "all" | "sales" | "service")}
            options={[
              { value: "all", label: "All departments" },
              { value: "sales", label: "Sales live" },
              { value: "service", label: "Service live" },
            ]}
          />
          <div className="inline-flex overflow-hidden rounded-md border border-border-subtle">
            {(["daily", "weekly", "monthly"] as Cadence[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCadence(c)}
                className={`px-3 py-1.5 text-[12px] font-semibold capitalize ${
                  cadence === c ? "bg-brand-primary text-white" : "bg-surface-card text-text-secondary hover:bg-surface-subtle"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setCsmFilter("all");
              setDeptFilter("all");
              setReasonFilter("all");
            }}
            className="ml-1 text-[11px] font-semibold text-brand-primary hover:underline"
          >
            Clear filters
          </button>
          <div className="ml-auto text-[11px] text-text-muted tabular">
            Showing {filtered.length} of {rooftops.length} rooftops
          </div>
        </div>
      </div>

      {/* 3 · Table */}
      <div className="flex-1 overflow-auto bg-surface-background">
        <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
          <thead className="sticky top-0 z-20">
            <tr>
              <Th sticky left={0} minW={200}>Rooftop</Th>
              <Th minW={140}>CSM</Th>
              <Th minW={92}>Dept</Th>
              <Th minW={96}>Dry-run</Th>
              {Array.from({ length: colCount }).map((_, i) => (
                <Th key={i} minW={88}>{formatColLabel(cadence, i, today)}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, idx) => {
              const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
              // group-by-rooftop: both department rows of a rooftop render as one visual block
              const groupKey = (rr: RooftopRow) => rr.team_id ?? rr.name;
              const firstOfGroup = idx === 0 || groupKey(filtered[idx - 1]) !== groupKey(r);
              const lastOfGroup = idx === filtered.length - 1 || groupKey(filtered[idx + 1]) !== groupKey(r);
              // shared zebra per rooftop group (not per row) so both dept rows match
              let groupIdx = 0;
              for (let k = 1; k <= idx; k++) if (groupKey(filtered[k - 1]) !== groupKey(filtered[k])) groupIdx++;
              const rowBg = groupIdx % 2 === 0 ? "bg-surface-card" : "bg-surface-background";
              const divider = lastOfGroup ? "border-b border-border-subtle" : "";
              const groupTop = firstOfGroup && idx !== 0 ? "border-t-2 border-border-subtle" : "";
              return (
                <tr key={r.rooftop_id}>
                  <td className={`sticky left-0 z-10 ${divider} ${groupTop} ${rowBg} px-4 py-2`} style={{ minWidth: 200 }}>
                    {firstOfGroup ? (
                      <>
                        <div className="text-[13px] font-semibold text-text-primary">{r.name}</div>
                        <div className="text-[10px] text-text-muted">{r.group ?? "—"}</div>
                      </>
                    ) : (
                      <div className="pl-3 text-[11px] text-text-muted">↳ same rooftop</div>
                    )}
                  </td>
                  <td className={`${divider} ${groupTop} ${rowBg} px-3 py-2`} style={{ minWidth: 140 }}>
                    {firstOfGroup ? (
                      <span className="text-[12px] font-medium text-text-secondary">{r.csm}</span>
                    ) : null}
                  </td>
                  <td className={`${divider} ${groupTop} px-3 py-2`}>
                    <DeptBadge dept={r.department} />
                  </td>
                  <td className={`${divider} ${groupTop} px-3 py-2`}>
                    <DryRunToggle rooftop={r} />
                  </td>
                  {cells.slice(0, colCount).map((c) => (
                    <td key={c.date} className={`${divider} ${groupTop} px-2 py-2`} style={{ minWidth: 88 }}>
                      <SendStatusCell
                        cell={c}
                        sentNow={!!sentNow[cellKey(r, c)]}
                        onOpen={() => setActiveCell({ rooftop: r, cell: c })}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-text-muted">No rooftops match the filters.</div>
        ) : null}
      </div>

      <RooftopCellDrawer
        rooftop={activeCell?.rooftop ?? null}
        cell={activeCell?.cell ?? null}
        onClose={() => setActiveCell(null)}
        onSend={(rid, date, cad) =>
          setSentNow((p) => ({ ...p, [`${rid}::${cad}::${date}`]: true }))
        }
        onReload={() => void reload()}
      />
    </div>
  );
}

/* ============================================================
   Compact stat (header strip)
   ============================================================ */
function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "positive" | "negative";
}) {
  const c = tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-text-primary";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`text-[15px] font-bold tabular leading-none ${c}`}>{value}</span>
      <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">{label}</span>
    </span>
  );
}

/* ============================================================
   Department badge (one row per department)
   ============================================================ */
function DeptBadge({ dept }: { dept?: DeptKind }) {
  if (!dept) return <span className="text-[10px] text-text-muted">—</span>;
  const cls = dept === "sales" ? "bg-info-soft text-info" : "bg-positive/10 text-positive";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dept === "sales" ? "bg-info" : "bg-positive"}`} />
      {dept}
    </span>
  );
}

/* ============================================================
   Per-department dry-run toggle → writes roi_live_departments.dry_run
   ============================================================ */
// #3 — report a rooftop missing from the tracker → emails product@ + subhav@ with details.
function MissingRooftopButton() {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ teamId: "", teamName: "", departments: "", csm: "", csmEmail: "", note: "" });
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const upd = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = async () => {
    if (!f.teamId.trim() && !f.teamName.trim()) { setState("error"); setMsg("Team ID or team name is required."); return; }
    setState("sending"); setMsg("");
    const r = await reportMissingRooftopNow({
      teamId: f.teamId.trim(), teamName: f.teamName.trim(),
      departments: f.departments.split(",").map((s) => s.trim()).filter(Boolean),
      csm: f.csm.trim(), csmEmail: f.csmEmail.trim(), note: f.note.trim(),
    });
    if (r.ok) { setState("done"); setMsg("Sent to product@spyne.ai + subhav.malhotra@spyne.ai ✓"); setTimeout(() => { setOpen(false); setState("idle"); setF({ teamId: "", teamName: "", departments: "", csm: "", csmEmail: "", note: "" }); }, 1600); }
    else { setState("error"); setMsg(r.error || "Send failed"); }
  };
  const inputCls = "w-full rounded-md border border-border-subtle bg-surface-background px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none";
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-border-subtle bg-surface-card px-2.5 py-1 text-[11px] font-semibold text-text-primary hover:bg-surface-subtle">+ Missing rooftop</button>
      {open ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-border-subtle bg-surface-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-bold text-text-primary">Report a missing rooftop</h3>
            <p className="mt-1 text-[12px] text-text-secondary">Emails <b>product@spyne.ai</b> + <b>subhav.malhotra@spyne.ai</b> with the details below for onboarding.</p>
            <div className="mt-3 space-y-2">
              <input className={inputCls} value={f.teamId} onChange={upd("teamId")} placeholder="Team ID" />
              <input className={inputCls} value={f.teamName} onChange={upd("teamName")} placeholder="Team / rooftop name" />
              <input className={inputCls} value={f.departments} onChange={upd("departments")} placeholder="Departments live (e.g. sales, service)" />
              <input className={inputCls} value={f.csm} onChange={upd("csm")} placeholder="CSM name" />
              <input className={inputCls} value={f.csmEmail} onChange={upd("csmEmail")} placeholder="CSM email" />
              <textarea className={inputCls} rows={2} value={f.note} onChange={upd("note")} placeholder="Note (optional)" />
            </div>
            {msg ? <p className={`mt-2 text-[11px] ${state === "error" ? "text-negative" : "text-positive"}`}>{msg}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-subtle">Cancel</button>
              <button type="button" disabled={state === "sending"} onClick={() => void submit()} className="rounded-md bg-brand-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-brand-primary-hover disabled:opacity-60">
                {state === "sending" ? "Sending…" : "Send report"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function DryRunToggle({ rooftop }: { rooftop: RooftopRow }) {
  const [on, setOn] = useState<boolean>(rooftop.dryRun !== false); // on = dry-run held
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const persist = async (nextDry: boolean): Promise<boolean> => {
    setBusy(true);
    if (supabase && rooftop.team_id && rooftop.department) {
      const { error } = await supabase
        .from("roi_live_departments").update({ dry_run: nextDry })
        .eq("team_id", rooftop.team_id).eq("department", rooftop.department);
      if (error) { setBusy(false); return false; }
    }
    setOn(nextDry); setBusy(false); return true;
  };

  const onClick = () => {
    if (busy || !rooftop.team_id || !rooftop.department) return;
    if (on) setConfirm(true);     // dry → LIVE: show disclaimer first
    else void persist(true);      // live → dry (hold): safe, no prompt
  };

  // who will start receiving once live = enabled recipients for this dept
  const recipients = (rooftop.departments?.find((d) => d.kind === rooftop.department)?.recipients
    ?? rooftop.departments?.[0]?.recipients ?? []).map((r) => r.email).filter(Boolean);
  const pad = (n?: number) => String(n ?? (n === 0 ? 0 : 7)).padStart(2, "0");
  const sendTime = `${pad(rooftop.sendHour)}:${String(rooftop.sendMinute ?? 0).padStart(2, "0")}`;
  const tz = rooftop.timezone || "America/New_York";

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title={on ? "Dry-run ON — emails held. Click to go Live." : "Live — sends allowed. Click to hold (dry-run)."}
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${on ? "bg-warning-soft text-warning" : "bg-positive/10 text-positive"} ${busy ? "opacity-50" : ""}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-warning" : "bg-positive"}`} />
        {on ? "Dry-run" : "Live"}
      </button>
      {confirm ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" onClick={() => setConfirm(false)}>
          <div className="w-full max-w-md rounded-xl border border-border-subtle bg-surface-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-bold text-text-primary">Enable live emails for {rooftop.name}?</h3>
            <p className="mt-1 text-[12px] text-text-secondary">
              The <b>{rooftop.department}</b> digest will start sending on the next scheduled run at <b>{sendTime} {tz}</b>.
            </p>
            <div className="mt-3 rounded-md border border-border-subtle bg-surface-background p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Will start receiving ({recipients.length})</div>
              {recipients.length ? (
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                  {recipients.map((e) => <li key={e} className="text-[12px] text-text-primary">{e}</li>)}
                </ul>
              ) : (
                <p className="mt-1 text-[12px] text-warning">No enabled recipients — nobody will receive until you enable some.</p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(false)} className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-subtle">Cancel</button>
              <button type="button" disabled={busy} onClick={async () => { const ok = await persist(false); if (ok) setConfirm(false); }} className="rounded-md bg-brand-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-brand-primary-hover disabled:opacity-60">
                {busy ? "Saving…" : "Save · go live"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ============================================================
   Send-status cell
   ============================================================ */
function SendStatusCell({
  cell,
  sentNow,
  onOpen,
}: {
  cell: SendCell;
  sentNow: boolean;
  onOpen: () => void;
}) {
  if (sentNow) {
    return (
      <span className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-positive/10 px-2 py-1 text-[11px] font-semibold text-positive">
        ✓ Sent now
      </span>
    );
  }
  switch (cell.status) {
    case "sent":
      return (
        <button
          type="button"
          onClick={onOpen}
          title="Click to view what was sent + recipients"
          className="inline-flex w-full items-center justify-center rounded-md bg-positive/10 px-2 py-1 text-[11px] font-semibold text-positive hover:bg-positive/20"
        >
          Sent
        </button>
      );
    case "suppressed":
      return (
        <button
          type="button"
          onClick={onOpen}
          title={cell.reason ? `Suppressed · ${NOT_SENT_REASON_LABEL[cell.reason]} · click to view + send` : "Suppressed · click to view + send"}
          className="inline-flex w-full items-center justify-center rounded-md bg-warning-soft px-2 py-1 text-[11px] font-semibold text-warning hover:bg-warning-soft/80"
        >
          Suppr.
        </button>
      );
    case "not_sent": {
      const reason = cell.reason ?? "scheduler_skipped";
      const cta = NOT_SENT_REASON_CTA[reason];
      const styles =
        cta.tone === "warn"
          ? "border-warning/40 bg-warning-soft text-warning hover:bg-warning-soft/80"
          : "border-negative/40 bg-negative-soft text-negative hover:bg-negative-soft/80";
      return (
        <button
          type="button"
          onClick={onOpen}
          className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold ${styles}`}
          title={`Not sent · ${NOT_SENT_REASON_LABEL[reason]}`}
        >
          {cta.label}
        </button>
      );
    }
    case "not_subscribed":
      return (
        <span className="inline-flex w-full items-center justify-center rounded-md bg-surface-subtle px-2 py-1 text-[11px] text-text-muted">
          —
        </span>
      );
    case "scheduled":
      return (
        <span className="inline-flex w-full items-center justify-center rounded-md bg-info-soft px-2 py-1 text-[11px] font-semibold text-info">
          Scheduled
        </span>
      );
  }
}

/* ============================================================
   Small primitives
   ============================================================ */
function Th({
  children,
  sticky,
  left,
  minW,
}: {
  children: React.ReactNode;
  sticky?: boolean;
  left?: number;
  minW?: number;
}) {
  return (
    <th
      className={`border-b border-border-subtle bg-surface-card px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-text-muted ${
        sticky ? "sticky z-30" : ""
      }`}
      style={{ minWidth: minW, left: sticky ? left : undefined }}
    >
      {children}
    </th>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-border-subtle bg-surface-card px-2.5 py-1.5 text-[12px] font-medium text-text-secondary focus:border-brand-primary focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function formatColLabel(cadence: Cadence, i: number, today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (cadence === "daily") {
    date.setUTCDate(date.getUTCDate() - i);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  if (cadence === "weekly") {
    date.setUTCDate(date.getUTCDate() - i * 7);
    return `Wk ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
  }
  date.setUTCMonth(date.getUTCMonth() - i);
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}
