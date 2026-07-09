// Run: node scripts/previewAgentsEmail.js
//
// Pipeline (2 Jun rebuild):
//   • Vini Master Sheet (single source for the 4 lifecycle stages)
//       - Contracted_Vini  → contracted funnel stage
//       - In_Ob            → onboarding pipeline
//       - Live & Churned   → live + churn cohort (+ MRR for the RAG join)
//       - Blocked_Reason   → top-5 OB blocker reasons (grouped by `Blocked At`)
//   • ClickHouse conversation spine via agentsSource (totals + daily) →
//     appointments/leads for RAG, daily usage tile for yesterday's pulse.
//     Same source of truth as /api/agents (replaces the old agents_v2 cards).
//
// RAG: < 100 leads → Red·TOFU; ROI ≥ 5× Green; 3–5× Amber; < 3× Red·Performance.
// ROI Multiple = (appts × cost-per-appt) ÷ MRR. Premium dealers $750/appt.

import { buildAgentsEmailHtml } from "../server/agentsEmailTemplate.js";
import { snapshotAndCommentate } from "../server/dailySnapshot.js";
import { fetchAgentsTotals, fetchAgentsDaily } from "../server/agentsSource.js";
import { joinAppointments, computeRoiAndRag, summarizeVini,
         COST_PER_APPT, RAG_THRESHOLDS } from "../server/viniAgentTracker.js";
