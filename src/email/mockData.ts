/**
 * Tracker · rooftop list + agents + departments + send history.
 *
 * Real rooftop list imported from the team's Google Sheet (04 Jun 2026).
 * Enriched with the agents/departments hierarchy the CSM-ops tracker needs:
 *
 *   Rooftop
 *     └─ agents_live · which agent types are taking calls
 *        (sales/service × inbound/outbound)
 *     └─ departments · sales + service · each live? + recipients
 *
 *   A daily email is "sent" for a rooftop on a date when at least one
 *   recipient in EITHER the sales OR service department received it.
 */
export type SendStatus =
  | "sent"
  | "not_sent"
  | "error"        // send genuinely FAILED (mail gateway / render / unexpected throw) — shown as "Failed"
  | "suppressed"
  | "scheduled"
  | "not_subscribed";

export type NotSentReason =
  | "recipients_missing"
  | "tag_missing"
  | "recipient_placeholder"
  | "smtp_timeout"
  | "scheduler_skipped"
  | "silent_day"
  | "bounced"
  | "spyne_preview"
  | "send_failed";

export type Cadence = "daily" | "weekly" | "monthly";

export type AgentType = "sales_ib" | "sales_ob" | "service_ib" | "service_ob";
export type DeptKind = "sales" | "service";

export type Recipient = {
  email: string; // "" = no email on file, "m" = placeholder
  name?: string;
  /** Did this person receive the most recent send for this rooftop? */
  received: boolean;
  /** roi_recipients.email_enabled — whether this recipient currently receives sends. */
  enabled?: boolean;
  /** roi_recipients.phone — E.164-ish phone for the SMS channel (undefined = none on file). */
  phone?: string;
  /** roi_recipients.sms_enabled — whether this recipient receives SMS notifications. */
  smsEnabled?: boolean;
};

export type Department = {
  kind: DeptKind;
  live: boolean; // has at least one live agent
  agents: AgentType[]; // which agent types power this department
  recipients: Recipient[]; // ENABLED recipients (used for sending)
  allRecipients?: Recipient[]; // every configured recipient incl. disabled (view + toggle)
};

/** Loose shape of the stored digest payload (roi_digest_runs.metrics jsonb). */
export type DigestMetrics = Record<string, number | string>;

/** One department's run on a given date — carries the real stored payload. */
export type CellRun = {
  department: DeptKind;
  status: SendStatus;
  reason?: string; // raw backend reason (e.g. 'dry_run', 'no_data')
  metrics?: DigestMetrics;
  /** Exact HTML stored at send time (real sends only; null for metrics-only backfill). */
  renderedHtml?: string;
  /** First time the email was opened (tracking pixel). */
  openedAt?: string;
  /** Total tracking-pixel loads (open count) for this run. */
  openCount?: number;
  /** Who the email was actually sent to (run.recipients). */
  recipients?: { email: string; name?: string; received?: boolean; bounced?: boolean; opened?: boolean; openedAt?: string }[];
};

export type SendCell = {
  date: string; // ISO YYYY-MM-DD
  cadence: Cadence;
  status: SendStatus;
  reason?: NotSentReason;
  /** Per-department runs behind this cell (real data from roi_digest_runs). */
  runs?: CellRun[];
};

/** Account-level BUSINESS lifecycle stage (roi_rooftop_config.lifecycle_status) — orthogonal to
 * `liveStatus` below, which is a per-DEPARTMENT technical send-status. A rooftop can be
 * "onboarding" here while a department's dry-run badge already reads "Live" (its digest is
 * technically sending) — that's not a contradiction, just two different questions. Derived from
 * ClickHouse's arr_bucket (Contract-Initiated/PWS → contracting; Onboarding/OB-Live → onboarding;
 * Live → live; Churned → churn) by the sync-lifecycle cron. */
export type LifecycleStatus = "onboarding" | "contracting" | "live" | "churn";

