import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { toPng } from "html-to-image";
import { getProgramsClient, PROGRAMS_DB_CONFIGURED } from "./supabaseClient";
import { OWNER_NAMES, teamForOwner } from "./owners";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

// ─── Types ─────────────────────────────────────────────────────────────────
type AgentType = "Sales Inbound" | "Service Inbound" | "Sales Outbound" | "Service Outbound";
type RagStatus = "green" | "amber" | "red";
type Cohort = "Activation" | "Ramp" | "Mature" | "Unknown";

type SheetEntry = {
  enterpriseName: string;
  rooftopName: string;
  agentType: string;
  currentStage: string;
  subStage: string;
  enterpriseId: string;
  rooftopId: string;
  agentMrr: number | null;
  collectedMrr: number | null;
  agentCarr: number | null;
  goLiveDate: string | null; // ISO yyyy-mm-dd
  csmEmail: string | null;   // lower-cased email; null when blank/non-email
};

type MetabaseRow = {
  enterprise_name: string;
  rooftop_name: string;
  rooftop_stage: string | null;
  agent_type: AgentType;
  touched_leads: number | null;
  qualified_leads: number | null;
  appointments: number | null;
  appointment_value: number | null;
  total_calls: number | null;
  total_sms: number | null;
  new_leads_created: number | null;
  leads_contacted_from_new: number | null;
} & Record<string, unknown>;

type Account = {
  key: string;            // rooftopId::agentType (or name fallback)
  rooftopName: string;
  enterpriseName: string;
  enterpriseId: string;   // funnel-sheet enterprise id ("" when missing)
  teamId: string;         // funnel-sheet rooftopId == Metabase team_id ("" when missing)
  agentType: AgentType;
  mrr: number | null;
  arr: number | null;     // sheet's agentCarr — fallback to MRR×12 if missing
  goLiveDate: string | null;
  daysLive: number | null;
  cohort: Cohort;
  csmEmail: string | null;
  csmName: string;        // derived from email; "" when no CSM
  // Metabase activity (last 30 days)
  appts: number;
  touched: number;
  newLeads: number;
  roiValue: number;       // appts × cost-per-appt
  roi: number | null;
  rag: RagStatus;
  ragNote: string;
  hasActivity: boolean;
  mrrAtRisk: number;      // mrr if not green else 0
};

// ─── ROI model (mirrors AgentsDashboard) ───────────────────────────────────
const COST_PER_APPT: Record<AgentType, number> = {
  "Sales Inbound":   200,
  "Sales Outbound":  250,
  "Service Inbound": 100,
  "Service Outbound":200,
};
function costPerAppt(t: AgentType): number {
  return COST_PER_APPT[t] ?? 0;
}

// RAG thresholds on the ROI multiple:
//   ≥ 3× → Green   ·   1.5×–3× → Amber   ·   < 1.5× → Red
const ROI_GREEN = 3;
const ROI_AMBER = 1.5;

const RAG_COLORS: Record<RagStatus, { bg: string; fg: string; dot: string }> = {
  green: { bg: "#dcfce7", fg: "#166534", dot: "#16a34a" },
  amber: { bg: "#fef3c7", fg: "#92400e", dot: "#d97706" },
  red:   { bg: "#fee2e2", fg: "#991b1b", dot: "#dc2626" },
};

const COHORT_COLORS: Record<Cohort, { bg: string; fg: string }> = {
  Activation: { bg: "#dbeafe", fg: "#1e40af" },
  Ramp:       { bg: "#ede9fe", fg: "#5b21b6" },
  Mature:     { bg: "#f1f5f9", fg: "#334155" },
  Unknown:    { bg: "#f3f4f6", fg: "#6b7280" },
};

const ROOT_CAUSES = [
  "Activation Incomplete",
  "Low Lead Volume",
  "Low Conversion",
  "Agent Quality",
  "Dealer Engagement",
  "Pricing / Fit",
  "Tech / Integration",
  "Other",
] as const;
type RootCause = typeof ROOT_CAUSES[number];

const TASK_FUNCTIONS = ["CSM", "Product", "Engineering", "Operations", "Dealer", "PM"] as const;
type TaskFunction = typeof TASK_FUNCTIONS[number];
type TaskStatus = "Open" | "In Progress" | "Blocked" | "Done";

type Task = {
  id: string;
  title: string;
  taskDri: string;
  function: TaskFunction;
  dueDate: string | null;
  status: TaskStatus;
  blockerNote: string;
  createdAt: string;
  updatedAt: string;
};

type AccountState = {
  rootCauses: RootCause[];
  tasks: Task[];
  accountDri: string;            // CSM override (sheet provides the default)
  actualLive: boolean;           // operator-controlled "really shipping today" flag
  starred: boolean;              // operator focus flag — star to highlight + filter
  notes: string;
};

// Rooftop-level tech stack (CRM / scheduler / DMS) — these are facts about
// the dealership, not the agent product, so they're keyed by rooftop and
// shared across every agent on that rooftop. Stored in programs_rooftops.
type RooftopStack = {
  crmName: string;
  serviceSchedulerName: string;
  dmsName: string;
};
const EMPTY_ROOFTOP_STACK: RooftopStack = { crmName: "", serviceSchedulerName: "", dmsName: "" };

// ─── Helpers ───────────────────────────────────────────────────────────────
const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fmtMoney = (n: number | null) =>
  n == null ? "—" : `$${Math.round(n).toLocaleString()}`;
const fmtRoi = (x: number | null) => (x == null ? "—" : `${x.toFixed(1)}×`);