import {
  fetchContractedAgents, summarizeContracted,
  fetchInOb,              summarizeInOb,
  fetchLiveAndChurned,    summarizeLiveChurned,
  fetchBlockedReasons,    topBlockerReasons,
  fetchAgeing,            summarizeAgeing,
} from "../server/viniMasterSheet.js";
import { fetchAllQuality } from "../server/superbrynQuality.js";
import { buildHistoricalMetrics } from "../server/historicalAggregates.js";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Inline .env loader (avoid adding the dotenv dep).
(function loadDotenv() {
  // Repo-root .env — shared with the parent project (CLICKHOUSE_* live there)
  // plus the control-tower vars (VINI_MASTER_SHEET_ID, SUPERBRYN_KEY_*, …).
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    let val   = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const DASHBOARD_URL = "https://vini-daily-calls.vercel.app/agents";

console.log("→ Fetching Vini Master sheet (4 tabs) + agent spine (ClickHouse) + Superbryn quality…");
const [
  contractedRows, inObRows, liveChurnRows, blockerRows, ageingRows,
  totals, daily, quality,
] = await Promise.all([
  fetchContractedAgents(),
  fetchInOb(),
  fetchLiveAndChurned(),
  fetchBlockedReasons(),
  fetchAgeing(),
  fetchAgentsTotals(),
  fetchAgentsDaily(),
  fetchAllQuality({ lookbackHours: 24 }).catch(e => {
    console.error("✗ Superbryn fetch failed:", e.message);
    return null;
  }),
]);
if (quality) {
  console.log(`  Superbryn: ${quality.agents.length} agents · window=${quality.lookbackHours}h`);
  for (const a of quality.agents) {
    if (a.error) console.log(`    ${a.label.padEnd(11)} ERROR · ${a.error}`);
    else        console.log(`    ${a.label.padEnd(11)} ingested=${a.ingested}  analyzed=${a.analyzed}  AC/BS/FA/RA=${a.quality.allClear}/${a.quality.blindSpot}/${a.quality.falseAlarm}/${a.quality.redAlert}  topIssues=${a.topIssues.length}`);
  }
}
// Ageing is summarised below (after we have the churn cohort) so churned
// enterprises can be filtered out before bucketing.

const contracted   = summarizeContracted(contractedRows);
const obSummary    = summarizeInOb(inObRows);
const liveAndChurn = summarizeLiveChurned(liveChurnRows);
const topBlockers5 = topBlockerReasons(blockerRows, 5);

console.log(`✓ Master: ${contractedRows.length} contracted · ${inObRows.length} In_Ob · ${liveChurnRows.length} Live+Churn (${liveAndChurn.live.count} Live / ${liveAndChurn.churn.count} Churn) · ${blockerRows.length} blocker rows`);
console.log(`  Agent spine totals: ${totals.length} rows · daily ${daily.asOfDate} (${daily.rowCount} rows)`);

// Live cohort → join Metabase appointments → score RAG.
// viniAgentTracker.joinAppointments needs { teamId, rooftop, agentShort, mrr,
// account } — master sheet's Live & Churned rows already carry these.
const scored = computeRoiAndRag(joinAppointments(liveAndChurn.live.rows, totals));
// summarizeVini consumes raw scored agents and needs the `stage` field.
// Our live rows are all stage="Live"; merge in the churn rows so the
// summarizer's live/churn split works the same way.
const allScored = [
  ...scored,                                       // every Live agent with computed RAG
  ...liveAndChurn.churn.rows.map(c => ({           // churn rows (no scoring needed)
    ...c, rag: "Red", redKind: null, roiMultiple: null,
  })),
];
const vini = summarizeVini(allScored);

// ─── Rotate the Top 3 lists daily ──────────────────────────────────────────
// summarizeVini returns top 15 candidates per side (Wins / REDs) ordered by
// ARR. To avoid showing the same 3 every day (Mehul 15-Jun: "everyday show
// different 3"), exclude rooftops that appeared in the last 3 days' picks
// and take the top 3 of what remains. Falls back to the raw top 3 if the
// exclusion would leave fewer than 3.
const SNAP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "snapshots");
function recentPicks(field, days = 3) {
  if (!existsSync(SNAP_DIR)) return new Set();
  const files = readdirSync(SNAP_DIR)
    .filter(f => /^email-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-days);
  const seen = new Set();
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(SNAP_DIR, f), "utf8"));
      for (const r of (d[field] || []))
        seen.add(`${r.rooftop || r.account}|${r.agentShort}`);
    } catch { /* skip corrupt snapshots */ }
  }
  return seen;
}
function pickRotated(pool, recent, n = 3) {
  const fresh = pool.filter(a =>
    !recent.has(`${a.rooftop || a.account}|${a.agentShort}`));
  // If we have at least n fresh, use them. Otherwise fall back to raw top-n.
  return (fresh.length >= n ? fresh : pool).slice(0, n);
}
{
  const recentWins = recentPicks("topWins");
  const recentReds = recentPicks("topReds");
  vini.topWins = pickRotated(vini.topWins, recentWins, 3);
  vini.topReds = pickRotated(vini.topReds, recentReds, 3);
  console.log(`  Rotation: excluded ${recentWins.size} wins / ${recentReds.size} reds from last 3 days`);
}

// Strict source-of-truth per 2 Jun directive:
//   • In_Ob          → OB count + ARR + Confirmed/Upside split per agent
//                      (via "Current Month Confirmations" column:
//                       Confirmed = Unblocked, Upside = Blocked)
//   • Blocked_Reason → top-5 reasons list ONLY (analytical, not for counts)
const obRawShape = {
  ...obSummary,
  // Hero "blocked" tile now reads Upside from In_Ob (single source).
  blockedCount:  obSummary.upsideCount,
  blockedArr:    obSummary.upsideArr,
  blockBuckets:  topBlockers5,
};

const greenPct = vini.live.count > 0
  ? Math.round((vini.byAgentType.reduce((s, b) => s + b.green, 0) / vini.live.count) * 100)
  : 0;

