// ─── Vini Master Sheet (single source for all 4 lifecycle stages) ──────────
// Sheet: 15BScfybsSmmvQefXQxN-TYA_-cCNkD8qLDui7EML3ss
// Tabs:
//   • Contracted_Vini  — full signed book
//   • In_Ob            — accounts currently in onboarding
//   • Live & Churned   — agents in Live or Churned stage
//   • Blocked_Reason   — OB blockers w/ bucket + ARR (drives the top-5 reasons)

import Papa from "papaparse";

const SHEET_ID =
  process.env.VINI_MASTER_SHEET_ID ||
  "15BScfybsSmmvQefXQxN-TYA_-cCNkD8qLDui7EML3ss";

const tabUrl = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

const AGENT_LABELS = {
  "Sales Inbound":    "Sales IB",
  "Sales Outbound":   "Sales OB",
  "Service Inbound":  "Service IB",
  "Service Outbound": "Service OB",
};

function clean(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}
function parseDollars(s) {
  if (!s) return 0;
  // Sheet has mixed $ / ₹ symbols + commas — strip all non-digit/decimal
  const n = parseFloat(String(s).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchCsv(tab) {
  const res = await fetch(tabUrl(tab));
  if (!res.ok) throw new Error(`${tab} fetch failed: HTTP ${res.status}`);
  const csv = await res.text();
  const { data } = Papa.parse(csv, { skipEmptyLines: true });
  return data;
}

// ─── Contracted_Vini ─────────────────────────────────────────────────────────
// Header on row 1 (row 0 has the top banner).
// SCHEMA CHECKED 6-Jun-2026 — a column was inserted between Agent and MRR,
// shifting every index ≥3 by +1. Current layout:
//   0 Enterprise · 1 Rooftop · 2 Agent · 3 Agent Start Date · 4 MRR ·
//   5 Billing Plan · 6 Contract Term · 8 Source/Notes · 9 Ent ID ·
//  10 AE Name · 11 Agent Live Date · 12 Team Id · 13 Unique key · 14 OB Stage
// There is no longer a separate "CS Stage" column — col 14 ("OB") holds the
// full lifecycle (Contracted | Not in OB | OB Initiated | Live | Churned |
// OB Drop | Sales Drop).
export async function fetchContractedAgents() {
  const data = await fetchCsv("Contracted_Vini");
  const hdr = data.findIndex(r => (r[0] || "").trim() === "Enterprise/Customer");
  if (hdr < 0) throw new Error("Contracted_Vini header row not found");
  const rows = [];
  for (let i = hdr + 1; i < data.length; i++) {
    const r = data[i];
    const agent = clean(r[2]);
    if (!agent) continue;
    const mrr = parseDollars(r[4]);   // col 4 is MRR now (was col 3)
    rows.push({
      enterprise:   clean(r[0]),
      rooftop:      clean(r[1]),
      agentRaw:     agent,
      agentShort:   AGENT_LABELS[agent] || agent,
      mrr,
      arr:          mrr * 12,
      agentStartDate: clean(r[3]),    // new column
      billingPlan:  clean(r[5]),
      contractTerm: clean(r[6]),
      enterpriseId: clean(r[9]),      // was col 8
      aeName:       clean(r[10]),
      agentLiveDate: clean(r[11]),
      teamId:       clean(r[12]),     // was col 11
      stage:        clean(r[14]),     // was col 13/14 — single source for lifecycle
    });
  }
  return rows;
}

// ─── In_Ob ──────────────────────────────────────────────────────────────────
// Header on row 0. Cols: 0 Ent ID · 1 Ent Name · 2 Rooftop ID · 3 Rooftop ·
//   4 Status · 5 Agent · 6 In_OB (date) · 7 ARR · 8 Confirmations
export async function fetchInOb() {
  const data = await fetchCsv("In_Ob");
  const hdr = data.findIndex(r => (r[0] || "").trim() === "Enterprise_Id");
  if (hdr < 0) throw new Error("In_Ob header row not found");
  const rows = [];
  for (let i = hdr + 1; i < data.length; i++) {
    const r = data[i];
    const agent = clean(r[5]);
    if (!agent) continue;
    rows.push({
      enterpriseId: clean(r[0]),
      enterprise:   clean(r[1]),
      teamId:       clean(r[2]),
      rooftop:      clean(r[3]),
      status:       clean(r[4]),
      agentRaw:     agent,
      agentShort:   AGENT_LABELS[agent] || agent,
      inObDate:     clean(r[6]),
      arr:          parseDollars(r[7]),
      confirmation: clean(r[8]),
    });
  }
  return rows;
}

// ─── Live & Churned ─────────────────────────────────────────────────────────
// Header on row 0. Cols: 0 Ent ID · 1 Account · 2 Team ID · 3 Rooftop ·
//   4 Agent · 5 Go-Live Date · 6 ARR · 7 MRR · 8 Stage (Live|Churned)
export async function fetchLiveAndChurned() {
  const data = await fetchCsv("Live & Churned");
  const hdr = data.findIndex(r => (r[0] || "").trim() === "Enterprise ID");
  if (hdr < 0) throw new Error("Live & Churned header row not found");
  const rows = [];
  for (let i = hdr + 1; i < data.length; i++) {
    const r = data[i];
    const agent = clean(r[4]);
    if (!agent) continue;
    rows.push({
      enterpriseId: clean(r[0]),
      account:      clean(r[1]),
      teamId:       clean(r[2]),
      rooftop:      clean(r[3]),
      agentRaw:     agent,
      agentShort:   AGENT_LABELS[agent] || agent,
      goLiveDate:   clean(r[5]),
      arr:          parseDollars(r[6]),
      mrr:          parseDollars(r[7]),
      stage:        clean(r[8]),   // "Live" | "Churned" | null
    });
  }
  return rows;
}

// ─── Blocked_Reason ─────────────────────────────────────────────────────────
// SCHEMA CHECKED 10-Jun-2026 — a key column was inserted at index 1, shifting
// every other column by +1. The bucket field (was "Blocked At") is now
// labelled "Blocked Owner" at col 8.
//   0 (blank) · 1 Combined key (e.g. "Paragon HondaParts Inbound") ·
//   2 Account · 3 Rooftop · 4 ARR · 5 OB POC · 6 Stage · 7 Agent ·
//   8 Blocked Owner (bucket: Client/Product/Tech/...) · 9 Remarks
export async function fetchBlockedReasons() {
  const data = await fetchCsv("Blocked_Reason");
  const hdr = data.findIndex(r => (r[2] || "").trim() === "Account Name");
  if (hdr < 0) throw new Error("Blocked_Reason header row not found");
  const rows = [];
  for (let i = hdr + 1; i < data.length; i++) {
    const r = data[i];
    const account = clean(r[2]);
    if (!account) continue;
    rows.push({
      combinedKey: clean(r[1]),
      account,
      rooftop:    clean(r[3]),
      arr:        parseDollars(r[4]),
      obPoc:      clean(r[5]),
      stage:      clean(r[6]),
      agent:      clean(r[7]),
      blockedAt:  clean(r[8]) || "Uncategorized", // sheet label is "Blocked Owner"
      remarks:    clean(r[9]),
    });
  }
  return rows;
}

// ─── Ageing — contracts signed but not yet fully live ──────────────────────
// Schema: 0 Contract Name · 1 ARR Potential · 2 Enterprise ID ·
//         3 Agreement Sign Date · 4 Days Since Signing · 5 Aging Bucket
export async function fetchAgeing() {
  const data = await fetchCsv("Ageing");
  const hdr = data.findIndex(r => (r[0] || "").trim() === "Contract Name");
  if (hdr < 0) throw new Error("Ageing header row not found");
  const rows = [];
  for (let i = hdr + 1; i < data.length; i++) {
    const r = data[i];
    const name = clean(r[0]);
    if (!name) continue;
    rows.push({
      contractName:  name,
      arr:           parseDollars(r[1]),
      enterpriseId:  clean(r[2]),
      signDate:      clean(r[3]),
      daysSince:     parseInt(r[4], 10) || 0,
      sheetBucket:   clean(r[5]),
    });
  }
  return rows;
}

// Bucket by Days Since Signing into the user's preferred 3 bands:
//   0-30, 30-60, 60+ days
export function summarizeAgeing(rows) {
  const buckets = [
    { key: "0–30 days",   lo: 0,  hi: 30,        count: 0, arr: 0 },
    { key: "30–60 days",  lo: 30, hi: 60,        count: 0, arr: 0 },
    { key: "60+ days",    lo: 60, hi: Infinity,  count: 0, arr: 0 },
  ];
  let total = 0, totalArr = 0;
  let oldest = 0;
  for (const r of rows) {
    const d = r.daysSince;
    const b = buckets.find(x => d >= x.lo && d < x.hi)
           || buckets.find(x => d >= x.lo && x.hi === Infinity);
    if (b) { b.count += 1; b.arr += r.arr || 0; }
    total += 1; totalArr += r.arr || 0;
    if (d > oldest) oldest = d;
  }
  return { buckets, total, totalArr, oldestDays: oldest };
}

// ─── Group OB blockers into top-5 reasons by ARR ────────────────────────────
//
// User asked: "pick, group and give 5 reasons" — group by the `Blocked At`
// bucket (already categorical: Client / Integration Tech / Product /
// Onboarding / Tech), sum ARR + count rows, sort by ARR desc, return top 5.
export function topBlockerReasons(blockedRows, limit = 5) {
  const buckets = {};
  for (const r of blockedRows) {
    const k = r.blockedAt;
    if (!buckets[k]) buckets[k] = { key: k, count: 0, arr: 0 };
    buckets[k].count += 1;
    buckets[k].arr   += r.arr || 0;
  }
  return Object.values(buckets)
    .sort((a, b) => b.arr - a.arr || b.count - a.count)
    .slice(0, limit);
}

// ─── Summarize In_Ob (Confirmed = Unblocked, Upside = Blocked) ─────────────
// "Current Month Confirmations" column carries the blocked/unblocked signal:
//   • Confirmed  → Unblocked (will go live this month)
//   • Upside     → Blocked   (uncertain whether it'll happen)
//   • empty      → unclassified (counted in total but not in either bucket)
//
// In_Ob tab carries rows for OB Initiated, OB Drop, Sales Drop and Churned
// statuses (the workflow sheet, not just active OB). Funnel-correct "In OB"
// means only `status === "OB Initiated"` — every other status is an exit
// and rolls into the Churn bucket (see exit* fields below).
export function summarizeInOb(rows) {
  // Drop any non-OB-Initiated rows from the in-funnel count. The exits
  // (OB Drop / Sales Drop / Churned) are exposed separately so the funnel
  // can lump them into the Churn bucket per Mehul's directive.
  const ACTIVE_OB_STATUS = "ob initiated";
  const isActive = r => (r.status || "").toLowerCase() === ACTIVE_OB_STATUS;
  const obRows   = rows.filter(isActive);
  const exitRows = rows.filter(r => !isActive(r));

  // Canonical 4 first (in fixed order), then any other agent types found in
  // the data (AI Receptionist, Parts Inbound, Service Recall, etc.) appended
  // by row count desc — so nothing gets silently dropped.
  const CANONICAL = ["Sales IB", "Service IB", "Sales OB", "Service OB"];
  const distinctLabels = [...new Set(obRows.map(r => r.agentShort).filter(Boolean))];
  const extras = distinctLabels
    .filter(l => !CANONICAL.includes(l))
    .sort((a, b) =>
      obRows.filter(r => r.agentShort === b).length -
      obRows.filter(r => r.agentShort === a).length);
  const AGENT_ORDER = [...CANONICAL, ...extras];

  const sumArr = list => list.reduce((s, r) => s + (r.arr || 0), 0);
  const distinct = (list, key) =>
    new Set(list.map(r => r[key]).filter(Boolean)).size;

  const isConfirmed = r => (r.confirmation || "").toLowerCase() === "confirmed";
  const isUpside    = r => (r.confirmation || "").toLowerCase() === "upside";

  const byAgentType = AGENT_ORDER.map(label => {
    const list      = obRows.filter(r => r.agentShort === label);
    const confirmed = list.filter(isConfirmed);
    const upside    = list.filter(isUpside);
    return {
      label,
      count:         list.length,
      arr:           sumArr(list),
      confirmed:     confirmed.length,
      confirmedArr:  sumArr(confirmed),
      upside:        upside.length,
      upsideArr:     sumArr(upside),
    };
  }).filter(b => b.count > 0);

  const confirmedAll = obRows.filter(isConfirmed);
  const upsideAll    = obRows.filter(isUpside);

  // Exit breakdown by status (used by the lumped Churn bucket).
  const exitsByStatus = {};
  for (const r of exitRows) {
    const k = r.status || "(unknown)";
    if (!exitsByStatus[k]) exitsByStatus[k] = { count: 0, arr: 0 };
    exitsByStatus[k].count++;
    exitsByStatus[k].arr += r.arr || 0;
  }

  return {
    // Funnel-correct counts: only OB Initiated.
    totalCount:     obRows.length,
    totalArr:       sumArr(obRows),
    rooftops:       distinct(obRows, "teamId") || distinct(obRows, "rooftop"),
    accounts:       distinct(obRows, "enterpriseId") || distinct(obRows, "enterprise"),
    confirmedCount: confirmedAll.length,
    confirmedArr:   sumArr(confirmedAll),
    upsideCount:    upsideAll.length,
    upsideArr:      sumArr(upsideAll),
    byAgentType,
    // Exits (roll into the unified Churn bucket).
    exitCount:      exitRows.length,
    exitArr:        sumArr(exitRows),
    exitsByStatus,
    exitRows,
  };
}

// ─── Summarize Live & Churned (replaces viniAgentTracker CSV) ───────────────
export function summarizeLiveChurned(rows) {
  const live  = rows.filter(r => (r.stage || "").toLowerCase() === "live");
  const churn = rows.filter(r => (r.stage || "").toLowerCase() === "churned");
  const sumArr = list => list.reduce((s, r) => s + (r.arr || 0), 0);
  const distinct = (list, key) =>
    new Set(list.map(r => r[key]).filter(Boolean)).size;
  return {
    live:  {
      count:    live.length,
      arr:      sumArr(live),
      rooftops: distinct(live, "teamId") || distinct(live, "rooftop"),
      accounts: distinct(live, "enterpriseId") || distinct(live, "account"),
      rows:     live,
    },
    churn: {
      count:    churn.length,
      arr:      sumArr(churn),
      rooftops: distinct(churn, "teamId") || distinct(churn, "rooftop"),
      accounts: distinct(churn, "enterpriseId") || distinct(churn, "account"),
      rows:     churn,
    },
  };
}

// ─── Summarize Contracted ───────────────────────────────────────────────────
// "Contracted" in the funnel = the FULL signed book — the top of the funnel.
// Every downstream stage (OB / Live / Churn) is a subset of this. Reads every
// row in Contracted_Vini regardless of lifecycle stage.
//
// Per Mehul 6-Jun: stakeholders read this as "total signed" (~$5M ARR), not
// "currently in contracting stage." The byStage breakdown is kept for QA.
export function summarizeContracted(rows) {
  const sumArr = list => list.reduce((s, r) => s + (r.arr || 0), 0);
  const distinct = (list, key) =>
    new Set(list.map(r => r[key]).filter(Boolean)).size;

  // Audit view of the signed book by lifecycle stage.
  const byStage = {};
  for (const r of rows) {
    const k = r.stage || "(unknown)";
    if (!byStage[k]) byStage[k] = { count: 0, arr: 0 };
    byStage[k].count += 1;
    byStage[k].arr   += r.arr || 0;
  }

  return {
    count:    rows.length,
    arr:      sumArr(rows),
    rooftops: distinct(rows, "teamId")       || distinct(rows, "rooftop"),
    accounts: distinct(rows, "enterpriseId") || distinct(rows, "enterprise"),
    byStage,
  };
}
