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
  type AgentType,
  type Cadence,
  type CellRun,
  type DailyTemplate,
  type DigestFocus,
  type Department,
  type DeptKind,
  type DigestMetrics,
  type LifecycleStatus,
  type NotSentReason,
  type Recipient,
  type RooftopConfig,
  type RooftopRow,
  type SendCell,
  type SendStatus,
} from "./mockData";

export type RooftopSource = "supabase" | "unconfigured" | "error";
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
  recipients: { email: string; name?: string; received?: boolean; bounced?: boolean; opened?: boolean; opened_at?: string }[] | null;
  metrics: DigestMetrics | null;
  rendered_html: string | null;
  message_id: string | null;
  sent_at: string | null;
  opened_at: string | null;
  open_count: number | null;
};
type ConfigRow = { team_id: string; enterprise_id: string | null; rooftop_name: string | null; timezone: string | null; csm_name: string | null; cs_poc: string | null; digest_send_hour: number | null; digest_send_minute: number | null;
  daily_enabled: boolean | null; weekly_enabled: boolean | null; monthly_enabled: boolean | null;
  post_appointment_enabled: boolean | null; post_conversation_enabled: boolean | null; action_item_enabled: boolean | null; action_item_overdue_enabled: boolean | null;
  daily_template: string | null; digest_focus: string | null; sms_enabled: boolean | null;
  weekly_send_dow: number | null; monthly_send_day: number | null;
  lifecycle_status: string | null; arr_bucket: string | null; enterprise_name: string | null; team_name: string | null;
  contracted_date: string | null; onboarding_date: string | null; ob_live_date: string | null; live_date: string | null; churn_date: string | null;
  calls_30d: number | null; sms_30d: number | null; last_activity_at: string | null };

/** roi_rooftop_config.lifecycle_status → the tracker's LifecycleStatus, defaulting to "live" for
 * rooftops the lifecycle sync hasn't classified yet — never hides an already-visible rooftop. */
function toLifecycleStatus(v: string | null | undefined): LifecycleStatus {
  return v === "onboarding" || v === "contracting" || v === "churn" ? v : "live";
}
// Unfurl a corp email local-part into a display name: "ankur.batra@spyne.ai" →
// "Ankur Batra". Trailing dedup digits ("vishal.singh1") are stripped. Returns
// "" for blank/non-email input so callers can fall back.
function nameFromEmail(email: string | null | undefined): string {
  const s = String(email ?? "").trim();
  if (!s.includes("@")) return s; // already a plain name (or empty)
  const cap = (t: string) => { const x = t.replace(/\d+$/, "") || t; return x.charAt(0).toUpperCase() + x.slice(1); };
  return (s.toLowerCase().split("@")[0] || "")
    .split(/[._]+/).filter(Boolean)
    .map((p) => p.split("-").map(cap).join("-")).join(" ");
}

type RecipientRow = {
  team_id: string; email: string; name: string | null;
  receives_sales: boolean; receives_service: boolean; email_enabled: boolean;
  phone: string | null; sms_enabled: boolean | null; role: string | null;
};
type LiveRow = { team_id: string; department: DeptKind; is_live: boolean; dry_run?: boolean };

const CADENCE_LEN: Record<Cadence, number> = { daily: 14, weekly: 8, monthly: 6 };

/* ── reason mapping: backend canonical → tracker NotSentReason ─────────────── */
const TRACKER_REASONS = new Set<NotSentReason>([
  "recipients_missing", "tag_missing", "recipient_placeholder",
  "smtp_timeout", "scheduler_skipped", "silent_day", "bounced", "spyne_preview", "send_failed",
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
    case "mail_error":
    case "error": return "send_failed";
    default: return "scheduler_skipped";
  }
}

