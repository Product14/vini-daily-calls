import { AGENT_COLOR } from "./agentColors.js";

// ─── Vini Daily Control Tower — final design (2026-05-29) ──────────────────
// One committed visual language. Warm paper background, big hero numbers,
// strategic indigo accent, RAG color-dots in the matrix (not background tints),
// clean tables with subtle row striping, an actionable "Top 5 to fix" list,
// daily-pulse tiles for yesterday, and a quiet methodology footer.

// Notion palette — cool light-gray surface, white cards, subtle borders,
// near-black text with a hint of warm brown (Notion's signature #37352f).
// Bolder palette per 16-Jun CEO feedback — darker body text, stronger
// muted, beefier color hits. Background stays warm-paper for print-on-mobile
// readability.
const PALETTE = {
  bg:        "#f7f7f5",   // Notion gray-50 page background
  card:      "#ffffff",
  border:    "#d8d8d3",   // bumped contrast (was #ebebe9)
  text:      "#1f1d18",   // near-black (was #37352f)
  muted:     "#5b5955",   // darker muted (was #787875)
  soft:      "#8d8b87",   // (was #a8a7a4)
  accent:    "#1e88c9",   // saturated blue (was #2eaadc)
  // RAG — boosted saturation
  green:     "#0b6635",
  amber:     "#b85a08",
  red:       "#c92626",
  na:        "#8d8b87",
  // Section bar accents
  sec1:      "#1e88c9",
  sec2:      "#0b6635",
  sec3:      "#b85a08",
};

const RESPONSIVE_CSS = `
  /* Default desktop sizing. The mobile rules below override at <=620px. */
  @media only screen and (max-width:620px) {
    .container    { padding:10px 0 !important; }
    .body-pad     { padding:18px 14px 24px !important; }
    .hero-tile    { display:block !important; width:100% !important; padding:6px 0 !important; }
    .hero-num     { font-size:28px !important; }
    .hero-label   { font-size:11px !important; }
    .hero-arr     { font-size:16px !important; }
    .yest-tile    { display:inline-block !important; width:50% !important; box-sizing:border-box !important; }
    .sec-title    { font-size:20px !important; }
    .sec-sub      { font-size:13px !important; }
    .matrix-num   { font-size:18px !important; }
    .matrix-arr   { font-size:12px !important; }
    .topcard-name { font-size:14px !important; }
    .topcard-meta { font-size:12px !important; }
    .topcard-arr  { font-size:16px !important; }
    .funnel-cell  { padding:14px 10px !important; }
    .mob-hide     { display:none !important; }
    table.metrics th, table.metrics td { padding:9px 10px !important; font-size:13px !important; }
  }
`;

// ─── Formatters ──────────────────────────────────────────────────────────────
function fmtNum(n)   { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  const v = Number(n);
  if (v === 0)         return "$0";
  if (v >= 1_000_000)  return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)      return `$${Math.round(v / 1_000)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtPct(n)   { return n == null ? "—" : `${Math.round(Number(n))}%`; }
function fmtMult(n)  { return n == null ? "—" : `${Number(n).toFixed(1)}×`; }
// MRR = ARR / 12, shown under each ARR figure.
function fmtMrr(n)   { return (n == null || isNaN(n)) ? "—" : `${fmtMoney(Number(n) / 12)}/mo`; }

// ─── Building blocks ────────────────────────────────────────────────────────

// Tiny uppercase label (bumped from 10px → 11px, weight stays 700)
function microLabel(text, color = PALETTE.muted) {
  return `<div style="font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${color};">${text}</div>`;
}

// Section title — bigger, bolder, with a thicker accent bar.
function sectionTitle(barColor, title, sub, dailyDelta) {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 14px;">
      <tr>
        <td style="background:${barColor}; width:4px; padding:0;">&nbsp;</td>
        <td style="padding:0 0 0 14px;">
          <div class="sec-title" style="font-size:22px; font-weight:800; color:${PALETTE.text}; letter-spacing:-0.02em; line-height:1.1;">${title}</div>
          ${sub ? `<div class="sec-sub" style="font-size:13px; color:${PALETTE.muted}; margin-top:4px; font-weight:500;">${sub}</div>` : ""}
          ${dailyDelta ? `<div style="font-size:13px; color:${PALETTE.text}; margin-top:8px; line-height:1.5; background:#fff; border:1px solid ${PALETTE.border}; border-left:3px solid ${barColor}; padding:10px 14px; border-radius:0 6px 6px 0; font-weight:500;">${dailyDelta}</div>` : ""}
        </td>
      </tr>
    </table>`;
}