// "2026-05-26" → "26 May" (DD MON). Returns "" for falsy/unparseable input.
const ETA_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtEtaShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${ETA_MONTHS[d.getMonth()]}`;
}

function daysBetween(fromIso: string | null, toDate: Date): number | null {
  if (!fromIso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fromIso);
  if (!m) return null;
  const from = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const ms = toDate.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Cohort thresholds — aggressive accountability curve:
//   0–7d   Activation : just live, signal is noisy, focus on setup/first-conversion
//   7–30d  Ramp       : signal is real, ROI starts to matter
//   30d+   Mature     : steady state — Red/Amber here = churn risk
function cohortFromDays(d: number | null): Cohort {
  if (d == null || d < 0) return "Unknown";
  if (d < 7)  return "Activation";
  if (d < 30) return "Ramp";
  return "Mature";
}

// Unfurl a corporate email into a display name. Splits on @, then splits the
// local part on `.`, `_`, or `-` (preserving hyphen between sub-tokens as a
// real hyphen in the output). Trailing digits on tokens are stripped — corp
// emails often disambiguate dupes with `.singh1` / `.kumar2`. Edge cases:
//   manpreet.kaur@spyne.ai     → Manpreet Kaur
//   mary-jane.smith@x.com      → Mary-Jane Smith
//   vishal.singh1@spyne.ai     → Vishal Singh
//   ankur@spyne.ai             → Ankur
//   ""/null                    → ""
// Resolve the effective CSM for an account: any override in the dashboard
// state (account_state.account_dri) wins; otherwise fall back to the funnel
// sheet's csmEmail. Returns { email, name } where name is the unfurled
// display string.
function effectiveCsm(a: Account, st: AccountState | undefined): { email: string | null; name: string } {
  const override = (st?.accountDri ?? "").trim();
  if (override) return { email: override.toLowerCase(), name: displayNameFromEmail(override) || override };
  return { email: a.csmEmail, name: a.csmName };
}

function displayNameFromEmail(email: string | null | undefined): string {
  if (!email) return "";
  const s = String(email).trim();
  if (!s) return "";
  // Drawer accepts either an email or a plain name. Only unfurl emails;
  // for anything else, respect the user's casing/spacing — otherwise
  // typing "Shubham Mittal" becomes "Shubham mittal" because the unfurl
  // logic lowercases the whole string and re-caps only on dot/underscore.
  if (!s.includes("@")) return s;
  const local = s.toLowerCase().split("@")[0] ?? "";
  if (!local) return "";
  const cap = (tok: string) => {
    const trimmed = tok.replace(/\d+$/, "");                // drop dedup suffix digits
    if (trimmed.length === 0) return tok.charAt(0).toUpperCase() + tok.slice(1);
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  };
  const capHyphenated = (tok: string) => tok.split("-").map(cap).join("-");
  return local.split(/[._]+/).filter(Boolean).map(capHyphenated).join(" ");
}

const AGENT_LABELS: Record<AgentType, string> = {
  "Sales Inbound":   "Sales IB",
  "Service Inbound": "Service IB",
  "Sales Outbound":  "Sales OB",
  "Service Outbound":"Service OB",
};

function normalizeAgentType(s: string): AgentType | null {
  const t = s.trim().toLowerCase();
  if (t === "sales inbound"   || t === "sales ib"   || t === "sales-ib")   return "Sales Inbound";
  if (t === "service inbound" || t === "service ib" || t === "service-ib") return "Service Inbound";
  if (t === "sales outbound"  || t === "sales ob"   || t === "sales-ob")   return "Sales Outbound";
  if (t === "service outbound"|| t === "service ob" || t === "service-ob") return "Service Outbound";
  return null;
}

// Persistence — Supabase (primary) with localStorage mirror (backup if DB is
// down or env vars are missing). Schema: src/programs/schema.sql.
const LS_ROOT = "programs.accountState.v1";
// Default shape for AccountState — kept in sync with the `AccountState` type
// above. Used to backfill any fields missing on objects loaded from older
// localStorage snapshots (added incrementally as we extend the schema).
const ACCOUNT_STATE_DEFAULTS: AccountState = {
  rootCauses: [],
  tasks: [],
  accountDri: "",
  actualLive: false,
  starred: false,
  notes: "",
};
function loadLocalMirror(): Record<string, AccountState> {
  try {
    const raw = localStorage.getItem(LS_ROOT);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Backfill any fields added since this snapshot was written — otherwise
    // code that reads (e.g.) s.serviceSchedulerName crashes on .trim() on
    // pre-existing localStorage state.
    const out: Record<string, AccountState> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = { ...ACCOUNT_STATE_DEFAULTS, ...(v as Partial<AccountState>) };
    }
    return out;
  } catch { return {}; }
}
function saveLocalMirror(s: Record<string, AccountState>) {
  try { localStorage.setItem(LS_ROOT, JSON.stringify(s)); } catch {}
}

// Load every account_state + task from Supabase and rebuild the in-memory
// map. Returns null if the DB isn't configured or the fetch fails (caller
// falls back to the local mirror so the UI still works offline).
async function loadFromSupabase(): Promise<Record<string, AccountState> | null> {
  const sb = getProgramsClient();
  if (!sb) return null;
  try {
    const [stateRes, tasksRes] = await Promise.all([
      sb.from("programs_account_state").select("*"),
      sb.from("programs_tasks").select("*"),
    ]);
    if (stateRes.error) throw stateRes.error;
    if (tasksRes.error) throw tasksRes.error;
    const out: Record<string, AccountState> = {};
    for (const r of stateRes.data ?? []) {
      out[r.account_key] = {
        rootCauses: Array.isArray(r.root_causes) ? r.root_causes : [],
        tasks: [],
        accountDri: r.account_dri ?? "",
        actualLive: r.actual_live === true,
        starred: r.starred === true,
        notes: r.notes ?? "",
      };
    }
    for (const t of tasksRes.data ?? []) {
      const k = t.account_key as string;
      if (!out[k]) out[k] = { rootCauses: [], tasks: [], accountDri: "", actualLive: false, starred: false, notes: "" };
      out[k].tasks.push({
        id: t.id,
        title: t.title ?? "",
        taskDri: t.task_dri ?? "",
        function: (t.function ?? "CSM") as TaskFunction,
        dueDate: t.due_date ?? null,
        status: (t.status ?? "Open") as TaskStatus,
        blockerNote: t.blocker_note ?? "",
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      });
    }
    return out;
  } catch (e) {
    console.error("[programs] Supabase load failed:", e);
    return null;
  }
}

// Set once if the DB upsert reports `starred` is unknown (pre-migration), so
// subsequent saves skip it without re-probing. Cleared by a page reload after
// schema-starred.sql is applied.
let starredColumnMissing = false;

// Persist one account's full state. Upserts the row in programs_account_state
// and reconciles its tasks (insert new, update changed by id, delete removed).
async function persistAccount(accountKey: string, current: AccountState): Promise<{ ok: boolean; error?: string }> {
  const sb = getProgramsClient();
  if (!sb) return { ok: false, error: "DB not configured" };
  const [rooftopId, agentType] = parseAccountKey(accountKey);
  try {
    // 1. Upsert account_state. `starred` is a newer column (schema-starred.sql);
    // if the DB hasn't been migrated yet, retry without it so the rest of the
    // state still saves instead of failing the whole write.
    const baseRow = {
      account_key: accountKey,
      rooftop_id: rooftopId,
      agent_type: agentType,
      account_dri: current.accountDri,
      actual_live: current.actualLive,
      root_causes: current.rootCauses,
      notes: current.notes,
      updated_at: new Date().toISOString(),
    };
    const row = starredColumnMissing ? baseRow : { ...baseRow, starred: current.starred };
    let upState = await sb.from("programs_account_state").upsert(row, { onConflict: "account_key" });
    if (upState.error && !starredColumnMissing && /starred/i.test(upState.error.message ?? "")) {
      console.warn("[programs] `starred` column missing — run schema-starred.sql. Saving without it for now.");
      starredColumnMissing = true;
      upState = await sb.from("programs_account_state").upsert(baseRow, { onConflict: "account_key" });
    }
    if (upState.error) throw upState.error;

    // 2. Reconcile tasks for this account_key
    const existing = await sb.from("programs_tasks").select("id").eq("account_key", accountKey);
    if (existing.error) throw existing.error;
    const existingIds = new Set<string>((existing.data ?? []).map(r => r.id));
    const currentIds = new Set<string>(current.tasks.map(t => t.id));

    const toDelete = [...existingIds].filter(id => !currentIds.has(id));
    if (toDelete.length) {
      const del = await sb.from("programs_tasks").delete().in("id", toDelete);
      if (del.error) throw del.error;
    }
    if (current.tasks.length) {
      const up = await sb.from("programs_tasks").upsert(
        current.tasks.map(t => ({
          id: t.id,
          account_key: accountKey,
          title: t.title,
          task_dri: t.taskDri,
          function: t.function,
          due_date: t.dueDate,
          status: t.status,
          blocker_note: t.blockerNote,
          created_at: t.createdAt,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "id" },
      );
      if (up.error) throw up.error;
    }
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[programs] persistAccount failed:", msg);
    return { ok: false, error: msg };
  }
}

// Load rooftop-level tech stack rows from Supabase. Returns null if the DB
// isn't configured or the fetch fails — caller falls through to empty data.
async function loadRooftopStacks(): Promise<Record<string, RooftopStack> | null> {
  const sb = getProgramsClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from("programs_rooftops").select("*");
    if (error) throw error;
    const out: Record<string, RooftopStack> = {};
    for (const r of data ?? []) {
      out[r.rooftop_key] = {
        crmName: r.crm_name ?? "",
        serviceSchedulerName: r.service_scheduler_name ?? "",
        dmsName: r.dms_name ?? "",
      };
    }
    return out;
  } catch (e) {
    console.error("[programs] Supabase rooftops load failed:", e);
    return null;
  }
}

// Upsert a single rooftop record. Used when the user edits CRM/Scheduler/DMS
// from the drawer — the change applies to every (rooftop × agent) account
// implicitly because every consumer reads via rooftopKey.
async function persistRooftop(rooftopKey: string, stack: RooftopStack): Promise<{ ok: boolean; error?: string }> {
  const sb = getProgramsClient();
  if (!sb) return { ok: false, error: "DB not configured" };
  try {
    const { error } = await sb.from("programs_rooftops").upsert({
      rooftop_key: rooftopKey,
      crm_name: stack.crmName,
      service_scheduler_name: stack.serviceSchedulerName,
      dms_name: stack.dmsName,
      updated_at: new Date().toISOString(),
    }, { onConflict: "rooftop_key" });
    if (error) throw error;
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[programs] persistRooftop failed:", msg);
    return { ok: false, error: msg };
  }
}

// Strip the "::AgentType" suffix from an accountKey to get its rooftop key —
// "tid:abc::Sales Inbound" → "tid:abc", "name:foo::Service IB" → "name:foo".
// Every (rooftop × agent) on the same rooftop maps to the same rooftopKey,
// which is how rooftop-level facts (CRM, scheduler, DMS) stay consistent.
function rooftopKeyFromAccountKey(k: string): string {
  const i = k.indexOf("::");
  return i > 0 ? k.slice(0, i) : k;
}

// account_key format from buildAccount: "tid:<rooftopId>::<agentType>" or
// "name:<lower-name>::<agentType>". Extract rooftopId (or null) + agentType.
function parseAccountKey(k: string): [string | null, string | null] {
  const m = /^tid:([^:]+)::(.+)$/.exec(k);
  if (m) return [m[1], m[2]];
  const n = /^name:[^:]+::(.+)$/.exec(k);
  return [null, n ? n[1] : null];
}

const EMPTY_STATE: AccountState = { rootCauses: [], tasks: [], accountDri: "", actualLive: false, starred: false, notes: "" };
type DbStatus = "loading" | "ready" | "saving" | "error" | "local-only";

// ─── Component ─────────────────────────────────────────────────────────────
export default function ProgramsDashboard() {
  const [sheet, setSheet] = useState<SheetEntry[]>([]);
  const [daily, setDaily] = useState<MetabaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  // UI state. Initial tab can be set via URL hash so links like
  // `/programs#tasks` land directly on Path to Green.
  const initialTab = (() => {
    const h = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    return (["overview","list","cohort","tasks","report"].includes(h) ? h : "overview") as
      "overview" | "list" | "cohort" | "tasks" | "report";
  })();
  const [tab, setTab] = useState<"overview" | "list" | "cohort" | "tasks" | "report">(initialTab);
  // Keep the URL hash in sync when the user changes tabs — makes the back/
  // forward buttons jump between tabs and lets you bookmark or share a tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const desired = `#${tab}`;
    if (window.location.hash !== desired) {
      window.history.replaceState(null, "", desired);
    }
  }, [tab]);
  // RAG filter — multi-select. Default = exclude Green (focus on not-green
  // accounts which is the program-management lens). Toggle Green on to see
  // the whole portfolio.
  const [ragFilter, setRagFilter] = useState<Set<RagStatus>>(new Set(["red", "amber"]));
  const [cohortFilter, setCohortFilter] = useState<Set<Cohort>>(new Set());
  const [agentFilter, setAgentFilter] = useState<Set<AgentType>>(new Set());
  const [csmFilter, setCsmFilter] = useState<Set<string>>(new Set());   // emails
  // Actually-Live filter — "all" shows every rooftop (incl. not-live), "live"
  // only the actually-live ones, "notlive" only the not-yet-live. Default
  // "all" so nothing is hidden until the operator narrows.
  const [liveFilter, setLiveFilter] = useState<"all" | "live" | "notlive">("all");
  const [starOnly, setStarOnly] = useState(false);   // show only starred rooftops
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"priority" | "mrr" | "roi" | "daysLive" | "name">("priority");
  const [openKey, setOpenKey] = useState<string | null>(null);

  // Persistent account state. Hydrate from Supabase on mount (with local
  // mirror as fallback); persist with debounced per-account upserts.
  const [state, setState] = useState<Record<string, AccountState>>(() => loadLocalMirror());
  const [dbStatus, setDbStatus] = useState<DbStatus>(PROGRAMS_DB_CONFIGURED ? "loading" : "local-only");
  const [dbError, setDbError] = useState<string | null>(null);
  const dirtyKeys = useRef<Set<string>>(new Set());
  const saveTimer = useRef<number | null>(null);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Rooftop-level tech stack (CRM / scheduler / DMS) — keyed by rooftopKey
  // so all agents on the same rooftop share one value automatically.
  const [rooftopStack, setRooftopStack] = useState<Record<string, RooftopStack>>({});
  const dirtyRooftops = useRef<Set<string>>(new Set());
  const rooftopSaveTimer = useRef<number | null>(null);
  const rooftopStackRef = useRef(rooftopStack);
  useEffect(() => { rooftopStackRef.current = rooftopStack; }, [rooftopStack]);

  // Hydrate from Supabase on mount.
  useEffect(() => {
    if (!PROGRAMS_DB_CONFIGURED) return;
    let cancelled = false;
    (async () => {
      const [fromDb, rooftops] = await Promise.all([loadFromSupabase(), loadRooftopStacks()]);
      if (cancelled) return;
      if (fromDb) {
        setState(fromDb);
        saveLocalMirror(fromDb);
        setDbStatus("ready");
        setDbError(null);
      } else {
        setDbStatus("error");
        setDbError("Could not load from Supabase. Using local mirror.");
      }
      if (rooftops) setRooftopStack(rooftops);
    })();
    return () => { cancelled = true; };
  }, []);

  // Mark a key dirty and debounce a save. Local mirror is updated immediately.
  const flushDirty = async () => {
    const keys = Array.from(dirtyKeys.current);
    dirtyKeys.current = new Set();
    if (!PROGRAMS_DB_CONFIGURED || keys.length === 0) return;
    setDbStatus("saving");
    let errMsg: string | null = null;
    for (const k of keys) {
      const cur = stateRef.current[k];
      if (!cur) continue;
      const res = await persistAccount(k, cur);
      if (!res.ok) errMsg = res.error ?? "save failed";
    }
    setDbStatus(errMsg ? "error" : "ready");
    setDbError(errMsg);
  };

  const flushDirtyRooftops = async () => {
    const keys = Array.from(dirtyRooftops.current);
    dirtyRooftops.current = new Set();
    if (!PROGRAMS_DB_CONFIGURED || keys.length === 0) return;
    setDbStatus("saving");
    let errMsg: string | null = null;
    for (const rk of keys) {
      const cur = rooftopStackRef.current[rk];
      if (!cur) continue;
      const res = await persistRooftop(rk, cur);
      if (!res.ok) errMsg = res.error ?? "save failed";
    }
    setDbStatus(errMsg ? "error" : "ready");
    setDbError(errMsg);
  };

  const updateAccountState = (key: string, patch: Partial<AccountState>) => {
    setState(prev => {
      const next = { ...prev, [key]: { ...EMPTY_STATE, ...prev[key], ...patch } };
      saveLocalMirror(next);
      return next;
    });
    dirtyKeys.current.add(key);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushDirty, 700);
  };

  // Update the rooftop-level tech stack for a rooftop (every agent on that
  // rooftop sees the change). Debounced 700ms like account state.
  const updateRooftopStack = (rooftopKey: string, patch: Partial<RooftopStack>) => {
    setRooftopStack(prev => ({
      ...prev,
      [rooftopKey]: { ...EMPTY_ROOFTOP_STACK, ...prev[rooftopKey], ...patch },
    }));
    dirtyRooftops.current.add(rooftopKey);
    if (rooftopSaveTimer.current) window.clearTimeout(rooftopSaveTimer.current);
    rooftopSaveTimer.current = window.setTimeout(flushDirtyRooftops, 700);
  };

  // ── Fetch sheet + Metabase ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/api/accounts-sheet`, { cache: "no-store" }).then(r => r.json()),
      fetch(`${API_BASE}/api/agents`,         { cache: "no-store" }).then(r => r.json()),
    ])
      .then(([sheetJson, agentsJson]) => {
        if (cancelled) return;
        const rows: SheetEntry[] = Array.isArray(sheetJson?.rows) ? sheetJson.rows : [];
        setSheet(rows);
        setDaily(Array.isArray(agentsJson?.daily) ? agentsJson.daily : []);
        setFetchedAt(agentsJson?.fetchedAt ?? null);
      })
      .catch(e => { if (!cancelled) setError(e?.message ?? "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Build accounts (sheet-driven roster, Metabase-decorated) ────────────
  const accounts: Account[] = useMemo(() => {
    if (!sheet.length) return [];
    const today = new Date(); today.setHours(0,0,0,0);
    const horizon = new Date(today); horizon.setDate(horizon.getDate() - 29);

    // Index daily rows for the last 30 days. Sum additive fields; MAX TOFU
    // (newLeads / contactedFromNew are constants per row, not per-day deltas).
    type Agg = {
      appts: number; touched: number; qualified: number; newLeads: number;
      contactedFromNew: number; totalCalls: number; totalSms: number;
      roiValue: number;
    };
    const empty: Agg = { appts:0, touched:0, qualified:0, newLeads:0, contactedFromNew:0, totalCalls:0, totalSms:0, roiValue:0 };
    const byKeyTeam = new Map<string, Agg>();
    const byKeyName = new Map<string, Agg>();
    for (const r of daily) {
      const dayStr = (r as Record<string, unknown>)["day"];
      if (typeof dayStr !== "string") continue;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayStr);
      if (!m) continue;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (d < horizon || d > today) continue;
      const teamId = String(((r as Record<string, unknown>)["team_id"]) ?? ((r as Record<string, unknown>)["pld.team_id"]) ?? "").trim();
      const aType = r.agent_type;
      const name = String(r.rooftop_name ?? "").trim();
      const cpa = costPerAppt(aType);
      const tKey = teamId ? `tid:${teamId}::${aType}` : "";
      const nKey = `name:${name.toLowerCase()}::${aType}`;
      const apply = (map: Map<string, Agg>, k: string) => {
        const prev = map.get(k) ?? { ...empty };
        prev.appts            += num(r.appointments);
        prev.touched          += num(r.touched_leads);
        prev.qualified        += num(r.qualified_leads);
        prev.totalCalls       += num(r.total_calls);
        prev.totalSms         += num(r.total_sms);
        prev.roiValue         += num(r.appointments) * cpa;
        const nl  = num(r.new_leads_created);
        const cfn = num(r.leads_contacted_from_new);
        if (nl  > prev.newLeads)         prev.newLeads = nl;
        if (cfn > prev.contactedFromNew) prev.contactedFromNew = cfn;
        map.set(k, prev);
      };
      if (tKey) apply(byKeyTeam, tKey);
      apply(byKeyName, nKey);
    }

    const out: Account[] = [];
    for (const e of sheet) {
      if (e.currentStage !== "Live") continue;            // first cut: Live only
      const aType = normalizeAgentType(e.agentType);
      if (!aType) continue;

      const tKey = e.rooftopId ? `tid:${e.rooftopId}::${aType}` : "";
      const nKey = `name:${e.rooftopName.toLowerCase()}::${aType}`;
      const agg = (tKey && byKeyTeam.get(tKey)) || byKeyName.get(nKey) || { ...empty };

      const daysLive = daysBetween(e.goLiveDate, today);
      const cohort = cohortFromDays(daysLive);
      const hasActivity = agg.touched > 0 || agg.appts > 0 || agg.totalCalls > 0 || agg.totalSms > 0 || agg.newLeads > 0;
      const denom = e.agentMrr != null && e.agentMrr > 0 ? e.agentMrr : null; // periodMonths=1 (trailing 30d)
      const roi = denom != null && agg.roiValue > 0 ? agg.roiValue / denom : null;

      let rag: RagStatus;
      let ragNote: string;
      if (cohort === "Activation") {
        // Activation: don't penalise on ROI volume. Surface as Amber if no
        // activity, otherwise Green. Real RAG kicks in once Ramp begins.
        if (!hasActivity) { rag = "amber"; ragNote = `Activation — ${daysLive ?? 0}d post-live, no Metabase activity yet`; }
        else { rag = "green"; ragNote = `Activation — ${daysLive ?? 0}d post-live, agent receiving activity`; }
      } else if (!hasActivity) {
        rag = "red"; ragNote = "No Metabase activity in last 30d";
      } else if (denom == null) {
        rag = "red"; ragNote = "MRR unknown — ROI can't be computed";
      } else if (roi! >= ROI_GREEN) {
        rag = "green"; ragNote = `ROI ${fmtRoi(roi)} — at/above ${ROI_GREEN}×`;
      } else if (roi! >= ROI_AMBER) {
        rag = "amber"; ragNote = `ROI ${fmtRoi(roi)} — ${ROI_AMBER}–${ROI_GREEN}×`;
      } else {
        rag = "red"; ragNote = `ROI ${fmtRoi(roi)} — below ${ROI_AMBER}×`;
      }

      const arr = e.agentCarr ?? (e.agentMrr != null ? e.agentMrr * 12 : null);
      out.push({
        key: tKey || nKey,
        rooftopName: e.rooftopName,
        enterpriseName: e.enterpriseName,
        enterpriseId: e.enterpriseId ?? "",
        teamId: e.rooftopId ?? "",
        agentType: aType,
        mrr: e.agentMrr,
        arr,
        goLiveDate: e.goLiveDate,
        daysLive,
        cohort,
        csmEmail: e.csmEmail,
        csmName: displayNameFromEmail(e.csmEmail),
        appts: agg.appts,
        touched: agg.touched,
        newLeads: agg.newLeads,
        roiValue: agg.roiValue,
        roi,
        rag,
        ragNote,
        hasActivity,
        mrrAtRisk: rag !== "green" ? (e.agentMrr ?? 0) : 0,
      });
    }
    return out;
  }, [sheet, daily]);

  // Filtered + sorted list for the table.
  const filtered = useMemo(() => {
    let rows = accounts;
    if (ragFilter.size) rows = rows.filter(a => ragFilter.has(a.rag));
    if (cohortFilter.size) rows = rows.filter(a => cohortFilter.has(a.cohort));
    if (agentFilter.size)  rows = rows.filter(a => agentFilter.has(a.agentType));
    if (csmFilter.size)    rows = rows.filter(a => {
      const eff = effectiveCsm(a, state[a.key]);
      return eff.email != null && csmFilter.has(eff.email);
    });
    if (liveFilter !== "all") rows = rows.filter(a => {
      const live = state[a.key]?.actualLive === true;
      return liveFilter === "live" ? live : !live;
    });
    if (starOnly) rows = rows.filter(a => state[a.key]?.starred === true);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(a =>
        a.rooftopName.toLowerCase().includes(q) ||
        a.enterpriseName.toLowerCase().includes(q)
      );
    }
    const ragRank: Record<RagStatus, number> = { red: 3, amber: 2, green: 1 };
    const cohortRank: Record<Cohort, number>  = { Mature: 3, Ramp: 2, Activation: 1, Unknown: 0 };
    const sorted = [...rows].sort((a, b) => {
      if (sortKey === "priority") {
        const r = ragRank[b.rag] - ragRank[a.rag];          if (r) return r;
        const c = cohortRank[b.cohort] - cohortRank[a.cohort]; if (c) return c;
        return (b.mrrAtRisk ?? 0) - (a.mrrAtRisk ?? 0);
      }
      if (sortKey === "mrr")      return (b.mrr ?? -1) - (a.mrr ?? -1);
      if (sortKey === "roi")      return (b.roi ?? -1) - (a.roi ?? -1);
      if (sortKey === "daysLive") return (b.daysLive ?? -1) - (a.daysLive ?? -1);
      if (sortKey === "name")     return a.rooftopName.localeCompare(b.rooftopName);
      return 0;
    });
    return sorted;
  }, [accounts, ragFilter, cohortFilter, agentFilter, csmFilter, liveFilter, starOnly, search, sortKey, state]);

  // Unique CSM list (email → name) sorted by display name. Used by the filter.
  // Uses effective CSM so dashboard overrides are reflected.
  const csmOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of accounts) {
      const eff = effectiveCsm(a, state[a.key]);
      if (eff.email && !seen.has(eff.email)) seen.set(eff.email, eff.name || eff.email);
    }
    return Array.from(seen.entries()).sort(([,a],[,b]) => a.localeCompare(b));
  }, [accounts, state]);

  // ── Aggregates: Agent×RAG, Agent×Cohort (both use $ARR) ────────────────
  type Cell = { count: number; arr: number };
  const emptyCell = (): Cell => ({ count: 0, arr: 0 });
  const ragRowMaker = () => ({ red: emptyCell(), amber: emptyCell(), green: emptyCell() });

  // Only Actually-Live (rooftop × agent) rows count toward the aggregate
  // widgets. Sheet stage = "Live" gets the row onto Account List + Path to
  // Green so the operator can toggle it; the checkbox on Account List
  // promotes it into every Overview / By-Cohort / Email aggregate.
  const liveAccounts = useMemo(
    () => accounts.filter(a => state[a.key]?.actualLive === true),
    [accounts, state],
  );

  // Per-agent RAG counts + $ARR (drives the top KPI cards)
  const agentByRag = useMemo(() => {
    const m: Record<AgentType, Record<RagStatus, Cell>> = {
      "Sales Inbound":    ragRowMaker(),
      "Service Inbound":  ragRowMaker(),
      "Sales Outbound":   ragRowMaker(),
      "Service Outbound": ragRowMaker(),
    };
    for (const a of liveAccounts) {
      m[a.agentType][a.rag].count += 1;
      m[a.agentType][a.rag].arr   += a.arr ?? 0;
    }
    return m;
  }, [liveAccounts]);

  // Per-agent Cohort breakdown (drives the four tables on Overview)
  const agentByCohort = useMemo(() => {
    const cohortRow = () => ({
      Activation: ragRowMaker(),
      Ramp:       ragRowMaker(),
      Mature:     ragRowMaker(),
      Unknown:    ragRowMaker(),
    });
    const m: Record<AgentType, ReturnType<typeof cohortRow>> = {
      "Sales Inbound":    cohortRow(),
      "Service Inbound":  cohortRow(),
      "Sales Outbound":   cohortRow(),
      "Service Outbound": cohortRow(),
    };
    for (const a of liveAccounts) {
      m[a.agentType][a.cohort][a.rag].count += 1;
      m[a.agentType][a.cohort][a.rag].arr   += a.arr ?? 0;
    }
    return m;
  }, [liveAccounts]);

  // Overall portfolio split: Red / Amber / Green / At-Risk(R+A) — each with
  // count + $ARR + share of total. Drives the top KPI bar on Overview.
  const overall = useMemo(() => {
    const total = liveAccounts.length;
    const totalArr = liveAccounts.reduce((s, a) => s + (a.arr ?? 0), 0);
    const bucket = (rags: RagStatus[]) => {
      const xs = liveAccounts.filter(a => rags.includes(a.rag));
      const count = xs.length;
      const arr = xs.reduce((s, a) => s + (a.arr ?? 0), 0);
      return {
        count, arr,
        pctCount: total > 0 ? (count / total) * 100 : 0,
        pctArr:   totalArr > 0 ? (arr / totalArr) * 100 : 0,
      };
    };
    return {
      totalCount: total,
      totalArr,
      red:    bucket(["red"]),
      amber:  bucket(["amber"]),
      green:  bucket(["green"]),
      atRisk: bucket(["red","amber"]),
    };
  }, [liveAccounts]);

  const openAccount = openKey ? accounts.find(a => a.key === openKey) ?? null : null;
  const openAccountState = openKey ? (state[openKey] ?? EMPTY_STATE) : EMPTY_STATE;

  // Distinct tech-stack values across all rooftops. Drawer combobox uses
  // these as dropdown suggestions so common vendors get auto-completed
  // without managing an enum. Sourced from the rooftop-level table now.
  const stackOptions = useMemo(() => {
    const uniq = (pick: (s: RooftopStack) => string) => {
      const set = new Set<string>();
      for (const s of Object.values(rooftopStack)) {
        const v = (pick(s) ?? "").trim();
        if (v) set.add(v);
      }
      return Array.from(set).sort((a, b) => a.localeCompare(b));
    };
    return {
      crm:       uniq(s => s.crmName),
      scheduler: uniq(s => s.serviceSchedulerName),
      dms:       uniq(s => s.dmsName),
    };
  }, [rooftopStack]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <Header fetchedAt={fetchedAt} loading={loading} dbStatus={dbStatus} dbError={dbError} />
      {!PROGRAMS_DB_CONFIGURED && (
        <div style={S.errorBar}>
          Supabase not configured. Set <code>VITE_PROGRAMS_SUPABASE_URL</code> + <code>VITE_PROGRAMS_SUPABASE_KEY</code> in .env. Changes saved to browser localStorage only.
        </div>
      )}

      {error && <div style={S.errorBar}>Failed to load: {error}</div>}

      {/* Tabs */}
      <div style={S.tabs}>
        <TabButton active={tab==="overview"} onClick={()=>setTab("overview")}>Overview</TabButton>
        <TabButton active={tab==="list"}     onClick={()=>setTab("list")}>Account List</TabButton>
        <TabButton active={tab==="cohort"}   onClick={()=>setTab("cohort")}>By Cohort</TabButton>
        <TabButton active={tab==="tasks"}    onClick={()=>setTab("tasks")}>Path to Green</TabButton>
        <TabButton active={tab==="report"}   onClick={()=>setTab("report")}>Email Report</TabButton>
      </div>

      {/* Top: overall portfolio RAG split */}
      <OverallRagBar overall={overall} />

      {/* Per-agent breakdown */}
      <AgentKpiCards agentByRag={agentByRag} />

      {tab === "overview" && (
        <OverviewView
          accounts={accounts}
          state={state}
          onOpen={setOpenKey}
        />
      )}

      {/* Filters block — only on Account List at the top; on By Cohort the
          tab renders it lower (after cohort definitions + agent×cohort). */}
      {tab === "list" && (
        <Filters
          ragFilter={ragFilter} setRagFilter={setRagFilter}
          cohortFilter={cohortFilter} setCohortFilter={setCohortFilter}
          agentFilter={agentFilter}   setAgentFilter={setAgentFilter}
          csmFilter={csmFilter}       setCsmFilter={setCsmFilter}
          csmOptions={csmOptions}
          liveFilter={liveFilter}     setLiveFilter={setLiveFilter}
          starOnly={starOnly}         setStarOnly={setStarOnly}
          search={search}             setSearch={setSearch}
          sortKey={sortKey}           setSortKey={setSortKey}
          showSort={true}
        />
      )}

      {tab === "list"   && <AccountTable rows={filtered} state={state} rooftopStack={rooftopStack} onOpen={setOpenKey} onToggleActualLive={(k, v) => updateAccountState(k, { actualLive: v })} onToggleStar={(k, v) => updateAccountState(k, { starred: v })} />}
      {tab === "cohort" && (
        <CohortView agentByCohort={agentByCohort} />
      )}
      {tab === "tasks"  && <NextStepsView accounts={accounts} state={state} onOpen={setOpenKey} onToggleStar={(k, v) => updateAccountState(k, { starred: v })} />}
      {tab === "report" && <EmailReportView accounts={liveAccounts} state={state} overall={overall} />}

      {openAccount && (() => {
        const rk = rooftopKeyFromAccountKey(openAccount.key);
        return (
          <AccountDrawer
            account={openAccount}
            state={openAccountState}
            stack={rooftopStack[rk] ?? EMPTY_ROOFTOP_STACK}
            stackOptions={stackOptions}
            onChange={(patch)=>updateAccountState(openAccount.key, patch)}
            onStackChange={(patch)=>updateRooftopStack(rk, patch)}
            onClose={()=>setOpenKey(null)}
          />
        );
      })()}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────
function Header({ fetchedAt, loading, dbStatus, dbError }: { fetchedAt: string | null; loading: boolean; dbStatus: DbStatus; dbError: string | null }) {
  const dbLabel: Record<DbStatus, { text: string; color: string }> = {
    loading:      { text: "DB · loading",  color: "#6b7280" },
    ready:        { text: "DB · synced",   color: "#16a34a" },
    saving:       { text: "DB · saving…",  color: "#d97706" },
    error:        { text: dbError ? `DB · error: ${dbError}` : "DB · error", color: "#dc2626" },
    "local-only": { text: "DB · local only", color: "#92400e" },
  };
  return (
    <div style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#111827", margin: 0 }}>
          Account Programs · Path to Green
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0", maxWidth: 820 }}>
          Live accounts not in Green, by RAG × cohort. Trailing 30-day ROI vs MRR. Track diagnoses,
          next steps, and ownership for every not-green account.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ color: loading ? "#6b7280" : "#16a34a" }}>
            {loading ? "Fetching activity…" : fetchedAt ? `● fetched ${new Date(fetchedAt).toLocaleTimeString()}` : ""}
          </div>
          <div style={{ color: dbLabel[dbStatus].color, fontWeight: 600 }}>● {dbLabel[dbStatus].text}</div>
        </div>
        <a href="/agents"
           style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid #111827", background: "#111827", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#fff", textDecoration: "none" }}>
          ← Agent Performance
        </a>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: ()=>void; children: ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", border: "none", borderBottom: active ? "2px solid #111827" : "2px solid transparent",
      background: "transparent", fontSize: 13, fontWeight: 600,
      color: active ? "#111827" : "#6b7280", cursor: "pointer",
    }}>{children}</button>
  );
}

