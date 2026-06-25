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
  type Department,
  type DeptKind,
  type DigestMetrics,
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
};
type ConfigRow = { team_id: string; enterprise_id: string | null; rooftop_name: string | null; timezone: string | null; csm_name: string | null; cs_poc: string | null; digest_send_hour: number | null; digest_send_minute: number | null;
  daily_enabled: boolean | null; weekly_enabled: boolean | null; monthly_enabled: boolean | null;
  post_appointment_enabled: boolean | null; post_conversation_enabled: boolean | null; action_item_enabled: boolean | null; action_item_overdue_enabled: boolean | null;
  daily_template: string | null };
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
};
type LiveRow = { team_id: string; department: DeptKind; is_live: boolean; dry_run?: boolean };

const CADENCE_LEN: Record<Cadence, number> = { daily: 14, weekly: 8, monthly: 6 };

/* ── reason mapping: backend canonical → tracker NotSentReason ─────────────── */
const TRACKER_REASONS = new Set<NotSentReason>([
  "recipients_missing", "tag_missing", "recipient_placeholder",
  "smtp_timeout", "scheduler_skipped", "silent_day", "bounced", "spyne_preview",
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
    openedAt: r.opened_at ?? undefined,
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
  if (runs.some(r => r.status === "suppressed")) {
    const s = runs.find(r => r.status === "suppressed");
    return cell("suppressed", normReason(s?.reason ?? null));
  }
  if (runs.some(r => r.status === "scheduled")) return cell("scheduled");
  const ns = runs.find(r => r.status === "not_sent");
  return cell("not_sent", normReason(ns?.reason ?? null));
}

export async function loadRooftops(): Promise<LoadResult> {
  const todayIso = new Date().toISOString().slice(0, 10);
  if (!isSupabaseConfigured || !supabase) {
    // No mock fallback — surface an explicit unconfigured state so the UI shows a message, not fake data.
    return { rooftops: [], source: "unconfigured", today: todayIso, lastSynced: new Date() };
  }

  const [runsRes, cfgRes, recRes, liveRes] = await Promise.all([
    supabase.from("roi_digest_runs")
      .select("team_id,enterprise_id,department,cadence,local_date,status,reason,recipients,metrics,rendered_html,message_id,sent_at,opened_at")
      .order("local_date", { ascending: false }).limit(5000),
    supabase.from("roi_rooftop_config").select("team_id,enterprise_id,rooftop_name,timezone,csm_name,cs_poc,digest_send_hour,digest_send_minute,daily_enabled,weekly_enabled,monthly_enabled,post_appointment_enabled,post_conversation_enabled,action_item_enabled,action_item_overdue_enabled,daily_template"),
    supabase.from("roi_recipients").select("team_id,email,name,receives_sales,receives_service,email_enabled"),
    supabase.from("roi_live_departments").select("team_id,department,is_live,dry_run"),
  ]);

  const err = runsRes.error || cfgRes.error || recRes.error || liveRes.error;
  if (err) {
    console.warn("[tracker] Supabase read failed:", err.message);
    return { rooftops: [], source: "error", today: todayIso, lastSynced: new Date() };
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
    // every recipient routed to this department (incl. disabled) → view + toggle
    const recipsAll: Recipient[] = (recByTeam.get(teamId) ?? [])
      .filter(r => (dept === "sales" ? r.receives_sales : r.receives_service))
      .map(r => ({ email: r.email, name: r.name ?? undefined, received: recvMap.get(r.email.toLowerCase()) ?? false, enabled: r.email_enabled }));
    // ENABLED subset → used for sending
    const recips: Recipient[] = recipsAll.filter(r => r.enabled);

    const departments: Department[] = [{ kind: dept, live: true, agents, recipients: recips, allRecipients: recipsAll }];
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
      sendHour: cfg?.digest_send_hour ?? undefined,
      sendMinute: cfg?.digest_send_minute ?? undefined,
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
        daily_template: cfg?.daily_template === "v2" ? "v2" : "v1",   // default classic
      },
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

/* ── Transactional emails (roi_event_emails) — per-event sends, monitored per rooftop ───── */
export type EventTypeCount = { total: number; sent: number; notSent: number; lastAt?: string | null; byDir?: { inbound: number; outbound: number } };
/** counts keyed by `${team_id}::${department}` → { [email_type]: EventTypeCount } */
export type EventCounts = Map<string, Record<string, EventTypeCount>>;
export type EventEmailRow = {
  id: string; email_type: string; status: string;
  subject: string | null; recipients: { email: string; received?: boolean; opened?: boolean }[] | null;
  sent_at: string | null; created_at: string; opened_at: string | null;
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
      .select("team_id,department,email_type,total,sent,not_sent,last_at");
    if (error) console.warn("[tracker] event counts (view) read failed:", error.message);
    for (const r of (data ?? []) as Array<{ team_id: string; department: string; email_type: string; total: number; sent: number; not_sent: number; last_at: string | null }>) {
      const key = `${r.team_id}::${r.department}`;
      const rec = m.get(key) ?? {};
      rec[r.email_type] = { total: r.total, sent: r.sent, notSent: r.not_sent, lastAt: r.last_at };
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
        rec[email_type] = { total: a.total, sent, notSent: Math.max(0, a.total - sent), lastAt: a.lastAt ?? rec[email_type]?.lastAt ?? null, byDir: { inbound: a.inbound, outbound: a.outbound } };
        m.set(key, rec);
      }
    }
  } catch { /* CH endpoint unavailable → keep view-only counts */ }
  return m;
}

