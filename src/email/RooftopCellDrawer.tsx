import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  type DeptKind,
  type DigestMetrics,
  type Recipient,
  type RooftopRow,
  type SendCell,
} from "./mockData";
import { renderDigestEmail } from "./renderDigest";
import { sendDigestNow, generateAndSendNow, generatePreviewNow, renderStoredPreview, addRecipientNow, toggleRecipientNow, setRecipientPhoneNow, updateRooftopConfigNow, addCsmNow } from "./sendDigest";
import { loadDigestRun, loadEligibleRecipients, type DigestRunDetail, type EligibleRecipients } from "./dataSource";
import { periodKeyForColumn, periodLabel } from "./periodBuckets";
import { STATE_META, neutralizeTracking, type CellState } from "./trackerModel.ts";
import { timezoneOptions } from "./timezones.ts";
import { confirmDialog } from "../ui/dialogs";

/**
 * Cell-action drawer.
 *
 * SENT cell:
 *   1. Email snippet · what the dealer received
 *   2. Recipients · per department, who received ✓ / who didn't ✗
 *      - didn't-receive recipient → "Send to them" button
 *      - missing-email recipient → inline "Add email" + send
 *      - department with no recipients → "Add recipient"
 *
 * NOT-SENT cell:
 *   1. Reason · why it didn't go + field-status grid
 *   2. Snippet · numbers added (no real send happened)
 *   3. Fill data & send · reason-aware form
 */
/** Step the open digest to an adjacent rooftop (same date) or date (same rooftop).
 * Each handler is null when there's nowhere to go in that direction. */
export type CellNav = {
  prevRooftop: (() => void) | null;
  nextRooftop: (() => void) | null;
  olderDate: (() => void) | null;
  newerDate: (() => void) | null;
  rooftopPos: { idx: number; total: number } | null;
};

type DrawerProps = {
  rooftop: RooftopRow | null;
  cell: SendCell | null;
  onClose: () => void;
  onSend: (rooftopId: string, date: string, cadence: SendCell["cadence"]) => void;
  /** Reload tracker data after a dry-run pipeline trigger (rows change status). */
  onReload?: () => void;
  /** Prev/next rooftop + date stepping (computed by the parent from the filtered table). */
  nav?: CellNav | null;
};

// States with nothing to send from here: delivered, in flight, not due yet, or deliberately off.
const NO_SEND_STATES = new Set<CellState>(["sent", "in_flight", "scheduled", "not_due", "churned", "paused", "history_only"]);