// Top-level portfolio bar — total live + per-RAG bucket counts/ARR and the
// At-Risk combined view (Red + Amber). Each non-total card shows percentage
// share by both count and ARR so the operator knows which lens to trust.
type OverallBucket = { count: number; arr: number; pctCount: number; pctArr: number };
type OverallStats = {
  totalCount: number; totalArr: number;
  red: OverallBucket; amber: OverallBucket; green: OverallBucket; atRisk: OverallBucket;
};
// RAG threshold descriptions surfaced on each card via an info icon. Single
// source of truth — sits next to ROI_GREEN / ROI_AMBER above so the copy and
// the actual thresholds can't drift apart.
const RAG_TOOLTIPS = {
  Red:   `ROI < ${ROI_AMBER}× · or no recent Metabase activity · or MRR unknown`,
  Amber: `${ROI_AMBER}× ≤ ROI < ${ROI_GREEN}×`,
  Green: `ROI ≥ ${ROI_GREEN}× · (or any Metabase activity for accounts in their first 7 days post-live)`,
  "Total Live": "Every Live (rooftop × agent) on the funnel sheet. Counts include Red, Amber, and Green.",
  "At Risk (R+A)": "Red + Amber combined. The portfolio slice that needs CSM / Eng / Product attention.",
};

function InfoIcon({ tooltip, fg }: { tooltip: string; fg: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", marginLeft: 4 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
    >
      <span
        aria-label={tooltip}
        role="img"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 14, height: 14,
          borderRadius: "50%",
          border: `1px solid ${fg}`,
          color: fg,
          fontSize: 9, fontWeight: 700, fontStyle: "italic", lineHeight: 1,
          cursor: "help",
          opacity: open ? 1 : 0.6,
          transition: "opacity 120ms ease",
          background: open ? fg : "transparent",
        }}
      >
        <span style={{ color: open ? "#fff" : fg, transition: "color 120ms ease" }}>i</span>
      </span>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: 220,
            maxWidth: 320,
            width: "max-content",
            padding: "8px 10px",
            background: "#111827",
            color: "#ffffff",
            fontSize: 11,
            fontWeight: 500,
            fontStyle: "normal",
            textTransform: "none",
            letterSpacing: 0,
            lineHeight: 1.45,
            borderRadius: 6,
            boxShadow: "0 6px 16px rgba(15,23,42,0.2), 0 1px 3px rgba(15,23,42,0.12)",
            whiteSpace: "normal",
            zIndex: 50,
            pointerEvents: "none",
          }}
        >
          <span style={{
            position: "absolute",
            top: -4, left: 8,
            width: 8, height: 8,
            background: "#111827",
            transform: "rotate(45deg)",
          }} />
          {tooltip}
        </span>
      )}
    </span>
  );
}

function OverallRagBar({ overall }: { overall: OverallStats }) {
  const Card = ({ label, count, arr, pctCount, pctArr, accent, bg, fg }: {
    label: string; count: number; arr: number; pctCount?: number; pctArr?: number;
    accent: string; bg: string; fg: string;
  }) => {
    const tooltip = RAG_TOOLTIPS[label as keyof typeof RAG_TOOLTIPS];
    return (
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, borderLeft: `3px solid ${accent}` }}>
        <div style={{ display: "inline-flex", alignItems: "center", fontSize: 11, color: fg, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, background: bg, padding: "2px 8px", borderRadius: 999 }}>
          {label}
          {tooltip && <InfoIcon tooltip={tooltip} fg={fg} />}
        </div>
        <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#111827", lineHeight: 1 }}>{count}</div>
            {pctCount != null && <div style={{ fontSize: 11, color: "#6b7280" }}>{pctCount.toFixed(1)}% of agents</div>}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{fmtMoney(arr)}</div>
            {pctArr != null && <div style={{ fontSize: 11, color: "#6b7280" }}>{pctArr.toFixed(1)}% of ARR</div>}
          </div>
        </div>
      </div>
    );
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12, marginBottom: 14 }}>
      <Card label="Total Live"
            count={overall.totalCount} arr={overall.totalArr}
            accent="#111827" bg="#f3f4f6" fg="#374151" />
      <Card label="Red"
            count={overall.red.count}   arr={overall.red.arr}
            pctCount={overall.red.pctCount} pctArr={overall.red.pctArr}
            accent={RAG_COLORS.red.dot} bg={RAG_COLORS.red.bg} fg={RAG_COLORS.red.fg} />
      <Card label="Amber"
            count={overall.amber.count} arr={overall.amber.arr}
            pctCount={overall.amber.pctCount} pctArr={overall.amber.pctArr}
            accent={RAG_COLORS.amber.dot} bg={RAG_COLORS.amber.bg} fg={RAG_COLORS.amber.fg} />
      <Card label="Green"
            count={overall.green.count} arr={overall.green.arr}
            pctCount={overall.green.pctCount} pctArr={overall.green.pctArr}
            accent={RAG_COLORS.green.dot} bg={RAG_COLORS.green.bg} fg={RAG_COLORS.green.fg} />
      <Card label="At Risk (R+A)"
            count={overall.atRisk.count} arr={overall.atRisk.arr}
            pctCount={overall.atRisk.pctCount} pctArr={overall.atRisk.pctArr}
            accent="#dc2626" bg="#fef2f2" fg="#991b1b" />
    </div>
  );
}

function AgentKpiCards({ agentByRag }:
  { agentByRag: Record<AgentType, Record<RagStatus, { count:number; arr:number }>> }) {
  const order: AgentType[] = ["Sales Inbound","Service Inbound","Sales Outbound","Service Outbound"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 18 }}>
      {order.map(a => {
        const row = agentByRag[a];
        const total = row.red.count + row.amber.count + row.green.count;
        const notGreenArr = row.red.arr + row.amber.arr;
        return (
          <div key={a} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{AGENT_LABELS[a]}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>{total} live</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {(["red","amber","green"] as RagStatus[]).map(r => (
                <div key={r} style={{ background: RAG_COLORS[r].bg, borderRadius: 8, padding: "6px 8px" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: RAG_COLORS[r].fg, textTransform: "uppercase", letterSpacing: 0.4 }}>{r}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: RAG_COLORS[r].fg, lineHeight: 1.1 }}>{row[r].count}</div>
                  <div style={{ fontSize: 10, color: RAG_COLORS[r].fg, opacity: 0.85 }}>{fmtMoney(row[r].arr)} ARR</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 8 }}>
              Not Green: <strong style={{ color: "#111827" }}>{row.red.count + row.amber.count}</strong> ·
              {" "}ARR at risk: <strong style={{ color: "#dc2626" }}>{fmtMoney(notGreenArr)}</strong>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OverviewView({ accounts, state, onOpen }: {
  accounts: Account[];
  state: Record<string, AccountState>;
  onOpen:(k:string)=>void;
}) {
  const topNotGreen = accounts
    .filter(a => a.rag !== "green")
    .sort((a,b) => (b.arr ?? 0) - (a.arr ?? 0))
    .slice(0, 8);
  return (
    <>
      <SectionTitle>Top not-green accounts by $ ARR at risk</SectionTitle>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 0, overflow: "hidden" }}>
        {topNotGreen.map(a => {
          const tasks = state[a.key]?.tasks ?? [];
          return (
            <button key={a.key} onClick={()=>onOpen(a.key)} style={{ ...Sx.topRow, alignItems: "flex-start" }}>
              <div style={{ flex: "0 0 88px", paddingTop: 2 }}><RagPill rag={a.rag} /></div>
              <div style={{ flex: "0 0 220px", minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.rooftopName}</div>
                <div style={{ fontSize: 11, color: "#6b7280" }}>{AGENT_LABELS[a.agentType]}</div>
              </div>
              <div style={{ flex: "0 0 130px", paddingTop: 2 }}><CohortPill cohort={a.cohort} daysLive={a.daysLive} /></div>
              <div style={{ flex: "0 0 110px", textAlign: "right", fontWeight: 700, color: "#111827", paddingTop: 2 }}>{fmtMoney(a.arr)} ARR</div>
              <div style={{ flex: "0 0 80px", textAlign: "right", paddingTop: 2 }}><RoiPill roi={a.roi} /></div>
              <div style={{ flex: "1 1 320px", minWidth: 220, paddingLeft: 8, borderLeft: "1px solid #f3f4f6" }}>
                <NextStepsCell tasks={tasks} compact />
              </div>
            </button>
          );
        })}
        {topNotGreen.length === 0 && (
          <div style={{ padding: 12, color: "#6b7280", fontSize: 13 }}>Every Live account is Green. 🎉</div>
        )}
      </div>
    </>
  );
}

function CohortDefCard({ cohort, range, purpose, ragRule }: { cohort: Cohort; range: string; purpose: string; ragRule: string }) {
  const c = COHORT_COLORS[cohort];
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ background: c.bg, color: c.fg, fontWeight: 700, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>{cohort}</span>
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>{range}</span>
      </div>
      <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.45, marginBottom: 6 }}>{purpose}</div>
      <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.45, borderTop: "1px solid #f3f4f6", paddingTop: 6 }}>
        <strong style={{ color: "#374151" }}>RAG rule:</strong> {ragRule}
      </div>
    </div>
  );
}