export type RooftopRow = {
  rooftop_id: string;
  name: string;
  enterprise_id?: string;
  team_id?: string;
  /** Set when this row tracks a single department (one row per dept). */
  department?: DeptKind;
  /** Per-department dry-run flag (roi_live_departments.dry_run). */
  dryRun?: boolean;
  /** Lifecycle status derived from dry_run + send history (see dataSource):
   *   "live"        — dry_run=false; the scheduled cron sends real emails.
   *   "paused"      — dry_run on, but a real digest HAS been sent before (was live, now held).
   *   "not_started" — dry_run on and NO real digest has ever been sent (never gone live). */
  liveStatus?: "live" | "paused" | "not_started";
  /** Account-level business stage — see LifecycleStatus. Defaults to "live" for rooftops the
   * lifecycle sync hasn't classified yet (back-compat: never hides an already-visible rooftop). */
  lifecycleStatus?: LifecycleStatus;
  /** A human's manual stage override (roi_rooftop_config.lifecycle_status_override), or null to
   * follow the billing ledger. When set it IS lifecycleStatus above — kept separately so the UI can
   * mark the stage as manually set and offer to clear it. Never "churn": churn is a billing fact and
   * an override can't mask it. */
  lifecycleOverride?: "live" | "onboarding" | "contracting" | null;
  /** The ledger's own lifecycle_status, underneath any override — lets the UI show what billing
   * thinks when a human has disagreed with it. */
  lifecycleLedger?: string | null;
  /** Raw ClickHouse bucket behind lifecycleStatus (e.g. "PWS", "OB-Live") — display-only detail. */
  arrBucket?: string;
  /** Lifecycle milestone dates (roi_rooftop_config), all optional/nullable. */
  lifecycleDates?: { contracted?: string | null; onboarding?: string | null; obLive?: string | null; live?: string | null; churn?: string | null };
  /** Operational activity (last 30d) from ClickHouse — orthogonal to lifecycleStatus. Shows whether the
   * AI is actually handling calls/SMS, even for a pre-live (onboarding/contracting) rooftop. */
  activity?: { calls30d: number; sms30d: number; lastActivityAt?: string | null };
  /** Stage-relevant owner names (from ClickHouse POC emails): ae = Account Executive (contracting),
   * ob = Onboarding owner (onboarding). CSM (live) stays on `csm`. */
  ae?: string;
  ob?: string;
  /** True when this row has no roi_live_departments entry (no digest-cell history) — the tracker
   * renders these in the lightweight LifecycleList instead of the digest grid. */
  lifecycleOnly?: boolean;
  /** Dealer timezone (roi_rooftop_config.timezone) — used to build link windows. */
  timezone?: string;
  /** Local send hour (0–23) / minute (roi_rooftop_config.digest_send_hour/minute). */
  sendHour?: number;
  sendMinute?: number;
  /** Weekly/monthly digest send-day (roi_rooftop_config.weekly_send_dow/monthly_send_day).
   * weeklySendDow: 0=Sun..6=Sat. monthlySendDay: 1..28. Both default to 1 server-side. */
  weeklySendDow?: number;
  monthlySendDay?: number;
  csm: string;
  group?: string;
  /** Detected live agents · present even when the rooftop isn't classified */
  agents_live: AgentType[];
  /** Classified departments · empty when tag is missing */
  departments: Department[];
  current_block?: NotSentReason | null;
  daily: SendCell[];
  weekly: SendCell[];
  monthly: SendCell[];
  /** Per-rooftop email-type enable/disable (roi_rooftop_config). Shared across the rooftop's dept rows. */
  config?: RooftopConfig;
  /** roi_rooftop_config.sms_enabled — rooftop-level master switch for the SMS channel. */
  smsEnabled?: boolean;
};

/** The 7 configurable email types, in display order. */
export const EMAIL_TYPES = [
  { key: "daily_enabled", label: "Daily digest" },
  { key: "weekly_enabled", label: "Weekly digest" },
  { key: "monthly_enabled", label: "Monthly digest" },
  { key: "post_appointment_enabled", label: "Post-appointment" },
  { key: "post_conversation_enabled", label: "Post-conversation" },
  { key: "action_item_enabled", label: "Action item" },
  { key: "action_item_overdue_enabled", label: "Action item overdue" },
] as const;
export type EmailTypeKey = (typeof EMAIL_TYPES)[number]["key"];