export function RooftopCellDrawer({ rooftop, cell, onClose, onSend, onReload, nav }: DrawerProps) {
  const open = !!(rooftop && cell);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<"desktop" | "email">("email");
  // Generated weekly/monthly preview HTML (render-only) shown in the left pane before a manual send.
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  // Daily "New / Classic" template preview toggle: null = as-sent/default, else the chosen template.
  const [tplActive, setTplActive] = useState<"v1" | "v2" | null>(null);
  const [tplBusy, setTplBusy] = useState(false);
  const [tplErr, setTplErr] = useState<string | null>(null);
  // Clear any generated/toggled preview when the drawer's target cell changes.
  useEffect(() => { setPreviewHtml(null); setTplActive(null); setTplErr(null); }, [rooftop?.rooftop_id, cell?.date, cell?.cadence]);

  // The DEFAULT (client-side) preview can only render the NEW (v2) design. So for a rooftop whose
  // day actually used/uses the CLASSIC (v1) template, the client fallback would show — and label —
  // the wrong email ("showing old, but it's the new design", and vice-versa). Fix: when the day's
  // stored run used v1 and it isn't a sent row (whose exact bytes we already show), auto server-render
  // the real v1 so the preview body matches what the cron sends. Derives from `cell` to keep hook order.
  useEffect(() => {
    // Gate on `mounted`, not just `open`: on the open transition `open` flips true one render BEFORE
    // `mounted` does, and that render takes the `!mounted` early-return below — so `showTemplate` (a
    // const declared AFTER that return) is still in its temporal dead zone. Calling it here then throws
    // "Cannot access 'showTemplate' before initialization", which — with no error boundary — unmounts
    // the whole app to a blank screen. Waiting for `mounted` guarantees the full render ran first.
    if (!mounted || !open || !rooftop || !cell || cell.cadence !== "daily") return;
    // Preview must equal what the cron SENDS. The client renderer (renderDigestEmail) drifts from the
    // cron on several inputs — campaign images (gated on DIGEST_ASSET_BASE), deep links, content focus,
    // period wording — and can't render Classic (v1) at all (it lives server-side). So server-render the
    // EXACT template the cron will use via renderStoredDigest, for BOTH v1 and v2. The template the cron
    // will send = the rooftop's CURRENT config (pickTemplate reads the same roi_rooftop_config
    // .daily_template → rooftop.config.daily_template): v2 is the default, so only an explicit 'v1'
    // opt-out previews Classic. Sent cells already show exact stored bytes; no-run cells fall back to the client render.
    const cfgTpl = rooftop.config?.daily_template;
    // Mirror pickTemplate exactly: v2 is the default (go-live Jul 2026); only an
    // explicit 'v1' opt-out gets Classic.
    const willSendTpl: "v1" | "v2" = cfgTpl === "v1" ? "v1" : "v2";
    // Only a cell with a stored run has data to render; a missed day has none (Generate & send previews it).
    if (cell.status !== "sent" && (cell.runs ?? []).length) void showTemplate(willSendTpl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, open, rooftop?.rooftop_id, cell?.date, cell?.cadence, cell?.status]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      // Don't hijack arrows while typing in a field.
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); nav?.olderDate?.(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); nav?.newerDate?.(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); nav?.prevRooftop?.(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); nav?.nextRooftop?.(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose, nav]);

  // The grid load no longer carries each run's stored metrics or email HTML (together they were
  // nearly all of that payload), so fetch the opened run's copy here. Keyed by run id so stepping
  // to another cell never shows the previous cell's data.
  const primaryRunId = (() => {
    const rs = cell?.runs ?? [];
    return (rs.find((r) => r.status === cell?.status) ?? rs[0])?.runId;
  })();
  const [runDetail, setRunDetail] = useState<(DigestRunDetail & { runId: string; failed?: boolean }) | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  useEffect(() => {
    if (!open || !primaryRunId) return;
    let alive = true;
    loadDigestRun(primaryRunId)
      .then((d) => { if (alive) setRunDetail({ runId: primaryRunId, ...d }); })
      .catch(() => { if (alive) setRunDetail({ runId: primaryRunId, metrics: null, html: null, failed: true }); });
    return () => { alive = false; };
    // `cell` too: a grid reload (e.g. after a dry-run re-run regenerated this run) hands the drawer a
    // new cell object for the same run id, and the stored copy must follow it.
  }, [open, primaryRunId, cell, detailAttempt]);

  if (!mounted || !rooftop || !cell) return null;

  const status = cell.status;
  const runs = cell.runs ?? [];
  // the run that drives this cell (matching status), else the first run
  const primary = runs.find((r) => r.status === status) ?? runs[0] ?? null;
  const detail = runDetail && primary?.runId && runDetail.runId === primary.runId ? runDetail : null;
  // Loading gates the whole body, not just the email: the send/recipient actions read `metrics`, and
  // without it they would briefly claim "No data for this day".
  const runDetailLoading = !!primary?.runId && !detail && !(primary.metrics && primary.renderedHtml);
  const runDetailFailed = !!detail?.failed;
  const runHtml = primary?.renderedHtml ?? detail?.html ?? undefined;
  const metrics = primary?.metrics ?? detail?.metrics ?? undefined;
  const dept = primary?.department;
  // The stored run's own local_date — the key every read/re-send of that run must use. Same as the
  // cell date for daily; a weekly/monthly cell is a period whose run can be dated anywhere inside it.
  const runDate = primary?.localDate ?? cell.date;
  const rawReason = primary?.reason;
  // What this cell means (trackerModel): every label, colour and action below follows it (C3).
  const state: CellState = cell.state ?? (status === "sent" ? "sent" : "no_run");
  const meta = STATE_META[state];
  const isSent = state === "sent";
  const isSuppressed = state === "held_dry_run" || state === "held";
  const isPeriodic = cell.cadence !== "daily";
  // The cron's key for this cell's period: what Generate & send builds and records (C14).
  const periodKey = cell.periodKey || periodKeyForColumn(cell.cadence, cell.date, rooftop.weeklySendDow ?? 1);
  // Department for the generate/send call: the cell's run dept, else the rooftop's first department.
  const effDept = (dept ?? rooftop.departments?.[0]?.kind) as DeptKind | undefined;
  // The label must match the previewed/sent BODY. SENT cells: the template actually sent (stored on
  // the run's metrics). NOT-yet-sent cells: the template the cron WILL use = current config — using
  // the stored metric here would default to "Classic" on runs that never stamped it while the body
  // renders v2, so label and body disagreed.
  const storedTpl = (metrics as { daily_template?: string } | undefined)?.daily_template;
  const cfgTpl = rooftop.config?.daily_template;
  const effTpl: "v1" | "v2" = isSent
    ? (storedTpl === "v2" ? "v2" : "v1")
    : (cfgTpl === "v1" ? "v1" : "v2");   // not-yet-sent → what the cron WILL send (pickTemplate default v2)
  const effTplName = effTpl === "v2" ? "New" : "Classic";
  const effFocusRaw = (metrics as { digest_focus?: string } | undefined)?.digest_focus;
  const effFocusName = effFocusRaw === "appointment" ? "Appointment-led" : effFocusRaw === "conversation" ? "Conversation-led" : "";

  // Daily template preview toggle: render this day's STORED metrics in v1 (Classic) / v2 (New).
  // null → restore the as-sent / default view. Render-only — never sends.
  const showTemplate = async (tpl: "v1" | "v2" | null) => {
    setTplErr(null);
    setTplActive(tpl);
    if (tpl === null) { setPreviewHtml(null); return; }
    if (!rooftop.team_id || !effDept) { setTplErr("Missing rooftop/department"); setTplActive(null); return; }
    setTplBusy(true);
    const r = await renderStoredPreview({ teamId: rooftop.team_id, dept: effDept, localDate: runDate, cadence: cell.cadence, tpl });
    setTplBusy(false);
    if (r.ok && r.html) setPreviewHtml(r.html);
    else { setTplErr(r.error || "Preview failed"); setTplActive(null); }
  };

  const statusLabel = meta.label;
  const TONE_CHIP: Record<string, string> = {
    positive: "bg-positive/10 text-positive", negative: "bg-negative-soft text-negative", warn: "bg-warning-soft text-warning",
    info: "bg-info-soft text-info", muted: "bg-surface-subtle text-text-muted",
  };
  const statusChip = TONE_CHIP[meta.tone];
  const periodName = cell.cadence === "daily" ? "day" : cell.cadence === "weekly" ? "week" : "month";
  const periodText = cell.cadence === "daily" ? formatHumanDate(periodKey || cell.date) : periodLabel(cell.cadence, cell.date);

  // Portal + high z-index so this overlays the host shell's sidebar instead of opening below it.
  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] flex flex-col bg-surface-background transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${rooftop.name} daily digest`}
    >
      {/* Top bar */}
      <header className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-border-subtle bg-surface-card px-6 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            {cell.cadence} · {cell.cadence === "daily" ? formatHumanDate(cell.date) : periodLabel(cell.cadence, cell.date)}{dept ? ` · ${dept}` : ""}
          </div>
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[16px] font-bold leading-tight text-text-primary">{rooftop.name}</h2>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusChip}`}>
              {statusLabel}
            </span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {nav ? (
            <div className="mr-1 flex items-center gap-3">
              <div className="flex items-center gap-0.5" title="Previous / next rooftop (↑ / ↓)">
                <NavBtn onClick={nav.prevRooftop}>‹</NavBtn>
                <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  Rooftop{nav.rooftopPos ? ` ${nav.rooftopPos.idx}/${nav.rooftopPos.total}` : ""}
                </span>
                <NavBtn onClick={nav.nextRooftop}>›</NavBtn>
              </div>
              <div className="flex items-center gap-0.5" title="Older / newer date (← / →)">
                <NavBtn onClick={nav.olderDate}>‹</NavBtn>
                <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Date</span>
                <NavBtn onClick={nav.newerDate}>›</NavBtn>
              </div>
            </div>
          ) : null}
          <div className="inline-flex overflow-hidden rounded-md border border-border-subtle">
            {(["desktop", "email"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-[11px] font-semibold capitalize ${view === v ? "bg-brand-primary text-white" : "bg-surface-card text-text-secondary hover:bg-surface-subtle"}`}
              >
                {v === "desktop" ? "🖥 Desktop" : "✉ Email"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-subtle bg-surface-card px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-subtle"
          >
            Close ✕
          </button>
        </div>
      </header>

      {/* Reason banner (non-sent): the state's own words, plus the run's detail when there is one. */}
      {!isSent ? (
        <div className={`flex-shrink-0 border-b border-border-subtle px-6 py-2 text-[12px] leading-snug ${statusChip}`}>
          <span className="font-semibold">{meta.label}.</span> {meta.help}
          {cell.detail ? <span className="opacity-80"> {cell.detail}</span> : null}
          {state === "no_run" ? <span className="opacity-80"> No {cell.cadence} digest exists for this {periodName}.</span> : null}
        </div>
      ) : null}

      {/* Body: full email (left) + actions rail (right) */}
      <div className="flex-1 overflow-y-auto">
        {runDetailLoading || runDetailFailed ? (
          <div className="mx-auto max-w-[1180px] px-6 py-6">
            <div className="rounded-xl border border-border-subtle bg-surface-card px-4 py-10 text-center text-[12px] text-text-muted">
              {runDetailLoading ? "Loading this digest…" : (
                <>
                  Couldn’t load this digest.{" "}
                  <button type="button" onClick={() => { setRunDetail(null); setDetailAttempt((n) => n + 1); }} className="font-semibold text-brand-primary hover:underline">
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
        <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                {tplActive
                  ? `${cell.cadence} digest · ${tplActive === "v2" ? "New" : "Classic"} template preview`
                  : isSent
                  ? runDetailLoading
                    ? "Email sent · loading exact HTML…"
                    : runHtml
                    ? `Email sent · ${effTplName} template${effFocusName ? ` · ${effFocusName}` : ""} · exact HTML`
                    : runDetailFailed
                    ? "Email sent · couldn't load the stored HTML"
                    : "Email sent · exact HTML not stored"
                  : previewHtml
                  ? `${cell.cadence} digest · ${effTplName} template${effFocusName ? ` · ${effFocusName}` : ""} preview`
                  : `${cell.cadence} digest · ${effTplName} template${effFocusName ? ` · ${effFocusName}` : ""} preview`}
              </div>
              {/* Daily only: preview this day's data under either template (render-only, no send). */}
              {cell.cadence === "daily" ? (
                <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-border-subtle text-[10px] font-semibold">
                  {([
                    { v: null as "v1" | "v2" | null, label: "As sent" },
                    { v: "v2" as const, label: "New" },
                    { v: "v1" as const, label: "Classic" },
                  ]).map((o) => (
                    <button
                      key={String(o.v)}
                      type="button"
                      disabled={tplBusy}
                      onClick={() => void showTemplate(o.v)}
                      className={`px-2.5 py-1 transition-colors disabled:opacity-50 ${
                        tplActive === o.v ? "bg-accent text-white" : "bg-surface text-text-muted hover:bg-surface-background"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {tplErr ? <div className="mb-2 rounded bg-negative/10 px-2 py-1 text-[11px] text-negative">{tplErr}</div> : null}
            {tplBusy ? <div className="mb-2 text-[11px] text-text-muted">Rendering preview…</div> : null}
            <DigestEmail rooftop={rooftop} cell={cell} metrics={metrics} dept={dept} renderedHtml={previewHtml ?? runHtml} isSent={isSent} view={view} />
          </div>

          <aside className="space-y-4">
            {/* The way to send this period, first: a held daily digest sends its stored copy; any
                other unsent period is built for that period and sent (Retry for a failed day, C15). */}
            {isSent || NO_SEND_STATES.has(state) ? null : isSuppressed && !isPeriodic ? (
              <>
                <Section eyebrow="Held" title="Why it was held back">
                  <SuppressBanner rawReason={rawReason ?? undefined} />
                </Section>
                <Section eyebrow="Send" title="Send this held digest">
                  <SendNowLiveSection
                    rooftop={rooftop}
                    recipients={primary?.recipients}
                    metrics={metrics}
                    dept={dept}
                    reportDate={runDate}
                    onSent={() => { onReload?.(); }}
                  />
                </Section>
              </>
            ) : (
              <Section eyebrow={state === "failed" ? "Retry" : "Send"} title={`${state === "failed" ? "Retry" : "Generate & send"} · ${periodText}`}>
                <GenerateSendSection
                  key={`${rooftop.rooftop_id}::${cell.cadence}::${periodKey}`}
                  rooftop={rooftop}
                  dept={effDept}
                  cadence={cell.cadence}
                  periodKey={periodKey}
                  periodText={periodText}
                  state={state}
                  onPreview={setPreviewHtml}
                  onSent={() => onReload?.()}
                  onIgnore={onClose}
                />
              </Section>
            )}
            {/* The recipient list + chooser + per-recipient (re)send of the stored daily copy. */}
            <Section eyebrow="Recipients" title={isSent ? "Recipients · choose & resend" : "Recipients"}>
              <RecipientManager
                key={`${rooftop.rooftop_id}::${cell.cadence}::${cell.date}`}
                periodic={isPeriodic}
                rooftop={rooftop}
                dept={dept}
                metrics={metrics}
                reportDate={runDate}
                sentRecipients={primary?.recipients}
                isSent={isSent}
                onSend={() => onSend(rooftop.rooftop_id, cell.date, cell.cadence)}
                onReload={onReload}
              />
            </Section>
            <Section eyebrow="Schedule" title="Send time & timezone">
              <ScheduleEditor rooftop={rooftop} onSaved={onReload} />
            </Section>
            <Section eyebrow="CSM" title={rooftop.csm && rooftop.csm !== "Unassigned" ? "Customer Success Manager" : "Assign a CSM"}>
              <CsmSection rooftop={rooftop} onSaved={onReload} />
            </Section>
            {isSent ? (
              <>
                <Section eyebrow="Engagement" title="Opens">
                  {primary?.openedAt ? (
                    <div className="rounded-md bg-positive/10 px-3 py-2 text-[12px] font-semibold text-positive">
                      👁 Opened · {primary.openCount || 1} view{(primary.openCount || 1) === 1 ? "" : "s"}
                      <span className="font-normal text-text-muted"> · first {new Date(primary.openedAt).toLocaleString()}</span>
                    </div>
                  ) : (
                    <div className="rounded-md bg-surface-background px-3 py-2 text-[12px] text-text-muted">Sent · no open detected yet</div>
                  )}
                </Section>
                <Section eyebrow="Sent to" title="Email IDs on this send">
                  <SentToList recipients={primary?.recipients} />
                </Section>
              </>
            ) : null}
          </aside>
        </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ============================================================
   Section wrapper
   ============================================================ */
function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border-subtle px-5 py-4 last:border-0">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">{eyebrow}</div>
      <h3 className="mt-0.5 text-[13px] font-semibold text-text-primary">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/* ============================================================
   Recipient manager (sent view) · per department
   ============================================================ */
const validEmail = (e: string) => e.trim() !== "" && e !== "m" && /\S+@\S+\.\S+/.test(e.trim());

// Zero-data guard — a digest the backend wouldn't send must NEVER be sendable from the UI.
// Matches the engine's guardrail: a day is actionable only when appointments, inbound leads, or
// action items exist (conversations alone = "not_actionable" → never sent). No metrics → not sendable.
const hasSendableData = (m?: DigestMetrics): boolean => {
  if (!m) return false;
  const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  return num(m.appointmentsYesterday) + num(m.inboundUniqueLeads) + num((m as { actionItemsTotal?: number }).actionItemsTotal) > 0;
};

type SendResult = { ok: boolean; error?: string };

// Add a recipient and PERSIST it to roi_recipients (rooftop+dept enabled), then reload the tracker.
// Add a recipient (name + email) and PERSIST it to roi_recipients for this rooftop+dept.
// Per Case 2 it's added DISABLED (email_enabled=false) — the user then flips the On toggle.
function AddRecipientInline({ teamId, dept, onAdded }: { teamId?: string; dept: DeptKind; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const submit = async () => {
    if (!validEmail(email)) { setState("error"); setMsg("Enter a valid email."); return; }
    setState("saving"); setMsg("");
    const r = await addRecipientNow({ teamId, dept, email: email.trim(), name: name.trim() || undefined, emailEnabled: false });
    if (r.ok) { setState("done"); setMsg("Added (disabled) — flip the On toggle to start sending"); setName(""); setEmail(""); onAdded(); setTimeout(() => setState("idle"), 1800); }
    else { setState("error"); setMsg(r.error || "Add failed"); }
  };
  return (
    <div className="mt-1.5">
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

// Exported so ConfigDrawer (EmailerTracker.tsx) can render the same weekly-day picker labels.
export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// #4 — view + edit a rooftop's local send hour:minute + timezone, plus which day the WEEKLY
// digest sends (0=Sun..6=Sat) and which day-of-month the MONTHLY digest sends (1-28). Not every
// customer wants their weekly/monthly summary landing on the same day — these persist to
// roi_rooftop_config.weekly_send_dow / monthly_send_day (default Monday / the 1st, today's
// previously-hardcoded behavior for every rooftop).
function ScheduleEditor({ rooftop, onSaved }: { rooftop: RooftopRow; onSaved?: () => void }) {
  const [hour, setHour] = useState<string>(rooftop.sendHour != null ? String(rooftop.sendHour) : "7");
  const [minute, setMinute] = useState<string>(rooftop.sendMinute != null ? String(rooftop.sendMinute) : "0");
  // The stored zone ("" when none is set: the cron then resolves one itself). It is only sent back
  // when someone picks a different one, so saving a send hour never pins New York on a rooftop that
  // had no zone (A1 F12).
  const storedTz = rooftop.timezone || "";
  const [tz, setTz] = useState<string>(storedTz);
  const tzOptions = useMemo(() => timezoneOptions(), []);
  const [weeklyDow, setWeeklyDow] = useState<string>(String(rooftop.weeklySendDow ?? 1));
  const [monthlyDay, setMonthlyDay] = useState<string>(String(rooftop.monthlySendDay ?? 1));
  const [edit, setEdit] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const pad = (n: string) => String(n).padStart(2, "0");
  const save = async () => {
    const h = Number(hour), m = Number(minute), dow = Number(weeklyDow), day = Number(monthlyDay);
    if (!Number.isInteger(h) || h < 0 || h > 23) { setState("error"); setMsg("Hour must be 0–23"); return; }
    if (!Number.isInteger(m) || m < 0 || m > 59) { setState("error"); setMsg("Minute must be 0–59"); return; }
    setState("saving"); setMsg("");
    const r = await updateRooftopConfigNow({ teamId: rooftop.team_id, sendHour: h, sendMinute: m, ...(tz && tz !== storedTz ? { timezone: tz } : {}), weekly_send_dow: dow, monthly_send_day: day });
    if (r.ok) { setState("done"); setMsg("Saved ✓"); setEdit(false); onSaved?.(); setTimeout(() => setState("idle"), 1500); }
    else { setState("error"); setMsg(r.error || "Save failed"); }
  };
  if (rooftop.unconfigured) {
    return <p className="text-[12px] text-text-muted">This rooftop has no email configuration yet, so its schedule can't be saved. Ask product to set it up.</p>;
  }
  if (!edit) {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] text-text-primary">
          {pad(hour)}:{pad(minute)} <span className="text-text-muted">· {tz || "time zone not set (the cron looks it up)"}</span>
          <div className="text-[10px] text-text-muted">Weekly: {WEEKDAY_LABELS[Number(weeklyDow)]} · Monthly: day {monthlyDay}</div>
        </div>
        <button type="button" onClick={() => setEdit(true)} className="shrink-0 rounded-md border border-border-subtle px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface-subtle">Edit</button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} className="w-14 rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]" />
        <span className="text-text-muted">:</span>
        <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} className="w-14 rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]" />
        <select value={tz} onChange={(e) => setTz(e.target.value)} aria-label="Time zone" className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]">
          {!storedTz ? <option value="">Not set</option> : null}
          {storedTz && !tzOptions.some((o) => o.value === storedTz) ? <option value={storedTz}>{storedTz} (current, not a US or Canadian zone)</option> : null}
          {tzOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="text-[11px] text-text-muted">Weekly digest day</label>
        <select value={weeklyDow} onChange={(e) => setWeeklyDow(e.target.value)} className="rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]">
          {WEEKDAY_LABELS.map((label, i) => <option key={i} value={i}>{label}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="text-[11px] text-text-muted">Monthly digest day</label>
        <select value={monthlyDay} onChange={(e) => setMonthlyDay(e.target.value)} className="rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]">
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => void save()} disabled={state === "saving"} className="rounded-md bg-brand-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-primary-hover disabled:opacity-60">{state === "saving" ? "Saving…" : "Save"}</button>
        <button type="button" onClick={() => setEdit(false)} className="rounded-md border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-subtle">Cancel</button>
        {msg ? <span className={`text-[10px] ${state === "error" ? "text-negative" : "text-text-muted"}`}>{msg}</span> : null}
      </div>
      <p className="text-[10px] text-text-muted">Local send time + day for this rooftop · applies on the next scheduled run. Not all customers want their weekly/monthly summary on the same day.</p>
    </div>
  );
}

// #5 — view CSM, or assign one (name + email BOTH required → enables email for sales + service).
function CsmSection({ rooftop, onSaved }: { rooftop: RooftopRow; onSaved?: () => void }) {
  const assigned = !!rooftop.csm && rooftop.csm !== "Unassigned";
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(assigned ? rooftop.csm : "");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const save = async () => {
    if (!name.trim()) { setState("error"); setMsg("CSM name is required."); return; }
    if (!validEmail(email)) { setState("error"); setMsg("A valid CSM email is required."); return; }
    setState("saving"); setMsg("");
    const r = await addCsmNow({ teamId: rooftop.team_id, name: name.trim(), email: email.trim() });
    if (r.ok) { setState("done"); setMsg("CSM saved. The nightly sync from Metabase replaces it if Metabase names someone else."); setOpen(false); onSaved?.(); setTimeout(() => setState("idle"), 4000); }
    else { setState("error"); setMsg(r.error || "Save failed"); }
  };
  if (assigned && !open) {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-text-primary">{rooftop.csm}{msg ? <div className="text-[10px] font-normal text-text-muted">{msg}</div> : null}</div>
        <button type="button" onClick={() => setOpen(true)} className="shrink-0 rounded-md border border-border-subtle px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface-subtle">Change</button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="CSM name (required)" className="w-full rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]" />
      <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); if (state === "error") setState("idle"); }} placeholder="csm@spyne.ai (required)" className="w-full rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]" />
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => void save()} disabled={state === "saving"} className="rounded-md bg-brand-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-primary-hover disabled:opacity-60">{state === "saving" ? "Saving…" : "Save CSM"}</button>
        {assigned ? <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-subtle">Cancel</button> : null}
        {msg ? <span className={`text-[10px] ${state === "error" ? "text-negative" : "text-text-muted"}`}>{msg}</span> : null}
      </div>
      <p className="text-[10px] text-text-muted">Name and email required. Saving shows this CSM on the rooftop and adds them to the sales and service lists (unverified, so they get nothing until verified). The nightly sync from Metabase is the source of truth: update Metabase too, or it replaces this.</p>
    </div>
  );
}

function RecipientManager({
  rooftop,
  dept,
  metrics,
  reportDate,
  sentRecipients,
  isSent,
  periodic = false,
  onSend,
  onReload,
}: {
  rooftop: RooftopRow;
  dept?: DeptKind;
  metrics?: DigestMetrics;
  reportDate?: string;
  sentRecipients?: { email: string; received?: boolean; bounced?: boolean }[];
  isSent: boolean;
  /** Weekly/monthly cell: this list's sends render the DAILY template, so they stay off. */
  periodic?: boolean;
  onSend: () => void;
  onReload?: () => void;
}) {
  // received overlay from the actual run (who really got it)
  const recvByEmail = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const r of sentRecipients ?? []) map.set(r.email.toLowerCase(), r.received === true && r.bounced !== true);
    return map;
  }, [sentRecipients]);

  // Local editable copy so add-email / send / received reflect immediately.
  // Merge the ACTUAL sent recipients (from the run) into the cell's department so a
  // "Sent" row always lists who got it — even if they aren't in the configured roi_recipients.
  const [depts, setDepts] = useState(() =>
    rooftop.departments.map((d) => {
      // "Received" comes from THIS cell's run only. The department-level r.received is the rooftop's
      // latest run of ANY cadence, so a monthly cell with no run showed every weekly recipient as
      // "✓ Received" (Sport Durst, 2026-10-08) — read as proof a monthly went out that never did.
      const base = (d.allRecipients ?? d.recipients).map((r) => ({ ...r, received: recvByEmail.get(r.email.toLowerCase()) ?? false }));
      if (dept && d.kind === dept) {
        for (const sr of sentRecipients ?? []) {
          if (!base.some((b) => b.email.toLowerCase() === sr.email.toLowerCase())) {
            base.push({ email: sr.email, received: sr.received === true && sr.bounced !== true, enabled: true });
          }
        }
      }
      return { kind: d.kind, recipients: base };
    })
  );
  // chosen recipients (emails) that WILL receive on a bulk send · default = all valid
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const d of rooftop.departments) for (const r of d.recipients) if (validEmail(r.email)) s.add(r.email.toLowerCase());
    for (const sr of sentRecipients ?? []) if (validEmail(sr.email)) s.add(sr.email.toLowerCase());
    return s;
  });
  const [bulk, setBulk] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [bulkMsg, setBulkMsg] = useState("");
  // Rooftop-level SMS master switch (roi_rooftop_config.sms_enabled). SMS only sends when this is ON.
  const [smsRooftopOn, setSmsRooftopOn] = useState<boolean>(rooftop.smsEnabled === true);
  const [smsRooftopBusy, setSmsRooftopBusy] = useState(false);
  const toggleSmsRooftop = async () => {
    const next = !smsRooftopOn;
    setSmsRooftopOn(next); setSmsRooftopBusy(true);
    const r = await updateRooftopConfigNow({ teamId: rooftop.team_id, sms_enabled: next });
    setSmsRooftopBusy(false);
    if (!r.ok) { setSmsRooftopOn(!next); setBulkMsg(r.error || "SMS switch failed"); }
  };

  const toggle = (email: string) => {
    const key = email.toLowerCase();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const markReceived = (deptKind: DeptKind, idx: number) =>
    setDepts((prev) => prev.map((d) => (d.kind === deptKind ? { ...d, recipients: d.recipients.map((r, i) => (i === idx ? { ...r, received: true } : r)) } : d)));
  const setEmail = (deptKind: DeptKind, idx: number, email: string) =>
    setDepts((prev) => prev.map((d) => (d.kind === deptKind ? { ...d, recipients: d.recipients.map((r, i) => (i === idx ? { ...r, email } : r)) } : d)));
  // Toggle email_enabled — persists, never sends. Optimistic; reverts on failure.
  const setEnabledLocal = (deptKind: DeptKind, idx: number, val: boolean) =>
    setDepts((prev) => prev.map((d) => (d.kind === deptKind ? { ...d, recipients: d.recipients.map((r, i) => (i === idx ? { ...r, enabled: val } : r)) } : d)));
  const toggleEnabled = async (deptKind: DeptKind, idx: number, email: string, next: boolean) => {
    setEnabledLocal(deptKind, idx, next);
    setSelected((prev) => { const n = new Set(prev); next ? n.add(email.toLowerCase()) : n.delete(email.toLowerCase()); return n; });
    const r = await toggleRecipientNow({ teamId: rooftop.team_id, email, enabled: next });
    if (!r.ok) setEnabledLocal(deptKind, idx, !next); // revert
  };

  // ── SMS channel (per recipient) — mirror the email toggle, plus a phone editor ──
  const patchRecip = (deptKind: DeptKind, idx: number, patch: Partial<Recipient>) =>
    setDepts((prev) => prev.map((d) => (d.kind === deptKind ? { ...d, recipients: d.recipients.map((r, i) => (i === idx ? { ...r, ...patch } : r)) } : d)));
  const toggleSms = async (deptKind: DeptKind, idx: number, email: string, next: boolean) => {
    patchRecip(deptKind, idx, { smsEnabled: next });
    const r = await toggleRecipientNow({ teamId: rooftop.team_id, email, enabled: next, channel: "sms" });
    if (!r.ok) { patchRecip(deptKind, idx, { smsEnabled: !next }); setBulkMsg(r.error || "SMS toggle failed"); }
  };
  const savePhone = async (deptKind: DeptKind, idx: number, email: string, phone: string): Promise<{ ok: boolean; error?: string }> => {
    const prev = depts.find((d) => d.kind === deptKind)?.recipients[idx]?.phone;
    patchRecip(deptKind, idx, { phone });
    const r = await setRecipientPhoneNow({ teamId: rooftop.team_id, dept: deptKind, email, phone });
    if (!r.ok) patchRecip(deptKind, idx, { phone: prev }); // revert
    return r;
  };

  // the REAL send — to a specific set of emails for a department. Always confirmed first (C11):
  // Resend and the per-row Send used to email on one click.
  const sendTo = async (emails: string[], deptKind: DeptKind): Promise<SendResult> => {
    const ok = await confirmDialog({
      title: `${isSent ? "Resend" : "Send"} the ${deptKind} daily digest for ${formatHumanDate(reportDate || "")}?`,
      message: `It emails ${emails.length === 1 ? "this person" : `these ${emails.length} people`} through mail.spyne.ai:\n${emails.join(", ")}${isSent ? "\n\nThey already got this digest once. The original send stays on record; this one is added to its history." : ""}`,
      confirmLabel: isSent ? "Resend" : "Send",
    });
    if (!ok) return { ok: false, error: "Not sent." };
    const r = await sendDigestNow({
      teamId: rooftop.team_id,
      enterpriseId: rooftop.enterprise_id,
      dept: (deptKind ?? dept) as DeptKind | undefined,
      rooftopName: rooftop.name,
      timezone: rooftop.timezone,
      localDate: reportDate || "",
      cadence: "daily",
      metrics,
      recipients: emails,
    });
    return { ok: r.ok, error: r.error };
  };

  const sendSelected = async (deptKind: DeptKind, deptEmails: string[]) => {
    const chosen = deptEmails.filter((e) => selected.has(e.toLowerCase()));
    if (!chosen.length) { setBulk("error"); setBulkMsg("Pick at least one recipient first."); return; }
    setBulk("sending"); setBulkMsg("");
    const r = await sendTo(chosen, deptKind);
    if (r.ok) { setBulk("sent"); setBulkMsg(r.error || `Sent ✓ → ${chosen.join(", ")}`); onSend(); }
    else { setBulk("error"); setBulkMsg(r.error || "Send failed"); }
  };

  if (depts.length === 0) {
    return <p className="text-[12px] text-text-muted">No departments classified for this rooftop.</p>;
  }

  // Sends from this list render the DAILY template from the cell's stored numbers (sendDigestNow).
  // A weekly/monthly cell now carries its run's numbers too, and sending them through here would email
  // the dealer a "Daily Digest" of a whole month. Those cadences send from "Generate & send", which
  // builds the email for the period server-side.
  const noData = periodic || !hasSendableData(metrics);

  return (
    <div className="space-y-4">
      {/* SMS channel master switch — texts action-item + appointment alerts to recipients with a phone + SMS on.
          Hidden for a rooftop with no config row: the save would 404. */}
      {rooftop.unconfigured ? null : <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-background px-3 py-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-text-primary">SMS notifications</div>
          <div className="text-[10px] text-text-muted">Text appointment & action-item alerts to recipients below who have a phone + SMS on.</div>
        </div>
        <button
          type="button"
          onClick={() => void toggleSmsRooftop()}
          disabled={smsRooftopBusy}
          title={smsRooftopOn ? "SMS ON for this rooftop — click to disable" : "SMS OFF — click to enable the SMS channel for this rooftop"}
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${smsRooftopOn ? "bg-positive/10 text-positive" : "bg-surface-subtle text-text-muted"} disabled:opacity-60`}
        >
          <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${smsRooftopOn ? "bg-positive" : "bg-text-muted"}`} />
          {smsRooftopOn ? "On" : "Off"}
        </button>
      </div>}
      {periodic ? (
        <p className="rounded-md border border-border-subtle bg-surface-subtle px-3 py-1.5 text-[11px] leading-snug text-text-muted">
          Weekly and monthly digests are sent from Generate &amp; send, which builds the email for the whole period. You can still add or enable recipients here.
        </p>
      ) : noData ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-1.5 text-[11px] leading-snug text-warning">
          No stored digest with activity for this day, so there is nothing here to send. Use Generate &amp; send above to build it, or add and switch on recipients for the next send.
        </p>
      ) : null}
      {depts.map((d) => {
        const emails = d.recipients.map((r) => r.email).filter(validEmail);
        const chosenCount = emails.filter((e) => selected.has(e.toLowerCase())).length;
        // "X/Y received" — for a SENT run, base Y on who the run actually targeted (the run's
        // recipients[]), NOT the full configured recipient list. Configured-but-not-targeted
        // recipients default to received:false and would inflate the denominator into a false
        // "didn't receive". For non-sent states fall back to the configured count.
        const targeted = isSent && d.kind === dept && (sentRecipients?.length ?? 0) > 0
          ? new Set((sentRecipients ?? []).map((r) => r.email.toLowerCase()))
          : null;
        const denomRecips = targeted
          ? d.recipients.filter((r) => targeted.has(r.email.toLowerCase()))
          : d.recipients;
        return (
          <div key={d.kind}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-widest capitalize text-text-secondary">
                {d.kind} department
              </span>
              <span className="text-[10px] text-text-muted">
                {denomRecips.filter((r) => r.received).length}/{denomRecips.length} received
              </span>
            </div>
            {d.recipients.length === 0 ? (
              <AddRecipientInline teamId={rooftop.team_id} dept={d.kind} onAdded={() => (onReload ? onReload() : onSend())} />
            ) : (
              <>
                <ul className="space-y-1.5">
                  {d.recipients.map((rec, idx) => (
                    <RecipientRow
                      key={idx}
                      recipient={rec}
                      isSent={isSent}
                      disabled={noData}
                      checked={validEmail(rec.email) && selected.has(rec.email.toLowerCase())}
                      onToggle={() => toggle(rec.email)}
                      onToggleEnabled={validEmail(rec.email) ? (next: boolean) => void toggleEnabled(d.kind, idx, rec.email, next) : undefined}
                      smsRooftopOn={smsRooftopOn}
                      onToggleSms={validEmail(rec.email) ? (next: boolean) => void toggleSms(d.kind, idx, rec.email, next) : undefined}
                      onSavePhone={validEmail(rec.email) ? (phone: string) => savePhone(d.kind, idx, rec.email, phone) : undefined}
                      onSend={async (email) => {
                        // commit the typed address into the list + select it, THEN send
                        setEmail(d.kind, idx, email);
                        setSelected((prev) => new Set(prev).add(email.toLowerCase()));
                        const r = await sendTo([email], d.kind);
                        if (r.ok) { markReceived(d.kind, idx); onSend(); }
                        return r;
                      }}
                    />
                  ))}
                </ul>
                <AddRecipientInline teamId={rooftop.team_id} dept={d.kind} onAdded={() => (onReload ? onReload() : onSend())} />
                {emails.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void sendSelected(d.kind, emails)}
                    disabled={bulk === "sending" || chosenCount === 0 || noData}
                    title={periodic ? "Weekly and monthly digests are sent from Generate & send" : noData ? "No data for this day — nothing to send" : undefined}
                    className={`mt-2 w-full rounded-md px-3 py-2 text-[12px] font-semibold ${
                      noData
                        ? "cursor-not-allowed bg-surface-subtle text-text-muted"
                        : bulk === "sent"
                        ? "bg-positive/10 text-positive"
                        : bulk === "error"
                        ? "bg-negative-soft text-negative"
                        : chosenCount > 0
                        ? "bg-brand-primary text-white hover:bg-brand-primary-hover"
                        : "cursor-not-allowed bg-surface-subtle text-text-muted"
                    }`}
                  >
                    {bulk === "sending"
                      ? "Sending…"
                      : isSent
                      ? `Resend to ${chosenCount} selected`
                      : `Send to ${chosenCount} selected`}
                  </button>
                ) : null}
              </>
            )}
          </div>
        );
      })}
      {bulkMsg ? <p className="text-[10px] text-text-muted">{bulkMsg}</p> : null}
    </div>
  );
}