/* ── date helpers (UTC, anchored) ──────────────────────────────────────────── */
function shift(anchor: string, unit: Cadence, n: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (unit === "daily") dt.setUTCDate(dt.getUTCDate() - n);
  else if (unit === "weekly") dt.setUTCDate(dt.getUTCDate() - n * 7);
  else {
    // Subtract n months WITHOUT day-overflow: setUTCMonth on a day the target month
    // lacks (e.g. Mar 31 − 1mo) silently rolls into the next month. Clamp to the
    // target month's last valid day instead.
    const day = dt.getUTCDate();
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() - n);
    const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(day, lastDay));
  }
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
    openedAt: r.opened_at ?? undefined,
    openCount: r.open_count ?? undefined,
    recipients: (r.recipients ?? undefined)?.map(rec => ({
      email: rec.email, name: rec.name, received: rec.received, bounced: rec.bounced,
      opened: rec.opened, openedAt: rec.opened_at,
    })),
  }));
  const cell = (status: SendStatus, reason?: NotSentReason): SendCell => ({
    date, cadence, status, reason, runs: cellRuns,
  });

  if (!runs.length) return cell("not_subscribed");
  if (runs.some(r => r.status === "sent")) return cell("sent");
  // A genuine send FAILURE — surfaced as "Failed" (distinct from a deliberate not_sent hold). Matches both
  // the new status="error" rows and legacy failures stored as status="not_sent" with reason="error".
  const err = runs.find(r => r.status === "error" || (r.status === "not_sent" && r.reason === "error"));
  if (err) return cell("error", normReason(err.reason ?? "error"));
  if (runs.some(r => r.status === "suppressed")) {
    const s = runs.find(r => r.status === "suppressed");
    return cell("suppressed", normReason(s?.reason ?? null));
  }
  if (runs.some(r => r.status === "scheduled")) return cell("scheduled");
  const ns = runs.find(r => r.status === "not_sent");
  return cell("not_sent", normReason(ns?.reason ?? null));
}

