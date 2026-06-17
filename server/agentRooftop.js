// Rooftop-grain agent metrics, straight off Q12227's base_fact on ClickHouse —
// the SAME raw layer the Overall view (/api/metrics) aggregates. Aggregating
// here at (team_id × agent_type [× activity_day]) makes the Rooftop view and the
// Overall view reconcile exactly (one source, identical definitions). Replaces
// the old Metabase agents_v2 cards.
//
// Distinct-count fields use uniqExact so the totals query is lead-deduped over
// the whole window and the daily query is deduped per day — never summed across
// days (the cross-day double-count the dashboard already warns about).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runClickhouse, hasClickhouseCreds } from "./agentMetrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASE_FACT = readFileSync(join(here, "agentBaseFact.sql"), "utf8");

// Trailing window the rooftop view covers (daily rows + totals). 120 days spans
// the dashboard's widest preset (Last 90D) with headroom; "All" then means
// "last N days". base_fact's {START} floors the underlying conversation scan.
const WINDOW_DAYS = Number(process.env.AGENTS_WINDOW_DAYS) || 120;
const baseSql = () => BASE_FACT.replaceAll("{START}", `addDays(today(), -${WINDOW_DAYS})`);

// Identity columns carried per rooftop. The dashboard reads team_id/enterprise_id
// bare (it also accepts the pld.* aliases the old totals card used).
const DIM_COLS = `
  team_id,
  any(enterprise_id)   AS enterprise_id,
  any(enterprise_name) AS enterprise_name,
  any(rooftop_name)    AS rooftop_name,
  any(rooftop_stage)   AS rooftop_stage,
  any(service_type)    AS service_type,
  any(direction)       AS direction,
  agent_type`;

// Metric columns matching the dashboard's AgentRowBase. appointment_value is not
// in Q12227 (ROI uses the cost-per-appt model, not $-value) → 0. new_leads_created
// / leads_contacted_from_new / capture_rate are top-of-funnel concepts absent from
// the conversation-grain base_fact and are already hidden in the UI → omitted.
const METRIC_COLS = `
  uniqExact(lead_id)                          AS touched_leads,
  uniqExactIf(lead_id, qualified = 1)         AS qualified_leads,
  sum(appointments_count)                     AS appointments,
  toInt32(0)                                  AS appointment_value,
  sum(is_call)                                AS total_calls,
  sum(n_sms_messages)                         AS total_sms,
  uniqExactIf(lead_id, is_call = 1)           AS leads_with_calls,
  uniqExactIf(lead_id, is_sms = 1)            AS leads_with_sms,
  uniqExactIf(lead_id, had_transfer = 1)      AS transfer_leads,
  uniqExactIf(lead_id, had_callback = 1)      AS callback_leads`;

const totalsSql = () => `SELECT ${DIM_COLS}, ${METRIC_COLS}
FROM ( ${baseSql()} ) AS b
WHERE team_id != ''
GROUP BY team_id, agent_type`;

const dailySql = () => `SELECT ${DIM_COLS}, toString(activity_day) AS day, ${METRIC_COLS}
FROM ( ${baseSql()} ) AS b
WHERE team_id != ''
GROUP BY team_id, agent_type, activity_day`;

// Returns { daily, totals } in the exact shape /api/agents already serves.
// GROUP BY yields one row per key, so no client-side dedup is needed.
export async function runAgentRooftops() {
  const [totals, daily] = await Promise.all([
    runClickhouse(totalsSql()),
    runClickhouse(dailySql()),
  ]);
  return { totals, daily };
}

export { hasClickhouseCreds };
