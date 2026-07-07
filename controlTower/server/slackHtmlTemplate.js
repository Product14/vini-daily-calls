// ─── Vini Daily — Slack card grid + per-agent tables ───────────────────────
// User 24-Jun (final): "keep the data like the earlier version we created
// yesterday. design and layout like today."
//
// → Yesterday's data shape = per-agent mini table with D-1 + MTD columns
//   for Live agents · Leads · Appts · ABR % · % Green · % All Clear ·
//   Blocked ARR.
// → Today's layout = LinkedIn-card aesthetic (purple hero with Northstar
//   on top, polished white cards with bigger numbers below).
//
// Output is portrait so the click-through fills a phone screen.

const PAL = {
  bg:     "#f5f3f1",
  card:   "#ffffff",
  border: "#e8e6e3",
  text:   "#1f1d18",
  muted:  "#6b6863",
  soft:   "#9b9893",
  red:    "#c92626",
  amber:  "#b85a08",
  green:  "#0b6635",
  accent: "#1e88c9",
  sec3:   "#b85a08",
  heroStart: "#6c63ff",
  heroEnd:   "#a78bfa",
};

import { AGENT_COLOR } from "./agentColors.js";
const AGENTS = ["Sales IB", "Service IB", "Sales OB", "Service OB"];

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1_000)}K`;
  return `$${v.toFixed(0)}`;
}
// MRR = ARR / 12, shown alongside each ARR figure.
function fmtMrr(n) {
  if (n == null || isNaN(n)) return "—";
  return `${fmtMoney(Number(n) / 12)}/mo`;
}
function fmtNum(n)   { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
function pct(v)      { return v == null ? "—" : `${Math.round(v * 100)}%`; }
function pct1(v)     { return v == null ? "—" : `${(v * 100).toFixed(1)}%`; }
function mult(v)     { return v == null ? "—" : `${Number(v).toFixed(2)}×`; }
function dayShort(yyyymmdd) {
  if (!yyyymmdd) return "—";
  const d = new Date(yyyymmdd + "T12:00:00");
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

function condColor(metric, v) {
  if (v == null) return PAL.muted;
  const t = {
    abr:         { good: 0.05, amber: 0.02 },
    pctGreen:    { good: 0.30, amber: 0.15 },
    pctAllClear: { good: 0.30, amber: 0.20 },
    arrBlocked:  { good: 20_000, amber: 50_000, inverse: true },
    roiMultiple: { good: 3, amber: 1.5 },
  }[metric];
  if (!t) return PAL.text;
  if (t.inverse) {
    if (v <  t.good)  return PAL.green;
    if (v <  t.amber) return PAL.amber;
    return PAL.red;
  }
  if (v >= t.good)  return PAL.green;
  if (v >= t.amber) return PAL.amber;
  return PAL.red;
}

export function buildSlackHtml(data) {
  const { funnel, asOfDate, dates, byAgent, perAgentArr } = data;
  const f = funnel || {};

  // ─── Northstar hero (today's LinkedIn-purple style) ────────────────────
  const liveArr   = f.live?.arr      ?? 0;
  const liveCount = f.live?.agents   ?? 0;
  const hero = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
      <tr>
        <td style="background:linear-gradient(135deg, ${PAL.heroStart} 0%, ${PAL.heroEnd} 100%); border-radius:14px; padding:24px 28px;">
          <div style="font-size:11px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.78);">Live · Northstar</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
            <tr>
              <td>
                <div style="font-size:46px; font-weight:800; color:#fff; line-height:1; letter-spacing:-0.03em; font-variant-numeric:tabular-nums;">${fmtMoney(liveArr)}</div>
                <div style="font-size:13px; color:rgba(255,255,255,0.85); margin-top:6px; font-weight:600;">${fmtNum(liveCount)} agents live</div>
              </td>
              <td align="right" valign="top" style="font-size:11px; color:rgba(255,255,255,0.75); font-weight:600; line-height:1.6;">
                Contracted ${fmtNum(f.contracted?.agents)}<br>
                In OB ${fmtNum(f.ob?.agents)}<br>
                Churn ${fmtNum(f.churned?.agents)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  // ─── Per-agent card — yesterday's data shape, today's card polish ──────
  // Each card stacks: colored header bar (agent name + CARR/OB/Live ARR
  // strip) → mini table with 7 metric rows × 2 cols (D-1 + MTD).
  const cell = (val, fmt, condKey, isMTD) => {
    const fg = condKey ? condColor(condKey, val) : PAL.text;
    const bg = isMTD ? "background:#fff8ed;" : "";
    return `<td style="padding:8px 12px; text-align:right; font-size:15px; font-weight:800; color:${fg}; font-variant-numeric:tabular-nums; ${bg}">${fmt(val)}</td>`;
  };

  const agentCard = (agent) => {
    const color = AGENT_COLOR[agent];
    const m     = byAgent?.[agent] || {};
    const arr   = perAgentArr?.[agent] || {};
    // Warm leads omitted from Slack — appointment_intent_leads is empty for
    // both OB agents today. Add back once the upstream source lands.
    const rows = [
      { label: "Live agents", key: "liveAgents",  fmt: fmtNum,    cond: null },
      { label: "% Green",     key: "pctGreen",    fmt: pct,       cond: "pctGreen" },
      { label: "Leads",       key: "leads",       fmt: fmtNum,    cond: null },
      { label: "Appts",       key: "appts",       fmt: fmtNum,    cond: null },
      { label: "ABR",         key: "abr",         fmt: pct1,      cond: "abr" },
      { label: "ROI Multiple",key: "roiMultiple", fmt: mult,      cond: "roiMultiple" },
      { label: "% All Clear", key: "pctAllClear", fmt: pct,       cond: "pctAllClear" },
      { label: "Blocked ARR", key: "arrBlocked",  fmt: fmtMoney,  cond: "arrBlocked" },
    ];
    const rowsHtml = rows.map((r, i) => `
      <tr style="background:${i % 2 === 1 ? PAL.bg : PAL.card};">
        <td style="padding:8px 16px; font-size:13px; color:${PAL.text}; font-weight:600; border-top:1px solid ${PAL.border};">${r.label}</td>
        ${cell(m[r.key]?.d1,  r.fmt, r.cond, false)}
        ${cell(m[r.key]?.mtd, r.fmt, r.cond, true)}
      </tr>`).join("");

    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAL.card}; border:1px solid ${PAL.border}; border-radius:12px; border-collapse:separate; border-spacing:0; overflow:hidden; margin-bottom:10px;">
        <tr>
          <td style="background:${color}; color:#fff; padding:12px 16px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:16px; font-weight:800; letter-spacing:-0.01em;">${agent}</td>
                <td align="right" style="font-size:11px; font-weight:700; color:rgba(255,255,255,0.92); font-variant-numeric:tabular-nums; white-space:nowrap;">
                  CARR ${fmtMoney(arr.cArr)} <span style="font-weight:500; color:rgba(255,255,255,0.72);">(${fmtMrr(arr.cArr)})</span> → OB ${fmtMoney(arr.obArr)} <span style="font-weight:500; color:rgba(255,255,255,0.72);">(${fmtMrr(arr.obArr)})</span> → Live ${fmtMoney(arr.liveArr)} <span style="font-weight:500; color:rgba(255,255,255,0.72);">(${fmtMrr(arr.liveArr)})</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <th style="padding:8px 16px; text-align:left; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PAL.muted}; background:${PAL.bg}; border-bottom:1px solid ${PAL.border};">Metric</th>
          <th style="padding:8px 12px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PAL.muted}; background:${PAL.bg}; border-bottom:1px solid ${PAL.border};">
            ${dayShort(dates?.d1)}
            <div style="font-size:8px; color:${PAL.soft}; margin-top:2px; font-weight:500; letter-spacing:0; text-transform:none;">yesterday</div>
          </th>
          <th style="padding:8px 12px; text-align:right; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${PAL.text}; background:#fff5e6; border-bottom:2px solid ${PAL.amber};">
            MTD
            <div style="font-size:8px; color:${PAL.soft}; margin-top:2px; font-weight:500; letter-spacing:0; text-transform:none;">this month</div>
          </th>
        </tr>
        ${rowsHtml}
      </table>`;
  };

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <title>Vini Daily · Slack · ${asOfDate}</title>
</head>
<body style="margin:0; padding:0; background:${PAL.bg}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:${PAL.text}; width:720px;">
  <div style="padding:18px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
      <tr>
        <td>
          <div style="font-size:10px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:${PAL.accent};">Vini · Daily</div>
          <div style="font-size:22px; font-weight:800; color:${PAL.text}; letter-spacing:-0.02em; line-height:1.1; margin-top:3px;">Control Tower</div>
        </td>
        <td align="right" valign="top" style="font-size:12px; color:${PAL.muted}; font-weight:600;">${asOfDate}</td>
      </tr>
    </table>

    ${hero}
    ${AGENTS.map(agentCard).join("")}

    <div style="margin-top:6px; font-size:10px; color:${PAL.soft}; text-align:center; font-weight:500;">
      D-2 · D-3 · last 3 months — see email report.
    </div>
  </div>
</body></html>`;
}