function RecipientRow({
  recipient,
  isSent,
  checked,
  onToggle,
  onSend,
  onToggleEnabled,
  smsRooftopOn = false,
  onToggleSms,
  onSavePhone,
  disabled = false,
}: {
  recipient: Recipient;
  isSent: boolean;
  checked: boolean;
  onToggle: () => void;
  onSend: (email: string) => Promise<SendResult>;
  onToggleEnabled?: (next: boolean) => void;
  smsRooftopOn?: boolean;
  onToggleSms?: (next: boolean) => void;
  onSavePhone?: (phone: string) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(recipient.email);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  const hasEmail = validEmail(recipient.email);
  const valid = validEmail(draft);
  const enabled = recipient.enabled !== false; // undefined (e.g. sent-run recipients) → treat as on
  // SMS sub-row state
  const [phoneDraft, setPhoneDraft] = useState(recipient.phone ?? "");
  const [phoneState, setPhoneState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const smsOn = recipient.smsEnabled === true;
  const hasPhone = !!(recipient.phone && recipient.phone.trim());
  const phoneValid = /\+?[\d][\d\s().-]{6,}/.test(phoneDraft.trim());
  const savePhone = async () => {
    const p = phoneDraft.trim();
    if (!onSavePhone || p === (recipient.phone ?? "")) return;
    if (p && !phoneValid) { setPhoneState("error"); return; }
    setPhoneState("saving");
    const r = await onSavePhone(p);
    setPhoneState(r.ok ? "saved" : "error");
    if (r.ok) setTimeout(() => setPhoneState("idle"), 1500);
  };

  const fire = async (email: string) => {
    setState("sending"); setMsg("");
    const r = await onSend(email);
    if (r.ok) { setState("sent"); setMsg(r.error || "Sent ✓"); }
    else { setState("error"); setMsg(r.error || "Failed"); }
  };

  // Missing email · inline add + send (no checkbox until there's an address)
  if (!hasEmail) {
    return (
      <li className="rounded-md border border-dashed border-warning/50 bg-warning-soft/40 px-3 py-2">
        <div className="text-[10px] font-semibold text-warning">No email on file · add one</div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && valid) void fire(draft.trim()); }}
            placeholder="name@dealership.com"
            className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-card px-2.5 py-1.5 text-[12px] placeholder:text-text-muted focus:border-brand-primary focus:outline-none"
          />
          <button
            type="button"
            onClick={() => valid && !disabled && void fire(draft.trim())}
            disabled={!valid || disabled || state === "sending"}
            title={disabled ? "No data for this day — nothing to send" : undefined}
            className={`shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-semibold ${
              valid && !disabled ? "bg-brand-primary text-white hover:bg-brand-primary-hover" : "cursor-not-allowed bg-surface-subtle text-text-muted"
            }`}
          >
            {state === "sending" ? "Sending…" : "Add & send"}
          </button>
        </div>
        {msg ? <div className="mt-1 text-[10px] text-text-muted">{msg}</div> : null}
      </li>
    );
  }

  const sendLabel = state === "sending"
    ? "Sending…"
    : state === "sent"
    ? "✓ Sent"
    : state === "error"
    ? "Retry"
    : recipient.received
    ? "Resend"
    : "Send";

  return (
    <li className={`rounded-md border border-border-subtle px-3 py-2 ${recipient.received ? "bg-positive/5" : "bg-surface-background"}`}>
      <div className="flex items-center gap-2">
        {/* choose-to-receive checkbox */}
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          title="Include this recipient when sending to selected"
          className="h-3.5 w-3.5 shrink-0 accent-brand-primary"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-text-primary">{recipient.email}{recipient.name ? <span className="ml-1 text-text-muted">· {recipient.name}</span> : null}</div>
          <div className={`text-[10px] ${recipient.received ? "text-positive" : isSent ? "text-negative" : "text-text-muted"}`}>
            {recipient.received ? "✓ Received" : isSent ? "Didn't receive" : "Not sent yet"}
          </div>
        </div>
        {/* email_enabled status + toggle (persists; never sends) */}
        {onToggleEnabled ? (
          <button
            type="button"
            onClick={() => onToggleEnabled(!enabled)}
            title={enabled ? "Email ON — click to disable (won’t receive sends)" : "Email OFF — click to enable (no send, just enable)"}
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${enabled ? "bg-positive/10 text-positive" : "bg-surface-subtle text-text-muted"}`}
          >
            <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${enabled ? "bg-positive" : "bg-text-muted"}`} />
            {enabled ? "On" : "Off"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => !disabled && void fire(recipient.email)}
          disabled={disabled || state === "sending"}
          title={disabled ? "No data for this day — nothing to send" : recipient.received ? "Resend individually to this recipient" : "Send individually to this recipient"}
          className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold ${
            disabled
              ? "cursor-not-allowed bg-surface-subtle text-text-muted"
              : state === "sent"
              ? "bg-positive/10 text-positive"
              : state === "error"
              ? "bg-negative-soft text-negative"
              : "bg-brand-primary text-white hover:bg-brand-primary-hover"
          }`}
        >
          {sendLabel}
        </button>
      </div>
      {/* SMS sub-row: phone editor + SMS on/off. Shown once the rooftop SMS switch is on. */}
      {smsRooftopOn && (onToggleSms || onSavePhone) ? (
        <div className="mt-1.5 flex items-center gap-1.5 border-t border-border-subtle pt-1.5">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-muted">SMS</span>
          <input
            type="tel"
            value={phoneDraft}
            onChange={(e) => { setPhoneDraft(e.target.value); if (phoneState === "error") setPhoneState("idle"); }}
            onKeyDown={(e) => { if (e.key === "Enter") void savePhone(); }}
            onBlur={() => void savePhone()}
            placeholder="+1 555 123 4567"
            className={`min-w-0 flex-1 rounded-md border bg-surface-card px-2 py-1 text-[11px] placeholder:text-text-muted focus:outline-none ${phoneState === "error" ? "border-negative" : "border-border-subtle focus:border-brand-primary"}`}
          />
          <span className="shrink-0 text-[9px] text-text-muted">
            {phoneState === "saving" ? "Saving…" : phoneState === "saved" ? "Saved ✓" : phoneState === "error" ? "Invalid" : ""}
          </span>
          {onToggleSms ? (
            <button
              type="button"
              onClick={() => hasPhone ? onToggleSms(!smsOn) : setPhoneState("error")}
              disabled={!hasPhone}
              title={!hasPhone ? "Add a phone first" : smsOn ? "SMS ON — click to disable" : "SMS OFF — click to enable"}
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold disabled:opacity-50 ${smsOn ? "bg-positive/10 text-positive" : "bg-surface-subtle text-text-muted"}`}
            >
              <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${smsOn ? "bg-positive" : "bg-text-muted"}`} />
              {smsOn ? "On" : "Off"}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/* ============================================================
   Complete daily-digest email (real template, from stored metrics)
   ============================================================ */
function DigestEmail({
  rooftop,
  cell,
  metrics,
  dept,
  renderedHtml,
  isSent = false,
  view = "email",
}: {
  rooftop: RooftopRow;
  cell: SendCell;
  metrics?: DigestMetrics;
  dept?: DeptKind;
  renderedHtml?: string;
  isSent?: boolean;
  view?: "desktop" | "email";
}) {
  // SENT → show ONLY the exact HTML that was emailed (stored rendered_html). Never re-render
  // from data; if it wasn't stored, say so rather than fabricate a preview.
  // NOT SENT (preview / add-recipient) → ALWAYS the default digest template: the stored body if
  // present, otherwise render the canonical template from metrics (zeros when none) — never a stub.
  let html: string | null;
  const exact = !!renderedHtml;
  if (isSent) {
    html = renderedHtml || null;
  } else if (cell.cadence !== "daily" && !renderedHtml) {
    // renderDigestEmail is the DAILY template ("yesterday", "daily report"). A weekly/monthly body
    // comes from the server preview (PeriodicGenerateSection), so wait for it instead of showing a
    // daily-worded stand-in built from this period's stored numbers.
    return (
      <div className="rounded-xl border border-border-subtle bg-surface-card px-4 py-10 text-center text-[12px] text-text-muted">
        The {cell.cadence} email is built on demand. Its preview appears here once generated.
      </div>
    );
  } else {
    html = renderedHtml || renderDigestEmail((metrics ?? {}) as DigestMetrics, {
      rooftopName: rooftop.name, dept, teamId: rooftop.team_id, enterpriseId: rooftop.enterprise_id,
      reportDate: ((metrics ?? {}) as { reportDate?: string }).reportDate ?? cell.date, timezone: rooftop.timezone,
    });
  }
  if (!html) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface-card px-4 py-10 text-center text-[12px] text-text-muted">
        The exact sent email HTML wasn’t stored for this run, so it can’t be shown.
      </div>
    );
  }
  // view toggle: 'email' = ~400px (mobile/inbox, triggers the email's @media stacking);
  // 'desktop' = full 640px card. The HTML is identical — only the viewport width changes.
  const maxWidth = view === "email" ? 400 : 680;
  return (
    <div style={{ maxWidth, margin: "0 auto" }} className="transition-[max-width] duration-200">
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-white">
        {/* The pixel is stripped and scripts can't run: viewing a stored email here must never
            register as the dealer opening it (C13). */}
        <iframe title={isSent ? "Email, exact HTML sent" : exact ? "Daily digest, stored body" : "Daily digest, default template"} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={neutralizeTracking(html)} className="block w-full bg-white" style={{ height: 980, border: 0 }} />
      </div>
    </div>
  );
}

/* ============================================================
   Sent-to email IDs (sent cells)
   ============================================================ */
function SentToList({
  recipients,
  pending,
}: {
  recipients?: { email: string; name?: string; received?: boolean; bounced?: boolean; opened?: boolean }[];
  pending?: boolean; // true for suppressed (not sent yet) → "Will send"
}) {
  const list = recipients ?? [];
  if (!list.length)
    return <p className="text-[12px] text-text-muted">No recipients configured for this department.</p>;
  return (
    <ul className="space-y-1.5">
      {list.map((r, i) => (
        <li
          key={i}
          className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-background px-3 py-2"
        >
          <span className="min-w-0 truncate text-[12px] text-text-primary">{r.email}</span>
          <span
            className={`shrink-0 text-[11px] font-semibold ${
              r.bounced ? "text-negative" : r.opened ? "text-positive" : r.received ? "text-positive" : pending ? "text-info" : "text-text-muted"
            }`}
          >
            {r.bounced ? "Bounced" : r.opened ? "Opened ✓" : r.received ? "Received" : pending ? "Will send" : "Sent"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ============================================================
   Suppress reason banner
   ============================================================ */
function SuppressBanner({ rawReason }: { rawReason?: string }) {
  const dryRun = rawReason === "dry_run";
  return (
    <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5">
      <div className="text-[12px] font-semibold text-warning">
        {dryRun ? "Held by dry-run mode" : `Suppressed${rawReason ? ` · ${rawReason}` : ""}`}
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
        {dryRun
          ? "This rooftop had activity, so the digest was built, but the department is in dry run, so the dealer was not emailed. To send this one anyway, use Send below: it asks you to type DANGER and records the override. To start sending every day, switch the department to Live in the grid."
          : "The digest was built and held back. Nothing was sent to the dealer."}
      </p>
    </div>
  );
}

/* ============================================================
   Generate & send ONE period (C14, C15).
   Builds the clicked cell's period (cron key) on the server and sends it to the department's
   eligible recipients. The recipient list comes from the server's eligibility check (the cron's
   own predicate), so the button works on an empty cell. Retry on a failed day is this same call.
   Weekly/monthly previews the period first (render only, no email).
   ============================================================ */
function GenerateSendSection({
  rooftop,
  dept,
  cadence,
  periodKey,
  periodText,
  state,
  onPreview,
  onSent,
  onIgnore,
}: {
  rooftop: RooftopRow;
  dept?: DeptKind;
  cadence: SendCell["cadence"];
  periodKey: string;
  periodText: string;
  state: CellState;
  onPreview: (html: string | null) => void;
  onSent: () => void;
  onIgnore?: () => void;
}) {
  const [audience, setAudience] = useState<EligibleRecipients | null | undefined>(undefined);
  const [pState, setPState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [pMsg, setPMsg] = useState("");
  const [sState, setSState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [sMsg, setSMsg] = useState("");
  const inFlight = useRef(false);
  const autoDone = useRef(false);
  const periodic = cadence !== "daily";

  useEffect(() => {
    if (!rooftop.team_id || !dept) { setAudience(null); return; }
    let alive = true;
    void loadEligibleRecipients(rooftop.team_id, dept, cadence).then((a) => { if (alive) setAudience(a); });
    return () => { alive = false; };
  }, [rooftop.team_id, dept, cadence]);

  // ① Preview — render only, shown on the left, no email.
  const preview = useCallback(async () => {
    setPState("running"); setPMsg("");
    const r = await generatePreviewNow({ cadence, teamId: rooftop.team_id, dept, localDate: periodKey });
    if (r.ok && r.preview) {
      onPreview(r.preview.html);
      setPState("done");
      setPMsg(r.preview.hasData
        ? `Preview ready · ${r.preview.dateLabel}`
        : `Preview ready, but there was no activity (${r.preview.reason ?? "no data"}), so a send would be blocked.`);
    } else {
      setPState("error"); setPMsg(r.error ?? "Preview failed");
    }
  }, [cadence, rooftop.team_id, dept, periodKey, onPreview]);
  // Weekly/monthly cells have no stored copy to show, so preview as soon as the drawer opens.
  useEffect(() => { if (periodic && !autoDone.current) { autoDone.current = true; void preview(); } }, [periodic, preview]);

  const emails = (audience?.eligible ?? []).map((r) => r.email);
  const send = async () => {
    if (inFlight.current) return;
    if (!emails.length) { setSState("error"); setSMsg("Nobody is eligible to receive this. Verify a recipient and switch them on first."); return; }
    const ok = await confirmDialog({
      title: `${state === "failed" ? "Retry" : "Send"} the ${cadence} digest for ${periodText}?`,
      message: (state === "delivery_unknown"
        ? "A send for this period was started and never finished, so the dealer may already have this email. Only send if you have checked that they don't.\n\n"
        : "") +
        `It builds the digest for ${periodText} from current data and emails ${emails.length} recipient${emails.length === 1 ? "" : "s"} through mail.spyne.ai:\n${emails.join(", ")}`,
      confirmLabel: state === "failed" ? "Retry send" : "Send digest",
      tone: state === "delivery_unknown" ? "danger" : undefined,
    });
    if (!ok || inFlight.current) return;
    inFlight.current = true; setSState("sending"); setSMsg("");
    const r = await generateAndSendNow({ cadence, teamId: rooftop.team_id, dept, localDate: periodKey });
    if (r.ok) {
      const s = r.summary;
      setSState("sent");
      setSMsg(!s ? `Sent to ${emails.join(", ")}`
        : s.sent > 0 ? `Sent to ${emails.join(", ")}`
        : (s.already_sent ?? 0) > 0 ? "Already sent for this period. Nothing was sent again."
        : s.suppressed > 0 ? "Held: the department is in dry run, so nothing was sent."
        : s.no_data > 0 ? "No activity for this period. Nothing was sent."
        : s.no_recipients > 0 ? "No eligible recipients. Nothing was sent."
        : (s.paused ?? 0) > 0 ? "This email type is turned off for the rooftop. Nothing was sent."
        : (s.churned ?? 0) > 0 ? "This rooftop has churned. Nothing was sent."
        : s.errors > 0 ? "The send failed. Check the cell after the page reloads."
        : "Nothing was sent.");
      setTimeout(onSent, 1200);
    } else {
      setSState("error"); setSMsg(r.error ?? "Send failed");
    }
    inFlight.current = false;
  };

  const btnBase = "w-full rounded-md px-3 py-2 text-[12px] font-semibold disabled:opacity-60";
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border-subtle bg-surface-background px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Will receive{audience ? ` (${audience.eligible.length})` : ""}
        </div>
        {audience === undefined ? (
          <p className="mt-1 text-[11px] text-text-muted">Checking who is eligible…</p>
        ) : audience === null ? (
          <p className="mt-1 text-[11px] text-negative">Couldn't load the recipient list.</p>
        ) : audience.eligible.length ? (
          <ul className="mt-1 space-y-0.5">{audience.eligible.map((e) => <li key={e.email} className="truncate text-[11px] text-text-primary">{e.email}</li>)}</ul>
        ) : (
          <p className="mt-1 text-[11px] text-warning">Nobody on the {dept ?? ""} list is eligible (verified, switched on and subscribed to the {cadence} digest).</p>
        )}
        {audience && audience.held.length ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] text-text-muted">{audience.held.length} on the list won't receive it</summary>
            <ul className="mt-0.5 space-y-0.5">{audience.held.map((h) => <li key={h.email} className="truncate text-[10px] text-text-secondary">{h.email} · {h.why}</li>)}</ul>
          </details>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => void preview()}
          disabled={pState === "running"}
          className={`${btnBase} ${pState === "error" ? "bg-negative-soft text-negative" : pState === "done" ? "bg-positive/10 text-positive" : "border border-border-subtle bg-surface-card text-text-primary hover:bg-surface-subtle"}`}
        >
          {pState === "running" ? "Building preview…" : pState === "done" ? "Preview again" : pState === "error" ? "Retry preview" : "Preview this period"}
        </button>
        <p className="text-[10px] text-text-muted">{pMsg || `Builds the ${cadence} digest for ${periodText} and shows it on the left. No email is sent.`}</p>
      </div>
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sState === "sending" || !emails.length || !periodKey}
          title={!emails.length ? "Nobody is eligible to receive this" : undefined}
          className={`${btnBase} ${sState === "sent" ? "bg-positive/10 text-positive" : sState === "error" ? "bg-negative-soft text-negative" : "bg-brand-primary text-white hover:bg-brand-primary-hover"}`}
        >
          {sState === "sending" ? "Sending…" : sState === "sent" ? "Sent" : state === "failed" ? `Retry ${periodText}` : `Send ${periodText} to the dealer`}
        </button>
        <p className="text-[10px] text-text-muted">{sMsg || "Asks you to confirm first. The server checks the same rules as the scheduled send (churn, dry run, type switched on, eligible recipients) and refuses if any fail."}</p>
      </div>
      {onIgnore ? (
        <button type="button" onClick={onIgnore} className={`${btnBase} border border-border-subtle bg-surface-card text-text-secondary hover:bg-surface-subtle`}>
          Close without sending
        </button>
      ) : null}
    </div>
  );
}

/* ============================================================
   Send a HELD daily digest's stored copy (dry-run hold). Confirms first; the server applies the
   cron's gates, so a dry-run department asks for a typed DANGER override, recorded on the run.
   ============================================================ */
function SendNowLiveSection({
  rooftop,
  recipients,
  metrics,
  dept,
  reportDate,
  onSent,
}: {
  rooftop: RooftopRow;
  recipients?: { email: string }[];
  metrics?: DigestMetrics;
  dept?: DeptKind;
  reportDate?: string;
  onSent: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  const inFlight = useRef(false); // guarantees ONE send per click (no double-fire)
  const emails = (recipients ?? []).map((r) => r.email).filter(Boolean);
  const noData = !hasSendableData(metrics);

  const click = async () => {
    if (inFlight.current) return;
    if (!emails.length) { setState("error"); setMsg("No recipients on this run."); return; }
    if (noData) { setState("error"); setMsg("No data for this day. Nothing to send."); return; }
    const ok = await confirmDialog({
      title: `Send the held ${dept ?? ""} digest for ${formatHumanDate(reportDate || "")}?`,
      message: `It emails the dealer through mail.spyne.ai:\n${emails.join(", ")}\n\nRecipients who are no longer eligible are dropped by the server.`,
      confirmLabel: "Send digest",
    });
    if (!ok || inFlight.current) return;
    inFlight.current = true;
    setState("sending"); setMsg("");
    const r = await sendDigestNow({
      teamId: rooftop.team_id,
      enterpriseId: rooftop.enterprise_id,
      dept,
      rooftopName: rooftop.name,
      timezone: rooftop.timezone,
      localDate: reportDate || "",
      cadence: "daily",
      metrics,
      recipients: emails,
    });
    if (r.ok) {
      setState("sent");
      setMsg(r.error ? r.error : `Sent to ${emails.join(", ")}`);
      setTimeout(onSent, 1200);
    } else {
      setState("error");
      setMsg(r.error ?? "Send failed");
    }
    inFlight.current = false;
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void click()}
        disabled={state === "sending" || noData}
        title={noData ? "No data for this day, nothing to send" : undefined}
        className={`w-full rounded-md px-3 py-2 text-[12px] font-semibold ${
          noData
            ? "cursor-not-allowed bg-surface-subtle text-text-muted"
            : state === "sent"
            ? "bg-positive/10 text-positive"
            : state === "error"
            ? "bg-negative-soft text-negative"
            : "bg-negative text-white hover:opacity-90 disabled:opacity-60"
        }`}
      >
        {noData ? "No data, can't send" : state === "sending" ? "Sending…" : state === "sent" ? "Sent" : state === "error" ? "Retry send" : "Send to the dealer"}
      </button>
      <p className="text-[10px] text-text-muted">
        {msg || `Asks you to confirm, then emails ${emails.join(", ") || "the run's recipients"} through mail.spyne.ai.`}
      </p>
    </div>
  );
}

/* ============================================================
   Email snippet preview (stub fallback)
   ============================================================ */
function EmailSnippetCard({ rooftop, numbersAdded }: { rooftop: RooftopRow; numbersAdded?: boolean }) {
  const stub = useMemo(() => generateStub(rooftop.rooftop_id), [rooftop.rooftop_id]);
  const primaryDept = rooftop.departments[0]?.kind ?? "service";
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-background">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-card px-4 py-3">
        <div className="inline-flex items-baseline gap-1.5 text-[13px] font-semibold tracking-tight text-text-primary">
          <SnippetLogo /> spyne
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold leading-tight text-text-primary">{rooftop.name}</div>
          <div className="text-[9px] text-text-muted">Vini · Daily Digest</div>
        </div>
      </div>
      <div className="px-4 pt-3">
        <h4 className="text-[15px] font-bold tracking-tight text-text-primary">
          Yesterday
          <span className="ml-1 text-[12px] font-normal text-text-secondary">at {rooftop.name}</span>
        </h4>
        <p className="mt-0.5 text-[10px] text-text-muted">
          <Num n={stub.conversations} /> conversations · <Num n={stub.appts} /> appts · <Num n={stub.leads} /> leads
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 px-4 pb-3 pt-2">
        <SnippetKpiTile label="Conversations" value={stub.conversations} sub={`${Math.round((stub.voice / stub.conversations) * 100)}% voice`} />
        <SnippetKpiTile label="Appointments" value={stub.appts} sub={`${stub.mtdAppts} MTD`} />
      </div>
      <div className="border-t border-border-subtle bg-surface-card px-4 py-2.5">
        <div className="text-[9px] font-semibold uppercase tracking-widest text-text-muted">
          Top {primaryDept === "service" ? "service intent" : "vehicle"}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-semibold text-text-primary">{stub.topItem}</span>
          <span className="tabular text-[11px] text-text-secondary">{stub.topItemCount} leads</span>
        </div>
      </div>
      {numbersAdded ? (
        <div className="border-t border-border-subtle bg-info-soft px-4 py-1.5 text-[10px] font-semibold text-info">
          Numbers added from activity feed — preview only
        </div>
      ) : null}
    </div>
  );
}

function Num({ n }: { n: number }) {
  return <span className="tabular font-semibold text-text-primary">{n.toLocaleString()}</span>;
}

function SnippetKpiTile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-surface-card px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-widest text-text-muted">{label}</div>
      <div className="mt-1 text-[20px] font-bold tabular leading-tight text-text-primary">{value.toLocaleString()}</div>
      <div className="text-[10px] text-text-muted">{sub}</div>
    </div>
  );
}

function SnippetLogo() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
      <circle cx="6" cy="6" r="3" fill="#FF6B35" />
      <circle cx="18" cy="6" r="3" fill="#FFC107" />
      <circle cx="6" cy="18" r="3" fill="#4600F2" />
      <circle cx="18" cy="18" r="3" fill="#16A34A" />
    </svg>
  );
}

/** A single ‹ / › step button — disabled (greyed) when there's nowhere to go. */
function NavBtn({ onClick, children }: { onClick: (() => void) | null; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onClick?.()}
      disabled={!onClick}
      className="rounded-md border border-border-subtle bg-surface-card px-2 py-1 text-[13px] leading-none text-text-secondary hover:bg-surface-subtle disabled:opacity-30 disabled:hover:bg-surface-card"
    >
      {children}
    </button>
  );
}

function generateStub(rooftopId: string) {
  let seed = 0;
  for (const ch of rooftopId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const r = (max: number) => {
    seed = (seed * 9301 + 49297) % 233280;
    return Math.floor((seed / 233280) * max);
  };
  const conversations = 12 + r(40);
  const voice = Math.floor(conversations * (0.5 + r(40) / 100));
  const appts = 2 + r(8);
  const leads = conversations + 5 + r(30);
  const mtdAppts = appts * (5 + r(15));
  const topItemCount = 2 + r(8);
  const SVC = ["Maintenance / oil change", "Recall follow-up", "Diagnostic / check-engine", "Status update"];
  const SALES = ["2025 Mercedes-Benz GLE 450", "2024 Honda Civic Sport", "2025 Toyota RAV4 Hybrid", "2024 Ford F-150 Lariat"];
  const topItem = r(2) === 0 ? SVC[r(SVC.length)] : SALES[r(SALES.length)];
  return { conversations, voice, appts, leads, mtdAppts, topItem, topItemCount };
}

function formatHumanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