// One small table per agent — rows are cohorts, columns are RAG.
function AgentCohortTable({ agent, data }: { agent: AgentType; data: Record<Cohort, Record<RagStatus, { count:number; arr:number }>> }) {
  const cohorts: Cohort[] = ["Activation", "Ramp", "Mature"];
  const rags: RagStatus[] = ["red", "amber", "green"];
  const total = cohorts.reduce((s, c) =>
    s + rags.reduce((ss, r) => ss + data[c][r].count, 0)
  , 0);
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700, color: "#111827", fontSize: 13 }}>{AGENT_LABELS[agent]}</div>
        <div style={{ fontSize: 11, color: "#6b7280" }}>{total} live</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ ...Sx.matrixHeadCell, padding: "8px 10px" }}>Cohort</th>
            {rags.map(r => (
              <th key={r} style={{ ...Sx.matrixHeadCell, textAlign: "center", padding: "8px 10px", background: RAG_COLORS[r].bg, color: RAG_COLORS[r].fg }}>
                {r.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map(c => (
            <tr key={c}>
              <td style={{ padding: "8px 10px", borderBottom: "1px solid #f3f4f6", background: COHORT_COLORS[c].bg, color: COHORT_COLORS[c].fg, fontWeight: 600 }}>{c}</td>
              {rags.map(r => (
                <td key={r} style={{ padding: "8px 10px", borderBottom: "1px solid #f3f4f6", textAlign: "center" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", lineHeight: 1.1 }}>{data[c][r].count}</div>
                  <div style={{ fontSize: 10, color: "#6b7280" }}>{fmtMoney(data[c][r].arr)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Shared "Actually Live" segmented filter — All / Live / Not live. Used on the
// Account List and Path to Green tabs so the same lens works on both.
function LiveFilter({ value, onChange }: {
  value: "all" | "live" | "notlive"; onChange: (v: "all" | "live" | "notlive") => void;
}) {
  const opts: { v: "all" | "live" | "notlive"; label: string }[] = [
    { v: "all", label: "All" },
    { v: "live", label: "Live" },
    { v: "notlive", label: "Not live" },
  ];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Actually Live</span>
      <div style={{ display: "inline-flex", border: "1px solid #d1d5db", borderRadius: 8, overflow: "hidden" }}>
        {opts.map((o, i) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            style={{
              padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none",
              borderLeft: i === 0 ? "none" : "1px solid #e5e7eb",
              background: value === o.v ? "#16a34a" : "#fff",
              color: value === o.v ? "#fff" : "#374151",
            }}
          >{o.label}</button>
        ))}
      </div>
    </div>
  );
}

// Shared "Starred only" toggle. A filled gold star = active.
function StarToggle({ active, onChange }: { active: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      title={active ? "Showing starred only — click to show all" : "Show starred rooftops only"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
        borderRadius: 8, border: `1px solid ${active ? "#f59e0b" : "#d1d5db"}`,
        background: active ? "#fffbeb" : "#fff", color: active ? "#b45309" : "#374151",
        fontSize: 12, fontWeight: 600, cursor: "pointer",
      }}
    >
      <span style={{ color: active ? "#f59e0b" : "#9ca3af", fontSize: 14 }}>{active ? "★" : "☆"}</span>
      Starred
    </button>
  );
}

function Filters(props: {
  ragFilter: Set<RagStatus>; setRagFilter: (s:Set<RagStatus>)=>void;
  cohortFilter: Set<Cohort>; setCohortFilter: (s:Set<Cohort>)=>void;
  agentFilter: Set<AgentType>; setAgentFilter: (s:Set<AgentType>)=>void;
  csmFilter: Set<string>; setCsmFilter: (s:Set<string>)=>void;
  csmOptions: [string, string][];
  liveFilter: "all" | "live" | "notlive"; setLiveFilter: (v:"all"|"live"|"notlive")=>void;
  starOnly: boolean; setStarOnly: (v:boolean)=>void;
  search: string; setSearch: (s:string)=>void;
  sortKey: "priority"|"mrr"|"roi"|"daysLive"|"name"; setSortKey: (k:"priority"|"mrr"|"roi"|"daysLive"|"name")=>void;
  showSort: boolean;
}) {
  const toggle = <T,>(set: Set<T>, v: T, setter: (s: Set<T>)=>void) => {
    const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n);
  };
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", marginBottom: 14, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
      <ChipGroup<RagStatus> label="RAG" options={["red","amber","green"]} selected={props.ragFilter} onToggle={v=>toggle(props.ragFilter, v, props.setRagFilter)} render={v=>v.toUpperCase()} palette={v=>CHIP_PALETTE_RAG[v]} />
      <div style={Sx.divider} />
      <ChipGroup label="Cohort" options={["Activation","Ramp","Mature","Unknown"] as Cohort[]} selected={props.cohortFilter} onToggle={(v)=>toggle(props.cohortFilter, v, props.setCohortFilter)} />
      <div style={Sx.divider} />
      <ChipGroup label="Agent" options={["Sales Inbound","Service Inbound","Sales Outbound","Service Outbound"] as AgentType[]} selected={props.agentFilter} onToggle={(v)=>toggle(props.agentFilter, v, props.setAgentFilter)} render={(v)=>AGENT_LABELS[v]} />
      {props.csmOptions.length > 0 && (
        <>
          <div style={Sx.divider} />
          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>CSM</span>
            <select
              multiple={false}
              value={Array.from(props.csmFilter)[0] ?? ""}
              onChange={e => {
                const v = e.target.value;
                if (!v) props.setCsmFilter(new Set());
                else props.setCsmFilter(new Set([v]));
              }}
              style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, background: "#fff", maxWidth: 200 }}
            >
              <option value="">All CSMs</option>
              {props.csmOptions.map(([email, name]) => (
                <option key={email} value={email}>{name}</option>
              ))}
            </select>
          </div>
        </>
      )}
      <div style={Sx.divider} />
      <LiveFilter value={props.liveFilter} onChange={props.setLiveFilter} />
      <StarToggle active={props.starOnly} onChange={props.setStarOnly} />
      <input
        type="search" placeholder="Search rooftop / enterprise"
        value={props.search} onChange={e=>props.setSearch(e.target.value)}
        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, minWidth: 220 }}
      />
      {props.showSort && (
        <>
          <div style={Sx.divider} />
          <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Sort</label>
          <select value={props.sortKey} onChange={e=>props.setSortKey(e.target.value as any)} style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13 }}>
            <option value="priority">Priority (Red → Amber, Mature first, $ at risk)</option>
            <option value="mrr">MRR</option>
            <option value="roi">ROI</option>
            <option value="daysLive">Days since live</option>
            <option value="name">Rooftop name</option>
          </select>
        </>
      )}
    </div>
  );
}

// ChipGroup — modern token-style chips.
// • 8px corners (still pill-shaped but softer than fully-rounded)
// • 28px min height, generous tap target
// • Semantic tinting via `palette` prop — RAG/Status chips show their meaning
//   when selected (red wash for Red, amber for Amber, etc.) instead of a
//   uniform black fill
// • 150ms ease transitions on every state change
// • Subtle hover affordance for unselected chips
type ChipTone = { bg: string; fg: string; border: string };
function ChipGroup<T extends string>({ label, options, selected, onToggle, render, palette }:
  { label: string; options: T[]; selected: Set<T>; onToggle: (v:T)=>void;
    render?: (v:T)=>string; palette?: (v:T)=>ChipTone | undefined }) {
  // Default selected tone — soft charcoal with light shadow, not a hard black slab.
  const defaultOn: ChipTone = { bg: "#111827", fg: "#ffffff", border: "#111827" };
  return (
    <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <span style={{
        fontSize: 10, color: "#6b7280", fontWeight: 700,
        textTransform: "uppercase", letterSpacing: 0.6,
      }}>{label}</span>
      <div style={{ display: "inline-flex", gap: 4 }}>
        {options.map(v => {
          const on   = selected.has(v);
          const tone = on ? (palette?.(v) ?? defaultOn) : null;
          const baseStyle: CSSProperties = {
            padding: "5px 10px",
            minHeight: 26,
            borderRadius: 7,
            fontSize: 11.5, fontWeight: 600,
            fontFamily: "inherit",
            letterSpacing: 0.1,
            cursor: "pointer",
            transition: "background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease",
            outline: "none",
            lineHeight: 1.3,
            whiteSpace: "nowrap",
          };
          const onStyle: CSSProperties = on
            ? {
                background: tone!.bg,
                color: tone!.fg,
                border: `1px solid ${tone!.border}`,
                boxShadow: palette ? "none" : "0 1px 2px rgba(17,24,39,0.12), inset 0 1px 0 rgba(255,255,255,0.06)",
              }
            : {
                background: "#ffffff",
                color: "#475569",
                border: "1px solid #e5e7eb",
              };
          return (
            <button
              key={v}
              onClick={() => onToggle(v)}
              style={{ ...baseStyle, ...onStyle }}
              onMouseEnter={e => {
                if (on) return;
                e.currentTarget.style.background   = "#f8fafc";
                e.currentTarget.style.borderColor  = "#cbd5e1";
                e.currentTarget.style.color        = "#1f2937";
              }}
              onMouseLeave={e => {
                if (on) return;
                e.currentTarget.style.background   = "#ffffff";
                e.currentTarget.style.borderColor  = "#e5e7eb";
                e.currentTarget.style.color        = "#475569";
              }}
            >{render ? render(v) : v}</button>
          );
        })}
      </div>
    </div>
  );
}

// Semantic palettes for RAG and Task Status. Used in the filter chips so the
// selected state carries meaning at a glance — Red selected = red wash, not
// a generic black-fill that looks identical to every other selected chip.
const CHIP_PALETTE_RAG: Record<RagStatus, ChipTone> = {
  red:   { bg: "#fee2e2", fg: "#991b1b", border: "#fca5a5" },
  amber: { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d" },
  green: { bg: "#dcfce7", fg: "#166534", border: "#86efac" },
};
const CHIP_PALETTE_STATUS: Record<TaskStatus, ChipTone> = {
  "Open":        { bg: "#f3f4f6", fg: "#374151", border: "#d1d5db" },
  "In Progress": { bg: "#e0f2fe", fg: "#075985", border: "#7dd3fc" },
  "Blocked":     { bg: "#fee2e2", fg: "#991b1b", border: "#fca5a5" },
  "Done":        { bg: "#dcfce7", fg: "#166534", border: "#86efac" },
};

function AccountTable({ rows, state, rooftopStack, onOpen, onToggleActualLive, onToggleStar }: {
  rows: Account[];
  state: Record<string, AccountState>;
  rooftopStack: Record<string, RooftopStack>;
  onOpen:(k:string)=>void;
  onToggleActualLive: (accountKey: string, value: boolean) => void;
  onToggleStar: (accountKey: string, value: boolean) => void;
}) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: 34 }}  />  {/* Star */}
          <col style={{ width: 50 }}  />  {/* Actual Live (checkbox) */}
          <col style={{ width: 210 }} />  {/* Rooftop (enterprise name wraps to 2 lines via line-clamp) */}
          <col style={{ width: 72 }}  />  {/* Agent */}
          <col style={{ width: 78 }}  />  {/* MRR */}
          <col style={{ width: 100 }} />  {/* CSM */}
          <col style={{ width: 200 }} />  {/* Tech stack — CRM / Scheduler / DMS stacked */}
          <col style={{ width: 72 }}  />  {/* ROI */}
          <col style={{ width: 92 }}  />  {/* Cohort */}
          <col style={{ width: 68 }}  />  {/* 30d Leads */}
          <col style={{ width: 68 }}  />  {/* 30d Appts */}
          <col style={{ minWidth: 220 }} />  {/* Next Step — flexes, with floor */}
        </colgroup>
        <thead style={{ background: "#f9fafb" }}>
          <tr>
            <Th><span title="Star a rooftop to focus on it — highlights the row and filters via the ★ Starred toggle.">★</span></Th>
            <Th><span title="Actually Live — drives every aggregate widget on Overview / By Cohort / Email Report. Toggle per row.">Live</span></Th>
            <Th>Rooftop</Th>
            <Th>Agent</Th>
            <Th right>MRR</Th>
            <Th>CSM</Th>
            <Th>Tech stack</Th>
            <Th right>ROI</Th>
            <Th>Cohort</Th>
            <Th right>30d Leads</Th>
            <Th right>30d Appts</Th>
            <Th>Next Step · Owner · ETA</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(a => {
            const s = state[a.key] ?? EMPTY_STATE;
            return (
              <tr
                key={a.key}
                onClick={()=>onOpen(a.key)}
                style={{
                  ...Sx.tr, verticalAlign: "top",
                  background: s.starred ? "#fffdf5" : undefined,
                  boxShadow: s.starred ? "inset 3px 0 0 #f59e0b" : undefined,
                }}
              >
                <Td>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); onToggleStar(a.key, !s.starred); }}
                    title={s.starred ? "Starred — click to unstar" : "Star this rooftop to focus on it"}
                    style={{ border: "none", background: "transparent", cursor: "pointer", padding: "4px 2px", fontSize: 16, lineHeight: 1, color: s.starred ? "#f59e0b" : "#d1d5db" }}
                  >{s.starred ? "★" : "☆"}</button>
                </Td>
                <Td>
                  <label
                    onClick={e => e.stopPropagation()}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "100%", cursor: "pointer", padding: "4px 0" }}
                    title={s.actualLive ? "Counted in aggregate widgets. Untick to exclude." : "Excluded from aggregate widgets. Tick to include."}
                  >
                    <input
                      type="checkbox"
                      checked={s.actualLive}
                      onChange={e => onToggleActualLive(a.key, e.target.checked)}
                      style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#16a34a" }}
                    />
                  </label>
                </Td>
                <Td>
                  <div style={Sx.cellTruncate}>
                    <div style={{ fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.rooftopName}>{a.rooftopName}</div>
                    <div
                      title={a.enterpriseName}
                      style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                    >{a.enterpriseName}</div>
                  </div>
                </Td>
                <Td>{AGENT_LABELS[a.agentType]}</Td>
                <Td right>{fmtMoney(a.mrr)}</Td>
                <Td>
                  {(() => {
                    const eff = effectiveCsm(a, s);
                    const isOverride = !!s.accountDri?.trim();
                    return eff.name
                      ? <span title={eff.email ?? ""} style={{ color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                          {eff.name}{isOverride && <span style={{ marginLeft: 4, fontSize: 10, color: "#6b7280" }}>✎</span>}
                        </span>
                      : <span style={{ color: "#9ca3af" }}>—</span>;
                  })()}
                </Td>
                {(() => {
                  const stack = rooftopStack[rooftopKeyFromAccountKey(a.key)] ?? EMPTY_ROOFTOP_STACK;
                  // CRM / Scheduler / DMS stacked in one column to save width.
                  // Names wrap (no truncation) so full vendor names always show;
                  // the row height grows to fit.
                  const line = (label: string, value: string) => (
                    <div style={{ display: "flex", gap: 6, lineHeight: 1.3 }}>
                      <span style={{ flexShrink: 0, width: 64, fontSize: 10, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, paddingTop: 1 }}>{label}</span>
                      <span style={{ color: value ? "#111827" : "#9ca3af", wordBreak: "break-word" }}>{value || "—"}</span>
                    </div>
                  );
                  return (
                    <Td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {line("CRM", stack.crmName)}
                        {line("Sched", stack.serviceSchedulerName)}
                        {line("DMS", stack.dmsName)}
                      </div>
                    </Td>
                  );
                })()}
                <Td right><RoiPill roi={a.roi} /></Td>
                <Td><CohortPill cohort={a.cohort} daysLive={a.daysLive} /></Td>
                <Td right>{a.touched.toLocaleString()}</Td>
                <Td right>{a.appts.toLocaleString()}</Td>
                <Td><NextStepsCell tasks={s.tasks} /></Td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={12} style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>No accounts match current filters.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CohortView({ agentByCohort }: {
  agentByCohort: Record<AgentType, Record<Cohort, Record<RagStatus, { count:number; arr:number }>>>;
}) {
  const agents: AgentType[] = ["Sales Inbound","Service Inbound","Sales Outbound","Service Outbound"];
  return (
    <>
      <SectionTitle>Cohort definitions</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: 18 }}>
        <CohortDefCard
          cohort="Activation"
          range="0–7 days post-live"
          purpose="Just live. Signal is noisy, volume is small. Focus is on setup quality and first conversion."
          ragRule="Green if any Metabase activity, else Amber. ROI is not used to RAG."
        />
        <CohortDefCard
          cohort="Ramp"
          range="7–30 days post-live"
          purpose="Volume is meaningful. ROI signal starts to stabilise. Highest-leverage cohort to intervene."
          ragRule="Full ROI thresholds: ≥3× Green · 1.5×–3× Amber · <1.5× Red. TOFU <100 leads forces Red."
        />
        <CohortDefCard
          cohort="Mature"
          range="30+ days post-live"
          purpose="Steady state. Has had time to show value. Red/Amber here = churn risk."
          ragRule="Same ROI thresholds as Ramp. Regressions here are the highest-priority signal."
        />
      </div>

      <SectionTitle>By agent · cohort breakdown</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginBottom: 18 }}>
        {agents.map(agent => (
          <AgentCohortTable key={agent} agent={agent} data={agentByCohort[agent]} />
        ))}
      </div>
    </>
  );
}

