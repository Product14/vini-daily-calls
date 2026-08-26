import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackerAuthHeaders } from "./dataSource";

/* Realtime send feed — "what email just went out, anywhere in the fleet".
 *
 * Reads /api/tracker/realtime-feed, which merges the TWO tables a send can land in:
 *   roi_event_emails  — transactional (action items, overdue, post-conversation). ~6.4k/day.
 *   roi_digest_runs   — daily/weekly/monthly digests. ~60/day, in a burst at each rooftop's
 *                       local send hour, so a digest-only view reads as "dead" all afternoon.
 * Both are status='sent' only — held/not_sent/suppressed rows never count as "went out".
 * Rooftop names are resolved server-side from roi_rooftop_config (neither send table carries
 * a name column), so nothing here has to join. */

type FeedRow = {
  id: string;
  kind: "transactional" | "digest";
  type: string;
  teamId: string;
  rooftop: string;
  csm: string;
  department: string;
  subject: string;
  sentAt: string;
  recipients: number;
  opens: number;
  /** How many stored event rows this ONE delivery covers (rollup emails fan in on message_id). */
  events: number;
};

const WINDOWS = [
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
  { label: "24h", minutes: 1440 },
] as const;

const TYPE_LABEL: Record<string, string> = {
  action_item: "Action item",
  action_item_overdue: "Overdue",
  post_conversation: "Post-conversation",
  post_appointment: "Post-appointment",
  lead_capture: "Lead capture",
  daily: "Daily digest",
  weekly: "Weekly digest",
  monthly: "Monthly digest",
};

const DEPT_LABEL: Record<string, string> = {
  sales: "Sales",
  service: "Service",
  sales_ib: "Sales IB",
  sales_ob: "Sales OB",
  service_ib: "Service IB",
  service_ob: "Service OB",
};

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "just now" / "3m ago" — relative to the SERVER's clock, so a skewed laptop clock can't
 * render every row as hours old (or in the future). */
