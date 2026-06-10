/**
 * Tracker data source — maps Supabase roi_* rows into the tracker's existing
 * RooftopRow shape, so the UI is unchanged. Falls back to mock data when
 * Supabase isn't configured.
 *
 * Reads:
 *   roi_digest_runs        → per-rooftop daily/weekly/monthly send cells (digest logs)
 *   roi_digest_runs.recipients → per-recipient received/bounced (mailservice data)
 *   roi_rooftop_config     → rooftop display name + enterprise
 *   roi_recipients         → recipient list + department routing
 *   roi_live_departments   → which departments/agents are live
 */
import { supabase, isSupabaseConfigured } from "./supabaseClient";
import {
  ROOFTOPS as MOCK_ROOFTOPS,
  TRACKER_META,
  type AgentType,
  type Cadence,
  type CellRun,
  type Department,
  type DeptKind,
  type DigestMetrics,
  type NotSentReason,
  type Recipient,
  type RooftopRow,
  type SendCell,
  type SendStatus,
} from "./mockData";

export type RooftopSource = "supabase" | "mock";
export type LoadResult = {
  rooftops: RooftopRow[];
  source: RooftopSource;
  today: string; // ISO anchor for column labels
  lastSynced: Date;
};

type RunRow = {
  team_id: string;
  enterprise_id: string | null;
  department: DeptKind;
  cadence: Cadence;
  local_date: string;
  status: SendStatus;
  reason: string | null;
  recipients: { email: string; name?: string; received?: boolean; bounced?: boolean }[] | null;
  metrics: DigestMetrics | null;
  rendered_html: string | null;
  message_id: string | null;
  sent_at: string | null;
};
type ConfigRow = { team_id: string; enterprise_id: string | null; rooftop_name: string | null; timezone: string | null; csm_name: string | null };
type RecipientRow = {
  team_id: string; email: string; name: string | null;
  receives_sales: boolean; receives_service: boolean; email_enabled: boolean;
};
type LiveRow = { team_id: string; department: DeptKind; is_live: boolean; dry_run?: boolean };

const CADENCE_LEN: Record<Cadence, number> = { daily: 14, weekly: 8, monthly: 6 };

/* ── reason mapping: backend canonical → tracker NotSentReason ─────────────── */
const TRACKER_REASONS = new Set<NotSentReason>([
  "recipients_missing", "tag_missing", "recipient_placeholder",
  "smtp_timeout", "scheduler_skipped", "silent_day", "bounced",
]);
function normReason(r: string | null): NotSentReason {
  if (r && TRACKER_REASONS.has(r as NotSentReason)) return r as NotSentReason;
  switch (r) {
    case "not_eligible": return "tag_missing";
    case "before_send_hour": return "scheduler_skipped";
    case "no_data":
    case "not_actionable":
    case "guardrail_failed": return "silent_day";
    case "not_subscribed": return "recipients_missing";
    case "mail_error": return "smtp_timeout";
    default: return "scheduler_skipped";
  }
}

/* ── date helpers (UTC, anchored) ──────────────────────────────────────────── */
function shift(anchor: string, unit: Cadence, n: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (unit === "daily") dt.setUTCDate(dt.getUTCDate() - n);
  else if (unit === "weekly") dt.setUTCDate(dt.getUTCDate() - n * 7);
  else dt.setUTCMonth(dt.getUTCMonth() - n);
  return dt.toISOString().slice(0, 10);
}

/** Aggregate all department runs on one date into one rooftop-level cell. */
function aggregateCell(date: string, cadence: Cadence, runs: RunRow[]): SendCell {
  const cellRuns: CellRun[] = runs.map(r => ({
    department: r.department,
    status: r.status,
    reason: r.reason ?? undefined,
    metrics: r.metrics ?? undefined,
    renderedHtml: r.rendered_html ?? undefined,
    recipients: r.recipients ?? undefined,
  }));
  const cell = (status: SendStatus, reason?: NotSentReason): SendCell => ({
    date, cadence, status, reason, runs: cellRuns,
  });

  if (!runs.length) return cell("not_subscribed");
  if (runs.some(r => r.status === "sent")) return cell("sent");
  if (runs.some(r => r.status === "suppressed")) {
    const s = runs.find(r => r.status === "suppressed");
    return cell("suppressed", normReason(s?.reason ?? null));
  }
  if (runs.some(r => r.status === "scheduled")) return cell("scheduled");
  const ns = runs.find(r => r.status === "not_sent");
  return cell("not_sent", normReason(ns?.reason ?? null));
}

