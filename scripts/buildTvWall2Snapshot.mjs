#!/usr/bin/env node
/**
 * Builds public/tvwall2-snapshot.json — the data behind /tv-wall-2.
 *
 * WHY A SNAPSHOT AND NOT A QUERY. Every number on that wall is already defined,
 * built and cross-checked in the vini-success dashboard: RAG bands, appointment
 * values, dormancy, the CSM roster. Re-deriving them from ClickHouse here would
 * create a second definition of "Red" to keep in step with the first, and the two
 * would drift the first time one side changed. So this reads that repo's own
 * dataset files and does nothing but group and count.
 *
 * INPUT: the vini-success prototype directory. Point it wherever the repo is:
 *   VINI_SUCCESS_DIR=~/Desktop/repos/vini-success/prototype node scripts/buildTvWall2Snapshot.mjs
 * Default is ../vini-success/prototype relative to this repo.
 *
 * The four datasets do not have the same shape, which is the only complexity here:
 *   sales   (data-inbound.json, data-30d.json)            rows carry csm/arr/mrr/live_date
 *   service (data-service-*.json)                          rows carry the funnel only; csm/arr/mrr
 *                                                          live in a separate `rooftops` map, and
 *                                                          there is NO go-live date anywhere
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SRC = process.env.VINI_SUCCESS_DIR
  ? resolve(process.env.VINI_SUCCESS_DIR.replace(/^~/, process.env.HOME))
  : resolve(REPO, "../vini-success/prototype");

/* Appointment value per product, in dollars. Deliberately explicit and in ONE place,
   because these have never agreed across sources and the wall has to name the one it used.
   All four are Spyne planning assumptions, not audited industry figures.

   SERVICE SETTLED ON data-overall.json's FIGURES (2026-09-01, Mehul): 100 and 200, not the
   225 the service datasets publish. That is a real cut, 56% on Service Inbound, so bands
   move: a service rooftop needs more than twice the appointments it used to for the same
   band. The service TABS in vini-success still read 225 from their own datasets, so this
   wall and those tabs now disagree until the service builders are changed.

   SALES OUTBOUND IS STILL OPEN at 300, which is what its tab shows; data-overall.json
   prices it at 250. Left as it was because only the service pair was decided. */
const APPT_VALUE = {
  salesIb: 200,
  salesOb: 300,
  serviceIb: 100,
  serviceOb: 200,
};

const RAG = { green: 3, amber: 1 };
const DORMANT_BELOW = 10; // leads reached (or, on Service Inbound, conversations held) in 7 days
const MATURE_DAYS = 30;

const read = (f) => {
  const p = join(SRC, f);
  if (!existsSync(p)) {
    console.error(
      `\n  Cannot find ${p}\n` +
        `  Point VINI_SUCCESS_DIR at the vini-success repo's prototype/ directory.\n`
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, "utf8"));
};

const dayDiff = (a, b) =>
  Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

/**
 * One agent = one (rooftop x product). Returns a flat list, live only.
 *
 * proRata: an agent live under 30 days has only part of a 30-day window, so its
 * appointments are scaled to 30 days before banding. Service datasets carry no
 * go-live date, so nothing there can be scaled and every service agent is banded
 * on its raw 30-day count. That asymmetry is real and the view says so.
 */
function agents({ d, apptValue, reachField, identityFrom }) {
  const w30 = d.byWindow["30d"] || [];
  const w7 = new Map((d.byWindow["7d"] || []).map((r) => [r.team_id, r]));
  const rooftops = d.rooftops || null;
  const asOf = d.asOf;
  const out = [];

  for (const r of w30) {
    // Identity is either on the row (sales) or in the rooftops map (service).
    const id = identityFrom === "row" ? r : rooftops && rooftops[r.team_id];
    if (!id) continue;
    if (id.stage !== "Live") continue;

    const csmRaw = identityFrom === "row" ? id.csm : id.csm && id.csm.value;
    const csm = csmRaw || "No CSM assigned";
    const rooftop = identityFrom === "row" ? id.rooftop : id.rooftop;
    const mrr = Number(id.mrr) || 0;
    const arr = Number(id.arr) || 0;
    const liveDate = identityFrom === "row" ? id.live_date || null : null;
    const daysLive = liveDate ? dayDiff(asOf, liveDate) : null;

    const apptsRaw = Number(r.appts) || 0;
    const factor = daysLive !== null && daysLive > 0 && daysLive < MATURE_DAYS
      ? MATURE_DAYS / daysLive
      : 1;
    const appts = apptsRaw * factor;

    const ratio = mrr > 0 ? (appts * apptValue) / mrr : null;
    const ratioBand = ratio === null ? "none" : ratio >= RAG.green ? "green" : ratio >= RAG.amber ? "amber" : "red";

    const w = w7.get(r.team_id) || {};
    const reach7 = Number(w[reachField]) || 0;
    const dormant = reach7 < DORMANT_BELOW;

    /* Red absorbs dormant and unrateable, so Red + Amber + Green always equals the
       agent count. A wall where the three numbers do not sum invites the wrong
       question ("what happened to the other four?") instead of the right one. */
    const band = ratioBand === "none" || dormant ? "red" : ratioBand;

    out.push({
      teamId: r.team_id, rooftop, csm, arr, mrr, liveDate, daysLive,
      factor: Number(factor.toFixed(2)), apptsRaw, appts: Number(appts.toFixed(1)),
      ratio: ratio === null ? null : Number(ratio.toFixed(2)),
      ratioBand, reach7, dormant, band,
    });
  }
  return out.sort((a, b) => b.arr - a.arr);
}