// ─── Funnel table (CEO 19-Jun: tables over cards) ───────────────────────────
// One row per stage × columns for Agents / Rooftops / Enterprises / ARR plus
// a small day-over-day delta below the agent count. "Tables are denser, more
// professional, Excel is what business owners understand."
function heroBand({ funnel, deltas }) {
  if (!funnel) return "";
  const stages = [
    { label: "Contracted",    data: funnel.contracted, key: "contracted", dot: PALETTE.accent },
    { label: "In Onboarding", data: funnel.ob,         key: "ob",         dot: PALETTE.sec3   },
    { label: "Live",          data: funnel.live,       key: "live",       dot: PALETTE.green  },
    { label: "Churned",       data: funnel.churned,    key: "churned",    dot: PALETTE.red    },
  ];
  const th = (label, align = "right") => `
    <th style="padding:10px 14px; text-align:${align}; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">${label}</th>`;
  const numCell = (v, deltaV, money, isHeadline) => {
    const dStr = deltaV != null && deltaV !== 0
      ? `<div style="font-size:11px; color:${deltaColor(deltaV)}; margin-top:3px; font-weight:700;">${money ? signedMoney(deltaV) : signedNum(deltaV)}</div>`
      : "";
    return `
      <td style="padding:14px 14px; text-align:right; font-variant-numeric:tabular-nums;">
        <div style="font-size:${isHeadline ? "20px" : "16px"}; color:${PALETTE.text}; font-weight:${isHeadline ? 800 : 700}; line-height:1;">${money ? fmtMoney(v) : fmtNum(v)}</div>
        ${dStr}
      </td>`;
  };
  const rows = stages.map((s, i) => {
    const d  = s.data || {};
    const ds = deltas?.funnel?.[s.key] || {};
    const isLast = i === stages.length - 1;
    const bg = i % 2 === 1 ? "#f7f7f5" : PALETTE.card;
    const border = isLast ? "" : `border-bottom:1px solid ${PALETTE.border};`;
    return `
      <tr style="background:${bg};">
        <td style="padding:14px 16px; font-size:15px; color:${PALETTE.text}; font-weight:700; ${border}">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${s.dot}; margin-right:10px; vertical-align:middle;"></span>${s.label}
        </td>
        ${numCell(d.agents,   ds.agents,   false, true)}
        ${numCell(d.rooftops, ds.rooftops, false, false)}
        ${numCell(d.accounts, ds.accounts, false, false)}
        ${numCell(d.arr,      ds.arr,      true,  true)}
      </tr>`;
  }).join("");
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:10px; border-collapse:separate; border-spacing:0; overflow:hidden; margin-bottom:18px;">
      <tr>
        <th style="padding:10px 16px; text-align:left; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Stage</th>
        ${th("Agents")}
        ${th("Rooftops")}
        ${th("Enterprises")}
        ${th("ARR")}
      </tr>
      ${rows}
    </table>`;
}

// ─── At-a-glance summary table (NEW 19-Jun) ─────────────────────────────────
// "First fold = one strong table that carries the most info" (Sanjay).
// Rows = the 4 agents, columns = key MTD metrics. Lives at the top so a
// reader's first second on the email gives the full operational pulse.
function atAGlance({ historical, perAgentArr }) {
  if (!historical?.byAgent) return "";
  const agents = ["Sales IB", "Service IB", "Sales OB", "Service OB"];
  const pct  = (v) => v == null ? "—" : `${Math.round(v * 100)}%`;
  const pct1 = (v) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
  const num  = (v) => v == null ? "—" : fmtNum(v);

  const th = (label) => `
    <th style="padding:10px 10px; text-align:right; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">${label}</th>`;
  const cell = (val, fmt, condKey) => {
    const fg = condKey ? (condColor(condKey, val) || PALETTE.text) : PALETTE.text;
    return `<td style="padding:13px 10px; text-align:right; font-size:15px; color:${fg}; font-weight:800; font-variant-numeric:tabular-nums;">${fmt(val)}</td>`;
  };
  const rows = agents.map((a, i) => {
    const m = historical.byAgent[a] || {};
    const arr = perAgentArr?.[a] || {};
    const bg = i % 2 === 1 ? "#f7f7f5" : PALETTE.card;
    return `
      <tr style="background:${bg};">
        <td style="padding:13px 16px; font-size:14px; color:${PALETTE.text}; font-weight:700;">
          ${a}
          <div style="font-size:10px; color:${PALETTE.muted}; margin-top:3px; font-weight:600; font-variant-numeric:tabular-nums;">
            ${fmtMoney(arr.cArr)} → ${fmtMoney(arr.obArr)} → ${fmtMoney(arr.liveArr)}
          </div>
          <div style="font-size:10px; color:${PALETTE.soft}; margin-top:1px; font-weight:500; font-variant-numeric:tabular-nums;">
            ${fmtMrr(arr.cArr)} → ${fmtMrr(arr.obArr)} → ${fmtMrr(arr.liveArr)}
          </div>
        </td>
        ${cell(m.liveAgents?.mtd,  num,  null)}
        ${cell(m.leads?.mtd,       num,  null)}
        ${cell(m.appts?.mtd,       num,  null)}
        ${cell(m.abr?.mtd,         pct1, "abr")}
        ${cell(m.pctGreen?.mtd,    pct,  "pctGreen")}
        ${cell(m.pctAllClear?.mtd, pct,  "pctAllClear")}
        ${cell(m.pctBlocked?.mtd,  pct,  "pctBlocked")}
      </tr>`;
  }).join("");

  return `
    <div style="margin-bottom:8px; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted};">At a glance · MTD</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:10px; border-collapse:separate; border-spacing:0; overflow:hidden; margin-bottom:20px;">
      <tr>
        <th style="padding:10px 16px; text-align:left; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Agent <span style="font-weight:500; color:${PALETTE.soft}; letter-spacing:0;">· CARR → OB → Live</span></th>
        ${th("Live")}
        ${th("Leads")}
        ${th("Appts")}
        ${th("ABR")}
        ${th("Green")}
        ${th("All Clear")}
        ${th("Blocked")}
      </tr>
      ${rows}
    </table>`;
}

// ─── Per-agent trend table (CEO 17-Jun) ─────────────────────────────────────
// One block per agent type — Sales IB, Sales OB, Service IB, Service OB.
// Rows: # Live · % Green · % All Clear · ABR
// Cols: MTD · D-1 · D-2 · D-3 · M-1 · M-2 · M-3
// CEO: "MTD is the most important metric" — bold the MTD column.
// Conditional-format color picker for a percentage value. Returns a CSS
// color (red / amber / green / default text) given a metric type + value.
// Per-metric thresholds chosen to match the report's RAG semantics.
function condColor(metric, v, agent) {
  if (v == null) return null;
  // Appointments grades per agent TYPE (IB high-volume vs OB few/high-value).
  const t = metric === "appts"
    ? (agent && agent.endsWith("OB") ? { good: 3, amber: 1 } : { good: 10, amber: 3 })
    : {
    abr:         { good: 0.05, amber: 0.02 },      // ≥5% green, 2–5% amber
    pctGreen:    { good: 0.30, amber: 0.15 },
    pctAllClear: { good: 0.30, amber: 0.20 },
    pctBlocked:  { good: 0.15, amber: 0.30, inverse: true },  // <15% green, ≥30% red
    arrBlocked:  { good: 20_000, amber: 50_000, inverse: true },  // <$20K green, ≥$50K red
    roiMultiple: { good: 3,    amber: 1.5 },                  // ≥3× green, 1.5–3× amber
  }[metric];
  if (!t) return null;
  if (t.inverse) {
    if (v <  t.good)  return "#0b6635";
    if (v <  t.amber) return "#b85a08";
    return "#c92626";
  }
  if (v >= t.good)  return "#0b6635";
  if (v >= t.amber) return "#b85a08";
  return "#c92626";
}

// Light background fill matching a conditional text color — used for the ROI
// row so the green/amber/red grading reads as spreadsheet-style cell fill.
function condBgFill(metric, v, agent) {
  const c = condColor(metric, v, agent);
  if (!c) return "";
  return c === "#0b6635" ? "background:#e6f2eb;"
       : c === "#b85a08" ? "background:#fbeede;"
       : "background:#fbe8e8;";
}

function perAgentTrends({ historical, perAgentArr, arrDeltas }) {
  if (!historical || !historical.byAgent) return "";

  const dt = historical.dates || {};
  // Stakeholder-friendly column labels (CEO 18-Jun: "column name not
  // understandable"). Real dates for D-1/D-2/D-3, full month names for
  // M-1/M-2/M-3, current month name on MTD.
  const colKeys   = ["mtd", "d1", "d2", "d3", "m1", "m2", "m3"];
  const colLabels = {
    mtd: `${monthShort(dt.today)} MTD`,
    d1:  dayShort(dt.d1),         // e.g. "Jun 17"
    d2:  dayShort(dt.d2),
    d3:  dayShort(dt.d3),
    m1:  monthShort(dt.m1),       // e.g. "May"
    m2:  monthShort(dt.m2),
    m3:  monthShort(dt.m3),
  };
  const colSubs   = {
    mtd: "this month",
    d1:  "yesterday",
    d2:  "2 days ago",
    d3:  "3 days ago",
    m1:  "last month",
    m2:  "2 months ago",
    m3:  "3 months ago",
  };
  const pct  = (v) => v == null ? "—" : `${Math.round(v * 100)}%`;
  const pct1 = (v) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
  const num  = (v) => v == null ? "—" : fmtNum(v);
  const money= (v) => v == null ? "—" : fmtMoney(v);
  const mult = (v) => v == null ? "—" : `${Number(v).toFixed(2)}×`;
  const fmt  = {
    liveAgents:      num,
    pctGreen:        pct,
    pctAllClear:     pct,
    pctBlocked:      pct,
    arrBlocked:      money,
    roiMultiple:     mult,
    warmLeads:       num,
    abr:             pct1,
    pctRooftopsAppt: pct,
    callConnection:  pct,
    smsReply:        pct,
    transferRate:    pct,
    rooftopsActive:  num,
    rooftopsAppt:    num,
    leads:           num,
    qualified:       num,
    appts:           num,
    totalCalls:      num,
    totalSms:        num,
  };
  // Agent-aware metric rows. Transfer % is IB-only; Warm leads is OB-only
  // (placeholder until the field lands). Common rows render for all agents.
  const rowsFor = (agent) => {
    const isIB = agent.endsWith("IB");
    const isOB = agent.endsWith("OB");
    // Per-agent ABR denominator (user 26-Jun): Sales OB + Service IB use
    // qualified calls; Sales IB + Service OB stay on raw leads.
    const usesQualified = agent === "Sales OB" || agent === "Service IB";
    // Service OB's `appts`/`abr` already include voucher claims (folded in at
    // historicalAggregates.js's aggregateDailyMetabase) — relabel here so the
    // wording matches what's actually being counted.
    const isServiceOB = agent === "Service OB";
    const abrLabel = isServiceOB ? "ABR (outcomes ÷ leads)" : usesQualified ? "ABR (appts ÷ qualified)" : "ABR (appts ÷ leads)";
    return [
      { key: "liveAgents",  label: "Live agents",           color: PALETTE.text },
      // User 26-Jun: % Green right under the rooftop count.
      { key: "pctGreen",    label: "% Green (RAG)",         color: PALETTE.green,  cond: "pctGreen" },
      { key: "leads",       label: "Leads touched",         color: PALETTE.text },
      { key: "qualified",   label: "Qualified calls",       color: PALETTE.text },
      // Warm leads = distinct leads with appointment-intent (had_appt_intent),
      // a stronger cohort than "qualified" (any buying-intent). Wired 3-Jul via
      // the spine's appointment_intent_leads column.
      { key: "warmLeads",   label: "Warm leads",            color: PALETTE.text },
      isIB && { key: "transferRate", label: "Transfer %",   color: PALETTE.text },
      { key: "appts",       label: isServiceOB ? "Outcome Achieved" : "Appointments booked", color: PALETTE.accent, cond: "appts", condBg: true },
      { key: "abr",         label: abrLabel,                color: PALETTE.red,    cond: "abr",   condBg: true },
      { key: "roiMultiple", label: "ROI Multiple",          color: PALETTE.accent, cond: "roiMultiple", condBg: true },
      { key: "pctAllClear", label: "% All Clear (quality)", color: PALETTE.green,  cond: "pctAllClear" },
      { key: "arrBlocked",  label: "Blocked ARR (OB)",      color: PALETTE.amber,  cond: "arrBlocked" },
    ].filter(Boolean);
  };

  // Mirror the body-cell separator on the header row.
  const sepBorderH = (k) => {
    if (k === "d1" || k === "m1") return `border-left:2px solid ${PALETTE.muted};`;
    if (k === "d2" || k === "d3" || k === "m2" || k === "m3") return `border-left:1px solid ${PALETTE.border};`;
    return "";
  };
  // Sub-labels ("yesterday", "2 days ago", …) removed per user 8-Jul — the
  // date labels (Jul 7, Jun, …) already make the columns obvious.
  const th = (label, sub, isMTD, k) => `
    <th style="padding:10px 8px; text-align:right; font-size:11px; font-weight:700; letter-spacing:0.02em; color:${isMTD ? PALETTE.text : PALETTE.muted}; background:${isMTD ? "#fff5e6" : PALETTE.bg}; border-bottom:2px solid ${isMTD ? PALETTE.amber : PALETTE.border}; vertical-align:bottom; ${sepBorderH(k)}">
      <div>${label}</div>
    </th>`;

  const renderAgent = (agent) => {
    const m = historical.byAgent[agent];
    if (!m) return "";
    const arr = perAgentArr?.[agent] || { cArr: 0, obArr: 0, liveArr: 0 };

    const rows = rowsFor(agent).map((mr, i) => {
      // Highlighted rows (ABR red, Appointments blue) match the Studio
      // Health Report visual — full-row tinted background + white text.
      const isHL  = !!mr.highlight;
      const rowBg = isHL ? mr.highlight : (i % 2 === 1 ? "#f7f7f5" : PALETTE.card);
      const labelColor = isHL ? "#ffffff" : mr.color;
      const f = fmt[mr.key];

      // Vertical separator policy: group boundary (MTD→D-1 and D-3→M-1)
      // gets a slightly darker hairline; inner-group separators are softer.
      // User 23-Jun feedback: previous dark text-color borders were "very
      // dark" — softened to muted/border palette so the table reads cleanly.
      const sepBorder = (k) => {
        if (k === "d1" || k === "m1") return `border-left:2px solid ${PALETTE.muted};`;
        if (k === "d2" || k === "d3" || k === "m2" || k === "m3") return `border-left:1px solid ${PALETTE.border};`;
        return "";
      };

      let cells;
      if (mr.comingSoon) {
        cells = colKeys.map(k => {
          const isMTD = k === "mtd";
          const mtdBg = isMTD ? "background:#fff8ed;" : "";
          return `<td style="padding:11px 8px; text-align:right; font-size:13px; color:${PALETTE.soft}; font-variant-numeric:tabular-nums; ${mtdBg} ${sepBorder(k)}">—</td>`;
        }).join("");
      } else {
        cells = colKeys.map(k => {
          const v = m[mr.key]?.[k];
          const isMTD = k === "mtd";
          const condFg = !isHL && mr.cond ? condColor(mr.cond, v, agent) : null;
          // Conditional grading shows as TEXT color only (user 3-Jul: "too many
          // colors" — dropped the full-cell green/amber/red fills). MTD column
          // keeps its soft highlight.
          const bg = isHL ? "" : (isMTD ? "background:#fff8ed;" : "");
          const fg = condFg || (isHL ? "#ffffff" : PALETTE.text);
          return `<td style="padding:11px 8px; text-align:right; font-size:14px; color:${fg}; font-weight:${isMTD || isHL || condFg ? 800 : 600}; font-variant-numeric:tabular-nums; ${bg} ${sepBorder(k)}">${f(v)}</td>`;
        }).join("");
      }

      const labelExtra = mr.comingSoon
        ? ` <span style="font-size:9px; font-weight:700; color:${PALETTE.muted}; background:${PALETTE.bg}; border:1px solid ${PALETTE.border}; padding:1px 6px; border-radius:8px; letter-spacing:0.04em; text-transform:uppercase; margin-left:6px;">coming soon</span>`
        : "";
      return `
        <tr style="background:${rowBg};">
          <td style="padding:11px 14px; font-size:13px; color:${labelColor}; font-weight:700;">${mr.label}${labelExtra}</td>
          ${cells}
        </tr>`;
    }).join("");

    // User 2-Jul: CARR → In OB → Live ARR are KPI cards ABOVE the table (each a
    // funnel snapshot with MRR + day-on-day movement). Agent gets its identity
    // color on the name + the card top-borders.
    const agColor = AGENT_COLOR[agent] || PALETTE.text;
    const agDelta = arrDeltas?.[agent] || {};
    const deltaChip = (dN) => (dN == null || dN === 0) ? "" :
      `<span style="font-size:11px; font-weight:700; color:${deltaColor(dN)}; margin-left:6px; font-variant-numeric:tabular-nums;">${signedMoney(dN)}</span>`;
    // Neutral KPI cards (user 3-Jul: fewer colors) — dark values, one subtle
    // agent-colored top accent, no per-stage color trio. Delta chips still carry
    // green/red movement.
    const kpiCard = (label, value, delta) => `
      <td width="33.33%" valign="top" style="padding:0 5px;">
        <div style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-top:3px solid ${agColor}; border-radius:10px; padding:13px 15px;">
          <div style="font-size:10px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted};">${label}</div>
          <div style="font-size:23px; font-weight:800; color:${PALETTE.text}; margin-top:7px; font-variant-numeric:tabular-nums;">${money(value)}</div>
          <div style="font-size:11px; font-weight:600; color:${PALETTE.soft}; margin-top:3px;">${fmtMrr(value)}${deltaChip(delta)}</div>
        </div>
      </td>`;
    const kpiCards = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0; border-collapse:separate; border-spacing:0;">
        <tr>
          ${kpiCard("CARR",     arr.cArr,    agDelta.cArr)}
          ${kpiCard("In OB",    arr.obArr,   agDelta.obArr)}
          ${kpiCard("Live ARR", arr.liveArr, agDelta.liveArr)}
        </tr>
      </table>`;

    return `
      <div style="margin-top:22px;">
        <div style="display:flex; align-items:center; gap:9px;">
          <span style="width:5px; height:20px; border-radius:3px; background:${agColor}; display:inline-block;"></span>
          <span style="font-size:19px; font-weight:800; color:${agColor}; letter-spacing:-0.01em;">${agent}</span>
        </div>
        ${kpiCards}
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="margin-top:12px; background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; border-collapse:separate; border-spacing:0; overflow:hidden;">
          <tr>
            <th style="padding:9px 14px; text-align:left; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:2px solid ${PALETTE.border};">Metric</th>
            ${colKeys.map(k => th(colLabels[k], colSubs[k], k === "mtd", k)).join("")}
          </tr>
          ${rows}
        </table>
      </div>`;
  };

  // View dashboard CTA at the bottom (CEO 18-Jun).
  const dashboardBtn = `
    <div style="margin:28px 0 4px; text-align:center;">
      <a href="https://vini-daily-calls.vercel.app/agents"
         style="display:inline-block; background:${PALETTE.text}; color:#fff; font-size:14px; font-weight:700; letter-spacing:0.02em; text-decoration:none; padding:14px 32px; border-radius:24px;">
        View live dashboard →
      </a>
    </div>`;

  // Legend strip removed (user 23-Jun) — sub-labels inside the column
  // headers already carry the date-to-meaning mapping.
  return `
    ${sectionTitle(PALETTE.sec1, "By Agent · Trend",  "MTD · last 3 days · last 3 months")}
    ${["Sales IB", "Service IB", "Sales OB", "Service OB"].map(renderAgent).join("")}
    ${dashboardBtn}`;
}

