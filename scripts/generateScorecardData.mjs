// Regenerates src/agents/scorecard/data/week.json + month.json for the Agent
// Scorecard tab. Run manually: `node scripts/generateScorecardData.mjs`.
//
// Rebuilt (2026-07) to fix 3 confirmed bugs in the original ad-hoc pass:
//   1. Appointments now scoped to source='spyne' (was counting all sources —
//      96% of dealer_leads.meetings rows are source='bdc', human-booked).
//   2. Office-hours overflow is now partitioned by (teamId, projectType), not
//      teamId alone — a Sales-line call and a Service-line call on the same
//      rooftop no longer falsely flag each other as overflow.
//   3. Touches on a rooftop with unconfigured business hours (~42% of all
//      team-agent mappings have empty availabilityHours) are now excluded
//      from BOTH the after-hours and office-hours buckets, surfaced instead
//      as "unknown hours" — previously they silently defaulted to after-hours.
// Also: the Live-rooftop roster is now read from the master sheet at
// generation time (fixes the stale/hand-seeded 43-vs-48-vs-41 mismatch), pool
// entries now carry team_id (needed for reliable matched/unmatched drill-down
// in ScorecardView.tsx), and dates are rolling (today()-relative), not
// hardcoded literals — so re-running this later just works.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runClickhouse, hasClickhouseCreds } from "../server/agentMetrics.js";
import { getAllDeploymentStatuses } from "../server/viniStatuses.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "src", "agents", "scorecard", "data");

const FUNNEL_SHEET_ID = "15BScfybsSmmvQefXQxN-TYA_-cCNkD8qLDui7EML3ss";
const ACCOUNTS_SHEET_URL = `https://docs.google.com/spreadsheets/d/${FUNNEL_SHEET_ID}/export?format=csv&gid=0`;

const AGENT_TYPE_MAP = {
  "sales inbound": "Sales IB",
  "sales outbound": "Sales OB",
  "service inbound": "Service IB",
  "service outbound": "Service OB",
};
const PROJECT_TYPE_OF = {
  "Sales IB": "Sales inbound",
  "Sales OB": "Sales outbound",
  "Service IB": "Service inbound",
  "Service OB": "Service outbound",
};
const SERVICE_TYPE_OF = { "Sales OB": "sales", "Service OB": "service" };
const CAMPAIGN_TYPE_OF = { "Sales OB": "Sales", "Service OB": "Service" };
const APPT_THRESHOLD_OF = { "Sales OB": 10, "Service OB": 20 };
const AGENTS_ORDER = ["Sales IB", "Sales OB", "Service IB", "Service OB"];

// ── 1. Master sheet — dynamic Live-rooftop roster ───────────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchLiveRoster() {
  const res = await fetch(ACCOUNTS_SHEET_URL);
  if (!res.ok) throw new Error(`accounts sheet fetch failed: HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  const headerIdx = rows.findIndex(r => r.some(c => c.trim().toLowerCase() === "team id"));
  if (headerIdx === -1) throw new Error("accounts sheet: header row not found");
  const header = rows[headerIdx];
  const col = (name) => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const iTeam = col("Team ID"), iRooftop = col("Rooftop Name"), iAgent = col("Agent Opted"), iStage = col("Stage");

  const roster = { "Sales IB": [], "Sales OB": [], "Service IB": [], "Service OB": [] };
  const seen = { "Sales IB": new Set(), "Sales OB": new Set(), "Service IB": new Set(), "Service OB": new Set() };
  for (const r of rows.slice(headerIdx + 1)) {
    const teamId = (r[iTeam] || "").trim();
    if (!teamId) continue;
    if ((r[iStage] || "").trim() !== "Live") continue;
    const agentKey = AGENT_TYPE_MAP[(r[iAgent] || "").trim().toLowerCase()];
    if (!agentKey) continue; // e.g. "AI Receptionist" — not one of the 4 scorecard buckets
    if (seen[agentKey].has(teamId)) continue; // de-dupe repeated rooftop rows for the same team+agent_type
    seen[agentKey].add(teamId);
    roster[agentKey].push({ team_id: teamId, rooftop: (r[iRooftop] || "").trim() || teamId });
  }
  return roster;
}

// ── 2. ClickHouse helpers ────────────────────────────────────────────────

const teamList = (ids) => ids.map(t => `'${t.replace(/'/g, "\\'")}'`).join(",");

