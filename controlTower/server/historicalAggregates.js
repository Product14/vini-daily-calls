// ─── Historical metric aggregates for per-agent trend tables ───────────────
// CEO 17-Jun: per-agent rows should show MTD · D-1 · D-2 · D-3 · M-1 · M-2 · M-3
// for each metric (# Live · % Green · % All Clear · ABR).
//
// Data sources:
//   - AGENTS_DAILY Metabase card → per-(day × team × agent_type) rows
//     used for: # active rooftops, ABR (sum appts ÷ sum leads)
//   - data/snapshots/email-YYYY-MM-DD.json → daily RAG matrix
//     used for: % Green (Green / Live per agent type)
//   - data/superbryn/YYYY-MM-DD/<call>.json → quality verdicts
//     used for: % All Clear (analyzed only — historical only as far back as
//     2026-06-12 when we started caching)
//
// Returns: { byAgent: { "Sales IB": { liveAgents:{...}, pctGreen:{...},
//                                     pctAllClear:{...}, abr:{...} } } }
// Each metric obj has keys: mtd, d1, d2, d3, m1, m2, m3

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchDailyRows } from "./agentsSource.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR  = join(__dirname, "..", "data", "snapshots");
const SUPER_DIR = join(__dirname, "..", "data", "superbryn");

const AGENT_LABELS = {
  "Sales Inbound":    "Sales IB",
  "Sales Outbound":   "Sales OB",
  "Service Inbound":  "Service IB",
  "Service Outbound": "Service OB",
};
export const AGENT_ORDER = ["Sales IB", "Service IB", "Sales OB", "Service OB"];

function todayIST() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = ist.getFullYear(), m = String(ist.getMonth() + 1).padStart(2, "0"), d = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function addDays(yyyymmdd, n) {
  const d = new Date(yyyymmdd + "T12:00:00+05:30");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function monthKey(yyyymmdd) { return yyyymmdd.slice(0, 7); }
function priorMonthKey(yyyymm, n) {
  const [y, m] = yyyymm.split("-").map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ─── Source 1: ClickHouse conversation spine (per day × team × agent_type) ───
// Was the AGENTS_DAILY Metabase card; now the canonical spine via agentsSource
// (memoized there for the whole run). Same row shape the card returned, plus
// total_sms_conversations.
const fetchDaily = fetchDailyRows;

// Per agent × day → full set of aggregates from the Metabase daily card.
// Mirrors the columns in the Studio Health Report screenshot the CEO shared
// 18-Jun (% Rooftops w/ appt, ABR, Transfer, Call connection, SMS reply,
// Rooftops w/ activity, Rooftops w/ appointment, leads, qualified, appts,
// total calls, total SMS).
function aggregateDailyMetabase(rows) {
  const idx = new Map();        // `${day}|${agent}` → aggregates
  for (const r of rows) {
    const ag = AGENT_LABELS[r.agent_type];
    if (!ag) continue;
    const key = `${r.day}|${ag}`;
    if (!idx.has(key)) idx.set(key, {
      teamsActive: new Set(),     // rooftops with any activity
      teamsAppt:   new Set(),     // rooftops with at least 1 appointment
      leads:       0,             // unique leads touched
      qualified:   0,             // qualified_leads
      appts:       0,
      totalCalls:  0,
      leadsWithCalls: 0,
      totalSms:    0,
      leadsWithSms:0,
      transfers:   0,
      callbacks:   0,
      warmLeads:   0,             // appointment_intent_leads (warm cohort)
    });
    const v = idx.get(key);
    if (r.team_id) v.teamsActive.add(r.team_id);
    const ap = Number(r.appointments || 0);
    if (r.team_id && ap > 0) v.teamsAppt.add(r.team_id);
    v.leads          += Number(r.touched_leads || 0);
    v.qualified      += Number(r.qualified_leads || 0);
    v.appts          += ap;
    v.totalCalls     += Number(r.total_calls || 0);
    v.leadsWithCalls += Number(r.leads_with_calls || 0);
    v.totalSms       += Number(r.total_sms_conversations || 0);
    v.leadsWithSms   += Number(r.leads_with_sms || 0);
    v.transfers      += Number(r.transfer_leads || 0);
    v.callbacks      += Number(r.callback_leads || 0);
    v.warmLeads      += Number(r.appointment_intent_leads || 0);
  }
  return idx;
}

// ─── Source 2: snapshot history (for % Green + raw blobs) ──────────────────
// Returns { snaps, raw } so callers can access either the simplified
// per-agent live/green index or the full saved snapshot blob (used by
// Blocked ARR which reads obByAgent[i].upsideArr historically).
function readSnapshots() {
  if (!existsSync(SNAP_DIR)) return { snaps: {}, raw: {} };
  const snaps = {};   // day → { agent → { live, green } }
  const raw   = {};   // day → full saved JSON blob
  for (const f of readdirSync(SNAP_DIR)) {
    const m = f.match(/^email-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    try {
      const d = JSON.parse(readFileSync(join(SNAP_DIR, f), "utf8"));
      const day = m[1];
      raw[day] = d;
      snaps[day] = {};
      for (const b of (d.ragByAgent || [])) {
        snaps[day][b.label] = { live: b.live || 0, green: b.green || 0 };
      }
    } catch { /* skip corrupt */ }
  }
  return { snaps, raw };
}

// ─── Source 3: Superbryn cache for % All Clear (historical) ───────────────
// Walks data/superbryn/<date>/ — for each cached call detail, classify the
// agent_id and audit_verdict, then compute share of TN ("All Clear") per
// (day × agent). agent_id → label mapping is fixed below from the 4 keys.
const SUPER_AGENT_BY_ID = {
  "5b30d169-3339-4242-96ec-eb748a302548": "Sales IB",
  "c583fb70-bb2a-40b1-8212-ac5870edacf6": "Sales OB",
  "0c0cc331-d47b-4d10-971e-5a25fa343800": "Service IB",
  "de76bba1-247f-46b0-9ee5-dd60920cc49e": "Service OB",
};
function readSuperbrynHistory() {
  if (!existsSync(SUPER_DIR)) return {};
  const out = {};   // day → { agent → { analyzed, allClear } }
  for (const dayDir of readdirSync(SUPER_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDir)) continue;
    const day = dayDir;
    const dir = join(SUPER_DIR, dayDir);
    if (!statSync(dir).isDirectory()) continue;
    out[day] = {};
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (!c.audit_verdict) continue;
        const ag = SUPER_AGENT_BY_ID[c.agent_id];
        if (!ag) continue;
        // Use the call's started_at date (when the call happened), not the
        // cache directory date (when we fetched it).
        const callDay = (c.started_at || c.created_at || "").slice(0, 10) || day;
        if (!out[callDay]) out[callDay] = {};
        if (!out[callDay][ag]) out[callDay][ag] = { analyzed: 0, allClear: 0 };
        out[callDay][ag].analyzed += 1;
        if (c.audit_verdict === "TN") out[callDay][ag].allClear += 1;
      } catch { /* skip */ }
    }
  }
  return out;
}

