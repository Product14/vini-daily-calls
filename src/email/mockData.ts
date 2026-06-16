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
  | "bounced";

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
  /** Who the email was actually sent to (run.recipients). */
  recipients?: { email: string; name?: string; received?: boolean; bounced?: boolean }[];
};

export type SendCell = {
  date: string; // ISO YYYY-MM-DD
  cadence: Cadence;
  status: SendStatus;
  reason?: NotSentReason;
  /** Per-department runs behind this cell (real data from roi_digest_runs). */
  runs?: CellRun[];
};

export type RooftopRow = {
  rooftop_id: string;
  name: string;
  enterprise_id?: string;
  team_id?: string;
  /** Set when this row tracks a single department (one row per dept). */
  department?: DeptKind;
  /** Per-department dry-run flag (roi_live_departments.dry_run). */
  dryRun?: boolean;
  /** Dealer timezone (roi_rooftop_config.timezone) — used to build link windows. */
  timezone?: string;
  /** Local send hour (0–23) / minute (roi_rooftop_config.digest_send_hour/minute). */
  sendHour?: number;
  sendMinute?: number;
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
};

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
};

export const NOT_SENT_REASON_CTA: Record<NotSentReason, { label: string; tone: "warn" | "danger" }> = {
  recipients_missing: { label: "+ Add recipients", tone: "warn" },
  tag_missing: { label: "+ Classify", tone: "warn" },
  recipient_placeholder: { label: "+ Fix email", tone: "warn" },
  smtp_timeout: { label: "⚠ Retry", tone: "danger" },
  scheduler_skipped: { label: "→ Send now", tone: "danger" },
  silent_day: { label: "—", tone: "warn" },
  bounced: { label: "+ Update email", tone: "danger" },
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
  emailStatus: { sent: number; notSent: number; sentRatePct: number };
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
  let sent = 0;
  let notSent = 0;
  for (const r of rooftops) {
    const cells = cadence === "daily" ? r.daily : cadence === "weekly" ? r.weekly : r.monthly;
    const latest = cells[0];
    if (!latest) continue;
    if (latest.status === "sent" || latest.status === "suppressed") sent += 1;
    else if (latest.status === "not_sent") notSent += 1;
  }
  const denom = sent + notSent;
  const sentRatePct = denom > 0 ? Math.round((sent / denom) * 100) : 0;

  return {
    liveAgents,
    liveAgentsTotal: Object.values(liveAgents).reduce((s, x) => s + x, 0),
    rooftopsWithAgents,
    liveDepartments,
    emailStatus: { sent, notSent, sentRatePct },
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