// ─── Churn bucket ──────────────────────────────────────────────────────────
// Per 6-Jun directive: stick to the Live & Churned tab as the single source
// of truth for Churn. OB Drops / Sales Drops are tracked separately in the
// OB pipeline and do not collapse into this number. Keeps the headline
// stable (~$130K) and lets each tab stay its own source of truth.
const churnLumped = {
  count:    liveAndChurn.churn.count,
  arr:      liveAndChurn.churn.arr,
  accounts: liveAndChurn.churn.accounts,
  rooftops: liveAndChurn.churn.rooftops,
};
console.log(`  Churn (Live & Churned tab): ${churnLumped.count} agents · $${churnLumped.arr.toLocaleString()}`);

// Filter Ageing — drop any row whose enterpriseId is a churned account, so
// the "Contracting age · N accounts not yet fully live" card doesn't count
// accounts that have already exited.
const churnedEnterpriseIds = new Set(
  liveAndChurn.churn.rows.map(r => r.enterpriseId).filter(Boolean)
);
const ageingFiltered = (() => {
  const before = ageingRows.length;
  const kept = ageingRows.filter(r => !churnedEnterpriseIds.has(r.enterpriseId));
  console.log(`  Ageing: ${before} → ${kept.length} (removed ${before - kept.length} churned)`);
  return summarizeAgeing(kept);
})();

const payload = {
  header: {
    liveCount: vini.live.count,
    liveArr:   vini.live.arr,
    obCount:   obSummary.totalCount,
    obArr:     obSummary.totalArr,
  },
  hero: {
    liveArr:    vini.live.arr,
    liveCount:  vini.live.count,
    greenPct,
    obArr:      obSummary.totalArr,
    obCount:    obSummary.totalCount,
    obBlocked:  obRawShape.blockedCount,
    churnArr:   churnLumped.arr,
    churnCount: churnLumped.count,
  },
  sec1: {
    byAgentType:        vini.byAgentType,
    whyNotGreen:        vini.whyNotGreen,
    topReds:            vini.topReds,
    topWins:            vini.topWins,
    usage: {
      portfolio: { weightedRoi: vini.portfolio.roi },
      daily,
    },
    costPerAppt:   COST_PER_APPT,
    ragThresholds: RAG_THRESHOLDS,
  },
  sec2: {
    funnelV2: {
      contracted: {
        accounts: contracted.accounts,
        rooftops: contracted.rooftops,
        agents:   contracted.count,
        arr:      contracted.arr,
      },
      ob: {
        accounts: obSummary.accounts,
        rooftops: obSummary.rooftops,
        agents:   obSummary.totalCount,
        arr:      obSummary.totalArr,
      },
      live: {
        accounts: vini.live.accounts,
        rooftops: vini.live.rooftops,
        agents:   vini.live.count,
        arr:      vini.live.arr,
      },
      churned: {
        accounts: churnLumped.accounts,
        rooftops: churnLumped.rooftops,
        agents:   churnLumped.count,
        arr:      churnLumped.arr,
      },
    },
    obRaw: obRawShape,
    ageing: ageingFiltered,
    liveChurnPending: false,
  },
};

const nowIST = new Date().toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
}).toUpperCase().replace(/\s+/g, " ");

// Attach Superbryn quality data for the new Live Agent Quality section.
payload.quality = quality;

// Take a daily snapshot + compute commentary deltas vs yesterday's snapshot
const { commentary, priorDate, todayDate, deltas } = snapshotAndCommentate(payload);
payload.commentary = commentary;
payload.deltas     = deltas || null;     // null on the very first run

// Merge quality pp deltas into each agent block so the Quality section can
// render "+4pp / −16pp" badges next to today's verdict counts.
if (payload.quality?.agents && deltas?.qualityByAgent) {
  for (const a of payload.quality.agents) {
    const d = deltas.qualityByAgent.find(x => x.label === a.label);
    if (d?.qualityDeltaPp) a.qualityDeltaPp = d.qualityDeltaPp;
  }
}