// ─── Next Steps tab (task-centric view) ────────────────────────────────────
type TaskRow = {
  task: Task;
  account: Account;
  csmEmail: string | null;           // effective CSM (override → sheet)
  csmName: string;                   // unfurled
  dueBucket: "Overdue" | "Today" | "This Week" | "Next 30d" | "Later" | "No date";
  daysToDue: number | null;          // negative = past
  isOverdue: boolean;
  starred: boolean;                  // account starred for focus
  actualLive: boolean;               // account flagged actually live
};
type TaskSortKey = "priority" | "due" | "created" | "arr";
type TaskGroupKey = "none" | "owner" | "function" | "status" | "rag" | "csm" | "rooftop" | "task" | "agent";
type DueBucket = TaskRow["dueBucket"];

function classifyDue(due: string | null): { bucket: DueBucket; daysToDue: number | null } {
  if (!due) return { bucket: "No date", daysToDue: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
  if (!m) return { bucket: "No date", daysToDue: null };
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dt = Math.floor((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (dt < 0)  return { bucket: "Overdue", daysToDue: dt };
  if (dt === 0) return { bucket: "Today", daysToDue: dt };
  if (dt <= 7)  return { bucket: "This Week", daysToDue: dt };
  if (dt <= 30) return { bucket: "Next 30d", daysToDue: dt };
  return { bucket: "Later", daysToDue: dt };
}

function NextStepsView({ accounts, state, onOpen, onToggleStar }: {
  accounts: Account[]; state: Record<string, AccountState>; onOpen: (k: string)=>void;
  onToggleStar: (accountKey: string, value: boolean) => void;
}) {
  // Filters
  const [statusFilter, setStatusFilter] = useState<Set<TaskStatus>>(new Set(["Open","In Progress","Blocked"]));
  const [liveFilter,   setLiveFilter]   = useState<"all" | "live" | "notlive">("all");
  const [starOnly,     setStarOnly]     = useState(false);
  const [funcFilter,   setFuncFilter]   = useState<Set<TaskFunction>>(new Set());
  const [ragFilter,    setRagFilter]    = useState<Set<RagStatus>>(new Set());
  const [agentFilter,  setAgentFilter]  = useState<Set<AgentType>>(new Set());
  const [dueFilter,    setDueFilter]    = useState<Set<DueBucket>>(new Set());
  const [ownerFilter,  setOwnerFilter]  = useState<string>("");   // task DRI email
  const [csmFilter,    setCsmFilter]    = useState<string>("");   // account CSM email
  const [search,       setSearch]       = useState("");
  const [sortKey,      setSortKey]      = useState<TaskSortKey>("priority");
  const [groupKey,     setGroupKey]     = useState<TaskGroupKey>("owner");
  // Notion-style collapsed-by-default behaviour is annoying for small lists;
  // we default to all-expanded. Groups the user collapses are remembered in
  // `collapsedGroups`. `expandedGroups` is a *separate* set used only for the
  // aggregated-task-row "show the underlying rooftops" toggle.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroupCollapsed = (k: string) => {
    setCollapsedGroups(prev => {
      const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n;
    });
  };
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroupExpanded = (k: string) => {
    setExpandedGroups(prev => {
      const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n;
    });
  };

  // Flatten — one row per (account × task)
  const allRows: TaskRow[] = useMemo(() => {
    const out: TaskRow[] = [];
    const accByKey = new Map(accounts.map(a => [a.key, a]));
    for (const [accountKey, s] of Object.entries(state)) {
      const account = accByKey.get(accountKey);
      if (!account) continue;
      const eff = effectiveCsm(account, s);
      for (const task of s.tasks ?? []) {
        const { bucket, daysToDue } = classifyDue(task.dueDate);
        out.push({
          task, account,
          csmEmail: eff.email, csmName: eff.name,
          dueBucket: bucket,
          daysToDue,
          isOverdue: bucket === "Overdue",
          starred: s.starred === true,
          actualLive: s.actualLive === true,
        });
      }
    }
    return out;
  }, [accounts, state]);

  // Unique option lists
  const taskOwners = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRows) {
      const e = r.task.taskDri?.trim();
      if (e && !m.has(e)) m.set(e, displayNameFromEmail(e) || e);
    }
    return Array.from(m.entries()).sort(([,a],[,b]) => a.localeCompare(b));
  }, [allRows]);

  const accountCsms = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRows) {
      if (r.csmEmail && !m.has(r.csmEmail)) m.set(r.csmEmail, r.csmName || r.csmEmail);
    }
    return Array.from(m.entries()).sort(([,a],[,b]) => a.localeCompare(b));
  }, [allRows]);

  // Filter + sort
  const filtered = useMemo(() => {
    let rows = allRows;
    if (statusFilter.size) rows = rows.filter(r => statusFilter.has(r.task.status));
    if (funcFilter.size)   rows = rows.filter(r => funcFilter.has(r.task.function));
    if (ragFilter.size)    rows = rows.filter(r => ragFilter.has(r.account.rag));
    if (agentFilter.size)  rows = rows.filter(r => agentFilter.has(r.account.agentType));
    if (dueFilter.size)    rows = rows.filter(r => dueFilter.has(r.dueBucket));
    if (liveFilter !== "all") rows = rows.filter(r => liveFilter === "live" ? r.actualLive : !r.actualLive);
    if (starOnly)          rows = rows.filter(r => r.starred);
    if (ownerFilter)       rows = rows.filter(r => r.task.taskDri === ownerFilter);
    if (csmFilter)         rows = rows.filter(r => r.csmEmail === csmFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(r =>
        r.task.title.toLowerCase().includes(q) ||
        r.account.rooftopName.toLowerCase().includes(q) ||
        r.account.enterpriseName.toLowerCase().includes(q)
      );
    }
    const ragRank: Record<RagStatus, number> = { red: 3, amber: 2, green: 1 };
    const sorted = [...rows].sort((a, b) => {
      if (sortKey === "priority") {
        // Overdue first, then by account RAG, then by days-to-due asc, then by ARR desc
        if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
        const r = ragRank[b.account.rag] - ragRank[a.account.rag]; if (r) return r;
        const da = a.daysToDue == null ?  9999 : a.daysToDue;
        const db = b.daysToDue == null ?  9999 : b.daysToDue;
        if (da !== db) return da - db;
        return (b.account.arr ?? 0) - (a.account.arr ?? 0);
      }
      if (sortKey === "due") {
        const da = a.daysToDue == null ?  9999 : a.daysToDue;
        const db = b.daysToDue == null ?  9999 : b.daysToDue;
        return da - db;
      }
      if (sortKey === "created") return b.task.createdAt.localeCompare(a.task.createdAt);
      if (sortKey === "arr")     return (b.account.arr ?? 0) - (a.account.arr ?? 0);
      return 0;
    });
    return sorted;
  }, [allRows, statusFilter, funcFilter, ragFilter, agentFilter, dueFilter, liveFilter, starOnly, ownerFilter, csmFilter, search, sortKey]);

  // Group
  const groupLabel = (r: TaskRow): string => {
    if (groupKey === "none")     return "All tasks";
    if (groupKey === "owner")    return r.task.taskDri ? (displayNameFromEmail(r.task.taskDri) || r.task.taskDri) : "(no owner)";
    if (groupKey === "function") return r.task.function;
    if (groupKey === "status")   return r.task.status;
    if (groupKey === "rag")      return r.account.rag.toUpperCase();
    if (groupKey === "csm")      return r.csmName || r.csmEmail || "(no CSM)";
    if (groupKey === "rooftop")  return r.account.rooftopName;
    if (groupKey === "task")     return r.task.title || "(untitled)";
    if (groupKey === "agent")    return AGENT_LABELS[r.account.agentType];
    return "";
  };
  const grouped = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const r of filtered) {
      const k = groupLabel(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    const entries = Array.from(m.entries());
    // Sort the groups themselves by the active sortKey, not alphabetically.
    // Inside each group, rows are already in the right order (filtered + sorted).
    const sumArr = (rows: TaskRow[]) => rows.reduce((s, r) => s + (r.account.arr ?? 0), 0);
    const overdueCount = (rows: TaskRow[]) => rows.filter(r => r.isOverdue).length;
    const earliestDue  = (rows: TaskRow[]) => {
      let best = Infinity;
      for (const r of rows) if (r.daysToDue != null && r.daysToDue < best) best = r.daysToDue;
      return best;
    };
    const latestCreated = (rows: TaskRow[]) => rows.reduce((m, r) => r.task.createdAt > m ? r.task.createdAt : m, "");
    const ragRank: Record<RagStatus, number> = { red: 3, amber: 2, green: 1 };
    const worstRag = (rows: TaskRow[]) => Math.max(...rows.map(r => ragRank[r.account.rag]));

    entries.sort(([nameA, rowsA], [nameB, rowsB]) => {
      if (sortKey === "arr") return sumArr(rowsB) - sumArr(rowsA);
      if (sortKey === "due") return earliestDue(rowsA) - earliestDue(rowsB);   // ascending
      if (sortKey === "created") return latestCreated(rowsB).localeCompare(latestCreated(rowsA));
      // priority (default): groups with overdue tasks first, then highest worst-RAG,
      // then biggest ARR. Same heuristic as the row-level priority sort.
      const od = overdueCount(rowsB) - overdueCount(rowsA);                    if (od) return od;
      const wr = worstRag(rowsB) - worstRag(rowsA);                            if (wr) return wr;
      const ar = sumArr(rowsB) - sumArr(rowsA);                                if (ar) return ar;
      return nameA.localeCompare(nameB);
    });
    return entries;
  }, [filtered, groupKey, sortKey]);

  // ── Render ─────────────────────────────────────────────────────────────
  const toggleSet = <T,>(set: Set<T>, v: T, setter: (s: Set<T>)=>void) => {
    const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n);
  };
  return (
    <>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 14px", marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
        <ChipGroup<TaskStatus> label="Status" options={["Open","In Progress","Blocked","Done"]} selected={statusFilter} onToggle={v=>toggleSet(statusFilter, v, setStatusFilter)} palette={v=>CHIP_PALETTE_STATUS[v]} />
        <div style={Sx.divider} />
        <ChipGroup<TaskFunction> label="Function" options={[...TASK_FUNCTIONS]} selected={funcFilter} onToggle={v=>toggleSet(funcFilter, v, setFuncFilter)} />
        <div style={Sx.divider} />
        <ChipGroup<RagStatus> label="Account RAG" options={["red","amber","green"]} selected={ragFilter} onToggle={v=>toggleSet(ragFilter, v, setRagFilter)} render={v=>v.toUpperCase()} palette={v=>CHIP_PALETTE_RAG[v]} />
        <div style={Sx.divider} />
        <ChipGroup<AgentType> label="Agent" options={["Sales Inbound","Service Inbound","Sales Outbound","Service Outbound"]} selected={agentFilter} onToggle={v=>toggleSet(agentFilter, v, setAgentFilter)} render={v=>AGENT_LABELS[v]} />
        <div style={Sx.divider} />
        <ChipGroup<DueBucket> label="Due" options={["Overdue","Today","This Week","Next 30d","Later","No date"]} selected={dueFilter} onToggle={v=>toggleSet(dueFilter, v, setDueFilter)} />
      </div>

      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 14px", marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
        <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Task Owner</span>
          <select value={ownerFilter} onChange={e=>setOwnerFilter(e.target.value)} style={Sx.select}>
            <option value="">All</option>
            {taskOwners.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
          </select>
        </div>
        <div style={Sx.divider} />
        <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Account CSM</span>
          <select value={csmFilter} onChange={e=>setCsmFilter(e.target.value)} style={Sx.select}>
            <option value="">All</option>
            {accountCsms.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
          </select>
        </div>
        <div style={Sx.divider} />
        <LiveFilter value={liveFilter} onChange={setLiveFilter} />
        <StarToggle active={starOnly} onChange={setStarOnly} />
        <div style={Sx.divider} />
        <input type="search" placeholder="Search task / rooftop"
               value={search} onChange={e=>setSearch(e.target.value)}
               style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, minWidth: 220 }} />
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 14, alignItems: "center" }}>
          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Sort</span>
            <select value={sortKey} onChange={e=>setSortKey(e.target.value as TaskSortKey)} style={Sx.select}>
              <option value="priority">Priority (overdue · RAG · ARR)</option>
              <option value="due">Due date</option>
              <option value="created">Recently added</option>
              <option value="arr">Account ARR</option>
            </select>
          </div>
          <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Group by</span>
            <select value={groupKey} onChange={e=>setGroupKey(e.target.value as TaskGroupKey)} style={Sx.select}>
              <option value="owner">Task Owner</option>
              <option value="task">Task</option>
              <option value="function">Function</option>
              <option value="agent">Agent</option>
              <option value="status">Status</option>
              <option value="rag">Account RAG</option>
              <option value="csm">Account CSM</option>
              <option value="rooftop">Rooftop</option>
              <option value="none">No grouping</option>
            </select>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          {filtered.length} task{filtered.length === 1 ? "" : "s"} ·
          {" "}{filtered.filter(r => r.isOverdue).length} overdue ·
          {" "}{filtered.filter(r => !r.task.taskDri).length} without owner ·
          {" "}{filtered.filter(r => !r.task.dueDate).length} without ETA
        </div>
        {grouped.length > 1 && (
          <div style={{ display: "inline-flex", gap: 4, fontSize: 11 }}>
            <button onClick={()=>setCollapsedGroups(new Set(grouped.map(([n]) => n)))} style={Sx.linkBtn}>Collapse all</button>
            <span style={{ color: "#d1d5db" }}>·</span>
            <button onClick={()=>setCollapsedGroups(new Set())} style={Sx.linkBtn}>Expand all</button>
          </div>
        )}
      </div>

      {grouped.length === 0 && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 24, textAlign: "center", color: "#6b7280" }}>
          No tasks match the current filters.
        </div>
      )}

      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 78 }}  />   {/* Status */}
            <col />                          {/* Task — flexes to take leftover */}
            <col style={{ width: 130 }} />   {/* Owner */}
            <col style={{ width: 80 }}  />   {/* Team */}
            <col style={{ width: 72 }}  />   {/* ETA */}
            <col style={{ width: 170 }} />   {/* Rooftop */}
            <col style={{ width: 80 }}  />   {/* Agent */}
            <col style={{ width: 70 }}  />   {/* RAG */}
            <col style={{ width: 88 }}  />   {/* ARR */}
            <col style={{ width: 96 }}  />   {/* Cohort */}
          </colgroup>
          <thead style={{ background: "#f9fafb" }}>
            <tr>
              <Th>Status</Th>
              <Th>Task</Th>
              <Th>Owner</Th>
              <Th>Team</Th>
              <Th>ETA</Th>
              <Th>Rooftop</Th>
              <Th>Agent</Th>
              <Th>RAG</Th>
              <Th right>ARR</Th>
              <Th>Cohort</Th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([groupName, rows]) => {
              const overdueCount = rows.filter(r => r.isOverdue).length;
              const noOwnerCount = rows.filter(r => !r.task.taskDri).length;
              const totalArr = rows.reduce((s, r) => s + (r.account.arr ?? 0), 0);
              const isTaskGroup = groupKey === "task";
              const isCollapsed = collapsedGroups.has(groupName);
              const isAggregatedExpanded = expandedGroups.has(groupName);
              return (
                <Fragment key={groupName}>
                  {/* Group header — colSpan over all 10 columns. */}
                  <tr>
                    <td colSpan={10} style={{ padding: 0, background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
                      <button
                        onClick={() => toggleGroupCollapsed(groupName)}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, width: "100%",
                          padding: "10px 12px",
                          border: "none", background: "transparent",
                          cursor: "pointer", textAlign: "left",
                          transition: "background-color 120ms ease",
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f3f4f6")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <span style={{
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          width: 28, height: 28, color: "#111827", fontSize: 22, lineHeight: 1,
                          transition: "transform 120ms ease",
                          transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                        }}>▾</span>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{groupName}</div>
                        <span style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", padding: "1px 7px", borderRadius: 999, fontWeight: 600 }}>{rows.length}</span>
                        <div style={{ marginLeft: "auto", fontSize: 11, color: "#6b7280" }}>
                          {overdueCount > 0 && <span style={{ color: "#dc2626", fontWeight: 600, marginRight: 8 }}>⚠ {overdueCount} overdue</span>}
                          {noOwnerCount > 0 && <span style={{ color: "#dc2626", fontWeight: 600, marginRight: 8 }}>⚠ {noOwnerCount} no owner</span>}
                          <span style={{ fontWeight: 600, color: "#374151" }}>{fmtMoney(totalArr)}</span> ARR
                        </div>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed && (
                    isTaskGroup && rows.length > 1 ? (
                      <Fragment>
                        <AggregatedTaskRow
                          rows={rows} groupName={groupName}
                          expanded={isAggregatedExpanded}
                          onToggle={() => toggleGroupExpanded(groupName)}
                        />
                        {isAggregatedExpanded && rows.map(r => <TaskRowItem key={`${r.account.key}::${r.task.id}`} row={r} onOpen={onOpen} onToggleStar={onToggleStar} />)}
                      </Fragment>
                    ) : (
                      rows.map(r => <TaskRowItem key={`${r.account.key}::${r.task.id}`} row={r} onOpen={onOpen} onToggleStar={onToggleStar} />)
                    )
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// One row per (task title) when Path-to-Green is grouped by Task and the
// same title appears across multiple rooftops. Collapses individual cells to
// aggregated values: "Multiple" / "Mixed" when values diverge across the
// group, the actual value when they agree. ARR is summed; ETA is the
// earliest set across the group. Click toggles inline expansion to reveal
// the individual underlying rows.
function AggregatedTaskRow({ rows, groupName, expanded, onToggle }: {
  rows: TaskRow[]; groupName: string; expanded: boolean; onToggle: ()=>void;
}) {
  const ragCounts: Record<RagStatus, number> = { red: 0, amber: 0, green: 0 };
  const owners = new Set<string>();
  const teams  = new Set<TaskFunction>();
  const agents = new Set<AgentType>();
  const cohorts = new Set<Cohort>();
  const statuses = new Set<TaskStatus>();
  const noOwner = rows.filter(r => !r.task.taskDri).length;
  let totalArr = 0;
  let earliestDue: string | null = null;
  for (const r of rows) {
    ragCounts[r.account.rag] += 1;
    if (r.task.taskDri) owners.add(r.task.taskDri);
    teams.add(r.task.function);
    statuses.add(r.task.status);
    agents.add(r.account.agentType);
    cohorts.add(r.account.cohort);
    totalArr += r.account.arr ?? 0;
    if (r.task.dueDate && (!earliestDue || r.task.dueDate < earliestDue)) earliestDue = r.task.dueDate;
  }
  const ownerLabel: ReactNode = owners.size === 0
    ? <span style={{ color: "#dc2626" }}>no owner</span>
    : owners.size === 1
      ? (displayNameFromEmail([...owners][0]) || [...owners][0])
      : `${owners.size} owners`;
  const teamLabel  = teams.size  === 1 ? [...teams][0]  : "Multiple";
  const agentLabel = agents.size === 1 ? AGENT_LABELS[[...agents][0]] : "Multiple";
  const cohortLabel = cohorts.size === 1 ? [...cohorts][0] : "Multiple";
  const statusLabel = statuses.size === 1 ? [...statuses][0] : "Mixed";
  return (
    <tr
      onClick={onToggle}
      style={{ cursor: "pointer", borderBottom: "1px solid #f3f4f6", background: expanded ? "#f9fafb" : "#fff", fontWeight: 500 }}
    >
      <Td>
        {statuses.size === 1
          ? <StatusPill status={[...statuses][0]} />
          : <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#f3f4f6", color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 }}>{statusLabel}</span>}
      </Td>
      <Td>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%" }}>
          <span style={{ fontSize: 14, width: 14, display: "inline-block", textAlign: "center", color: "#374151", flex: "0 0 auto" }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={groupName}>
            {groupName}
          </span>
        </div>
      </Td>
      <Td>{ownerLabel}{noOwner > 0 && owners.size > 0 && <span style={{ color: "#dc2626", fontSize: 11 }}> · {noOwner} unassigned</span>}</Td>
      <Td>{teamLabel}</Td>
      <Td>{earliestDue ? fmtEtaShort(earliestDue) : <span style={{ color: "#9ca3af" }}>—</span>}</Td>
      <Td>
        {rows.length === 1
          ? rows[0].account.rooftopName
          : <span style={{ fontWeight: 600 }}>Multiple Rooftops · {rows.length}</span>}
      </Td>
      <Td>{agentLabel}</Td>
      <Td>
        <div style={{ display: "inline-flex", gap: 3 }}>
          {(["red","amber","green"] as RagStatus[]).filter(r => ragCounts[r] > 0).map(r => (
            <span key={r} style={{
              display: "inline-flex", alignItems: "center", gap: 3,
              padding: "1px 5px", borderRadius: 999,
              background: RAG_COLORS[r].bg, color: RAG_COLORS[r].fg,
              fontSize: 10, fontWeight: 700,
            }}>{ragCounts[r]}</span>
          ))}
        </div>
      </Td>
      <Td right>{fmtMoney(totalArr)}</Td>
      <Td>{cohortLabel}</Td>
    </tr>
  );
}

// Status pill (used in TaskRowItem and AggregatedTaskRow)
const STATUS_COLORS: Record<TaskStatus, string> = {
  "Open": "#6b7280",
  "In Progress": "#0369a1",
  "Blocked": "#dc2626",
  "Done": "#16a34a",
};
function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span style={{
      display: "inline-block",
      fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
      background: "#f3f4f6", color: STATUS_COLORS[status],
      textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>{status}</span>
  );
}

function TaskRowItem({ row, onOpen, onToggleStar }: { row: TaskRow; onOpen:(k:string)=>void; onToggleStar:(k:string,v:boolean)=>void }) {
  const { task, account, isOverdue, starred } = row;
  const ownerLabel = task.taskDri ? (displayNameFromEmail(task.taskDri) || task.taskDri) : null;
  const baseBg = starred ? "#fffdf5" : "transparent";
  return (
    <tr
      onClick={()=>onOpen(account.key)}
      style={{ cursor: "pointer", borderBottom: "1px solid #f3f4f6", background: baseBg, boxShadow: starred ? "inset 3px 0 0 #f59e0b" : undefined }}
      onMouseEnter={e => (e.currentTarget.style.background = "#fafafa")}
      onMouseLeave={e => (e.currentTarget.style.background = baseBg)}
    >
      <Td><StatusPill status={task.status} /></Td>
      <Td>
        <div style={{ ...Sx.cellTruncate, fontWeight: 500, color: "#111827" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }} title={task.title}>
            {task.title || "(untitled)"}
          </span>
        </div>
      </Td>
      <Td>
        {ownerLabel
          ? <span style={{ color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }} title={task.taskDri}>{ownerLabel}</span>
          : <span style={{ color: "#dc2626", fontWeight: 600 }}>⚠ no owner</span>}
      </Td>
      <Td>{task.function}</Td>
      <Td>
        {task.dueDate
          ? <span style={{ color: isOverdue ? "#dc2626" : "#111827", fontWeight: isOverdue ? 600 : 400 }}>{fmtEtaShort(task.dueDate)}</span>
          : <span style={{ color: "#9ca3af" }}>—</span>}
      </Td>
      <Td>
        <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleStar(account.key, !starred); }}
            title={starred ? "Starred — click to unstar" : "Star this rooftop to focus on it"}
            style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1, color: starred ? "#f59e0b" : "#d1d5db", flexShrink: 0 }}
          >{starred ? "★" : "☆"}</button>
          <span style={{ color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={account.rooftopName}>
            {account.rooftopName}
          </span>
        </span>
      </Td>
      <Td>{AGENT_LABELS[account.agentType]}</Td>
      <Td><RagPill rag={account.rag} small /></Td>
      <Td right>{fmtMoney(account.arr)}</Td>
      <Td><CohortPill cohort={account.cohort} daysLive={account.daysLive} /></Td>
    </tr>
  );
}

// ─── Email Report view ─────────────────────────────────────────────────────
// Static, screenshot-friendly weekly snapshot. Two sections:
//   1. RAG split — overall + per-agent (count, % count, ARR, % ARR)
//   2. Tasks by agent — aggregated by (RAG × team × task title) across rooftops
//      so identical asks across multiple rooftops collapse into one row with
//      "# Rooftops" and summed ARR.

// Section 2 — per-CSM RAG portfolio summary.
// For each account's CSM, we tally how many of THEIR accounts (the ones with
// open tasks) are Red / Amber / Green, with ARR sums per bucket. One row per
// (CSM × rag) — rendered in the email as a rowspan-2 banded table. Accounts
// with no CSM bucket under "No CSM Mapped".
type Section2CsmRagSummary = {
  csmKey: string;           // grouping key (lowercased CSM email); "" = no CSM
  csmLabel: string;         // displayed name; "No CSM Mapped" when absent
  red:   { count: number; arr: number };
  amber: { count: number; arr: number };
  green: { count: number; arr: number };
  notGreenArr: number;      // red.arr + amber.arr, used for sort
};

function EmailReportView({ accounts, state, overall }: {
  accounts: Account[];
  state: Record<string, AccountState>;
  overall: OverallStats;
}) {
  // Section 1 — per-agent RAG split with %s within each agent
  const section1ByAgent = useMemo(() => {
    const agents: AgentType[] = ["Sales Inbound","Service Inbound","Sales Outbound","Service Outbound"];
    return agents.map(agent => {
      const inAgent = accounts.filter(a => a.agentType === agent);
      const totalCount = inAgent.length;
      const totalArr = inAgent.reduce((s, a) => s + (a.arr ?? 0), 0);
      const bucket = (r: RagStatus) => {
        const xs = inAgent.filter(a => a.rag === r);
        const count = xs.length;
        const arr = xs.reduce((s, a) => s + (a.arr ?? 0), 0);
        return {
          count, arr,
          pctCount: totalCount > 0 ? (count / totalCount) * 100 : 0,
          pctArr:   totalArr  > 0 ? (arr / totalArr) * 100 : 0,
        };
      };
      return {
        agent,
        totalCount, totalArr,
        red: bucket("red"), amber: bucket("amber"), green: bucket("green"),
      };
    });
  }, [accounts]);

  // Section 2 — per-CSM RAG summary.
  // For each account's CSM, count the UNIQUE accounts they cover that have at
  // least one open (non-Done) task, bucketed by the account's RAG. ARR sums per
  // bucket. Sorted by Not-Green ARR desc; "No CSM Mapped" pinned to bottom.
  // `accounts` is already filtered to Actually-Live by the parent — the
  // email is about live agents only, so the summary reflects that.
  const section2: Section2CsmRagSummary[] = useMemo(() => {
    const accByKey = new Map(accounts.map(a => [a.key, a]));
    // Pass 1: for each CSM, collect the distinct set of their accounts that
    // have at least one open task. An account rolls up under its own CSM
    // regardless of who owns the individual tasks.
    type CsmCollect = { csmLabel: string; accounts: Set<string> };
    const csms = new Map<string, CsmCollect>();
    for (const [accountKey, s] of Object.entries(state)) {
      const account = accByKey.get(accountKey);
      if (!account) continue;
      const hasOpenTask = (s.tasks ?? []).some(t => t.status !== "Done");
      if (!hasOpenTask) continue;
      const { email, name } = effectiveCsm(account, s);
      const csmKey = (email ?? "").trim().toLowerCase();   // "" = no CSM
      let csm = csms.get(csmKey);
      if (!csm) {
        csm = { csmLabel: name.trim() || "No CSM Mapped", accounts: new Set<string>() };
        csms.set(csmKey, csm);
      }
      csm.accounts.add(accountKey);
    }
    // Pass 2: tally R/A/G counts + ARR per CSM.
    const out: Section2CsmRagSummary[] = [];
    for (const [csmKey, csm] of csms.entries()) {
      const row: Section2CsmRagSummary = {
        csmKey,
        csmLabel: csm.csmLabel,
        red:   { count: 0, arr: 0 },
        amber: { count: 0, arr: 0 },
        green: { count: 0, arr: 0 },
        notGreenArr: 0,
      };
      for (const k of csm.accounts) {
        const a = accByKey.get(k);
        if (!a) continue;
        const arr = a.arr ?? 0;
        row[a.rag].count += 1;
        row[a.rag].arr   += arr;
      }
      row.notGreenArr = row.red.arr + row.amber.arr;
      out.push(row);
    }
    // Sort: Not-Green ARR descending; "No CSM Mapped" pinned to bottom regardless.
    out.sort((a, b) => {
      if (!a.csmKey && b.csmKey) return 1;
      if (a.csmKey && !b.csmKey) return -1;
      return b.notGreenArr - a.notGreenArr;
    });
    return out;
  }, [accounts, state]);

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });

  // Snapshot the report card to a single PNG and trigger a download. Skips
  // any element tagged `data-print-hide` (the action buttons themselves) so
  // they don't appear in the image. Renders at 2× pixel-ratio for crispness
  // on retina-class email recipients.
  const cardRef = useRef<HTMLDivElement>(null);
  const [savingImg, setSavingImg] = useState(false);

  // ── Recipients + send-via-email state ────────────────────────────────
  type Recipient = { id: string; email: string; name: string; active: boolean };
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newName,  setNewName]  = useState("");
  const [sending,  setSending]  = useState(false);
  const [sendMsg,  setSendMsg]  = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const sb = getProgramsClient();
    if (!sb) return;
    (async () => {
      const { data, error } = await sb
        .from("programs_email_recipients")
        .select("*")
        .order("added_at", { ascending: true });
      if (!error) setRecipients((data as Recipient[]) ?? []);
    })();
  }, []);

  const addRecipient = async () => {
    const email = newEmail.trim().toLowerCase();
    const name  = newName.trim();
    if (!email || !email.includes("@")) {
      setSendMsg({ ok: false, text: "Enter a valid email." });
      return;
    }
    if (recipients.some(r => r.email === email)) {
      setSendMsg({ ok: false, text: "That email is already on the list." });
      return;
    }
    const sb = getProgramsClient();
    if (!sb) { setSendMsg({ ok: false, text: "DB not configured." }); return; }
    const { data, error } = await sb
      .from("programs_email_recipients")
      .insert({ email, name, active: true })
      .select()
      .single();
    if (error || !data) { setSendMsg({ ok: false, text: error?.message ?? "Add failed" }); return; }
    setRecipients(prev => [...prev, data as Recipient]);
    setNewEmail(""); setNewName(""); setSendMsg(null);
  };
  const removeRecipient = async (id: string) => {
    const sb = getProgramsClient(); if (!sb) return;
    await sb.from("programs_email_recipients").delete().eq("id", id);
    setRecipients(prev => prev.filter(r => r.id !== id));
  };
  const toggleActive = async (id: string, active: boolean) => {
    const sb = getProgramsClient(); if (!sb) return;
    await sb.from("programs_email_recipients").update({ active }).eq("id", id);
    setRecipients(prev => prev.map(r => r.id === id ? { ...r, active } : r));
  };

  const buildPayload = () => ({
    overall, perAgent: section1ByAgent, section2,
  });

  const sendReport = async () => {
    if (sending) return;
    const active = recipients.filter(r => r.active);
    if (active.length === 0) {
      setSendMsg({ ok: false, text: "No active recipients. Add one first." });
      return;
    }
    setSending(true); setSendMsg(null);
    try {
      const res = await fetch(`${API_BASE}/api/programs/send-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: buildPayload(),
          dashboardUrl: typeof window !== "undefined" ? `${window.location.origin}/programs` : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "send failed");
      setSendMsg({ ok: true, text: `Sent to ${json.sent} recipient${json.sent === 1 ? "" : "s"} ✓` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSendMsg({ ok: false, text: msg });
    } finally { setSending(false); }
  };

  // Open the rendered HTML in a new tab without sending. Useful for debugging
  // when the email arrives empty or formatted wrong.
  const previewEmail = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/programs/send-report?preview=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: buildPayload(),
          recipientsOverride: ["preview@local"],   // satisfies recipient gate
          dashboardUrl: typeof window !== "undefined" ? `${window.location.origin}/programs` : null,
        }),
      });
      const html = await res.text();
      if (!res.ok) {
        setSendMsg({ ok: false, text: `Preview failed: ${html.slice(0, 200)}` });
        return;
      }
      const w = window.open("", "_blank");
      if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSendMsg({ ok: false, text: msg });
    }
  };

  const downloadAsImage = async () => {
    if (!cardRef.current || savingImg) return;
    setSavingImg(true);
    try {
      const node = cardRef.current;
      // Lock in pixel width before capture — html-to-image re-renders into an
      // SVG foreignObject, where `width: 100%` loses its parent-width context
      // and the layout shifts/clips. Force explicit width + neutralise the
      // auto-margin and any overflow-auto so the entire content is in frame.
      const w = node.scrollWidth;
      const h = node.scrollHeight;
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        cacheBust: true,
        width: w,
        height: h,
        style: {
          margin: "0",
          width: `${w}px`,
          maxWidth: `${w}px`,
          overflow: "visible",
          transform: "none",
          boxShadow: "none",
        },
        filter: (n) => !(n instanceof HTMLElement) || !n.hasAttribute("data-print-hide"),
      });
      const link = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      link.download = `account-programs-${stamp}.png`;
      link.href = dataUrl;
      link.click();
    } catch (e) {
      console.error("[report] image export failed:", e);
      alert("Couldn't generate image. See console for details.");
    } finally {
      setSavingImg(false);
    }
  };

  return (
    <Fragment>
    {/* ─── Recipients management (above the preview) ─── */}
    <div style={Sx.reportContainer}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#111827" }}>Email recipients</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 11, color: "#6b7280" }}>
            {recipients.filter(r => r.active).length} active · {recipients.length} total
          </div>
          <button
            onClick={sendReport}
            disabled={sending || recipients.filter(r => r.active).length === 0}
            style={{
              padding: "6px 12px", border: "1px solid #0f766e", borderRadius: 8,
              background: sending || recipients.filter(r => r.active).length === 0 ? "#94a3b8" : "#0f766e",
              fontSize: 12, fontWeight: 600,
              cursor: sending ? "wait" : (recipients.filter(r => r.active).length === 0 ? "not-allowed" : "pointer"),
              color: "#fff",
            }}
          >{sending ? "Sending…" : "Send email"}</button>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>
        Edits save to Supabase immediately. Send goes to every active recipient (first in To, rest in CC).
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
        {recipients.length === 0 && (
          <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", padding: "10px 0" }}>
            No recipients yet. Add one below.
          </div>
        )}
        {recipients.map(r => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "1px solid #f3f4f6", borderRadius: 6, background: r.active ? "#fff" : "#fafafa" }}>
            <input type="checkbox" checked={r.active} onChange={e => toggleActive(r.id, e.target.checked)} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: r.active ? "#111827" : "#9ca3af" }}>
                {r.name || displayNameFromEmail(r.email) || r.email.split("@")[0]}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>{r.email}</div>
            </div>
            <button
              onClick={() => removeRecipient(r.id)}
              title="Remove"
              style={{ border: "none", background: "transparent", color: "#dc2626", fontSize: 16, cursor: "pointer", padding: "0 6px" }}
            >×</button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Name (optional)"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, minWidth: 130 }}
        />
        <input
          type="email"
          placeholder="email@spyne.ai"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") addRecipient(); }}
          style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, minWidth: 180, flex: 1 }}
        />
        <button
          onClick={addRecipient}
          style={{ padding: "6px 12px", border: "1px solid #111827", borderRadius: 6, background: "#111827", fontSize: 12, fontWeight: 600, color: "#fff", cursor: "pointer" }}
        >+ Add</button>
      </div>

      {sendMsg && (
        <div style={{
          marginTop: 10, padding: "6px 10px", borderRadius: 6, fontSize: 12,
          background: sendMsg.ok ? "#dcfce7" : "#fee2e2",
          color:      sendMsg.ok ? "#166534" : "#991b1b",
          border: `1px solid ${sendMsg.ok ? "#bbf7d0" : "#fecaca"}`,
        }}>{sendMsg.text}</div>
      )}
    </div>

    <div style={{ height: 16 }} />

    <div data-print-target ref={cardRef} style={Sx.reportContainer}>
      {/* Print-only CSS: hide everything in the document except this card, so
          window.print() emits only the email, not the surrounding dashboard. */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          [data-print-target], [data-print-target] * { visibility: visible !important; }
          [data-print-target] {
            position: absolute !important;
            left: 0 !important; top: 0 !important;
            width: 100% !important; max-width: none !important;
            margin: 0 !important; padding: 16px !important;
            border: none !important; box-shadow: none !important; border-radius: 0 !important;
            overflow: visible !important;
          }
          [data-print-hide] { display: none !important; }
        }
      `}</style>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>Account Programs · Daily Snapshot</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{today}</div>
        </div>
        {/* Action buttons removed — Send moved to the Recipients panel above. */}
      </div>

      {/* ─── Section 1: RAG split (one banded table) ────────────────── */}
      <ReportSectionTitle index={1}>Portfolio · RAG split</ReportSectionTitle>

      <table style={{ ...Sx.reportTable, width: "auto", margin: "0 auto" }}>
        <colgroup>
          <col style={{ width: 88 }} />   {/* Section */}
          <col style={{ width: 64 }} />   {/* RAG */}
          <col style={{ width: 60 }} />   {/* Agents */}
          <col style={{ width: 44 }} />   {/* % */}
          <col style={{ width: 92 }} />   {/* ARR */}
          <col style={{ width: 44 }} />   {/* % */}
        </colgroup>
        <thead>
          <tr>
            <Th2>Section</Th2>
            <Th2>RAG</Th2>
            <Th2 right>Agents</Th2>
            <Th2 right>%</Th2>
            <Th2 right>ARR</Th2>
            <Th2 right>%</Th2>
          </tr>
        </thead>
        <tbody>
          <RagSplitBand
            label="Overall"
            totalCount={overall.totalCount} totalArr={overall.totalArr}
            red={overall.red} amber={overall.amber} green={overall.green}
            totalLabel="Total"
          />
          {section1ByAgent.map(row => (
            <RagSplitBand
              key={row.agent}
              label={AGENT_LABELS[row.agent]}
              totalCount={row.totalCount} totalArr={row.totalArr}
              red={row.red} amber={row.amber} green={row.green}
              totalLabel="Subtotal"
            />
          ))}
        </tbody>
      </table>

      {/* ─── CTA between sections ─────────────────────────────────────── */}
      <div style={{ marginTop: 22, textAlign: "center" }}>
        <a href="#tasks" style={{
          display: "inline-block",
          padding: "10px 22px",
          background: "#0f766e",
          color: "#ffffff",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 700,
          textDecoration: "none",
          letterSpacing: "0.2px",
        }}>View all tasks →</a>
      </div>

      {/* ─── Section 2: Per-CSM RAG summary (RAG buckets as columns) ──── */}
      <div style={{ marginTop: 24 }}>
        <ReportSectionTitle index={2}>CSMs - % Green</ReportSectionTitle>
      </div>

      <table style={{ ...Sx.reportTable, width: "auto", margin: "0 auto" }}>
        <colgroup>
          <col style={{ width: 140 }} />  {/* CSM (rowspan 2) */}
          <col style={{ width: 80 }} />   {/* Metric label */}
          <col style={{ width: 80 }} />   {/* Red */}
          <col style={{ width: 80 }} />   {/* Amber */}
          <col style={{ width: 80 }} />   {/* Green */}
          <col style={{ width: 72 }} />   {/* % Green */}
        </colgroup>
        <thead>
          <tr>
            <Th2>CSM</Th2>
            <Th2></Th2>
            <Th2 right style={{ background: RAG_COLORS.red.bg,   color: RAG_COLORS.red.fg }}>Red</Th2>
            <Th2 right style={{ background: RAG_COLORS.amber.bg, color: RAG_COLORS.amber.fg }}>Amber</Th2>
            <Th2 right style={{ background: RAG_COLORS.green.bg, color: RAG_COLORS.green.fg }}>Green</Th2>
            <Th2 right style={{ background: RAG_COLORS.green.bg, color: RAG_COLORS.green.fg }}>% Green</Th2>
          </tr>
        </thead>
        <tbody>
          {section2.length === 0 ? (
            <tr><td colSpan={6} style={{ padding: "10px 8px", color: "#9ca3af", fontSize: 11, textAlign: "center" }}>No CSMs with open tasks on live accounts.</td></tr>
          ) : section2.map(({ csmLabel, csmKey, red, amber, green }) => {
            const totalCount = red.count + amber.count + green.count;
            const totalArr   = red.arr   + amber.arr   + green.arr;
            const pct = (n: number, d: number) => d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
            const ownerCellStyle: CSSProperties = {
              padding: "8px 10px",
              fontWeight: 700,
              color: csmKey ? "#111827" : "#dc2626",
              fontSize: 12,
              background: "#f9fafb",
              borderTop: "1px solid #e5e7eb",
              borderRight: "1px solid #e5e7eb",
              verticalAlign: "middle",
            };
            const metricStyle: CSSProperties = {
              padding: "6px 10px", borderTop: "1px solid #f3f4f6",
              color: "#374151", fontSize: 11, fontWeight: 700,
              background: "#fafafa", borderRight: "1px solid #e5e7eb", whiteSpace: "nowrap",
            };
            const valStyle = (rag: RagStatus): CSSProperties => ({
              padding: "6px 10px", borderTop: "1px solid #f3f4f6",
              color: RAG_COLORS[rag].fg, fontSize: 11, fontWeight: 700,
              background: RAG_COLORS[rag].bg, textAlign: "right",
            });
            const pctStyle: CSSProperties = {
              padding: "6px 10px", borderTop: "1px solid #f3f4f6", borderLeft: "1px solid #e5e7eb",
              color: RAG_COLORS.green.fg, fontSize: 11, fontWeight: 800,
              background: RAG_COLORS.green.bg, textAlign: "right",
            };
            return (
              <Fragment key={csmKey || "no-csm"}>
                <tr>
                  <td rowSpan={2} style={ownerCellStyle}>{csmLabel}</td>
                  <td style={metricStyle}># Agents</td>
                  <td style={valStyle("red")}>{red.count}</td>
                  <td style={valStyle("amber")}>{amber.count}</td>
                  <td style={valStyle("green")}>{green.count}</td>
                  <td style={pctStyle}>{pct(green.count, totalCount)}</td>
                </tr>
                <tr>
                  <td style={metricStyle}>$ ARR</td>
                  <td style={valStyle("red")}>{fmtMoney(red.arr)}</td>
                  <td style={valStyle("amber")}>{fmtMoney(amber.arr)}</td>
                  <td style={valStyle("green")}>{fmtMoney(green.arr)}</td>
                  <td style={pctStyle}>{pct(green.arr, totalArr)}</td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 14, lineHeight: 1.5, textAlign: "center" }}>
        Each CSM row counts the distinct live (rooftop × agent) accounts they cover that have at least one open next-step. CSMs sorted by Not-Green ARR descending; accounts with no CSM bucket under "No CSM Mapped".
      </div>
    </div>

    </Fragment>
  );
}

function RagSplitBand({ label, totalLabel, totalCount, totalArr, red, amber, green }: {
  label: string; totalLabel: string;
  totalCount: number; totalArr: number;
  red: OverallBucket; amber: OverallBucket; green: OverallBucket;
}) {
  const fmtPct = (n: number) => `${n.toFixed(0)}%`;
  const rags: RagStatus[] = ["red","amber","green"];
  const sectionCell: CSSProperties = {
    padding: "8px 10px", fontWeight: 700, color: "#111827", fontSize: 11,
    background: "#f9fafb", borderTop: "1px solid #e5e7eb", borderRight: "1px solid #e5e7eb",
    verticalAlign: "top",
  };
  return (
    <Fragment>
      {rags.map((rag, i) => {
        const b = rag === "red" ? red : rag === "amber" ? amber : green;
        return (
          <tr key={rag}>
            {i === 0 && <td rowSpan={4} style={sectionCell}>{label}</td>}
            <td style={{ ...Sx.reportCellTight, background: RAG_COLORS[rag].bg, color: RAG_COLORS[rag].fg, fontWeight: 700 }}>
              {rag === "red" ? "Red" : rag === "amber" ? "Amber" : "Green"}
            </td>
            <td style={{ ...Sx.reportCellTight, textAlign: "right" }}>{b.count}</td>
            <td style={{ ...Sx.reportCellTight, textAlign: "right" }}>{fmtPct(b.pctCount)}</td>
            <td style={{ ...Sx.reportCellTight, textAlign: "right" }}>{fmtMoney(b.arr)}</td>
            <td style={{ ...Sx.reportCellTight, textAlign: "right" }}>{fmtPct(b.pctArr)}</td>
          </tr>
        );
      })}
      <tr>
        <td style={Sx.totalsCell}>{totalLabel}</td>
        <td style={{ ...Sx.totalsCell, textAlign: "right" }}>{totalCount}</td>
        <td style={{ ...Sx.totalsCell, textAlign: "right" }}>{totalCount > 0 ? "100%" : "—"}</td>
        <td style={{ ...Sx.totalsCell, textAlign: "right" }}>{fmtMoney(totalArr)}</td>
        <td style={{ ...Sx.totalsCell, textAlign: "right" }}>{totalArr > 0 ? "100%" : "—"}</td>
      </tr>
    </Fragment>
  );
}

function ReportSectionTitle({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 22, height: 22, borderRadius: 6, background: "#111827", color: "#fff",
        fontSize: 12, fontWeight: 700,
      }}>{index}</span>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: "#111827", margin: 0 }}>{children}</h2>
    </div>
  );
}

