import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  NOT_SENT_REASON_LABEL,
  type DeptKind,
  type DigestMetrics,
  type NotSentReason,
  type Recipient,
  type RooftopRow,
  type SendCell,
} from "./mockData";
import { isPipelineConfigured, runDryPipeline } from "./pipeline";
import { renderDigestEmail } from "./renderDigest";
import { sendDigestNow, generateAndSendNow, generatePreviewNow, renderStoredPreview, addRecipientNow, toggleRecipientNow, updateRooftopConfigNow, addCsmNow } from "./sendDigest";

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

const REASON_HELPER: Record<NotSentReason, string> = {
  tag_missing:
    "This rooftop isn't classified into Sales or Service. Vini needs the designation to know which agent's stats to pull. Classify it below to unblock.",
  recipient_placeholder:
    'The recipient field holds a placeholder ("m") instead of a real address. Replace it below.',
  recipients_missing:
    "No email recipient is configured for this department. Add at least one address below.",
  smtp_timeout: "The send was attempted but the SMTP relay timed out. Retry below.",
  scheduler_skipped: "The scheduler didn't fire the job on time. Send manually below.",
  bounced: "The recipient's inbox bounced the message. Update the address below.",
  silent_day: "No customer activity for this rooftop on this day.",
};

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

  if (!mounted || !rooftop || !cell) return null;

  const status = cell.status;
  const runs = cell.runs ?? [];
  // the run that drives this cell (matching status), else the first run
  const primary = runs.find((r) => r.status === status) ?? runs[0] ?? null;
  const metrics = primary?.metrics;
  const dept = primary?.department;
  const rawReason = primary?.reason;
  const reason = cell.reason ?? "scheduler_skipped";
  const isSent = status === "sent";
  const isSuppressed = status === "suppressed";
  // Weekly/monthly digests are generated on demand (rolling window) → preview-then-send flow.
  const isPeriodic = cell.cadence !== "daily";
  // Department for the generate/send call: the cell's run dept, else the rooftop's first department.
  const effDept = (dept ?? rooftop.departments?.[0]?.kind) as DeptKind | undefined;

  // Daily template preview toggle: render this day's STORED metrics in v1 (Classic) / v2 (New).
  // null → restore the as-sent / default view. Render-only — never sends.
  const showTemplate = async (tpl: "v1" | "v2" | null) => {
    setTplErr(null);
    setTplActive(tpl);
    if (tpl === null) { setPreviewHtml(null); return; }
    if (!rooftop.team_id || !effDept) { setTplErr("Missing rooftop/department"); setTplActive(null); return; }
    setTplBusy(true);
    const r = await renderStoredPreview({ teamId: rooftop.team_id, dept: effDept, localDate: cell.date, cadence: cell.cadence, tpl });
    setTplBusy(false);
    if (r.ok && r.html) setPreviewHtml(r.html);
    else { setTplErr(r.error || "Preview failed"); setTplActive(null); }
  };

  const statusLabel = isSent ? "Sent" : isSuppressed ? "Suppressed" : NOT_SENT_REASON_LABEL[reason];
  const statusChip = isSent
    ? "bg-positive/10 text-positive"
    : isSuppressed
    ? "bg-warning-soft text-warning"
    : "bg-negative-soft text-negative";

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
            {cell.cadence} · {formatHumanDate(cell.date)}{dept ? ` · ${dept}` : ""}
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

      {/* Reason banner (non-sent) */}
      {!isSent ? (
        <div
          className={`flex-shrink-0 border-b border-border-subtle px-6 py-2 text-[12px] leading-snug ${
            isSuppressed ? "bg-warning-soft text-warning" : "bg-negative-soft text-negative"
          }`}
        >
          {isSuppressed
            ? rawReason === "dry_run"
              ? "Held by dry-run mode — the digest was generated but emails are OFF. “Re-run (dry-run)” regenerates it; no email is sent."
              : `Suppressed${rawReason ? ` · ${rawReason}` : ""}`
            : `Not sent · ${NOT_SENT_REASON_LABEL[reason]} — ${REASON_HELPER[reason]}`}
        </div>
      ) : null}

      {/* Body: full email (left) + actions rail (right) */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                {tplActive
                  ? `${cell.cadence} digest · ${tplActive === "v2" ? "New" : "Classic"} template preview`
                  : isSent
                  ? primary?.renderedHtml
                    ? "Email sent · exact HTML"
                    : "Email sent · exact HTML not stored"
                  : previewHtml
                  ? `${cell.cadence} digest · generated preview`
                  : `${cell.cadence} digest · default template preview`}
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
            <DigestEmail rooftop={rooftop} cell={cell} metrics={metrics} dept={dept} renderedHtml={previewHtml ?? primary?.renderedHtml} isSent={isSent} view={view} />
          </div>

          <aside className="space-y-4">
            {/* ALWAYS show the recipient list + chooser + per-recipient (re)send — every status */}
            <Section eyebrow="Recipients" title={isSent ? "Recipients · choose & retrigger" : "Recipients · choose & send"}>
              <RecipientManager
                rooftop={rooftop}
                dept={dept}
                metrics={metrics}
                reportDate={cell.date}
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
            ) : (isPeriodic || status === "not_subscribed") ? (
              <Section eyebrow="Generate" title={`Generate & send ${cell.cadence}`}>
                <PeriodicGenerateSection
                  rooftop={rooftop}
                  dept={effDept}
                  cadence={cell.cadence}
                  recipients={primary?.recipients}
                  onPreview={setPreviewHtml}
                  onSent={() => onReload?.()}
                  onIgnore={onClose}
                />
              </Section>
            ) : isSuppressed ? (
              <>
                <Section eyebrow="Suppressed" title="Why it was held back">
                  <SuppressBanner rawReason={rawReason} />
                </Section>
                <Section eyebrow="Dry-run" title="Re-run this digest (dry-run)">
                  <DryRunSection
                    rooftop={rooftop}
                    onDone={() => {
                      onReload?.();
                      onClose();
                    }}
                  />
                </Section>
                <Section eyebrow="Live send" title="Send now (real email)">
                  <SendNowLiveSection
                    rooftop={rooftop}
                    recipients={primary?.recipients}
                    metrics={metrics}
                    dept={dept}
                    reportDate={cell.date}
                    cadence={cell.cadence}
                    onSent={() => {
                      onReload?.();
                    }}
                  />
                </Section>
              </>
            ) : (
              <>
                <Section eyebrow="Reason" title={NOT_SENT_REASON_LABEL[reason]}>
                  <ReasonFieldStatus rooftop={rooftop} reason={reason} />
                </Section>
                <Section eyebrow="Fix & send" title="Fill data & send now">
                  <FixDataForm
                    rooftop={rooftop}
                    reason={reason}
                    dept={dept}
                    metrics={metrics}
                    localDate={cell.date}
                    onSent={() => {
                      onReload?.();
                      onClose();
                    }}
                  />
                </Section>
              </>
            )}
          </aside>
        </div>
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