// ─── Public API ────────────────────────────────────────────────────────────
/**
 * Build the historical metrics matrix for every agent type.
 *
 * @param {object} opts
 * @param {object} opts.todaySnapshot — today's snapshot (RAG matrix) so we
 *   can include "today" alongside D-1/D-2 from history. Pass `null` to skip.
 * @param {object} opts.todayQuality — today's Superbryn quality (per agent)
 *   so we can include today's % All Clear without needing a saved snapshot.
 * @returns {Promise<{ byAgent: object, asOfDate: string, dates: object }>}
 */
export async function buildHistoricalMetrics({ todaySnapshot, todayQuality, obSummary } = {}) {
  const today = todayIST();
  const d1 = addDays(today, -1);
  const d2 = addDays(today, -2);
  const d3 = addDays(today, -3);
  const thisMonth = monthKey(today);
  const m1 = priorMonthKey(thisMonth, 1);
  const m2 = priorMonthKey(thisMonth, 2);
  const m3 = priorMonthKey(thisMonth, 3);

  const dailyRows = await fetchDaily();
  const dailyIdx  = aggregateDailyMetabase(dailyRows);
  const { snaps, raw: rawSnaps } = readSnapshots();
  const superHist = readSuperbrynHistory();

  // ─── Per-agent metric assembly ───────────────────────────────────────────
  const byAgent = {};
  for (const agent of AGENT_ORDER) {
    // Sum + distinct-rooftop aggregates across a date range.
    const aggRange = (from, to) => {
      const teamsActive = new Set(), teamsAppt = new Set();
      let leads = 0, qualified = 0, appts = 0;
      let totalCalls = 0, leadsWithCalls = 0;
      let totalSms = 0, leadsWithSms = 0;
      let transfers = 0, warmLeads = 0;
      for (const [k, v] of dailyIdx) {
        const [day, ag] = k.split("|");
        if (ag !== agent) continue;
        if (day < from || day > to) continue;
        v.teamsActive.forEach(t => teamsActive.add(t));
        v.teamsAppt.forEach(t => teamsAppt.add(t));
        leads          += v.leads;
        qualified      += v.qualified;
        appts          += v.appts;
        totalCalls     += v.totalCalls;
        leadsWithCalls += v.leadsWithCalls;
        totalSms       += v.totalSms;
        leadsWithSms   += v.leadsWithSms;
        transfers      += v.transfers;
        warmLeads      += v.warmLeads;
      }
      // ABR denominator policy (user 26-Jun):
      //   • Sales IB / Service OB  → appts ÷ leads_touched
      //   • Sales OB / Service IB  → appts ÷ qualified_calls
      // Both outbound and inbound-service get over-counted denominators if
      // we use raw lead volume, so we use the qualified subset for those.
      const usesQualified = agent === "Sales OB" || agent === "Service IB";
      const abrDenom = usesQualified ? qualified : leads;
      return {
        rooftopsActive:    teamsActive.size,
        rooftopsAppt:      teamsAppt.size,
        leads, qualified, appts,
        totalCalls, leadsWithCalls,
        totalSms, leadsWithSms,
        transfers, warmLeads,
        // Derived ratios
        abr:               abrDenom > 0 ? appts / abrDenom : null,
        abrDenom,                                                // surfaced for portfolio aggregation
        pctRooftopsAppt:   teamsActive.size > 0 ? teamsAppt.size / teamsActive.size : null,
        callConnection:    totalCalls > 0 ? leadsWithCalls / totalCalls : null,
        smsReply:          totalSms   > 0 ? leadsWithSms   / totalSms   : null,
        transferRate:      leads > 0 ? transfers / leads : null,
      };
    };
    // % Green = LATEST snapshot's green/live ratio in the range (user 26-Jun
    // fix). Was averaging across days; that blended new-threshold readings
    // with historical ones taken under the old 5× ROI bar, which produced
    // values like 5% MTD when today's reading is actually 17%. Latest-in-
    // range matches stakeholder intuition: "% Green for that day."
    //
    // Weekend-gap fallback unchanged — single-day windows look back up to
    // 7 days to fill Sat/Sun from the nearest snapshot.
    const aggGreen = (from, to) => {
      const inRange = Object.keys(snaps)
        .filter(d => d >= from && d <= to && snaps[d][agent])
        .sort();
      if (inRange.length) {
        const r = snaps[inRange[inRange.length - 1]][agent];
        return r.live > 0 ? r.green / r.live : 0;
      }
      if (from === to) {
        const fallbackFrom = addDays(from, -7);
        const prior = Object.keys(snaps)
          .filter(d => d >= fallbackFrom && d < from && snaps[d][agent])
          .sort();
        if (prior.length) {
          const r = snaps[prior[prior.length - 1]][agent];
          return r.live > 0 ? r.green / r.live : 0;
        }
      }
      return null;
    };
    // For % All Clear: today only (from todayQuality). History intentionally
    // null until we start saving quality verdicts to snapshots.
    const todayAllClearShare = (() => {
      if (!todayQuality?.agents) return null;
      const a = todayQuality.agents.find(x => x.label === agent);
      if (!a || !a.analyzed) return null;
      return (a.quality?.allClear || 0) / a.analyzed;
    })();
    // Historical % All Clear from cached Superbryn details, summed across
    // a date range. Same weekend-gap fallback as aggGreen.
    const aggAllClear = (from, to) => {
      let analyzed = 0, allClear = 0, days = 0;
      for (const [day, perAg] of Object.entries(superHist)) {
        if (day < from || day > to) continue;
        if (!perAg[agent]) continue;
        analyzed += perAg[agent].analyzed;
        allClear += perAg[agent].allClear;
        days += 1;
      }
      if (!days && from === to) {
        const fallbackFrom = addDays(from, -7);
        const prior = Object.keys(superHist).filter(d => d >= fallbackFrom && d < from && superHist[d][agent]).sort();
        if (prior.length) {
          const r = superHist[prior[prior.length - 1]][agent];
          return r.analyzed > 0 ? r.allClear / r.analyzed : null;
        }
        return null;
      }
      return analyzed > 0 ? allClear / analyzed : null;
    };

    const ranges = {
      mtd: [`${thisMonth}-01`, today],
      d1:  [d1, d1],
      d2:  [d2, d2],
      d3:  [d3, d3],
      m1:  [`${m1}-01`, `${m1}-31`],
      m2:  [`${m2}-01`, `${m2}-31`],
      m3:  [`${m3}-01`, `${m3}-31`],
    };

    const out = {
      liveAgents:     {},   // # Live agents (from snapshots)
      pctGreen:       {},   // % Green
      pctAllClear:    {},   // % All Clear (Superbryn)
      pctBlocked:     {},   // % Blocked in OB (from In_Ob)
      arrBlocked:     {},   // $ ARR blocked in OB (from In_Ob.upsideArr)
      abr:            {},   // appts / leads
      pctRooftopsAppt:{},   // rooftops w/ appt / rooftops w/ activity
      callConnection: {},   // leads_with_calls / total_calls
      smsReply:       {},   // leads_with_sms / total_sms
      transferRate:   {},   // transfer_leads / leads
      warmLeads:      {},   // appointment_intent_leads (warm cohort)
      rooftopsActive: {},
      rooftopsAppt:   {},
      leads:          {},
      qualified:      {},
      appts:          {},
      totalCalls:     {},
      totalSms:       {},
    };

    // Live agent count from daily snapshots. Single-day windows fall back
    // to the nearest prior snapshot within 7 days so weekend cells inherit
    // Friday's value (cron is Mon-Fri).
    const latestLive = (from, to) => {
      const inRange = Object.keys(snaps).filter(d => d >= from && d <= to && snaps[d][agent]).sort();
      if (inRange.length) return snaps[inRange[inRange.length - 1]][agent].live;
      if (from === to) {
        const fallbackFrom = addDays(from, -7);
        const prior = Object.keys(snaps).filter(d => d >= fallbackFrom && d < from && snaps[d][agent]).sort();
        if (prior.length) return snaps[prior[prior.length - 1]][agent].live;
      }
      return null;
    };
    // Historical Blocked ARR comes from the per-day snapshot's obByAgent[i]
    // .upsideArr field — we've been saving that since the OB section was
    // added, so D-1/D-2/D-3 and even prior months fill in for any day a
    // snapshot exists. Single-day windows use the weekend-gap fallback.
    const arrBlockedFromSnap = (from, to) => {
      const dayVal = (d) => {
        const ob = (rawSnaps[d]?.obByAgent || []).find(b => b.label === agent);
        return ob ? (ob.upsideArr || 0) : null;
      };
      const inRange = Object.keys(rawSnaps).filter(d => d >= from && d <= to && dayVal(d) != null).sort();
      if (inRange.length) return dayVal(inRange[inRange.length - 1]);
      if (from === to) {
        const fallbackFrom = addDays(from, -7);
        const prior = Object.keys(rawSnaps).filter(d => d >= fallbackFrom && d < from && dayVal(d) != null).sort();
        if (prior.length) return dayVal(prior[prior.length - 1]);
      }
      return null;
    };

    for (const [key, [from, to]] of Object.entries(ranges)) {
      const r = aggRange(from, to);
      out.liveAgents[key]     = latestLive(from, to);
      out.pctGreen[key]       = aggGreen(from, to);
      out.pctAllClear[key]    = aggAllClear(from, to);
      out.pctBlocked[key]     = null;     // filled from today's In_Ob below
      out.arrBlocked[key]     = arrBlockedFromSnap(from, to);
      out.abr[key]            = r.abr;
      out.pctRooftopsAppt[key]= r.pctRooftopsAppt;
      out.callConnection[key] = r.callConnection;
      out.smsReply[key]       = r.smsReply;
      out.transferRate[key]   = r.transferRate;
      out.warmLeads[key]      = r.warmLeads || null;
      out.rooftopsActive[key] = r.rooftopsActive || null;
      out.rooftopsAppt[key]   = r.rooftopsAppt   || null;
      out.leads[key]          = r.leads          || null;
      out.qualified[key]      = r.qualified      || null;
      out.appts[key]          = r.appts          || null;
      out.totalCalls[key]     = r.totalCalls     || null;
      out.totalSms[key]       = r.totalSms       || null;
    }

    // Today's snapshot + today's quality fill the d1 slot if missing.
    if (todaySnapshot?.ragByAgent) {
      const b = todaySnapshot.ragByAgent.find(x => x.label === agent);
      if (b && out.liveAgents.d1 == null) {
        out.liveAgents.d1 = b.live;
        out.pctGreen.d1   = b.live > 0 ? b.green / b.live : 0;
      }
    }
    if (todayAllClearShare != null) {
      out.pctAllClear.d1 = todayAllClearShare;
      out.pctAllClear.mtd = todayAllClearShare;  // best we have
    }

    // % Blocked: today's In_Ob has confirmed/upside per agent. Fill the d1
    // and mtd slots so the column isn't empty. Historical comes from
    // snapshots once we save it daily.
    if (obSummary?.byAgentType) {
      const b = obSummary.byAgentType.find(x => x.label === agent);
      if (b && b.count > 0) {
        const blockedShare = b.upside / b.count;
        out.pctBlocked.d1  = blockedShare;
        out.pctBlocked.mtd = blockedShare;
        // Dollar ARR blocked — user 23-Jun: "show ARR blocked instead of %".
        out.arrBlocked.d1  = b.upsideArr || 0;
        out.arrBlocked.mtd = b.upsideArr || 0;
      }
    }

    byAgent[agent] = out;
  }

  return {
    asOfDate: today,
    dates: { today, d1, d2, d3, m1, m2, m3 },
    byAgent,
    // Suppress unused-var lint for the placeholder.
    _superHist: superHist,
  };
}
