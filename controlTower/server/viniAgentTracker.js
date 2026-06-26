// ─── Vini Agent Tracker — canonical Live/Churn source ──────────────────────
// Schema: Enterprise ID · Account · Team ID · Rooftop Name · Agent Opted ·
//         Go-Live Date · ARR · MRR · Stage  (Live | Churned | blank)
//
// Source: tab "Vini_Agent_Tracker" on doc 1H5cBuWmL…
// Sheet is not publicly shared yet, so this loader reads from a local CSV
// snapshot at data/vini_agent_tracker.csv. Swap to a remote fetch once the
// sheet is shared with "Anyone with the link".

import Papa from "papaparse";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, "..", "data", "vini_agent_tracker.csv");

const AGENT_LABELS = {
  "Sales Inbound":    "Sales IB",
  "Sales Outbound":   "Sales OB",
  "Service Inbound":  "Service IB",
  "Service Outbound": "Service OB",
};
const AGENT_ORDER = ["Sales IB", "Service IB", "Sales OB", "Service OB"];

// ─── ROI formula constants ───────────────────────────────────────────────────
// Cost per appointment by agent type — what the dealer would pay elsewhere for
// the same appointment. We monetize Vini's output as (# appts × cost per appt)
// and compare against MRR.
// Mehul whiteboard 17-Jun → applied 26-Jun directive. New rates per agent:
//   Sales IB    $200  (was $100)
//   Sales OB    $250  (unchanged)
//   Service IB  $100  (was $50)
//   Service OB  $200  (was $75)
export const COST_PER_APPT = {
  "Sales IB":    200,
  "Sales OB":    250,
  "Service IB":  100,
  "Service OB":  200,
};

// Premium dealers — book higher-value appointments (luxury / top-tier).
// Premium override applies regardless of agent type.
export const PREMIUM_APPT_VALUE = 750;
export const PREMIUM_ACCOUNTS = new Set([
  "Mercedes-Benz of Arlington",
  // Add more "top 1%" dealers here as identified.
]);

// Rooftops/accounts that should NOT appear in Top Wins / Top REDs lists —
// internal test rooftops, demo accounts, or any agent the user has flagged
// as misleading to surface to stakeholders. Match is exact on rooftop OR
// account OR (rooftop + agentShort) so we can scope per-agent if needed.
export const HIGHLIGHT_EXCLUDE = new Set([
  "Burns Hyundai|Service IB",  // user-flagged 15-Jun: remove from Top Wins
]);
const isExcluded = (a) =>
  HIGHLIGHT_EXCLUDE.has(`${a.rooftop || a.account}|${a.agentShort}`) ||
  HIGHLIGHT_EXCLUDE.has(a.rooftop) ||
  HIGHLIGHT_EXCLUDE.has(a.account);

/**
 * Cost per appointment for an agent — premium override first, agent-type
 * default second. Matches on either account name or rooftop name so either
 * field can be the lookup key.
 */
export function costPerAppt(agent) {
  if (PREMIUM_ACCOUNTS.has(agent.account) || PREMIUM_ACCOUNTS.has(agent.rooftop)) {
    return PREMIUM_APPT_VALUE;
  }
  return COST_PER_APPT[agent.agentShort] ?? null;
}

// ─── RAG model — ROI-based (reverted 2026-05-30 per Mehul's spec) ─────────
//
// Volume gate first (TOFU floor); else classify by ROI Multiple bucket.
//   leads < 100              → Red · TOFU      (volume problem)
//   ROI ≥ 5                  → Green
//   3 ≤ ROI < 5              → Amber
//   ROI < 3                  → Red · Performance
//   no Metabase row          → N/A             (unscored — excluded from "Actually Live")
//
// ROI Multiple = (appointments × cost-per-appt) ÷ MRR, with premium-dealer
// override layered in via costPerAppt(agent).
// Mehul whiteboard 17-Jun (applied 26-Jun directive):
//   ROI ≥ 3     → Green
//   ROI ≥ 1.5   → Amber
//   ROI < 1.5   → Red
// TOFU red stays at < 100 leads.
export const RAG_THRESHOLDS = {
  tofuLeads: 100,
  roiGreen:  3,
  roiAmber:  1.5,
};