export async function loadRooftops(opts: { anchor?: string } = {}): Promise<LoadResult> {
  const todayIso = new Date().toISOString().slice(0, 10);
  // Optional history anchor (YYYY-MM-DD) — becomes the right-most column, so the tracker can jump to
  // ANY past date instead of only the fixed window ending "today".
  const anchorReq = opts.anchor && /^\d{4}-\d{2}-\d{2}$/.test(opts.anchor) ? opts.anchor : null;
  if (!isSupabaseConfigured || !supabase) {
    // No mock fallback — surface an explicit unconfigured state so the UI shows a message, not fake data.
    return { rooftops: [], source: "unconfigured", today: todayIso, lastSynced: new Date() };
  }

  // When browsing history, fetch the 5000 rows AT/BEFORE the anchor so an older window isn't crowded
  // out by the newest rows (the 5000-row cap otherwise only covers the most recent ~3 weeks).
  const runsBase = supabase.from("roi_digest_runs")
    .select("team_id,enterprise_id,department,cadence,local_date,status,reason,recipients,metrics,rendered_html,message_id,sent_at,opened_at,open_count")
    .order("local_date", { ascending: false });
  const [runsRes, cfgRes, recRes, liveRes] = await Promise.all([
    (anchorReq ? runsBase.lte("local_date", anchorReq) : runsBase).limit(5000),
    supabase.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,csm_name,cs_poc,digest_send_hour,digest_send_minute,daily_enabled,weekly_enabled,monthly_enabled,post_appointment_enabled,post_conversation_enabled,action_item_enabled,action_item_overdue_enabled,daily_template,digest_focus,sms_enabled,weekly_send_dow,monthly_send_day,lifecycle_status,arr_bucket,enterprise_name,team_name,contracted_date,onboarding_date,ob_live_date,live_date,churn_date,calls_30d,sms_30d,last_activity_at"),
    supabase.from("roi_recipients").select("team_id,email,name,receives_sales,receives_service,email_enabled,phone,sms_enabled,role"),
    supabase.from("roi_live_departments").select("team_id,department,is_live,dry_run"),
  ]);

  // CRITICAL reads — these define the rooftop rows themselves (runs, config, and the live
  // departments that seed one row per (team, dept)). If any fail, the tracker has nothing to show.
  const critErr = runsRes.error || cfgRes.error || liveRes.error;
  if (critErr) {
    console.warn("[tracker] Supabase read failed:", critErr.message);
    return { rooftops: [], source: "error", today: todayIso, lastSynced: new Date() };
  }
  // NON-CRITICAL: recipients only enrich the rows (recipient lists / received overlay). A failure
  // here shouldn't nuke the whole tracker — degrade to empty recipients rather than "error".
  if (recRes.error) console.warn("[tracker] recipients read failed (degrading to empty):", recRes.error.message);

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

  // anchor "today" (the right-most / "live" column) = the most recent of {latest daily run, real
  // yesterday UTC}. Anchoring to the latest run ALONE froze the calendar whenever the cron fell
  // behind (a 3-day-old run made the UI look like that day was "today"). Daily digests carry
  // yesterday's local_date, so real-yesterday keeps the live column populated while still advancing
  // every day; a fresher same-day run (local_date === today) still wins via the max.
  const isoYesterday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const dailyDates = runs.filter(r => r.cadence === "daily").map(r => r.local_date).sort();
  const latestRun = dailyDates.length ? dailyDates[dailyDates.length - 1] : "";
  // Explicit history anchor wins (user jumped to a past date); else the live anchor (latest run / yesterday).
  const today = anchorReq ?? (latestRun > isoYesterday ? latestRun : isoYesterday);

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
    // every recipient routed to this department (incl. disabled) → view + toggle
    const recipsAll: Recipient[] = (recByTeam.get(teamId) ?? [])
      .filter(r => (dept === "sales" ? r.receives_sales : r.receives_service))
      .map(r => ({ email: r.email, name: r.name ?? undefined, received: recvMap.get(r.email.toLowerCase()) ?? false, enabled: r.email_enabled, phone: r.phone ?? undefined, smsEnabled: r.sms_enabled === true }));
    // ENABLED subset → used for sending
    const recips: Recipient[] = recipsAll.filter(r => r.enabled);

    const departments: Department[] = [{ kind: dept, live: true, agents, recipients: recips, allRecipients: recipsAll }];
    // Lifecycle status (by send history): a real email is one with a "sent" run in ANY cadence.
    const everSent = deptRuns.some(r => r.status === "sent");
    const isDry = live.dry_run !== false; // dry-run held when unset or true
    const liveStatus: RooftopRow["liveStatus"] = !isDry ? "live" : everSent ? "paused" : "not_started";
    const daily = buildCells(deptRuns, "daily");
    const current_block = daily[0] && daily[0].status === "not_sent" ? daily[0].reason ?? null : null;

    return {
      rooftop_id: `${teamId}::${dept}`,
      name: cfg?.rooftop_name || cfg?.team_name || teamId,
      enterprise_id: enterpriseId,
      team_id: teamId,
      department: dept,
      dryRun: live.dry_run !== false, // default true (dry-run on) when unset
      liveStatus,
      lifecycleStatus: toLifecycleStatus(cfg?.lifecycle_status),
      arrBucket: cfg?.arr_bucket ?? undefined,
      lifecycleDates: {
        contracted: cfg?.contracted_date ?? null,
        onboarding: cfg?.onboarding_date ?? null,
        obLive: cfg?.ob_live_date ?? null,
        live: cfg?.live_date ?? null,
        churn: cfg?.churn_date ?? null,
      },
      activity: { calls30d: cfg?.calls_30d ?? 0, sms30d: cfg?.sms_30d ?? 0, lastActivityAt: cfg?.last_activity_at ?? null },
      timezone: cfg?.timezone ?? undefined,
      sendHour: cfg?.digest_send_hour ?? undefined,
      sendMinute: cfg?.digest_send_minute ?? undefined,
      weeklySendDow: cfg?.weekly_send_dow ?? undefined,
      monthlySendDay: cfg?.monthly_send_day ?? undefined,
      // CSM is sourced from roi_rooftop_config.cs_poc (authoritative — synced from
      // Metabase Q12071's cs_poc_email per team_id). Fall back to the stored
      // csm_name, then "Unassigned".
      csm: nameFromEmail(cfg?.cs_poc) || cfg?.csm_name?.trim() || "Unassigned",
      group: enterpriseId ? `Ent ${enterpriseId.slice(0, 6)}` : undefined,
      agents_live: agents,
      departments,
      current_block,
      daily,
      weekly: buildCells(deptRuns, "weekly"),
      monthly: buildCells(deptRuns, "monthly"),
      config: {
        daily_enabled: cfg?.daily_enabled !== false,            // default on
        weekly_enabled: cfg?.weekly_enabled === true,
        monthly_enabled: cfg?.monthly_enabled === true,
        post_appointment_enabled: cfg?.post_appointment_enabled === true,
        post_conversation_enabled: cfg?.post_conversation_enabled === true,
        action_item_enabled: cfg?.action_item_enabled === true,
        action_item_overdue_enabled: cfg?.action_item_overdue_enabled === true,
        daily_template: (cfg?.daily_template === "v1" ? "v1" : "v2") as DailyTemplate,   // default v2 (new) — go-live Jul 2026
        digest_focus: ((cfg?.digest_focus === "conversation" || cfg?.digest_focus === "appointment") ? cfg.digest_focus : "auto") as DigestFocus,   // default auto (→ conversation)
      },
      smsEnabled: cfg?.sms_enabled === true, // rooftop-level SMS master switch (default off)
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

/** Lightweight rows for rooftops NOT yet represented by a roi_live_departments grid row —
 * onboarding/contracting-stage accounts (and any churned account with no send history). No
 * digest cells: these power the tracker's non-grid "LifecycleList" view. A team with lifecycle
 * columns unset never appears here (it's plain "live" back-compat, already covered by the grid
 * or genuinely unclassified). */
export async function loadLifecycleOnlyRooftops(): Promise<RooftopRow[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const [cfgRes, liveRes] = await Promise.all([
    supabase.from("roi_rooftop_config")
      .select("team_id,enterprise_id,enterprise_name,team_name,rooftop_name,csm_name,cs_poc,timezone,digest_send_hour,digest_send_minute,weekly_send_dow,monthly_send_day,daily_enabled,weekly_enabled,monthly_enabled,post_appointment_enabled,post_conversation_enabled,action_item_enabled,action_item_overdue_enabled,daily_template,digest_focus,sms_enabled,lifecycle_status,arr_bucket,contracted_date,onboarding_date,ob_live_date,live_date,churn_date,calls_30d,sms_30d,last_activity_at")
      .in("lifecycle_status", ["onboarding", "contracting", "churn"]),
    supabase.from("roi_live_departments").select("team_id"),
  ]);
  if (cfgRes.error) { console.warn("[tracker] lifecycle-only read failed:", cfgRes.error.message); return []; }
  const haveGridRow = new Set((liveRes.data ?? []).map((l: { team_id: string }) => l.team_id));
  return (cfgRes.data ?? [])
    .filter((c) => !haveGridRow.has(c.team_id))
    .map((c): RooftopRow => ({
      rooftop_id: `${c.team_id}::lifecycle`,
      name: c.rooftop_name || c.team_name || c.team_id,
      enterprise_id: c.enterprise_id ?? undefined,
      team_id: c.team_id,
      lifecycleStatus: toLifecycleStatus(c.lifecycle_status),
      arrBucket: c.arr_bucket ?? undefined,
      lifecycleDates: { contracted: c.contracted_date, onboarding: c.onboarding_date, obLive: c.ob_live_date, live: c.live_date, churn: c.churn_date },
      activity: { calls30d: c.calls_30d ?? 0, sms30d: c.sms_30d ?? 0, lastActivityAt: c.last_activity_at ?? null },
      lifecycleOnly: true,
      csm: nameFromEmail(c.cs_poc) || c.csm_name?.trim() || "Unassigned",
      group: c.enterprise_id ? `Ent ${c.enterprise_id.slice(0, 6)}` : (c.enterprise_name ?? undefined),
      timezone: c.timezone ?? undefined,
      sendHour: c.digest_send_hour ?? undefined,
      sendMinute: c.digest_send_minute ?? undefined,
      weeklySendDow: c.weekly_send_dow ?? undefined,
      monthlySendDay: c.monthly_send_day ?? undefined,
      agents_live: [],
      departments: [],
      daily: [], weekly: [], monthly: [],
      // Same defaults loadRooftops() applies for a config-less team — so ConfigDrawer (opened via
      // the LifecycleList's "Configure" button, ahead of go-live) renders normally.
      config: {
        daily_enabled: c.daily_enabled !== false,
        weekly_enabled: c.weekly_enabled === true,
        monthly_enabled: c.monthly_enabled === true,
        post_appointment_enabled: c.post_appointment_enabled === true,
        post_conversation_enabled: c.post_conversation_enabled === true,
        action_item_enabled: c.action_item_enabled === true,
        action_item_overdue_enabled: c.action_item_overdue_enabled === true,
        daily_template: (c.daily_template === "v1" ? "v1" : "v2") as DailyTemplate,
        digest_focus: ((c.digest_focus === "conversation" || c.digest_focus === "appointment") ? c.digest_focus : "auto") as DigestFocus,
      },
      smsEnabled: c.sms_enabled === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Transactional emails (roi_event_emails) — per-event sends, monitored per rooftop ───── */
export type EventTypeCount = { total: number; sent: number; notSent: number; opened?: number; lastAt?: string | null; byDir?: { inbound: number; outbound: number } };
/** counts keyed by `${team_id}::${department}` → { [email_type]: EventTypeCount } */
export type EventCounts = Map<string, Record<string, EventTypeCount>>;
export type EventEmailRow = {
  id: string; email_type: string; status: string;
  subject: string | null; recipients: { email: string; received?: boolean; opened?: boolean; opened_at?: string }[] | null;
  sent_at: string | null; created_at: string; opened_at: string | null; open_count?: number | null;
  reason: string | null; rendered_html: string | null; event_key: string; message_id: string | null;
};

/** Per-(rooftop, dept, type) counts. TOTAL comes live from ClickHouse (all real events,
 * history + ongoing — see /api/email/roi-event-counts), so nothing is missed; SENT is
 * overlaid from the generated-rows view (roi_event_email_counts). Degrades to the view
 * alone if the CH endpoint is unavailable. */
export async function loadEventCounts(): Promise<EventCounts> {
  const m: EventCounts = new Map();
  // 1) generated-rows view → seeds all types + the `sent` overlay.
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("roi_event_email_counts")
      .select("team_id,department,email_type,total,sent,not_sent,opened,last_at");
    if (error) console.warn("[tracker] event counts (view) read failed:", error.message);
    for (const r of (data ?? []) as Array<{ team_id: string; department: string; email_type: string; total: number; sent: number; not_sent: number; opened: number | null; last_at: string | null }>) {
      const key = `${r.team_id}::${r.department}`;
      const rec = m.get(key) ?? {};
      rec[r.email_type] = { total: r.total, sent: r.sent, notSent: r.not_sent, opened: r.opened ?? 0, lastAt: r.last_at };
      m.set(key, rec);
    }
  }
  // 2) ClickHouse totals → override `total` with the REAL event count (keep `sent` from the view).
  try {
    const r = await fetch(`/api/email/roi-event-counts`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray((j as { counts?: unknown }).counts)) {
      // CH returns one row per (team×dept×type×direction) — fold to per (team::dept::type) with a
      // direction breakdown so the grid can show the all-agents total OR a single agent (IB/OB).
      const agg = new Map<string, { total: number; inbound: number; outbound: number; lastAt: string | null }>();
      for (const c of (j as { counts: Array<{ team_id: string; department: string; email_type: string; direction?: string; total: number; last_at: string | null }> }).counts) {
        const k = `${c.team_id}::${c.department}::${c.email_type}`;
        const a = agg.get(k) ?? { total: 0, inbound: 0, outbound: 0, lastAt: null };
        a.total += c.total || 0;
        if (c.direction === "outbound") a.outbound += c.total || 0; else a.inbound += c.total || 0;
        if (c.last_at && (!a.lastAt || c.last_at > a.lastAt)) a.lastAt = c.last_at;
        agg.set(k, a);
      }
      for (const [k, a] of agg) {
        const sep = k.split("::"); const email_type = sep.pop() as string; const key = sep.join("::");
        const rec = m.get(key) ?? {};
        const sent = rec[email_type]?.sent ?? 0;
        const opened = rec[email_type]?.opened ?? 0; // preserve the view's opened count through the CH total override
        rec[email_type] = { total: a.total, sent, notSent: Math.max(0, a.total - sent), opened, lastAt: a.lastAt ?? rec[email_type]?.lastAt ?? null, byDir: { inbound: a.inbound, outbound: a.outbound } };
        m.set(key, rec);
      }
    }
  } catch { /* CH endpoint unavailable → keep view-only counts */ }
  return m;
}

/** One recipient of a team, with BOTH department memberships + the global enabled flag. */
export type TeamRecipient = { id: string; email: string; name: string | null; receives_sales: boolean; receives_service: boolean; email_enabled: boolean; phone: string | null; sms_enabled: boolean; role: string | null; subscriptions: import("./mockData").Subscriptions | null; verified_at: string | null };

/** All recipients for a team (both departments) — powers the ConfigDrawer's side-by-side Sales /
 * Service recipient lists. Each RooftopRow only carries its own department's recipients, so the
 * drawer fetches the full set here (roi_recipients; RLS off so the browser anon key can read). */
export async function loadTeamRecipients(teamId: string): Promise<TeamRecipient[]> {
  if (!isSupabaseConfigured || !supabase || !teamId) return [];
  const { data, error } = await supabase
    .from("roi_recipients")
    .select("id,email,name,receives_sales,receives_service,email_enabled,phone,sms_enabled,role,subscriptions,verified_at")
    .eq("team_id", teamId);
  if (error) { console.warn("[tracker] team recipients read failed:", error.message); return []; }
  return (data ?? []) as TeamRecipient[];
}

export type EventEmailPage = { rows: EventEmailRow[]; hasMore: boolean };

/** One page of the individual transactional emails behind a count — newest first.
 * This lists ONLY real emails the pipeline actually produced (sent / suppressed / error /
 * queued), paged straight from roi_event_emails. It deliberately does NOT fabricate rows for
 * qualified-but-never-emailed ClickHouse events — the drill-down is a true "what got sent, what
 * day" record, not a preview surface. (Generating a preview for a not-yet-sent event is now an
 * explicit action from the drawer's empty state / the grid's ✦ Generate cell, never a list row.)
 * `hasMore` is true when a full page came back (more pages likely follow).
 *
 * Note: roi_event_emails has no direction column, so the IB/OB `direction` filter isn't applied
 * here — consistent with the count's numerator (`sent`), which is likewise not direction-split. */
export async function loadEventEmails(
  teamId: string, department: string, emailType: string,
  opts: { limit?: number; offset?: number; direction?: string | null } = {},
): Promise<EventEmailPage> {
  const limit = opts.limit ?? 50;
  const offset = Math.max(0, opts.offset ?? 0);
  let stored: EventEmailRow[] = [];
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("roi_event_emails")
      .select("id,email_type,status,subject,recipients,sent_at,created_at,opened_at,open_count,reason,rendered_html,event_key,message_id")
      .eq("team_id", teamId).eq("department", department).eq("email_type", emailType)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) console.warn("[tracker] event emails read failed:", error.message);
    stored = (data ?? []) as EventEmailRow[];
  }
  return { rows: stored, hasMore: stored.length === limit };
}

/** A produced transactional email carrying its team + department, for the cross-rooftop
 * per-day analytics modal (the plain EventEmailRow drops both). */
export type EventEmailDayRow = EventEmailRow & { team_id: string; department: string };

/** Every produced transactional email of ONE type across the given teams — newest first,
 * bounded. Powers the transactional Sent/Opened analytics modal: its per-day trend and the
 * per-day drill-down. Reads roi_event_emails directly, the same "what actually got produced"
 * record the Sent (status='sent') and Opened (opened_at) KPI numerators are computed from, so
 * the modal's counts reconcile with the KPI chips. `direction` is intentionally NOT filtered —
 * roi_event_emails has no direction column and the `sent`/`opened` numerators aren't
 * direction-split either (see loadEventEmails). */
export async function loadEventEmailsByType(
  teamIds: string[], emailType: string,
  opts: { department?: string | null; limit?: number } = {},
): Promise<EventEmailDayRow[]> {
  if (!isSupabaseConfigured || !supabase || teamIds.length === 0) return [];
  let q = supabase
    .from("roi_event_emails")
    .select("id,team_id,department,email_type,status,subject,recipients,sent_at,created_at,opened_at,open_count,reason,rendered_html,event_key,message_id")
    .in("team_id", teamIds)
    .eq("email_type", emailType)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 3000);
  if (opts.department) q = q.eq("department", opts.department);
  const { data, error } = await q;
  if (error) { console.warn("[tracker] event emails by type read failed:", error.message); return []; }
  return (data ?? []) as EventEmailDayRow[];
}

/** Per-day mini-report counts for ONE (team×dept×type): Created / Closed (action items only) /
 * Eligible (from ClickHouse, dealer-local days) + Sent (from roi_event_emails). Keyed by the
 * dealer-local 'YYYY-MM-DD'. Returns {} if the endpoint is unavailable (drawer falls back to the
 * plain "N emails" header). */
export type EventDayCount = { created: number; closed: number; eligible: number; sent: number };
export type EventDayCounts = Record<string, EventDayCount>;
export async function loadEventDayCounts(
  teamId: string, department: string, emailType: string, tz?: string,
): Promise<EventDayCounts> {
  if (!teamId || !emailType) return {};
  try {
    const qs = new URLSearchParams({ teamId, department: department || "", emailType });
    if (tz) qs.set("tz", tz);
    const r = await fetch(`/api/email/roi-event-daycounts?${qs.toString()}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && typeof (j as { days?: unknown }).days === "object") return (j as { days: EventDayCounts }).days || {};
  } catch { /* fall through */ }
  return {};
}

/** Lifetime count of SENT digest runs for the given rooftops — all-time, not just the loaded
 * window. Optionally scoped to a cadence (to match the modal's current daily/weekly/monthly view)
 * and a department. Uses a head-only exact count (no rows fetched). */
export async function countDigestSent(teamIds: string[], opts: { cadence?: string; department?: string | null } = {}): Promise<number> {
  if (!isSupabaseConfigured || !supabase || teamIds.length === 0) return 0;
  let q = supabase.from("roi_digest_runs").select("id", { count: "exact", head: true })
    .in("team_id", teamIds).eq("status", "sent");
  if (opts.cadence) q = q.eq("cadence", opts.cadence);
  if (opts.department) q = q.eq("department", opts.department);
  const { count, error } = await q;
  if (error) { console.warn("[tracker] lifetime digest-sent count failed:", error.message); return 0; }
  return count ?? 0;
}

/** Lifetime count of a transactional type's produced emails for the given rooftops — all-time.
 * metric 'sent' = status='sent'; 'opened' = an open was recorded (opened_at set). Head-only count. */
export async function countEventByMetric(teamIds: string[], emailType: string, metric: "sent" | "opened", opts: { department?: string | null } = {}): Promise<number> {
  if (!isSupabaseConfigured || !supabase || teamIds.length === 0) return 0;
  let q = supabase.from("roi_event_emails").select("id", { count: "exact", head: true })
    .in("team_id", teamIds).eq("email_type", emailType);
  if (metric === "opened") q = q.not("opened_at", "is", null);
  else q = q.eq("status", "sent");
  if (opts.department) q = q.eq("department", opts.department);
  const { count, error } = await q;
  if (error) { console.warn("[tracker] lifetime event count failed:", error.message); return 0; }
  return count ?? 0;
}

/** One eligible event from ClickHouse (history + live), via /api/email/roi-event-list. */
type CHEvent = { eventKey: string; customer?: string; phone?: string; createdAt: string; direction?: string; label?: string; sub?: string };

/** The transactional drill-down FEED: every eligible event from ClickHouse (all dates, history
 * included), each filed under the date it was supposed to go, with real send-status overlaid from
 * roi_event_emails where an email actually got produced. This is the "show ALL data, grouped by
 * intended date" view — not just the sparse generated rows. An event that never produced an email
 * shows as status `eligible` (id="" → the drawer live-renders + offers Send/Ignore on click).
 *
 * Pages purely on the ClickHouse stream (newest-first) so the drawer's offset=rows.length stays
 * valid. Falls back to the stored-rows-only view (loadEventEmails) if the CH endpoint is down. */
export async function loadEventFeed(
  teamId: string, department: string, emailType: string,
  opts: { limit?: number; offset?: number; direction?: string | null } = {},
): Promise<EventEmailPage> {
  const limit = opts.limit ?? 50;
  const offset = Math.max(0, opts.offset ?? 0);
  const direction = opts.direction ?? null;
  // 1) eligible events from ClickHouse (all dates)
  let ch: CHEvent[] | null = null;
  try {
    const qs = new URLSearchParams({ teamId, department: department || "", emailType, sinceDays: "365", limit: String(limit), offset: String(offset) });
    if (direction) qs.set("direction", direction);
    const r = await fetch(`/api/email/roi-event-list?${qs.toString()}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray((j as { events?: unknown }).events)) ch = (j as { events: CHEvent[] }).events;
  } catch { /* fall through to stored-only */ }
  if (ch === null) return loadEventEmails(teamId, department, emailType, { limit, offset, direction });
  // 2) overlay real send-status from roi_event_emails, matched by event_key
  const stored = (await loadEventEmails(teamId, department, emailType, { limit: 200, offset: 0, direction })).rows;
  const byKey = new Map(stored.map((s) => [s.event_key, s]));
  const rows: EventEmailRow[] = ch.map((ev) => {
    const s = byKey.get(ev.eventKey);
    if (s) return s; // a real generated/sent email — keep its exact status / html / opens
    return {
      id: "", email_type: emailType, status: "eligible",
      subject: ev.label || null, recipients: null, sent_at: null,
      created_at: (ev.createdAt || "").replace(" ", "T"), // CH DateTime → ISO-ish for Date()
      opened_at: null, open_count: 0, reason: ev.sub || null,
      rendered_html: null, event_key: ev.eventKey, message_id: null,
    };
  });
  return { rows, hasMore: ch.length === limit };
}

/** Who's making config changes from this browser — attached to every config write so the
 * "History" panel (roi_config_audit_log) can attribute it. Not real auth (the tracker sits
 * behind one shared login, see TrackerAuthGate) — just a cheap, persistent display name. */
const ACTOR_KEY = "vini-tracker-actor";
export function getActorName(): string {
  try {
    const stored = localStorage.getItem(ACTOR_KEY);
    if (stored) return stored;
  } catch { /* private mode → ask every time */ }
  const name = (typeof window !== "undefined" ? window.prompt("Your name (shown in the config change history):") : "")?.trim();
  if (name) { try { localStorage.setItem(ACTOR_KEY, name); } catch { /* ignore */ } }
  return name || "";
}
export function setActorName(name: string): void {
  try { localStorage.setItem(ACTOR_KEY, name.trim()); } catch { /* ignore */ }
}

/** Persist a per-rooftop email-type toggle (roi_rooftop_config). Browser write — RLS is off
 * on this project and anon has been granted UPDATE, so the tracker writes directly. */
// Persist rooftop config (email-type toggles + daily template) through the backend
// (service key) so the browser's publishable key never needs write grants on
// roi_rooftop_config. The server whitelists the columns it accepts.
export async function updateRooftopConfig(teamId: string, patch: Partial<RooftopConfig> & { sms_enabled?: boolean; weekly_send_dow?: number; monthly_send_day?: number }): Promise<{ ok: boolean; error?: string }> {
  if (!teamId) return { ok: false, error: "teamId required" };
  try {
    const res = await fetch("/api/rooftop-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, actor: getActorName(), ...patch }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) return { ok: false, error: (body as { error?: string }).error || `Save failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** One entry in a rooftop's config change history (roi_config_audit_log via /api/config-audit-log). */
export type AuditEntry = { field: string; old_value: string | null; new_value: string | null; actor: string | null; source: string; created_at: string };
export async function loadConfigAuditLog(teamId: string): Promise<AuditEntry[]> {
  if (!teamId) return [];
  try {
    const r = await fetch(`/api/config-audit-log?teamId=${encodeURIComponent(teamId)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray((j as { entries?: unknown }).entries)) return (j as { entries: AuditEntry[] }).entries;
  } catch { /* fall through */ }
  return [];
}

/** Flip is_live for every department of a rooftop — the real emailer kill switch (both crons gate
 * on this column independently of the tracker's own "churn" tag). Routed through the server so
 * the change is attributable in roi_config_audit_log, unlike a direct client write. */
export async function updateRooftopLiveStatus(teamId: string, isLive: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!teamId) return { ok: false, error: "teamId required" };
  try {
    const res = await fetch("/api/rooftop-live-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, isLive, actor: getActorName() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) return { ok: false, error: (body as { error?: string }).error || `Save failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