// Per-touch classification, shared by every Sales/Service IB metric. Returns
// per-team_id counts for one (agent bucket, date window) pair.
async function touchMetrics(projectType, teamIds, startExpr, endExpr, { withStl }) {
  if (!teamIds.length) return [];
  const sql = `
WITH base AS (
  SELECT teamId,
    if(hoursConfigured, (NOT avail OR lm < sm OR lm >= em), NULL) AS isAfterHours,
    (channel='call' AND createdAtUtc < maxPrevEnd) AS isOverflow,
    channel, isSTL
  FROM (
    SELECT teamId, channel, isSTL, createdAtUtc, localTs,
      length(hours) > 0 AS hoursConfigured,
      ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'][toDayOfWeek(localTs)] AS dn,
      toHour(localTs)*60+toMinute(localTs) AS lm,
      JSONExtractBool(hours,dn,'available') AS avail,
      toUInt16OrZero(substring(JSONExtractString(hours,dn,'startTime'),1,2))*60+toUInt16OrZero(substring(JSONExtractString(hours,dn,'startTime'),4,2)) AS sm,
      toUInt16OrZero(substring(JSONExtractString(hours,dn,'endTime'),1,2))*60+toUInt16OrZero(substring(JSONExtractString(hours,dn,'endTime'),4,2)) AS em,
      max(callEnd) OVER (PARTITION BY teamId ORDER BY createdAtUtc ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS maxPrevEnd
    FROM (
      SELECT c.teamId AS teamId, c.type AS channel,
        c.followupId IN (SELECT taskId FROM dealer_leads.sequenceTasks WHERE taskType='STL') AS isSTL,
        c.createdAt AS createdAtUtc, tam.availabilityHours AS hours,
        if(c.type='call', c.createdAt + toIntervalSecond(ifNull(c.callData_callDuration,0)), NULL) AS callEnd,
        multiIf(
          etd.timezone = 'America/New_York',    toTimeZone(c.createdAt, 'America/New_York'),
          etd.timezone = 'America/Los_Angeles', toTimeZone(c.createdAt, 'America/Los_Angeles'),
          etd.timezone = 'America/Denver',      toTimeZone(c.createdAt, 'America/Denver'),
          etd.timezone = 'America/Phoenix',      toTimeZone(c.createdAt, 'America/Phoenix'),
          etd.timezone = 'America/Detroit',      toTimeZone(c.createdAt, 'America/Detroit'),
          toTimeZone(c.createdAt, 'America/Chicago')
        ) AS localTs
      FROM dealer_leads.conversations c FINAL
      INNER JOIN dealer_leads.teamAgentMappings tam FINAL ON c.teamAgentMappingId=tam.teamAgentMappingId AND tam.__deleted=0
      INNER JOIN dealer_leads.agentTypes at FINAL ON tam.agentTypeId=at.agentTypeId AND at.__deleted=0
      LEFT JOIN eventila.enterprise_team_details etd FINAL ON etd.team_id = c.teamId
      WHERE c.__deleted=0 AND ifNull(c.isTest,0)=0
        AND c.teamId IN (${teamList(teamIds)})
        AND concat(at.agentType,' ',at.agentCallType) = '${projectType}'
        AND c.createdAt >= ${startExpr} AND c.createdAt < ${endExpr}
    )
  )
)
SELECT teamId,
  countIf(isAfterHours = 1) AS afterHoursCalls_all,
  countIf(channel='call' AND isAfterHours = 1) AS afterHoursCalls,
  countIf(channel='call' AND isAfterHours = 0) AS officeHoursAllCalls,
  countIf(isOverflow = 1 AND isAfterHours = 0) AS officeHoursOverflow,
  countIf(isAfterHours IS NULL) AS unknownHoursTouches
  ${withStl ? `,
  countIf(isSTL = 1 AND isAfterHours = 1) AS afterHoursSTL,
  countIf(isSTL = 1 AND isAfterHours = 0) AS officeHoursSTL` : ""}
FROM base
GROUP BY teamId
`;
  return runClickhouse(sql);
}