/** The notification types as BARE keys (not the config "<type>_enabled" columns) — the keys used
 * in the roi_recipients.subscriptions matrix. Order = display order in the subscription grid.
 * 'chat' is subscription-only: website-chat emails store as post_conversation but recipient-match
 * on this key (default ON for email), so a call-summary opt-out doesn't silence chat. */
export const SUBSCRIPTION_TYPES = [
  { key: "daily", label: "Daily digest" },
  { key: "weekly", label: "Weekly digest" },
  { key: "monthly", label: "Monthly digest" },
  { key: "post_appointment", label: "Post-appointment" },
  { key: "post_conversation", label: "Post-conversation" },
  { key: "chat", label: "Website chat" },
  { key: "action_item", label: "Action item" },
  { key: "action_item_overdue", label: "Action item overdue" },
] as const;
export type SubType = (typeof SUBSCRIPTION_TYPES)[number]["key"];
export type Channel = "email" | "sms";
export type Subscriptions = Partial<Record<SubType, { email?: boolean; sms?: boolean }>>;
export type RecipientRole = "salesperson" | "bdc" | "gm";
const DIGEST_SUB_TYPES = new Set<SubType>(["daily", "weekly", "monthly"]);
/** Mirror of server/roi-cron/subscriptions.cjs — email: all on; sms: transactional on, digests off,
 * chat off (chat is email-only today; SMS for it must be explicit opt-in if it ever ships). */
export function defaultSub(type: SubType, channel: Channel): boolean {
  if (channel === "email") return true;
  return !DIGEST_SUB_TYPES.has(type) && type !== "chat";
}
/** Effective subscription for a cell — explicit value wins, else the default. */
export function isSubscribed(subs: Subscriptions | null | undefined, type: SubType, channel: Channel): boolean {
  const cell = subs && subs[type];
  const v = cell ? cell[channel] : undefined;
  return typeof v === "boolean" ? v : defaultSub(type, channel);
}
/** Which DAILY-digest template a rooftop receives: 'v1' = classic (legacy, default), 'v2' = redesign. */
export type DailyTemplate = "v1" | "v2";
/** Content focus (the appointment/conversation checker). Orthogonal to DailyTemplate (the v1/v2 DESIGN):
 *  'conversation' leads with conversations + demotes appointments; 'appointment' leads with appointments;
 *  'auto' (default) lets the resolver decide — today → conversation; Phase 2 → feature-flag derived. */
export type DigestFocus = "auto" | "conversation" | "appointment";
export type RooftopConfig = Record<EmailTypeKey, boolean> & { daily_template: DailyTemplate; digest_focus: DigestFocus };

/** The 4 transactional (per-event) email types — match roi_event_emails.email_type values. */
export const TRANSACTIONAL_TYPES = [
  { key: "post_appointment", label: "Post-appointment" },
  { key: "post_conversation", label: "Post-conversation" },
  { key: "action_item", label: "Action item" },
  { key: "action_item_overdue", label: "Action item overdue" },
] as const;
export type TransactionalKey = (typeof TRANSACTIONAL_TYPES)[number]["key"];

const TODAY = "2026-06-04";

function isoDaysAgo(daysAgo: number): string {
  const [y, m, d] = TODAY.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}
function isoWeeksAgo(weeksAgo: number): string {
  return isoDaysAgo(weeksAgo * 7);
}
function isoMonthsAgo(monthsAgo: number): string {
  const [y, m, d] = TODAY.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCMonth(date.getUTCMonth() - monthsAgo);
  return date.toISOString().slice(0, 10);
}

/* ============================================================
   Raw sheet rows · what landed in the CSV
   ============================================================ */
type SheetRow = {
  name: string;
  enterprise_id?: string;
  team_id?: string;
  tag?: DeptKind | null;
  recipients: string[];
  current_status: "sent" | "";
  csm: string;
  /** Synthesize a 2nd department that's live but not yet emailed (real-world gap). */
  second_dept?: DeptKind;
};

