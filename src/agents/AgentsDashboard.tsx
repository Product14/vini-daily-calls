import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import OverallView from "./overall/OverallView";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

type AgentType = "Sales Inbound" | "Service Inbound" | "Sales Outbound" | "Service Outbound";

// V3 — activity-day anchoring (vs V2's lead-creation-day) fixes the ~3x OB
// appointment undercount. Two card shapes share most fields; daily adds `day`,
// totals adds `conversion_rate`. SQL alias `pld.` bleeds through on the team/
// enterprise key fields, so we read them via bracket access in helpers.
type AgentRowBase = {
  enterprise_name: string;
  rooftop_name: string;
  rooftop_stage: string | null;
  service_type: string;
  direction: string;
  agent_type: AgentType;

  touched_leads: number | null;
  qualified_leads: number | null;
  appointments: number | null;
  appointment_value: number | null;
  total_calls: number | null;
  total_sms: number | null;
  leads_with_calls: number | null;
  leads_with_sms: number | null;

  // Top-of-funnel pipeline (added in the latest Metabase card revision).
  // `new_leads_created` / `leads_contacted_from_new` are *rolling-window
  // rooftop×service_type totals*, NOT daily counts — every daily row for the
  // same (rooftop × service_type) carries the same constant value. Summing
  // them across days would multi-count; sum across rooftops is meaningful.
  // `capture_rate` = leads_contacted_from_new / new_leads_created.
  // `abr` (Appointment Booking Rate) = appointments / qualified_leads — this
  // one IS per-row (varies day to day in daily, varies per agent in totals).
  new_leads_created: number | null;
  leads_contacted_from_new: number | null;
  capture_rate: number | null;
  abr: number | null;

  // Inbound-only outcome counts (Sales IB / Service IB). Distinct lead counts:
  // `transfer_leads` = leads the agent handed off to a human; `callback_leads`
  // = leads for which a callback was scheduled. Null on Outbound rows.
  transfer_leads: number | null;
  callback_leads: number | null;
};
// Index signature for the `pld.` prefixed fields (TS can't express dotted keys
// in a closed type; we just hand-roll the access).
type AgentRowDaily  = AgentRowBase & { day: string } & Record<string, unknown>;
type AgentRowTotals = AgentRowBase & { conversion_rate: number | null } & Record<string, unknown>;
type AnyAgentRow    = AgentRowDaily | AgentRowTotals;

// Field-name compatibility shim. The Metabase cards have flipped between
// `pld.team_id` (qualified) and `team_id` (bare) — depending on which SQL
// revision is live — so we read whichever the row carries. Same for the
// enterprise id. Returns "" when neither is present so downstream callers
// fall through to the rooftop-name composite key.
const teamId = (r: AnyAgentRow): string => {
  const v = r["team_id"] ?? r["pld.team_id"];
  return v == null ? "" : String(v);
};
const enterpriseId = (r: AnyAgentRow): string => {
  const v = r["enterprise_id"] ?? r["pld.enterprise_id"];
  return v == null ? "" : String(v);
};

const AGENT_TYPES: AgentType[] = ["Sales Inbound", "Service Inbound", "Sales Outbound", "Service Outbound"];
const AGENT_LABELS: Record<AgentType, string> = {
  "Sales Inbound": "Sales IB",
  "Service Inbound": "Service IB",
  "Sales Outbound": "Sales OB",
  "Service Outbound": "Service OB",
};
const AGENT_COLORS: Record<AgentType, string> = {
  "Sales Inbound": "#f59e0b",
  "Service Inbound": "#22c55e",
  "Sales Outbound": "#6366f1",
  "Service Outbound": "#0ea5e9",
};

// ─── ROI model ────────────────────────────────────────────────────────────────
// Per-appointment dollar value the agent generates, by agent type. ROI Multiple
// = (appts × cost-per-appt) ÷ MRR — i.e. how many times the monthly fee the
// agent paid back in booked-appointment value this period.
const COST_PER_APPT: Record<AgentType, number> = {
  "Sales Inbound":   200,
  "Sales Outbound":  250,
  "Service Inbound": 100,
  "Service Outbound":200,
};
// Premium dealers get a flat $750 per appointment regardless of agent type
// (higher-value showrooms where each booked visit is worth far more). Editable
// allowlist — matched case-insensitively against rooftop OR enterprise name.
const PREMIUM_DEALER_APPT_COST = 750;
const PREMIUM_DEALERS = new Set<string>([
  "mercedes-benz of arlington",
]);
const normName = (s: string) => s.trim().toLowerCase();
function isPremiumDealer(rooftopName: string, enterpriseName: string): boolean {
  return PREMIUM_DEALERS.has(normName(rooftopName)) || PREMIUM_DEALERS.has(normName(enterpriseName));
}
function costPerAppt(agentType: AgentType, rooftopName: string, enterpriseName: string): number {
  if (isPremiumDealer(rooftopName, enterpriseName)) return PREMIUM_DEALER_APPT_COST;
  return COST_PER_APPT[agentType] ?? 0;
}

// RAG thresholds. Green ROI ≥ 3×, Amber 1.5×–3×, Performance red < 1.5×. A rooftop
// with < 100 top-of-funnel (new) leads is Red regardless of ROI — too little
// volume to trust the multiple.
// RAG thresholds on the ROI multiple:
//   ≥ 3× → Green   ·   1.5×–3× → Amber   ·   < 1.5× → Red
const ROI_GREEN = 3;
const ROI_AMBER = 1.5;
const TOFU_MIN_LEADS = 100;

// Every rooftop resolves to one of three states — never N/A. Anything we can't
// score (no Metabase activity, MRR unknown, too little volume) falls to Red.
type RagStatus = "green" | "amber" | "red";
const RAG_COLORS: Record<RagStatus, { bg: string; fg: string }> = {
  green: { bg: "#dcfce7", fg: "#166534" },
  amber: { bg: "#fef3c7", fg: "#92400e" },
  red:   { bg: "#fee2e2", fg: "#991b1b" },
};

// Tab selection extends AgentType with an "All" pseudo-value that aggregates
// every agent type for the same rooftop. Per-agent KPIs sum across agents,
// the rooftop table collapses per (team_id) instead of per (team_id × agent),
// and the chart's funnel shows the combined Touched/Qualified/Appts series.
type ActiveAgent = AgentType | "All";
const ALL_AGENT_COLOR = "#0f172a";

// Stage priority for the "All Agents" merge — when one rooftop has different
// stages on different agent_types (e.g. Live on Sales-IB but Onboarding on
// Service-OB), we surface the most active label. Higher number wins.
const STAGE_PRIORITY: Record<string, number> = {
  "Live": 6,
  "Onboarding": 5,
  "Contract-Initiated": 4,
  "Contracted": 4,
  "New": 3,
  "In OB": 2,
  "Churned": 1,
};
function preferStage(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return (STAGE_PRIORITY[b] ?? 0) > (STAGE_PRIORITY[a] ?? 0) ? b : a;
}

const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type DateRange = "ALL" | "TODAY" | "WEEK" | "MTD" | "D30" | "D90" | "CUSTOM";
const DATE_RANGES: { key: DateRange; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "TODAY", label: "Today" },
  { key: "WEEK", label: "This Week" },
  { key: "MTD", label: "MTD" },
  { key: "D30", label: "Last 30D" },
  { key: "D90", label: "Last 90D" },
  { key: "CUSTOM", label: "Custom" },
];