async function sequenceTaskMetric(taskType, teamIds, startExpr, endExpr) {
  if (!teamIds.length) return [];
  const sql = `
SELECT teamId, count() AS n
FROM dealer_leads.sequenceTasks
WHERE taskType='${taskType}' AND __deleted=0
  AND teamId IN (${teamList(teamIds)})
  AND createdAt >= ${startExpr} AND createdAt < ${endExpr}
GROUP BY teamId
`;
  return runClickhouse(sql);
}

async function campaignMetric(campaignType, teamIds, startExpr, endExpr) {
  if (!teamIds.length) return [];
  const sql = `
SELECT teamId, uniqExact(campaignUseCase) AS n
FROM dealer_leads.campaigns FINAL
WHERE __deleted=0 AND campaignType='${campaignType}'
  AND teamId IN (${teamList(teamIds)})
  AND createdAt >= ${startExpr} AND createdAt < ${endExpr}
GROUP BY teamId
`;
  return runClickhouse(sql);
}

// AI-booked (source='spyne') appointments per rooftop — Fix #1.
async function apptMetric(serviceType, teamIds, startExpr, endExpr) {
  if (!teamIds.length) return [];
  const sql = `
SELECT team_id AS teamId, count() AS n
FROM dealer_leads.meetings FINAL
WHERE __deleted=0 AND is_active=1 AND source='spyne' AND service_type='${serviceType}'
  -- canonical: source='spyne' says we OWN the booking; meta.source='warm_transfer' rows are the
  -- customer's EXISTING appointments pulled in around a transfer — records we did not create.
  AND lower(JSONExtractString(ifNull(meta,''),'source'))!='warm_transfer'
  AND status IN ('scheduled','completed')
  AND team_id IN (${teamList(teamIds)})
  AND created_at >= ${startExpr} AND created_at < ${endExpr}
GROUP BY team_id
`;
  return runClickhouse(sql);
}

// ── 3. Cell builders ─────────────────────────────────────────────────────

function byTeam(rows, field = "n") {
  const m = new Map();
  for (const r of rows) m.set(r.teamId, Number(r[field] ?? 0));
  return m;
}