const SHEET: SheetRow[] = [
  { name: "Honda DTLA", enterprise_id: "7d06f7427", team_id: "9923577d07", tag: null, recipients: [], current_status: "", csm: "Aanya Sharma" },
  { name: "Covina Kia", enterprise_id: "7d06f7427", team_id: "49a06313cf", tag: "service", recipients: ["mamri@covinakia.com"], current_status: "sent", csm: "Aanya Sharma", second_dept: "sales" },
  { name: "Honda Resida", enterprise_id: "7d06f7427", team_id: "2b110492b6", tag: null, recipients: [], current_status: "", csm: "Aanya Sharma" },
  { name: "Victory", enterprise_id: "ef09d889d", team_id: "bf718528af", tag: "service", recipients: ["sergio.reyna@victorytoyota.com", "david.quinto@victorytoyota.com"], current_status: "sent", csm: "Carlos Vega", second_dept: "sales" },
  { name: "Brown Daub", enterprise_id: "fe7e2e8e5", team_id: "5d2ffea9c0", tag: "service", recipients: ["m"], current_status: "", csm: "Carlos Vega" },
  { name: "World Car Mazda", enterprise_id: "4f772edd8", team_id: "d4c824c0-9", tag: "service", recipients: ["m"], current_status: "", csm: "Carlos Vega" },
  { name: "World Car Kia South", enterprise_id: "4f772edd8", team_id: "48d0fea7-2", tag: "service", recipients: ["m"], current_status: "", csm: "Carlos Vega" },
  { name: "World Car Kia San Antonio", enterprise_id: "4f772edd8", team_id: "d2999d21-c", tag: "service", recipients: ["brent.worldcar@gmail.com", "rene.galvan@worldcarsatx.com", "sandrag@worldcar.com"], current_status: "sent", csm: "Carlos Vega" },
  { name: "Burns Hyundai", enterprise_id: "4c65517e7", team_id: "9c9e3d1259", tag: "service", recipients: ["tsmith@burnsbuickgmc.com", "pgutowski@burnsbuickgmc.com", "mbrairton@burnshyundai.com"], current_status: "sent", csm: "Diego Park", second_dept: "sales" },
  { name: "Toronto Honda", enterprise_id: "56a910bcc", team_id: "1c402ffba8", tag: null, recipients: [], current_status: "", csm: "Diego Park" },
  { name: "i40 Auto", enterprise_id: "b7a9c31a8", team_id: "b4df3297f5", tag: "sales", recipients: ["toddi@i40auto.com", "ahammood@i40autogroup.com"], current_status: "sent", csm: "Diego Park", second_dept: "service" },
  { name: "Dream Nissan Midwest", tag: "sales", recipients: [], current_status: "", csm: "Mira Patel" },
  { name: "Dream Nissan Lawrence", tag: "sales", recipients: [], current_status: "", csm: "Mira Patel" },
  { name: "Dream Nissan Kansas", tag: "sales", recipients: [], current_status: "", csm: "Mira Patel" },
  { name: "Merc Arrington", tag: null, recipients: [], current_status: "", csm: "Mira Patel" },
  { name: "Edwards Chevy 280", tag: null, recipients: [], current_status: "", csm: "Mira Patel" },
  { name: "Wolfchase Honda", tag: null, recipients: [], current_status: "", csm: "Aanya Sharma" },
  { name: "Wolfchase Nissan", tag: null, recipients: [], current_status: "", csm: "Aanya Sharma" },
];

/* ============================================================
   Deterministic per-rooftop randomness
   ============================================================ */
