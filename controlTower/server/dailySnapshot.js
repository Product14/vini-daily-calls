// ─── Daily snapshot + commentary engine ─────────────────────────────────────
// Writes today's headline numbers to data/snapshots/email-YYYY-MM-DD.json
// and emits a short, sectioned commentary diff vs the most recent prior
// snapshot. Drives the "what changed yesterday" copy under each section
// header in the email.
//
// Until LLM-generated commentary is wired in, this hand-builds the prose
// from numeric deltas — terse, factual, no fluff.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR  = join(__dirname, "..", "data", "snapshots");

function ensureDir() {
  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
}

function todayIST() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = ist.getFullYear(), m = String(ist.getMonth() + 1).padStart(2, "0"), d = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  const v = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `${sign}$${Math.round(v / 1_000)}K`;
  return `${sign}$${v.toFixed(0)}`;
}
function signed(n) { return n > 0 ? `+${n}` : `${n}`; }
function signedMoney(n) { return n > 0 ? `+${fmtMoney(n)}` : fmtMoney(n); }
function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US");
}

// ─── Snapshot read/write ────────────────────────────────────────────────────

function priorSnapshot(todayDate) {
  ensureDir();
  const files = readdirSync(SNAP_DIR)
    .filter(f => /^email-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace(/^email-|\.json$/g, ""))
    .filter(d => d < todayDate)
    .sort();
  if (!files.length) return null;
  const last = files[files.length - 1];
  try {
    return { date: last, data: JSON.parse(readFileSync(join(SNAP_DIR, `email-${last}.json`), "utf8")) };
  } catch { return null; }
}