// Build the per-agent historical metrics matrix (MTD · D-1/2/3 · M-1/2/3).
// Requires the snapshot from above to be saved already so today's RAG counts
// are part of the corpus we pull from. dailySnapshot.js saves *before* it
// returns commentary, so we're good.
try {
  const todaySnap = {
    ragByAgent: vini.byAgentType.map(b => ({ label: b.label, live: b.live, green: b.green })),
  };
  payload.historical = await buildHistoricalMetrics({
    todaySnapshot: todaySnap,
    todayQuality:  quality,
    obSummary,
    liveRows: liveAndChurn.live.rows,   // period-aware ROI Multiple (all columns)
  });

  // Per-agent funnel ARRs for the trend-card header (CEO 18-Jun: "CARR → in
  // OB → Live ARR" instead of "X live · Y% green · Z% all clear").
  payload.perAgentArr = {};
  payload.perAgentRoi = {};      // ARR-weighted ROI Multiple per agent type
  for (const agent of ["Sales IB", "Service IB", "Sales OB", "Service OB"]) {
    const cArr  = contractedRows
      .filter(r => r.agentShort === agent)
      .reduce((s, r) => s + (r.arr || 0), 0);
    const obArr = obSummary.byAgentType.find(b => b.label === agent)?.arr || 0;
    const liveB = vini.byAgentType.find(b => b.label === agent);
    const liveArr = liveB ? (liveB.greenArr || 0) + (liveB.amberArr || 0) + (liveB.redArr || 0) : 0;
    payload.perAgentArr[agent] = { cArr, obArr, liveArr };

    // Mehul whiteboard (applied 26-Jun): per-agent ROI Multiple, ARR-weighted.
    let arrSum = 0, roiW = 0;
    for (const a of scored) {
      if (a.agentShort !== agent) continue;
      if (a.roiMultiple == null || a.arr == null) continue;
      roiW   += a.roiMultiple * a.arr;
      arrSum += a.arr;
    }
    payload.perAgentRoi[agent] = arrSum > 0 ? roiW / arrSum : null;
    // ROI Multiple in the trend table now comes period-aware from
    // buildHistoricalMetrics (every column) — no longer overwritten here.
  }
  console.log(`  Historical: MTD/D-1..3/M-1..3 computed for ${Object.keys(payload.historical.byAgent).length} agents`);
} catch (e) {
  console.error("✗ Historical aggregates failed:", e.message);
  payload.historical = null;
}
console.log(`  Commentary: ${priorDate ? `vs ${priorDate}` : "baseline " + todayDate}`);
if (deltas?.redMovement) {
  console.log(`  Red list movement: +${deltas.redMovement.added.length} new, ${deltas.redMovement.stayed.length} persistent, ${deltas.redMovement.dropped.length} dropped`);
}

const html = buildAgentsEmailHtml(payload, `${nowIST} IST`, DASHBOARD_URL);
// Write into controlTower/ (the dir sendVinniReport.js reads from), not the cwd,
// so `ct:send:email` finds the file regardless of where it's invoked.
const HTML_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "agents-preview-2.html");
writeFileSync(HTML_OUT, html);

console.log(`✓ ${HTML_OUT} written`);
console.log(`  Funnel: Contracted ${contracted.count}/$${contracted.arr.toLocaleString()} → OB ${obSummary.totalCount}/$${obSummary.totalArr.toLocaleString()} → Live ${vini.live.count}/$${vini.live.arr.toLocaleString()} → Churn ${churnLumped.count}/$${churnLumped.arr.toLocaleString()}`);
console.log(`  Top blocker reasons (top 5 by ARR):`);
topBlockers5.forEach(t => console.log(`    ${t.key.padEnd(20)} ${t.count} rows · $${t.arr.toLocaleString()}`));
console.log(`  RAG by agent:`);
vini.byAgentType.forEach(b => console.log(`    ${b.label.padEnd(11)} Live=${b.live}  G=${b.green}  A=${b.amber}  R=${b.red}  Churn=${b.churn}`));

try { execSync(`open "${HTML_OUT}"`); } catch (_) { console.log("(open manually)"); }
