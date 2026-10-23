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
// roi_* reads/writes now go through the authenticated same-origin server (/api/tracker/*,
// service-role key) instead of the browser's publishable/anon key — the tables are RLS-protected,
// so the anon key can no longer read them. isSupabaseConfigured still gates the "connected" state.
import { isSupabaseConfigured } from "./supabaseClient";
import { buildCells, rowDueKeys, expectedFromFor, type RowFacts, type RunLite, type SinceFacts, type TxStatusCounts } from "./trackerModel.ts";
import { promptDialog } from "../ui/dialogs";
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
  /** The explicit history anchor that was requested, or "" for live (the grid computes the live
   * anchor from the rows on screen: trackerModel.liveAnchor). */
  today: string;
  lastSynced: Date;
  /** The server holds every send (DRY_RUN). Manual sends will be refused. */
  serverDryRun?: boolean;
};

type RunRow = {
  id: string;
  team_id: string;
  enterprise_id: string | null;
  department: DeptKind;
  cadence: Cadence;
  local_date: string;
  status: SendStatus;
  reason: string | null;
  reason_detail?: string | null;
  trigger?: string | null;
  recipients: { email: string; name?: string; received?: boolean; bounced?: boolean; opened?: boolean; opened_at?: string }[] | null;
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
  lifecycle_status: string | null; lifecycle_status_override: string | null; lifecycle_effective: string | null;
  lifecycle_override_at: string | null; lifecycle_override_by: string | null;
  arr_bucket: string | null; enterprise_name: string | null; team_name: string | null;
  contracted_date: string | null; onboarding_date: string | null; ob_live_date: string | null; live_date: string | null; churn_date: string | null;
  calls_30d: number | null; sms_30d: number | null; last_activity_at: string | null;
  ae_poc: string | null; ob_poc: string | null;
  chat_enabled?: boolean | null; post_conversation_template?: string | null; post_conversation_mode?: string | null;
  post_conversation_outbound_requires_reply?: boolean | null; sms_post_conversation_cadence?: string | null; working_hours?: unknown };

/** roi_rooftop_config → the tracker's LifecycleStatus, defaulting to "live" for rooftops the
 * lifecycle sync hasn't classified yet — never hides an already-visible rooftop.
 *
 * Prefer lifecycle_effective (generated: a human's lifecycle_status_override applied over the
 * ledger's lifecycle_status, with churn always winning). Falls back to lifecycle_status so the
 * tracker still renders against a database where the override migration hasn't been applied. */
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

/** A department is churned on a date the way the cron's isChurned reads it: the ledger stage is
 * churn, or a churn_date on or before that date. */
function churnTest(cfg: ConfigRow | undefined): (isoDate: string) => boolean {
  const stage = String(cfg?.lifecycle_status ?? "").toLowerCase();
  const effective = String(cfg?.lifecycle_effective ?? "").toLowerCase();
  const churnDate = cfg?.churn_date ? String(cfg.churn_date).slice(0, 10) : "";
  return (d: string) => stage === "churn" || effective === "churn" || (!!churnDate && !!d && churnDate <= d);
}

/** Cells for one department row, anchored at `anchor` (the right-most column). The tracker builds
 * these per tab: the anchor comes from the rows on screen, never from one far-off rooftop (A4 F1). */
export function anchorRow(r: RooftopRow, anchor: string, now: Date): RooftopRow {
  if (r.lifecycleOnly || !r.facts || !anchor) return r;
  const timing = { timezone: r.timezone, sendHour: r.sendHour, sendMinute: r.sendMinute, weeklySendDow: r.weeklySendDow, monthlySendDay: r.monthlySendDay };
  const dueKeys = rowDueKeys(timing, now);
  const runs = r.digestRuns ?? [];
  return {
    ...r,
    dueKeys,
    daily: buildCells(runs, "daily", anchor, r.facts, timing, now, dueKeys.daily),
    weekly: buildCells(runs, "weekly", anchor, r.facts, timing, now, dueKeys.weekly),
    monthly: buildCells(runs, "monthly", anchor, r.facts, timing, now, dueKeys.monthly),
  };
}

/** Use the response index.html's inline script started for `url` before the bundle loaded, once;
 * any later call (a Refresh, a second load) fetches fresh. A failed prefetch falls back to a fetch. */