// list = pool rooftops with count > 0, sorted desc. Callers building
// "unmatched" (pool minus list) do it client-side in ScorecardView.tsx.
function cellFromCounts(pool, counts, unit, subFmt, opts = {}) {
  const list = pool
    .map(p => ({ rooftop: p.rooftop, team_id: p.team_id, count: counts.get(p.team_id) ?? 0 }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const value = opts.avg
    ? (pool.length ? Math.round((list.reduce((s, x) => s + x.count, 0) / pool.length) * 10) / 10 : 0)
    : list.length;
  return { value, unit, sub: subFmt(list, pool), list };
}

function cellThreshold(pool, counts, threshold, unit) {
  const list = pool
    .map(p => ({ rooftop: p.rooftop, team_id: p.team_id, count: counts.get(p.team_id) ?? 0 }))
    .filter(x => x.count >= threshold)
    .sort((a, b) => b.count - a.count);
  return { value: list.length, unit, sub: `≥${threshold} appts booked`, list };
}

// deployment_statuses is a snapshot (current config), not a per-period metric —
// "matched" = status is exactly 'Live' (the feature is actually deployed for
// that rooftop). Anything else (In Progress/Approval/Declined/Not Live/unset)
// falls out to "unmatched". Same value used for both prev and cur columns
// since there's no historical tracking of this flag.
function cellFromStatus(pool, statusByTeam, flagName) {
  const list = pool
    .filter(p => statusByTeam.get(p.team_id) === "Live")
    .map(p => ({ rooftop: p.rooftop, team_id: p.team_id, count: 1 }));
  return { value: list.length, unit: "rooftops", sub: `of pool with ${flagName} status = Live (current config, not period-over-period)`, list };
}

// ── 4. Assemble one period payload (week or month) ──────────────────────

async function buildAgentRows(agentKey, pool, windows, deploymentStatuses) {
  const teamIds = pool.map(p => p.team_id);
  const rows = [];

  if (agentKey === "Sales IB" || agentKey === "Service IB") {
    const projectType = PROJECT_TYPE_OF[agentKey];
    const withStl = agentKey === "Sales IB";
    const [prevTouch, curTouch] = await Promise.all([
      touchMetrics(projectType, teamIds, windows.prev.start, windows.prev.end, { withStl }),
      touchMetrics(projectType, teamIds, windows.cur.start, windows.cur.end, { withStl }),
    ]);
    const prevUnknown = byTeam(prevTouch, "unknownHoursTouches");
    const curUnknown = byTeam(curTouch, "unknownHoursTouches");
    const unknownNote = (m) => {
      const n = teamIds.filter(t => (m.get(t) ?? 0) > 0).length;
      return n ? `${n} rooftop${n === 1 ? "" : "s"} have no configured hours (excluded)` : "of pool with a qualifying touch";
    };

    const addRow = (metric, field, subBase) => {
      rows.push({
        metric,
        prev: cellFromCounts(pool, byTeam(prevTouch, field), "rooftops", () => subBase + " — " + unknownNote(prevUnknown)),
        cur: cellFromCounts(pool, byTeam(curTouch, field), "rooftops", () => subBase + " — " + unknownNote(curUnknown)),
        total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true },
      });
    };

    if (withStl) addRow("After-hours STL", "afterHoursSTL", "of pool with an after-hours speed-to-lead touch");
    addRow("After-hours Calls", "afterHoursCalls", "of pool with an after-hours call");
    if (withStl) addRow("Office-hrs STL", "officeHoursSTL", "of pool with an office-hours speed-to-lead touch");
    addRow("Office-hrs Overflow", "officeHoursOverflow", "of pool with a 2nd+ simultaneous office-hours call");
    addRow("Office-hrs All Calls", "officeHoursAllCalls", "of pool with an office-hours call");

    const followUpType = agentKey === "Sales IB" ? "14 days follow-up" : "Follow-ups";
    const [prevFu, curFu] = await Promise.all([
      sequenceTaskMetric("FOLLOW_UP", teamIds, windows.prev.start, windows.prev.end),
      sequenceTaskMetric("FOLLOW_UP", teamIds, windows.cur.start, windows.cur.end),
    ]);
    rows.push({
      metric: followUpType,
      prev: cellFromCounts(pool, byTeam(prevFu), "rooftops", () => "of pool with a follow-up task"),
      cur: cellFromCounts(pool, byTeam(curFu), "rooftops", () => "of pool with a follow-up task"),
      total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true },
    });

    const [prevAr, curAr] = await Promise.all([
      sequenceTaskMetric("APPOINTMENT_REMINDER", teamIds, windows.prev.start, windows.prev.end),
      sequenceTaskMetric("APPOINTMENT_REMINDER", teamIds, windows.cur.start, windows.cur.end),
    ]);
    rows.push({
      metric: "Appointment Reminder",
      prev: cellFromCounts(pool, byTeam(prevAr), "rooftops", () => "of pool with an appointment-reminder task"),
      cur: cellFromCounts(pool, byTeam(curAr), "rooftops", () => "of pool with an appointment-reminder task"),
      total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true },
    });

    // Smartview is a deployment-status flag (deployment_statuses.smart_view),
    // not a ClickHouse activity metric — separate data source, Sales IB only.
    if (agentKey === "Sales IB") {
      const smartViewByTeam = new Map();
      for (const p of pool) {
        const status = deploymentStatuses[p.team_id];
        if (status) smartViewByTeam.set(p.team_id, status.smartView);
      }
      const cell = smartViewByTeam.size
        ? cellFromStatus(pool, smartViewByTeam, "SmartView")
        : { value: null, unit: "rooftops", sub: "deployment_statuses not configured (SUPABASE_URL/SUPABASE_SECRET_KEY missing) — see .env.example", list: [] };
      rows.push({ metric: "Smartview", prev: cell, cur: cell, total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true } });
    }
  } else {
    // Sales OB / Service OB
    const campaignType = CAMPAIGN_TYPE_OF[agentKey];
    const serviceType = SERVICE_TYPE_OF[agentKey];
    const threshold = APPT_THRESHOLD_OF[agentKey];

    const [prevCamp, curCamp, prevAppt, curAppt] = await Promise.all([
      campaignMetric(campaignType, teamIds, windows.prev.start, windows.prev.end),
      campaignMetric(campaignType, teamIds, windows.cur.start, windows.cur.end),
      apptMetric(serviceType, teamIds, windows.prev.start, windows.prev.end),
      apptMetric(serviceType, teamIds, windows.cur.start, windows.cur.end),
    ]);

    rows.push({
      metric: "Campaigns/Rooftop",
      prev: cellFromCounts(pool, byTeam(prevCamp), "avg", () => "distinct campaign use-cases per rooftop", { avg: true }),
      cur: cellFromCounts(pool, byTeam(curCamp), "avg", () => "distinct campaign use-cases per rooftop", { avg: true }),
      total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true },
    });
    rows.push({
      metric: "Appointments/Rooftop",
      prev: cellFromCounts(pool, byTeam(prevAppt), "avg", () => "AI-booked (source=spyne) appts per rooftop", { avg: true }),
      cur: cellFromCounts(pool, byTeam(curAppt), "avg", () => "AI-booked (source=spyne) appts per rooftop", { avg: true }),
      total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true },
    });
    rows.push({
      metric: `Rooftops with ${threshold}+ Appts`,
      prev: cellThreshold(pool, byTeam(prevAppt), threshold, "rooftops"),
      cur: cellThreshold(pool, byTeam(curAppt), threshold, "rooftops"),
      total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true },
    });
    rows.push({
      metric: "Active Rooftops",
      prev: cellFromCounts(pool, byTeam(prevCamp), "rooftops", () => `of pool with a ${campaignType.toLowerCase()} campaign`),
      cur: cellFromCounts(pool, byTeam(curCamp), "rooftops", () => `of pool with a ${campaignType.toLowerCase()} campaign`),
      total: { value: pool.length, unit: "rooftops", sub: "contract-Live count from the master sheet", list: [], pool: true },
    });
  }

  return rows;
}