function clean(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}
function parseDollars(s) {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function fetchViniAgents() {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`Snapshot missing: ${SNAPSHOT_PATH} — share the Vini_Agent_Tracker sheet publicly to enable live fetch`);
  }
  const csv = readFileSync(SNAPSHOT_PATH, "utf8");
  const { data } = Papa.parse(csv, { skipEmptyLines: true });

  const headerIdx = data.findIndex(r => (r?.[0] || "").trim() === "Enterprise ID");
  if (headerIdx < 0) throw new Error("Vini_Agent_Tracker header row not found");

  const rows = [];
  for (let i = headerIdx + 1; i < data.length; i++) {
    const r = data[i];
    const rooftop = clean(r[3]);
    const agentRaw = clean(r[4]);
    if (!rooftop || !agentRaw) continue;
    rows.push({
      enterpriseId: clean(r[0]),
      account:      clean(r[1]),
      teamId:       clean(r[2]),
      rooftop,
      agentRaw,
      agentShort:   AGENT_LABELS[agentRaw] || agentRaw,
      arr:          parseDollars(r[6]),
      mrr:          parseDollars(r[7]),
      stage:        clean(r[8]),     // "Live" | "Churned" | null (OB)
    });
  }
  return rows;
}

// ─── Join Metabase totals (appointments + leads) into agent rows ────────────
// Join key = teamId + agentShort (falls back to rooftop name + agentShort).
//
// metabaseRows is the array from fetchAgentsTotals() with at least:
//   { teamId, rooftop, agentShort, leadsInteracted, appointments, abr }
export function joinAppointments(agentRows, metabaseRows) {
  const byKey = new Map();
  for (const t of metabaseRows) {
    if (!t.agentShort) continue;
    if (t.teamId)  byKey.set(`${t.teamId}::${t.agentShort}`,  t);
    if (t.rooftop) byKey.set(`${t.rooftop}::${t.agentShort}`, t);
  }
  return agentRows.map(a => {
    const t =
      byKey.get(`${a.teamId}::${a.agentShort}`) ||
      byKey.get(`${a.rooftop}::${a.agentShort}`) ||
      null;
    return {
      ...a,
      leadsInteracted: t ? (t.leadsInteracted ?? 0) : null,
      appointments:    t ? (t.appointments    ?? 0) : null,
      abr:             t ? t.abr              : null,   // already 0..1 decimal
    };
  });
}

// ─── ROI Multiple + RAG per agent ────────────────────────────────────────────
//
// RAG model (TOFU + per-agent ABR — replaces the old ROI-multiple cutoffs):
//   leads < TOFU_THRESHOLD              → Red-TOFU       (volume too low)
//   ABR ≥ greenFloor                    → Green
//   ABR ≥ greenFloor × AMBER_RATIO      → Amber
//   else                                → Red-Performance
//   no Metabase row for this agent      → N/A
//
// ROI Multiple is still computed (using premium-aware costPerAppt) and shown
// in the email as a value metric — it just no longer drives RAG.
//
// Returns each row with: roiMultiple, rag ("Green"|"Amber"|"Red"|"N/A"),
//   redKind ("TOFU"|"Performance"|null), abrPct (display %).

export function computeRoiAndRag(joinedRows) {
  const { tofuLeads, roiGreen, roiAmber } = RAG_THRESHOLDS;

  return joinedRows.map(a => {
    const cpa = costPerAppt(a);                       // premium-aware
    const monthlyCost = a.mrr;

    let roiMultiple = null;
    if (a.appointments != null && cpa != null && monthlyCost > 0) {
      roiMultiple = (a.appointments * cpa) / monthlyCost;
    }

    // No N/A bucket in Live — per Mehul's note "there is no such thing as
    // N/A in live, make it Red". Agents without Metabase data fall to Red
    // with no specific redKind (neither pure TOFU nor pure Performance).
    let rag = "Red";
    let redKind = null;

    if (a.appointments != null && a.leadsInteracted != null && cpa != null) {
      if (a.leadsInteracted < tofuLeads) {
        rag = "Red"; redKind = "TOFU";
      } else if (roiMultiple != null && roiMultiple >= roiGreen) {
        rag = "Green";
      } else if (roiMultiple != null && roiMultiple >= roiAmber) {
        rag = "Amber";
      } else {
        rag = "Red"; redKind = "Performance";
      }
    }

    return {
      ...a,
      costPerAppt:     cpa,
      roiMultiple,
      rag,
      redKind,
      abrPct:          a.abr != null ? a.abr * 100 : null,
    };
  });
}

// ─── Summarizer ──────────────────────────────────────────────────────────────

/**
 * Builds the email payload from scored agents:
 *   • header.live  — Live cohort count + ARR
 *   • header.churn — Churned cohort count + ARR
 *   • byAgentType  — Live RAG matrix (G/A/R/N-A) per agent type
 *   • whyNotGreen  — TOFU vs Performance per agent type
 *   • portfolio    — weighted ROI + appt totals
 */