export async function loadRooftops(): Promise<LoadResult> {
  if (!isSupabaseConfigured || !supabase) {
    return { rooftops: MOCK_ROOFTOPS, source: "mock", today: TRACKER_META.today, lastSynced: new Date() };
  }

  const [runsRes, cfgRes, recRes, liveRes] = await Promise.all([
    supabase.from("roi_digest_runs")
      .select("team_id,enterprise_id,department,cadence,local_date,status,reason,recipients,metrics,rendered_html,message_id,sent_at")
      .order("local_date", { ascending: false }).limit(5000),
    supabase.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,csm_name"),
    supabase.from("roi_recipients").select("team_id,email,name,receives_sales,receives_service,email_enabled"),
    supabase.from("roi_live_departments").select("team_id,department,is_live,dry_run"),
  ]);

  const err = runsRes.error || cfgRes.error || recRes.error || liveRes.error;
  if (err) {
    console.warn("[tracker] Supabase read failed, falling back to mock:", err.message);
    return { rooftops: MOCK_ROOFTOPS, source: "mock", today: TRACKER_META.today, lastSynced: new Date() };
  }

  const runs = (runsRes.data ?? []) as RunRow[];
  const configs = (cfgRes.data ?? []) as ConfigRow[];
  const recipients = (recRes.data ?? []) as RecipientRow[];
  const lives = (liveRes.data ?? []) as LiveRow[];

  // index by team
  const cfgByTeam = new Map(configs.map(c => [c.team_id, c]));
  // one entry per (team, department) that is live → drives one tracker row each
  const liveEntries = lives.filter(l => l.is_live);
  const recByTeam = new Map<string, RecipientRow[]>();
  for (const r of recipients) {
    const arr = recByTeam.get(r.team_id) ?? [];
    arr.push(r); recByTeam.set(r.team_id, arr);
  }
  const runsByTeam = new Map<string, RunRow[]>();
  for (const r of runs) {
    const arr = runsByTeam.get(r.team_id) ?? [];
    arr.push(r); runsByTeam.set(r.team_id, arr);
  }

  // anchor "today" = latest daily run date, else real today
  const dailyDates = runs.filter(r => r.cadence === "daily").map(r => r.local_date).sort();
  const today = dailyDates.length ? dailyDates[dailyDates.length - 1] : new Date().toISOString().slice(0, 10);

  // anchor recomputed above; build cells for ONE department's runs
  function buildCells(deptRuns: RunRow[], cadence: Cadence): SendCell[] {
    const byDate = new Map<string, RunRow[]>();
    for (const r of deptRuns) {
      if (r.cadence !== cadence) continue;
      const arr = byDate.get(r.local_date) ?? [];
      arr.push(r); byDate.set(r.local_date, arr);
    }
    return Array.from({ length: CADENCE_LEN[cadence] }, (_, i) => {
      const date = shift(today, cadence, i);
      return aggregateCell(date, cadence, byDate.get(date) ?? []);
    });
  }

  // ONE ROW PER (team, department) — separate tracking per department.
  const rooftops: RooftopRow[] = liveEntries.map((live) => {
    const teamId = live.team_id;
    const dept = live.department;
    const cfg = cfgByTeam.get(teamId);
    const deptRuns = (runsByTeam.get(teamId) ?? []).filter(r => r.department === dept);
    const enterpriseId = cfg?.enterprise_id ?? deptRuns[0]?.enterprise_id ?? undefined;
    const agents: AgentType[] = [dept === "service" ? "service_ib" : "sales_ib"];

    // received map from the latest run carrying recipients
    const recvMap = new Map<string, boolean>();
    const latestWithRecips = deptRuns
      .filter(r => Array.isArray(r.recipients))
      .sort((a, b) => (a.local_date < b.local_date ? 1 : -1))[0];
    for (const rec of latestWithRecips?.recipients ?? []) {
      recvMap.set(rec.email.toLowerCase(), rec.received === true && rec.bounced !== true);
    }
    const recips: Recipient[] = (recByTeam.get(teamId) ?? [])
      .filter(r => (dept === "sales" ? r.receives_sales : r.receives_service) && r.email_enabled)
      .map(r => ({ email: r.email, name: r.name ?? undefined, received: recvMap.get(r.email.toLowerCase()) ?? false }));

    const departments: Department[] = [{ kind: dept, live: true, agents, recipients: recips }];
    const daily = buildCells(deptRuns, "daily");
    const current_block = daily[0] && daily[0].status === "not_sent" ? daily[0].reason ?? null : null;

    return {
      rooftop_id: `${teamId}::${dept}`,
      name: cfg?.rooftop_name || teamId,
      enterprise_id: enterpriseId,
      team_id: teamId,
      department: dept,
      dryRun: live.dry_run !== false, // default true (dry-run on) when unset
      timezone: cfg?.timezone ?? undefined,
      csm: cfg?.csm_name?.trim() || "Unassigned",
      group: enterpriseId ? `Ent ${enterpriseId.slice(0, 6)}` : undefined,
      agents_live: agents,
      departments,
      current_block,
      daily,
      weekly: buildCells(deptRuns, "weekly"),
      monthly: buildCells(deptRuns, "monthly"),
    };
  })
  // GROUP BY ROOFTOP — both departments of a rooftop sit together (sales above service),
  // rooftops ordered alphabetically. (Replaces the previous "sent-first" split that scattered
  // a rooftop's two department rows apart.)
  .sort((a, b) =>
    a.name.localeCompare(b.name) ||
    (a.team_id ?? "").localeCompare(b.team_id ?? "") ||
    (a.department ?? "").localeCompare(b.department ?? "")
  );

  return { rooftops, source: "supabase", today, lastSynced: new Date() };
}