/** The individual transactional emails behind a count — newest first. Backfill + live:
 * the list comes from ClickHouse (every real event in the window, history included),
 * with each generated/sent row from roi_event_emails overlaid by event_key. Events that
 * haven't been generated yet appear as `status:"live"` rows (id:"" → the drawer's "Live
 * preview · decide to send or ignore" path). Degrades to the stored rows on CH failure. */
export async function loadEventEmails(teamId: string, department: string, emailType: string, limit = 500, direction?: string | null): Promise<EventEmailRow[]> {
  // Stored/generated rows (sent, suppressed, etc.) keyed by event_key for overlay.
  let stored: EventEmailRow[] = [];
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from("roi_event_emails")
      .select("id,email_type,status,subject,recipients,sent_at,created_at,opened_at,reason,rendered_html,event_key,message_id")
      .eq("team_id", teamId).eq("department", department).eq("email_type", emailType)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) console.warn("[tracker] event emails read failed:", error.message);
    stored = (data ?? []) as EventEmailRow[];
  }
  // Live CH events (history + ongoing).
  let chEvents: Array<{ eventKey: string; label: string; sub: string; createdAt: string }> = [];
  try {
    const q = `teamId=${encodeURIComponent(teamId)}&department=${encodeURIComponent(department)}&emailType=${encodeURIComponent(emailType)}&limit=${limit}` + (direction ? `&direction=${encodeURIComponent(direction)}` : "");
    const r = await fetch(`/api/email/roi-event-list?${q}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray((j as { events?: unknown }).events)) chEvents = (j as { events: typeof chEvents }).events;
  } catch { /* fall through to stored-only */ }
  if (!chEvents.length) return stored; // CH unavailable / no events → previous behavior

  const byKey = new Map(stored.map((r) => [r.event_key, r] as const));
  const seen = new Set<string>();
  const merged: EventEmailRow[] = chEvents.map((e) => {
    const hit = byKey.get(e.eventKey);
    if (hit) { seen.add(e.eventKey); return { ...hit, subject: hit.subject || e.label }; }
    // Not generated yet → "live, decide to send/ignore" row (id:"" routes to the live preview/generate path).
    return {
      id: "", email_type: emailType, status: "live",
      subject: e.label + (e.sub ? ` · ${e.sub}` : ""),
      recipients: null, sent_at: null, created_at: e.createdAt, opened_at: null,
      reason: null, rendered_html: null, event_key: e.eventKey, message_id: null,
    };
  });
  // Keep any generated rows outside the CH window so nothing already-sent disappears.
  for (const s of stored) if (s.event_key && !seen.has(s.event_key)) merged.push(s);
  return merged;
}

/** Persist a per-rooftop email-type toggle (roi_rooftop_config). Browser write — RLS is off
 * on this project and anon has been granted UPDATE, so the tracker writes directly. */
export async function updateRooftopConfig(teamId: string, patch: Partial<RooftopConfig>): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !supabase) return { ok: false, error: "Supabase not configured" };
  const { error } = await supabase
    .from("roi_rooftop_config")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("team_id", teamId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