function hashSeed(s: string): () => number {
  let seed = 0;
  for (const ch of s) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

/* ============================================================
   Derive agents_live for a rooftop
   ============================================================ */
function deriveAgents(row: SheetRow, r: () => number): AgentType[] {
  const agents = new Set<AgentType>();
  // The tagged (or 2nd) dept's inbound agent is always live
  if (row.tag) agents.add(`${row.tag}_ib` as AgentType);
  if (row.second_dept) agents.add(`${row.second_dept}_ib` as AgentType);
  // Tag-missing rooftops still have detected agents (that's WHY classification matters)
  if (!row.tag && !row.second_dept) {
    // Heuristic: nameplate hints. Default service IB for service-heavy brands.
    const svc = /honda|nissan|chevy|merc/i.test(row.name);
    agents.add(svc ? "service_ib" : "sales_ib");
    if (r() > 0.6) agents.add(svc ? "sales_ib" : "service_ib");
  }
  // Outbound agents for ~40% of rooftops
  if (r() > 0.6 && row.tag) agents.add(`${row.tag}_ob` as AgentType);
  if (r() > 0.7 && row.second_dept) agents.add(`${row.second_dept}_ob` as AgentType);
  return Array.from(agents);
}

/* ============================================================
   Derive departments (with recipients) for a rooftop
   ============================================================ */
function deriveBlock(row: SheetRow): NotSentReason | null {
  if (row.current_status === "sent") return null;
  if (row.tag == null) return "tag_missing";
  if (row.recipients.length === 1 && row.recipients[0] === "m") {
    return "recipient_placeholder";
  }
  if (row.recipients.length === 0) return "recipients_missing";
  return "scheduler_skipped";
}

function buildRecipients(row: SheetRow): Recipient[] {
  if (row.recipients.length === 0) return [];
  if (row.recipients.length === 1 && row.recipients[0] === "m") {
    return [{ email: "", name: "Recipient (placeholder)", received: false }];
  }
  const sent = row.current_status === "sent";
  return row.recipients.map((email) => ({
    email,
    name: nameFromEmail(email),
    // when sent: most received; deterministically mark one as not-received (bounce)
    received: sent,
  }));
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function deriveDepartments(row: SheetRow, agents: AgentType[]): Department[] {
  const depts: Department[] = [];
  const agentsFor = (k: DeptKind) =>
    agents.filter((a) => a.startsWith(k)) as AgentType[];

  if (row.tag) {
    const recips = buildRecipients(row);
    // Sent rooftops: mark the last recipient as a bounce so "who didn't receive"
    // has something to show.
    if (row.current_status === "sent" && recips.length > 1) {
      recips[recips.length - 1] = { ...recips[recips.length - 1], received: false };
    }
    depts.push({
      kind: row.tag,
      live: agentsFor(row.tag).length > 0 || true,
      agents: agentsFor(row.tag),
      recipients: recips,
    });
  }
  if (row.second_dept) {
    // 2nd dept: live agent but no recipients yet (real-world "live but not emailed")
    depts.push({
      kind: row.second_dept,
      live: agentsFor(row.second_dept).length > 0 || true,
      agents: agentsFor(row.second_dept),
      recipients: [],
    });
  }
  return depts;
}

/* ============================================================
   Send-history generators
   ============================================================ */
function buildDaily(row: SheetRow, block: NotSentReason | null): SendCell[] {
  return Array.from({ length: 14 }, (_, i) => {
    const date = isoDaysAgo(i);
    if (row.current_status === "sent") {
      if (i === 6 || i === 13) {
        return { date, cadence: "daily" as const, status: "suppressed" as const, reason: "silent_day" as const };
      }
      return { date, cadence: "daily" as const, status: "sent" as const };
    }
    if (block === "scheduler_skipped") {
      if (i === 0) return { date, cadence: "daily" as const, status: "not_sent" as const, reason: block };
      return { date, cadence: "daily" as const, status: "sent" as const };
    }
    // tag_missing / recipients_missing / recipient_placeholder
    if (i <= 6) {
      return { date, cadence: "daily" as const, status: "not_sent" as const, reason: block ?? "scheduler_skipped" };
    }
    return { date, cadence: "daily" as const, status: "not_subscribed" as const };
  });
}

function buildWeekly(row: SheetRow, block: NotSentReason | null): SendCell[] {
  return Array.from({ length: 8 }, (_, i) => {
    const date = isoWeeksAgo(i);
    if (row.current_status === "sent") return { date, cadence: "weekly" as const, status: "sent" as const };
    if (i === 0) return { date, cadence: "weekly" as const, status: "not_sent" as const, reason: block ?? "scheduler_skipped" };
    return { date, cadence: "weekly" as const, status: "not_subscribed" as const };
  });
}

function buildMonthly(row: SheetRow, block: NotSentReason | null): SendCell[] {
  return Array.from({ length: 6 }, (_, i) => {
    const date = isoMonthsAgo(i);
    if (row.current_status === "sent") return { date, cadence: "monthly" as const, status: "sent" as const };
    if (i === 0) return { date, cadence: "monthly" as const, status: "not_sent" as const, reason: block ?? "scheduler_skipped" };
    return { date, cadence: "monthly" as const, status: "not_subscribed" as const };
  });
}

/* ============================================================
   Build the rooftop list
   ============================================================ */
function buildRooftops(): RooftopRow[] {
  return SHEET.map((row, i) => {
    const r = hashSeed(row.name);
    const agents = deriveAgents(row, r);
    const departments = deriveDepartments(row, agents);
    const block = deriveBlock(row);
    return {
      rooftop_id: `rt-${String(i + 1).padStart(3, "0")}`,
      name: row.name,
      enterprise_id: row.enterprise_id,
      team_id: row.team_id,
      csm: row.csm,
      group: row.enterprise_id ? `Ent ${row.enterprise_id.slice(0, 6)}` : undefined,
      agents_live: agents,
      departments,
      current_block: block,
      daily: buildDaily(row, block),
      weekly: buildWeekly(row, block),
      monthly: buildMonthly(row, block),
    };
  });
}

export const ROOFTOPS = buildRooftops();

/* ============================================================
   Labels
   ============================================================ */
export const AGENT_LABEL: Record<AgentType, string> = {
  sales_ib: "Sales · Inbound",
  sales_ob: "Sales · Outbound",
  service_ib: "Service · Inbound",
  service_ob: "Service · Outbound",
};

export const NOT_SENT_REASON_LABEL: Record<NotSentReason, string> = {
  recipients_missing: "Recipients missing",
  tag_missing: "Department not classified",
  recipient_placeholder: "Recipient is a placeholder",
  smtp_timeout: "SMTP timeout",
  scheduler_skipped: "Scheduler skipped",
  silent_day: "Silent day · no activity",
  bounced: "Inbox bounced",
  spyne_preview: "Preview · Spyne only (dealer not sent)",
  send_failed: "Send failed",
};

export const NOT_SENT_REASON_CTA: Record<NotSentReason, { label: string; tone: "warn" | "danger" }> = {
  recipients_missing: { label: "+ Add recipients", tone: "warn" },
  tag_missing: { label: "+ Classify", tone: "warn" },
  recipient_placeholder: { label: "+ Fix email", tone: "warn" },
  smtp_timeout: { label: "⚠ Retry", tone: "danger" },
  scheduler_skipped: { label: "→ Send now", tone: "danger" },
  silent_day: { label: "—", tone: "warn" },
  bounced: { label: "+ Update email", tone: "danger" },
  spyne_preview: { label: "→ Send now", tone: "warn" },
  send_failed: { label: "⚠ Retry", tone: "danger" },
};

export const TRACKER_META = {
  today: TODAY,
  lastSyncedMinutesAgo: 7,
  totalRooftops: ROOFTOPS.length,
  csms: Array.from(new Set(ROOFTOPS.map((r) => r.csm))),
  groups: Array.from(new Set(ROOFTOPS.map((r) => r.group).filter((g): g is string => !!g))),
  source: "Google Sheet · synced 04 Jun 2026",
};

/* ============================================================
   Summary + funnel computation
   ============================================================ */
export type Summary = {
  liveAgents: Record<AgentType, number>;
  liveAgentsTotal: number;
  rooftopsWithAgents: number;
  liveDepartments: { sales: number; service: number; total: number };
  emailStatus: { sent: number; notSent: number; suppressed: number; sentRatePct: number; opened: number; openRatePct: number };
};

export function computeSummary(rooftops: RooftopRow[], cadence: Cadence): Summary {
  const liveAgents: Record<AgentType, number> = {
    sales_ib: 0,
    sales_ob: 0,
    service_ib: 0,
    service_ob: 0,
  };
  let rooftopsWithAgents = 0;
  const liveDepartments = { sales: 0, service: 0, total: 0 };

  for (const r of rooftops) {
    if (r.agents_live.length > 0) rooftopsWithAgents += 1;
    for (const a of r.agents_live) liveAgents[a] += 1;
    for (const d of r.departments) {
      if (d.live) {
        liveDepartments[d.kind] += 1;
        liveDepartments.total += 1;
      }
    }
  }

  // Email status · most-recent date in the chosen cadence
  // Only truly-sent runs count toward `sent`. Suppressed runs were generated but never
  // emailed, so they're tracked separately and kept OUT of `sent` / the open-rate denominator
  // (a suppressed run can't be opened — counting it would deflate the open rate).
  let sent = 0;
  let notSent = 0;
  let suppressed = 0;
  let opened = 0; // sent cells whose run was opened (tracking pixel)
  for (const r of rooftops) {
    const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
    const latest = cells[0];
    if (!latest) continue;
    if (latest.status === "sent") {
      sent += 1;
      const wasOpened = (latest.runs ?? []).some(
        (run) => run.openedAt || (run.recipients ?? []).some((rec) => rec.opened)
      );
      if (wasOpened) opened += 1;
    } else if (latest.status === "suppressed") suppressed += 1;
    else if (latest.status === "not_sent") notSent += 1;
  }
  const denom = sent + notSent;
  const sentRatePct = denom > 0 ? Math.round((sent / denom) * 100) : 0;
  // Rooftop-granularity open rate: a sent rooftop counts as "opened" if ANY recipient opened.
  const openRatePct = sent > 0 ? Math.round((opened / sent) * 100) : 0;

  return {
    liveAgents,
    liveAgentsTotal: Object.values(liveAgents).reduce((s, x) => s + x, 0),
    rooftopsWithAgents,
    liveDepartments,
    emailStatus: { sent, notSent, suppressed, sentRatePct, opened, openRatePct },
  };
}

export type FunnelStage = { label: string; value: number; sub?: string };

export function computeFunnel(rooftops: RooftopRow[], cadence: Cadence): FunnelStage[] {
  const total = rooftops.length;
  const withAgents = rooftops.filter((r) => r.agents_live.length > 0).length;
  let liveDepts = 0;
  let deptsEmailed = 0;
  for (const r of rooftops) {
    const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
    const latest = cells[0];
    const sentToday = latest?.status === "sent" || latest?.status === "suppressed";
    for (const d of r.departments) {
      if (d.live) {
        liveDepts += 1;
        // a department counts as "emailed" if the rooftop sent AND the dept has recipients
        if (sentToday && d.recipients.some((rec) => rec.received)) deptsEmailed += 1;
      }
    }
  }
  return [
    { label: "Rooftops", value: total },
    { label: "With live agents", value: withAgents },
    { label: "Live departments", value: liveDepts },
    {
      label: "Departments emailed",
      value: deptsEmailed,
      sub: liveDepts > 0 ? `${Math.round((deptsEmailed / liveDepts) * 100)}% sent rate` : undefined,
    },
  ];
}

export function countStatus(
  rooftops: RooftopRow[],
  cadence: Cadence,
  days: number
): Record<SendStatus, number> {
  const counts: Record<SendStatus, number> = {
    sent: 0,
    suppressed: 0,
    not_sent: 0,
    not_subscribed: 0,
    scheduled: 0,
  };
  for (const r of rooftops) {
    const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
    for (const c of cells.slice(0, days)) counts[c.status] += 1;
  }
  return counts;
}

export function reasonBreakdown(
  rooftops: RooftopRow[]
): { reason: NotSentReason; count: number; rooftops: string[] }[] {
  const map = new Map<NotSentReason, string[]>();
  for (const r of rooftops) {
    if (r.current_block) {
      const list = map.get(r.current_block) ?? [];
      list.push(r.name);
      map.set(r.current_block, list);
    }
  }
  return Array.from(map.entries())
    .map(([reason, names]) => ({ reason, count: names.length, rooftops: names }))
    .sort((a, b) => b.count - a.count);
}

/** Helper · split agents into a sales row + service row for the matrix */
export function agentMatrix(agents: AgentType[]): {
  sales: { ib: boolean; ob: boolean };
  service: { ib: boolean; ob: boolean };
} {
  return {
    sales: {
      ib: agents.includes("sales_ib"),
      ob: agents.includes("sales_ob"),
    },
    service: {
      ib: agents.includes("service_ib"),
      ob: agents.includes("service_ob"),
    },
  };
}
