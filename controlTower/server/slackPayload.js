// ─── Shared assembly for the Slack "Option B" daily report ──────────────────
// Fetches the same data set as the email, computes the table payload, the
// day-on-day ARR deltas, and a small `guardrail` block the automated sender
// uses to decide whether it's safe to send (never send on a broken/zero feed).

import { fetchAgentsTotals } from "./agentsSource.js";
import {
  fetchContractedAgents, summarizeContracted,
  fetchInOb,             summarizeInOb,
  fetchLiveAndChurned,   summarizeLiveChurned,
} from "./viniMasterSheet.js";
import { joinAppointments, computeRoiAndRag, summarizeVini } from "./viniAgentTracker.js";
import { fetchAllQuality } from "./superbrynQuality.js";
import { buildHistoricalMetrics, AGENT_ORDER } from "./historicalAggregates.js";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");   // controlTower/

export async function assembleSlackPayload() {
  const [contractedRows, obRows, liveChurnRows, totals, quality] = await Promise.all([
    fetchContractedAgents(),
    fetchInOb(),
    fetchLiveAndChurned(),
    fetchAgentsTotals(),
    fetchAllQuality({ lookbackHours: 24 }).catch(() => null),
  ]);
  const contracted = summarizeContracted(contractedRows);
  const obSummary  = summarizeInOb(obRows);
  const liveChurn  = summarizeLiveChurned(liveChurnRows);
  const scored     = computeRoiAndRag(joinAppointments(liveChurn.live.rows, totals));
  const vini       = summarizeVini([
    ...scored,
    ...liveChurn.churn.rows.map(r => ({ ...r, rag: "Red", redKind: null, roiMultiple: null })),
  ]);

  const todaySnap = { ragByAgent: vini.byAgentType.map(b => ({ label: b.label, live: b.live, green: b.green })) };
  const historical = await buildHistoricalMetrics({ todaySnapshot: todaySnap, todayQuality: quality, obSummary });

  const perAgentArr = {};
  for (const agent of AGENT_ORDER) {
    const cArr  = contractedRows.filter(r => r.agentShort === agent).reduce((s, r) => s + (r.arr || 0), 0);
    const obArr = obSummary.byAgentType.find(b => b.label === agent)?.arr || 0;
    const liveB = vini.byAgentType.find(b => b.label === agent);
    const liveArr = liveB ? (liveB.greenArr || 0) + (liveB.amberArr || 0) + (liveB.redArr || 0) : 0;
    perAgentArr[agent] = { cArr, obArr, liveArr };

    let arrSum = 0, roiW = 0;
    for (const a of scored) {
      if (a.agentShort !== agent) continue;
      if (a.roiMultiple == null || a.arr == null) continue;
      roiW += a.roiMultiple * a.arr; arrSum += a.arr;
    }
    const roi = arrSum > 0 ? roiW / arrSum : null;
    if (historical?.byAgent?.[agent]) {
      historical.byAgent[agent].roiMultiple = { mtd: roi, d1: roi, d2: null, d3: null, m1: null, m2: null, m3: null };
    }
  }

  // Day-on-day ARR movement vs the most recent prior snapshot.
  const SNAP_DIR = join(ROOT, "data", "snapshots");
  const arrDeltas = (() => {
    if (!existsSync(SNAP_DIR)) return {};
    const todayDate = historical.dates.today;
    const files = readdirSync(SNAP_DIR)
      .filter(f => /^email-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace(/^email-|\.json$/g, ""))
      .filter(d => d < todayDate).sort();
    if (!files.length) return {};
    let prior;
    try { prior = JSON.parse(readFileSync(join(SNAP_DIR, `email-${files[files.length - 1]}.json`), "utf8")); } catch { return {}; }
    const out = {};
    for (const agent of AGENT_ORDER) {
      const cur = perAgentArr[agent] || {};
      const prv = prior.perAgentArr?.[agent];
      const prvOb   = prv?.obArr   ?? (prior.obByAgent || []).find(b => b.label === agent)?.arr;
      const prvLive = prv?.liveArr ?? (() => {
        const r = (prior.ragByAgent || []).find(b => b.label === agent);
        return r ? (r.greenArr || 0) + (r.amberArr || 0) + (r.redArr || 0) : null;
      })();
      out[agent] = {
        cArr:    prv?.cArr != null ? cur.cArr - prv.cArr : null,
        obArr:   prvOb     != null ? cur.obArr - prvOb   : null,
        liveArr: prvLive   != null ? cur.liveArr - prvLive : null,
      };
    }
    return out;
  })();
  const overallArrDeltas = ["cArr", "obArr", "liveArr"].reduce((acc, k) => {
    const vals = AGENT_ORDER.map(a => arrDeltas[a]?.[k]).filter(v => v != null);
    acc[k] = vals.length ? vals.reduce((s, v) => s + v, 0) : null;
    return acc;
  }, {});

  const rag = vini.byAgentType.reduce((acc, b) => {
    acc.green += b.green || 0; acc.amber += b.amber || 0; acc.red += b.red || 0; return acc;
  }, { green: 0, amber: 0, red: 0 });
  rag.total = rag.green + rag.amber + rag.red;

  const dataDay = historical.dates.d1;
  const asOfDate = new Date(dataDay + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });

  // Yesterday's total leads across agents — the "is the spine alive?" signal.
  const AGENTS = AGENT_ORDER;
  const d1Leads = AGENTS.reduce((s, a) => s + (Number(historical.byAgent?.[a]?.leads?.d1) || 0), 0);
  const d1Appts = AGENTS.reduce((s, a) => s + (Number(historical.byAgent?.[a]?.appts?.d1) || 0), 0);

  const payload = {
    asOfDate,
    funnel: {
      contracted: { agents: contracted.count,      arr: contracted.arr      },
      ob:         { agents: obSummary.totalCount,  arr: obSummary.totalArr  },
      live:       { agents: vini.live.count,       arr: vini.live.arr       },
      churned:    { agents: liveChurn.churn.count, arr: liveChurn.churn.arr },
    },
    rag,
    byAgent: historical.byAgent,
    perAgentArr,
    arrDeltas,
    overallArrDeltas,
  };

  const guardrail = {
    dataDay,
    contractedCount: contracted.count,
    liveCount:       vini.live.count,
    d1Leads,
    d1Appts,
  };

  return { payload, guardrail };
}