async function buildPayload(roster, windows, deploymentStatuses) {
  const rows = {};
  for (const agent of AGENTS_ORDER) {
    rows[agent] = await buildAgentRows(agent, roster[agent], windows, deploymentStatuses);
  }
  const pools = {};
  for (const agent of AGENTS_ORDER) pools[agent] = roster[agent].map(p => ({ ...p, count: 1 }));
  return { rows, pools };
}

// ── 5. Main ──────────────────────────────────────────────────────────────

async function main() {
  if (!hasClickhouseCreds()) throw new Error("CLICKHOUSE_HOST/CLICKHOUSE_PASSWORD not set");

  console.log("Fetching Live-rooftop roster from the master sheet...");
  const roster = await fetchLiveRoster();
  for (const a of AGENTS_ORDER) console.log(`  ${a}: ${roster[a].length} Live rooftops`);

  console.log("Fetching deployment_statuses (Smartview) from Supabase...");
  let deploymentStatuses = {};
  try {
    deploymentStatuses = await getAllDeploymentStatuses();
    console.log(`  ${Object.keys(deploymentStatuses).length} rooftop_key rows`);
  } catch (err) {
    console.warn(`  skipped: ${err.message}`);
  }
  if (!Object.keys(deploymentStatuses).length) {
    console.warn("  WARNING: no deployment_statuses rows — Smartview will show as unavailable. Set SUPABASE_URL + SUPABASE_SECRET_KEY (see .env.example) and re-run.");
  }

  const weekWindows = {
    prev: { start: "subtractWeeks(toMonday(today()), 1)", end: "toMonday(today())" },
    cur: { start: "toMonday(today())", end: "today() + 1" },
  };
  const monthWindows = {
    prev: { start: "subtractMonths(toStartOfMonth(today()), 1)", end: "toStartOfMonth(today())" },
    cur: { start: "toStartOfMonth(today())", end: "today() + 1" },
  };

  console.log("Building week payload...");
  const week = await buildPayload(roster, weekWindows, deploymentStatuses);
  console.log("Building month payload...");
  const month = await buildPayload(roster, monthWindows, deploymentStatuses);

  writeFileSync(join(DATA_DIR, "week.json"), JSON.stringify(week, null, 2));
  writeFileSync(join(DATA_DIR, "month.json"), JSON.stringify(month, null, 2));
  console.log("Wrote week.json + month.json");
}

main().catch(err => { console.error(err); process.exit(1); });
