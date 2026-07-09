// ─── True distinct-lead counts per (agent_type, period) ─────────────────────
// The daily spine rows carry uniqExact(lead_id) PER DAY. Summing them across a
// month double-counts any lead worked on multiple days (Service OB PM caught
// this 10-Jul: Jun "leads touched" 24,537 shown vs 13,200 real). This queries
// the SAME base_fact but dedupes over each whole range, so monthly/MTD columns
// are true distinct. Daily columns (single day) are already correct and keep
// using the daily rows.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCallbackOutboundAttribution } from "../../server/callbackAttribution.js";
import { runClickhouse } from "../../server/agentMetrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = applyCallbackOutboundAttribution(
  readFileSync(join(here, "..", "..", "server", "agentBaseFact.sql"), "utf8"),
  "agentBaseFact.sql"
);
const WINDOW_DAYS = Number(process.env.AGENTS_WINDOW_DAYS) || 120;
const AGENT_LABELS = {
  "Sales Inbound": "Sales IB", "Service Inbound": "Service IB",
  "Sales Outbound": "Sales OB", "Service Outbound": "Service OB",
};
// Distinct-lead metrics that get double-counted when summed across days.
const METRICS = {
  leads:     "1 = 1",
  qualified: "qualified = 1",
  warmLeads: "had_appt_intent = 1",
  transfers: "had_transfer = 1",
};

// periods: { key: [fromISO, toISO], ... }. Returns { agentShort: { key: {leads,qualified,warmLeads,transfers} } }.
export async function fetchAgentPeriodDistinct(periods) {
  const base = BASE.replaceAll("{START}", `addDays(today(), -${WINDOW_DAYS})`);
  const cols = [];
  for (const [pk, [from, to]] of Object.entries(periods))
    for (const [mk, cond] of Object.entries(METRICS))
      cols.push(`uniqExactIf(lead_id, (${cond}) AND activity_day BETWEEN '${from}' AND '${to}') AS ${mk}__${pk}`);
  const sql = `SELECT agent_type, ${cols.join(", ")}
    FROM ( ${base} ) b WHERE team_id != '' GROUP BY agent_type`;
  const rows = await runClickhouse(sql);
  const out = {};
  for (const r of rows) {
    const ag = AGENT_LABELS[r.agent_type];
    if (!ag) continue;
    out[ag] = {};
    for (const pk of Object.keys(periods)) {
      out[ag][pk] = {
        leads:     Number(r[`leads__${pk}`])     || 0,
        qualified: Number(r[`qualified__${pk}`]) || 0,
        warmLeads: Number(r[`warmLeads__${pk}`]) || 0,
        transfers: Number(r[`transfers__${pk}`]) || 0,
      };
    }
  }
  return out;
}