export function summarizeVini(scored) {
  const live  = scored.filter(a => a.stage === "Live");
  const churn = scored.filter(a => a.stage === "Churned");

  const sumArr = list => list.reduce((s, r) => s + (r.arr || 0), 0);

  // RAG matrix per agent type (LIVE only). N/A is gone — collapsed into Red
  // upstream. Per-bucket ARR added so the template can show count + ARR in
  // each cell ("wherever you see count, add ARR in the same cell").
  const byAgentType = AGENT_ORDER.map(label => {
    const slice  = live.filter(a => a.agentShort === label);
    const greens = slice.filter(a => a.rag === "Green");
    const ambers = slice.filter(a => a.rag === "Amber");
    const reds   = slice.filter(a => a.rag === "Red");
    const churns = churn.filter(a => a.agentShort === label);
    return {
      label,
      live:     slice.length,
      green:    greens.length,
      amber:    ambers.length,
      red:      reds.length,
      churn:    churns.length,
      arr:      sumArr(slice),
      greenArr: sumArr(greens),
      amberArr: sumArr(ambers),
      redArr:   sumArr(reds),
      churnArr: sumArr(churns),
    };
  }).filter(b => b.live + b.churn > 0);

  // Manual RAG overrides removed 2026-05-30 — formula runs pure now that
  // ROI-based thresholds + premium-dealer costs are in place.

  // Why-not-green: covers EVERY non-Green Live agent so the bucket sums
  // reconcile to Live − Green. Three buckets per agent type:
  //   • TOFU         — leads < 100 (volume problem)
  //   • Performance  — leads OK but ROI < amber floor (conversion problem)
  //   • Amber        — borderline; not red but not Green either
  //   • No data      — Live agent absent from Metabase totals card (data gap)
  // Sum of all four across all agent types == (Live count − Green count).
  const whyNotGreen = {
    threshold: RAG_THRESHOLDS.tofuLeads,
    blocks: AGENT_ORDER.map(label => {
      const slice  = live.filter(a => a.agentShort === label && a.rag !== "Green");
      const tofu   = slice.filter(a => a.rag === "Red"   && a.redKind === "TOFU");
      const perf   = slice.filter(a => a.rag === "Red"   && a.redKind === "Performance");
      const amber  = slice.filter(a => a.rag === "Amber");
      const noData = slice.filter(a => a.rag === "Red"   && a.redKind == null);
      return {
        agentType: label,
        tofu:        { count: tofu.length,   arr: sumArr(tofu)   },
        performance: { count: perf.length,   arr: sumArr(perf)   },
        amber:       { count: amber.length,  arr: sumArr(amber)  },
        noData:      { count: noData.length, arr: sumArr(noData) },
        total:       slice.length,
      };
    }).filter(b => b.total > 0),
  };

  // Portfolio totals — ARR-weighted ROI across LIVE agents that have a score
  let arrSum = 0, roiW = 0, apptsTotal = 0, callsTotal = 0;
  for (const a of live) {
    if (a.appointments != null)    apptsTotal += a.appointments;
    if (a.leadsInteracted != null) callsTotal += a.leadsInteracted;
    if (a.roiMultiple != null && a.arr > 0) {
      arrSum += a.arr;
      roiW   += a.roiMultiple * a.arr;
    }
  }
  const portfolioRoi = arrSum > 0 ? roiW / arrSum : null;

  // Top Red / Green pools — expose the top 15 by ARR (sorted desc). The
  // preview script picks the daily "Top 3" out of these pools, rotating to
  // avoid showing the same 3 rooftops every day (per Mehul 15-Jun feedback).
  const topReds = live
    .filter(a => a.rag === "Red" && !isExcluded(a))
    .sort((x, y) => (y.arr || 0) - (x.arr || 0))
    .slice(0, 15);

  const topWins = live
    .filter(a => a.rag === "Green" && !isExcluded(a))
    .sort((x, y) => (y.arr || 0) - (x.arr || 0))
    .slice(0, 15);

  // Distinct rooftop / account counts per lifecycle stage — needed for the
  // Contracted → OB → Live → Churned funnel table in v2.
  const distinct = (list, key) => new Set(list.map(a => a[key]).filter(Boolean)).size;

  return {
    live: {
      count:    live.length,
      arr:      sumArr(live),
      rooftops: distinct(live, "teamId") || distinct(live, "rooftop"),
      accounts: distinct(live, "enterpriseId") || distinct(live, "account"),
    },
    churn: {
      count:    churn.length,
      arr:      sumArr(churn),
      rooftops: distinct(churn, "teamId") || distinct(churn, "rooftop"),
      accounts: distinct(churn, "enterpriseId") || distinct(churn, "account"),
    },
    byAgentType,
    whyNotGreen,
    portfolio: {
      roi:           portfolioRoi,
      appointments:  apptsTotal,
      calls:         callsTotal,
      scoredAgents:  live.length,   // every Live agent is now scored (no N/A)
      naAgents:      0,
    },
    topReds,
    topWins,
  };
}