function Th2({ children, right, style }: { children: ReactNode; right?: boolean; style?: CSSProperties }) {
  return (
    <th style={{
      padding: "6px 6px", textAlign: right ? "right" : "left",
      fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: 0.3,
      background: "#e5e7eb", borderBottom: "1px solid #cbd5e1",
      ...style,
    }}>{children}</th>
  );
}

function AccountDrawer({ account, state, stack, stackOptions, onChange, onStackChange, onClose }:
  { account: Account; state: AccountState;
    stack: RooftopStack;
    stackOptions: { crm: string[]; scheduler: string[]; dms: string[] };
    onChange: (p: Partial<AccountState>)=>void;
    onStackChange: (p: Partial<RooftopStack>)=>void;
    onClose: ()=>void }) {
  const toggleCause = (c: RootCause) => {
    const next = state.rootCauses.includes(c)
      ? state.rootCauses.filter(x => x !== c)
      : [...state.rootCauses, c];
    onChange({ rootCauses: next });
  };
  const addTask = () => {
    const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const t: Task = {
      id,
      title: "New next step",
      taskDri: "",
      function: "CSM",
      dueDate: null,
      status: "Open",
      blockerNote: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    onChange({ tasks: [...state.tasks, t] });
  };
  const updateTask = (id: string, patch: Partial<Task>) => {
    onChange({ tasks: state.tasks.map(t => t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t) });
  };
  const removeTask = (id: string) => {
    onChange({ tasks: state.tasks.filter(t => t.id !== id) });
  };

  return (
    <div style={Sx.drawerScrim} onClick={onClose}>
      <div style={Sx.drawer} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => onChange({ starred: !state.starred })}
                title={state.starred ? "Starred — click to unstar" : "Star this rooftop to focus on it"}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 22, lineHeight: 1, color: state.starred ? "#f59e0b" : "#d1d5db" }}
              >{state.starred ? "★" : "☆"}</button>
              <RagPill rag={account.rag} />
              <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: "#111827" }}>{account.rooftopName}</h2>
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
              {account.enterpriseName} · {AGENT_LABELS[account.agentType]} · {account.ragNote}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              <CopyId label="Enterprise ID" value={account.enterpriseId} />
              <CopyId label="Team ID" value={account.teamId} />
            </div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 22, cursor: "pointer", color: "#6b7280" }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat label="MRR" value={fmtMoney(account.mrr)} />
          <Stat label="30d ROI" value={<RoiPill roi={account.roi} />} />
          <Stat label="Days Live" value={account.daysLive == null ? "—" : `${account.daysLive}`} sub={account.goLiveDate ?? ""} />
          <Stat label="Cohort" value={account.cohort} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
          <Stat label="30d Appts" value={account.appts.toLocaleString()} />
          <Stat label="30d TOFU" value={account.newLeads.toLocaleString()} />
          <Stat label="30d Touched" value={account.touched.toLocaleString()} />
          <Stat label="30d Appt $" value={fmtMoney(account.roiValue)} />
        </div>

        <SectionTitle>CSM (Account DRI)</SectionTitle>
        <input
          placeholder={account.csmEmail ?? "no CSM assigned in funnel sheet"}
          value={state.accountDri}
          onChange={e => onChange({ accountDri: e.target.value })}
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, fontWeight: 600 }}
        />
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, marginBottom: 14 }}>
          {state.accountDri
            ? <>Overridden in dashboard. Display name: <strong style={{ color: "#374151" }}>{displayNameFromEmail(state.accountDri) || state.accountDri}</strong>.{" "}
                {account.csmEmail && <>Sheet says <code>{account.csmEmail}</code>.</>}
                <button onClick={() => onChange({ accountDri: "" })} style={{ marginLeft: 6, border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", padding: 0, font: "inherit" }}>Reset to sheet</button>
              </>
            : <>Default: <strong style={{ color: "#374151" }}>{account.csmName || "—"}</strong> (from funnel sheet). Type a new email to override for this account.</>}
        </div>

        <SectionTitle>Tech stack</SectionTitle>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 4 }}>
          <StackField
            label="CRM"
            placeholder="VinSolutions, Tekion…"
            value={stack.crmName}
            onChange={v => onStackChange({ crmName: v })}
            options={stackOptions.crm}
            listId="stack-crm"
          />
          <StackField
            label="Service Scheduler"
            placeholder="xtime, myKaarma…"
            value={stack.serviceSchedulerName}
            onChange={v => onStackChange({ serviceSchedulerName: v })}
            options={stackOptions.scheduler}
            listId="stack-scheduler"
          />
          <StackField
            label="DMS"
            placeholder="Reynolds, CDK, Dealertrack…"
            value={stack.dmsName}
            onChange={v => onStackChange({ dmsName: v })}
            options={stackOptions.dms}
            listId="stack-dms"
          />
        </div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 14 }}>
          Set per rooftop — shared across all agents on this dealership. Pick a suggestion or type a new vendor.
        </div>

        <SectionTitle>Diagnosis · root causes</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
          {ROOT_CAUSES.map(c => {
            const on = state.rootCauses.includes(c);
            return (
              <button key={c} onClick={()=>toggleCause(c)} style={{
                padding: "4px 10px", fontSize: 12, fontWeight: 600, borderRadius: 999,
                border: on ? "1px solid #111827" : "1px solid #d1d5db",
                background: on ? "#111827" : "#fff", color: on ? "#fff" : "#374151", cursor: "pointer",
              }}>{c}</button>
            );
          })}
        </div>

        <SectionTitle>Next steps</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          {state.tasks.map(t => (
            <div key={t.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, background: "#fafafa" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <input
                  value={t.title} onChange={e=>updateTask(t.id, { title: e.target.value })}
                  style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, fontWeight: 600 }}
                />
                <select value={t.status} onChange={e=>updateTask(t.id, { status: e.target.value as TaskStatus })} style={Sx.select}>
                  {(["Open","In Progress","Blocked","Done"] as TaskStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={()=>removeTask(t.id)} style={{ ...Sx.select, color: "#dc2626", cursor: "pointer" }}>Delete</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                <input
                  list="task-owner-list"
                  placeholder="Task owner"
                  value={t.taskDri}
                  onChange={e => {
                    const name = e.target.value;
                    // Picking a known owner auto-fills their default team; the
                    // team stays editable below for the odd cross-team task.
                    const team = teamForOwner(name);
                    updateTask(t.id, team ? { taskDri: name, function: team } : { taskDri: name });
                  }}
                  style={Sx.input}
                />
                <select value={t.function} onChange={e=>updateTask(t.id, { function: e.target.value as TaskFunction })} style={Sx.select}>
                  {TASK_FUNCTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <input type="date" value={t.dueDate ?? ""} onChange={e=>updateTask(t.id, { dueDate: e.target.value || null })} style={Sx.input} />
              </div>
              {(t.status === "Blocked" || t.blockerNote) && (
                <textarea
                  placeholder="Blocker / context"
                  value={t.blockerNote} onChange={e=>updateTask(t.id, { blockerNote: e.target.value })}
                  rows={2} style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, marginTop: 8 }}
                />
              )}
            </div>
          ))}
        </div>
        <button onClick={addTask} style={{ padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>
          + Add next step
        </button>
        {/* Shared owner suggestions for every task's owner combobox. Typeahead +
            free entry — picking a known name auto-fills the team. */}
        <datalist id="task-owner-list">
          {OWNER_NAMES.map(name => <option key={name} value={name} />)}
        </datalist>

        <SectionTitle>Notes</SectionTitle>
        <textarea
          rows={4} value={state.notes} onChange={e=>onChange({ notes: e.target.value })}
          placeholder="Context, last conversation, any history…"
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13 }}
        />

        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #e5e7eb", fontSize: 11, color: "#6b7280" }}>
          Account state saved locally (browser only). Will move to Supabase in next cut.
          {" · "}
          <a href={`/agents`} style={{ color: "#2563eb" }}>Open in /agents</a>
        </div>
      </div>
    </div>
  );
}

