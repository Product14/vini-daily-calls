/**
 * Lightweight list for rooftops that aren't (yet) represented by a digest-cell grid row —
 * onboarding/contracting-stage accounts, and any churned account with no send history. These
 * exist so the onboarding team can find and pre-configure a rooftop (recipients, cadence,
 * template) *before* it goes technically live — today's tracker only ever shows rooftops that
 * already have a roi_live_departments row, so anything earlier in the customer lifecycle was
 * simply invisible.
 *
 * Deliberately NOT the digest grid (daily/weekly/monthly cells + KPI strip) — these rooftops
 * have no send history to show yet. "Configure" opens the same ConfigDrawer used everywhere
 * else in the tracker (recipients + email-type toggles + template/focus), which already works
 * off team_id alone.
 *
 * Churned rows also get a "Remove from Emailer" action — a churn tag alone doesn't stop the
 * cron (it only gates the tracker's own display + KPIs); this is the actual kill switch.
 */
import { useState } from "react";
import type { LifecycleStatus, RooftopRow } from "./mockData";

const STAGE_COLORS: Record<LifecycleStatus, { bg: string; fg: string }> = {
  live: { bg: "#dcfce7", fg: "#166534" },
  onboarding: { bg: "#dbeafe", fg: "#1e40af" },
  contracting: { bg: "#ede9fe", fg: "#5b21b6" },
  churn: { bg: "#fee2e2", fg: "#991b1b" },
};
const STAGE_LABEL: Record<LifecycleStatus, string> = {
  live: "Live", onboarding: "Onboarding", contracting: "Contracting", churn: "Churn",
};

/** Small colored pill for a rooftop's ACCOUNT-level lifecycle stage — distinct from the
 * per-department dry-run "Live/Paused/Not started" badge shown in the digest grid (that's a
 * technical send-status question; this is a business-stage question). Exported so the grid can
 * flag the same rare case this file exists for: a department already sending while its account
 * is still onboarding. */
export function LifecycleBadge({ status, sub }: { status: LifecycleStatus; sub?: string }) {
  const c = STAGE_COLORS[status];
  return (
    <span
      title={sub ? `Account stage: ${sub}` : undefined}
      className="ml-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
      style={{ background: c.bg, color: c.fg }}
    >
      {STAGE_LABEL[status]}
    </span>
  );
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

/** The one lifecycle date most relevant to a rooftop's CURRENT stage (what "days in stage" counts from). */
function stageDate(r: RooftopRow): string | null | undefined {
  if (r.lifecycleStatus === "churn") return r.lifecycleDates?.churn;
  if (r.lifecycleStatus === "onboarding") return r.lifecycleDates?.onboarding;
  return r.lifecycleDates?.contracted;
}

/** "Remove from Emailer" — the actual kill switch for a churned rooftop. Confirms, then hands off
 * to the caller's onStopEmails (which flips is_live=false on every department + all email-type
 * toggles off). Local busy/done state only — the parent's reload picks up the real result. */
function StopEmailerButton({ rooftop, onStopEmails }: { rooftop: RooftopRow; onStopEmails: (r: RooftopRow) => Promise<{ ok: boolean; error?: string }> }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const run = async () => {
    if (!window.confirm(`Stop ALL emails (daily/weekly/monthly + transactional) to ${rooftop.name}?\n\nThis is the real kill switch — the cron will never send this rooftop anything again until a human re-activates it.`)) return;
    setState("busy"); setMsg("");
    const res = await onStopEmails(rooftop);
    if (res.ok) { setState("done"); }
    else { setState("error"); setMsg(res.error || "Failed"); }
  };
  if (state === "done") return <span className="text-[11px] font-semibold text-positive">✓ Removed from emailer</span>;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={() => void run()}
        disabled={state === "busy"}
        title="Stop all digest + transactional emails to this rooftop"
        className="rounded-md border border-negative/40 bg-negative-soft px-2.5 py-1 text-[11px] font-semibold text-negative hover:bg-negative/10 disabled:opacity-60"
      >
        {state === "busy" ? "Removing…" : "Remove from emailer"}
      </button>
      {msg ? <span className="text-[10px] text-negative">{msg}</span> : null}
    </div>
  );
}

export function LifecycleList({ rooftops, onConfigure, onStopEmails }: {
  rooftops: RooftopRow[];
  onConfigure: (r: RooftopRow) => void;
  onStopEmails?: (r: RooftopRow) => Promise<{ ok: boolean; error?: string }>;
}) {
  if (!rooftops.length) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16 text-[13px] text-text-muted">
        No rooftops in this stage right now.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto bg-surface-background">
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-10 bg-surface-background">
          <tr>
            {["Rooftop", "Enterprise", "CSM / POC", "Stage", "Days in stage", ""].map((h) => (
              <th key={h} className="border-b border-border-subtle px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rooftops.map((r) => {
            const days = daysSince(stageDate(r));
            return (
              <tr key={r.team_id ?? r.rooftop_id} className="hover:bg-surface-subtle">
                <td className="border-b border-border-subtle px-4 py-2.5 text-[13px] font-semibold text-text-primary">{r.name}</td>
                <td className="border-b border-border-subtle px-4 py-2.5 text-[12px] text-text-secondary">{r.group ?? "—"}</td>
                <td className="border-b border-border-subtle px-4 py-2.5 text-[12px] text-text-secondary">{r.csm}</td>
                <td className="border-b border-border-subtle px-4 py-2.5">
                  <LifecycleBadge status={r.lifecycleStatus ?? "live"} sub={r.arrBucket} />
                </td>
                <td className="border-b border-border-subtle px-4 py-2.5 text-[12px] tabular text-text-secondary">
                  {days == null ? "—" : `${days}d`}
                </td>
                <td className="border-b border-border-subtle px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {r.lifecycleStatus === "churn" && onStopEmails ? (
                      <StopEmailerButton rooftop={r} onStopEmails={onStopEmails} />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onConfigure(r)}
                      className="rounded-md border border-border-subtle bg-surface-card px-2.5 py-1 text-[11px] font-semibold text-text-primary hover:bg-surface-subtle"
                    >
                      Configure
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
