import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  NOT_SENT_REASON_CTA,
  NOT_SENT_REASON_LABEL,
  computeSummary,
  reasonBreakdown,
  EMAIL_TYPES,
  TRANSACTIONAL_TYPES,
  type Cadence,
  type DeptKind,
  type NotSentReason,
  type RooftopRow,
  type RooftopConfig,
  type EmailTypeKey,
  type SendCell,
} from "./mockData";
import { loadRooftops, updateRooftopConfig, loadEventCounts, loadEventEmails, type EventCounts, type EventEmailRow } from "./dataSource";
import { supabase } from "./supabaseClient";
import { RooftopCellDrawer } from "./RooftopCellDrawer";
import { isPipelineConfigured, runPreviewPipeline, runRespectPipeline } from "./pipeline";
import { reportMissingRooftopNow, generateSendEventNow } from "./sendDigest";

export function EmailerTracker() {
  const [cadence, setCadence] = useState<Cadence>("daily");
  // Digests (daily/weekly/monthly cadence cells) vs Transactional (per-event email counts).
  const [view, setView] = useState<"digests" | "transactional">("digests");
  const [eventCounts, setEventCounts] = useState<EventCounts>(new Map());
  const [eventList, setEventList] = useState<{ rooftop: RooftopRow; type: string; label: string; direction?: "inbound" | "outbound" | null } | null>(null);
  const [search, setSearch] = useState("");
  const [csmFilter, setCsmFilter] = useState("all");
  // Agent-product filter — Sales/Service × Inbound/Outbound. Digests are stored per dept, so
  // IB/OB map onto their dept's rows (they share one digest); the picker still reads as products.
  const [productFilter, setProductFilter] = useState<"all" | "sales_ib" | "sales_ob" | "service_ib" | "service_ob">("all");
  const [reasonFilter, setReasonFilter] = useState<NotSentReason | "all">("all");
  const [groupBy, setGroupBy] = useState<"rooftop" | "csm">("rooftop");
  const [sentNow, setSentNow] = useState<Record<string, true>>({});
  const [activeCell, setActiveCell] = useState<{ rooftop: RooftopRow; cell: SendCell } | null>(null);
  const [configRooftop, setConfigRooftop] = useState<RooftopRow | null>(null);

  // Live data from roi_digest_runs (+ mailservice engagement). No mock fallback — empty until loaded.
  const [rooftops, setRooftops] = useState<RooftopRow[]>([]);
  const [today, setToday] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [sourceKind, setSourceKind] = useState<"supabase" | "unconfigured" | "error" | "">("");
  const [lastSynced, setLastSynced] = useState<Date>(new Date());
  const [loading, setLoading] = useState(true); // start in loading so we never flash mock/empty
  const [loadedOnce, setLoadedOnce] = useState(false);
  // Global manual pipeline triggers
  const [previewState, setPreviewState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [previewMsg, setPreviewMsg] = useState("");
  const [liveState, setLiveState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [liveMsg, setLiveMsg] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [res, counts] = await Promise.all([loadRooftops(), loadEventCounts()]);
      setEventCounts(counts);
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

  // PREVIEW ALL (Spyne-only): a REAL send across all rooftops, but cron4 filters
  // every recipient list down to @spyne.ai addresses — no customer is emailed.
  // Subject is prefixed "[PREVIEW]". Needs a mail token, like a live send.
  const runSpynePreviewAll = useCallback(async () => {
    const ok = window.confirm(
      "Send a PREVIEW now?\n\nThis really emails — but ONLY @spyne.ai (internal) recipients across all rooftops. " +
      "Every external/customer address is dropped, so no customer receives anything. Subject is prefixed “[PREVIEW]”.",
    );
    if (!ok) return;
    setPreviewState("running");
    setPreviewMsg("");
    const r = await runPreviewPipeline({}); // no team → all rooftops; cron4 keeps @spyne.ai only
    if (r.simulated) {
      setPreviewState("done");
      setPreviewMsg("Simulated — no backend configured.");
    } else if (r.authFailed || r.status === 401 || r.status === 403) {
      setPreviewState("error");
      setPreviewMsg("Mail token rejected/expired. Open a rooftop’s “Send now” to paste a fresh token, then retry.");
    } else if (r.status === 404) {
      setPreviewState("error");
      setPreviewMsg("Functions not deployed yet.");
    } else if (r.ok) {
      setPreviewState("done");
      setPreviewMsg(`Preview sent to Spyne only · ${r.counts?.preview ?? 0} previewed (dealer not sent, not counted) · ${r.counts?.skipped ?? 0} skipped (no @spyne.ai recipient) · ${r.counts?.errors ?? 0} errors.`);
      await reload();
    } else {
      setPreviewState("error");
      setPreviewMsg(r.error ?? `Error ${r.status ?? ""}`);
    }
    setTimeout(() => setPreviewState("idle"), 6000);
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
  // The 4-agent filter → a direction (inbound/outbound) for transactional counts + drill-down.
  // "all" = both directions (the department total). sales_ib/service_ib → inbound; *_ob → outbound.
  const prodDir: "inbound" | "outbound" | null = productFilter === "all" ? null : productFilter.endsWith("ib") ? "inbound" : "outbound";

  const cellKey = (r: RooftopRow, c: SendCell) => `${r.rooftop_id}::${c.cadence}::${c.date}`;
  const colCount = cadence === "daily" ? 10 : cadence === "weekly" ? 8 : 6;
  const csms = useMemo(() => Array.from(new Set(rooftops.map((r) => r.csm))), [rooftops]);
  const syncedMinAgo = Math.max(0, Math.round((Date.now() - lastSynced.getTime()) / 60000));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const prodDept = productFilter === "all" ? null : productFilter.startsWith("sales") ? "sales" : "service";
    return rooftops.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.csm.toLowerCase().includes(q)) return false;
      if (csmFilter !== "all" && r.csm !== csmFilter) return false;
      if (prodDept && r.department !== prodDept) return false;
      if (reasonFilter !== "all" && r.current_block !== reasonFilter) return false;
      return true;
    });
  }, [rooftops, search, csmFilter, productFilter, reasonFilter]);

  // Per-column tallies shown above each date: sent / not-sent / not-eligible.
  // not-eligible = not_subscribed (dept not subscribed / no run that day); everything
  // else that didn't send (not_sent, suppressed, scheduled) counts as not-sent.
  const colStats = useMemo(() => {
    const arr = Array.from({ length: colCount }, () => ({ sent: 0, notSent: 0, notEligible: 0 }));
    for (const r of filtered) {
      const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
      for (let i = 0; i < colCount; i++) {
        const st = cells[i]?.status;
        if (!st) continue;
        if (st === "sent") arr[i].sent++;
        else if (st === "not_subscribed") arr[i].notEligible++;
        else arr[i].notSent++;
      }
    }
    return arr;
  }, [filtered, cadence, colCount]);

  // Group-by-CSM clusters a CSM's rooftops together (CSM → rooftop → dept rows). Rooftop
  // grouping (the default) keeps a rooftop's two dept rows adjacent.
  const ordered = useMemo(() => {
    if (groupBy !== "csm") return filtered;
    return [...filtered].sort((a, b) =>
      (a.csm || "").localeCompare(b.csm || "") ||
      a.name.localeCompare(b.name) ||
      (a.department ?? "").localeCompare(b.department ?? ""));
  }, [filtered, groupBy]);

  // Summary reflects the CURRENT filter set (so filtering to one CSM updates the count + %).
  const summary = useMemo(() => computeSummary(filtered, cadence), [filtered, cadence]);
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
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-[16px] font-extrabold tracking-tight text-text-primary">
              Email Tracker
            </h1>
            <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] font-semibold text-text-secondary">
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
              onClick={() => void runSpynePreviewAll()}
              disabled={previewState === "running"}
              title="Fire cron1→4 for every rooftop as a REAL send, but cron4 keeps only @spyne.ai recipients — no customer is emailed. Subject prefixed “[PREVIEW]”. Needs a mail token."
              className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                previewState === "error"
                  ? "border-negative/40 bg-negative-soft text-negative"
                  : previewState === "done"
                  ? "border-positive/40 bg-positive/10 text-positive"
                  : "border-border-subtle bg-surface-card text-text-primary hover:bg-surface-subtle"
              } disabled:opacity-60`}
            >
              {previewState === "running"
                ? "Sending preview…"
                : previewState === "done"
                ? "✓ Preview sent"
                : previewState === "error"
                ? "Preview failed"
                : "Preview (Spyne only)"}
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
        {previewMsg || liveMsg ? (
          <div className="mt-1 text-right text-[10px] text-text-muted">
            {liveMsg || previewMsg}
            {!isPipelineConfigured ? " · set VITE_SUPABASE_URL + deploy functions to run for real" : ""}
          </div>
        ) : null}
      </header>

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
            value={productFilter}
            onChange={(v) => setProductFilter(v as typeof productFilter)}
            options={[
              { value: "all", label: "All products" },
              { value: "sales_ib", label: "Sales · Inbound" },
              { value: "sales_ob", label: "Sales · Outbound" },
              { value: "service_ib", label: "Service · Inbound" },
              { value: "service_ob", label: "Service · Outbound" },
            ]}
          />
          <div className="inline-flex overflow-hidden rounded-md border border-border-subtle">
            {([["digests", "Digests"], ["transactional", "Transactional"]] as const).map(([v, lbl]) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                title={v === "transactional" ? "Per-event emails: post-appointment, post-conversation, action item, overdue" : "Daily / weekly / monthly digests"}
                className={`px-3 py-1.5 text-[12px] font-semibold ${
                  view === v ? "bg-text-primary text-white" : "bg-surface-card text-text-secondary hover:bg-surface-subtle"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
          {view === "digests" ? (
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
          ) : null}
          <div className="inline-flex overflow-hidden rounded-md border border-border-subtle">
            {(["rooftop", "csm"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGroupBy(g)}
                title={g === "csm" ? "Group rooftops by CSM" : "Group by rooftop"}
                className={`px-3 py-1.5 text-[12px] font-semibold capitalize ${
                  groupBy === g ? "bg-brand-primary text-white" : "bg-surface-card text-text-secondary hover:bg-surface-subtle"
                }`}
              >
                {g === "csm" ? "By CSM" : "By rooftop"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setCsmFilter("all");
              setProductFilter("all");
              setReasonFilter("all");
              setGroupBy("rooftop");
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

      {/* KPI strip — sits below the filters; reacts to the active filters (CSM / product / search) */}
      <div className="flex-shrink-0 border-b border-border-subtle bg-surface-background px-6 py-3">
        <div className="flex flex-wrap items-stretch gap-2">
          <Stat label="Rooftops" value={teamCount} />
          <Stat label="Dept trackers" value={rooftops.length} />
          <Stat label="Sales / Service" value={`${salesRows} / ${serviceRows}`} />
          <span className="mx-1 w-px self-stretch bg-border-subtle" />
          <Stat label="Sent today" value={summary.emailStatus.sent} tone="positive" />
          <Stat label="Not sent" value={summary.emailStatus.notSent} tone="negative" />
          <Stat
            label="Sent rate"
            value={`${summary.emailStatus.sentRatePct}%`}
            tone={summary.emailStatus.sentRatePct >= 50 ? "positive" : "negative"}
          />
          <Stat
            label="Open rate"
            value={`${summary.emailStatus.openRatePct}%`}
            tone={summary.emailStatus.openRatePct >= 40 ? "positive" : summary.emailStatus.opened > 0 ? "neutral" : undefined}
          />
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
              {view === "digests"
                ? Array.from({ length: colCount }).map((_, i) => (
                    <Th key={i} minW={104}>
                      <div>{formatColLabel(cadence, i, today)}</div>
                      <div
                        className="mt-1 flex items-center gap-1.5 text-[11px] font-bold tabular"
                        title={`${colStats[i].sent} sent · ${colStats[i].notSent} not sent · ${colStats[i].notEligible} not eligible`}
                      >
                        <span className="text-positive">✓{colStats[i].sent}</span>
                        <span className="text-negative">✕{colStats[i].notSent}</span>
                        <span className="text-text-muted">–{colStats[i].notEligible}</span>
                      </div>
                    </Th>
                  ))
                : TRANSACTIONAL_TYPES.map((t) => {
                    const tot = filtered.reduce((s, r) => s + (eventCounts.get(`${r.team_id}::${r.department}`)?.[t.key]?.sent ?? 0), 0);
                    return (
                      <Th key={t.key} minW={132}>
                        <div>{t.label}</div>
                        <div className="mt-1 text-[11px] font-bold tabular text-positive">
                          {tot} <span className="font-medium text-text-muted">sent</span>
                        </div>
                      </Th>
                    );
                  })}
            </tr>
          </thead>
          <tbody>
            {ordered.map((r, idx) => {
              const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
              // group-by-rooftop: both department rows of a rooftop render as one visual block
              const groupKey = (rr: RooftopRow) => rr.team_id ?? rr.name;
              const firstOfGroup = idx === 0 || groupKey(ordered[idx - 1]) !== groupKey(r);
              const lastOfGroup = idx === ordered.length - 1 || groupKey(ordered[idx + 1]) !== groupKey(r);
              // shared zebra per rooftop group (not per row) so both dept rows match
              let groupIdx = 0;
              for (let k = 1; k <= idx; k++) if (groupKey(ordered[k - 1]) !== groupKey(ordered[k])) groupIdx++;
              const rowBg = groupIdx % 2 === 0 ? "bg-surface-card" : "bg-surface-background";
              // when grouping by CSM, draw a heavier separator where the CSM changes
              const csmTop = groupBy === "csm" && idx !== 0 && (ordered[idx - 1].csm || "") !== (r.csm || "") ? "border-t-2 border-brand-primary/40" : "";
              const divider = lastOfGroup ? "border-b border-border-subtle" : "";
              const groupTop = csmTop || (firstOfGroup && idx !== 0 ? "border-t-2 border-border-subtle" : "");
              return (
                <tr key={r.rooftop_id}>
                  <td className={`sticky left-0 z-10 ${divider} ${groupTop} ${rowBg} px-4 py-2`} style={{ minWidth: 200 }}>
                    {firstOfGroup ? (
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-[13px] font-semibold text-text-primary">{r.name}</div>
                          <div className="text-[10px] text-text-muted">{r.group ?? "—"}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfigRooftop(r)}
                          title="Configure which emails this rooftop receives"
                          className="mt-0.5 shrink-0 rounded-md border border-border-subtle px-1.5 py-0.5 text-[12px] leading-none text-text-muted hover:border-brand-primary hover:text-brand-primary"
                        >
                          ⚙
                        </button>
                      </div>
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
                  {view === "digests"
                    ? cells.slice(0, colCount).map((c) => (
                        <td key={c.date} className={`${divider} ${groupTop} px-2 py-2`} style={{ minWidth: 88 }}>
                          <SendStatusCell
                            cell={c}
                            sentNow={!!sentNow[cellKey(r, c)]}
                            onOpen={() => setActiveCell({ rooftop: r, cell: c })}
                          />
                        </td>
                      ))
                    : TRANSACTIONAL_TYPES.map((t) => {
                        const ec = eventCounts.get(`${r.team_id}::${r.department}`)?.[t.key];
                        // When a single agent (IB/OB) is selected, show that direction's count; else the dept total.
                        const total = prodDir ? (ec?.byDir?.[prodDir] ?? 0) : (ec?.total ?? 0);
                        return (
                          <td key={t.key} className={`${divider} ${groupTop} px-2 py-2`} style={{ minWidth: 132 }}>
                            {total > 0 ? (
                              <button
                                type="button"
                                onClick={() => setEventList({ rooftop: r, type: t.key, label: t.label, direction: prodDir })}
                                title={`${ec?.sent ?? 0} sent · ${ec?.notSent ?? 0} held — click to see all ${total}`}
                                className="inline-flex w-full items-center justify-center gap-0.5 rounded-md bg-brand-primary/10 px-2 py-1 text-[12px] font-bold tabular text-brand-primary hover:bg-brand-primary/20"
                              >
                                {ec?.sent ?? 0}<span className="font-medium text-text-muted">/{total}</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setEventList({ rooftop: r, type: t.key, label: t.label, direction: prodDir })}
                                title={`No ${t.label} yet · click to generate a preview, then send or ignore`}
                                className="group inline-flex w-full items-center justify-center rounded-md border border-dashed border-border-subtle bg-surface-subtle px-2 py-1 text-[11px] text-text-muted hover:border-brand-primary hover:bg-brand-primary/10 hover:text-brand-primary"
                              >
                                <span className="group-hover:hidden">—</span>
                                <span className="hidden group-hover:inline">✦ Generate</span>
                              </button>
                            )}
                          </td>
                        );
                      })}
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

      <ConfigDrawer rooftop={configRooftop} onClose={() => setConfigRooftop(null)} onSaved={() => void reload()} />

      <EventListDrawer entry={eventList} onClose={() => setEventList(null)} />
    </div>
  );
}

/* Drill-down list of the individual transactional emails behind a count
 * (e.g. all 100 post-conversation emails sent to a rooftop). */
function EventListDrawer({ entry, onClose }: { entry: { rooftop: RooftopRow; type: string; label: string; direction?: "inbound" | "outbound" | null } | null; onClose: () => void }) {
  const [rows, setRows] = useState<EventEmailRow[] | null>(null);
  const [preview, setPreview] = useState<EventEmailRow | null>(null); // the email currently being viewed
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  // Stored (exact bytes sent) ⇄ Latest design (re-rendered now with the current template).
  const [mode, setMode] = useState<"stored" | "live">("stored");
  const [liveHtml, setLiveHtml] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<"idle" | "loading" | "error">("idle");
  const [liveErr, setLiveErr] = useState("");
  const [genState, setGenState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  // A synthetic "preview" row (no id) for a type with no stored events — live-renders the
  // latest design for the rooftop's most-recent matching customer, then Send-to-customer/Ignore.
  const synthetic = (): EventEmailRow => ({ id: "", email_type: entry?.type ?? "", status: "preview", subject: null, recipients: null, sent_at: null, created_at: new Date().toISOString(), opened_at: null, reason: null, rendered_html: null, event_key: "", message_id: null });
  useEffect(() => {
    if (!entry) { setRows(null); setPreview(null); return; }
    setRows(null); setPreview(null); setSendMsg(""); setGenState("idle");
    void loadEventEmails(entry.rooftop.team_id ?? "", entry.rooftop.department ?? "", entry.type, 500, entry.direction).then((rs) => {
      setRows(rs);
      if (!rs.length) setPreview(synthetic()); // empty type → jump straight to a live preview
    });
  }, [entry]);
  // When opening a row: show stored if we have it, else jump straight to the live design.
  useEffect(() => {
    setLiveHtml(null); setLiveState("idle"); setLiveErr("");
    setMode(preview && preview.rendered_html ? "stored" : "live");
  }, [preview]);
  const fetchLive = useCallback(async () => {
    if (!entry || !preview) return;
    setLiveState("loading"); setLiveErr("");
    try {
      const res = await fetch("/api/email/roi-event-preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId: entry.rooftop.team_id, enterpriseId: entry.rooftop.enterprise_id, department: entry.rooftop.department,
          emailType: entry.type, eventKey: preview.event_key, rooftopName: entry.rooftop.name, tz: entry.rooftop.timezone,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !(j as { ok?: boolean }).ok) { setLiveState("error"); setLiveErr((j as { error?: string }).error || `Preview failed (${res.status})`); return; }
      setLiveHtml((j as { html?: string }).html ?? ""); setLiveState("idle");
    } catch (e) { setLiveState("error"); setLiveErr(e instanceof Error ? e.message : String(e)); }
  }, [entry, preview]);
  useEffect(() => { if (mode === "live" && liveHtml === null && liveState === "idle") void fetchLive(); }, [mode, liveHtml, liveState, fetchLive]);
  if (!entry) return null;
  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }); } catch { return iso; } };
  const recipientsOf = (r: EventEmailRow) => (r.recipients ?? []).map((x) => x.email).join(", ");
  const openTab = (html: string) => { const w = window.open("", "_blank"); if (w) { w.document.open(); w.document.write(html); w.document.close(); } };
  const sendNow = async (r: EventEmailRow) => {
    if (!r.rendered_html) return;
    if (!window.confirm(`Send this ${entry.label} email now to its recipient(s)?\n\nThis sends a REAL email via the mail proxy.`)) return;
    setSending(true); setSendMsg("");
    try {
      const res = await fetch("/api/email/roi-event-send-now", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setSendMsg(`✓ Sent to ${(j.to ?? []).join(", ") || "recipients"}`);
        setPreview({ ...r, status: "sent" });
        setRows((prev) => (prev ? prev.map((x) => (x.id === r.id ? { ...x, status: "sent" } : x)) : prev));
      } else {
        setSendMsg(j.error ? `Send failed — ${j.error}` : `Send failed (${res.status})`);
      }
    } catch (e) {
      setSendMsg(`Send failed — ${e instanceof Error ? e.message : String(e)}`);
    }
    setSending(false);
  };
  // Render the latest design live + send it to the rooftop's recipients (synthetic preview path).
  const generateSend = async () => {
    if (!entry) return;
    if (!window.confirm(`Send this ${entry.label} email to ${entry.rooftop.name}'s recipients?\n\nRenders the latest design from live data and sends a REAL email via the mail proxy.`)) return;
    setGenState("sending"); setSendMsg("");
    const r = await generateSendEventNow({
      teamId: entry.rooftop.team_id, enterpriseId: entry.rooftop.enterprise_id, department: entry.rooftop.department,
      emailType: entry.type, eventKey: preview?.event_key ?? "", rooftopName: entry.rooftop.name, tz: entry.rooftop.timezone,
    });
    if (r.ok) { setGenState("sent"); setSendMsg(`✓ Sent to ${(r.to ?? []).join(", ") || "recipients"}`); }
    else { setGenState("error"); setSendMsg(`Send failed — ${r.error ?? ""}`); }
  };
  const tone = (s: string) =>
    s === "sent" ? "bg-positive/10 text-positive"
    : s === "suppressed" ? "bg-warning-soft text-warning"
    : s === "error" || s === "not_sent" ? "bg-negative-soft text-negative"
    : "bg-surface-subtle text-text-muted";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-[680px] max-w-[96vw] flex-col bg-surface-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* header — shows a Back button when previewing a single email */}
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {preview ? (
              <button type="button" onClick={() => { if (rows && rows.length) setPreview(null); else onClose(); }} className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-subtle">← Back</button>
            ) : null}
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-text-primary">{entry.rooftop.name} · {entry.label}</div>
              <div className="text-[11px] text-text-muted">
                {preview ? (preview.id ? `${fmt(preview.created_at)} · ${recipientsOf(preview) || "—"}` : "Live preview · decide to send or ignore") : rows === null ? "Loading…" : `${rows.length} email${rows.length === 1 ? "" : "s"} · ${entry.rooftop.department}`}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-text-muted hover:text-text-primary">✕</button>
        </div>

        {preview ? (
          /* ── single email preview — stored (sent bytes) or live (latest design) ── */
          (() => {
            const isSynth = !preview.id; // no stored row → live-only "generate & send" preview
            const shownHtml = mode === "live" ? (liveHtml ?? "") : (preview.rendered_html ?? "");
            const seg = (m: "stored" | "live", lbl: string, disabled?: boolean) => (
              <button type="button" disabled={disabled} onClick={() => setMode(m)}
                className={`px-2.5 py-1 text-[11px] font-semibold ${mode === m ? "bg-brand-primary text-white" : "bg-surface-card text-text-secondary hover:bg-surface-subtle"} disabled:opacity-40`}>{lbl}</button>
            );
            return (
          <div className="flex flex-1 flex-col overflow-hidden bg-surface-subtle">
            <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-card px-5 py-2 text-[11px] text-text-muted">
              <span className="flex min-w-0 items-center gap-2">
                {isSynth ? (
                  <span className="rounded-md bg-brand-primary/10 px-2 py-1 text-[10px] font-bold text-brand-primary">LIVE PREVIEW · not sent</span>
                ) : (
                  <span className="inline-flex overflow-hidden rounded-md border border-border-subtle">
                    {seg("stored", "Stored", !preview.rendered_html)}
                    {seg("live", "Latest design")}
                  </span>
                )}
                <span className="min-w-0 truncate">{preview.subject || entry.label}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {mode === "live" && liveState !== "loading" ? <button type="button" onClick={() => { setLiveHtml(null); setLiveState("idle"); }} className="font-semibold text-brand-primary hover:underline">↻ Refresh</button> : null}
                {isSynth ? (
                  <>
                    <button type="button" onClick={() => void generateSend()} disabled={genState === "sending" || liveState === "loading" || !shownHtml} className="font-semibold text-brand-primary hover:underline disabled:opacity-50">{genState === "sending" ? "Sending…" : genState === "sent" ? "✓ Sent" : "Send to customer ▸"}</button>
                    <button type="button" onClick={onClose} className="font-semibold text-text-secondary hover:underline">Ignore</button>
                  </>
                ) : preview.rendered_html ? (
                  <button type="button" onClick={() => void sendNow(preview)} disabled={sending} className="font-semibold text-brand-primary hover:underline disabled:opacity-50">{sending ? "Sending…" : "Send now ▸"}</button>
                ) : null}
                {shownHtml ? <button type="button" onClick={() => openTab(shownHtml)} className="font-semibold text-brand-primary hover:underline">Open in new tab ↗</button> : null}
              </span>
            </div>
            {sendMsg ? <div className={`border-b border-border-subtle px-5 py-1.5 text-[11px] ${sendMsg.startsWith("✓") ? "bg-positive/10 text-positive" : "bg-negative-soft text-negative"}`}>{sendMsg}</div> : null}
            {mode === "live" && liveState === "loading" ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-text-muted"><span className="h-4 w-4 animate-spin rounded-full border-2 border-border-subtle border-t-brand-primary" /> Rendering latest design from live data…</div>
            ) : mode === "live" && liveState === "error" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-[13px] text-negative">Couldn’t render live preview — {liveErr}<button type="button" onClick={() => { setLiveHtml(null); setLiveState("idle"); }} className="rounded-md border border-border-subtle px-2 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-subtle">Retry</button></div>
            ) : shownHtml ? (
              <iframe title="email preview" sandbox="" srcDoc={shownHtml} className="h-full w-full flex-1 border-0 bg-white" />
            ) : (
              <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-text-muted">
                {mode === "live" ? "No live data found for this customer to render." : `No stored copy for this email${preview.status === "suppressed" ? " (suppressed before send)." : "."}`}
              </div>
            )}
          </div>
            );
          })()
        ) : (
          /* ── list of all emails — click a row to view it ── */
          <div className="flex-1 overflow-auto">
            {rows === null ? (
              <div className="py-12 text-center text-[13px] text-text-muted">Loading…</div>
            ) : rows.length === 0 ? (
              <div className="py-12 text-center text-[13px] text-text-muted">No emails of this type yet.</div>
            ) : (
              rows.map((r) => (
                <button
                  key={r.id || r.event_key}
                  type="button"
                  onClick={() => setPreview(r)}
                  className="flex w-full items-center justify-between gap-3 border-b border-border-subtle px-5 py-2.5 text-left hover:bg-surface-subtle"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-text-primary">{r.subject || entry.label}</div>
                    <div className="mt-0.5 text-[11px] text-text-muted">
                      {fmt(r.created_at)}{recipientsOf(r) ? " · " + recipientsOf(r) : ""}{r.reason ? " · " + r.reason : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone(r.status)}`}>{r.status}</span>
                    <span className="text-[12px] text-text-muted">View →</span>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* Per-rooftop email configuration — toggle which of the 7 email types this rooftop receives.
 * Writes roi_rooftop_config directly (anon UPDATE granted; RLS off on this project). */
function ConfigDrawer({ rooftop, onClose, onSaved }: { rooftop: RooftopRow | null; onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<RooftopConfig | null>(null);
  const [busy, setBusy] = useState<EmailTypeKey | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { setCfg(rooftop?.config ?? null); setErr(""); }, [rooftop]);
  if (!rooftop || !cfg) return null;

  const toggle = async (key: EmailTypeKey) => {
    const next = !cfg[key];
    setCfg({ ...cfg, [key]: next }); // optimistic
    setBusy(key); setErr("");
    const res = await updateRooftopConfig(rooftop.team_id ?? "", { [key]: next });
    setBusy(null);
    if (!res.ok) { setCfg({ ...cfg, [key]: !next }); setErr(res.error || "Save failed"); return; }
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-[380px] overflow-auto bg-surface-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <div className="text-[14px] font-semibold text-text-primary">{rooftop.name}</div>
            <div className="text-[11px] text-text-muted">Email configuration · {rooftop.csm}</div>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">✕</button>
        </div>
        <div className="px-5 py-4">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-text-muted">Emails this rooftop receives</div>
          {EMAIL_TYPES.map(({ key, label }) => (
            <label key={key} className="flex items-center justify-between border-b border-border-subtle py-2.5 cursor-pointer">
              <span className="text-[13px] text-text-primary">{label}</span>
              <button
                type="button"
                role="switch"
                aria-checked={cfg[key]}
                disabled={busy === key}
                onClick={() => void toggle(key)}
                className={`relative h-5 w-9 rounded-full transition-colors ${cfg[key] ? "bg-brand-primary" : "bg-border-subtle"} ${busy === key ? "opacity-60" : ""}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${cfg[key] ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </label>
          ))}
          {err ? <div className="mt-3 text-[12px] text-[#DC2626]">{err}</div> : null}
          <div className="mt-4 text-[11px] leading-relaxed text-text-muted">
            Changes save immediately and gate the cron (digests + transactional sends). Daily/weekly/monthly also need a send-hour; transactional types fire on the poll.
          </div>
        </div>
      </div>
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
    <div className="rounded-lg border border-border-subtle bg-surface-card px-3 py-1.5 min-w-[84px]">
      <div className={`text-[19px] font-extrabold tabular leading-none ${c}`}>{value}</div>
      <div className="mt-1 text-[9px] font-semibold uppercase tracking-widest text-text-muted">{label}</div>
    </div>
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
      // Empty cell — no digest generated. Clicking generates a live preview in the
      // drawer, then offers Send-to-customer or Ignore.
      return (
        <button
          type="button"
          onClick={onOpen}
          title={`No ${cell.cadence} digest yet · click to generate a preview, then send or ignore`}
          className="group inline-flex w-full items-center justify-center rounded-md border border-dashed border-border-subtle bg-surface-subtle px-2 py-1 text-[11px] text-text-muted hover:border-brand-primary hover:bg-brand-primary/10 hover:text-brand-primary"
        >
          <span className="group-hover:hidden">—</span>
          <span className="hidden group-hover:inline">✦ Generate</span>
        </button>
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
      className={`border-b-2 border-border-subtle bg-surface-subtle px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-text-secondary ${
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
