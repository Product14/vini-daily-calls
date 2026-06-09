import { useEffect, useMemo, useRef, useState } from "react";
import {
  NOT_SENT_REASON_LABEL,
  type DeptKind,
  type DigestMetrics,
  type NotSentReason,
  type Recipient,
  type RooftopRow,
  type SendCell,
} from "./mockData";
import { isPipelineConfigured, runDryPipeline, sendViaServer } from "./pipeline";
import { renderDigestEmail } from "./renderDigest";

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
type DrawerProps = {
  rooftop: RooftopRow | null;
  cell: SendCell | null;
  onClose: () => void;
  onSend: (rooftopId: string, date: string, cadence: SendCell["cadence"]) => void;
  /** Reload tracker data after a dry-run pipeline trigger (rows change status). */
  onReload?: () => void;
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

export function RooftopCellDrawer({ rooftop, cell, onClose, onSend, onReload }: DrawerProps) {
  const open = !!(rooftop && cell);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

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
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

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

  const statusLabel = isSent ? "Sent" : isSuppressed ? "Suppressed" : NOT_SENT_REASON_LABEL[reason];
  const statusChip = isSent
    ? "bg-positive/10 text-positive"
    : isSuppressed
    ? "bg-warning-soft text-warning"
    : "bg-negative-soft text-negative";

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-surface-background transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
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
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-md border border-border-subtle bg-surface-card px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-subtle"
        >
          Close ✕
        </button>
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
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              {isSent
                ? primary?.renderedHtml
                  ? "Email sent · exact HTML"
                  : "Email sent · re-rendered from stored metrics"
                : "Daily digest · preview (not sent)"}
            </div>
            <DigestEmail rooftop={rooftop} cell={cell} metrics={metrics} dept={dept} renderedHtml={primary?.renderedHtml} />
          </div>

          <aside className="space-y-4">
            {isSent ? (
              <>
                <Section eyebrow="Sent to" title="Email IDs on this send">
                  <SentToList recipients={primary?.recipients} />
                </Section>
                <Section eyebrow="Recipients" title="Manage recipients">
                  <RecipientManager rooftop={rooftop} onSend={() => onSend(rooftop.rooftop_id, cell.date, cell.cadence)} />
                </Section>
              </>
            ) : isSuppressed ? (
              <>
                <Section eyebrow="Will send to" title="Recipients on send">
                  <SentToList recipients={primary?.recipients} pending />
                </Section>
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
                    onSend={() => {
                      onSend(rooftop.rooftop_id, cell.date, cell.cadence);
                      onClose();
                    }}
                  />
                </Section>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
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
function RecipientManager({ rooftop, onSend }: { rooftop: RooftopRow; onSend: () => void }) {
  // Local editable copy so add-email / send reflect immediately
  const [depts, setDepts] = useState(() =>
    rooftop.departments.map((d) => ({
      kind: d.kind,
      recipients: d.recipients.map((r) => ({ ...r })),
    }))
  );

  const markReceived = (deptKind: DeptKind, idx: number) => {
    setDepts((prev) =>
      prev.map((d) =>
        d.kind === deptKind
          ? { ...d, recipients: d.recipients.map((r, i) => (i === idx ? { ...r, received: true } : r)) }
          : d
      )
    );
  };

  const setEmail = (deptKind: DeptKind, idx: number, email: string) => {
    setDepts((prev) =>
      prev.map((d) =>
        d.kind === deptKind
          ? { ...d, recipients: d.recipients.map((r, i) => (i === idx ? { ...r, email } : r)) }
          : d
      )
    );
  };

  const addRecipient = (deptKind: DeptKind) => {
    setDepts((prev) =>
      prev.map((d) =>
        d.kind === deptKind
          ? { ...d, recipients: [...d.recipients, { email: "", received: false }] }
          : d
      )
    );
  };

  if (depts.length === 0) {
    return <p className="text-[12px] text-text-muted">No departments classified for this rooftop.</p>;
  }

  return (
    <div className="space-y-4">
      {depts.map((d) => (
        <div key={d.kind}>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-widest capitalize text-text-secondary">
              {d.kind} department
            </span>
            <span className="text-[10px] text-text-muted">
              {d.recipients.filter((r) => r.received).length}/{d.recipients.length} received
            </span>
          </div>
          {d.recipients.length === 0 ? (
            <button
              type="button"
              onClick={() => addRecipient(d.kind)}
              className="w-full rounded-md border border-dashed border-border-strong bg-surface-background px-3 py-2 text-[12px] font-semibold text-text-secondary hover:border-brand-primary hover:text-brand-primary"
            >
              + Add recipient
            </button>
          ) : (
            <ul className="space-y-1.5">
              {d.recipients.map((rec, idx) => (
                <RecipientRow
                  key={idx}
                  recipient={rec}
                  onSetEmail={(email) => setEmail(d.kind, idx, email)}
                  onSend={() => {
                    markReceived(d.kind, idx);
                    onSend();
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function RecipientRow({
  recipient,
  onSetEmail,
  onSend,
}: {
  recipient: Recipient;
  onSetEmail: (email: string) => void;
  onSend: () => void;
}) {
  const [draft, setDraft] = useState(recipient.email);
  const hasEmail = recipient.email.trim() !== "" && recipient.email !== "m";
  const valid = /\S+@\S+\.\S+/.test(draft.trim());

  if (recipient.received) {
    return (
      <li className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-positive/5 px-3 py-2">
        <span className="min-w-0 truncate text-[12px] text-text-primary">{recipient.email}</span>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-positive">✓ Received</span>
      </li>
    );
  }

  // Not received · either has an email (bounce/retry) or needs an email
  if (hasEmail) {
    return (
      <li className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-background px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] text-text-primary">{recipient.email}</div>
          <div className="text-[10px] text-negative">Didn't receive</div>
        </div>
        <button
          type="button"
          onClick={onSend}
          className="shrink-0 rounded-md bg-brand-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-primary-hover"
        >
          Send to them
        </button>
      </li>
    );
  }

  // Missing email · inline add + send
  return (
    <li className="rounded-md border border-dashed border-warning/50 bg-warning-soft/40 px-3 py-2">
      <div className="text-[10px] font-semibold text-warning">No email on file · add one</div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="email"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onSetEmail(e.target.value);
          }}
          placeholder="name@dealership.com"
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-card px-2.5 py-1.5 text-[12px] placeholder:text-text-muted focus:border-brand-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!valid}
          className={`shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-semibold ${
            valid ? "bg-brand-primary text-white hover:bg-brand-primary-hover" : "cursor-not-allowed bg-surface-subtle text-text-muted"
          }`}
        >
          Add & send
        </button>
      </div>
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
  onSend,
}: {
  rooftop: RooftopRow;
  reason: NotSentReason;
  onSend: () => void;
}) {
  const existing = rooftop.departments.flatMap((d) => d.recipients).find((r) => r.email && r.email !== "m");
  const [tag, setTag] = useState<DeptKind | "">(rooftop.departments[0]?.kind ?? "");
  const [recipientsInput, setRecipientsInput] = useState(existing?.email ?? "");

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
          onClick={onSend}
          disabled={!canSend}
          className={`rounded-md px-3 py-2 text-[12px] font-semibold ${
            canSend ? "bg-brand-primary text-white hover:bg-brand-primary-hover" : "cursor-not-allowed bg-surface-subtle text-text-muted"
          }`}
        >
          {retryOnly ? "Retry & send now" : "Save & send now"}
        </button>
        <span className="text-[10px] text-text-muted">
          {retryOnly ? "Re-runs the send job" : "Saves data + dispatches"}
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
}: {
  rooftop: RooftopRow;
  cell: SendCell;
  metrics?: DigestMetrics;
  dept?: DeptKind;
  renderedHtml?: string;
}) {
  // Render the exact email-safe digest HTML (table layout, real console links) in an
  // iframe — the same HTML the mailer sends. Renders identically in-app and in inbox.
  if (metrics) {
    const html = renderDigestEmail(metrics, {
      rooftopName: rooftop.name,
      dept,
      teamId: rooftop.team_id,
      enterpriseId: rooftop.enterprise_id,
      reportDate: (metrics as { reportDate?: string }).reportDate ?? cell.date,
      timezone: rooftop.timezone,
    });
    return (
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-white">
        <iframe title="Daily digest preview" srcDoc={html} className="block w-full bg-white" style={{ height: 760, border: 0 }} />
      </div>
    );
  }
  // No metrics but exact provider HTML stored (real send) → show it verbatim.
  if (renderedHtml) {
    return (
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-white">
        <iframe title="Email sent" srcDoc={renderedHtml} className="block w-full bg-white" style={{ height: 700, border: 0 }} />
      </div>
    );
  }
  // Nothing stored → lightweight stub.
  return <EmailSnippetCard rooftop={rooftop} />;
}

/* ============================================================
   Sent-to email IDs (sent cells)
   ============================================================ */
function SentToList({
  recipients,
  pending,
}: {
  recipients?: { email: string; name?: string; received?: boolean; bounced?: boolean }[];
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
              r.bounced ? "text-negative" : r.received ? "text-positive" : pending ? "text-info" : "text-text-muted"
            }`}
          >
            {r.bounced ? "Bounced" : r.received ? "Received" : pending ? "Will send" : "Sent"}
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

  const click = async () => {
    if (inFlight.current) return; // already sending — ignore extra clicks
    if (!emails.length) { setState("error"); setMsg("No recipients configured for this department."); return; }
    if (!metrics) { setState("error"); setMsg("No metrics for this rooftop yet — resync first."); return; }
    inFlight.current = true;
    setState("sending"); setMsg("");
    const r = await sendViaServer({
      teamId: rooftop.team_id,
      enterpriseId: rooftop.enterprise_id,
      dept: dept as "sales" | "service" | undefined,
      rooftopName: rooftop.name,
      timezone: rooftop.timezone,
      reportDate,
      metrics: metrics as unknown as Record<string, unknown>,
      recipients: emails,
    });
    if (r.ok) {
      setState("sent");
      setMsg(`Sent ✓ → ${(r.to ?? emails).join(", ")}`);
      setTimeout(onSent, 1200);
    } else {
      setState("error");
      setMsg(r.error ?? `Send failed (HTTP ${r.status ?? "?"})`);
    }
    inFlight.current = false; // release — a later deliberate click may resend
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={click}
        disabled={state === "sending"}
        className={`w-full rounded-md px-3 py-2 text-[12px] font-semibold ${
          state === "sent"
            ? "bg-positive/10 text-positive"
            : state === "error"
            ? "bg-negative-soft text-negative"
            : "bg-negative text-white hover:opacity-90 disabled:opacity-60"
        }`}
      >
        {state === "sending" ? "Sending…" : state === "sent" ? "✓ Sent — resend" : state === "error" ? "Retry send" : "Send now (real email)"}
      </button>
      <p className="text-[10px] text-text-muted">
        {msg || `Clicking sends a real email to ${emails.join(", ") || "the recipients"} via mail.spyne.ai (renders the actual digest).`}
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