function monthShort(yyyymmdd) {
  if (!yyyymmdd) return "";
  const m = yyyymmdd.slice(0, 7) + "-01";
  const d = new Date(m + "T12:00:00");
  return d.toLocaleString("en-US", { month: "short" });
}
function dayShort(yyyymmdd) {
  if (!yyyymmdd) return "";
  const d = new Date(yyyymmdd + "T12:00:00");
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

// Inline RAG dot (used in matrix cells next to numbers)
function dot(color) {
  return `<span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${color}; margin-right:6px; vertical-align:middle;"></span>`;
}

// ─── Commentary helper ──────────────────────────────────────────────────────
// Inline section-commentary helper removed 5-Jun. The three inline blocks
// (Onboarding / Live / Metrics) were restating numbers already visible in
// the tables below. Day-over-day deltas now live entirely inside the
// section title bar (dailyDelta prop on sectionTitle), powered by
// server/dailySnapshot.js.

// ─── Funnel + counts (Mehul, 29 May call) ───────────────────────────────────
// Contracted → OB → Live → Churned at agent-level, with Accounts · Rooftops ·
// Agents · ARR per stage. Replaces the old 3-tile hero band.

// Contracting-age card — shows enterprises stuck in contracting (not yet
// fully live) bucketed by Days Since Signing: 0-30, 30-60, 60+. Slots
// directly under the funnel since it's a contracted-stage drill-down.
function contractingAgeCard({ ageing }) {
  if (!ageing || !ageing.buckets) return "";
  const fgFor = (key) =>
    key === "0–30 days"  ? PALETTE.green :
    key === "30–60 days" ? PALETTE.amber :
                           PALETTE.red;
  // Compact: single inline strip instead of 3 tiles.
  return `
    <div style="margin-top:8px; font-size:11px; color:${PALETTE.muted}; line-height:1.5;">
      <strong style="color:${PALETTE.text};">Contracting age</strong> · ${fmtNum(ageing.total)} accounts not yet live · oldest ${fmtNum(ageing.oldestDays)} days &nbsp;·&nbsp;
      ${ageing.buckets.map(b =>
        `<span style="color:${fgFor(b.key)}; font-weight:700;">${b.key}</span> ${fmtNum(b.count)} (${fmtMoney(b.arr)})`
      ).join(" &nbsp;·&nbsp; ")}
    </div>`;
}

function funnelSection({ funnel, ageing, deltas }) {
  if (!funnel) return "";

  const colorOf = {
    Contracted: PALETTE.accent,
    "In Onboarding": PALETTE.sec3,
    Live: PALETTE.green,
    Churned: PALETTE.red,
  };

  const stages = [
    { label: "Contracted",    key: "contracted", data: funnel.contracted },
    { label: "In Onboarding", key: "ob",         data: funnel.ob         },
    { label: "Live",          key: "live",       data: funnel.live       },
    { label: "Churned",       key: "churned",    data: funnel.churned    },
  ];

  const thStyle = `padding:11px 14px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};`;
  const labelThStyle = `padding:11px 18px; text-align:left; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};`;

  const fmtOrDash = v => (v == null || v === 0) ? "—" : fmtNum(v);

  // Compact day-on-day delta string for a numeric cell. Stays grey when 0.
  const dCell = (n, kind = "num") => {
    if (n == null || n === 0) return "";
    return `<div style="font-size:10px; color:${deltaColor(n)}; margin-top:2px; font-weight:600;">${kind === "money" ? signedMoney(n) : signedNum(n)}</div>`;
  };

  const rows = stages.map((s, i) => {
    const d = s.data || {};
    const ds = deltas?.funnel?.[s.key] || null;
    const isLast = i === stages.length - 1;
    const bg = i % 2 === 1 ? "#f7f7f5" : PALETTE.card;
    const border = isLast ? "" : `border-bottom:1px solid ${PALETTE.border};`;
    return `
      <tr style="background:${bg};">
        <td style="padding:13px 18px; font-size:13px; color:${PALETTE.text}; font-weight:600; ${border}">
          <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:${colorOf[s.label] || PALETTE.muted}; margin-right:10px; vertical-align:middle;"></span>${s.label}
        </td>
        <td style="padding:13px 14px; text-align:right; font-size:13px; color:${PALETTE.text}; font-variant-numeric:tabular-nums; ${border}">${fmtOrDash(d.accounts)}${dCell(ds?.accounts)}</td>
        <td style="padding:13px 14px; text-align:right; font-size:13px; color:${PALETTE.text}; font-variant-numeric:tabular-nums; ${border}">${fmtOrDash(d.rooftops)}${dCell(ds?.rooftops)}</td>
        <td style="padding:13px 14px; text-align:right; font-size:13px; color:${PALETTE.text}; font-variant-numeric:tabular-nums; ${border}">${fmtOrDash(d.agents)}${dCell(ds?.agents)}</td>
        <td style="padding:13px 18px 13px 14px; text-align:right; font-size:14px; color:${PALETTE.text}; font-weight:700; font-variant-numeric:tabular-nums; ${border}">${d.arr != null ? fmtMoney(d.arr) : "—"}${dCell(ds?.arr, "money")}</td>
      </tr>`;
  }).join("");

  return `
    ${sectionTitle(PALETTE.accent, "Funnel — Contracted → Live", "Accounts · Rooftops · Agents · ARR per lifecycle stage")}
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; border-collapse:separate; border-spacing:0; overflow:hidden;">
      <tr>
        <th style="${labelThStyle}">Stage</th>
        <th style="${thStyle}">Accounts</th>
        <th style="${thStyle}">Rooftops</th>
        <th style="${thStyle}">Agents</th>
        <th style="${thStyle} padding-right:18px;">ARR</th>
      </tr>
      ${rows}
    </table>
    ${contractingAgeCard({ ageing })}`;
}

// ─── Section 1: Live RAG matrix + Top REDs ──────────────────────────────────

// Helpers for day-on-day annotations rendered under tables in small font.
function signedNum(n) {
  if (n == null || n === 0) return null;
  return n > 0 ? `+${n}` : `${n}`;
}
function signedMoney(n) {
  if (n == null || n === 0) return null;
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `$${Math.round(abs/1000)}K` : `$${Math.round(abs)}`;
  return n > 0 ? `+${s}` : `−${s}`;
}
function deltaColor(n) {
  if (n == null || n === 0) return "#787774";
  return n > 0 ? "#0f7b46" : "#d23f31";
}
// Inline colored delta — used in compact strips. Empty string if delta is zero/null.
function deltaSpan(label, n, kind = "num") {
  if (n == null || n === 0) return "";
  const s = kind === "money" ? signedMoney(n) : signedNum(n);
  return `<span style="color:${deltaColor(n)};">${label} ${s}</span>`;
}

function sec1Live({ byAgentType, whyNotGreen, topReds, topWins, dailyDelta, deltas }) {
  // Totals row — count + ARR per bucket
  const tot = byAgentType.reduce((a, b) => ({
    live: a.live + b.live,
    green: a.green + b.green, amber: a.amber + b.amber, red: a.red + b.red, churn: a.churn + b.churn,
    greenArr: a.greenArr + (b.greenArr || 0),
    amberArr: a.amberArr + (b.amberArr || 0),
    redArr:   a.redArr   + (b.redArr   || 0),
    churnArr: a.churnArr + (b.churnArr || 0),
  }), { live: 0, green: 0, amber: 0, red: 0, churn: 0, greenArr: 0, amberArr: 0, redArr: 0, churnArr: 0 });

  // "Actually Live" banner removed entirely 5-Jun (was already a no-op).

  // RAG matrix — Live agents only. Each cell stacks: count, ARR, and an
  // optional day-on-day delta (small grey, +X / -X) so movement is visible
  // without reading the commentary.
  const ragDelta = (label) =>
    (deltas?.rag || []).find(d => d.label === label) || null;

  const cell = (count, arrVal, dotColor, topBorder, _bold, deltaN) => {
    const arrStr = arrVal > 0 ? fmtMoney(arrVal) : "—";
    const dStr = deltaN != null && deltaN !== 0
      ? `<div style="font-size:10px; color:${deltaColor(deltaN)}; margin-top:1px; font-weight:600;">${signedNum(deltaN)}</div>`
      : "";
    // Bolder: 16px count, 13px ARR underneath. Stronger weight on the count.
    return `
      <td style="padding:14px 14px; text-align:right; font-variant-numeric:tabular-nums; ${topBorder}">
        <div class="matrix-num" style="font-size:20px; color:${PALETTE.text}; font-weight:800; line-height:1;">${dotColor ? dot(dotColor) : ""}${fmtNum(count)}</div>
        <div class="matrix-arr" style="font-size:13px; color:${PALETTE.muted}; margin-top:3px; font-weight:600;">${arrStr}</div>
        ${dStr}
      </td>`;
  };

  const matrixRow = (label, b, opts = {}) => {
    const bg = opts.bg || (opts.zebra ? "#f7f7f5" : PALETTE.card);
    const pctG = b.live > 0 ? Math.round((b.green / b.live) * 100) : 0;
    const w = opts.bold ? "font-weight:800;" : "font-weight:600;";
    const topBorder = opts.topBorder ? `border-top:1px solid ${PALETTE.border};` : "";
    const liveArr = (b.greenArr || 0) + (b.amberArr || 0) + (b.redArr || 0);
    const d = opts.deltas || null;
    return `
      <tr style="background:${bg};">
        <td style="padding:14px 18px; font-size:15px; color:${PALETTE.text}; ${w} ${topBorder}">${label}</td>
        ${cell(b.live,  liveArr,        null,         topBorder, opts.bold, d?.live)}
        ${cell(b.green, b.greenArr || 0, PALETTE.green, topBorder, opts.bold, d?.green)}
        ${cell(b.amber, b.amberArr || 0, PALETTE.amber, topBorder, opts.bold, d?.amber)}
        ${cell(b.red,   b.redArr   || 0, PALETTE.red,   topBorder, opts.bold, d?.red)}
        <td style="padding:14px 18px 14px 12px; text-align:right; font-size:16px; color:${PALETTE.text}; ${w} font-variant-numeric:tabular-nums; ${topBorder}">${pctG}%</td>
      </tr>`;
  };

  const thStyle = `padding:12px 14px; text-align:right; font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};`;
  const matrixTable = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; border-collapse:separate; border-spacing:0; overflow:hidden;">
      <tr>
        <th style="padding:10px 16px; text-align:left; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Agent</th>
        <th style="${thStyle}">Live</th>
        <th style="${thStyle}">Green</th>
        <th style="${thStyle}">Amber</th>
        <th style="${thStyle}">Red</th>
        <th style="${thStyle} padding-right:16px;">% Green</th>
      </tr>
      ${byAgentType.map((b, i) => matrixRow(b.label, b, { zebra: i % 2 === 1, deltas: ragDelta(b.label) })).join("")}
      ${matrixRow("Total", { ...tot }, {
        bold: true, topBorder: true, bg: "#f1f1ef",
        deltas: (deltas?.rag || []).reduce((s, d) => ({
          live:  s.live  + (d.live  || 0),
          green: s.green + (d.green || 0),
          amber: s.amber + (d.amber || 0),
          red:   s.red   + (d.red   || 0),
        }), { live: 0, green: 0, amber: 0, red: 0 }),
      })}
    </table>`;

  // (unscored footnote removed — the Actually Live banner above already
  // surfaces the N/A count as part of the derivation.)

  // Top cards — bolder typography per CEO 16-Jun. Rooftop name now 15px/700,
  // meta line 12px, ARR 18px/800. More vertical padding per row so the
  // numbers breathe.
  const topRow = (item, i, isWin) => {
    const color = isWin ? PALETTE.green : PALETTE.red;
    const arr = isWin ? (item.arr || (item.mrr || 0) * 12) : ((item.mrr || 0) * 12);
    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="${i > 0 ? `border-top:1px solid ${PALETTE.border};` : ""}">
        <tr>
          <td style="padding:12px 0;">
            <div class="topcard-name" style="font-size:15px; font-weight:700; color:${PALETTE.text}; letter-spacing:-0.01em;">${item.rooftop}</div>
            <div class="topcard-meta" style="font-size:12px; color:${PALETTE.muted}; margin-top:4px; font-weight:500;">
              ${item.agentShort} &nbsp;·&nbsp; ABR ${item.abrPct != null ? fmtPct(item.abrPct) : "—"} &nbsp;·&nbsp; ROI ${fmtMult(item.roiMultiple)}
            </div>
          </td>
          <td align="right" valign="middle" style="padding:12px 0; white-space:nowrap;">
            <span class="topcard-arr" style="font-size:18px; font-weight:800; color:${color}; font-variant-numeric:tabular-nums;">${fmtMoney(arr)}</span>
          </td>
        </tr>
      </table>`;
  };

  const topWinsCard = (topWins && topWins.length) ? `
    <div style="margin-top:16px; background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; padding:16px 18px;">
      ${microLabel("Top 3 wins · rotated daily", PALETTE.green)}
      <div style="margin-top:8px;">
        ${topWins.slice(0, 3).map((w, i) => topRow(w, i, true)).join("")}
      </div>
    </div>` : "";

  const topRedsCard = (topReds && topReds.length) ? `
    <div style="margin-top:12px; background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; padding:16px 18px;">
      ${microLabel("Top 3 to fix · rotated daily", PALETTE.red)}
      <div style="margin-top:8px;">
        ${topReds.slice(0, 3).map((r, i) => topRow(r, i, false)).join("")}
      </div>
    </div>` : "";

  // Why-not-GREEN block — splits each agent type's Red+Amber into TOFU
  // (volume problem) vs Performance (conversion problem). Sits between the
  // matrix and the Top-REDs card as a diagnostic dimension.
  const wng = whyNotGreen || { blocks: [] };
  // Sum across blocks so the table's "Total" column reconciles with the
  // Live − Green count visible in the matrix above.
  const wngTotals = wng.blocks.reduce((s, b) => ({
    tofu:  s.tofu  + (b.tofu?.count   || 0),
    perf:  s.perf  + (b.performance?.count || 0),
    amber: s.amber + (b.amber?.count  || 0),
    nodata:s.nodata+ (b.noData?.count || 0),
    total: s.total + (b.total         || 0),
  }), { tofu: 0, perf: 0, amber: 0, nodata: 0, total: 0 });

  const wngCol = (count, arr, color) => `
    <td style="padding:9px 10px; text-align:right;">
      <div style="font-size:13px; color:${color}; font-weight:700;">${fmtNum(count)}</div>
      <div style="font-size:11px; color:${PALETTE.muted}; margin-top:1px;">${fmtMoney(arr)}</div>
    </td>`;
  const th = (label, color) => `<th style="padding:8px 10px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${color || PALETTE.muted}; border-bottom:1px solid ${PALETTE.border};">${label}</th>`;

  const whyNotGreenBlock = wng.blocks.length ? `
    <div style="margin-top:18px; background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; padding:16px 20px;">
      ${microLabel("Why not GREEN — root cause")}
      <div style="font-size:12px; color:${PALETTE.muted}; margin-top:6px; line-height:1.5;">
        <strong style="color:${PALETTE.amber};">TOFU</strong> = under ${wng.threshold ?? 100} leads (volume) &nbsp;·&nbsp;
        <strong style="color:${PALETTE.red};">Perf</strong> = leads OK, appts not landing &nbsp;·&nbsp;
        <strong style="color:${PALETTE.amber};">Amber</strong> = borderline ROI &nbsp;·&nbsp;
        <strong style="color:${PALETTE.muted};">No data</strong> = missing from Metabase
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px; font-variant-numeric:tabular-nums; border-collapse:collapse;">
        <tr>
          <th style="padding:8px 0; text-align:left; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted}; border-bottom:1px solid ${PALETTE.border};">Agent</th>
          ${th("TOFU")}
          ${th("Perf")}
          ${th("Amber")}
          ${th("No data")}
          ${th("Total not Green", PALETTE.text)}
        </tr>
        ${wng.blocks.map(b => `
          <tr>
            <td style="padding:9px 0; font-size:13px; color:${PALETTE.text};">${b.agentType}</td>
            ${wngCol(b.tofu?.count        ?? 0, b.tofu?.arr        ?? 0, PALETTE.amber)}
            ${wngCol(b.performance?.count ?? 0, b.performance?.arr ?? 0, PALETTE.red)}
            ${wngCol(b.amber?.count       ?? 0, b.amber?.arr       ?? 0, PALETTE.amber)}
            ${wngCol(b.noData?.count      ?? 0, b.noData?.arr      ?? 0, PALETTE.muted)}
            <td style="padding:9px 10px; text-align:right; font-size:13px; color:${PALETTE.text}; font-weight:700; border-left:1px solid ${PALETTE.border};">${fmtNum(b.total || 0)}</td>
          </tr>`).join("")}
        <tr>
          <td style="padding:10px 0; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; border-top:1px solid ${PALETTE.border};">Total</td>
          <td style="padding:10px 10px; text-align:right; font-size:13px; color:${PALETTE.amber}; font-weight:700; border-top:1px solid ${PALETTE.border};">${fmtNum(wngTotals.tofu)}</td>
          <td style="padding:10px 10px; text-align:right; font-size:13px; color:${PALETTE.red};   font-weight:700; border-top:1px solid ${PALETTE.border};">${fmtNum(wngTotals.perf)}</td>
          <td style="padding:10px 10px; text-align:right; font-size:13px; color:${PALETTE.amber}; font-weight:700; border-top:1px solid ${PALETTE.border};">${fmtNum(wngTotals.amber)}</td>
          <td style="padding:10px 10px; text-align:right; font-size:13px; color:${PALETTE.muted}; font-weight:700; border-top:1px solid ${PALETTE.border};">${fmtNum(wngTotals.nodata)}</td>
          <td style="padding:10px 10px; text-align:right; font-size:13px; color:${PALETTE.text};  font-weight:700; border-top:1px solid ${PALETTE.border}; border-left:1px solid ${PALETTE.border};">${fmtNum(wngTotals.total)}</td>
        </tr>
      </table>
    </div>` : "";

  // Inline liveCommentary block removed 5-Jun — the matrix below shows the
  // same Green/Amber/Red counts and the day-over-day dailyDelta carries the
  // narrative. No need to restate.
  // Why-not-Green — promoted from inline footnote to a proper card per CEO
  // 16-Jun. Four big-number cells side-by-side, color-coded, with a "Total
  // not Green" summary line above. Reads at a glance, doesn't fight the
  // matrix above for attention.
  const wngCard = wng.blocks.length ? `
    <div style="margin-top:16px; background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; padding:16px 18px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td>
            ${microLabel("Why not GREEN")}
            <div style="font-size:13px; color:${PALETTE.muted}; margin-top:4px; font-weight:500;">Breakdown of all <strong style="color:${PALETTE.text};">${wngTotals.total}</strong> non-Green Live agents</div>
          </td>
        </tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px; border-collapse:separate; border-spacing:8px 0;">
        <tr>
          ${[
            { lbl: "TOFU",     sub: "volume",     n: wngTotals.tofu,   color: PALETTE.amber  },
            { lbl: "Perf",     sub: "conversion", n: wngTotals.perf,   color: PALETTE.red    },
            { lbl: "Amber",    sub: "borderline", n: wngTotals.amber,  color: PALETTE.amber  },
            { lbl: "No data",  sub: "missing",    n: wngTotals.nodata, color: PALETTE.muted  },
          ].map(t => `
            <td valign="top" style="width:25%; background:${PALETTE.bg}; border-radius:8px; padding:12px 10px;">
              <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${t.color};">${t.lbl}</div>
              <div class="matrix-num" style="font-size:26px; font-weight:800; color:${PALETTE.text}; line-height:1; margin-top:6px; font-variant-numeric:tabular-nums;">${fmtNum(t.n)}</div>
              <div style="font-size:11px; color:${PALETTE.muted}; margin-top:4px; font-weight:500;">${t.sub}</div>
            </td>`).join("")}
        </tr>
      </table>
    </div>` : "";

  return `
    ${sectionTitle(PALETTE.sec1, "Live Agents", null, dailyDelta)}
    ${matrixTable}
    ${wngCard}
    ${topWinsCard}
    ${topRedsCard}`;
}