type CustomRange = { from: string; to: string }; // ISO yyyy-mm-dd, both inclusive

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeekMon(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}
// Parse a "YYYY-MM-DD" Metabase day string as a local-midnight Date so it lines
// up with the viewer's calendar. Critical: `new Date("YYYY-MM-DD")` parses as
// UTC midnight, which silently shifts the day backwards for any viewer west of
// UTC — that's the bug that made TODAY/D30 look broken outside IST.
function parseDay(iso: string | null | undefined): Date | null {
  if (iso == null) return null;
  const s = String(iso).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : startOfDay(d);
}
function fmtDay(iso: string): string {
  const d = parseDay(iso);
  if (!d) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function inRange(iso: string, range: DateRange, custom: CustomRange): boolean {
  if (range === "ALL") return true;
  const day = parseDay(iso);
  if (!day) return false;
  const today = startOfDay(new Date());
  if (range === "TODAY") return day.getTime() === today.getTime();
  if (range === "WEEK") {
    const wk = startOfWeekMon(today);
    const end = new Date(wk); end.setDate(wk.getDate() + 7);
    return day >= wk && day < end;
  }
  if (range === "MTD") {
    const mStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const mEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return day >= mStart && day < mEnd;
  }
  if (range === "D30") {
    const start = new Date(today); start.setDate(start.getDate() - 29);
    const end = new Date(today); end.setDate(end.getDate() + 1);
    return day >= start && day < end;
  }
  if (range === "D90") {
    const start = new Date(today); start.setDate(start.getDate() - 89);
    const end = new Date(today); end.setDate(end.getDate() + 1);
    return day >= start && day < end;
  }
  if (range === "CUSTOM") {
    if (custom.from) {
      const f = parseDay(custom.from);
      if (f && day < f) return false;
    }
    if (custom.to) {
      const t = parseDay(custom.to);
      if (t && day > t) return false;
    }
    return true;
  }
  return true;
}

// Number of elapsed days covered by the selected range (bounded by today), or
// null for "ALL" where there's no clean span. Used to pro-rate monthly MRR to
// the selected window so ROI = appts(range) ÷ (MRR × days/30) stays
// apples-to-apples instead of comparing multi-month appts to a one-month fee.
function rangeDays(range: DateRange, custom: CustomRange): number | null {
  if (range === "ALL") return null;
  const today = startOfDay(new Date());
  const DAY_MS = 86400000;
  const inclusiveDays = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;
  if (range === "TODAY") return 1;
  if (range === "WEEK") return inclusiveDays(startOfWeekMon(today), today);
  if (range === "MTD") return inclusiveDays(new Date(today.getFullYear(), today.getMonth(), 1), today);
  if (range === "D30") return 30;
  if (range === "D90") return 90;
  if (range === "CUSTOM") {
    const f = custom.from ? parseDay(custom.from) : null;
    if (!f) return null; // open-ended start → no clean span; fall back to monthly
    const tRaw = custom.to ? parseDay(custom.to) : today;
    const t = tRaw && tRaw < today ? tRaw : today; // cap at today
    return Math.max(1, inclusiveDays(f, t));
  }
  return null;
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const rooftopLabel = (r: AnyAgentRow) =>
  r.rooftop_name?.trim() || r.enterprise_name?.trim() || teamId(r) || "Unknown";
const enterpriseLabel = (r: AnyAgentRow) => r.enterprise_name?.trim() || "";

// Normalize a rooftop name for cross-system matching: lowercase, replace any
// non-alphanumeric run with a space, drop the corporate-form filler tokens
// (LLC, Inc, …), token-sort, and join. "I 40 Autos" and "I-40 Autos, LLC"
// both normalize to "40 autos i", and "Dream Nissan Lawrence" and "Dream
// Lawrence Nissan" both normalize to "dream lawrence nissan". Used as a
// last-resort fallback (after team_id and exact name) — the join site still
// guards against ambiguity by requiring a single candidate.
const NAME_FILLER_TOKENS = new Set(["llc", "inc", "incorporated", "corp", "ltd", "co", "dba"]);
function normalizeRooftopName(s: string): string {
  if (!s) return "";
  const toks = s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !NAME_FILLER_TOKENS.has(t));
  return toks.sort().join(" ");
}

// V3 Bucket — funnel is Touched → Qualified → Appointments (no "Total" tier).
// Volume fields (calls / SMS / appt $) are sum-friendly across days; distinct-
// count fields (touched/qualified/appts) are NOT — sum them only when reading
// from the totals card (one row per team × agent_type, deduplicated lead-level).
type Bucket = {
  touched: number;
  qualified: number;
  appts: number;
  apptValue: number;
  totalCalls: number;
  totalSms: number;
  leadsWithCalls: number;
  leadsWithSms: number;
  // Top-of-funnel — see comment on AgentRowBase. Additive ACROSS rooftops,
  // NOT additive across daily rows of the same rooftop. We handle that at
  // the aggregation site (rooftopRows) by collapsing daily → rooftop with
  // max instead of sum for these two.
  newLeads: number;
  contactedFromNew: number;
  // Inbound-only outcome counts — see AgentRowBase. Additive like touched.
  transfers: number;
  callbacks: number;
  // Cost-weighted appointment value = appts × cost-per-appt for THIS row's
  // agent type (or the premium-dealer rate). Kept as a Bucket field so it sums
  // correctly when "All Agents" merges rows of different agent types — each
  // contributes its own cost basis. ROI Multiple = roiValue ÷ MRR.
  roiValue: number;
};
const EMPTY: Bucket = {
  touched: 0, qualified: 0, appts: 0, apptValue: 0,
  totalCalls: 0, totalSms: 0, leadsWithCalls: 0, leadsWithSms: 0,
  newLeads: 0, contactedFromNew: 0,
  transfers: 0, callbacks: 0,
  roiValue: 0,
};

function projectRow(r: AnyAgentRow): Bucket {
  return {
    touched: num(r.touched_leads),
    qualified: num(r.qualified_leads),
    appts: num(r.appointments),
    apptValue: num(r.appointment_value),
    totalCalls: num(r.total_calls),
    totalSms: num(r.total_sms),
    leadsWithCalls: num(r.leads_with_calls),
    leadsWithSms: num(r.leads_with_sms),
    newLeads: num(r.new_leads_created),
    contactedFromNew: num(r.leads_contacted_from_new),
    transfers: num(r.transfer_leads),
    callbacks: num(r.callback_leads),
    roiValue: num(r.appointments) *
      costPerAppt(r.agent_type, String(r.rooftop_name ?? ""), String(r.enterprise_name ?? "")),
  };
}
function add(a: Bucket, b: Bucket): Bucket {
  return {
    touched: a.touched + b.touched,
    qualified: a.qualified + b.qualified,
    appts: a.appts + b.appts,
    apptValue: a.apptValue + b.apptValue,
    totalCalls: a.totalCalls + b.totalCalls,
    totalSms: a.totalSms + b.totalSms,
    leadsWithCalls: a.leadsWithCalls + b.leadsWithCalls,
    leadsWithSms: a.leadsWithSms + b.leadsWithSms,
    newLeads: a.newLeads + b.newLeads,
    contactedFromNew: a.contactedFromNew + b.contactedFromNew,
    transfers: a.transfers + b.transfers,
    callbacks: a.callbacks + b.callbacks,
    roiValue: a.roiValue + b.roiValue,
  };
}
// Collapse one rooftop's daily rows into a per-rooftop total. Most fields
// are additive (touched, qualified, calls, etc.), but new_leads_created and
// leads_contacted_from_new are constants per (rooftop × service_type)
// repeated on every daily row — those must be MAX'd, not summed, or we'd
// inflate them N× for N days in range.
function collapseDailyForRooftop(daily: Bucket[]): Bucket {
  if (daily.length === 0) return { ...EMPTY };
  const out: Bucket = { ...EMPTY };
  for (const d of daily) {
    out.touched          += d.touched;
    out.qualified        += d.qualified;
    out.appts            += d.appts;
    out.apptValue        += d.apptValue;
    out.totalCalls       += d.totalCalls;
    out.totalSms         += d.totalSms;
    out.leadsWithCalls   += d.leadsWithCalls;
    out.leadsWithSms     += d.leadsWithSms;
    out.transfers        += d.transfers;
    out.callbacks        += d.callbacks;
    out.roiValue         += d.roiValue;
    if (d.newLeads         > out.newLeads)         out.newLeads         = d.newLeads;
    if (d.contactedFromNew > out.contactedFromNew) out.contactedFromNew = d.contactedFromNew;
  }
  return out;
}

const fmtNum = (n: number) => n.toLocaleString();
const fmtCurrency = (n: number) => `$${Math.round(n).toLocaleString()}`;
const fmtRate = (num: number, den: number) =>
  den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "—";
const fmtRoi = (x: number) => `${x.toFixed(1)}×`;

// True when the rooftop has any Metabase activity in scope. A sheet-seeded
// rooftop with no Metabase rows collapses to EMPTY → false.
function hasMetabaseActivity(b: Bucket): boolean {
  return b.touched > 0 || b.appts > 0 || b.totalCalls > 0 || b.totalSms > 0 || b.newLeads > 0;
}

type RagResult = { roi: number | null; status: RagStatus; note: string };

// RAG classification for one rooftop. Always Red / Amber / Green — never N/A.
// `periodMonths` pro-rates the monthly MRR to the selected date range (days/30,
// or 1 for the all-time "ALL" range) so the multiple compares like-for-like.
// Priority:
//   1. No activity in range → Red.
//   2. MRR unknown → can't compute ROI → Red.
//   3. ROI ≥ 3× Green · 1.5×–3× Amber · < 1.5× Red.
// (The old top-of-funnel volume gate is gone: the Q12227 source has no
// "new leads created" figure, and New Leads / Capture Rate are hidden anyway.)
function computeRag(mrr: number | null, total: Bucket, periodMonths: number): RagResult {
  if (!hasMetabaseActivity(total)) {
    return { roi: null, status: "red", note: "No activity in range" };
  }
  const denom = mrr != null && mrr > 0 ? mrr * periodMonths : null;
  const roi = denom != null && denom > 0 ? total.roiValue / denom : null;
  if (roi == null) {
    return { roi: null, status: "red", note: "MRR unknown — ROI can't be computed" };
  }
  if (roi >= ROI_GREEN) return { roi, status: "green", note: `ROI ${fmtRoi(roi)} — at/above ${ROI_GREEN}×` };
  if (roi >= ROI_AMBER) return { roi, status: "amber", note: `ROI ${fmtRoi(roi)} — ${ROI_AMBER}–${ROI_GREEN}×` };
  return { roi, status: "red", note: `ROI ${fmtRoi(roi)} — below ${ROI_AMBER}×` };
}

function AgentsDashboard({ mainView = "overall" }: { mainView?: "overall" | "rooftop" }) {
  const [dailyRows, setDailyRows] = useState<AgentRowDaily[]>([]);
  const [totalsRows, setTotalsRows] = useState<AgentRowTotals[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  // Top-level view comes from the route: "/" → Overall (company-wide), "/agents"
  // → the per-rooftop view. The toggle navigates between those two paths (SPA
  // nav). The heavy /api/agents Metabase pull is deferred until the rooftop
  // view is actually shown.
  const navigateMainView = (v: "overall" | "rooftop") => {
    const target = v === "overall" ? "/" : "/agents";
    if (window.location.pathname === target) return;
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const [activeAgent, setActiveAgent] = useState<ActiveAgent>("All");
  const [dateRange, setDateRange] = useState<DateRange>("D30");
  const [customRange, setCustomRange] = useState<CustomRange>(() => ({ from: "", to: todayIso() }));
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set());
  const [stageMasterList, setStageMasterList] = useState<string[]>([]);
  // Rooftop-name (lower-case, trimmed) → curated stage from the OB Google Sheet
  // (the "per-stage roster" sheet). Used to surface Onboarding/OB-side stages
  // that the master accounts sheet does not enumerate at the same granularity.
  const [rooftopToStage, setRooftopToStage] = useState<Map<string, string>>(new Map());
  // Per (team_id + agent_type) AND (rooftop_name + agent_type) → account info
  // from the master All-Accounts Google Sheet. Authoritative for the per-agent
  // stage and the only source of MRR. Keyed at the (rooftop × agent_type) grain
  // because one rooftop can be Live on Sales-IB and still In-OB on Service-OB —
  // we do NOT cross-pollinate Live/Churn across agent_types.
  // We index two ways so we can match Metabase rows that disagree with the sheet
  // on rooftop_name spelling (e.g. Metabase "Lambert Buick GMC" vs sheet
  // "Lambert Buick GMC Inc") — team_id is the strong key, name is the fallback.
  // `rooftopName` is the master-sheet's name for this team_id × agent_type.
  // We use it to override Metabase's rooftop_name when Metabase fell back to
  // the enterprise name (e.g. all 5 World Car team_ids show "World Car Auto
  // Group" in Metabase but resolve to "World Car Hyundai South" / "World
  // Car Kia Mazda" in the sheet).
  type AccountInfo = { stage: string; mrr: number | null; subStage: string; rooftopName: string };
  // Sheet entries kept in their full per-(team_id × agent_type) form so the
  // "sheet" data-mode can render zero-usage accounts that have no Metabase
  // activity at all — they'd otherwise never appear in the table.
  type SheetEntry = {
    teamId: string;
    agentType: AgentType;
    rooftopName: string;
    enterpriseName: string;
    stage: string;
    mrr: number | null;
    subStage: string;
  };
  const [accountsByTeamAgent, setAccountsByTeamAgent] = useState<Map<string, AccountInfo>>(new Map());
  const [accountsByNameAgent, setAccountsByNameAgent] = useState<Map<string, AccountInfo>>(new Map());
  // Normalized-name index — used to bridge naming drift between Metabase
  // and the sheet that exact-match misses (e.g. "Dream Nissan Lawrence" vs
  // "Dream Lawrence Nissan", or "I 40 Autos" vs "I-40 Autos, LLC"). Maps
  // each normalized name → array of candidate AccountInfo; we only use it
  // when there's exactly one candidate so an ambiguous normalization can't
  // attach the wrong sheet row.
  const [accountsByNormNameAgent, setAccountsByNormNameAgent] = useState<Map<string, AccountInfo[]>>(new Map());
  const [sheetEntries, setSheetEntries] = useState<SheetEntry[]>([]);
  const [search, setSearch] = useState("");
  const [selectedRooftops, setSelectedRooftops] = useState<Set<string>>(new Set());
  // MRR range filter (inclusive). null on either side means unbounded.
  const [mrrRange, setMrrRange] = useState<{ min: number | null; max: number | null }>({ min: null, max: null });
  // Data-mode toggle. The Vini funnel sheet is the source of truth, so we
  // default to "sheet":
  //   • "sheet"    — sheet-driven. Restrict rooftops to those listed in the
  //                  funnel sheet for this (rooftop × agent_type), and use the
  //                  sheet's stage (Live / Churned / In OB) + MRR. This is the
  //                  default and the intended view.
  //   • "no-sheet" — pure Metabase. Ignore the sheet entirely. Stage reverts to
  //                  Metabase's rooftop_stage; MRR is unavailable. Kept as an
  //                  escape hatch for spot-checking raw Metabase activity that
  //                  the sheet may not list yet.
  const [dataMode, setDataMode] = useState<"sheet" | "no-sheet">("sheet");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Sort state: null label means "default" (touched desc, the V3 funnel-top).
  const [sort, setSort] = useState<{ label: string | null; dir: "asc" | "desc" }>({ label: null, dir: "desc" });

  const load = (force = false) => {
    setLoading(true);
    setError(null);
    const url = `${API_BASE}/api/agents${force ? `?refresh=1&t=${Date.now()}` : ""}`;
    fetch(url, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => {
        setDailyRows(Array.isArray(j.daily) ? j.daily : []);
        setTotalsRows(Array.isArray(j.totals) ? j.totals : []);
        setFetchedAt(j.fetchedAt ?? null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  // Lazy-load the rooftop dataset: only hit /api/agents the first time the
  // rooftop view is opened, so landing on Overall stays instant.
  const rooftopLoaded = useRef(false);
  useEffect(() => {
    if (mainView === "rooftop" && !rooftopLoaded.current) {
      rooftopLoaded.current = true;
      load(false);
    }
  }, [mainView]);

  // Auto-sync the rooftop data every 20 min while it's the active view and the
  // tab is visible — force=false re-reads the precomputed cache (kept fresh by
  // the agents-refresh cron), so an always-on screen stays current WITHOUT ever
  // triggering a live ~66s ClickHouse scan on the request path.
  useEffect(() => {
    if (mainView !== "rooftop") return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load(false);
    }, 20 * 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainView]);

  // Stage roster from Google Sheets (via /api/agent-stages). Response shape:
  //   { stages: { Live: [...names], Onboarding: [...] }, rooftopToStage: {<lower-name>: stage}, errors: {...} }
  // The rooftopToStage map overrides Metabase's rooftop_stage per row (matched by
  // case-insensitive trimmed rooftop_name). Silent failure — if the endpoint is
  // unconfigured or returns the empty shape, we just fall back to data-derived stages.
  useEffect(() => {
    fetch(`${API_BASE}/api/agent-stages`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!j) return;
        if (j.stages && typeof j.stages === "object" && !Array.isArray(j.stages)) {
          setStageMasterList(Object.keys(j.stages));
        }
        if (j.rooftopToStage && typeof j.rooftopToStage === "object") {
          const m = new Map<string, string>();
          for (const [k, v] of Object.entries(j.rooftopToStage)) {
            if (typeof v === "string") m.set(k.toLowerCase().trim(), v);
          }
          setRooftopToStage(m);
        }
      })
      .catch(() => { /* fall back to data-derived list */ });
  }, []);

  // All-Accounts master sheet (via /api/accounts-sheet). Response shape:
  //   { rows: [{ rooftopName, agentType, currentStage, agentMrr, ... }], rooftopNames: [...] }
  // Server side falls back to sheet_cache on Google fetch failure, so we don't
  // need to do anything special here — empty list means "no data available".
  useEffect(() => {
    fetch(`${API_BASE}/api/accounts-sheet`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!j || !Array.isArray(j.rows)) return;
        const byTeam = new Map<string, AccountInfo>();
        const byName = new Map<string, AccountInfo>();
        const byNormName = new Map<string, AccountInfo[]>();
        const entries: SheetEntry[] = [];
        for (const row of j.rows) {
          const nameRaw = String(row.rooftopName ?? "").trim();
          const nameLower = nameRaw.toLowerCase();
          const normName = normalizeRooftopName(nameRaw);
          const agentRaw = String(row.agentType ?? "").trim();
          const agent = agentRaw.toLowerCase();
          const teamId = String(row.rooftopId ?? "").trim();
          if (!agent) continue;
          const info: AccountInfo = {
            stage: String(row.currentStage ?? "").trim(),
            subStage: String(row.subStage ?? "").trim(),
            mrr: typeof row.agentMrr === "number" ? row.agentMrr : null,
            rooftopName: nameRaw,
          };
          // Index by team_id first (the strong join key — survives name drift
          // between Metabase and the sheet, e.g. "Lambert Buick GMC" vs
          // "Lambert Buick GMC Inc"). Skip empty team_ids; those rooftops will
          // be reachable only by name.
          if (teamId) byTeam.set(`${teamId}::${agent}`, info);
          if (nameLower) byName.set(`${nameLower}::${agent}`, info);
          if (normName) {
            const k = `${normName}::${agent}`;
            const arr = byNormName.get(k) ?? [];
            arr.push(info);
            byNormName.set(k, arr);
          }
          // Only keep entries whose agentType matches one of the four dashboard
          // tabs — anything else can't seed a synthetic rooftop on the active
          // tab in sheet mode.
          if (AGENT_TYPES.includes(agentRaw as AgentType)) {
            entries.push({
              teamId,
              agentType: agentRaw as AgentType,
              rooftopName: info.rooftopName,
              enterpriseName: String(row.enterpriseName ?? "").trim(),
              stage: info.stage,
              mrr: info.mrr,
              subStage: info.subStage,
            });
          }
        }
        setAccountsByTeamAgent(byTeam);
        setAccountsByNameAgent(byName);
        setAccountsByNormNameAgent(byNormName);
        setSheetEntries(entries);
      })
      .catch(() => { /* sheet may be unconfigured / unreachable — silent fallback */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Names that appear on more than one Metabase team_id within the same
  // agent_type (e.g. 5 different team_ids all labeled "World Car Auto
  // Group" on Sales Inbound). For these, a name-based fallback into the
  // accounts sheet would yank one arbitrary sheet row's stage/MRR onto
  // every Metabase team_id — wrong rooftop, wrong numbers. We suppress
  // the fallback only for ambiguous names; legitimate single-team-id
  // matches like "Bridgeton Auto Mall" (different team_ids in Metabase
  // vs the sheet, but the name uniquely identifies the rooftop) still
  // join via name.
  const ambiguousMetabaseNames = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const r of totalsRows) {
      const name = (r.rooftop_name ?? "").trim().toLowerCase();
      const agent = (r.agent_type ?? "").trim().toLowerCase();
      const tid = teamId(r);
      if (!name || !agent || !tid) continue;
      const key = `${name}::${agent}`;
      let s = counts.get(key);
      if (!s) { s = new Set(); counts.set(key, s); }
      s.add(tid);
    }
    const out = new Set<string>();
    for (const [k, s] of counts) if (s.size > 1) out.add(k);
    return out;
  }, [totalsRows]);

  // Same ambiguity check for the normalized-name fallback. We need a
  // separate set because two different Metabase rooftop_names can collide
  // after normalization (e.g. punctuation / word-order differences) — in
  // which case the normalized fallback shouldn't be used.
  const ambiguousMetabaseNormNames = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const r of totalsRows) {
      const norm = normalizeRooftopName(r.rooftop_name ?? "");
      const agent = (r.agent_type ?? "").trim().toLowerCase();
      const tid = teamId(r);
      if (!norm || !agent || !tid) continue;
      const key = `${norm}::${agent}`;
      let s = counts.get(key);
      if (!s) { s = new Set(); counts.set(key, s); }
      s.add(tid);
    }
    const out = new Set<string>();
    for (const [k, s] of counts) if (s.size > 1) out.add(k);
    return out;
  }, [totalsRows]);

  // Per (rooftop × agent_type) lookup. We deliberately do NOT collapse across
  // agent types: Sales-OB stage stays Sales-OB stage, even when Sales-IB on the
  // same rooftop is Live. The user reported a bug where cross-agent precedence
  // was marking Paragon Honda as Live on the Sales-OB tab when its actual
  // Sales-OB row in the sheet said "In OB" — keep this strictly per-agent.
  const accountInfoFor = (r: AnyAgentRow): AccountInfo | null => {
    const agent = (r.agent_type ?? "").toLowerCase().trim();
    if (!agent) return null;
    const tid = teamId(r);
    if (tid) {
      const hit = accountsByTeamAgent.get(`${tid}::${agent}`);
      if (hit) return hit;
    }
    const nameRaw = (r.rooftop_name ?? "").trim();
    const name = nameRaw.toLowerCase();
    // Tier 2: exact name match, only when this Metabase name is uniquely
    // owned by one team_id (otherwise multiple rooftops would map to the
    // same sheet row).
    if (name && !ambiguousMetabaseNames.has(`${name}::${agent}`)) {
      const hit = accountsByNameAgent.get(`${name}::${agent}`);
      if (hit) return hit;
    }
    // Tier 3: normalized-name fallback (word order / corporate-form drift).
    // Same ambiguity guard, plus we only accept it when the sheet has
    // exactly one candidate under this normalized form for this agent_type.
    const norm = normalizeRooftopName(nameRaw);
    if (norm && !ambiguousMetabaseNormNames.has(`${norm}::${agent}`)) {
      const cands = accountsByNormNameAgent.get(`${norm}::${agent}`);
      if (cands && cands.length === 1) return cands[0];
    }
    return null;
  };

  // Stage resolver — per (rooftop × agent_type), with sheet > OB-roster > Metabase
  // fallback. The accounts sheet is treated as authoritative when it has a row
  // for this exact (rooftop × agent), even if it says "In OB" — that overrides
  // whatever Metabase happens to be reporting.
  const effectiveStage = (r: AnyAgentRow): string | null => {
    const info = accountInfoFor(r);
    if (info?.stage) return info.stage;
    // OB roster sheet — rooftop-wide (not per-agent), used when the accounts
    // sheet does not list this rooftop for this agent_type.
    const name = (r.rooftop_name ?? "").toLowerCase().trim();
    if (name && rooftopToStage.has(name)) return rooftopToStage.get(name)!;
    return r.rooftop_stage ?? null;
  };
  // Stage shown to the user — depends on data-mode. In "no-sheet" mode we
  // deliberately ignore BOTH Google sheets, so filtering and displaying must
  // both fall back to Metabase's rooftop_stage. Without this, picking "Live"
  // (a sheet-only stage label) in no-sheet mode would still pass rows whose
  // displayed stage is "Onboarding" — a confusing filter/display mismatch.
  const displayStage = (r: AnyAgentRow): string | null =>
    dataMode === "sheet" ? effectiveStage(r) : (r.rooftop_stage ?? null);

  // Rooftop label override — Metabase's `rooftop_name` is the same string
  // for several team_ids in some cases (e.g. 5 World Car team_ids all
  // labeled "World Car Auto Group"), which collapses distinct rooftops in
  // the table. Three-tier fallback:
  //   1. Master sheet's rooftopName for this (team_id × agent_type)
  //   2. Metabase's rooftop_name; suffix a short team_id when the same
  //      name is shared by multiple Metabase team_ids (the ambiguous case)
  //   3. The default rooftopLabel chain (enterprise_name → team_id → Unknown)
  // Applied in both data-modes since it's a purely cosmetic disambiguation.
  const displayRooftopLabel = (r: AnyAgentRow): string => {
    const info = accountInfoFor(r);
    if (info?.rooftopName) return info.rooftopName;
    const name = (r.rooftop_name ?? "").trim();
    const agent = (r.agent_type ?? "").trim().toLowerCase();
    if (name && ambiguousMetabaseNames.has(`${name.toLowerCase()}::${agent}`)) {
      const tid = teamId(r);
      if (tid) return `${name} · ${tid.slice(0, 8)}`;
    }
    return rooftopLabel(r);
  };

  // MRR for a specific (rooftop × agent_type). The master sheet stores MRR per
  // agent row, so this is the right granularity for the rooftop table when
  // viewed inside a single agent tab.
  const mrrFor = (r: AnyAgentRow): number | null => {
    const info = accountInfoFor(r);
    return info?.mrr ?? null;
  };

  // Reset row-expansion state whenever the active agent or filters narrow.
  useEffect(() => { setExpanded(new Set()); }, [activeAgent, dateRange, customRange, stageFilter, search, selectedRooftops, mrrRange, dataMode]);
  // Reset sort when the agent (and therefore the column set) changes.
  useEffect(() => { setSort({ label: null, dir: "desc" }); }, [activeAgent]);

  // Stages observed in the data after sheet override is applied. Read from
  // totals (one row per team × agent_type — already deduplicated). Routed
  // through displayStage so the dropdown options match whatever the user
  // currently sees in the table (sheet stages vs raw Metabase stages).
  const observedStages = useMemo(() => {
    const s = new Set<string>();
    totalsRows.forEach(r => {
      const eff = displayStage(r);
      if (eff) s.add(eff);
    });
    return s;
  // displayStage closes over rooftopToStage + dataMode + accounts maps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalsRows, rooftopToStage, dataMode, accountsByTeamAgent, accountsByNameAgent]);

  // Master list = sheet order first (preserves the curated order), then any observed
  // stages not in the sheet appended at the end (highlighted as "(unlisted)").
  const stages = useMemo(() => {
    const out: { key: string; sublabel?: string }[] = [];
    const seen = new Set<string>();
    for (const s of stageMasterList) {
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push({ key: s, sublabel: observedStages.has(s) ? undefined : "(no rooftops)" });
    }
    for (const s of Array.from(observedStages).sort()) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ key: s, sublabel: stageMasterList.length > 0 ? "(unlisted)" : undefined });
    }
    return out;
  }, [stageMasterList, observedStages]);

  const presentAgents = useMemo(() => {
    const s = new Set<AgentType>();
    totalsRows.forEach(r => { if (r.agent_type) s.add(r.agent_type); });
    return s;
  }, [totalsRows]);

  // Stable rooftop key: prefer team_id when present, else compose from names.
  const rowKey = (r: AnyAgentRow): string =>
    teamId(r) || `${r.enterprise_name ?? ""}::${r.rooftop_name ?? ""}`;

  // Rooftops available in the current agent/stage scope. From totals so the
  // dropdown matches the KPI universe; date filter is daily-only in V3.
  const availableRooftops = useMemo(() => {
    const m = new Map<string, { key: string; label: string; enterprise: string }>();
    for (const r of totalsRows) {
      if (activeAgent !== "All" && r.agent_type !== activeAgent) continue;
      if (stageFilter.size > 0 && !stageFilter.has(displayStage(r) ?? "")) continue;
      const key = rowKey(r);
      if (!m.has(key)) {
        m.set(key, { key, label: displayRooftopLabel(r), enterprise: enterpriseLabel(r) });
      }
    }
    return Array.from(m.values()).sort((a, b) => a.label.localeCompare(b.label));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalsRows, activeAgent, stageFilter, rooftopToStage, dataMode, accountsByTeamAgent, accountsByNameAgent]);

  // Filter predicate shared by both daily and totals pipelines (minus the date
  // check, which only applies to daily — totals are all-time per Metabase scope).
  // Stage check uses displayStage so the filter matches whatever the user sees
  // in the table — and so picking a sheet-only label like "Live" while in
  // no-sheet mode (where Metabase reports "Onboarding") doesn't quietly admit
  // the row.
  const matchesAgentStageRooftopSearch = (r: AnyAgentRow): boolean => {
    if (activeAgent !== "All" && r.agent_type !== activeAgent) return false;
    if (stageFilter.size > 0 && !stageFilter.has(displayStage(r) ?? "")) return false;
    if (selectedRooftops.size > 0 && !selectedRooftops.has(rowKey(r))) return false;
    const q = search.trim().toLowerCase();
    if (q) {
      // Include both the displayed (sheet-override) and raw (Metabase) names
      // so the search box matches whether the user typed the real rooftop
      // name or the "World Car Auto Group" placeholder.
      const hay = `${displayRooftopLabel(r)} ${rooftopLabel(r)} ${enterpriseLabel(r)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  const filteredDaily = useMemo(() => {
    return dailyRows.filter(r => {
      if (!matchesAgentStageRooftopSearch(r)) return false;
      if (!inRange(r.day, dateRange, customRange)) return false;
      return true;
    });
  // dataMode + accounts maps are pulled in because matchesAgentStageRooftopSearch
  // now reads displayStage, which closes over them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyRows, activeAgent, dateRange, customRange, stageFilter, search, selectedRooftops, rooftopToStage, dataMode, accountsByTeamAgent, accountsByNameAgent]);

  const filteredTotals = useMemo(() => {
    return totalsRows.filter(matchesAgentStageRooftopSearch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalsRows, activeAgent, stageFilter, search, selectedRooftops, rooftopToStage, dataMode, accountsByTeamAgent, accountsByNameAgent]);

  // KPI strip totals — sum the already-aggregated per-rooftop totals so the
  // KPI scope matches the table exactly (incl. MRR / sheet filters), and so
  // rolling-window fields (newLeads / contactedFromNew) aren't N×-inflated
  // by being repeated across each day's daily row. For dateRange==="ALL" each
  // rooftop's total is the totals-card row (lead-level deduped, exact); for
  // any narrower range it's collapseDailyForRooftop's sum-for-counts /
  // max-for-rolling-totals output over the in-range daily rows.

  type RooftopAgg = {
    key: string;
    rooftop: string;
    enterprise: string;
    stage: string | null;
    mrr: number | null;
    inSheet: boolean;
    daily: ({ day: string } & Bucket)[];
    total: Bucket;  // sourced from totals card, NOT from summing daily
  };
  const rooftopRows: RooftopAgg[] = useMemo(() => {
    const isAll = activeAgent === "All";
    const m = new Map<string, RooftopAgg>();
    // Seed from totals — the authoritative summary row per rooftop. In "All
    // Agents" mode multiple totals rows can share a rowKey (one per
    // agent_type) — they get merged: totals sum, MRR sums, Stage picks the
    // highest-priority label across agents.
    for (const r of filteredTotals) {
      const key = rowKey(r);
      const useSheet = dataMode === "sheet";
      const info = useSheet ? accountInfoFor(r) : null;
      const rowStage = useSheet ? effectiveStage(r) : (r.rooftop_stage ?? null);
      const existing = m.get(key);
      if (existing) {
        // "All" mode collision — merge.
        existing.total = add(existing.total, projectRow(r));
        existing.stage = preferStage(existing.stage, rowStage);
        if (info?.mrr != null) {
          existing.mrr = (existing.mrr ?? 0) + info.mrr;
        }
        if (info != null) existing.inSheet = true;
        continue;
      }
      m.set(key, {
        key, rooftop: displayRooftopLabel(r), enterprise: enterpriseLabel(r),
        stage: rowStage,
        mrr: info?.mrr ?? null,
        inSheet: info != null,
        daily: [],
        total: projectRow(r),
      });
    }
    // Attach per-day breakdown from daily, only for rooftops already in the
    // totals universe (so a daily-only ghost row doesn't sneak in). In "All"
    // mode, daily entries for the same (rooftop × day) but different
    // agent_types are summed into one entry — otherwise the chart would
    // double-count a rooftop's funnel per agent.
    for (const r of filteredDaily) {
      const key = rowKey(r);
      const entry = m.get(key);
      if (!entry) continue;
      const day = (r as AgentRowDaily).day;
      const bucket = projectRow(r);
      if (isAll) {
        const dup = entry.daily.find(d => d.day === day);
        if (dup) {
          const merged = add(dup, bucket);
          Object.assign(dup, merged);
          continue;
        }
      }
      entry.daily.push({ day, ...bucket });
    }
    for (const e of m.values()) e.daily.sort((a, b) => a.day.localeCompare(b.day));
    // When a date filter is active, recompute each rooftop's `total` from its
    // (filtered) daily rows so the table's main numbers match the date selector.
    // ALL keeps the totals card's lead-level-deduped figures, which are the
    // most accurate. Rooftops with zero daily rows in range get dropped so the
    // Total Accounts KPI reflects "accounts with activity in range".
    if (dateRange !== "ALL") {
      for (const e of m.values()) {
        if (e.daily.length === 0) {
          // In sheet mode every sheet account is meaningful even with zero
          // activity in range — keep it and zero out the total. In no-sheet
          // mode the only signal is Metabase activity, so dropping is correct.
          if (dataMode === "sheet") {
            e.total = { ...EMPTY };
            continue;
          }
          m.delete(e.key);
          continue;
        }
        // Sum-for-counts, max-for-rolling-totals (new_leads / contacted).
        // See collapseDailyForRooftop's docstring.
        e.total = collapseDailyForRooftop(e.daily);
      }
    }

    // Sheet-mode: seed accounts that exist in the master sheet for the active
    // agent type but have no Metabase activity at all. The user explicitly
    // wants these visible (with zero metrics) so the sheet view is exhaustive
    // and a 0-usage account isn't silently invisible. In "All Agents" mode
    // every sheet entry counts (any agent_type), and MRR / Stage merge the
    // same way as the Metabase-totals merge above.
    if (dataMode === "sheet") {
      for (const entry of sheetEntries) {
        if (!isAll && entry.agentType !== activeAgent) continue;
        const key = entry.teamId || `${entry.enterpriseName}::${entry.rooftopName}`;
        const existing = m.get(key);
        if (existing) {
          if (isAll) {
            existing.stage = preferStage(existing.stage, entry.stage || null);
            if (entry.mrr != null) {
              existing.mrr = (existing.mrr ?? 0) + entry.mrr;
            }
            existing.inSheet = true;
          }
          continue;
        }
        // Same filter predicate as Metabase rows, but on the sheet's fields.
        if (stageFilter.size > 0 && !stageFilter.has(entry.stage || "")) continue;
        if (selectedRooftops.size > 0 && !selectedRooftops.has(key)) continue;
        const q = search.trim().toLowerCase();
        if (q) {
          const hay = `${entry.rooftopName} ${entry.enterpriseName}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        m.set(key, {
          key,
          rooftop: entry.rooftopName || entry.enterpriseName || "Unknown",
          enterprise: entry.enterpriseName,
          stage: entry.stage || null,
          mrr: entry.mrr,
          inSheet: true,
          daily: [],
          total: { ...EMPTY },
        });
      }
    }

    let out = Array.from(m.values());
    // In "sheet" mode, restrict the rooftop universe to those listed in the
    // master accounts sheet for the active (rooftop × agent_type). "no-sheet"
    // mode shows everything Metabase has activity for — no sheet filtering.
    if (dataMode === "sheet") out = out.filter(rt => rt.inSheet);
    // MRR range filter applies after aggregation — comparing against the
    // resolved per-(rooftop × agent) MRR. A null MRR is treated as "unknown"
    // and excluded as soon as either bound is set.
    if (mrrRange.min != null || mrrRange.max != null) {
      out = out.filter(rt => {
        if (rt.mrr == null) return false;
        if (mrrRange.min != null && rt.mrr < mrrRange.min) return false;
        if (mrrRange.max != null && rt.mrr > mrrRange.max) return false;
        return true;
      });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTotals, filteredDaily, rooftopToStage, accountsByTeamAgent, accountsByNameAgent, mrrRange, dataMode, dateRange, sheetEntries, activeAgent, stageFilter, selectedRooftops, search]);

  // Sum each rooftop's already-correctly-collapsed `total` into the KPI strip
  // figure. Doing it here (rather than re-summing daily / totals rows) keeps
  // the KPI scope in lockstep with the table (incl. MRR & sheet filters), and
  // ensures newLeads / contactedFromNew aren't multi-counted across days.
  const totals = useMemo(
    () => rooftopRows.reduce((acc, rt) => add(acc, rt.total), { ...EMPTY }),
    [rooftopRows]
  );

  // Pro-rate factor for ROI: monthly MRR × (days-in-range / 30). "ALL" has no
  // clean span, so it falls back to 1 (raw monthly denominator).
  const periodMonths = useMemo(() => {
    const days = rangeDays(dateRange, customRange);
    return days == null ? 1 : days / 30;
  }, [dateRange, customRange]);

  // ROI column is only meaningful in sheet mode (MRR lives in the master sheet).
  const showRoi = dataMode === "sheet";

  const sortedRooftopRows = useMemo(() => {
    const rows = [...rooftopRows];
    const cols = columnsFor(activeAgent);
    if (sort.label === "Rooftop / Day") {
      rows.sort((a, b) => a.rooftop.localeCompare(b.rooftop));
      if (sort.dir === "desc") rows.reverse();
      return rows;
    }
    if (sort.label === "MRR") {
      // Nulls sink to bottom regardless of direction — they aren't comparable
      // with real numbers and we don't want them dominating the top of an asc sort.
      rows.sort((a, b) => {
        const av = a.mrr; const bv = b.mrr;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return sort.dir === "asc" ? av - bv : bv - av;
      });
      return rows;
    }
    if (sort.label === "ROI") {
      // Sort by the ROI multiple; rows where it can't be computed (no MRR or
      // volume-gated) sink to the bottom regardless of direction.
      rows.sort((a, b) => {
        const av = computeRag(a.mrr, a.total, periodMonths).roi;
        const bv = computeRag(b.mrr, b.total, periodMonths).roi;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return sort.dir === "asc" ? av - bv : bv - av;
      });
      return rows;
    }
    const col = sort.label ? cols.find(c => c.label === sort.label) : null;
    if (!col) {
      // V3 default: Touched desc (funnel top).
      rows.sort((a, b) => b.total.touched - a.total.touched);
      return rows;
    }
    rows.sort((a, b) => {
      const av = col.sortValue(a.total);
      const bv = col.sortValue(b.total);
      return sort.dir === "asc" ? av - bv : bv - av;
    });
    return rows;
  }, [rooftopRows, sort, activeAgent, periodMonths]);

  // Day-on-day series — aggregated from the already-filtered per-rooftop
  // daily buckets so the chart honors every filter the table does
  // (incl. MRR range and sheet/no-sheet mode). Per-day distinct counts are
  // NOT summable across days, but ARE summable across rooftops within the
  // same day (different rooftops = different leads).
  const { daily, days } = useMemo(() => {
    const byDay = new Map<string, Bucket>();
    for (const rt of rooftopRows) {
      for (const d of rt.daily) {
        const prev = byDay.get(d.day) ?? EMPTY;
        byDay.set(d.day, add(prev, d));
      }
    }
    const sortedDays = Array.from(byDay.keys()).sort();
    return {
      days: sortedDays,
      daily: sortedDays.map(d => byDay.get(d) ?? { ...EMPTY }),
    };
  }, [rooftopRows]);

  const { liveRooftops, churnedRooftops, inObRooftops } = useMemo(() => {
    let live = 0, churned = 0, inOb = 0;
    for (const rt of rooftopRows) {
      if (rt.stage === "Live") live++;
      else if (rt.stage === "Churned") churned++;
      else if (rt.stage === "In OB") inOb++;
    }
    return { liveRooftops: live, churnedRooftops: churned, inObRooftops: inOb };
  }, [rooftopRows]);

  const showingPlaceholder = loading && totalsRows.length === 0;

  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const expandAll = () => setExpanded(new Set(sortedRooftopRows.map(r => r.key)));
  const collapseAll = () => setExpanded(new Set());

  const onSort = (label: string) => {
    setSort(prev => {
      if (prev.label === label) return { label, dir: prev.dir === "asc" ? "desc" : "asc" };
      // First click defaults to desc for metrics (largest first) and asc for the name column.
      return { label, dir: label === "Rooftop / Day" ? "asc" : "desc" };
    });
  };

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", padding: "20px 32px", background: "#f9fafb", minHeight: "100vh" }}>
      <style>{`
        @keyframes agentShimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        .agent-shimmer { background:linear-gradient(90deg,#eef0f3 25%,#e2e5ea 50%,#eef0f3 75%); background-size:200% 100%; animation:agentShimmer 1.3s ease-in-out infinite; border-radius:6px; color:transparent !important; }
        .agent-refreshing { animation: agentSpin 1s linear infinite; }
        @keyframes agentSpin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#111827", margin: 0 }}>
            Conversational AI — Performance Dashboard
          </h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0", maxWidth: 820 }}>
            Switch agents (Sales / Service × Inbound / Outbound) or pick <b>All Agents</b> for the
            roll-up. Date filter applies to every card, chart and the per-day breakdown.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, paddingTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {fetchedAt && !loading && (
              <span style={{ fontSize: 12, color: "#16a34a" }}>
                ● {(dailyRows.length + totalsRows.length).toLocaleString()} rows ({totalsRows.length.toLocaleString()} totals · {dailyRows.length.toLocaleString()} daily) · fetched {new Date(fetchedAt).toLocaleTimeString()}
              </span>
            )}
            {loading && <span style={{ fontSize: 12, color: "#6b7280" }}>Fetching…</span>}
            <button onClick={() => load(true)} disabled={loading}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: loading ? "#f3f4f6" : "#fff", fontSize: 12, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", color: loading ? "#9ca3af" : "#374151" }}>
              <span className={loading ? "agent-refreshing" : undefined} style={{ display: "inline-block" }}>↻</span>
              Refresh
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <a href="/email-tracker"
               style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid #4600F2", background: "#4600F2", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#fff", textDecoration: "none" }}>
              ✉ Email tracker →
            </a>
            <a href="/programs"
               style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid #111827", background: "#111827", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#fff", textDecoration: "none" }}>
              CS Report →
            </a>
          </div>
        </div>
      </div>

      {/* Top-level view toggle — company-wide Overall ("/") vs the per-rooftop
          view ("/agents"). Real links (so middle-click / open-in-new-tab work)
          that navigate within the SPA on plain click. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["overall", "rooftop"] as const).map(v => {
          const active = v === mainView;
          const label = v === "overall" ? "Overall" : "Rooftop level";
          const href = v === "overall" ? "/" : "/agents";
          return (
            <a key={v} href={href}
              onClick={e => { if (!e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); navigateMainView(v); } }}
              style={{
                padding: "8px 18px", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer",
                textDecoration: "none", display: "inline-block",
                border: `1px solid ${active ? "#111827" : "#e5e7eb"}`,
                background: active ? "#111827" : "#fff",
                color: active ? "#fff" : "#374151",
              }}>
              {label}
            </a>
          );
        })}
      </div>

      {mainView === "overall" ? (
        <OverallView />
      ) : (
      <>
      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          Failed to load: {error}
        </div>
      )}

      {/* Agent tabs — "All Agents" rolls every agent_type together for the
          active rooftop (KPIs sum, table merges per team_id, stage/MRR pick
          across agents). */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid #e5e7eb" }}>
        {(["All", ...AGENT_TYPES] as ActiveAgent[]).map(t => {
          const active = t === activeAgent;
          const isAllTab = t === "All";
          const hasData = isAllTab || presentAgents.has(t as AgentType) || totalsRows.length === 0;
          const color = isAllTab ? ALL_AGENT_COLOR : AGENT_COLORS[t as AgentType];
          const label = isAllTab ? "All Agents" : AGENT_LABELS[t as AgentType];
          return (
            <button
              key={t}
              onClick={() => setActiveAgent(t)}
              disabled={!loading && totalsRows.length > 0 && !hasData}
              title={!hasData ? `No ${t} rows in current data` : undefined}
              style={{
                padding: "10px 16px", border: "none", background: "transparent",
                borderBottom: `2px solid ${active ? color : "transparent"}`,
                color: active ? color : hasData ? "#374151" : "#d1d5db",
                fontSize: 13, fontWeight: active ? 700 : 600,
                cursor: hasData ? "pointer" : "not-allowed",
                marginBottom: -1,
                transition: "color 0.15s, border-color 0.15s",
              }}
            >
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color, marginRight: 8, verticalAlign: "middle" }} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 18, background: "#fff", padding: 12, borderRadius: 10, border: "1px solid #e5e7eb" }}>
        <SegmentedControl options={DATE_RANGES} value={dateRange} onChange={setDateRange} />
        {dateRange === "CUSTOM" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>From</label>
            <input type="date" value={customRange.from}
              max={customRange.to || undefined}
              onChange={e => setCustomRange(r => ({ ...r, from: e.target.value }))}
              style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, background: "#fff" }} />
            <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>To</label>
            <input type="date" value={customRange.to}
              min={customRange.from || undefined}
              onChange={e => setCustomRange(r => ({ ...r, to: e.target.value }))}
              style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, background: "#fff" }} />
            {(customRange.from || customRange.to) && (
              <button onClick={() => setCustomRange({ from: "", to: "" })}
                title="Clear custom range"
                style={{ padding: "4px 8px", fontSize: 11, fontWeight: 600, color: "#6b7280", background: "transparent", border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer" }}>
                Clear
              </button>
            )}
          </div>
        )}
        <div style={{ width: 1, height: 24, background: "#e5e7eb", margin: "0 4px" }} />
        <MultiSelectDropdown
          options={stages.map(s => ({ key: s.key, label: s.key, sublabel: s.sublabel }))}
          selected={stageFilter}
          onChange={setStageFilter}
          headerLabel="Stage"
          allLabel="All stages"
          pluralUnit="stages"
          searchPlaceholder="Search stage…"
          minWidth={180}
        />
        <MultiSelectDropdown
          options={availableRooftops.map(r => ({ key: r.key, label: r.label, sublabel: r.enterprise }))}
          selected={selectedRooftops}
          onChange={setSelectedRooftops}
          headerLabel="Rooftops"
          allLabel="All rooftops"
          pluralUnit="rooftops"
          searchPlaceholder="Search rooftop…"
        />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search enterprise…"
          style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, minWidth: 180 }} />
        <MrrRangeFilter value={mrrRange} onChange={setMrrRange} />
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Accounts</span>
          <InfoTip text={
            "Funnel sheet only — show just the dealerships on the Vini funnel sheet (Live / In OB / Churned). " +
            "All Metabase activity — show every dealership with any agent activity, even if not on the sheet."
          } />
          <SegmentedControl
            options={[
              { key: "sheet" as const,    label: "Funnel sheet only" },
              { key: "no-sheet" as const, label: "All Metabase activity" },
            ]}
            value={dataMode}
            onChange={setDataMode}
          />
        </div>
        <div style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
          {rooftopRows.length} rooftop{rooftopRows.length === 1 ? "" : "s"} · {days.length} day{days.length === 1 ? "" : "s"}
        </div>
      </div>

      {/* KPIs — agent-specific */}
      <KpiStrip
        agent={activeAgent}
        totals={totals}
        liveRooftops={liveRooftops}
        churnedRooftops={churnedRooftops}
        inObRooftops={inObRooftops}
        totalRooftops={rooftopRows.length}
        loading={showingPlaceholder}
      />

      {/* Chart — single plot, dual Y-axes so large- and small-scale series share the canvas */}
      {(() => {
        const spec = chartSpecFor(activeAgent, daily);
        // Detect the "daily card lost its day column" failure mode. When the
        // Metabase daily SQL drops `DATE(...) AS day` + GROUP BY day, every
        // row arrives with `day === undefined`; D30/MTD/WEEK then filter every
        // row out (Date(undefined) is NaN) and the chart silently looks empty.
        // Surface it loudly instead — the fix is in the Metabase card, not the
        // dashboard, so a clear pointer saves the next person triaging this.
        const dailyMissingDay = dailyRows.length > 0
          && dailyRows.every(r => r.day === undefined || r.day === null || String(r.day).trim() === "");
        return (
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: 16, marginBottom: 20, position: "relative" }}>
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 15, fontWeight: 700, color: "#111827" }}>
                <span>Day-on-day — {spec.title}</span>
                <InfoTip text={
                  "Daily trend for each funnel stage. Two y-axes are used so the small Appointments line " +
                  "doesn't get crushed by the bigger Touched line. Click any label below to hide a line."
                } size={13} />
              </div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                Left axis: {spec.leftLabel}. Right axis: {spec.rightLabel}. Hover for day-level details.
              </div>
            </div>
            {showingPlaceholder ? (
              <div className="agent-shimmer" style={{ height: 320 }} />
            ) : dailyMissingDay ? (
              <div style={{ height: 320, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
                <div style={{ maxWidth: 560, textAlign: "center", background: "#fef3c7", border: "1px solid #fbbf24", borderRadius: 10, padding: "18px 22px", color: "#78350f" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                    Day-on-day chart unavailable
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                    The Metabase <b>daily</b> card is not returning a <code>day</code> column.
                    Add <code>DATE(activity_at) AS day</code> to the SELECT and to the GROUP BY in
                    the daily card SQL, then click Refresh.
                  </div>
                  <div style={{ fontSize: 11, color: "#92400e", marginTop: 8 }}>
                    All {dailyRows.length} daily rows have <code>day = null/undefined</code>.
                  </div>
                </div>
              </div>
            ) : days.length === 0 ? (
              <div style={{ height: 320, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>
                No data — widen your filters or pick a different date range.
              </div>
            ) : (
              <LineChart days={days} series={spec.series} leftLabel={spec.leftLabel} rightLabel={spec.rightLabel} />
            )}
          </div>
        );
      })()}

      {/* Rooftop table */}
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>
            Rooftop breakdown — {activeAgent === "All" ? "All Agents (combined)" : AGENT_LABELS[activeAgent]} · expand for daily detail
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={expandAll}
              style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
              Expand all
            </button>
            <button onClick={collapseAll}
              style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
              Collapse all
            </button>
          </div>
        </div>
        <div style={{ overflowX: "auto", maxHeight: 640 }}>
          <RooftopTable
            agent={activeAgent}
            rows={sortedRooftopRows}
            expanded={expanded}
            onToggle={toggleExpand}
            loading={showingPlaceholder}
            sort={sort}
            onSort={onSort}
            showRoi={showRoi}
            periodMonths={periodMonths}
          />
        </div>
      </div>
      </>
      )}
    </div>
  );
}

// ─── Per-agent KPI strip ─────────────────────────────────────────────────────

type KpiSpec = { label: string; value: string | number; color: string; sub?: string; info?: string };

// Short, stakeholder-friendly tooltip copy. One or two sentences max; no
// internal field names or jargon — these need to read clearly to a dealer
// principal or CS lead skim-reading the dashboard for the first time.
const KPI_INFO: Record<string, string> = {
  "New Leads":
    "Fresh prospects that came in during this period.",
  "Touched":
    "Leads the agent actually reached out to — at least one call or SMS. A lead with 20 calls counts once.",
  "Qualified":
    "Leads the agent confirmed have real buying intent, ready for follow-up.",
  "Appointments":
    "Leads who booked a visit. This is the headline outcome we optimise for.",
  "Total Calls":
    "Every call placed or received in this period. One lead can have many.",
  "Total SMS":
    "Every message exchanged in this period. One lead can have many.",
  "Capture Rate":
    "Of the new leads that came in, how many we actually reached. Higher is better.",
  "Conversion Rate":
    "Of the leads we worked, how many ended up booking. The single most important efficiency number.",
  "ABR":
    "Of the qualified leads, how many actually booked. Measures closing strength.",
  "Total Accounts":
    "Number of dealerships in this view, split into Live vs Churned.",
  "Transfers":
    "Inbound leads the agent handed off to a live human — e.g. a hot sales lead or an escalation.",
  "Callbacks":
    "Inbound leads the agent scheduled a callback for, to reconnect at a better time.",
};

function KpiStrip({ agent, totals, liveRooftops, churnedRooftops, inObRooftops, totalRooftops, loading }: {
  agent: ActiveAgent;
  totals: Bucket;
  liveRooftops: number;
  churnedRooftops: number;
  inObRooftops: number;
  totalRooftops: number;
  loading: boolean;
}) {
  const channelMix = (b: Bucket) => `${fmtNum(b.leadsWithCalls)} via calls · ${fmtNum(b.leadsWithSms)} via SMS`;
  // For Outbound agents the meaningful "conversion" denominator is qualified
  // leads (we deliberately filter to qualified before pursuing OB), so swap
  // the formula on those two tabs. Inbound keeps appts/touched. "All Agents"
  // rolls IB and OB together, so we fall back to the broader Touched
  // denominator (qualified-only would understate the mixed funnel).
  const isOutbound = agent === "Sales Outbound" || agent === "Service Outbound";
  // Transfer/Callback are inbound-only outcomes (Sales IB / Service IB). Show
  // them on those two tabs and on "All" (which folds IB in); the data is null
  // on pure-Outbound rows so we hide the cards there rather than show "0".
  const showInboundOutcomes =
    agent === "Sales Inbound" || agent === "Service Inbound" || agent === "All";
  const convNumer = totals.appts;
  const convDenom = isOutbound ? totals.qualified : totals.touched;
  const convDenomLabel = isOutbound ? "qualified" : "touched";

  // V3 funnel: Touched → Qualified → Appointments. The upstream Metabase query
  // also emits a top-of-funnel "New Leads" tier and a "Capture Rate" derived
  // metric — both are currently hidden from the UI (data plumbing kept intact).
  const main: KpiSpec[] = [
    { label: "Touched", value: fmtNum(totals.touched), color: "#0ea5e9", sub: channelMix(totals),
      info: KPI_INFO["Touched"] },
    { label: "Qualified", value: fmtNum(totals.qualified), color: "#0d9488",
      sub: fmtRate(totals.qualified, totals.touched) + " of touched",
      info: KPI_INFO["Qualified"] },
    { label: "Appointments", value: fmtNum(totals.appts), color: "#22c55e",
      sub: fmtRate(convNumer, convDenom) + " of " + convDenomLabel,
      info: KPI_INFO["Appointments"] },
  ];

  const accountsSub = `${liveRooftops} live · ${inObRooftops} in OB · ${churnedRooftops} churned`;
  const secondary: KpiSpec[] = [
    { label: "Total Calls", value: fmtNum(totals.totalCalls), color: "#6366f1",
      sub: totals.leadsWithCalls > 0 ? `${fmtNum(totals.leadsWithCalls)} unique leads` : undefined,
      info: KPI_INFO["Total Calls"] },
    { label: "Total SMS", value: fmtNum(totals.totalSms), color: "#0ea5e9",
      sub: totals.leadsWithSms > 0 ? `${fmtNum(totals.leadsWithSms)} unique leads` : undefined,
      info: KPI_INFO["Total SMS"] },
    { label: "Conversion Rate", value: fmtRate(convNumer, convDenom), color: "#15803d",
      sub: `appts / ${convDenomLabel}`, info: KPI_INFO["Conversion Rate"] },
    { label: "ABR", value: fmtRate(totals.appts, totals.qualified), color: "#0d9488",
      sub: "appts / qualified", info: KPI_INFO["ABR"] },
    ...(showInboundOutcomes ? [
      { label: "Transfers", value: fmtNum(totals.transfers), color: "#d97706",
        sub: totals.touched > 0 ? `${fmtRate(totals.transfers, totals.touched)} of touched` : undefined,
        info: KPI_INFO["Transfers"] },
      { label: "Callbacks", value: fmtNum(totals.callbacks), color: "#7c3aed",
        sub: totals.touched > 0 ? `${fmtRate(totals.callbacks, totals.touched)} of touched` : undefined,
        info: KPI_INFO["Callbacks"] },
    ] as KpiSpec[] : []),
    { label: "Total Accounts", value: fmtNum(totalRooftops), color: "#475569", sub: accountsSub,
      info: KPI_INFO["Total Accounts"] },
    // Appointment Value intentionally omitted — Metabase currently emits a flat
    // $100-per-appointment placeholder (appointment_value === appointments * 100
    // for every row), so the figure carries no information beyond the appt count.
  ];

  return (
    <div style={{ marginBottom: 18 }}>
      {/* MAIN — large headline cards (V3 funnel: Touched · Qualified · Appts) */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        {main.map(c => (
          <KpiCard key={c.label} label={c.label} value={c.value} color={c.color} loading={loading} sub={c.sub} size="main" info={c.info} />
        ))}
      </div>
      {/* SECONDARY — volume + conv rate + accounts */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {secondary.map(c => (
          <KpiCard key={c.label} label={c.label} value={c.value} color={c.color} loading={loading} sub={c.sub} size="secondary" info={c.info} />
        ))}
      </div>
    </div>
  );
}

// ─── Per-agent chart series ──────────────────────────────────────────────────

// Series get assigned to one of two Y-axes. Large-scale series ride the LEFT axis,
// smaller-scale series ride the RIGHT axis. Both render in the same plot area —
// each series is just scaled by its own axis max.
type Axis = "L" | "R";
type ChartSeries = { name: string; color: string; values: number[]; axis: Axis };
type ChartSpec = {
  title: string;
  series: ChartSeries[];
  leftLabel: string;
  rightLabel: string;
};
function chartSpecFor(_agent: ActiveAgent, daily: Bucket[]): ChartSpec {
  // V3 funnel — three lines: Touched · Qualified · Appointments. Touched is
  // typically ~10x larger than Qualified, which is ~10x larger than Appts —
  // Touched rides the left axis, the two smaller series share the right.
  return {
    title: "Touched · Qualified · Appointments",
    leftLabel: "Touched",
    rightLabel: "Qualified / Appts",
    series: [
      { name: "Touched",      color: "#0ea5e9", values: daily.map(d => d.touched),   axis: "L" },
      { name: "Qualified",    color: "#0d9488", values: daily.map(d => d.qualified), axis: "R" },
      { name: "Appointments", color: "#22c55e", values: daily.map(d => d.appts),     axis: "R" },
    ],
  };
}

// ─── Per-agent rooftop table ─────────────────────────────────────────────────

type RooftopRowData = {
  key: string; rooftop: string; enterprise: string; stage: string | null;
  mrr: number | null;
  inSheet: boolean;
  daily: ({ day: string } & Bucket)[]; total: Bucket;
};

function RooftopTable({ agent, rows, expanded, onToggle, loading, sort, onSort, showRoi, periodMonths }: {
  agent: ActiveAgent;
  rows: RooftopRowData[];
  expanded: Set<string>;
  onToggle: (k: string) => void;
  loading: boolean;
  sort: { label: string | null; dir: "asc" | "desc" };
  onSort: (label: string) => void;
  showRoi: boolean;       // ROI column hidden in no-sheet mode (no MRR available)
  periodMonths: number;   // pro-rate factor for the ROI denominator
}) {
  const cols = columnsFor(agent);
  // arrow + rooftop label + MRR (+ ROI when shown) + metrics
  const totalCols = cols.length + (showRoi ? 4 : 3);

  const sortIndicator = (label: string) => {
    if (sort.label !== label) return <span style={{ color: "#d1d5db", marginLeft: 4 }}>⇅</span>;
    return <span style={{ color: "#4f46e5", marginLeft: 4 }}>{sort.dir === "asc" ? "▲" : "▼"}</span>;
  };

  const sortableHeaderStyle = (label: string): CSSProperties => ({
    cursor: "pointer",
    userSelect: "none",
    color: sort.label === label ? "#4f46e5" : thStyle.color,
  });

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead style={{ position: "sticky", top: 0, background: "#f9fafb", zIndex: 1 }}>
        <tr>
          <th style={{ ...thStyle, width: 30 }} />
          <th
            style={{ ...thStyle, ...sortableHeaderStyle("Rooftop / Day"), textAlign: "left", minWidth: 240 }}
            onClick={() => onSort("Rooftop / Day")}>
            Rooftop / Day{sortIndicator("Rooftop / Day")}
          </th>
          <th
            style={{ ...thStyle, ...sortableHeaderStyle("MRR"), textAlign: "right", minWidth: 90 }}
            onClick={() => onSort("MRR")}
            title="Agent MRR from the All-Accounts sheet">
            MRR{sortIndicator("MRR")}
          </th>
          {showRoi && (
            <th
              style={{ ...thStyle, ...sortableHeaderStyle("ROI"), textAlign: "center", minWidth: 84 }}
              onClick={() => onSort("ROI")}
              title="ROI Multiple = (appts × cost-per-appt) ÷ (MRR pro-rated to the selected range). RAG: Green ≥ 3× · Amber 1.5×–3× · Red < 1.5× (or < 100 top-of-funnel leads, or no Metabase data).">
              ROI{sortIndicator("ROI")}
            </th>
          )}
          {cols.map(c => (
            <th
              key={c.label}
              style={{ ...thStyle, ...sortableHeaderStyle(c.label), textAlign: "right", minWidth: c.minWidth ?? 100 }}
              onClick={() => onSort(c.label)}>
              {c.label}{sortIndicator(c.label)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {loading && Array.from({ length: 8 }).map((_, i) => (
          <tr key={`sh-${i}`} style={{ borderTop: "1px solid #f3f4f6" }}>
            {Array.from({ length: totalCols }).map((__, j) => (
              <td key={j} style={{ padding: "10px 12px" }}>
                <div className="agent-shimmer" style={{ height: 14, width: j === 1 ? "60%" : "50%" }}>&nbsp;</div>
              </td>
            ))}
          </tr>
        ))}
        {!loading && rows.length === 0 && (
          <tr>
            <td colSpan={totalCols} style={{ padding: 24, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
              No rooftops match filters
            </td>
          </tr>
        )}
        {!loading && rows.map(row => {
          const isOpen = expanded.has(row.key);
          return (
            <Fragment key={row.key}>
              <tr
                onClick={() => onToggle(row.key)}
                style={{ borderTop: "1px solid #f3f4f6", background: isOpen ? "#eef2ff" : "#fff", cursor: "pointer" }}>
                <td style={{ ...tdStyle, textAlign: "center", color: "#6b7280", fontWeight: 700, userSelect: "none" }}>
                  <span style={{ display: "inline-block", width: 16, transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▶</span>
                </td>
                <td style={{ ...tdStyle, whiteSpace: "normal" }} title={`team_id: ${row.key}`}>
                  <div style={{ fontWeight: 700, color: "#111827" }}>
                    {row.rooftop}
                    <StagePill stage={row.stage} />
                    <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280", fontWeight: 500 }}>
                      ({row.daily.length} day{row.daily.length === 1 ? "" : "s"})
                    </span>
                  </div>
                  {row.enterprise && row.enterprise !== row.rooftop && (
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{row.enterprise}</div>
                  )}
                </td>
                <td style={{ ...tdStyle, textAlign: "right", color: row.mrr != null ? "#0369a1" : "#9ca3af", fontWeight: row.mrr != null ? 600 : 400 }}>
                  {row.mrr != null ? fmtCurrency(row.mrr) : "—"}
                </td>
                {showRoi && (
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <RoiCell rag={computeRag(row.mrr, row.total, periodMonths)} />
                  </td>
                )}
                {cols.map(c => (
                  <td key={c.label} style={{ ...tdStyle, textAlign: "right", color: c.emphasize ? "#0369a1" : "#374151", fontWeight: c.emphasize ? 600 : 400 }}>
                    {c.render(row.total)}
                  </td>
                ))}
              </tr>
              {isOpen && row.daily.map(d => (
                <tr key={`${row.key}::${d.day}`} style={{ borderTop: "1px solid #f3f4f6", background: "#fafbff" }}>
                  <td style={dayCellStyle} />
                  <td style={{ ...dayCellStyle, paddingLeft: 36, color: "#6b7280" }}>{fmtDay(d.day)}</td>
                  <td style={dayCellStyle} />
                  {showRoi && (
                    <td style={{ ...dayCellStyle, textAlign: "center", color: "#9ca3af" }} title="ROI is a rooftop-level figure — see the collapsed row">—</td>
                  )}
                  {cols.map(c => (
                    <td
                      key={c.label}
                      style={{ ...dayCellStyle, textAlign: "right", color: "#4b5563" }}
                      title={c.rollingPerRooftop ? "Rolling rooftop total — see the collapsed row" : undefined}
                    >
                      {c.rollingPerRooftop ? "—" : c.render(d)}
                    </td>
                  ))}
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// Compact "calls / sms" leads cell.
const fmtChannelMix = (b: Bucket): string =>
  b.leadsWithCalls === 0 && b.leadsWithSms === 0
    ? "—"
    : `${fmtNum(b.leadsWithCalls)} / ${fmtNum(b.leadsWithSms)}`;

const safeRate = (n: number, d: number) => (d > 0 ? n / d : -1); // -1 sinks "—" to bottom on desc

type Col = {
  label: string;
  render: (b: Bucket) => string;
  sortValue: (b: Bucket) => number;
  minWidth?: number;
  emphasize?: boolean;
  // True for fields whose value is a rolling rooftop×service_type total —
  // constant across all daily rows for the same rooftop. We render "—" in
  // the per-day expanded rows so the user doesn't misread the rolling
  // figure as a daily value.
  rollingPerRooftop?: boolean;
};

function columnsFor(agent: ActiveAgent): Col[] {
  // V3 uniform column set across all four agent tabs. Conv. Rate's denominator
  // switches between touched (IB) and qualified (OB) — see KpiStrip for the
  // rationale. "All Agents" mixes the two and falls back to Touched.
  const isOutbound = agent === "Sales Outbound" || agent === "Service Outbound";
  const convDenom  = (b: Bucket) => isOutbound ? b.qualified : b.touched;
  // Transfer/Callback are inbound-only — surface the columns on the IB tabs and
  // "All"; null on pure-Outbound rows, so we omit them there.
  const showInboundOutcomes =
    agent === "Sales Inbound" || agent === "Service Inbound" || agent === "All";
  return [
    { label: "Touched", render: b => fmtNum(b.touched), sortValue: b => b.touched, emphasize: true },
    { label: "Qualified", render: b => fmtNum(b.qualified), sortValue: b => b.qualified },
    { label: "Appts", render: b => fmtNum(b.appts), sortValue: b => b.appts, emphasize: true },
    { label: "Conv. Rate", render: b => fmtRate(b.appts, convDenom(b)), sortValue: b => safeRate(b.appts, convDenom(b)), minWidth: 90 },
    { label: "ABR", render: b => fmtRate(b.appts, b.qualified), sortValue: b => safeRate(b.appts, b.qualified), minWidth: 80 },
    { label: "Calls / SMS", render: fmtChannelMix, sortValue: b => b.leadsWithCalls + b.leadsWithSms, minWidth: 100 },
    { label: "Total Calls", render: b => fmtNum(b.totalCalls), sortValue: b => b.totalCalls },
    { label: "Total SMS", render: b => fmtNum(b.totalSms), sortValue: b => b.totalSms },
    ...(showInboundOutcomes ? [
      { label: "Transfers", render: (b: Bucket) => fmtNum(b.transfers), sortValue: (b: Bucket) => b.transfers },
      { label: "Callbacks", render: (b: Bucket) => fmtNum(b.callbacks), sortValue: (b: Bucket) => b.callbacks },
    ] as Col[] : []),
    // Appt $ column dropped — see KpiStrip note. Re-add once Metabase emits real values.
  ];
}

// ─── Small pieces ────────────────────────────────────────────────────────────

// ROI Multiple + RAG pill for a rooftop. Shows the multiple (e.g. "4.2×")
// colored by status, or "N/A" when it can't be computed. The hover title
// explains the verdict.
function RoiCell({ rag }: { rag: RagResult }) {
  const c = RAG_COLORS[rag.status];
  const label = rag.roi != null ? fmtRoi(rag.roi) : "—";
  return (
    <span
      title={rag.note}
      style={{
        display: "inline-block", minWidth: 52, textAlign: "center",
        padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 700,
        background: c.bg, color: c.fg,
      }}>
      {label}
    </span>
  );
}

function StagePill({ stage }: { stage: string | null }) {
  if (!stage) return null;
  const colorMap: Record<string, { bg: string; fg: string }> = {
    "Live": { bg: "#dcfce7", fg: "#166534" },
    "Churned": { bg: "#fee2e2", fg: "#991b1b" },
    "In OB": { bg: "#dbeafe", fg: "#1e40af" },
    "Onboarding": { bg: "#dbeafe", fg: "#1e40af" },
    "New": { bg: "#fef3c7", fg: "#92400e" },
    "Contracted": { bg: "#e0e7ff", fg: "#3730a3" },
    "Contract-Initiated": { bg: "#ede9fe", fg: "#5b21b6" },
  };
  const c = colorMap[stage] ?? { bg: "#f3f4f6", fg: "#374151" };
  return (
    <span style={{
      marginLeft: 8, padding: "2px 7px", borderRadius: 999, fontSize: 10, fontWeight: 700,
      background: c.bg, color: c.fg, textTransform: "uppercase", letterSpacing: 0.4,
      verticalAlign: "middle",
    }}>
      {stage}
    </span>
  );
}

type MultiSelectOption = { key: string; label: string; sublabel?: string };

function MultiSelectDropdown({
  options, selected, onChange,
  headerLabel, allLabel, pluralUnit, searchPlaceholder, minWidth = 200,
}: {
  options: MultiSelectOption[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  headerLabel: string;       // e.g. "Rooftops", "Stage"
  allLabel: string;          // e.g. "All rooftops", "All stages"
  pluralUnit: string;        // e.g. "rooftops", "stages"
  searchPlaceholder: string;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? options.filter(o =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel ?? "").toLowerCase().includes(q))
    : options;

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  const buttonLabel = selected.size === 0
    ? allLabel
    : selected.size === 1
      ? (options.find(o => selected.has(o.key))?.label ?? `1 ${pluralUnit}`)
      : `${selected.size} ${pluralUnit}`;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen(v => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db",
          background: "#fff", fontSize: 13, fontWeight: 600, color: "#374151",
          cursor: "pointer", minWidth,
        }}>
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>{headerLabel}</span>
        <span style={{ flex: 1, textAlign: "left", color: selected.size === 0 ? "#9ca3af" : "#111827", fontWeight: selected.size === 0 ? 500 : 600 }}>
          {buttonLabel}
        </span>
        <span style={{ color: "#9ca3af", fontSize: 10 }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20,
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
          boxShadow: "0 6px 20px rgba(0,0,0,0.08)", padding: 10, minWidth: 280, maxWidth: 360,
        }}>
          <input
            autoFocus
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            style={{
              width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db",
              fontSize: 13, marginBottom: 8, boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 11, color: "#6b7280" }}>
            <span>{visible.length} of {options.length}</span>
            {selected.size > 0 && (
              <button onClick={clearAll}
                style={{ background: "transparent", border: "none", color: "#4f46e5", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                Clear ({selected.size})
              </button>
            )}
          </div>
          <div style={{ maxHeight: 280, overflowY: "auto", borderTop: "1px solid #f3f4f6" }}>
            {visible.length === 0 ? (
              <div style={{ padding: "16px 8px", textAlign: "center", color: "#9ca3af", fontSize: 12 }}>
                No matches
              </div>
            ) : visible.map(o => {
              const checked = selected.has(o.key);
              return (
                <label key={o.key}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 4px", borderRadius: 4, cursor: "pointer",
                    background: checked ? "#eef2ff" : "transparent",
                  }}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(o.key)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "#111827", fontWeight: checked ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {o.label}
                    </div>
                    {o.sublabel && o.sublabel !== o.label && (
                      <div style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {o.sublabel}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MrrRangeFilter({ value, onChange }: {
  value: { min: number | null; max: number | null };
  onChange: (v: { min: number | null; max: number | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Empty string in the input → null bound. We parse on each keystroke so the
  // filter feels live; an invalid number (NaN) also collapses to null.
  const setBound = (which: "min" | "max", raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") return onChange({ ...value, [which]: null });
    const n = Number(trimmed.replace(/[$,\s]/g, ""));
    onChange({ ...value, [which]: Number.isFinite(n) ? n : null });
  };

  const label = (() => {
    if (value.min == null && value.max == null) return "All MRR";
    if (value.min != null && value.max != null) return `$${value.min}–$${value.max}`;
    if (value.min != null) return `≥ $${value.min}`;
    return `≤ $${value.max}`;
  })();

  const active = value.min != null || value.max != null;

  // A few presets — most slicing happens at these levels in conversations with
  // CS so wire them up directly. Custom values still come from the input fields.
  const presets: { label: string; min: number | null; max: number | null }[] = [
    { label: "Under $500",      min: null, max: 499 },
    { label: "$500 – $999",     min: 500,  max: 999 },
    { label: "$1,000 – $1,499", min: 1000, max: 1499 },
    { label: "$1,500+",         min: 1500, max: null },
  ];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen(v => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db",
          background: "#fff", fontSize: 13, fontWeight: 600, color: "#374151",
          cursor: "pointer", minWidth: 160,
        }}>
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>MRR</span>
        <span style={{ flex: 1, textAlign: "left", color: active ? "#111827" : "#9ca3af", fontWeight: active ? 600 : 500 }}>
          {label}
        </span>
        <span style={{ color: "#9ca3af", fontSize: 10 }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20,
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
          boxShadow: "0 6px 20px rgba(0,0,0,0.08)", padding: 12, minWidth: 240,
        }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, minWidth: 30 }}>Min</span>
            <input type="number" inputMode="numeric" min={0} step={50}
              value={value.min == null ? "" : value.min}
              onChange={e => setBound("min", e.target.value)}
              placeholder="—"
              style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, minWidth: 30 }}>Max</span>
            <input type="number" inputMode="numeric" min={0} step={50}
              value={value.max == null ? "" : value.max}
              onChange={e => setBound("max", e.target.value)}
              placeholder="—"
              style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
          </div>
          <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
            {presets.map(p => {
              const isActive = p.min === value.min && p.max === value.max;
              return (
                <button key={p.label} onClick={() => onChange({ min: p.min, max: p.max })}
                  style={{
                    padding: "3px 8px", borderRadius: 6,
                    border: `1px solid ${isActive ? "#4f46e5" : "#e5e7eb"}`,
                    background: isActive ? "#eef2ff" : "#fff",
                    color: isActive ? "#4f46e5" : "#374151",
                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}>
                  {p.label}
                </button>
              );
            })}
          </div>
          {active && (
            <button onClick={() => onChange({ min: null, max: null })}
              style={{
                marginTop: 10, width: "100%", padding: "6px 10px",
                borderRadius: 6, border: "1px solid #d1d5db", background: "#fff",
                fontSize: 12, fontWeight: 600, color: "#4f46e5", cursor: "pointer",
              }}>
              Clear MRR filter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SegmentedControl<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid #d1d5db", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
      {options.map((o, i) => {
        const active = o.key === value;
        return (
          <button key={o.key} onClick={() => onChange(o.key)}
            style={{
              padding: "6px 12px", fontSize: 12, fontWeight: 600,
              border: "none", cursor: "pointer",
              background: active ? "#4f46e5" : "#fff",
              color: active ? "#fff" : "#374151",
              borderRight: i < options.length - 1 ? "1px solid #e5e7eb" : "none",
              transition: "background 0.15s",
            }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const thStyle: CSSProperties = {
  padding: "10px 12px", fontSize: 11, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tdStyle: CSSProperties = { padding: "8px 12px", fontSize: 13, color: "#374151", whiteSpace: "nowrap" };
const dayCellStyle: CSSProperties = { padding: "3px 12px", fontSize: 12, color: "#4b5563", whiteSpace: "nowrap", lineHeight: 1.3 };

// Small ⓘ glyph with a tooltip on hover/focus. Uses React state for visibility
// (more reliable than CSS :hover inside a heavily-styled React tree where
// inline styles can outweigh a global rule). The bubble flips to a sibling
// of the icon and is anchored above; when there isn't enough vertical room
// above (top of the page) the consumer can still rely on the native `title`
// attribute as a fallback.
function InfoTip({ text, size = 12 }: { text: string; size?: number }) {
  const [open, setOpen] = useState(false);
  const show = () => setOpen(true);
  const hide = () => setOpen(false);
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={text}
      title={text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{
        position: "relative",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size + 4, height: size + 4, borderRadius: "50%",
        border: "1px solid #94a3b8", color: "#475569",
        fontSize: Math.max(10, size - 2), fontWeight: 700, lineHeight: 1,
        background: "#fff", cursor: "help", userSelect: "none",
        textTransform: "none", letterSpacing: 0,
      }}
    >
      i
      {open && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%",
          transform: "translateX(-50%)", background: "#111827", color: "#fff",
          padding: "10px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 500,
          lineHeight: 1.5, width: 300, textAlign: "left", letterSpacing: 0,
          textTransform: "none", boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
          pointerEvents: "none", zIndex: 100, whiteSpace: "normal",
        }}>
          {text}
          {/* Caret pointing down to the icon */}
          <span style={{
            position: "absolute", top: "100%", left: "50%",
            transform: "translateX(-50%)",
            width: 0, height: 0,
            borderLeft: "6px solid transparent",
            borderRight: "6px solid transparent",
            borderTop: "6px solid #111827",
          }} />
        </span>
      )}
    </span>
  );
}

function KpiCard({ label, value, color, loading, sub, size = "main", info }: {
  label: string; value: string | number; color: string; loading: boolean; sub?: string;
  size?: "main" | "secondary"; info?: string;
}) {
  const isMain = size === "main";
  return (
    <div style={{
      background: "#fff", borderRadius: 12,
      padding: isMain ? "16px 22px" : "10px 14px",
      boxShadow: isMain ? "0 1px 3px rgba(0,0,0,0.06)" : "0 1px 2px rgba(0,0,0,0.04)",
      border: "1px solid #e5e7eb",
      flex: isMain ? "1 1 220px" : "1 1 150px",
      minWidth: isMain ? 200 : 140,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        fontSize: isMain ? 12 : 11,
        color: isMain ? "#374151" : "#6b7280",
        fontWeight: 600,
        marginBottom: isMain ? 6 : 2,
        textTransform: isMain ? "none" : "uppercase",
        letterSpacing: isMain ? 0 : 0.4,
      }}>
        <span>{label}</span>
        {info && <InfoTip text={info} size={isMain ? 13 : 11} />}
      </div>
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          <div className="agent-shimmer" style={{ height: isMain ? 30 : 18, width: "55%" }}>&nbsp;</div>
          {sub !== undefined && <div className="agent-shimmer" style={{ height: 10, width: "40%" }}>&nbsp;</div>}
        </div>
      ) : (
        <>
          <div style={{ fontSize: isMain ? 30 : 18, fontWeight: 700, color, lineHeight: 1.1 }}>
            {typeof value === "number" ? value.toLocaleString() : value}
          </div>
          {sub && (
            <div style={{ fontSize: isMain ? 11 : 10, color: "#9ca3af", fontWeight: 500, marginTop: isMain ? 4 : 2 }}>
              {sub}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LineChart({ days, series, leftLabel, rightLabel }: {
  days: string[];
  series: { name: string; color: string; values: number[]; axis: "L" | "R" }[];
  leftLabel?: string;
  rightLabel?: string;
}) {
  const width = 860;
  const height = 320;
  const padL = 60, padR = 60, padT = 16, padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // Per-series visibility. Click a legend chip to toggle; visible series re-scale
  // the axes so isolating a small line zooms it up automatically.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // If a series-set change removes a name, drop it from the hidden set so we don't
  // pin stale state across agent switches.
  useEffect(() => {
    const names = new Set(series.map(s => s.name));
    setHidden(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const n of prev) { if (names.has(n)) next.add(n); else changed = true; }
      return changed ? next : prev;
    });
  }, [series]);

  const toggle = (name: string) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      // Don't allow hiding every series — keep at least one visible.
      if (next.size >= series.length) return prev;
      return next;
    });
  };

  const isVisible = (name: string) => !hidden.has(name);
  const visibleSeries = series.filter(s => isVisible(s.name));
  const leftSeries  = visibleSeries.filter(s => s.axis === "L");
  const rightSeries = visibleSeries.filter(s => s.axis === "R");
  const hasRight = rightSeries.length > 0;

  const leftMax  = niceCeil(Math.max(1, ...leftSeries.flatMap(s => s.values)));
  const rightMax = niceCeil(Math.max(1, ...rightSeries.flatMap(s => s.values)));

  const xFor = (i: number) =>
    days.length <= 1 ? padL + plotW / 2 : padL + (i * plotW) / (days.length - 1);
  const yForAxis = (v: number, axis: "L" | "R") =>
    padT + plotH - (v / (axis === "L" ? leftMax : rightMax)) * plotH;

  const yTicks = 5;
  // Cap labels at ~10 across the axis so longer ranges (90D, ALL) don't smear
  // overlapping dates onto each other. With 90 days the step lands at 9; with
  // 240+ days it lands at 24 — both readable without rotation.
  const labelStep = Math.max(1, Math.ceil(days.length / 10));
  // Hide the per-point circles once the axis gets dense — at >45 days the
  // spacing drops below ~16px and the dots merge into a thick line. The hover
  // crosshair still draws a single highlighted dot at the active day so the
  // user never loses the read-out.
  const showStaticDots = days.length <= 45;

  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const handleMouse = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const userX = ((e.clientX - rect.left) / rect.width) * width;
    if (days.length <= 1) { setHoverIdx(0); return; }
    const i = Math.round(((userX - padL) * (days.length - 1)) / plotW);
    setHoverIdx(Math.max(0, Math.min(days.length - 1, i)));
  };

  const tooltipX = hoverIdx !== null ? (xFor(hoverIdx) / width) * 100 : 0;
  const tooltipPlaceLeft = tooltipX > 60;

  // Pick a color hint for each axis label — use the first series on that axis.
  const leftAxisColor  = leftSeries[0]?.color  ?? "#6b7280";
  const rightAxisColor = rightSeries[0]?.color ?? "#6b7280";

  return (
    <div style={{ position: "relative" }}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {/* Gridlines + LEFT axis tick labels (aligned to leftMax) */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const t = (leftMax * i) / yTicks;
          const y = padT + plotH - (i / yTicks) * plotH;
          return (
            <g key={`l-${i}`}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="#f3f4f6" />
              <text x={padL - 8} y={y + 4} textAnchor="end" fontSize="10" fill={leftAxisColor}>
                {Math.round(t).toLocaleString()}
              </text>
            </g>
          );
        })}
        {/* RIGHT axis tick labels (scaled to rightMax) */}
        {hasRight && Array.from({ length: yTicks + 1 }, (_, i) => {
          const t = (rightMax * i) / yTicks;
          const y = padT + plotH - (i / yTicks) * plotH;
          return (
            <text key={`r-${i}`} x={width - padR + 8} y={y + 4} textAnchor="start" fontSize="10" fill={rightAxisColor}>
              {Math.round(t).toLocaleString()}
            </text>
          );
        })}
        {/* Axis vertical rules */}
        <line x1={padL} x2={padL} y1={padT} y2={padT + plotH} stroke="#e5e7eb" />
        {hasRight && <line x1={width - padR} x2={width - padR} y1={padT} y2={padT + plotH} stroke="#e5e7eb" />}

        {/* Axis titles */}
        {leftLabel && (
          <text x={padL - 50} y={padT + plotH / 2} textAnchor="middle" fontSize="10" fill={leftAxisColor}
            transform={`rotate(-90 ${padL - 50} ${padT + plotH / 2})`} style={{ fontWeight: 600 }}>
            {leftLabel}
          </text>
        )}
        {hasRight && rightLabel && (
          <text x={width - padR + 50} y={padT + plotH / 2} textAnchor="middle" fontSize="10" fill={rightAxisColor}
            transform={`rotate(90 ${width - padR + 50} ${padT + plotH / 2})`} style={{ fontWeight: 600 }}>
            {rightLabel}
          </text>
        )}

        {days.map((d, i) =>
          i % labelStep === 0 ? (
            <text key={d} x={xFor(i)} y={height - padB + 16} textAnchor="middle" fontSize="10" fill="#6b7280">
              {fmtDay(d)}
            </text>
          ) : null
        )}
        {visibleSeries.map(s => {
          const d = s.values
            .map((v, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(2)} ${yForAxis(v, s.axis).toFixed(2)}`)
            .join(" ");
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2.25} />
              {showStaticDots
                ? s.values.map((v, i) => (
                    <circle key={i} cx={xFor(i)} cy={yForAxis(v, s.axis)} r={hoverIdx === i ? 4.5 : 3} fill={s.color} stroke="#fff" strokeWidth={hoverIdx === i ? 1.5 : 0} />
                  ))
                : hoverIdx !== null
                  ? <circle cx={xFor(hoverIdx)} cy={yForAxis(s.values[hoverIdx] ?? 0, s.axis)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={1.5} />
                  : null}
            </g>
          );
        })}
        {hoverIdx !== null && (
          <line x1={xFor(hoverIdx)} x2={xFor(hoverIdx)} y1={padT} y2={padT + plotH}
            stroke="#9ca3af" strokeDasharray="3 3" strokeWidth={1} />
        )}
        <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent"
          onMouseMove={handleMouse} onMouseLeave={() => setHoverIdx(null)} />
      </svg>

      {hoverIdx !== null && (
        <div style={{
          position: "absolute", top: 16,
          left: tooltipPlaceLeft ? undefined : `calc(${tooltipX}% + 12px)`,
          right: tooltipPlaceLeft ? `calc(${100 - tooltipX}% + 12px)` : undefined,
          background: "#111827", color: "#fff", padding: "8px 12px", borderRadius: 8,
          fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          pointerEvents: "none", minWidth: 180, zIndex: 10,
        }}>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6, fontWeight: 600 }}>
            {fmtDay(days[hoverIdx])}
          </div>
          {visibleSeries.map(s => (
            <div key={s.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "2px 0" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
                {s.name}
                <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 2 }}>({s.axis})</span>
              </span>
              <span style={{ fontWeight: 700 }}>{(s.values[hoverIdx] ?? 0).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Toggleable legend — click to hide/show a series. Axes auto-rescale to what's visible. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, paddingLeft: 4, alignItems: "center" }}>
        {series.map(s => {
          const visible = isVisible(s.name);
          return (
            <button
              key={s.name}
              onClick={() => toggle(s.name)}
              title={visible ? `Click to hide ${s.name}` : `Click to show ${s.name}`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 10px", borderRadius: 999,
                border: `1px solid ${visible ? s.color : "#e5e7eb"}`,
                background: visible ? `${s.color}10` : "#fff",
                color: visible ? "#111827" : "#9ca3af",
                fontSize: 12, fontWeight: 600, cursor: "pointer",
                opacity: visible ? 1 : 0.6,
                transition: "all 0.15s",
              }}>
              <span style={{
                width: 14, height: 3, background: visible ? s.color : "#d1d5db",
                display: "inline-block", borderRadius: 2,
              }} />
              <span style={{ textDecoration: visible ? "none" : "line-through" }}>{s.name}</span>
              <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500 }}>
                ({s.axis === "L" ? "left" : "right"})
              </span>
            </button>
          );
        })}
        {hidden.size > 0 && (
          <button onClick={() => setHidden(new Set())}
            style={{
              marginLeft: 4, padding: "4px 10px", borderRadius: 999,
              border: "1px solid #d1d5db", background: "#fff",
              fontSize: 11, fontWeight: 600, color: "#4f46e5", cursor: "pointer",
            }}>
            Show all
          </button>
        )}
      </div>
    </div>
  );
}

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / pow;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

export default AgentsDashboard;