function fmtAgo(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function RealtimeLog() {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [windowMinutes, setWindowMinutes] = useState<number>(240);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [serverNowMs, setServerNowMs] = useState<number>(() => Date.now());
  const [truncated, setTruncated] = useState(false);
  // Ids seen on the PREVIOUS poll — anything outside this set is genuinely new and gets flashed.
  const seenRef = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  const fetchFeed = useCallback(async (minutes: number) => {
    try {
      const res = await fetch(`/api/tracker/realtime-feed?minutes=${minutes}&limit=200`, {
        headers: trackerAuthHeaders(),
      });
      if (!res.ok) {
        // Surface the failure instead of leaving an empty list that reads as "nothing is sending".
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      const next: FeedRow[] = data.rows ?? [];

      const prevSeen = seenRef.current;
      seenRef.current = new Set(next.map((r) => r.id));
      // First load shouldn't flash every row — only mark new arrivals after a baseline exists.
      setFreshIds(prevSeen ? new Set(next.filter((r) => !prevSeen.has(r.id)).map((r) => r.id)) : new Set());

      setRows(next);
      setTruncated(Boolean(data.truncated?.transactional || data.truncated?.digest));
      setServerNowMs(data.serverNow ? new Date(data.serverNow).getTime() : Date.now());
      setLastFetch(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch on window change; poll every 5s while live. Changing the window resets the
  // new-row baseline so a wider window doesn't flash its whole backlog as "new".
  useEffect(() => {
    seenRef.current = null;
    setLoading(true);
    fetchFeed(windowMinutes);
    if (!live) return;
    const id = setInterval(() => fetchFeed(windowMinutes), 5000);
    return () => clearInterval(id);
  }, [windowMinutes, live, fetchFeed]);

  const stats = useMemo(() => {
    const hourAgo = serverNowMs - 3600_000;
    const inHour = rows.filter((r) => new Date(r.sentAt).getTime() >= hourAgo);
    const sum = (rs: FeedRow[]) => rs.reduce((n, r) => n + (r.recipients || 0), 0);
    return {
      total: rows.length,
      transactional: rows.filter((r) => r.kind === "transactional").length,
      digest: rows.filter((r) => r.kind === "digest").length,
      lastHour: inHour.length,
      recipients: sum(rows),
    };
  }, [rows, serverNowMs]);

  const windowLabel = WINDOWS.find((w) => w.minutes === windowMinutes)?.label ?? `${windowMinutes}m`;

  return (
    <div className="flex h-full flex-col bg-surface-background">
      {/* Header */}
      <div className="border-b border-border-subtle bg-surface-card px-5 py-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[15px] font-bold text-text-primary">Realtime send feed</h1>
            <p className="text-[12px] text-text-secondary">
              Every email that left the system — transactional and digests, newest first.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-border-subtle">
              {WINDOWS.map((w) => (
                <button
                  key={w.minutes}
                  onClick={() => setWindowMinutes(w.minutes)}
                  className={`px-2.5 py-1.5 text-[12px] font-semibold ${
                    w.minutes === windowMinutes
                      ? "bg-brand-primary text-brand-foreground"
                      : "bg-surface-card text-text-secondary hover:bg-surface-subtle"
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setLive((v) => !v)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold ${
                live
                  ? "border-positive-ring bg-positive-soft text-positive"
                  : "border-border-subtle bg-surface-card text-text-secondary"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-positive" : "bg-text-tertiary"}`} />
              {live ? "Live" : "Paused"}
            </button>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: `Sent · last ${windowLabel}`, value: stats.total, tone: "text-text-primary" },
            { label: "Sent · last hour", value: stats.lastHour, tone: "text-positive" },
            { label: "Transactional", value: stats.transactional, tone: "text-text-primary" },
            { label: "Digests", value: stats.digest, tone: "text-text-primary" },
          ].map((k) => (
            <div key={k.label} className="rounded-lg border border-border-subtle bg-surface-card px-3 py-2 shadow-card">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{k.label}</div>
              <div className={`text-[22px] font-bold tabular-nums ${k.tone}`}>{k.value.toLocaleString()}</div>
            </div>
          ))}
        </div>

        <div className="mt-2 text-[11px] text-text-tertiary">
          {error ? (
            <span className="font-semibold text-negative">Feed error — {error}</span>
          ) : lastFetch ? (
            <>
              Updated {fmtClock(lastFetch.toISOString())} · refreshes every 5s ·{" "}
              {stats.recipients.toLocaleString()} recipients addressed
              {truncated ? (
                <span className="font-semibold text-warning"> · capped at the newest 200 — widen nothing, this window sent more</span>
              ) : null}
            </>
          ) : (
            "Loading…"
          )}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && rows.length === 0 ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border-subtle border-t-brand-primary" />
            <div className="text-[13px] font-semibold text-text-secondary">Loading feed…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-center">
            <div className="text-[14px] font-bold text-text-primary">No sends in the last {windowLabel}</div>
            <div className="max-w-md text-[12px] text-text-secondary">
              Digests go out in a burst at each rooftop's local send hour, so a quiet afternoon is
              normal. Widen to 24h before treating this as an outage.
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface-card shadow-card">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-subtle text-left text-[11px] uppercase tracking-wide text-text-muted">
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Rooftop</th>
                  <th className="px-3 py-2 font-semibold">Dept</th>
                  <th className="px-3 py-2 font-semibold">Email</th>
                  <th className="px-3 py-2 font-semibold">Subject</th>
                  <th className="px-3 py-2 text-right font-semibold">To</th>
                  <th className="px-3 py-2 text-right font-semibold">Opens</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b border-border-muted last:border-0 ${
                      freshIds.has(r.id) ? "bg-brand-soft" : "hover:bg-surface-subtle"
                    }`}
                  >
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-primary">
                      <span className="font-semibold">{fmtClock(r.sentAt)}</span>
                      <span className="ml-1.5 text-text-tertiary">{fmtAgo(r.sentAt, serverNowMs)}</span>
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 font-semibold text-text-primary" title={r.rooftop || r.teamId}>
                      {r.rooftop || r.teamId}
                      {r.csm ? <span className="ml-1.5 font-normal text-text-tertiary">· {r.csm}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                      {DEPT_LABEL[r.department] ?? r.department ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                          r.kind === "digest" ? "bg-info-soft text-info" : "bg-warning-soft text-warning"
                        }`}
                      >
                        {TYPE_LABEL[r.type] ?? r.type}
                      </span>
                    </td>
                    <td className="max-w-[320px] truncate px-3 py-2 text-text-secondary" title={r.subject}>
                      {r.subject || "—"}
                      {r.events > 1 ? (
                        <span className="ml-1.5 whitespace-nowrap text-text-tertiary" title="One email covering this many leads">
                          ({r.events} leads)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-primary">{r.recipients || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-secondary">{r.opens || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