function summarise(list) {
  const n = list.length;
  const c = { red: 0, amber: 0, green: 0 };
  for (const a of list) c[a.band]++;
  return {
    agents: n,
    arr: list.reduce((s, a) => s + a.arr, 0),
    ...c,
    dormant: list.filter((a) => a.dormant).length,
    unrateable: list.filter((a) => a.ratioBand === "none").length,
    pct: n ? { red: c.red / n, amber: c.amber / n, green: c.green / n } : { red: 0, amber: 0, green: 0 },
  };
}

function byCsm(list) {
  const g = new Map();
  for (const a of list) {
    if (!g.has(a.csm)) g.set(a.csm, []);
    g.get(a.csm).push(a);
  }
  return [...g.entries()]
    .map(([csm, rows]) => ({ csm, ...summarise(rows) }))
    .sort((x, y) => y.arr - x.arr || y.agents - x.agents);
}

// ---- build ------------------------------------------------------------------------------
const dIb = read("data-inbound.json");
const dOb = read("data-30d.json");
const dSvi = read("data-service-inbound.json");
const dSvo = read("data-service-outbound.json");

const PRODUCTS = [
  { key: "salesIb",   label: "Sales Inbound",    side: "sales",
    d: dIb,  apptValue: APPT_VALUE.salesIb,   reachField: "reached", identityFrom: "row",
    reachLabel: "Leads reached" },
  { key: "salesOb",   label: "Sales Outbound",   side: "sales",
    d: dOb,  apptValue: APPT_VALUE.salesOb,   reachField: "reached", identityFrom: "row",
    reachLabel: "Leads reached" },
  /* Service Inbound has no "reached": the calls come TO the agent. The closest honest
     analogue for "did anything happen here this week" is `spoke`, conversations actually
     held, so that is what dormancy reads and what the view labels. */
  { key: "serviceIb", label: "Service Inbound",  side: "service",
    d: dSvi, apptValue: APPT_VALUE.serviceIb, reachField: "spoke",   identityFrom: "rooftops",
    reachLabel: "Conversations held" },
  { key: "serviceOb", label: "Service Outbound", side: "service",
    d: dSvo, apptValue: APPT_VALUE.serviceOb, reachField: "reached", identityFrom: "rooftops",
    reachLabel: "Leads reached" },
];

/* TWO OUTPUTS, AND THE DIFFERENCE MATTERS.
   public/tvwall2-snapshot.json is served by an UNGATED route: this app has no middleware,
   and only /email-tracker sits behind a sign-in. So the public file carries ONLY what the
   wall actually renders: per-product and per-CSM aggregates. It does not carry the 204
   per-agent rows, because every one of those is a real dealer name with its ARR and MRR
   attached, and the view never displays them.
   The per-agent detail goes to a gitignored file instead, for auditing a figure locally. */
const products = {};
const audit = {};
for (const p of PRODUCTS) {
  const list = agents(p);
  products[p.key] = {
    key: p.key, label: p.label, side: p.side,
    apptValue: p.apptValue, reachLabel: p.reachLabel,
    asOf: p.d.asOf,
    proRata: p.identityFrom === "row",   // only sales carries a go-live date
    total: summarise(list),
    csms: byCsm(list),
  };
  audit[p.key] = list;
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  source: "vini-success dataset files (see scripts/buildTvWall2Snapshot.mjs)",
  rules: {
    rag: RAG,
    dormantBelow: DORMANT_BELOW,
    matureDays: MATURE_DAYS,
    apptValue: APPT_VALUE,
    redAbsorbs: ["dormant", "no MRR on record"],
  },
  products,
};

writeFileSync(join(REPO, "public", "tvwall2-snapshot.json"), JSON.stringify(snapshot, null, 1));
writeFileSync(
  join(REPO, "scripts", "tvwall2-agents.local.json"),
  JSON.stringify({ generatedAt: snapshot.generatedAt, rules: snapshot.rules, agents: audit }, null, 1)
);

// ---- report, so a silent wrong build is impossible ---------------------------------------
const nAgents = Object.values(audit).reduce((n, l) => n + l.length, 0);
console.log(`\n  wrote public/tvwall2-snapshot.json          aggregates only, safe for an ungated route`);
console.log(`  wrote scripts/tvwall2-agents.local.json    ${nAgents} agent rows with dealer names, GITIGNORED`);
for (const k of Object.keys(products)) {
  const p = products[k];
  const t = p.total;
  console.log(
    `  ${p.label.padEnd(17)} ${String(t.agents).padStart(3)} agents  ` +
      `$${t.arr.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(9)}  ` +
      `red ${String(t.red).padStart(2)} amber ${String(t.amber).padStart(2)} green ${String(t.green).padStart(2)}  ` +
      `dormant ${String(t.dormant).padStart(2)}  unrateable ${t.unrateable}  ` +
      `asOf ${p.asOf}  proRata ${p.proRata ? "yes" : "NO (no go-live date)"}`
  );
}