// #4 — view + edit a rooftop's local send hour:minute + timezone (persists to roi_rooftop_config).
function ScheduleEditor({ rooftop, onSaved }: { rooftop: RooftopRow; onSaved?: () => void }) {
  const [hour, setHour] = useState<string>(rooftop.sendHour != null ? String(rooftop.sendHour) : "7");
  const [minute, setMinute] = useState<string>(rooftop.sendMinute != null ? String(rooftop.sendMinute) : "0");
  const [tz, setTz] = useState<string>(rooftop.timezone || "America/New_York");
  const [edit, setEdit] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const pad = (n: string) => String(n).padStart(2, "0");
  const save = async () => {
    const h = Number(hour), m = Number(minute);
    if (!Number.isInteger(h) || h < 0 || h > 23) { setState("error"); setMsg("Hour must be 0–23"); return; }
    if (!Number.isInteger(m) || m < 0 || m > 59) { setState("error"); setMsg("Minute must be 0–59"); return; }
    setState("saving"); setMsg("");
    const r = await updateRooftopConfigNow({ teamId: rooftop.team_id, sendHour: h, sendMinute: m, timezone: tz.trim() });
    if (r.ok) { setState("done"); setMsg("Saved ✓"); setEdit(false); onSaved?.(); setTimeout(() => setState("idle"), 1500); }
    else { setState("error"); setMsg(r.error || "Save failed"); }
  };
  if (!edit) {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] text-text-primary">{pad(hour)}:{pad(minute)} <span className="text-text-muted">· {tz}</span></div>
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
        <input type="text" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/New_York" className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-background px-2 py-1.5 text-[12px]" />
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => void save()} disabled={state === "saving"} className="rounded-md bg-brand-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-primary-hover disabled:opacity-60">{state === "saving" ? "Saving…" : "Save"}</button>
        <button type="button" onClick={() => setEdit(false)} className="rounded-md border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-subtle">Cancel</button>
        {msg ? <span className={`text-[10px] ${state === "error" ? "text-negative" : "text-text-muted"}`}>{msg}</span> : null}
      </div>
      <p className="text-[10px] text-text-muted">Local send time for this rooftop · applies on the next scheduled run.</p>
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
    if (r.ok) { setState("done"); setMsg("CSM saved ✓ — email enabled for sales + service"); setOpen(false); onSaved?.(); setTimeout(() => setState("idle"), 1800); }
    else { setState("error"); setMsg(r.error || "Save failed"); }
  };
  if (assigned && !open) {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-text-primary">{rooftop.csm}</div>
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
      <p className="text-[10px] text-text-muted">Name + email required · saving enables email for both sales & service on this rooftop.</p>
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
  onSend,
  onReload,
}: {
  rooftop: RooftopRow;
  dept?: DeptKind;
  metrics?: DigestMetrics;
  reportDate?: string;
  sentRecipients?: { email: string; received?: boolean; bounced?: boolean }[];
  isSent: boolean;
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
      const base = (d.allRecipients ?? d.recipients).map((r) => ({ ...r, received: r.received || recvByEmail.get(r.email.toLowerCase()) || false }));
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

  // the REAL send — to a specific set of emails for a department
  const sendTo = async (emails: string[], deptKind: DeptKind): Promise<SendResult> => {
    const r = await sendDigestNow({
      teamId: rooftop.team_id,
      enterpriseId: rooftop.enterprise_id,
      dept: (deptKind ?? dept) as DeptKind | undefined,
      rooftopName: rooftop.name,
      timezone: rooftop.timezone,
      localDate: reportDate || "",
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

  const noData = !hasSendableData(metrics);

  return (
    <div className="space-y-4">
      {noData ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-1.5 text-[11px] leading-snug text-warning">
          No data for this day — there’s nothing to send, so sending is disabled. You can still add/enable recipients; they’ll receive on the next day with activity.
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
                    title={noData ? "No data for this day — nothing to send" : undefined}
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
  disabled = false,
}: {
  recipient: Recipient;
  isSent: boolean;
  checked: boolean;
  onToggle: () => void;
  onSend: (email: string) => Promise<SendResult>;
  onToggleEnabled?: (next: boolean) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(recipient.email);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  const hasEmail = validEmail(recipient.email);
  const valid = validEmail(draft);
  const enabled = recipient.enabled !== false; // undefined (e.g. sent-run recipients) → treat as on

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
    <li className={`flex items-center gap-2 rounded-md border border-border-subtle px-3 py-2 ${recipient.received ? "bg-positive/5" : "bg-surface-background"}`}>
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
    </li>
  );
}

/* ============================================================
   Reason field-status grid (not-sent view)
   ============================================================ */
function ReasonFieldStatus({ rooftop, reason }: { rooftop: RooftopRow; reason: NotSentReason }) {
  const allRecipients = rooftop.departments.flatMap((d) => d.recipients);
  const goodRecipients = allRecipients.filter((r) => r.email && r.email !== "m");
  const fields: { label: string; value: string; ok: boolean }[] = [
    {
      label: "Department classified",
      value: rooftop.departments.length > 0 ? rooftop.departments.map((d) => d.kind).join(" + ") : "—",
      ok: rooftop.departments.length > 0,
    },
    {
      label: "Recipients",
      value:
        allRecipients.length === 0
          ? "—"
          : goodRecipients.length === 0
          ? 'Placeholder ("m")'
          : `${goodRecipients.length} valid`,
      ok: goodRecipients.length > 0,
    },
    {
      label: "Agents live",
      value: rooftop.agents_live.length > 0 ? `${rooftop.agents_live.length} detected` : "—",
      ok: rooftop.agents_live.length > 0,
    },
  ];
  if (reason === "smtp_timeout" || reason === "scheduler_skipped" || reason === "bounced") {
    fields.push({
      label: "Send pipeline",
      value:
        reason === "smtp_timeout" ? "SMTP timeout" : reason === "bounced" ? "Inbox bounce" : "Scheduler skipped",
      ok: false,
    });
  }
  return (
    <ul className="mt-3 divide-y divide-border-subtle rounded-md border border-border-subtle">
      {fields.map((f) => (
        <li key={f.label} className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="text-[12px] text-text-secondary">{f.label}</span>
          <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold ${f.ok ? "text-positive" : "text-negative"}`}>
            {f.ok ? "✓" : "✕"} {f.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ============================================================
   Fill-and-send form (not-sent view)
   ============================================================ */
function FixDataForm({
  rooftop,
  reason,
  dept,
  metrics,
  localDate,
  onSent,
}: {
  rooftop: RooftopRow;
  reason: NotSentReason;
  dept?: DeptKind;
  metrics?: DigestMetrics;
  localDate: string;
  onSent: () => void;
}) {
  const existing = rooftop.departments.flatMap((d) => d.recipients).find((r) => r.email && r.email !== "m");
  const [tag, setTag] = useState<DeptKind | "">(dept ?? rooftop.departments[0]?.kind ?? "");
  const [recipientsInput, setRecipientsInput] = useState(existing?.email ?? "");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  const inFlight = useRef(false);

  const showTag = reason === "tag_missing";
  const showRecipients =
    reason === "tag_missing" || reason === "recipient_placeholder" || reason === "recipients_missing" || reason === "bounced";
  const retryOnly = reason === "smtp_timeout" || reason === "scheduler_skipped";

  const recipientsValid = (() => {
    if (!showRecipients) return true;
    const list = recipientsInput.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    return list.length > 0 && list.every((e) => /\S+@\S+\.\S+/.test(e));
  })();
  const tagValid = showTag ? !!tag : true;
  const canSend = recipientsValid && tagValid;

  const doSend = async () => {
    if (inFlight.current || !canSend) return;
    inFlight.current = true;
    setState("sending"); setMsg("");
    const recips = recipientsInput.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    const r = await sendDigestNow({
      teamId: rooftop.team_id,
      enterpriseId: rooftop.enterprise_id,
      dept: (tag || dept) as DeptKind | undefined,
      rooftopName: rooftop.name,
      timezone: rooftop.timezone,
      localDate,
      metrics,
      recipients: recips,
    });
    if (r.ok) { setState("sent"); setMsg(r.error || "Sent ✓"); setTimeout(onSent, 1200); }
    else { setState("error"); setMsg(r.error || "Send failed"); }
    inFlight.current = false;
  };

  return (
    <div className="space-y-3">
      {showTag ? (
        <div>
          <label className="text-[11px] font-semibold text-text-secondary">Classify this rooftop</label>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {(["sales", "service"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTag(t)}
                className={`rounded-md border px-3 py-2 text-[12px] font-semibold capitalize ${
                  tag === t
                    ? "border-brand-primary bg-brand-soft text-brand-primary"
                    : "border-border-subtle bg-surface-card text-text-secondary hover:bg-surface-subtle"
                }`}
              >
                {t === "sales" ? "Sales · inbound" : "Service · inbound"}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {showRecipients ? (
        <div>
          <label className="flex items-baseline justify-between text-[11px] font-semibold text-text-secondary">
            <span>Recipient email(s)</span>
            <span className="text-[10px] font-normal text-text-muted">comma-separated</span>
          </label>
          <input
            type="text"
            value={recipientsInput}
            onChange={(e) => setRecipientsInput(e.target.value)}
            placeholder="manager@dealership.com, owner@dealership.com"
            className="mt-1 w-full rounded-md border border-border-subtle bg-surface-card px-3 py-2 text-[12px] placeholder:text-text-muted focus:border-brand-primary focus:outline-none"
          />
          {!recipientsValid && recipientsInput.trim() ? (
            <p className="mt-1 text-[11px] text-negative">One or more addresses look invalid.</p>
          ) : null}
        </div>
      ) : null}

      {retryOnly ? (
        <p className="rounded-md border border-info-border bg-info-soft px-3 py-2 text-[12px] leading-snug text-info">
          No data fix needed — this is a send-pipeline issue. Retry to dispatch now.
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
        <button
          type="button"
          onClick={doSend}
          disabled={!canSend || state === "sending" || state === "sent"}
          className={`rounded-md px-3 py-2 text-[12px] font-semibold ${
            state === "sent"
              ? "bg-positive/10 text-positive"
              : state === "error"
              ? "bg-negative-soft text-negative"
              : canSend
              ? "bg-brand-primary text-white hover:bg-brand-primary-hover"
              : "cursor-not-allowed bg-surface-subtle text-text-muted"
          }`}
        >
          {state === "sending" ? "Sending…" : state === "sent" ? "✓ Sent" : state === "error" ? "Retry send" : retryOnly ? "Retry & send now" : "Save & send now"}
        </button>
        <span className="text-[10px] text-text-muted">
          {msg || (retryOnly ? "Re-runs the send job" : "Sends a real email + records it")}
        </span>
      </div>
    </div>
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
        <iframe title={isSent ? "Email — exact HTML sent" : exact ? "Daily digest — stored body" : "Daily digest — default template"} srcDoc={html} className="block w-full bg-white" style={{ height: 980, border: 0 }} />
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
          ? "This rooftop had valid, actionable activity, so the digest WAS generated — but emails are OFF (dry-run). Use “Re-run (dry-run)” to regenerate it. Real sending stays disabled until you flip dry-run off and let the scheduled cron run."
          : "The digest was generated but not sent. Use “Re-run (dry-run)” to regenerate the preview — no email is sent from the tracker."}
      </p>
    </div>
  );
}

/* ============================================================
   Dry-run trigger (suppressed cells)
   Fires the 4-cron pipeline for THIS rooftop in forced dry-run:
   cron1→2→3 regenerate metrics + HTML, cron4 SUPPRESSES (no email sent).
   ============================================================ */
function DryRunSection({ rooftop, onDone }: { rooftop: RooftopRow; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string>("");
  const click = async () => {
    setState("running");
    const r = await runDryPipeline({ teamId: rooftop.team_id });
    if (r.simulated) {
      setState("done");
      setMsg("Simulated (no backend configured).");
      setTimeout(onDone, 700);
    } else if (r.ok) {
      setState("done");
      const b = r.body as { cron4?: { body?: { suppressed?: number } } } | undefined;
      setMsg(`Regenerated · ${b?.cron4?.body?.suppressed ?? 0} suppressed (dry-run). No email sent.`);
      setTimeout(onDone, 900);
    } else {
      setState("error");
      setMsg(r.status === 404 ? "Functions not deployed yet." : r.error ?? `Error ${r.status ?? ""}`);
    }
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={click}
        disabled={state === "running" || state === "done"}
        className={`w-full rounded-md px-3 py-2 text-[12px] font-semibold ${
          state === "done"
            ? "bg-positive/10 text-positive"
            : state === "error"
            ? "bg-negative-soft text-negative"
            : "bg-brand-primary text-white hover:bg-brand-primary-hover disabled:opacity-60"
        }`}
      >
        {state === "running" ? "Running pipeline…" : state === "done" ? "✓ Regenerated (dry-run)" : state === "error" ? "Failed — retry" : "Re-run (dry-run)"}
      </button>
      <p className="text-[10px] text-text-muted">
        {msg ||
          (isPipelineConfigured
            ? "Runs cron1→4 for this rooftop with dry-run forced ON. Regenerates the digest + HTML and records it suppressed — no email is sent."
            : "No backend configured (VITE_SUPABASE_URL) — this simulates the run.")}
      </p>
    </div>
  );
}

/* ============================================================
   Periodic (weekly/monthly) generate → preview → manually send.
   Two explicit steps: ① render the digest (rolling window) and show it in the
   left pane WITHOUT sending; ② send the real email on a deliberate click.
   ============================================================ */
function PeriodicGenerateSection({
  rooftop,
  dept,
  cadence,
  recipients,
  onPreview,
  onSent,
  onIgnore,
}: {
  rooftop: RooftopRow;
  dept?: DeptKind;
  cadence: SendCell["cadence"];
  recipients?: { email: string }[];
  onPreview: (html: string | null) => void;
  onSent: () => void;
  onIgnore?: () => void;
}) {
  const [pState, setPState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [pMsg, setPMsg] = useState("");
  const [sState, setSState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [sMsg, setSMsg] = useState("");
  const [previewed, setPreviewed] = useState(false);
  const inFlight = useRef(false);
  const autoDone = useRef(false);
  const windowLabel = cadence === "weekly" ? "last 7 days" : cadence === "monthly" ? "last 30 days" : "yesterday";
  const emails = (recipients ?? []).map((r) => r.email).filter(Boolean);

  // ① Generate preview — render only, show on the left, no email.
  const preview = useCallback(async () => {
    setPState("running"); setPMsg("");
    const r = await generatePreviewNow({ cadence, teamId: rooftop.team_id, dept });
    if (r.ok && r.preview) {
      onPreview(r.preview.html);
      setPreviewed(true);
      setPState("done");
      setPMsg(r.preview.hasData
        ? `Preview ready · ${r.preview.dateLabel}`
        : `Preview ready, but no ${cadence} activity (${r.preview.reason ?? "no data"}) — a send would be skipped.`);
    } else {
      setPState("error"); setPMsg(r.error ?? "Preview failed");
    }
    setTimeout(() => setPState((s) => (s === "error" ? s : "idle")), 4000);
  }, [cadence, rooftop.team_id, dept, onPreview]);

  // Auto-generate the preview as soon as the drawer opens on this cell — clicking the
  // empty cell should immediately show the rendered email, then the user decides.
  useEffect(() => { if (!autoDone.current) { autoDone.current = true; void preview(); } }, [preview]);

  // ② Send — deliberate, confirmed, real email (honours the rooftop's dry-run flag).
  const send = async () => {
    if (inFlight.current) return;
    if (!emails.length) { setSState("error"); setSMsg("No recipients configured for this department."); return; }
    const ok = window.confirm(
      `Send the ${cadence} digest now?\n\nReal email to ${emails.length} recipient(s) via mail.spyne.ai. Honours the rooftop's dry-run flag (held if dry-run is on).`,
    );
    if (!ok) return;
    inFlight.current = true; setSState("sending"); setSMsg("");
    const r = await generateAndSendNow({ cadence, teamId: rooftop.team_id, dept });
    if (r.ok) {
      const s = r.summary;
      setSState("sent");
      setSMsg(s
        ? (s.sent > 0 ? `Sent ✓ → ${emails.join(", ")}`
          : s.suppressed > 0 ? "Held — rooftop is dry-run (no email sent)."
          : s.no_data > 0 ? "No data for this window — nothing sent."
          : s.no_recipients > 0 ? "No recipients — nothing sent."
          : "Done — nothing sent.")
        : `Sent ✓ → ${emails.join(", ")}`);
      setTimeout(onSent, 1200);
    } else {
      setSState("error"); setSMsg(r.error ?? "Send failed");
    }
    inFlight.current = false;
  };

  const btnBase = "w-full rounded-md px-3 py-2 text-[12px] font-semibold disabled:opacity-60";
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={preview}
          disabled={pState === "running"}
          className={`${btnBase} ${pState === "error" ? "bg-negative-soft text-negative" : pState === "done" ? "bg-positive/10 text-positive" : "border border-border-subtle bg-surface-card text-text-primary hover:bg-surface-subtle"}`}
        >
          {pState === "running" ? "Generating preview…" : pState === "done" ? "✓ Preview updated — regenerate" : pState === "error" ? "Retry preview" : `① Generate ${cadence} preview`}
        </button>
        <p className="text-[10px] text-text-muted">{pMsg || `Builds the ${cadence} digest (${windowLabel}) and shows it on the left. No email is sent.`}</p>
      </div>
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={send}
          disabled={sState === "sending" || !emails.length}
          title={!emails.length ? "No recipients configured for this department." : !previewed ? "Tip: generate the preview first." : undefined}
          className={`${btnBase} ${sState === "sent" ? "bg-positive/10 text-positive" : sState === "error" ? "bg-negative-soft text-negative" : "bg-brand-primary text-white hover:bg-brand-primary-hover"}`}
        >
          {sState === "sending" ? `Sending ${cadence}…` : sState === "sent" ? "✓ Sent — resend" : sState === "error" ? "Retry send" : `② Send to customer`}
        </button>
        <p className="text-[10px] text-text-muted">{sMsg || `Emails the ${cadence} digest to ${emails.join(", ") || "the recipients"} via mail.spyne.ai. Honours dry-run.`}</p>
      </div>
      {onIgnore ? (
        <button
          type="button"
          onClick={onIgnore}
          className={`${btnBase} border border-border-subtle bg-surface-card text-text-secondary hover:bg-surface-subtle`}
        >
          Ignore — don’t send
        </button>
      ) : null}
    </div>
  );
}

/* ============================================================
   Send-now LIVE — REALLY sends, on click, via the local send server
   (email-render/server.cjs), which renders the actual component and POSTs to
   mail.spyne.ai with the server-held token. Click = send. No confirm.
   ============================================================ */
function SendNowLiveSection({
  rooftop,
  recipients,
  metrics,
  dept,
  reportDate,
  cadence = "daily",
  onSent,
}: {
  rooftop: RooftopRow;
  recipients?: { email: string }[];
  metrics?: DigestMetrics;
  dept?: DeptKind;
  reportDate?: string;
  cadence?: SendCell["cadence"];
  onSent: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  const inFlight = useRef(false); // guarantees ONE send per click (no double-fire)
  const emails = (recipients ?? []).map((r) => r.email).filter(Boolean);

  // Weekly/monthly are generated server-side in real time (rolling 7/30-day window),
  // since the cell's stored metrics aren't that cadence's aggregate. Daily uses the
  // fast path that renders the stored metrics client-side and sends them.
  const isPeriodic = cadence === "weekly" || cadence === "monthly";
  const windowLabel = cadence === "weekly" ? "last 7 days" : cadence === "monthly" ? "last 30 days" : "yesterday";
  const noData = !isPeriodic && !hasSendableData(metrics); // server re-fetches for periodic, so don't block locally

  const click = async () => {
    if (inFlight.current) return; // already sending — ignore extra clicks
    if (!emails.length) { setState("error"); setMsg("No recipients configured for this department."); return; }
    if (noData) { setState("error"); setMsg("No data for this day — nothing to send."); return; }
    inFlight.current = true;
    setState("sending"); setMsg("");
    const r = isPeriodic
      ? await generateAndSendNow({ cadence, teamId: rooftop.team_id, dept })
      : await sendDigestNow({
          teamId: rooftop.team_id,
          enterpriseId: rooftop.enterprise_id,
          dept,
          rooftopName: rooftop.name,
          timezone: rooftop.timezone,
          localDate: reportDate || "",
          metrics,
          recipients: emails,
        });
    if (r.ok) {
      setState("sent");
      if (isPeriodic) {
        const s = (r as { summary?: { sent: number; suppressed: number; no_data: number; errors: number } }).summary;
        setMsg(s ? (s.sent > 0 ? `Sent ✓ → ${emails.join(", ")}` : s.suppressed > 0 ? "Held — rooftop is dry-run (no email sent)." : s.no_data > 0 ? "No data for this window — nothing sent." : "Done — nothing sent.") : `Sent ✓ → ${emails.join(", ")}`);
      } else {
        setMsg(r.error ? r.error : `Sent ✓ → ${emails.join(", ")}`);
      }
      setTimeout(onSent, 1200);
    } else {
      setState("error");
      setMsg(r.error ?? "Send failed");
    }
    inFlight.current = false; // release — a later deliberate click may resend
  };

  const label = isPeriodic
    ? (state === "sending" ? `Generating ${cadence}…` : state === "sent" ? "✓ Sent — regenerate" : state === "error" ? "Retry" : `✦ Generate & send ${cadence}`)
    : (noData ? "No data — can’t send" : state === "sending" ? "Sending…" : state === "sent" ? "✓ Sent — resend" : state === "error" ? "Retry send" : "Send now (real email)");

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={click}
        disabled={state === "sending" || noData}
        title={noData ? "No data for this day — nothing to send" : undefined}
        className={`w-full rounded-md px-3 py-2 text-[12px] font-semibold ${
          noData
            ? "cursor-not-allowed bg-surface-subtle text-text-muted"
            : state === "sent"
            ? "bg-positive/10 text-positive"
            : state === "error"
            ? "bg-negative-soft text-negative"
            : isPeriodic
            ? "bg-brand-primary text-white hover:bg-brand-primary-hover disabled:opacity-60"
            : "bg-negative text-white hover:opacity-90 disabled:opacity-60"
        }`}
      >
        {label}
      </button>
      <p className="text-[10px] text-text-muted">
        {msg || (isPeriodic
          ? `Builds the ${cadence} digest in real time (${windowLabel}) and emails it to ${emails.join(", ") || "the recipients"} via mail.spyne.ai. Honours the rooftop's dry-run flag.`
          : `Clicking sends a real email to ${emails.join(", ") || "the recipients"} via mail.spyne.ai (renders the actual digest).`)}
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