function saveSnapshot(date, data) {
  ensureDir();
  writeFileSync(join(SNAP_DIR, `email-${date}.json`), JSON.stringify(data, null, 2));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Capture today's numbers + return a commentary object for each section.
 *
 * @param {object} payload  Same payload that buildAgentsEmailHtml consumes.
 * @returns {object} {
 *   todayDate, priorDate (or null),
 *   commentary: {
 *     onboarding: string,        // markdown-ish prose, one short paragraph
 *     live:       string,
 *     metrics:    string,
 *   }
 * }
 */
export function snapshotAndCommentate(payload) {
  const todayDate = todayIST();

  // Flatten payload to the numbers we want to track day-over-day
  const snap = {
    date: todayDate,
    funnel: payload.sec2.funnelV2 || null,
    obByAgent: (payload.sec2.obRaw?.byAgentType || []).map(b => ({
      label: b.label, count: b.count, arr: b.arr,
      confirmed: b.confirmed, confirmedArr: b.confirmedArr,
      upside: b.upside, upsideArr: b.upsideArr,
    })),
    obTotals: {
      total: payload.sec2.obRaw?.totalCount,
      arr:   payload.sec2.obRaw?.totalArr,
      confirmed: payload.sec2.obRaw?.confirmedCount,
      upside:    payload.sec2.obRaw?.upsideCount,
    },
    ragByAgent: (payload.sec1.byAgentType || []).map(b => ({
      label: b.label, live: b.live, green: b.green, amber: b.amber, red: b.red, churn: b.churn,
      greenArr: b.greenArr, amberArr: b.amberArr, redArr: b.redArr,
    })),
    daily: payload.sec1.usage?.daily ? {
      asOfDate:        payload.sec1.usage.daily.asOfDate,
      calls:           payload.sec1.usage.daily.calls,
      leads:           payload.sec1.usage.daily.leadsInteracted,
      appointments:    payload.sec1.usage.daily.appointments,
      abr:             payload.sec1.usage.daily.abr,
      callFailureRate: payload.sec1.usage.daily.callFailureRate,
    } : null,
    portfolioRoi: payload.sec1.usage?.portfolio?.weightedRoi ?? null,
    // Day-on-day tracking of the Top-Reds and Top-Wins lists so the next
    // section can show "new", "still on the list", "fixed/dropped" badges.
    topReds: (payload.sec1.topReds || []).map(r => ({
      account: r.account, rooftop: r.rooftop, agentShort: r.agentShort,
      arr: r.arr, abrPct: r.abrPct, roiMultiple: r.roiMultiple, redKind: r.redKind,
    })),
    topWins: (payload.sec1.topWins || []).map(w => ({
      account: w.account, rooftop: w.rooftop, agentShort: w.agentShort,
      arr: w.arr, abrPct: w.abrPct, roiMultiple: w.roiMultiple,
    })),
    // Superbryn quality verdict share per agent type — used for pp deltas
    // in the Live Agent Quality section.
    qualityByAgent: (payload.quality?.agents || []).map(a => ({
      label:    a.label,
      analyzed: a.analyzed,
      quality:  a.quality,
    })),
    // Per-agent ARR funnel (CARR → In OB → Live) — saved daily so the next
    // run can compute movement deltas (user 23-Jun "show trend in this").
    perAgentArr: payload.perAgentArr || {},
  };

  const prior = priorSnapshot(todayDate);
  saveSnapshot(todayDate, snap);

  if (!prior) {
    const msg = "Baseline snapshot saved today — day-over-day deltas appear from tomorrow.";
    return {
      todayDate, priorDate: null,
      commentary: { onboarding: msg, live: msg, metrics: msg },
    };
  }

  // ── Build per-section commentary as narrative prose ──────────────────────

  const ago = humanAgo(prior.date, todayDate);

  // ─── Onboarding pipeline narrative ───────────────────────────────────────
  const obDelta          = (snap.obTotals.total ?? 0)     - (prior.data.obTotals?.total ?? 0);
  const obArrDelta       = (snap.obTotals.arr ?? 0)       - (prior.data.obTotals?.arr ?? 0);
  const obUpsideDelta    = (snap.obTotals.upside ?? 0)    - (prior.data.obTotals?.upside ?? 0);
  const obConfirmedDelta = (snap.obTotals.confirmed ?? 0) - (prior.data.obTotals?.confirmed ?? 0);
  const obSentences = [];
  if (obDelta !== 0) {
    const dirVerb = obDelta > 0 ? "added" : "shed";
    obSentences.push(
      `Pipeline ${dirVerb} <strong>${Math.abs(obDelta)} net account${Math.abs(obDelta) === 1 ? "" : "s"}</strong>` +
      ` (${signedMoney(obArrDelta)}) since ${ago}.`
    );
  } else {
    obSentences.push(`Pipeline volume held flat at <strong>${snap.obTotals.total ?? 0}</strong> accounts since ${ago}.`);
  }
  // Lead with whichever sub-bucket moved more — that's the signal for the day.
  if (obConfirmedDelta !== 0 || obUpsideDelta !== 0) {
    if (Math.abs(obConfirmedDelta) >= Math.abs(obUpsideDelta) && obConfirmedDelta !== 0) {
      const verb = obConfirmedDelta > 0 ? "moved into Confirmed (unblocked)" : "rolled out of Confirmed";
      obSentences.push(`<strong>${Math.abs(obConfirmedDelta)}</strong> ${verb}; Upside ${signed(obUpsideDelta)}.`);
    } else if (obUpsideDelta !== 0) {
      const verb = obUpsideDelta > 0 ? "drifted into Upside (blocked)" : "cleared from Upside";
      obSentences.push(`<strong>${Math.abs(obUpsideDelta)}</strong> ${verb}; Confirmed ${signed(obConfirmedDelta)}.`);
    }
  }
  // Surface the biggest agent-type mover for context.
  const obMovers = (snap.obByAgent || []).map(cur => {
    const prev = (prior.data.obByAgent || []).find(p => p.label === cur.label);
    return prev ? { label: cur.label, d: (cur.count - prev.count), dArr: (cur.arr - prev.arr) } : null;
  }).filter(Boolean).filter(m => m.d !== 0).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  if (obMovers.length) {
    const m = obMovers[0];
    obSentences.push(`Biggest shift: <strong>${m.label}</strong> ${signed(m.d)} (${signedMoney(m.dArr)}).`);
  }
  const onboarding = obSentences.join(" ");

  // ─── Live RAG narrative ──────────────────────────────────────────────────
  const ragNow  = aggregateRag(snap.ragByAgent);
  const ragPrev = aggregateRag(prior.data.ragByAgent || []);
  const greenDelta = ragNow.green - ragPrev.green;
  const redDelta   = ragNow.red   - ragPrev.red;
  const liveDelta  = ragNow.live  - ragPrev.live;
  const churnDelta = ragNow.churn - ragPrev.churn;
  const liveSentences = [];
  if (liveDelta !== 0) {
    const verb = liveDelta > 0 ? "went live" : "rolled off";
    liveSentences.push(`<strong>${Math.abs(liveDelta)} agent${Math.abs(liveDelta) === 1 ? "" : "s"}</strong> ${verb} since ${ago}, taking the cohort to <strong>${ragNow.live}</strong>.`);
  } else {
    liveSentences.push(`Live cohort steady at <strong>${ragNow.live}</strong> agents since ${ago}.`);
  }
  if (greenDelta !== 0 || redDelta !== 0) {
    const greenPart = greenDelta !== 0 ? `<strong>${signed(greenDelta)} Green</strong>` : null;
    const redPart   = redDelta   !== 0 ? `<strong style="color:#d23f31;">${signed(redDelta)} Red</strong>` : null;
    liveSentences.push(`RAG mix shifted ${[greenPart, redPart].filter(Boolean).join(" · ")}.`);
  } else {
    liveSentences.push(`RAG mix held — ${ragNow.green} Green / ${ragNow.amber} Amber / ${ragNow.red} Red.`);
  }
  // Surface the agent type that drove the biggest RAG flip.
  const flips = [];
  for (const cur of snap.ragByAgent) {
    const prev = (prior.data.ragByAgent || []).find(p => p.label === cur.label);
    if (!prev) continue;
    const dG = cur.green - prev.green, dR = cur.red - prev.red;
    if (dG !== 0 || dR !== 0) flips.push({ label: cur.label, dG, dR, mag: Math.abs(dG) + Math.abs(dR) });
  }
  if (flips.length) {
    flips.sort((a, b) => b.mag - a.mag);
    const f = flips[0];
    const parts = [];
    if (f.dG !== 0) parts.push(`${signed(f.dG)}G`);
    if (f.dR !== 0) parts.push(`${signed(f.dR)}R`);
    liveSentences.push(`<strong>${f.label}</strong> drove most of the move (${parts.join(" / ")}).`);
  }
  if (churnDelta > 0) {
    liveSentences.push(`<strong style="color:#d23f31;">${churnDelta} new churn</strong> recorded.`);
  }
  const live = liveSentences.join(" ");

  // ─── Daily metrics narrative ─────────────────────────────────────────────
  let metrics;
  if (snap.daily && prior.data.daily) {
    const callsD = (snap.daily.calls ?? 0)        - (prior.data.daily.calls ?? 0);
    const apptsD = (snap.daily.appointments ?? 0) - (prior.data.daily.appointments ?? 0);
    const leadsD = (snap.daily.leads ?? 0)        - (prior.data.daily.leads ?? 0);
    const abrD   = (snap.daily.abr ?? 0)          - (prior.data.daily.abr ?? 0);
    const roiD   = (snap.portfolioRoi ?? 0)       - (prior.data.portfolioRoi ?? 0);
    const sents = [];
    // Lead with calls + appts in one sentence (the headline pulse).
    if (callsD !== 0 || apptsD !== 0) {
      sents.push(
        `Vini handled <strong>${fmtNum(snap.daily.calls)}</strong> calls (${signed(callsD)} vs ${ago})` +
        ` and booked <strong>${fmtNum(snap.daily.appointments)}</strong> appointments (${signed(apptsD)}).`
      );
    } else {
      sents.push(`Volume held steady — ${fmtNum(snap.daily.calls)} calls, ${fmtNum(snap.daily.appointments)} appointments.`);
    }
    // ABR is the conversion-quality signal — separate sentence so it lands.
    if (Math.abs(abrD) >= 0.005) {
      const dir = abrD > 0 ? "lifted" : "slipped";
      sents.push(`ABR ${dir} <strong>${(abrD * 100).toFixed(1)} pts</strong> to <strong>${(snap.daily.abr * 100).toFixed(1)}%</strong>.`);
    }
    // ROI gets called out only on material moves.
    if (Math.abs(roiD) >= 0.1) {
      const dir = roiD > 0 ? "up" : "down";
      sents.push(`Portfolio ROI Multiple ${dir} <strong>${(roiD > 0 ? "+" : "") + roiD.toFixed(2)}×</strong> to <strong>${snap.portfolioRoi.toFixed(2)}×</strong>.`);
    }
    if (leadsD !== 0) {
      sents.push(`Leads interacted ${signed(leadsD)}.`);
    }
    metrics = sents.join(" ");
  } else {
    metrics = `Usage baseline captured — day-over-day deltas appear from tomorrow.`;
  }

  // ─── Day-on-day deltas as structured data ───────────────────────────────
  // The template renders these as small "+5 / -5" annotations under tables.
  const deltas = {
    funnel: snap.funnel && prior.data.funnel ? {
      contracted: deltaPair(snap.funnel.contracted, prior.data.funnel.contracted),
      ob:         deltaPair(snap.funnel.ob,         prior.data.funnel.ob),
      live:       deltaPair(snap.funnel.live,       prior.data.funnel.live),
      churned:    deltaPair(snap.funnel.churned,    prior.data.funnel.churned),
    } : null,
    rag: snap.ragByAgent.map(cur => {
      const prv = (prior.data.ragByAgent || []).find(p => p.label === cur.label) || {};
      return {
        label: cur.label,
        live:  (cur.live  || 0) - (prv.live  || 0),
        green: (cur.green || 0) - (prv.green || 0),
        amber: (cur.amber || 0) - (prv.amber || 0),
        red:   (cur.red   || 0) - (prv.red   || 0),
      };
    }),
    obByAgent: snap.obByAgent.map(cur => {
      const prv = (prior.data.obByAgent || []).find(p => p.label === cur.label) || {};
      return {
        label:     cur.label,
        count:     (cur.count     || 0) - (prv.count     || 0),
        arr:       (cur.arr       || 0) - (prv.arr       || 0),
        confirmed: (cur.confirmed || 0) - (prv.confirmed || 0),
        upside:    (cur.upside    || 0) - (prv.upside    || 0),
      };
    }),
    // Red account movement: which accounts joined / dropped off the Top-5 list.
    redMovement: diffAccountList(snap.topReds, prior.data.topReds),
    winMovement: diffAccountList(snap.topWins, prior.data.topWins),
    // Per-agent ARR deltas — diff today's CARR/OB/Live ARR vs the prior
    // snapshot. Falls back to today's ragByAgent + obByAgent fields when
    // perAgentArr wasn't saved on the prior day (early-run shim).
    perAgentArr: (() => {
      const out = {};
      for (const agent of Object.keys(snap.perAgentArr || {})) {
        const cur = snap.perAgentArr[agent];
        const prv = prior.data.perAgentArr?.[agent];
        // Fallback for prior — compute from old fields if perAgentArr absent.
        const prvObFromRow = (prior.data.obByAgent || [])
          .find(b => b.label === agent)?.arr;
        const prvLiveRow   = (prior.data.ragByAgent || []).find(b => b.label === agent);
        const prvLiveFromRow = prvLiveRow
          ? (prvLiveRow.greenArr || 0) + (prvLiveRow.amberArr || 0) + (prvLiveRow.redArr || 0)
          : null;
        out[agent] = {
          cArr:    prv?.cArr    != null ? cur.cArr    - prv.cArr    : null,
          obArr:   (prv?.obArr   ?? prvObFromRow) != null ? cur.obArr   - (prv?.obArr ?? prvObFromRow) : null,
          liveArr: (prv?.liveArr ?? prvLiveFromRow) != null ? cur.liveArr - (prv?.liveArr ?? prvLiveFromRow) : null,
        };
      }
      return out;
    })(),
    // Quality pp deltas per agent type: today's share − yesterday's share,
    // expressed as percentage points (rounded).
    qualityByAgent: (snap.qualityByAgent || []).map(cur => {
      const prv = (prior.data.qualityByAgent || []).find(p => p.label === cur.label);
      if (!prv || !prv.analyzed) return { label: cur.label, qualityDeltaPp: null };
      const share = (q, total) => total > 0 ? (q || 0) / total : 0;
      const pp = (curN, prvN) => Math.round((share(curN, cur.analyzed) - share(prvN, prv.analyzed)) * 100);
      return {
        label: cur.label,
        qualityDeltaPp: {
          allClear:   pp(cur.quality?.allClear,   prv.quality?.allClear),
          blindSpot:  pp(cur.quality?.blindSpot,  prv.quality?.blindSpot),
          falseAlarm: pp(cur.quality?.falseAlarm, prv.quality?.falseAlarm),
          redAlert:   pp(cur.quality?.redAlert,   prv.quality?.redAlert),
        },
      };
    }),
  };

  return {
    todayDate,
    priorDate: prior.date,
    commentary: { onboarding, live, metrics },
    deltas,
  };
}

function deltaPair(cur, prv) {
  cur = cur || {}; prv = prv || {};
  return {
    accounts: (cur.accounts || 0) - (prv.accounts || 0),
    rooftops: (cur.rooftops || 0) - (prv.rooftops || 0),
    agents:   (cur.agents   || 0) - (prv.agents   || 0),
    arr:      (cur.arr      || 0) - (prv.arr      || 0),
  };
}

// Compare today's vs yesterday's account list by (rooftop|agentShort) key.
// Returns { added: [...], dropped: [...], stayed: [...] } where each item
// carries today's data plus a `status` tag for chip rendering.
function diffAccountList(today, prior) {
  today = today || []; prior = prior || [];
  const key = a => `${a.rooftop || a.account}|${a.agentShort}`;
  const priorKeys = new Set(prior.map(key));
  const todayKeys = new Set(today.map(key));
  const added   = today.filter(a => !priorKeys.has(key(a))).map(a => ({ ...a, status: "new"     }));
  const stayed  = today.filter(a =>  priorKeys.has(key(a))).map(a => ({ ...a, status: "persistent" }));
  const dropped = prior.filter(a => !todayKeys.has(key(a))).map(a => ({ ...a, status: "dropped"   }));
  return { added, stayed, dropped };
}

function aggregateRag(arr) {
  return arr.reduce((a, b) => ({
    live:  a.live  + (b.live  || 0),
    green: a.green + (b.green || 0),
    amber: a.amber + (b.amber || 0),
    red:   a.red   + (b.red   || 0),
    churn: a.churn + (b.churn || 0),
  }), { live: 0, green: 0, amber: 0, red: 0, churn: 0 });
}

function humanAgo(priorDate, todayDate) {
  // both YYYY-MM-DD
  const p = new Date(priorDate + "T00:00:00");
  const t = new Date(todayDate + "T00:00:00");
  const days = Math.round((t - p) / 86400000);
  if (days === 1) return "yesterday";
  if (days === 0) return "earlier today";
  return `${days} days ago`;
}