function prefetchedOr(url: string, init: RequestInit): Promise<Response> {
  const w = window as unknown as { __trackerPrefetch?: Record<string, Promise<Response> | undefined> };
  const pending = w.__trackerPrefetch?.[url];
  if (!pending) return fetch(url, init);
  delete w.__trackerPrefetch![url];
  return pending.catch(() => fetch(url, init));
}

export async function loadRooftops(opts: { anchor?: string } = {}): Promise<LoadResult> {
  const todayIso = new Date().toISOString().slice(0, 10);
  // Optional history anchor (YYYY-MM-DD) — becomes the right-most column, so the tracker can jump to
  // ANY past date instead of only the fixed window ending "today".
  const anchorReq = opts.anchor && /^\d{4}-\d{2}-\d{2}$/.test(opts.anchor) ? opts.anchor : null;
  if (!isSupabaseConfigured) {
    // No mock fallback — surface an explicit unconfigured state so the UI shows a message, not fake data.
    return { rooftops: [], source: "unconfigured", today: todayIso, lastSynced: new Date() };
  }

  // Data comes from the authenticated server endpoint (service-role key). The server runs the same
  // 4 queries (windowed digest_runs + config + recipients + live depts) and returns identical
  // rows/columns, so every mapping below is unchanged. A failed fetch → "error" (same as before).
  let runs: RunRow[]; let configs: ConfigRow[]; let recipients: RecipientRow[]; let lives: LiveRow[];
  let eligibility: Array<{ team_id: string; department: string; daily: number; weekly: number; monthly: number }> | null = null;
  let everSentKeys: Set<string> | null = null;
  let sinceByTeam: Record<string, SinceFacts> = {};
  let serverDryRun: boolean | undefined;
  try {
    const init: RequestInit = { cache: "no-store", headers: trackerAuthHeaders() };
    const res = await (anchorReq ? fetch(`/api/tracker/rooftops-data?anchor=${anchorReq}`, init) : prefetchedOr("/api/tracker/rooftops-data", init));
    if (!res.ok) {
      console.warn("[tracker] rooftops-data read failed: HTTP", res.status);
      return { rooftops: [], source: "error", today: todayIso, lastSynced: new Date() };
    }
    const j = await res.json();
    runs = (j.runs ?? []) as RunRow[];
    configs = (j.configs ?? []) as ConfigRow[];
    recipients = (j.recipients ?? []) as RecipientRow[];
    lives = (j.lives ?? []) as LiveRow[];
    eligibility = Array.isArray(j.eligibility) ? j.eligibility : null;
    everSentKeys = Array.isArray(j.everSent) ? new Set<string>(j.everSent) : null;
    sinceByTeam = j.since && typeof j.since === "object" ? j.since : {};
    serverDryRun = typeof j.serverDryRun === "boolean" ? j.serverDryRun : undefined;
  } catch (e) {
    console.warn("[tracker] rooftops-data read error:", e);
    return { rooftops: [], source: "error", today: todayIso, lastSynced: new Date() };
  }

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

  const eligByKey = new Map((eligibility ?? []).map((e) => [`${e.team_id}::${e.department}`, e]));
  const now = new Date();

  // ONE ROW PER (team, department) — separate tracking per department.
  const rooftops: RooftopRow[] = liveEntries.map((live) => {
    const teamId = live.team_id;
    const dept = live.department;
    const cfg = cfgByTeam.get(teamId);
    const deptRuns = (runsByTeam.get(teamId) ?? []).filter(r => r.department === dept);
    const enterpriseId = cfg?.enterprise_id ?? deptRuns[0]?.enterprise_id ?? undefined;
    const agents: AgentType[] = [dept === "service" ? "service_ib" : "sales_ib"];

    // every recipient routed to this department (incl. disabled) → view + toggle. "Received" is
    // filled per cell from that cell's own run (RecipientManager), never from another run.
    const recipsAll: Recipient[] = (recByTeam.get(teamId) ?? [])
      .filter(r => (dept === "sales" ? r.receives_sales : r.receives_service))
      .map(r => ({ email: r.email, name: r.name ?? undefined, received: false, enabled: r.email_enabled, phone: r.phone ?? undefined, smsEnabled: r.sms_enabled === true }));
    // ENABLED subset → used for sending
    const recips: Recipient[] = recipsAll.filter(r => r.enabled);

    const departments: Department[] = [{ kind: dept, live: true, agents, recipients: recips, allRecipients: recipsAll }];
    // Lifecycle status: "Paused" = held now but has sent before, ever (the server's lifetime count;
    // the loaded window alone called 20 previously-live departments "Not started", A4 F19).
    const everSent = deptRuns.some(r => r.status === "sent") || !!everSentKeys?.has(`${teamId}::${dept}`);
    // Only dry_run === true holds, exactly as the crons read it: a null dry_run SENDS (C25).
    const isDry = live.dry_run === true;
    const liveStatus: RooftopRow["liveStatus"] = !isDry ? "live" : everSent ? "paused" : "not_started";
    const elig = eligByKey.get(`${teamId}::${dept}`);
    const facts: RowFacts = {
      dryRun: isDry,
      churnedOn: churnTest(cfg),
      toggleOn: { daily: cfg?.daily_enabled !== false, weekly: cfg?.weekly_enabled === true, monthly: cfg?.monthly_enabled === true },
      configured: !!cfg,
      eligible: elig ? { daily: elig.daily, weekly: elig.weekly, monthly: elig.monthly } : undefined,
      expectedFrom: expectedFromFor(sinceByTeam[teamId], dept, deptRuns, cfg?.monthly_send_day ?? 1),
    };

    return {
      rooftop_id: `${teamId}::${dept}`,
      name: cfg?.rooftop_name || cfg?.team_name || teamId,
      enterprise_id: enterpriseId,
      team_id: teamId,
      department: dept,
      dryRun: isDry,
      liveStatus,
      unconfigured: !cfg,
      eligible: facts.eligible,
      facts,
      digestRuns: deptRuns as unknown as RunLite[],
      readOnly: cfg ? {
        chatEnabled: cfg.chat_enabled ?? null,
        postConversationTemplate: cfg.post_conversation_template ?? null,
        postConversationMode: cfg.post_conversation_mode ?? null,
        outboundRequiresReply: cfg.post_conversation_outbound_requires_reply ?? null,
        smsPostConversationCadence: cfg.sms_post_conversation_cadence ?? null,
        workingHours: cfg.working_hours ?? null,
      } : undefined,
      lifecycleStatus: toLifecycleStatus(cfg?.lifecycle_effective ?? cfg?.lifecycle_status),
      lifecycleOverride: (cfg?.lifecycle_status_override ?? null) as RooftopRow["lifecycleOverride"],
      lifecycleLedger: cfg?.lifecycle_status ?? null,
      arrBucket: cfg?.arr_bucket ?? undefined,
      lifecycleDates: {
        contracted: cfg?.contracted_date ?? null,
        onboarding: cfg?.onboarding_date ?? null,
        obLive: cfg?.ob_live_date ?? null,
        live: cfg?.live_date ?? null,
        churn: cfg?.churn_date ?? null,
      },
      activity: { calls30d: cfg?.calls_30d ?? 0, sms30d: cfg?.sms_30d ?? 0, lastActivityAt: cfg?.last_activity_at ?? null },
      ae: nameFromEmail(cfg?.ae_poc) || undefined,
      ob: nameFromEmail(cfg?.ob_poc) || undefined,
      timezone: cfg?.timezone ?? undefined,
      sendHour: cfg?.digest_send_hour ?? undefined,
      sendMinute: cfg?.digest_send_minute ?? undefined,
      weeklySendDow: cfg?.weekly_send_dow ?? undefined,
      monthlySendDay: cfg?.monthly_send_day ?? undefined,
      // CSM is sourced from roi_rooftop_config.cs_poc (authoritative — synced from
      // Metabase Q12071's cs_poc_email per team_id). The tracker's "Change CSM" writes cs_poc too
      // (POST /api/csm), so a change shows immediately; the nightly sync replaces it if Metabase
      // names someone else. Fall back to the stored csm_name, then "Unassigned".
      csm: nameFromEmail(cfg?.cs_poc) || cfg?.csm_name?.trim() || "Unassigned",
      group: enterpriseId ? `Ent ${enterpriseId.slice(0, 6)}` : undefined,
      agents_live: agents,
      departments,
      current_block: null,
      // Built per anchor by anchorRow().
      daily: [],
      weekly: [],
      monthly: [],
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

  return { rooftops, source: "supabase", today: anchorReq ?? "", lastSynced: now, serverDryRun };
}

/** ONE digest run's heavy fields, fetched when the cell drawer opens: its stored metrics and the
 * exact email HTML. The grid read leaves both out because together they were nearly all of that
 * payload. Either is null when the run has none; throws on a failed read so the drawer can tell
 * "not stored" from "couldn't load". */
export type DigestRunDetail = { metrics: DigestMetrics | null; html: string | null };
export async function loadDigestRun(runId: string): Promise<DigestRunDetail> {
  const res = await fetch(`/api/tracker/digest-run?id=${encodeURIComponent(runId)}`, { cache: "no-store", headers: trackerAuthHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { metrics: (j.metrics as DigestMetrics | null) ?? null, html: (j.rendered_html as string | null) ?? null };
}

/** Lightweight rows for rooftops NOT yet represented by a roi_live_departments grid row —
 * onboarding/contracting-stage accounts (and any churned account with no send history). No
 * digest cells: these power the tracker's non-grid "LifecycleList" view. A team with lifecycle
 * columns unset never appears here (it's plain "live" back-compat, already covered by the grid
 * or genuinely unclassified). */
export async function loadLifecycleOnlyRooftops(): Promise<RooftopRow[]> {
  if (!isSupabaseConfigured) return [];
  let configs: ConfigRow[]; let liveTeamIds: string[]; let removed: Set<string>;
  try {
    const res = await prefetchedOr(`/api/tracker/lifecycle-rooftops`, { cache: "no-store", headers: trackerAuthHeaders() });
    if (!res.ok) { console.warn("[tracker] lifecycle-only read failed: HTTP", res.status); return []; }
    const j = await res.json();
    configs = (j.configs ?? []) as ConfigRow[];
    liveTeamIds = (j.liveTeamIds ?? []) as string[];
    removed = new Set((j.removedTeamIds ?? []) as string[]);
  } catch (e) { console.warn("[tracker] lifecycle-only read error:", e); return []; }
  const haveGridRow = new Set(liveTeamIds);
  return configs
    .filter((c) => !haveGridRow.has(c.team_id))
    .map((c): RooftopRow => ({
      rooftop_id: `${c.team_id}::lifecycle`,
      name: c.rooftop_name || c.team_name || c.team_id,
      enterprise_id: c.enterprise_id ?? undefined,
      team_id: c.team_id,
      lifecycleStatus: toLifecycleStatus(c.lifecycle_effective ?? c.lifecycle_status),
      lifecycleOverride: (c.lifecycle_status_override ?? null) as RooftopRow["lifecycleOverride"],
      lifecycleLedger: c.lifecycle_status ?? null,
      arrBucket: c.arr_bucket ?? undefined,
      lifecycleDates: { contracted: c.contracted_date, onboarding: c.onboarding_date, obLive: c.ob_live_date, live: c.live_date, churn: c.churn_date },
      activity: { calls30d: c.calls_30d ?? 0, sms30d: c.sms_30d ?? 0, lastActivityAt: c.last_activity_at ?? null },
      ae: nameFromEmail(c.ae_poc) || undefined,
      ob: nameFromEmail(c.ob_poc) || undefined,
      lifecycleOnly: true,
      removedFromEmailer: removed.has(c.team_id),
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
/** Per (rooftop, dept, type). total / sent / notSent / opened all come from the ledger
 * (roi_event_email_counts, all time) so a cell never divides one source by another. chEvents is
 * the separate ClickHouse event count (120 days), shown as information only. */
export type EventTypeCount = { total: number; sent: number; notSent: number; opened?: number; lastAt?: string | null; chEvents?: number; byDir?: { inbound: number; outbound: number } };
/** counts keyed by `${team_id}::${department}` → { [email_type]: EventTypeCount } */
export type EventCounts = Map<string, Record<string, EventTypeCount>>;
export type EventEmailRow = {
  id: string; email_type: string; status: string;
  subject: string | null; recipients: { email: string; received?: boolean; opened?: boolean; opened_at?: string }[] | null;
  sent_at: string | null; created_at: string; opened_at: string | null; open_count?: number | null;
  reason: string | null; rendered_html: string | null; event_key: string; message_id: string | null;
  /** Drill-down rows: the ClickHouse event's own key and the cron's key(s) for it. */
  source_event_key?: string;
  cron_event_key?: string;
  cron_event_keys?: string[];
};

/** Per-(rooftop, dept, type) counts. TOTAL comes live from ClickHouse (all real events,
 * history + ongoing — see /api/email/roi-event-counts), so nothing is missed; SENT is
 * overlaid from the generated-rows view (roi_event_email_counts). Degrades to the view
 * alone if the CH endpoint is unavailable. */
export async function loadEventCounts(): Promise<EventCounts> {
  const m: EventCounts = new Map();
  // Both reads start now; they are merged in order below (view first, then the CH override).
  const chRes = prefetchedOr(`/api/email/roi-event-counts`, { cache: "no-store", headers: trackerAuthHeaders() });
  chRes.catch(() => { /* handled where it is awaited */ });
  // 1) generated-rows view → seeds all types + the `sent` overlay.
  if (isSupabaseConfigured) {
    try {
      const res = await prefetchedOr(`/api/tracker/event-counts`, { cache: "no-store", headers: trackerAuthHeaders() });
      if (!res.ok) console.warn("[tracker] event counts (view) read failed: HTTP", res.status);
      const j = res.ok ? await res.json() : {};
      for (const r of ((j.rows ?? []) as Array<{ team_id: string; department: string; email_type: string; total: number; sent: number; not_sent: number; opened: number | null; last_at: string | null }>)) {
        const key = `${r.team_id}::${r.department}`;
        const rec = m.get(key) ?? {};
        rec[r.email_type] = { total: r.total, sent: r.sent, notSent: r.not_sent, opened: r.opened ?? 0, lastAt: r.last_at };
        m.set(key, rec);
      }
    } catch (e) { console.warn("[tracker] event counts read error:", e); }
  }
  // 2) ClickHouse totals → override `total` with the REAL event count (keep `sent` from the view).
  try {
    const r = await chRes;
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
        const prev = rec[email_type];
        // The ledger's numbers stay as they are; ClickHouse adds its own count beside them. (It used
        // to REPLACE `total`, so every cell and KPI divided ledger emails by raw events: 205%.)
        rec[email_type] = {
          total: prev?.total ?? 0, sent: prev?.sent ?? 0, notSent: prev?.notSent ?? 0, opened: prev?.opened ?? 0,
          lastAt: prev?.lastAt ?? a.lastAt ?? null, chEvents: a.total, byDir: { inbound: a.inbound, outbound: a.outbound },
        };
        m.set(key, rec);
      }
    }
  } catch { /* CH endpoint unavailable → keep view-only counts */ }
  return m;
}

/** One recipient of a team, with BOTH department memberships + the global enabled flag. */
// suppressed_at / suppression_reason: the deliverability hold. An address that failed (hard bounce,
// spam complaint, or one the sweep found undeliverable by construction) is held rather than deleted,
// so the tracker can show WHY that person stopped receiving and a CSM can fix the address. Optional
// because a database that hasn't run migration 0023 simply won't return them.
export type TeamRecipient = { id: string; email: string; name: string | null; receives_sales: boolean; receives_service: boolean; email_enabled: boolean; phone: string | null; sms_enabled: boolean; role: string | null; subscriptions: import("./mockData").Subscriptions | null; verified_at: string | null; suppressed_at?: string | null; suppression_reason?: string | null; bounce_count?: number | null };

/** All recipients for a team (both departments) — powers the ConfigDrawer's side-by-side Sales /
 * Service recipient lists. Each RooftopRow only carries its own department's recipients, so the
 * drawer fetches the full set here (roi_recipients, via the gated /api/tracker/team-recipients
 * server route — the table is RLS-protected, so the browser anon key can no longer read it). */
export async function loadTeamRecipients(teamId: string): Promise<TeamRecipient[]> {
  if (!isSupabaseConfigured || !teamId) return [];
  try {
    const res = await fetch(`/api/tracker/team-recipients?teamId=${encodeURIComponent(teamId)}`, { cache: "no-store", headers: trackerAuthHeaders() });
    if (!res.ok) { console.warn("[tracker] team recipients read failed: HTTP", res.status); return []; }
    const j = await res.json();
    return (j.rows ?? []) as TeamRecipient[];
  } catch (e) { console.warn("[tracker] team recipients read error:", e); return []; }
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
  if (isSupabaseConfigured) {
    try {
      const qs = new URLSearchParams({ teamId, department: department || "", emailType, limit: String(limit), offset: String(offset) });
      const res = await fetch(`/api/tracker/event-emails?${qs.toString()}`, { cache: "no-store", headers: trackerAuthHeaders() });
      if (!res.ok) console.warn("[tracker] event emails read failed: HTTP", res.status);
      else { const j = await res.json(); stored = ((j.rows ?? []) as EventEmailRow[]).filter((r) => !String(r.reason ?? "").startsWith("alias_of:")); }
    } catch (e) { console.warn("[tracker] event emails read error:", e); }
  }
  return { rows: stored, hasMore: stored.length === limit };
}

/** A produced transactional email carrying its team + department, for the cross-rooftop
 * per-day analytics modal (the plain EventEmailRow drops both). */
export type EventEmailDayRow = EventEmailRow & { team_id: string; department: string };

/** Per-day counts of ONE type's sent (or opened) emails across the given teams, for the last `days`
 * calendar days in `tz`. Exact counts from the server: the old single read was capped at 1,000
 * rows, about two days of post-conversation history (A4 F15). */
export async function loadEventDayCountsByType(
  teamIds: string[], emailType: string,
  opts: { department?: string | null; metric?: "sent" | "opened"; days?: number; tz?: string } = {},
): Promise<{ day: string; count: number }[] | null> {
  if (!isSupabaseConfigured || teamIds.length === 0) return [];
  try {
    const res = await fetch(`/api/tracker/event-emails-by-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamIds, emailType, department: opts.department ?? null, metric: opts.metric ?? "sent", days: opts.days ?? 30, tz: opts.tz }),
    });
    if (!res.ok) { console.warn("[tracker] event day counts read failed: HTTP", res.status); return null; }
    const j = await res.json();
    return (j.days ?? []) as { day: string; count: number }[];
  } catch (e) { console.warn("[tracker] event day counts read error:", e); return null; }
}

/** ONE day's sent (or opened) emails of a type across the given teams (up to 2,000). */
export async function loadEventEmailsForDay(
  teamIds: string[], emailType: string, day: string,
  opts: { department?: string | null; metric?: "sent" | "opened"; tz?: string } = {},
): Promise<{ rows: EventEmailDayRow[]; total: number } | null> {
  if (!isSupabaseConfigured || teamIds.length === 0) return { rows: [], total: 0 };
  try {
    const res = await fetch(`/api/tracker/event-emails-by-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamIds, emailType, department: opts.department ?? null, metric: opts.metric ?? "sent", tz: opts.tz, day }),
    });
    if (!res.ok) { console.warn("[tracker] event day rows read failed: HTTP", res.status); return null; }
    const j = await res.json();
    return { rows: (j.rows ?? []) as EventEmailDayRow[], total: Number(j.total ?? 0) };
  } catch (e) { console.warn("[tracker] event day rows read error:", e); return null; }
}

/** The transactional KPI strip's counts: roi_event_emails by status for these teams over the last
 * `sinceDays` days (C6: one source, one grain, one window). null = the read failed. */
export async function loadEventStatusCounts(
  teamIds: string[], opts: { department?: string | null; sinceDays?: number } = {},
): Promise<Record<string, TxStatusCounts> | null> {
  if (!isSupabaseConfigured) return {};
  try {
    const res = await fetch(`/api/tracker/event-status-counts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamIds, department: opts.department ?? null, sinceDays: opts.sinceDays ?? 30 }),
    });
    if (!res.ok) { console.warn("[tracker] event status counts read failed: HTTP", res.status); return null; }
    const j = await res.json();
    return (j.types ?? {}) as Record<string, TxStatusCounts>;
  } catch (e) { console.warn("[tracker] event status counts read error:", e); return null; }
}

/** Who the cron would email for (department, type), and why everyone else on the list is held. */
export type EligibleRecipients = { eligible: { email: string; name: string | null }[]; held: { email: string; name: string | null; why: string }[] };
export async function loadEligibleRecipients(teamId: string, department: string, type: string): Promise<EligibleRecipients | null> {
  if (!teamId) return null;
  try {
    const qs = new URLSearchParams({ teamId, department, type });
    const res = await fetch(`/api/tracker/eligible-recipients?${qs.toString()}`, { cache: "no-store", headers: trackerAuthHeaders() });
    if (!res.ok) { console.warn("[tracker] eligible recipients read failed: HTTP", res.status); return null; }
    const j = await res.json();
    return { eligible: j.eligible ?? [], held: j.held ?? [] };
  } catch (e) { console.warn("[tracker] eligible recipients read error:", e); return null; }
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
    const r = await fetch(`/api/email/roi-event-daycounts?${qs.toString()}`, { cache: "no-store", headers: trackerAuthHeaders() });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && typeof (j as { days?: unknown }).days === "object") return (j as { days: EventDayCounts }).days || {};
  } catch { /* fall through */ }
  return {};
}

/** Lifetime count of SENT digest runs for the given rooftops — all-time, not just the loaded
 * window. Optionally scoped to a cadence (to match the modal's current daily/weekly/monthly view)
 * and a department. Uses a head-only exact count (no rows fetched). */
export async function countDigestSent(teamIds: string[], opts: { cadence?: string; department?: string | null } = {}): Promise<number> {
  if (!isSupabaseConfigured || teamIds.length === 0) return 0;
  try {
    const res = await fetch(`/api/tracker/count-digest-sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamIds, cadence: opts.cadence ?? null, department: opts.department ?? null }),
    });
    if (!res.ok) { console.warn("[tracker] lifetime digest-sent count failed: HTTP", res.status); return 0; }
    const j = await res.json();
    return (j.count ?? 0) as number;
  } catch (e) { console.warn("[tracker] lifetime digest-sent count error:", e); return 0; }
}

/** Lifetime count of a transactional type's produced emails for the given rooftops — all-time.
 * metric 'sent' = status='sent'; 'opened' = an open was recorded (opened_at set). Head-only count. */
export async function countEventByMetric(teamIds: string[], emailType: string, metric: "sent" | "opened", opts: { department?: string | null } = {}): Promise<number> {
  if (!isSupabaseConfigured || teamIds.length === 0) return 0;
  try {
    const res = await fetch(`/api/tracker/count-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamIds, emailType, metric, department: opts.department ?? null }),
    });
    if (!res.ok) { console.warn("[tracker] lifetime event count failed: HTTP", res.status); return 0; }
    const j = await res.json();
    return (j.count ?? 0) as number;
  } catch (e) { console.warn("[tracker] lifetime event count error:", e); return 0; }
}

/** One eligible event from ClickHouse (history + live), via /api/email/roi-event-list. `cronEventKey`
 * is the key the events cron files this event's email under; `stored` is the email the pipeline
 * produced for it, matched on that key by the server (null when none). */
type CHEvent = { eventKey: string; cronEventKey?: string; cronEventKeys?: string[]; customer?: string; phone?: string; createdAt: string; direction?: string; label?: string; sub?: string; stored?: (EventEmailRow & { department?: string }) | null };

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
  opts: { limit?: number; offset?: number; direction?: string | null; tz?: string | null } = {},
): Promise<EventEmailPage> {
  const limit = opts.limit ?? 50;
  const offset = Math.max(0, opts.offset ?? 0);
  const direction = opts.direction ?? null;
  // 1) eligible events from ClickHouse (all dates)
  let ch: CHEvent[] | null = null;
  try {
    const qs = new URLSearchParams({ teamId, department: department || "", emailType, sinceDays: "365", limit: String(limit), offset: String(offset) });
    if (direction) qs.set("direction", direction);
    // The dealer's zone decides the cron's dealer-local keys (and day filing) for each event.
    if (opts.tz) qs.set("tz", opts.tz);
    const r = await fetch(`/api/email/roi-event-list?${qs.toString()}`, { cache: "no-store", headers: trackerAuthHeaders() });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray((j as { events?: unknown }).events)) ch = (j as { events: CHEvent[] }).events;
  } catch { /* fall through to stored-only */ }
  if (ch === null) return loadEventEmails(teamId, department, emailType, { limit, offset, direction });
  // 2) The server already matched each event to the email the pipeline produced for it, on the
  // cron's key (A4 F13: matching on the list's own key never hit, so every row read "eligible").
  const rows: EventEmailRow[] = ch.map((ev) => {
    const cronKey = ev.cronEventKey || ev.cronEventKeys?.[0] || ev.eventKey;
    const cronKeys = ev.cronEventKeys?.length ? ev.cronEventKeys : [cronKey];
    if (ev.stored) return { ...ev.stored, source_event_key: ev.eventKey, cron_event_key: cronKey, cron_event_keys: cronKeys };
    return {
      id: "", email_type: emailType, status: "not_emailed",
      subject: ev.label || null, recipients: null, sent_at: null,
      created_at: (ev.createdAt || "").replace(" ", "T"), // CH DateTime → ISO-ish for Date()
      opened_at: null, open_count: 0, reason: ev.sub || null,
      rendered_html: null, event_key: ev.eventKey, message_id: null,
      source_event_key: ev.eventKey, cron_event_key: cronKey, cron_event_keys: cronKeys,
    };
  });
  return { rows, hasMore: ch.length === limit };
}

/** The tracker sign-in token (see TrackerAuthGate) — the server now requires this on every
 * config-mutation route (recipients*, rooftop-config, rooftop-live-status, csm, missing-rooftop,
 * config-audit-log). Shared here so every fetch in this module (and sendDigest.ts) can attach it. */
export const TRACKER_TOKEN_KEY = "vini-tracker-token"; // also hard-coded in index.html's prefetch
export function trackerAuthHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(TRACKER_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

/** Who's making config changes from this browser — attached to every config write so the
 * "History" panel (roi_config_audit_log) can attribute it. Not real auth (the tracker sits
 * behind one shared login, see TrackerAuthGate) — just a cheap, persistent display name. */
const ACTOR_KEY = "vini-tracker-actor";
// One open ask at a time: two saves fired before a name is stored share the same dialog.
let actorAsk: Promise<string> | null = null;
export async function getActorName(): Promise<string> {
  try {
    const stored = localStorage.getItem(ACTOR_KEY);
    if (stored) return stored;
  } catch { /* private mode → ask every time */ }
  if (!actorAsk) {
    actorAsk = promptDialog({
      title: "What's your name?",
      message: "It's shown beside your changes in the config history. This browser only asks once.",
      label: "Your name",
      confirmLabel: "Save",
    }).then((v) => {
      const name = (v ?? "").trim();
      if (name) { try { localStorage.setItem(ACTOR_KEY, name); } catch { /* ignore */ } }
      return name;
    }).finally(() => { actorAsk = null; });
  }
  return actorAsk;
}
export function setActorName(name: string): void {
  try { localStorage.setItem(ACTOR_KEY, name.trim()); } catch { /* ignore */ }
}

/** Persist a per-rooftop email-type toggle (roi_rooftop_config) through the gated server route. */
// Persist rooftop config (email-type toggles + daily template) through the backend
// (service key) so the browser's publishable key never needs write grants on
// roi_rooftop_config. The server whitelists the columns it accepts.
export async function updateRooftopConfig(teamId: string, patch: Partial<RooftopConfig> & { sms_enabled?: boolean; weekly_send_dow?: number; monthly_send_day?: number }): Promise<{ ok: boolean; error?: string }> {
  if (!teamId) return { ok: false, error: "teamId required" };
  try {
    const res = await fetch("/api/rooftop-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamId, actor: await getActorName(), ...patch }),
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
    const r = await fetch(`/api/config-audit-log?teamId=${encodeURIComponent(teamId)}`, { cache: "no-store", headers: trackerAuthHeaders() });
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
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamId, isLive, actor: await getActorName() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) return { ok: false, error: (body as { error?: string }).error || `Save failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Set (or clear, with stage=null) a rooftop's MANUAL lifecycle-stage override.
 *
 * roi_rooftop_config.lifecycle_status is rewritten every morning by the sync-lifecycle cron from the
 * billing ledger, so setting a stage by hand never stuck — rooftops flipped back to "onboarding" at
 * 05:10 the next day. This writes the separate override column the cron doesn't touch. "churn" is
 * not settable: churn is a billing fact, and an override can never mask a churned rooftop (the
 * generated lifecycle_effective column and the send-side churn gate both refuse). */
export async function updateLifecycleOverride(
  teamId: string,
  stage: "live" | "onboarding" | "contracting" | null,
): Promise<{ ok: boolean; error?: string; effective?: string }> {
  if (!teamId) return { ok: false, error: "teamId required" };
  try {
    const res = await fetch("/api/tracker/lifecycle-override", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamId, stage, actor: await getActorName() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) return { ok: false, error: (body as { error?: string }).error || `Save failed (HTTP ${res.status})` };
    return { ok: true, effective: (body as { effective?: string }).effective };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Toggle a single (team, department)'s dry_run hold (Live ↔ Paused). Routed through the server
 * (service key, audited) so the browser's publishable/anon key never needs write grants on
 * roi_live_departments — this was the last direct browser write to a roi_* table. */
export async function updateRooftopDryRun(teamId: string, department: string, dryRun: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!teamId || !department) return { ok: false, error: "teamId + department required" };
  try {
    const res = await fetch("/api/tracker/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamId, department, dryRun, actor: await getActorName() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) return { ok: false, error: (body as { error?: string }).error || `Save failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