// ─── Atoms ─────────────────────────────────────────────────────────────────
// Combobox-style field. Uses HTML5 <datalist> so users get a dropdown of
// values already in use (across all accounts in state) AND can type
// anything new — a freshly-typed value automatically appears in the list
// for future accounts once it's saved.
function StackField({ label, placeholder, value, onChange, options, listId }: {
  label: string; placeholder: string;
  value: string; onChange: (v: string) => void;
  options: string[]; listId: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: "#6b7280", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      <input
        list={listId}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, fontWeight: 600 }}
      />
      <datalist id={listId}>
        {options.map(opt => <option key={opt} value={opt} />)}
      </datalist>
    </label>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</div>;
}
function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th style={{ padding: "10px 12px", textAlign: right ? "right" : "left", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid #e5e7eb" }}>{children}</th>;
}
function Td({ children, right }: { children: ReactNode; right?: boolean }) {
  return <td style={{ padding: "10px 12px", textAlign: right ? "right" : "left", borderBottom: "1px solid #f3f4f6", color: "#374151" }}>{children}</td>;
}
// Click-to-copy ID chip. Shows "LABEL value" with a copy icon; on click copies
// the raw value to the clipboard and flashes a "Copied" state for ~1.2s.
function CopyId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const has = Boolean(value && value.trim());
  const copy = async () => {
    if (!has) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable — no-op */ }
  };
  return (
    <button
      type="button"
      onClick={copy}
      disabled={!has}
      title={has ? `Copy ${label}: ${value}` : `No ${label}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "3px 8px", borderRadius: 6,
        border: "1px solid #e5e7eb", background: copied ? "#dcfce7" : "#f9fafb",
        fontSize: 11, color: "#374151", cursor: has ? "pointer" : "default",
        fontFamily: "inherit",
      }}
    >
      <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: "#6b7280" }}>{label}</span>
      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: has ? "#111827" : "#9ca3af" }}>
        {has ? value : "—"}
      </span>
      {has && <span style={{ color: copied ? "#16a34a" : "#9ca3af", fontWeight: 600 }}>{copied ? "✓ Copied" : "⧉"}</span>}
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
      <div style={{ fontSize: 10, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#9ca3af" }}>{sub}</div>}
    </div>
  );
}
// All not-Done tasks for an account, each with owner + ETA + function. Used
// in: Account List, Top Accounts, By Cohort. Showing every open item (not
// just the first) is what makes the dashboard a real program-management tool
// — accountability means seeing every commitment.
function NextStepsCell({ tasks, compact }: { tasks: Task[]; compact?: boolean }) {
  const open = tasks.filter(t => t.status !== "Done");
  if (open.length === 0) {
    return <span style={{ color: "#dc2626", fontWeight: 600, fontSize: compact ? 12 : 13 }}>⚠ no next step</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 6, minWidth: 0 }}>
      {open.map(t => {
        const ownerLabel = t.taskDri ? (displayNameFromEmail(t.taskDri) || t.taskDri) : null;
        const statusColors: Record<TaskStatus, string> = {
          "Open": "#6b7280",
          "In Progress": "#0369a1",
          "Blocked": "#dc2626",
          "Done": "#16a34a",
        };
        return (
          <div key={t.id} style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                background: "#f3f4f6", color: statusColors[t.status],
                textTransform: "uppercase", letterSpacing: 0.4, flex: "0 0 auto",
              }}>{t.status}</span>
              <div style={{ color: "#111827", fontSize: compact ? 12 : 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {t.title || "(untitled)"}
              </div>
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ownerLabel
                ? <>👤 {ownerLabel}</>
                : <span style={{ color: "#dc2626" }}>👤 no owner</span>}
              {" · "}{t.function}
              {t.dueDate ? <> · 📅 {t.dueDate}</> : <span style={{ color: "#9ca3af" }}> · no ETA</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RagPill({ rag, small }: { rag: RagStatus; small?: boolean }) {
  const c = RAG_COLORS[rag];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
      padding: small ? "1px 7px" : "3px 9px",
      borderRadius: 999, background: c.bg, color: c.fg,
      fontSize: small ? 10 : 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
      minWidth: small ? 50 : 64,         // ← fixes the variable-width issue
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot }} />
      {rag}
    </span>
  );
}

// ROI pill — colored by the ROI value itself (not the row's RAG). Green ≥3×,
// Amber 1.5×–3×, Red <1.5×, grey if unknown. Decouples ROI signal from RAG so an
// Activation account with low ROI still shows the ROI in red even though its
// overall RAG is Green (insufficient time to penalise).
function roiBucket(roi: number | null): RagStatus | "unknown" {
  if (roi == null) return "unknown";
  if (roi >= ROI_GREEN) return "green";
  if (roi >= ROI_AMBER) return "amber";
  return "red";
}
function RoiPill({ roi }: { roi: number | null }) {
  const bucket = roiBucket(roi);
  const c = bucket === "unknown"
    ? { bg: "#f3f4f6", fg: "#6b7280", dot: "#9ca3af" }
    : RAG_COLORS[bucket];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg,
      fontSize: 11, fontWeight: 700, minWidth: 52,
    }}>
      {fmtRoi(roi)}
    </span>
  );
}
function CohortPill({ cohort, daysLive }: { cohort: Cohort; daysLive: number | null }) {
  const c = COHORT_COLORS[cohort];
  return (
    <span style={{ display: "inline-flex", gap: 5, padding: "3px 9px", borderRadius: 999, background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600 }}>
      {cohort}{daysLive != null ? ` · ${daysLive}d` : ""}
    </span>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
const S: Record<string, CSSProperties> = {
  page: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", padding: "20px 32px", background: "#f9fafb", minHeight: "100vh" },
  errorBar: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 },
  tabs: { display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid #e5e7eb" },
};
const Sx = {
  // Filter bar "divider" — now a small subtle dot rather than a hard 1px
  // vertical line. The hard line looked cluttered; a dot reads as a soft
  // visual separator and stays out of the way.
  divider: { width: 3, height: 3, borderRadius: "50%", background: "#d1d5db", margin: "0 4px", flex: "0 0 auto" } as CSSProperties,
  matrixHeadCell: { padding: "10px 12px", borderBottom: "1px solid #e5e7eb", fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: 0.4 },
  matrixCell: { padding: "12px 14px", borderBottom: "1px solid #f3f4f6" } as CSSProperties,
  cellTruncate: { minWidth: 0, maxWidth: "100%" } as CSSProperties,
  linkBtn: { border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", padding: 0, font: "inherit", fontWeight: 500 } as CSSProperties,
  // Email-shaped card — narrow column centred in the page. Grows up to ~580px
  // on laptop / tablet; shrinks to fit narrow phones (the page's own padding
  // also scales via clamp() in S.page-equivalent context). Tables inside use
  // explicit colgroup widths and, as a last-resort fallback for very narrow
  // phones, the container scrolls horizontally.
  reportContainer: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "clamp(12px, 3vw, 20px)", width: "100%", maxWidth: 580, margin: "0 auto", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflowX: "auto" as const, WebkitOverflowScrolling: "touch" as const } as CSSProperties,
  reportTable: { width: "100%", borderCollapse: "collapse" as const, fontSize: 11, border: "1px solid #e5e7eb", tableLayout: "fixed" as const } as CSSProperties,
  reportCellTight: { padding: "5px 6px", borderTop: "1px solid #f3f4f6", color: "#111827", fontSize: 11, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" } as CSSProperties,
  totalsCell:  { padding: "5px 6px", borderTop: "2px solid #e5e7eb", fontWeight: 700, color: "#111827", background: "#fafafa", fontSize: 11, whiteSpace: "nowrap" as const } as CSSProperties,
  agentBandLabel: { padding: "6px 8px", background: "#f3f4f6", fontWeight: 700, color: "#111827", fontSize: 12, borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" } as CSSProperties,
  topRow: { display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 14px", border: "none", borderBottom: "1px solid #f3f4f6", background: "transparent", textAlign: "left" as const, cursor: "pointer", fontSize: 13 },
  cohortRow: { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: 8, border: "1px solid #f3f4f6", borderRadius: 8, background: "#fff", textAlign: "left" as const, cursor: "pointer" },
  tr: { cursor: "pointer", borderBottom: "1px solid #f3f4f6" } as CSSProperties,
  drawerScrim: { position: "fixed" as const, inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 100, display: "flex", justifyContent: "flex-end" },
  drawer: { width: "min(720px, 100%)", height: "100vh", background: "#fff", padding: 22, overflowY: "auto" as const, boxShadow: "-4px 0 12px rgba(0,0,0,0.12)" },
  select: { padding: "5px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, background: "#fff" } as CSSProperties,
  input: { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13 } as CSSProperties,
};
