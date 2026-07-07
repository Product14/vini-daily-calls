import { Fragment, useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import {
  NOT_SENT_REASON_CTA,
  NOT_SENT_REASON_LABEL,
  computeSummary,
  reasonBreakdown,
  EMAIL_TYPES,
  TRANSACTIONAL_TYPES,
  SUBSCRIPTION_TYPES,
  isSubscribed,
  type Cadence,
  type DeptKind,
  type NotSentReason,
  type RooftopRow,
  type RooftopConfig,
  type EmailTypeKey,
  type SubType,
  type SendCell,
} from "./mockData";
import { loadRooftops, updateRooftopConfig, loadEventCounts, loadEventEmails, loadTeamRecipients, type EventCounts, type EventEmailRow, type TeamRecipient } from "./dataSource";
import { supabase } from "./supabaseClient";
import { RooftopCellDrawer } from "./RooftopCellDrawer";
import { isPipelineConfigured, runPreviewPipeline, runRespectPipeline } from "./pipeline";
import { reportMissingRooftopNow, generateSendEventNow, sendStoredEventNow, addRecipientNow, toggleRecipientNow, setRecipientPhoneNow, setRecipientRoleNow, setRecipientSubscriptionNow, verifyRecipientNow } from "./sendDigest";

export function EmailerTracker() {
  const [cadence, setCadence] = useState<Cadence>("daily");
  // Digests (daily/weekly/monthly cadence cells) vs Transactional (per-event email counts).
  const [view, setView] = useState<"digests" | "transactional">("digests");
  const [eventCounts, setEventCounts] = useState<EventCounts>(new Map());
  const [eventList, setEventList] = useState<{ rooftop: RooftopRow; type: string; label: string; direction?: "inbound" | "outbound" | null } | null>(null);
  const [search, setSearch] = useState("");
  const [csmFilter, setCsmFilter] = useState<Set<string>>(new Set()); // empty = all CSMs
  // Agent-product filter — Sales/Service × Inbound/Outbound. Digests are stored per dept, so
  // IB/OB map onto their dept's rows (they share one digest); the picker still reads as products.
  const [productFilter, setProductFilter] = useState<"all" | "sales_ib" | "sales_ob" | "service_ib" | "service_ob">("all");
  const [reasonFilter, setReasonFilter] = useState<NotSentReason | "all">("all");
  const [groupBy, setGroupBy] = useState<"rooftop" | "csm">("rooftop");
  const [sentNow, setSentNow] = useState<Record<string, true>>({});
  const [activeCell, setActiveCell] = useState<{ rooftop: RooftopRow; cell: SendCell } | null>(null);
  const [configRooftop, setConfigRooftop] = useState<RooftopRow | null>(null);
  // History anchor = the right-most column date. null → live (latest run / yesterday). Set to jump to
  // any past date; the window shows that date and the (colCount-1) days/weeks/months before it.
  const [anchor, setAnchor] = useState<string | null>(null);
  // Which KPI chip's analytics modal is open (null = closed).
  const [analyticsMetric, setAnalyticsMetric] = useState<AnalyticsMetric | null>(null);

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
      const [res, counts] = await Promise.all([loadRooftops({ anchor: anchor ?? undefined }), loadEventCounts()]);
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
  }, [anchor]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // PREVIEW ALL (Spyne-only): a REAL send across all rooftops, but cron4 filters
  // every recipient list down to @spyne.ai addresses — no customer is emailed.
  // Subject is prefixed "[PREVIEW]". Needs a mail token, like a live send.
  const runSpynePreviewAll = useCallback(async () => {
    const pw = window.prompt(
      "Send a PREVIEW now?\n\nThis really emails — but ONLY the internal reviewers " +
      "devansh.hasija@spyne.ai and subhav.malhotra@spyne.ai, across all rooftops. " +
      "No customer (and no other address) receives anything. Subject is prefixed “[PREVIEW]”.\n\n" +
      "Type the send password to confirm:",
    );
    if (pw == null) return; // cancelled
    if (!pw.trim()) {
      setPreviewState("error");
      setPreviewMsg("Preview cancelled — the send password is required.");
      setTimeout(() => setPreviewState("idle"), 5000);
      return;
    }
    setPreviewState("running");
    setPreviewMsg("");
    const r = await runPreviewPipeline({ sendOverride: pw.trim() }); // no team → all rooftops; cron4 keeps @spyne.ai only
    if (r.simulated) {
      setPreviewState("done");
      setPreviewMsg("Simulated — no backend configured.");
    } else if (r.overrideRequired) {
      setPreviewState("error");
      setPreviewMsg("Wrong send password — nothing was sent.");
    } else if (r.authFailed || r.status === 401 || r.status === 403) {
      setPreviewState("error");
      setPreviewMsg("Mail token rejected/expired. Open a rooftop’s “Send now” to paste a fresh token, then retry.");
    } else if (r.status === 404) {
      setPreviewState("error");
      setPreviewMsg("Functions not deployed yet.");
    } else if (r.ok) {
      setPreviewState("done");
      setPreviewMsg(`Preview sent to reviewers only · ${r.counts?.preview ?? 0} previewed (dealer not sent, not counted) · ${r.counts?.skipped ?? 0} skipped (no recipients) · ${r.counts?.errors ?? 0} errors.`);
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
    // Manual bulk live send requires a typed password (anti-churn / deliberate-send
    // guard). It's forwarded to cron4 as x-send-override and must match the override
    // password; the scheduled cron is exempt (it carries no FE mail token).
    const pw = window.prompt(
      `⚠ Send REAL emails now to ${liveCount} live rooftop(s)?\n\nThis emails real customers via mail.spyne.ai (dry-run rooftops are skipped). This is not a preview.\n\nType the send password to confirm:`,
    );
    if (pw == null) return; // cancelled
    if (!pw.trim()) {
      setLiveState("error");
      setLiveMsg("Send cancelled — the send password is required.");
      setTimeout(() => setLiveState("idle"), 5000);
      return;
    }
    setLiveState("running");
    setLiveMsg("");
    const r = await runRespectPipeline({ sendOverride: pw.trim() }); // no team → all rooftops; honours each dry_run flag
    if (r.simulated) {
      setLiveState("done");
      setLiveMsg("Simulated — no backend configured. Nothing sent.");
    } else if (r.overrideRequired) {
      setLiveState("error");
      setLiveMsg("Wrong send password — nothing was sent.");
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

  // History window navigation. `today` is the effective right-most date (= anchor when set, else the
  // live anchor). Stepping moves the window by a full page (colCount) of the current cadence; stepping
  // forward past the live anchor snaps back to live (anchor=null).
  const isoToday = new Date().toISOString().slice(0, 10);
  const stepAnchor = (dir: -1 | 1) => {
    const base = anchor ?? today;
    if (!base) return;
    const [y, m, d] = base.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const n = colCount * dir;
    if (cadence === "daily") dt.setUTCDate(dt.getUTCDate() + n);
    else if (cadence === "weekly") dt.setUTCDate(dt.getUTCDate() + n * 7);
    else dt.setUTCMonth(dt.getUTCMonth() + n);
    const next = dt.toISOString().slice(0, 10);
    setAnchor(dir === 1 && next >= isoToday ? null : next);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const prodDept = productFilter === "all" ? null : productFilter.startsWith("sales") ? "sales" : "service";
    return rooftops.filter((r) => {
      // Match rooftop name, CSM, team_id, enterprise_id, or the enterprise group label — so a whole
      // dealer group is findable by its enterprise_id even when its rooftops share no name token
      // (e.g. "Corn Husker Nissan" / "Corn Hukser Auto Center" / "Courtesy Ford" under one enterprise).
      if (
        q &&
        !r.name.toLowerCase().includes(q) &&
        !r.csm.toLowerCase().includes(q) &&
        !(r.team_id ?? "").toLowerCase().includes(q) &&
        !(r.enterprise_id ?? "").toLowerCase().includes(q) &&
        !(r.group ?? "").toLowerCase().includes(q)
      )
        return false;
      if (csmFilter.size && !csmFilter.has(r.csm)) return false;
      if (prodDept && r.department !== prodDept) return false;
      if (reasonFilter !== "all" && r.current_block !== reasonFilter) return false;
      return true;
    });
  }, [rooftops, search, csmFilter, productFilter, reasonFilter]);

  // Per-column tallies shown above each date: sent / not-sent / not-eligible.
  // not-eligible = not_subscribed OR scheduled — neither is a send failure: not_subscribed has
  // no run that day, and scheduled is a pending/future run that hasn't come due. Only genuine
  // misses (not_sent, suppressed) count as not-sent.
  const colStats = useMemo(() => {
    const arr = Array.from({ length: colCount }, () => ({ sent: 0, notSent: 0, notEligible: 0 }));
    for (const r of filtered) {
      const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
      for (let i = 0; i < colCount; i++) {
        const st = cells[i]?.status;
        if (!st) continue;
        if (st === "sent") arr[i].sent++;
        else if (st === "not_subscribed" || st === "scheduled") arr[i].notEligible++;
        else arr[i].notSent++;
      }
    }
    return arr;
  }, [filtered, cadence, colCount]);

  // Per-column history for the analytics modal: sent / not-sent / opened + the rooftop lists behind
  // each, over the currently-loaded window (move the date window to see older history). Newest first.
  const trend = useMemo<TrendPoint[]>(() => {
    const cellsOf = (r: RooftopRow) => (cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly);
    const isOpened = (c: SendCell) => (c.runs ?? []).some((run) => run.openedAt || (run.openCount ?? 0) > 0 || (run.recipients ?? []).some((x) => x.opened));
    return Array.from({ length: colCount }, (_, i) => {
      const sent: RooftopRow[] = [], notSent: RooftopRow[] = [], opened: RooftopRow[] = [];
      let date = "";
      for (const r of filtered) {
        const c = cellsOf(r)[i];
        if (!c) continue;
        date = c.date;
        if (c.status === "sent") { sent.push(r); if (isOpened(c)) opened.push(r); }
        else if (c.status === "not_subscribed" || c.status === "scheduled") { /* not eligible */ }
        else notSent.push(r);
      }
      const eligible = sent.length + notSent.length;
      return {
        date,
        label: formatColLabel(cadence, i, today),
        sent, notSent, opened, eligible,
        sentRate: eligible ? Math.round((sent.length / eligible) * 100) : 0,
        openRate: sent.length ? Math.round((opened.length / sent.length) * 100) : 0,
      };
    });
  }, [filtered, cadence, colCount, today]);

  // Group-by-CSM clusters a CSM's rooftops together (CSM → rooftop → dept rows). Rooftop
  // grouping (the default) keeps a rooftop's two dept rows adjacent.
  const ordered = useMemo(() => {
    if (groupBy !== "csm") return filtered;
    return [...filtered].sort((a, b) =>
      (a.csm || "").localeCompare(b.csm || "") ||
      a.name.localeCompare(b.name) ||
      (a.department ?? "").localeCompare(b.department ?? ""));
  }, [filtered, groupBy]);

  // Digest-drawer navigation: step the open cell to the prev/next rooftop (same date) or
  // older/newer date (same rooftop). Cells are anchored to `today` (index 0 = today, higher = older),
  // so "newer" = lower index. Date stepping is capped at the visible column count for that cadence.
  const cellNav = useMemo(() => {
    if (!activeCell) return null;
    const cad = activeCell.cell.cadence as Cadence;
    const getCells = (r: RooftopRow) => (cad === "daily" ? r.daily : cad === "weekly" ? r.weekly : r.monthly);
    const visibleCols = cad === "daily" ? 10 : cad === "weekly" ? 8 : 6;
    const oi = ordered.findIndex((r) => r.rooftop_id === activeCell.rooftop.rooftop_id);
    const cells = getCells(activeCell.rooftop);
    const ci = cells.findIndex((c) => c.date === activeCell.cell.date);
    const maxCi = Math.min(cells.length, visibleCols) - 1;
    const toRooftop = (delta: number) => {
      const ni = oi + delta;
      if (oi < 0 || ni < 0 || ni >= ordered.length) return null;
      const r = ordered[ni];
      const cs = getCells(r);
      const c = cs.find((x) => x.date === activeCell.cell.date) ?? cs[0];
      return c ? () => setActiveCell({ rooftop: r, cell: c }) : null;
    };
    const toDate = (delta: number) => {
      const ni = ci + delta;
      if (ci < 0 || ni < 0 || ni > maxCi) return null;
      return () => setActiveCell({ rooftop: activeCell.rooftop, cell: cells[ni] });
    };
    return {
      prevRooftop: toRooftop(-1),
      nextRooftop: toRooftop(1),
      olderDate: toDate(1),   // ← back in time
      newerDate: toDate(-1),  // → toward today
      rooftopPos: oi >= 0 ? { idx: oi + 1, total: ordered.length } : null,
    };
  }, [activeCell, ordered]);

  // Summary reflects the CURRENT filter set (so filtering to one CSM updates the count + %).
  const summary = useMemo(() => computeSummary(filtered, cadence), [filtered, cadence]);
  // Per-transactional-type KPIs (sent rate + open rate), aggregated over the filtered rooftops.
  // The digest `summary` above is cadence/digest-only, so the KPI strip in the Transactional view
  // reads from here instead. `eligible` = real events that qualified (CH total when available);
  // `sent` = emails actually generated; `opened` = sent emails whose pixel fired (from the view).
  const txTypeStats = useMemo(() => TRANSACTIONAL_TYPES.map((t) => {
    let eligible = 0, sent = 0, opened = 0;
    for (const r of filtered) {
      const ec = eventCounts.get(`${r.team_id}::${r.department}`)?.[t.key];
      if (!ec) continue;
      eligible += prodDir ? (ec.byDir?.[prodDir] ?? 0) : (ec.total ?? 0);
      sent += ec.sent ?? 0;
      opened += ec.opened ?? 0;
    }
    return {
      key: t.key, label: t.label, eligible, sent, opened,
      sentRate: eligible ? Math.round((sent / eligible) * 100) : 0,
      openRate: sent ? Math.round((opened / sent) * 100) : 0,
    };
  }), [filtered, eventCounts, prodDir]);
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
              title="Fire cron1→4 for every rooftop as a REAL send, but cron4 sends only to the reviewers devansh.hasija@spyne.ai + subhav.malhotra@spyne.ai — no customer is emailed. Subject prefixed “[PREVIEW]”. Needs a mail token."
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
            placeholder="Search rooftop, CSM, team / enterprise id…"
            className="w-[240px] rounded-md border border-border-subtle bg-surface-card px-3 py-1.5 text-[12px] placeholder:text-text-muted focus:border-brand-primary focus:outline-none"
          />
          <MultiSelect allLabel="All CSMs" options={csms} selected={csmFilter} onChange={setCsmFilter} />
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
          {view === "digests" ? (
            <div className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-1 py-0.5" title="Jump the date window to any past date. ◀ / ▶ page by a full window; pick a date to jump; Live returns to the latest.">
              <button type="button" onClick={() => stepAnchor(-1)} className="px-1.5 text-[13px] font-bold text-text-secondary hover:text-brand-primary" aria-label="Older window">◀</button>
              <input
                type="date"
                value={anchor ?? today ?? ""}
                max={isoToday}
                onChange={(e) => setAnchor(e.target.value && e.target.value < isoToday ? e.target.value : null)}
                className="w-[128px] bg-transparent text-[12px] text-text-primary focus:outline-none"
              />
              <button type="button" onClick={() => stepAnchor(1)} disabled={!anchor} className={`px-1.5 text-[13px] font-bold ${anchor ? "text-text-secondary hover:text-brand-primary" : "text-border-subtle"}`} aria-label="Newer window">▶</button>
              {anchor ? (
                <button type="button" onClick={() => setAnchor(null)} className="ml-0.5 rounded bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-primary hover:bg-brand-primary/20">Live</button>
              ) : (
                <span className="ml-0.5 rounded bg-positive/10 px-1.5 py-0.5 text-[10px] font-semibold text-positive">Live</span>
              )}
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
              setCsmFilter(new Set());
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
          {view === "transactional" ? (
            /* Per-type sent rate + open rate — one card per transactional email type. */
            txTypeStats.map((s) => <TxTypeStat key={s.key} s={s} />)
          ) : (
            <>
              <Stat label="Sent today" value={summary.emailStatus.sent} tone="positive" onClick={() => setAnalyticsMetric("sent")} />
              <Stat label="Not sent" value={summary.emailStatus.notSent} tone="negative" onClick={() => setAnalyticsMetric("notSent")} />
              <Stat
                label="Sent rate"
                value={`${summary.emailStatus.sentRatePct}%`}
                sub={`${summary.emailStatus.sent} of ${summary.emailStatus.sent + summary.emailStatus.notSent} eligible`}
                tone={summary.emailStatus.sentRatePct >= 50 ? "positive" : "negative"}
                onClick={() => setAnalyticsMetric("sentRate")}
              />
              <Stat
                label="Rooftops opened"
                value={`${summary.emailStatus.openRatePct}%`}
                sub={`${summary.emailStatus.opened} of ${summary.emailStatus.sent} sent`}
                tone={summary.emailStatus.openRatePct >= 40 ? "positive" : summary.emailStatus.opened > 0 ? "neutral" : undefined}
                onClick={() => setAnalyticsMetric("openRate")}
              />
            </>
          )}
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
              <Th minW={104}>Status</Th>
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
                    <DryRunToggle rooftop={r} onChanged={() => void reload()} />
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
        nav={cellNav}
        onClose={() => setActiveCell(null)}
        onSend={(rid, date, cad) =>
          setSentNow((p) => ({ ...p, [`${rid}::${cad}::${date}`]: true }))
        }
        onReload={() => void reload()}
      />

      <ConfigDrawer rooftop={configRooftop} onClose={() => setConfigRooftop(null)} onSaved={() => void reload()} />

      <EventListDrawer entry={eventList} onClose={() => setEventList(null)} />

      {analyticsMetric ? (
        <AnalyticsModal metric={analyticsMetric} trend={trend} cadence={cadence} onClose={() => setAnalyticsMetric(null)} />
      ) : null}
    </div>
  );
}

/* Drill-down list of the individual transactional emails behind a count
 * (e.g. all 100 post-conversation emails sent to a rooftop). */
const EVENT_PAGE_SIZE = 50; // rows fetched per page in the drill-down list

function EventListDrawer({ entry, onClose }: { entry: { rooftop: RooftopRow; type: string; label: string; direction?: "inbound" | "outbound" | null } | null; onClose: () => void }) {
  const [rows, setRows] = useState<EventEmailRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
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
  const synthetic = (): EventEmailRow => ({ id: "", email_type: entry?.type ?? "", status: "preview", subject: null, recipients: null, sent_at: null, created_at: new Date().toISOString(), opened_at: null, open_count: 0, reason: null, rendered_html: null, event_key: "", message_id: null });
  useEffect(() => {
    if (!entry) { setRows(null); setPreview(null); setHasMore(false); return; }
    setRows(null); setPreview(null); setSendMsg(""); setGenState("idle"); setHasMore(false);
    void loadEventEmails(entry.rooftop.team_id ?? "", entry.rooftop.department ?? "", entry.type, { limit: EVENT_PAGE_SIZE, offset: 0, direction: entry.direction }).then((page) => {
      setRows(page.rows); setHasMore(page.hasMore);
      // NOTE: an empty list no longer auto-opens a synthetic preview — the drill-down is a record
      // of real sends only. Generating a preview is an explicit action (empty-state button below).
    });
  }, [entry]);
  const loadMore = useCallback(async () => {
    if (!entry || loadingMore) return;
    setLoadingMore(true);
    try {
      const offset = rows?.length ?? 0;
      const page = await loadEventEmails(entry.rooftop.team_id ?? "", entry.rooftop.department ?? "", entry.type, { limit: EVENT_PAGE_SIZE, offset, direction: entry.direction });
      setRows((prev) => [...(prev ?? []), ...page.rows]);
      setHasMore(page.hasMore);
    } finally { setLoadingMore(false); }
  }, [entry, rows, loadingMore]);
  // ── prev/next navigation through the list while previewing a single email ──
  const rowKey = (r: EventEmailRow) => r.id || r.event_key;
  const previewIdx = useMemo(() => {
    if (!preview || !rows) return -1;
    const k = rowKey(preview);
    return rows.findIndex((x) => rowKey(x) === k);
  }, [preview, rows]);
  // When the user hits Next at the last loaded row (more pages exist), load the next
  // page first, then advance once the new rows land.
  const [pendingNext, setPendingNext] = useState(false);
  useEffect(() => {
    if (pendingNext && rows && previewIdx >= 0 && previewIdx + 1 < rows.length) {
      setPreview(rows[previewIdx + 1]);
      setPendingNext(false);
    }
  }, [pendingNext, rows, previewIdx]);
  const go = useCallback((delta: number) => {
    if (previewIdx < 0 || !rows) return;
    const next = previewIdx + delta;
    if (next < 0) return;
    if (next >= rows.length) {
      if (delta > 0 && hasMore && !loadingMore) { setPendingNext(true); void loadMore(); }
      return;
    }
    setPreview(rows[next]);
  }, [previewIdx, rows, hasMore, loadingMore, loadMore]);
  // Keyboard: ← / → step between emails, Esc returns to the list (or closes from the list).
  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (preview && rows && rows.length) setPreview(null); else onClose(); }
      else if (preview && e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (preview && e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, preview, rows, go, onClose]);
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
  // Time-only (day comes from the section header) for the per-row line.
  const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }); } catch { return iso; } };
  // The timestamp a row is filed under: when it was sent, else when the row was created.
  const rowTime = (r: EventEmailRow) => r.sent_at || r.created_at;
  // Local-day key + human label ("Today" / "Yesterday" / "Mon, Jul 6") for day grouping.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  };
  // Group the loaded rows into consecutive same-day buckets (rows are already newest-first).
  const dayGroups = (() => {
    const out: { key: string; label: string; iso: string; rows: EventEmailRow[] }[] = [];
    for (const r of rows ?? []) {
      const iso = rowTime(r);
      const k = dayKey(iso);
      const last = out[out.length - 1];
      if (last && last.key === k) last.rows.push(r);
      else out.push({ key: k, label: dayLabel(iso), iso, rows: [r] });
    }
    return out;
  })();
  const recipientsOf = (r: EventEmailRow) => (r.recipients ?? []).map((x) => x.email).join(", ");
  // Who actually opened (recipients flagged by the tracking pixel).
  const openedRecips = (r: EventEmailRow) => (r.recipients ?? []).filter((x) => x.opened).map((x) => x.email);
  const openTitle = (r: EventEmailRow) =>
    !r.opened_at ? "" :
    `First opened ${fmt(r.opened_at)}` +
    (r.open_count ? ` · ${r.open_count} view${r.open_count === 1 ? "" : "s"}` : "") +
    (openedRecips(r).length ? ` · ${openedRecips(r).join(", ")}` : "");
  const openTab = (html: string) => { const w = window.open("", "_blank"); if (w) { w.document.open(); w.document.write(html); w.document.close(); } };
  const sendNow = async (r: EventEmailRow) => {
    if (!r.rendered_html) return;
    if (!window.confirm(`Send this ${entry.label} email now to its recipient(s)?\n\nThis sends a REAL email via the mail proxy.`)) return;
    setSending(true); setSendMsg("");
    try {
      // Anti-churn gated: if the email shows no value the client prompts for the override password.
      const res = await sendStoredEventNow({ id: r.id });
      if (res.ok) {
        setSendMsg(`✓ Sent to ${(res.to ?? []).join(", ") || "recipients"}`);
        setPreview({ ...r, status: "sent" });
        setRows((prev) => (prev ? prev.map((x) => (x.id === r.id ? { ...x, status: "sent" } : x)) : prev));
      } else {
        setSendMsg(res.error ? `Send failed — ${res.error}` : "Send failed");
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

  // Portal to <body> + a high z-index so the drawer overlays the host shell's sidebar
  // (a transformed/overflow ancestor was trapping the `fixed` overlay below it).
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-[680px] max-w-[96vw] flex-col bg-surface-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* header — Back returns to the list; ‹ › step between emails while previewing */}
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {preview ? (
              <button type="button" onClick={() => { if (rows && rows.length) setPreview(null); else onClose(); }} title="Back to list (Esc)" className="shrink-0 rounded-md border border-border-subtle px-2 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-subtle">← Back</button>
            ) : null}
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-text-primary">{entry.rooftop.name} · {entry.label}</div>
              <div className="text-[11px] text-text-muted">
                {preview ? (preview.id ? `${fmt(preview.created_at)} · ${recipientsOf(preview) || "—"}` : "Live preview · decide to send or ignore") : rows === null ? "Loading…" : `${rows.length}${hasMore ? "+" : ""} email${rows.length === 1 ? "" : "s"} · ${entry.rooftop.department}`}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {preview && previewIdx >= 0 && rows && rows.length > 1 ? (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => go(-1)}
                  disabled={previewIdx <= 0}
                  title="Previous email (←)"
                  className="rounded-md border border-border-subtle px-2 py-1 text-[13px] leading-none text-text-secondary hover:bg-surface-subtle disabled:opacity-30 disabled:hover:bg-transparent"
                >‹</button>
                <span className="min-w-[44px] text-center text-[11px] font-semibold tabular text-text-muted">
                  {previewIdx + 1} / {rows.length}{hasMore ? "+" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => go(1)}
                  disabled={previewIdx >= rows.length - 1 && !hasMore}
                  title="Next email (→)"
                  className="rounded-md border border-border-subtle px-2 py-1 text-[13px] leading-none text-text-secondary hover:bg-surface-subtle disabled:opacity-30 disabled:hover:bg-transparent"
                >{pendingNext ? "…" : "›"}</button>
              </div>
            ) : null}
            <button type="button" onClick={onClose} title="Close" className="text-text-muted hover:text-text-primary">✕</button>
          </div>
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
            {!isSynth && preview.status === "sent" ? (
              <div className="border-b border-border-subtle px-5 py-1.5 text-[11px]">
                {preview.opened_at ? (
                  <span className="font-semibold text-positive">
                    👁 Opened · {preview.open_count || 1} view{(preview.open_count || 1) === 1 ? "" : "s"} · first {fmt(preview.opened_at)}
                    {openedRecips(preview).length ? <span className="font-normal text-text-muted"> · by {openedRecips(preview).join(", ")}</span> : null}
                  </span>
                ) : (
                  <span className="text-text-muted">Sent · not opened yet</span>
                )}
              </div>
            ) : null}
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
          /* ── real emails only, grouped by day (click a row to view it) ── */
          <div className="flex-1 overflow-auto">
            {rows === null ? (
              <div className="py-12 text-center text-[13px] text-text-muted">Loading…</div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-8 py-14 text-center">
                <div className="text-[13px] font-medium text-text-primary">No {entry.label} emails sent yet</div>
                <div className="max-w-[320px] text-[12px] text-text-muted">This rooftop hasn’t had a real {entry.label.toLowerCase()} email go out. You can render the latest design from live data and decide whether to send it.</div>
                <button type="button" onClick={() => setPreview(synthetic())} className="rounded-md bg-brand-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90">✦ Generate a preview</button>
              </div>
            ) : (
              <>
                {dayGroups.map((g) => (
                  <div key={g.key}>
                    {/* sticky day header — "what got sent, what day" */}
                    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle bg-surface-subtle/95 px-5 py-1.5 backdrop-blur">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-text-secondary">{g.label}</span>
                      <span className="text-[10px] font-semibold tabular text-text-muted">{g.rows.length} email{g.rows.length === 1 ? "" : "s"}</span>
                    </div>
                    {g.rows.map((r) => (
                      <button
                        key={r.id || r.event_key}
                        type="button"
                        onClick={() => setPreview(r)}
                        className="flex w-full items-center justify-between gap-3 border-b border-border-subtle px-5 py-2.5 text-left hover:bg-surface-subtle"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-text-primary">{r.subject || entry.label}</div>
                          <div className="mt-0.5 text-[11px] text-text-muted">
                            {fmtTime(rowTime(r))}{recipientsOf(r) ? " · " + recipientsOf(r) : ""}{r.reason ? " · " + r.reason : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {r.opened_at ? (
                            <span title={openTitle(r)} className="rounded-full bg-positive/10 px-2 py-0.5 text-[10px] font-semibold text-positive">
                              👁 Opened{r.open_count && r.open_count > 1 ? ` · ${r.open_count} views` : ""}
                            </span>
                          ) : r.status === "sent" ? (
                            <span title="Sent — no open detected yet" className="rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] font-semibold text-text-muted">Not opened</span>
                          ) : null}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone(r.status)}`}>{r.status}</span>
                          <span className="text-[12px] text-text-muted">View →</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
                {hasMore ? (
                  <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="flex w-full items-center justify-center gap-2 px-5 py-3 text-[12px] font-semibold text-brand-primary hover:bg-surface-subtle disabled:opacity-50">
                    {loadingMore ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border-subtle border-t-brand-primary" /> Loading…</> : `Load ${EVENT_PAGE_SIZE} more ↓`}
                  </button>
                ) : (
                  <div className="px-5 py-3 text-center text-[11px] text-text-muted">End of list</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* Per-rooftop email configuration — toggle which of the 7 email types this rooftop receives.
 * Writes roi_rooftop_config directly (anon UPDATE granted; RLS off on this project). */
function ConfigDrawer({ rooftop, onClose, onSaved }: { rooftop: RooftopRow | null; onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<RooftopConfig | null>(null);
  const [busy, setBusy] = useState<EmailTypeKey | null>(null);
  const [tplBusy, setTplBusy] = useState(false);
  const [focusBusy, setFocusBusy] = useState(false);
  const [err, setErr] = useState("");
  // ALL recipients of this rooftop's team (both departments) — view, enable/disable, add. Each
  // RooftopRow only carries its own dept, so fetch the full team set to manage Sales + Service together.
  const [teamRecips, setTeamRecips] = useState<TeamRecipient[]>([]);
  const [recipBusy, setRecipBusy] = useState<string | null>(null);
  // Rooftop-level SMS master switch (roi_rooftop_config.sms_enabled) — SMS only sends when ON.
  const [smsMaster, setSmsMaster] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const reloadRecips = useCallback(async () => {
    if (!rooftop?.team_id) { setTeamRecips([]); return; }
    setTeamRecips(await loadTeamRecipients(rooftop.team_id));
  }, [rooftop?.team_id]);
  useEffect(() => {
    setCfg(rooftop?.config ?? null);
    setSmsMaster(rooftop?.smsEnabled === true);
    setErr("");
    void reloadRecips();
  }, [rooftop, reloadRecips]);
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

  // Daily-digest template selector — which email this rooftop's DAILY digest sends:
  // 'v2' = New (redesign, the default since the Jul 2026 go-live), 'v1' = Classic
  // (legacy, opt-out). Applies to both the Sales and Service daily digests;
  // weekly/monthly always use the new one.
  const prev = cfg.daily_template ?? "v2";
  const setTemplate = async (next: "v1" | "v2") => {
    if (next === prev || tplBusy) return;
    setCfg({ ...cfg, daily_template: next }); // optimistic
    setTplBusy(true); setErr("");
    const res = await updateRooftopConfig(rooftop.team_id ?? "", { daily_template: next });
    setTplBusy(false);
    if (!res.ok) { setCfg({ ...cfg, daily_template: prev }); setErr(res.error || "Save failed"); return; }
    onSaved();
  };

  // Email FOCUS (the appointment/conversation checker) — what every digest LEADS with for this rooftop.
  // Stable, rooftop-level, spans daily/weekly/monthly. 'auto' → conversation today (Phase 2: feature-flag derived).
  const prevFocus = cfg.digest_focus ?? "auto";
  const setFocus = async (next: "auto" | "conversation" | "appointment") => {
    if (next === prevFocus || focusBusy) return;
    setCfg({ ...cfg, digest_focus: next }); // optimistic
    setFocusBusy(true); setErr("");
    const res = await updateRooftopConfig(rooftop.team_id ?? "", { digest_focus: next });
    setFocusBusy(false);
    if (!res.ok) { setCfg({ ...cfg, digest_focus: prevFocus }); setErr(res.error || "Save failed"); return; }
    onSaved();
  };

  // Enable/disable a recipient (email_enabled — GLOBAL per recipient, spans both depts). Optimistic.
  const toggleRecip = async (email: string, next: boolean) => {
    setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, email_enabled: next } : r)));
    setRecipBusy(email); setErr("");
    const res = await toggleRecipientNow({ teamId: rooftop.team_id, email, enabled: next });
    setRecipBusy(null);
    if (!res.ok) { setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, email_enabled: !next } : r))); setErr(res.error || "Save failed"); return; }
    onSaved();
  };
  // Verify (or un-verify) a recipient for this rooftop. Unverified recipients are HELD — never emailed —
  // so a wrong-rooftop address can't leak another rooftop's data. Optimistic.
  const verifyRecip = async (email: string, next: boolean) => {
    if (next && !window.confirm(`Confirm ${email} belongs to ${rooftop.name} and should receive its emails?\n\nOnly verify people you know are at THIS rooftop — this is the guard against sending one store's data to another.`)) return;
    const stamp = next ? new Date().toISOString() : null;
    const prevVals = teamRecips.filter((r) => r.email === email).map((r) => r.verified_at);
    setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, verified_at: stamp } : r)));
    setRecipBusy(email); setErr("");
    const res = await verifyRecipientNow({ teamId: rooftop.team_id, email, verified: next });
    setRecipBusy(null);
    if (!res.ok) { setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, verified_at: prevVals[0] ?? null } : r))); setErr(res.error || "Save failed"); return; }
    onSaved();
  };
  // Rooftop SMS master switch.
  const toggleSmsMaster = async () => {
    if (!rooftop?.team_id || smsBusy) return;
    const next = !smsMaster;
    setSmsMaster(next); setSmsBusy(true); setErr("");
    const res = await updateRooftopConfig(rooftop.team_id, { sms_enabled: next });
    setSmsBusy(false);
    if (!res.ok) { setSmsMaster(!next); setErr(res.error || "Save failed"); return; }
    onSaved();
  };
  // Toggle a recipient's sms_enabled (channel:'sms'). Optimistic.
  const toggleRecipSms = async (email: string, next: boolean) => {
    setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, sms_enabled: next } : r)));
    setRecipBusy(email); setErr("");
    const res = await toggleRecipientNow({ teamId: rooftop?.team_id, email, enabled: next, channel: "sms" });
    setRecipBusy(null);
    if (!res.ok) { setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, sms_enabled: !next } : r))); setErr(res.error || "Save failed"); return; }
    onSaved();
  };
  // Save/clear a recipient's phone. Optimistic; reverts on failure.
  const saveRecipPhone = async (email: string, d: DeptKind, phone: string): Promise<{ ok: boolean; error?: string }> => {
    const prevPhone = teamRecips.find((r) => r.email === email)?.phone ?? null;
    setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, phone } : r)));
    const res = await setRecipientPhoneNow({ teamId: rooftop?.team_id, dept: d, email, phone });
    if (!res.ok) { setTeamRecips((prev) => prev.map((r) => (r.email === email ? { ...r, phone: prevPhone } : r))); setErr(res.error || "Save failed"); }
    else onSaved();
    return res;
  };
  // Set a recipient's role (salesperson|bdc|gm|null) — role-tiered transactional fallback. Optimistic.
  const setRole = async (email: string, d: DeptKind, role: "salesperson" | "bdc" | "gm" | null) => {
    const prev = teamRecips.find((r) => r.email === email)?.role ?? null;
    setTeamRecips((p) => p.map((r) => (r.email === email ? { ...r, role } : r)));
    setRecipBusy(email); setErr("");
    const res = await setRecipientRoleNow({ teamId: rooftop?.team_id, dept: d, email, role });
    setRecipBusy(null);
    if (!res.ok) { setTeamRecips((p) => p.map((r) => (r.email === email ? { ...r, role: prev } : r))); setErr(res.error || "Save failed"); return; }
    onSaved();
  };
  // Toggle one subscription cell (type × channel). Optimistic merge into the recipient's map.
  const setSub = async (email: string, type: string, channel: "email" | "sms", enabled: boolean) => {
    const before = teamRecips.find((r) => r.email === email)?.subscriptions ?? null;
    setTeamRecips((p) => p.map((r) => (r.email === email
      ? { ...r, subscriptions: { ...(r.subscriptions || {}), [type]: { ...((r.subscriptions || {})[type as keyof typeof r.subscriptions] || {}), [channel]: enabled } } }
      : r)));
    setErr("");
    const res = await setRecipientSubscriptionNow({ teamId: rooftop?.team_id, email, type, channel, enabled });
    if (!res.ok) { setTeamRecips((p) => p.map((r) => (r.email === email ? { ...r, subscriptions: before } : r))); setErr(res.error || "Save failed"); }
    else onSaved();
  };
  const salesRecips = teamRecips.filter((r) => r.receives_sales);
  const serviceRecips = teamRecips.filter((r) => r.receives_service);

  // Portal + high z-index so this overlays the host shell's sidebar (see EventListDrawer).
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-[380px] overflow-auto bg-surface-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <div className="text-[14px] font-semibold text-text-primary">{rooftop.name}</div>
            <div className="text-[11px] text-text-muted">Email configuration · {rooftop.csm}</div>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">✕</button>
        </div>
        <div className="px-5 py-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-muted">Daily digest template</div>
          <div className="mb-1 inline-flex w-full rounded-lg border border-border-subtle p-0.5">
            {([
              { v: "v1", label: "Classic", sub: "Current email" },
              { v: "v2", label: "New", sub: "Redesign" },
            ] as const).map(({ v, label, sub }) => {
              const active = prev === v;
              return (
                <button
                  key={v}
                  type="button"
                  disabled={tplBusy}
                  aria-pressed={active}
                  onClick={() => void setTemplate(v)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-center transition-colors ${active ? "bg-brand-primary text-white" : "text-text-primary hover:bg-surface-subtle"} ${tplBusy ? "opacity-60" : ""}`}
                >
                  <div className="text-[13px] font-semibold leading-tight">{label}</div>
                  <div className={`text-[10px] leading-tight ${active ? "text-white/80" : "text-text-muted"}`}>{sub}</div>
                </button>
              );
            })}
          </div>
          <div className="mb-4 text-[11px] leading-relaxed text-text-muted">Applies to this rooftop's Sales &amp; Service daily digests. Weekly/monthly always use the new template.</div>

          <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-muted">Email focus</div>
          <div className="mb-1 inline-flex w-full rounded-lg border border-border-subtle p-0.5">
            {([
              { v: "auto", label: "Auto", sub: prevFocus === "auto" ? "→ Conversation" : "Resolver" },
              { v: "conversation", label: "Conversation", sub: "Calls-led" },
              { v: "appointment", label: "Appointment", sub: "Appts-led" },
            ] as const).map(({ v, label, sub }) => {
              const active = prevFocus === v;
              return (
                <button
                  key={v}
                  type="button"
                  disabled={focusBusy}
                  aria-pressed={active}
                  onClick={() => void setFocus(v)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-center transition-colors ${active ? "bg-brand-primary text-white" : "text-text-primary hover:bg-surface-subtle"} ${focusBusy ? "opacity-60" : ""}`}
                >
                  <div className="text-[12px] font-semibold leading-tight">{label}</div>
                  <div className={`text-[10px] leading-tight ${active ? "text-white/80" : "text-text-muted"}`}>{sub}</div>
                </button>
              );
            })}
          </div>
          <div className="mb-4 text-[11px] leading-relaxed text-text-muted">What every digest <span className="font-semibold text-text-primary">leads</span> with. <span className="font-semibold text-text-primary">Conversation</span> (the ~90%) leads with conversations handled and demotes appointments; <span className="font-semibold text-text-primary">Appointment</span> leads with bookings. Stable across daily/weekly/monthly.</div>

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
          {/* SMS channel master switch — texts appointment + action-item alerts to recipients with a phone + SMS on. */}
          <label className="flex items-center justify-between border-b border-border-subtle py-2.5 cursor-pointer">
            <span className="text-[13px] text-text-primary">SMS notifications <span className="text-[10px] text-text-muted">· texts appointment & action-item alerts</span></span>
            <button
              type="button"
              role="switch"
              aria-checked={smsMaster}
              disabled={smsBusy}
              onClick={() => void toggleSmsMaster()}
              className={`relative h-5 w-9 rounded-full transition-colors ${smsMaster ? "bg-brand-primary" : "bg-border-subtle"} ${smsBusy ? "opacity-60" : ""}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${smsMaster ? "left-[18px]" : "left-0.5"}`} />
            </button>
          </label>
          {err ? <div className="mt-3 text-[12px] text-[#DC2626]">{err}</div> : null}
          <div className="mt-4 text-[11px] leading-relaxed text-text-muted">
            Changes save immediately and gate the cron (digests + transactional sends). Daily/weekly/monthly also need a send-hour; transactional types fire on the poll.
          </div>

          {/* Sales AND Service recipient lists, side by side — different people can receive each. */}
          {([
            { dept: "sales" as DeptKind, label: "Sales", list: salesRecips },
            { dept: "service" as DeptKind, label: "Service", list: serviceRecips },
          ]).map(({ dept: d, label, list }) => (
            <div key={d}>
              <div className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-widest text-text-muted">
                Recipients · {label}
              </div>
              {list.length === 0 ? (
                <p className="mb-2 text-[12px] text-warning">No {label.toLowerCase()} recipients yet — add at least one below, then turn it on.</p>
              ) : (
                <ul className="mb-2">
                  {list.map((r) => (
                    <li key={r.email} className="border-b border-border-subtle py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          {r.name ? <div className="truncate text-[13px] text-text-primary">{r.name}</div> : null}
                          <div className="truncate text-[12px] text-text-muted">{r.email}</div>
                          {r.receives_sales && r.receives_service ? (
                            <div className="text-[10px] text-text-muted">Also on {d === "sales" ? "Service" : "Sales"} list</div>
                          ) : null}
                          {!r.verified_at ? (
                            <div className="mt-0.5 text-[10px] font-semibold text-amber-600">⚠ Unverified — held, not emailed until verified</div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {/* Verification gate — an unverified recipient is never emailed (cross-rooftop guard). */}
                          {r.verified_at ? (
                            <button
                              type="button"
                              disabled={recipBusy === r.email}
                              onClick={() => void verifyRecip(r.email, false)}
                              title={`Verified for ${rooftop.name} — click to un-verify (holds all their emails)`}
                              className="shrink-0 rounded-md border border-emerald-300 px-1.5 py-1 text-[10px] font-semibold text-emerald-600 hover:bg-emerald-50"
                            >✓ Verified</button>
                          ) : (
                            <button
                              type="button"
                              disabled={recipBusy === r.email}
                              onClick={() => void verifyRecip(r.email, true)}
                              title="Confirm this person belongs to this rooftop, then they can receive emails"
                              className="shrink-0 rounded-md border border-amber-400 bg-amber-50 px-1.5 py-1 text-[10px] font-semibold text-amber-700 hover:bg-amber-100"
                            >Verify</button>
                          )}
                          {/* Role — drives the salesperson → BDC → GM fallback for transactional alerts. */}
                          <select
                            value={r.role ?? ""}
                            disabled={recipBusy === r.email}
                            onChange={(e) => void setRole(r.email, d, (e.target.value || null) as "salesperson" | "bdc" | "gm" | null)}
                            title="Role for transactional routing (salesperson → BDC → GM fallback)"
                            className="rounded-md border border-border-subtle bg-surface-background px-1.5 py-1 text-[10px] text-text-secondary focus:border-brand-primary focus:outline-none"
                          >
                            <option value="">No role</option>
                            <option value="salesperson">Salesperson</option>
                            <option value="bdc">BDC</option>
                            <option value="gm">GM</option>
                          </select>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={r.email_enabled}
                            disabled={recipBusy === r.email}
                            onClick={() => void toggleRecip(r.email, !r.email_enabled)}
                            title={r.email_enabled ? "Receiving — click to pause (pauses ALL emails to this person)" : "Paused — click to start receiving"}
                            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${r.email_enabled ? "bg-brand-primary" : "bg-border-subtle"} ${recipBusy === r.email ? "opacity-60" : ""}`}
                          >
                            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${r.email_enabled ? "left-[18px]" : "left-0.5"}`} />
                          </button>
                        </div>
                      </div>
                      {smsMaster ? (
                        <RecipientSmsControls
                          recip={r}
                          busy={recipBusy === r.email}
                          onSavePhone={(phone) => saveRecipPhone(r.email, d, phone)}
                          onToggleSms={(next) => void toggleRecipSms(r.email, next)}
                        />
                      ) : null}
                      {/* Per-type subscription matrix (email + optional SMS) — collapsible. */}
                      <RecipientSubscriptions
                        recip={r}
                        smsMaster={smsMaster}
                        disabled={recipBusy === r.email}
                        onSetSub={(type, channel, enabled) => void setSub(r.email, type, channel, enabled)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <AddRecipientRow teamId={rooftop.team_id} dept={d} onAdded={() => { onSaved(); void reloadRecips(); }} />
            </div>
          ))}
          <div className="mt-3 text-[11px] leading-relaxed text-text-muted">
            Sales and Service lists are independent — add different people to each. The On/Off toggle is the
            per-person email master (pauses ALL of their emails). Expand <span className="font-semibold text-text-primary">Notifications</span> to pick
            which of the 7 types each person gets on email and SMS. <span className="font-semibold text-text-primary">Role</span> drives
            transactional routing: alerts go to the Salesperson, falling back to BDC then GM when none is set. New recipients are added paused.
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* Per-recipient subscription matrix — collapsible "Notifications" grid: 7 types × Email/SMS.
 * Collapsed shows a summary (Email 7/7 · SMS 2/7). Effective value = explicit cell or default.
 * SMS column is shown only when the rooftop SMS master switch is on. */
function RecipientSubscriptions({ recip, smsMaster, disabled, onSetSub }: {
  recip: TeamRecipient;
  smsMaster: boolean;
  disabled: boolean;
  onSetSub: (type: SubType, channel: "email" | "sms", enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const subs = recip.subscriptions;
  const emailOn = SUBSCRIPTION_TYPES.filter((t) => isSubscribed(subs, t.key, "email")).length;
  const smsOn = SUBSCRIPTION_TYPES.filter((t) => isSubscribed(subs, t.key, "sms")).length;
  const n = SUBSCRIPTION_TYPES.length;
  const Toggle = ({ on, onClick, title }: { on: boolean; onClick: () => void; title: string }) => (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onClick} title={title}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-brand-primary" : "bg-border-subtle"} ${disabled ? "opacity-60" : ""}`}>
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? "left-[14px]" : "left-0.5"}`} />
    </button>
  );
  return (
    <div className="mt-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-md px-1 py-1 text-[10px] text-text-muted hover:bg-surface-subtle">
        <span className="font-semibold uppercase tracking-wide">Notifications</span>
        <span>{open ? "▲" : "▼"} Email {emailOn}/{n}{smsMaster ? ` · SMS ${smsOn}/${n}` : ""}</span>
      </button>
      {open ? (
        <div className="mt-1 rounded-md border border-border-subtle p-1.5">
          <div className={`grid ${smsMaster ? "grid-cols-[1fr_auto_auto]" : "grid-cols-[1fr_auto]"} items-center gap-x-3 gap-y-1.5`}>
            <span className="text-[9px] font-semibold uppercase tracking-wide text-text-muted"> </span>
            <span className="justify-self-center text-[9px] font-semibold uppercase tracking-wide text-text-muted">Email</span>
            {smsMaster ? <span className="justify-self-center text-[9px] font-semibold uppercase tracking-wide text-text-muted">SMS</span> : null}
            {SUBSCRIPTION_TYPES.map((t) => (
              <Fragment key={t.key}>
                <span className="text-[11px] text-text-primary">{t.label}</span>
                <span className="justify-self-center"><Toggle on={isSubscribed(subs, t.key, "email")} onClick={() => onSetSub(t.key, "email", !isSubscribed(subs, t.key, "email"))} title={`${t.label} · email`} /></span>
                {smsMaster ? (
                  <span className="justify-self-center"><Toggle on={isSubscribed(subs, t.key, "sms")} onClick={() => onSetSub(t.key, "sms", !isSubscribed(subs, t.key, "sms"))} title={recip.phone ? `${t.label} · SMS` : "Add a phone first"} /></span>
                ) : null}
              </Fragment>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* Add a recipient (name + email) to roi_recipients for this rooftop+department.
 * Added paused (email_enabled=false) — the user flips the On toggle to start sending. */
/* SMS sub-row for a recipient: phone editor (saves on blur/Enter) + an SMS On/Off toggle.
 * Shown only when the rooftop SMS master switch is on. Enabling SMS requires a saved phone. */
function RecipientSmsControls({ recip, busy, onSavePhone, onToggleSms }: {
  recip: TeamRecipient;
  busy: boolean;
  onSavePhone: (phone: string) => Promise<{ ok: boolean; error?: string }>;
  onToggleSms: (next: boolean) => void;
}) {
  const [phone, setPhone] = useState(recip.phone ?? "");
  const [pState, setPState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const smsOn = recip.sms_enabled === true;
  const hasPhone = !!(recip.phone && recip.phone.trim());
  const phoneValid = /\+?[\d][\d\s().-]{6,}/.test(phone.trim());
  const save = async () => {
    const p = phone.trim();
    if (p === (recip.phone ?? "")) return; // unchanged
    if (p && !phoneValid) { setPState("error"); return; }
    setPState("saving");
    const r = await onSavePhone(p);
    setPState(r.ok ? "saved" : "error");
    if (r.ok) setTimeout(() => setPState("idle"), 1500);
  };
  return (
    <div className="mt-1.5 flex items-center gap-2 pl-0.5">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-muted">SMS</span>
      <input
        type="tel"
        value={phone}
        onChange={(e) => { setPhone(e.target.value); if (pState === "error") setPState("idle"); }}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        onBlur={() => void save()}
        placeholder="+1 555 123 4567"
        className={`min-w-0 flex-1 rounded-md border bg-surface-background px-2 py-1 text-[12px] placeholder:text-text-muted focus:outline-none ${pState === "error" ? "border-[#DC2626]" : "border-border-subtle focus:border-brand-primary"}`}
      />
      <span className="w-8 shrink-0 text-right text-[10px] text-text-muted">{pState === "saving" ? "…" : pState === "saved" ? "✓" : pState === "error" ? "bad" : ""}</span>
      <button
        type="button"
        role="switch"
        aria-checked={smsOn}
        disabled={busy || !hasPhone}
        onClick={() => (hasPhone ? onToggleSms(!smsOn) : setPState("error"))}
        title={!hasPhone ? "Add a phone first" : smsOn ? "SMS on — click to pause" : "SMS off — click to enable"}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${smsOn ? "bg-brand-primary" : "bg-border-subtle"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${smsOn ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}

function AddRecipientRow({ teamId, dept, onAdded }: { teamId?: string; dept: DeptKind; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const submit = async () => {
    if (!/\S+@\S+\.\S+/.test(email.trim())) { setState("error"); setMsg("Enter a valid email."); return; }
    setState("saving"); setMsg("");
    const r = await addRecipientNow({ teamId, dept, email: email.trim(), name: name.trim() || undefined, emailEnabled: false });
    if (r.ok) { setState("done"); setMsg("Added (paused) — flip the On toggle to start sending."); setName(""); setEmail(""); onAdded(); setTimeout(() => setState("idle"), 1800); }
    else { setState("error"); setMsg(r.error || "Add failed"); }
  };
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          className="min-w-0 w-28 rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (state === "error") setState("idle"); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          placeholder="name@dealer.com"
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={state === "saving"}
          className="flex-shrink-0 rounded-md bg-brand-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-primary-hover disabled:opacity-60"
        >
          {state === "saving" ? "Adding…" : state === "done" ? "Added ✓" : "+ Add"}
        </button>
      </div>
      {msg ? <p className={`mt-1 text-[10px] ${state === "error" ? "text-negative" : "text-text-muted"}`}>{msg}</p> : null}
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
  sub,
  title,
  onClick,
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "positive" | "negative";
  /** Small clarifying line under the label (e.g. the rate's denominator). */
  sub?: string;
  /** Hover tooltip — extra precision without crowding the strip. */
  title?: string;
  /** When set, the chip is a button that opens the analytics modal. */
  onClick?: () => void;
}) {
  const c = tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-text-primary";
  const clickable = onClick ? "cursor-pointer text-left hover:border-brand-primary hover:shadow-sm" : "";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} title={title ?? (onClick ? "Click for history + breakdown" : undefined)} className={`rounded-lg border border-border-subtle bg-surface-card px-3 py-1.5 min-w-[84px] ${clickable}`}>
      <div className={`text-[19px] font-extrabold tabular leading-none ${c}`}>{value}</div>
      <div className="mt-1 text-[9px] font-semibold uppercase tracking-widest text-text-muted">{label}{onClick ? " ›" : ""}</div>
      {sub ? <div className="mt-0.5 text-[9px] font-medium tabular text-text-muted">{sub}</div> : null}
    </Tag>
  );
}

/* Compact per-transactional-type KPI card — sent rate (sent ÷ eligible) stacked over
   open rate (opened ÷ sent). Used in the KPI strip when the Transactional view is active. */
function TxTypeStat({ s }: { s: { label: string; eligible: number; sent: number; opened: number; sentRate: number; openRate: number } }) {
  const sentTone = s.eligible === 0 ? "text-text-muted" : s.sentRate >= 50 ? "text-positive" : "text-negative";
  const openTone = s.sent === 0 ? "text-text-muted" : s.openRate >= 40 ? "text-positive" : s.opened > 0 ? "text-text-primary" : "text-text-muted";
  return (
    <div
      title={`${s.label}: ${s.sent} of ${s.eligible} eligible sent · ${s.opened} of ${s.sent} sent opened`}
      className="rounded-lg border border-border-subtle bg-surface-card px-3 py-1.5 min-w-[128px]"
    >
      <div className="text-[9px] font-semibold uppercase tracking-widest text-text-secondary">{s.label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">Sent</span>
        <span className={`text-[15px] font-extrabold tabular leading-none ${sentTone}`}>{s.sentRate}%</span>
      </div>
      <div className="text-[9px] font-medium tabular text-text-muted text-right leading-tight">{s.sent} of {s.eligible} eligible</div>
      <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-border-subtle pt-1">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">Opened</span>
        <span className={`text-[15px] font-extrabold tabular leading-none ${openTone}`}>{s.openRate}%</span>
      </div>
      <div className="text-[9px] font-medium tabular text-text-muted text-right leading-tight">{s.opened} of {s.sent} sent</div>
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

function DryRunToggle({ rooftop, onChanged }: { rooftop: RooftopRow; onChanged?: () => void }) {
  const [on, setOn] = useState<boolean>(rooftop.dryRun !== false); // on = dry-run held (Live | Paused | Not started)
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // "Has this rooftop ever sent a real digest?" — distinguishes Paused from Not started while held.
  // A currently-live rooftop counts as having gone live; only an explicit "not_started" baseline is never-sent.
  const everSent = rooftop.liveStatus !== "not_started";
  // Current status derives from the live `on` flag (held?) + that baseline, so the badge updates on toggle.
  const status: NonNullable<RooftopRow["liveStatus"]> = !on ? "live" : everSent ? "paused" : "not_started";
  const STATUS = {
    live:        { label: "Live",        dot: "bg-positive", cls: "bg-positive/10 text-positive",  tip: "Live — the scheduled cron sends real emails. Click to hold." },
    paused:      { label: "Paused",      dot: "bg-warning",  cls: "bg-warning-soft text-warning",   tip: "Paused — was live, emails are held. Click to resume sending." },
    not_started: { label: "Not started", dot: "bg-text-muted", cls: "bg-surface-subtle text-text-muted", tip: "Not started — never sent a real digest. Click to go live." },
  }[status];

  const persist = async (nextDry: boolean): Promise<boolean> => {
    setBusy(true);
    if (supabase && rooftop.team_id && rooftop.department) {
      const { error } = await supabase
        .from("roi_live_departments").update({ dry_run: nextDry })
        .eq("team_id", rooftop.team_id).eq("department", rooftop.department);
      if (error) { setBusy(false); return false; }
    }
    setOn(nextDry); setBusy(false);
    // Optimistic local update done — now reload the parent so liveCount / "Send live (N)" /
    // each row's liveStatus reflect the new dry_run instead of going stale until manual Refresh.
    onChanged?.();
    return true;
  };

  const onClick = () => {
    if (busy || !rooftop.team_id || !rooftop.department) return;
    if (on) setConfirm(true);     // Paused/Not started → LIVE: show disclaimer first
    else void persist(true);      // Live → hold (pause): safe, no prompt
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
        title={STATUS.tip}
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS.cls} ${busy ? "opacity-50" : ""}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS.dot}`} />
        {STATUS.label}
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
    case "error":
      // Send genuinely FAILED (mail gateway / render / unexpected throw). Loud red so it's not mistaken
      // for a deliberate not-sent hold; click opens the drawer with the failure reason + a retry.
      return (
        <button
          type="button"
          onClick={onOpen}
          title={`Send failed${cell.reason ? ` · ${NOT_SENT_REASON_LABEL[cell.reason]}` : ""} · click to view + retry`}
          className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-negative/50 bg-negative text-white px-2 py-1 text-[11px] font-semibold hover:opacity-90"
        >
          ⚠ Failed
        </button>
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

/** KPI chips that open the analytics modal. */
type AnalyticsMetric = "sent" | "notSent" | "sentRate" | "openRate";
type TrendPoint = { date: string; label: string; sent: RooftopRow[]; notSent: RooftopRow[]; opened: RooftopRow[]; eligible: number; sentRate: number; openRate: number };

const METRIC_META: Record<AnalyticsMetric, { title: string; kind: "count" | "rate"; pick: (p: TrendPoint) => number; drill: (p: TrendPoint) => { title: string; rooftops: RooftopRow[] }[] }> = {
  sent: { title: "Sent", kind: "count", pick: (p) => p.sent.length, drill: (p) => [{ title: "Sent", rooftops: p.sent }, { title: "Not sent", rooftops: p.notSent }] },
  notSent: { title: "Not sent", kind: "count", pick: (p) => p.notSent.length, drill: (p) => [{ title: "Not sent", rooftops: p.notSent }, { title: "Sent", rooftops: p.sent }] },
  sentRate: { title: "Sent rate", kind: "rate", pick: (p) => p.sentRate, drill: (p) => [{ title: "Sent", rooftops: p.sent }, { title: "Not sent", rooftops: p.notSent }] },
  openRate: { title: "Open rate", kind: "rate", pick: (p) => p.openRate, drill: (p) => [{ title: "Opened", rooftops: p.opened }, { title: "Sent, not opened", rooftops: p.sent.filter((r) => !p.opened.includes(r)) }] },
};

/** Analytics modal for a KPI chip: a trend of the metric over the loaded window + the drill-down
 * list of rooftops behind the latest (right-most) column. Uses ONLY already-loaded cell data. */
function AnalyticsModal({ metric, trend, cadence, onClose }: { metric: AnalyticsMetric; trend: TrendPoint[]; cadence: Cadence; onClose: () => void }) {
  const meta = METRIC_META[metric];
  // Oldest → newest for the chart (trend is newest-first).
  const series = useMemo(() => [...trend].reverse(), [trend]);
  const maxVal = Math.max(1, ...series.map((p) => meta.pick(p)));
  const latest = trend[0];
  const suffix = meta.kind === "rate" ? "%" : "";
  const drill = latest ? meta.drill(latest) : [];
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className="flex max-h-[85vh] w-[720px] max-w-full flex-col overflow-hidden rounded-xl bg-surface-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <div>
            <div className="text-[14px] font-semibold text-text-primary">{meta.title} · history</div>
            <div className="text-[11px] text-text-muted">Per {cadence === "daily" ? "day" : cadence === "weekly" ? "week" : "month"} over the loaded window · move the date window for older history</div>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">✕</button>
        </div>
        <div className="overflow-auto px-5 py-4">
          {/* Trend bars */}
          <div className="flex items-end gap-2" style={{ height: 160 }}>
            {series.map((p) => {
              const v = meta.pick(p);
              const h = Math.round((v / maxVal) * 130);
              return (
                <div key={p.date || p.label} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${p.label}: ${v}${suffix}`}>
                  <div className="text-[10px] font-bold tabular text-text-secondary">{v}{suffix}</div>
                  <div className="w-full rounded-t bg-brand-primary/70" style={{ height: Math.max(2, h) }} />
                  <div className="mt-0.5 w-full truncate text-center text-[9px] text-text-muted">{p.label}</div>
                </div>
              );
            })}
          </div>
          {/* Drill-down for the latest column */}
          <div className="mt-5 border-t border-border-subtle pt-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-muted">
              {latest ? `Breakdown · ${latest.label}` : "Breakdown"}
            </div>
            <div className="grid grid-cols-2 gap-4">
              {drill.map((col) => (
                <div key={col.title}>
                  <div className="mb-1 text-[12px] font-semibold text-text-primary">{col.title} <span className="text-text-muted">({col.rooftops.length})</span></div>
                  {col.rooftops.length === 0 ? (
                    <div className="text-[11px] text-text-muted">None</div>
                  ) : (
                    <ul className="max-h-[220px] space-y-0.5 overflow-auto">
                      {col.rooftops.map((r) => (
                        <li key={r.rooftop_id} className="truncate text-[12px] text-text-secondary" title={`${r.name} · ${r.department ?? ""}`}>
                          {r.name} <span className="text-text-muted">· {r.department}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Compact multi-select popover (checkbox list). Empty selection = "all". */
function MultiSelect({
  allLabel,
  options,
  selected,
  onChange,
}: {
  allLabel: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = selected.size === 0 ? allLabel : selected.size === 1 ? Array.from(selected)[0] : `${selected.size} selected`;
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md border border-border-subtle bg-surface-card px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-subtle focus:border-brand-primary focus:outline-none"
        title={selected.size ? Array.from(selected).join(", ") : allLabel}
      >
        <span className="max-w-[160px] truncate">{label}</span>
        <span className="text-[9px] text-text-muted">▼</span>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-[61] mt-1 max-h-[300px] w-[240px] overflow-auto rounded-md border border-border-subtle bg-surface-card p-1 shadow-xl">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-subtle ${selected.size === 0 ? "font-semibold text-brand-primary" : "text-text-secondary"}`}
            >
              {allLabel}
            </button>
            {options.map((o) => (
              <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-text-primary hover:bg-surface-subtle">
                <input type="checkbox" checked={selected.has(o)} onChange={() => toggle(o)} className="accent-brand-primary" />
                <span className="truncate">{o}</span>
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
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