// ─── Section 2: Yesterday — daily pulse ─────────────────────────────────────

function sec2Yesterday({ usage, dailyDelta }) {
  const daily = usage && usage.daily;
  if (!daily) return "";
  const dateLabel = daily.asOfDate
    ? new Date(daily.asOfDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "yesterday";

  // Compact: 6 inline KPIs in one strip — Calls · Leads · Appts · ABR · Fail · ROI.
  const fail = daily.callFailureRate != null ? `${(daily.callFailureRate * 100).toFixed(1)}%` : "—";
  const roi  = usage.portfolio && usage.portfolio.weightedRoi;
  const kpi  = (label, value, color) => `
    <td style="padding:10px 8px; text-align:center;">
      <div style="font-size:9px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted};">${label}</div>
      <div style="font-size:18px; font-weight:700; color:${color || PALETTE.text}; margin-top:4px; font-variant-numeric:tabular-nums; letter-spacing:-0.01em;">${value}</div>
    </td>`;

  return `
    ${sectionTitle(PALETTE.sec2, `Yesterday · ${dateLabel}`, null, dailyDelta)}
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px;">
      <tr>
        ${kpi("Calls",  fmtNum(daily.calls))}
        ${kpi("Leads",  fmtNum(daily.leadsInteracted))}
        ${kpi("Appts",  fmtNum(daily.appointments))}
        ${kpi("ABR",    daily.abr != null ? fmtPct(daily.abr * 100) : "—")}
        ${kpi("Fail",   fail, daily.callFailureRate != null ? PALETTE.red : PALETTE.muted)}
        ${kpi("ROI",    fmtMult(roi))}
      </tr>
    </table>`;
}

// ─── Section 3: Onboarding pipeline ─────────────────────────────────────────

function sec3OB({ obRaw, dailyDelta, deltas }) {
  // Show every agent type with OB rows — including AI Receptionist,
  // Parts Inbound, Service Recall etc. summarizeInOb orders canonical-4
  // first then appends extras by count desc.
  const canonical = obRaw.byAgentType || [];
  const obDelta   = (label) => (deltas?.obByAgent || []).find(d => d.label === label) || null;

  // OB per-agent table — In_Ob source. "Current Month Confirmations" column
  // splits accounts into Unblocked (Confirmed in the sheet — will go live
  // this month) vs Blocked (Upside in the sheet — uncertain). Sheet labels
  // are mapped to stakeholder-facing terms in the UI.
  const thStyle = `padding:10px 12px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};`;
  const tableHeader = `
    <tr>
      <th style="padding:10px 16px; text-align:left; font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Agent</th>
      <th style="${thStyle}">Accounts</th>
      <th style="${thStyle}">Unblocked</th>
      <th style="${thStyle} padding-right:16px;">Blocked</th>
    </tr>`;

  const obCell = (count, arrVal, dotColor, deltaN) => {
    if (count <= 0 && (deltaN == null || deltaN === 0))
      return `<td style="padding:11px 12px; text-align:right; color:${PALETTE.muted};">0</td>`;
    const dStr = deltaN != null && deltaN !== 0
      ? `<div style="font-size:10px; color:${deltaColor(deltaN)}; margin-top:2px; font-weight:600;">${signedNum(deltaN)}</div>`
      : "";
    return `
      <td style="padding:11px 12px; text-align:right; font-variant-numeric:tabular-nums;">
        <div style="font-size:13px; color:${PALETTE.text}; font-weight:600;">${dotColor ? dot(dotColor) : ""}${fmtNum(count)}</div>
        <div style="font-size:11px; color:${PALETTE.muted}; margin-top:1px;">${fmtMoney(arrVal)}</div>
        ${dStr}
      </td>`;
  };

  const rows = canonical.map((b, i) => {
    const bg = i % 2 === 1 ? "#f7f7f5" : PALETTE.card;
    const d = obDelta(b.label);
    return `
      <tr style="background:${bg};">
        <td style="padding:11px 16px; font-size:13px; color:${PALETTE.text};">${b.label}</td>
        ${obCell(b.count,      b.arr,           null,           d?.count)}
        ${obCell(b.confirmed,  b.confirmedArr,  PALETTE.green,  d?.confirmed)}
        ${obCell(b.upside,     b.upsideArr,     PALETTE.amber,  d?.upside)}
      </tr>`;
  }).join("");

  const totalRow = `
    <tr style="background:#f1f1ef; border-top:1px solid ${PALETTE.border};">
      <td style="padding:11px 16px; font-size:13px; font-weight:700; color:${PALETTE.text}; border-top:1px solid ${PALETTE.border};">Total</td>
      <td style="padding:11px 12px; text-align:right; font-variant-numeric:tabular-nums; border-top:1px solid ${PALETTE.border};">
        <div style="font-size:13px; font-weight:700; color:${PALETTE.text};">${fmtNum(obRaw.totalCount)}</div>
        <div style="font-size:11px; color:${PALETTE.muted}; margin-top:1px;">${fmtMoney(obRaw.totalArr)}</div>
      </td>
      <td style="padding:11px 12px; text-align:right; font-variant-numeric:tabular-nums; border-top:1px solid ${PALETTE.border};">
        <div style="font-size:13px; font-weight:700; color:${PALETTE.green};">${fmtNum(obRaw.confirmedCount || 0)}</div>
        <div style="font-size:11px; color:${PALETTE.muted}; margin-top:1px;">${fmtMoney(obRaw.confirmedArr || 0)}</div>
      </td>
      <td style="padding:11px 16px 11px 12px; text-align:right; font-variant-numeric:tabular-nums; border-top:1px solid ${PALETTE.border};">
        <div style="font-size:13px; font-weight:700; color:${PALETTE.amber};">${fmtNum(obRaw.upsideCount || 0)}</div>
        <div style="font-size:11px; color:${PALETTE.muted}; margin-top:1px;">${fmtMoney(obRaw.upsideArr || 0)}</div>
      </td>
    </tr>`;

  const obTable = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; border-collapse:separate; border-spacing:0; overflow:hidden;">
      ${tableHeader}
      ${rows}
      ${totalRow}
    </table>`;

  // Compact: top blocker reasons as a one-line inline strip under the table.
  const bucketCard = (obRaw.blockBuckets || []).length ? `
    <div style="margin-top:8px; font-size:11px; color:${PALETTE.muted}; line-height:1.5;">
      <strong style="color:${PALETTE.text};">Top blockers:</strong>
      ${obRaw.blockBuckets.slice(0, 4).map(b =>
        `${b.key} <span style="font-weight:700; color:${PALETTE.text};">${fmtMoney(b.arr)}</span>`
      ).join(" &nbsp;·&nbsp; ")}
    </div>` : "";

  // "Current OB" math banner — mirrors Mehul's whiteboard:
  //   OB total  −  OB Drop  −  Not in OB  =  Current OB
  // OB Drop and "Not in OB" come from the contracts sheet's lifecycle stages
  // when available; the OB Raw sheet already filters to Stage == "OB Initiated"
  // so its totalCount IS Current OB. We show the derivation so the audience
  // sees what the number excludes.
  // Inline obCommentary, Current OB banner, and section subtitle removed
  // 5-Jun — those numbers already live in the funnel table + table below.
  // Day-over-day delta (from dailySnapshot) is the only narrative here.

  return `
    ${sectionTitle(PALETTE.sec3, "Onboarding Pipeline", null, dailyDelta)}
    ${obTable}
    ${bucketCard}`;
}

// ─── Methodology footer ─────────────────────────────────────────────────────

function methodFooter({ ragThresholds }) {
  const rt = ragThresholds || {};
  // Compact: one line, muted. Stakeholders rarely re-read this — keep it small.
  return `
    <div style="margin-top:18px; padding-top:12px; border-top:1px solid ${PALETTE.border}; font-size:10px; color:${PALETTE.muted}; line-height:1.5;">
      <strong>RAG</strong>: TOFU-red &lt; ${rt.tofuLeads ?? 100} leads · Green ROI ≥ ${rt.roiGreen ?? 5}× · Amber ${rt.roiAmber ?? 3}–${rt.roiGreen ?? 5}× · Perf-red &lt; ${rt.roiAmber ?? 3}× · No-Metabase → Red.
    </div>`;
}

// ─── Main builder ────────────────────────────────────────────────────────────

// ─── Live Agent Issues (Superbryn quality eval) ────────────────────────────
// Per-agent-type quality breakdown: All Clear / Blind Spot / False Alarm /
// Red Alert + top issues by evaluation lane. Sits right under the Live RAG
// matrix because quality drives what stakeholders should act on next.
//
// Data shape (filled by server/superbrynQuality.js once per-agent keys land):
//   quality = {
//     asOfDate,
//     agents: [
//       { label, ingested, analyzed, filtered, quality: { allClear, blindSpot, falseAlarm, redAlert },
//         qualityDeltaPp: { allClear, blindSpot, falseAlarm, redAlert },
//         topIssues: [{ lane, label, failedCalls, failRate, trend? }] }
//     ]
//   }
function qualitySection({ quality }) {
  if (!quality || !quality.agents || quality.agents.length === 0) {
    // Stub state — until per-agent Superbryn keys are wired.
    return `
      ${sectionTitle(PALETTE.sec1, "Live Agent Quality", "Per-agent call-quality + top issues from Superbryn evaluations")}
      <div style="background:${PALETTE.card}; border:1px dashed ${PALETTE.border}; border-radius:12px; padding:18px 20px;">
        <div style="font-size:13px; color:${PALETTE.muted}; line-height:1.6;">
          <strong style="color:${PALETTE.text};">Quality data pending.</strong>
          The Superbryn key in <code>.env</code> is not scoped to an agent — generate one key per agent type
          (Sales IB / Sales OB / Service IB / Service OB) from the Superbryn dashboard, drop them in <code>.env</code>
          as <code>SUPERBRYN_KEY_SALES_IB</code> etc., and this section will populate automatically.
          <div style="margin-top:10px; font-size:11px;">When live, this block will show All Clear / Blind Spot / False Alarm / Red Alert per agent type, day-on-day pp change, and the top 5 failed evaluation lanes ranked by fail rate.</div>
        </div>
      </div>`;
  }

  // Compact: ONE table for all 4 agents. Cols = Agent · Analyzed · AC% · BS%
  // · FA% · RA% · Top issue. Verdict % cells stack pp delta below in small
  // font. Top issue cell pulls the highest-failed-calls item across lanes.
  const pctOf = (a, k) => {
    const t = a.analyzed || 0;
    return t > 0 ? Math.round(((a.quality?.[k] || 0) / t) * 100) : 0;
  };
  // Bolder verdict cell: 18px % count, pp delta below at 11px.
  const verdictCell = (a, k, color) => {
    const pp = a.qualityDeltaPp?.[k];
    return `
      <td style="padding:14px 12px; text-align:right; font-variant-numeric:tabular-nums;">
        <div style="font-size:18px; font-weight:800; color:${color}; line-height:1;">${pctOf(a, k)}%</div>
        ${pp != null && pp !== 0 ? `<div style="font-size:11px; color:${deltaColor(pp)}; margin-top:3px; font-weight:700;">${signedNum(pp)}pp</div>` : ""}
      </td>`;
  };
  const th = (label, color) => `<th style="padding:11px 12px; text-align:right; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${color || PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">${label}</th>`;

  const rows = quality.agents.map((a, i) => {
    const bg = i % 2 === 1 ? "#f7f7f5" : PALETTE.card;
    return `
      <tr style="background:${bg};">
        <td style="padding:14px 16px; font-size:15px; color:${PALETTE.text}; font-weight:700;">${a.label}</td>
        <td style="padding:14px 12px; text-align:right; font-size:14px; color:${PALETTE.text}; font-weight:600; font-variant-numeric:tabular-nums;">${fmtNum(a.analyzed)}</td>
        ${verdictCell(a, "allClear",   PALETTE.green)}
        ${verdictCell(a, "blindSpot",  PALETTE.amber)}
        ${verdictCell(a, "falseAlarm", "#1e88c9")}
        ${verdictCell(a, "redAlert",   PALETTE.red)}
      </tr>`;
  }).join("");

  // Window note as a single small caption under the title.
  const windowNotes = [...new Set(quality.agents.map(a => a.windowNote).filter(Boolean))];

  return `
    ${sectionTitle(PALETTE.sec1, "Live Agent Quality", `Superbryn · ${windowNotes.join(" · ") || "as of " + (quality.asOfDate || "—")}`)}
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:12px; border-collapse:separate; border-spacing:0; overflow:hidden;">
      <tr>
        <th style="padding:11px 16px; text-align:left; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Agent</th>
        ${th("Analyzed")}
        ${th("All Clear", PALETTE.green)}
        ${th("Blind Spot", PALETTE.amber)}
        ${th("False Alarm", "#1e88c9")}
        ${th("Red Alert", PALETTE.red)}
      </tr>
      ${rows}
    </table>
    <div style="margin-top:6px; font-size:11px; color:${PALETTE.muted}; line-height:1.4; font-weight:500;">
      Full issues breakdown at the bottom of this report.
    </div>`;
}

// ─── Issues by Lane (bottom-of-report comprehensive table) ─────────────────
// Per CEO 16-Jun: the top quality summary shows verdict %, but stakeholders
// need to SEE the actual failed issues per agent type. This table sits at
// the bottom — full list of top issues per agent, grouped by agent type.
function issuesTable({ quality }) {
  if (!quality || !quality.agents) return "";
  const agentsWithIssues = quality.agents.filter(a => (a.topIssues || []).length > 0);
  if (!agentsWithIssues.length) return "";

  const renderAgent = (a) => {
    const issues = (a.topIssues || []).slice(0, 5);
    const rows = issues.map((iss, i) => {
      const bg = i % 2 === 1 ? "#f7f7f5" : PALETTE.card;
      return `
        <tr style="background:${bg};">
          <td style="padding:11px 14px; font-size:13px; color:${PALETTE.text}; font-weight:600;">${iss.label}</td>
          <td style="padding:11px 10px; text-align:right; font-size:12px; color:${PALETTE.muted}; font-weight:500; white-space:nowrap;">${iss.lane}</td>
          <td style="padding:11px 10px; text-align:right; font-size:15px; color:${PALETTE.red}; font-weight:800; font-variant-numeric:tabular-nums;">${fmtNum(iss.failedCalls)}</td>
          <td style="padding:11px 14px 11px 10px; text-align:right; font-size:15px; color:${PALETTE.red}; font-weight:800; font-variant-numeric:tabular-nums;">${Math.round((iss.failRate || 0) * 100)}%</td>
        </tr>`;
    }).join("");
    return `
      <div style="margin-top:14px;">
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:6px;">
          <div style="font-size:15px; font-weight:700; color:${PALETTE.text};">${a.label}</div>
          <div style="font-size:11px; color:${PALETTE.muted}; font-weight:500;">${fmtNum(a.analyzed)} analyzed</div>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:${PALETTE.card}; border:1px solid ${PALETTE.border}; border-radius:10px; border-collapse:separate; border-spacing:0; overflow:hidden;">
          <tr>
            <th style="padding:9px 14px; text-align:left; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Issue</th>
            <th style="padding:9px 10px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Lane</th>
            <th style="padding:9px 10px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Failed</th>
            <th style="padding:9px 14px 9px 10px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PALETTE.muted}; background:${PALETTE.bg}; border-bottom:1px solid ${PALETTE.border};">Rate</th>
          </tr>
          ${rows}
        </table>
      </div>`;
  };

  return `
    ${sectionTitle(PALETTE.sec1, "Top Quality Issues by Agent", "Top 5 failed evaluation issues per agent · ranked by failed-call count")}
    ${agentsWithIssues.map(renderAgent).join("")}`;
}

export function buildAgentsEmailHtml(payload, timeLabel, dashboardUrl) {
  const { sec1, sec2 } = payload;

  const dateLabel = new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  // Tightened header (CEO 19-Jun feedback: "kill the decorative top"). Title
  // + date inline, single line. Dashboard link still here so the click-out is
  // available from the first fold, but in muted text instead of a pill.
  const topStrip = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px; border-bottom:1px solid ${PALETTE.border}; padding-bottom:10px;">
      <tr>
        <td style="vertical-align:baseline;">
          <span style="font-size:20px; font-weight:800; color:${PALETTE.text}; letter-spacing:-0.02em;">Vini Control Tower</span>
          <span style="font-size:13px; color:${PALETTE.muted}; margin-left:8px; font-weight:500;">${dateLabel}</span>
        </td>
        <td align="right" valign="baseline" style="font-size:12px;">
          <a href="${dashboardUrl || '#'}" style="color:${PALETTE.accent}; text-decoration:none; font-weight:700;">Open dashboard →</a>
        </td>
      </tr>
    </table>`;

  // CTA at the bottom removed — header now carries the link.
  const cta = "";

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vini Control Tower · ${timeLabel}</title>
  <style>${RESPONSIVE_CSS}</style>
</head>
<body style="margin:0; padding:0; background:${PALETTE.bg}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:${PALETTE.text};">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" class="container" style="background:${PALETTE.bg}; padding:18px 0;">
    <tr><td align="center">
      <table width="720" cellpadding="0" cellspacing="0" border="0" style="max-width:720px; width:100%;">
        <tr><td class="body-pad" style="padding:4px 28px 24px;">
          ${topStrip}
          ${heroBand({ funnel: sec2.funnelV2, deltas: payload.deltas })}
          ${perAgentTrends({ historical: payload.historical, perAgentArr: payload.perAgentArr, arrDeltas: payload.deltas?.perAgentArr })}
          ${methodFooter({ ragThresholds: sec1.ragThresholds, costPerAppt: sec1.costPerAppt })}
          ${cta}
          <div style="margin-top:24px; font-size:11px; color:${PALETTE.soft}; text-align:center;">
            Generated ${dateLabel} · ${timeLabel}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
