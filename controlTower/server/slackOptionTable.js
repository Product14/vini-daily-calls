// ─── Slack "Option B" — dark-table layout (CS Report style) ─────────────────
// Navy header, KPI chips, agent-health bar, then a Metric × (per-agent +
// Overall) table. Operating metrics are yesterday (D-1) with MTD; CARR / In OB
// / Live ARR are current snapshots with day-on-day (d/d) movement. Appointments
// + ABR are RAG-graded per value (appointments per agent TYPE).

import { AGENT_COLOR, condColor } from "./agentColors.js";

const PAL = {
  navy: "#14315c",
  page: "#eef1f5", card: "#ffffff", border: "#dfe3ea",
  text: "#16202e", muted: "#6b7480", soft: "#9aa2ad",
  red: "#c0281f", amber: "#b8690a", green: "#1a7a44", blue: "#2660c4",
  rowAlt: "#f3f5f8",
  chipBlue: "#eaf1fb", chipGray: "#f1f3f6", chipRed: "#fdeceb", chipGreen: "#eaf6ef",
};
const AGENTS = ["Sales IB", "Service IB", "Sales OB", "Service OB"];
const dColorLight = (n) => n > 0 ? PAL.green : n < 0 ? PAL.red : PAL.soft;
const signedMoney = (n) => {
  if (n == null || n === 0) return "";
  const v = Math.abs(n), s = n > 0 ? "+" : "−";
  const t = v >= 1_000_000 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1e3)}K` : `$${v}`;
  return `${s}${t}`;
};
function money(n) {
  if (n == null || isNaN(n)) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1_000)}K`;
  return `$${v.toFixed(0)}`;
}
const mrr  = (n) => (n == null || isNaN(n)) ? "—" : `${money(Number(n) / 12)}/mo`;
const num  = (n) => n == null ? "—" : Number(n).toLocaleString("en-US");
const pct  = (v) => v == null ? "—" : `${Math.round(v * 100)}%`;
const pct1 = (v) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
const mult = (v) => v == null ? "—" : `${Number(v).toFixed(2)}×`;

function chip({ label, value, sub, bg, valueColor }) {
  return `
    <div style="flex:1; background:${bg}; border:1px solid ${PAL.border}; border-radius:14px; padding:18px 18px; text-align:center;">
      <div style="font-size:14px; font-weight:800; letter-spacing:0.06em; text-transform:uppercase; color:${PAL.muted};">${label}</div>
      <div style="font-size:34px; font-weight:800; color:${valueColor || PAL.text}; margin-top:8px; font-variant-numeric:tabular-nums;">${value}</div>
      ${sub ? `<div style="font-size:15px; color:${PAL.muted}; margin-top:5px;">${sub}</div>` : ""}
    </div>`;
}

function healthBar(rag) {
  const t = rag.total || 1;
  const seg = (n, c) => `<span style="width:${(n / t) * 100}%; background:${c}; display:inline-block; height:100%;"></span>`;
  return `
    <div style="margin-top:6px;">
      <div style="font-size:15px; font-weight:800; letter-spacing:0.06em; text-transform:uppercase; color:${PAL.muted};">Vini · Agent Health</div>
      <div style="display:flex; height:20px; border-radius:10px; overflow:hidden; margin-top:10px; background:${PAL.rowAlt};">
        ${seg(rag.green, PAL.green)}${seg(rag.amber, PAL.amber)}${seg(rag.red, PAL.red)}
      </div>
      <div style="font-size:18px; margin-top:11px; font-weight:700;">
        <span style="color:${PAL.green};">${rag.green} Green (${pct(rag.green / t)})</span>
        <span style="color:${PAL.soft};"> · </span>
        <span style="color:${PAL.amber};">${rag.amber} Amber (${pct(rag.amber / t)})</span>
        <span style="color:${PAL.soft};"> · </span>
        <span style="color:${PAL.red};">${rag.red} Red (${pct(rag.red / t)})</span>
      </div>
    </div>`;
}

export function buildTableHtml(p) {
  const f = p.funnel;
  const rag = p.rag || { green: 0, amber: 0, red: 0, total: 0 };
  const B = p.byAgent || {};
  const A = p.perAgentArr || {};

  const d1  = (agent, key) => B[agent]?.[key]?.d1;
  const mtd = (agent, key) => B[agent]?.[key]?.mtd;
  const sumD1  = (key) => AGENTS.reduce((s, a) => s + (Number(d1(a, key))  || 0), 0);
  const sumMtd = (key) => AGENTS.reduce((s, a) => s + (Number(mtd(a, key)) || 0), 0);
  const sumArr = (key) => AGENTS.reduce((s, a) => s + (Number(A[a]?.[key]) || 0), 0);

  // User 12-Aug: slimmed Slack table — removed CARR/In OB/Live ARR/Live agents,
  // Leads, % All Clear, Blocked ARR; Warm leads → Qualified Leads.
  const rows = [
    { label: "% Green",         fmt: pct,   key: "pctGreen",   overall: pct(rag.total ? rag.green / rag.total : null) },
    { label: "Qualified Leads", fmt: num,   key: "qualified", showMtd: true, overall: num(sumD1("qualified")), overallMtd: num(sumMtd("qualified")) },
    { label: "Appointments",    fmt: num,   key: "appts",  cond: "appts", showMtd: true, overall: num(sumD1("appts")), overallVal: sumD1("appts"), overallMtd: num(sumMtd("appts")) },
    { label: "ABR",             fmt: pct1,  key: "abr",    cond: "abr",   showMtd: true, overall: pct1(sumD1("leads") ? sumD1("appts") / sumD1("leads") : null), overallVal: sumD1("leads") ? sumD1("appts") / sumD1("leads") : null, overallMtd: pct1(sumMtd("leads") ? sumMtd("appts") / sumMtd("leads") : null) },
    { label: "ROI Multiple",    fmt: mult,  key: "roiMultiple", useMtd: true, overall: "—" },
  ];

  const cellColor = (label) =>
    label === "ABR" || label === "Blocked ARR" ? PAL.red :
    label === "Appointments" ? PAL.blue :
    label === "% Green" || label === "% All Clear" || label === "Live ARR" ? PAL.green :
    PAL.text;

  const mtdLine = (txt) => `<div style="font-size:14px; font-weight:600; color:${PAL.muted}; margin-top:4px;">MTD ${txt}</div>`;
  const ddLine  = (d) => (d == null || d === 0) ? "" :
    `<div style="font-size:13px; font-weight:800; color:${dColorLight(d)}; margin-top:4px;">${signedMoney(d)} d/d</div>`;
  const bodyRows = rows.map((r, i) => {
    const bg = i % 2 === 1 ? PAL.rowAlt : PAL.card;
    const cells = AGENTS.map(a => {
      // ROI is a monthly-scale metric — show MTD (a single day ÷ monthly MRR is
      // meaningless). Everything else shows yesterday (D-1).
      const v = r.arrKey ? A[a]?.[r.arrKey] : (r.useMtd ? mtd(a, r.key) : d1(a, r.key));
      const sub = r.arrKey ? ddLine(p.arrDeltas?.[a]?.[r.arrKey])
                : r.showMtd ? mtdLine(r.fmt(mtd(a, r.key))) : "";
      const cColor = r.cond ? (condColor(r.cond, v, a) || PAL.text) : PAL.text;
      return `<td style="padding:15px 14px; text-align:right; font-size:19px; font-weight:800; color:${cColor}; font-variant-numeric:tabular-nums;">${r.fmt(v)}${sub}</td>`;
    }).join("");
    const oSub = r.arrKey ? ddLine(p.overallArrDeltas?.[r.arrKey])
              : r.showMtd && r.overallMtd ? mtdLine(r.overallMtd) : "";
    const oColor = r.cond ? (condColor(r.cond, r.overallVal) || cellColor(r.label)) : cellColor(r.label);
    return `
      <tr style="background:${bg};">
        <td style="padding:15px 18px; font-size:19px; font-weight:800; color:${PAL.text}; white-space:nowrap;">${r.label}</td>
        ${cells}
        <td style="padding:15px 18px; text-align:right; font-size:19px; font-weight:800; color:${oColor}; font-variant-numeric:tabular-nums; border-left:1px solid ${PAL.border};">${r.overall}${oSub}</td>
      </tr>`;
  }).join("");

  const headCell = (t, extra = "") =>
    `<th style="padding:16px 14px; text-align:${extra ? "right" : "left"}; font-size:18px; font-weight:800; color:#fff;">${t}</th>`;
  const agentHeadCell = (a) =>
    `<th style="padding:16px 14px; text-align:right; font-size:18px; font-weight:800; color:#fff; border-bottom:5px solid ${AGENT_COLOR[a]};">${a}</th>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box; margin:0; padding:0;}
    body{background:${PAL.page}; color:${PAL.text}; width:900px; padding:26px;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased;}
    table{border-collapse:separate; border-spacing:0;}
  </style></head><body>
    <div style="background:${PAL.card}; border:1px solid ${PAL.border}; border-radius:16px; overflow:hidden;">
      <div style="background:${PAL.navy}; padding:24px; text-align:center;">
        <div style="font-size:32px; font-weight:800; color:#fff; letter-spacing:0.01em;">Vini Control Tower · Daily</div>
        <div style="font-size:17px; font-weight:600; color:#c3d0e2; margin-top:7px;">${p.asOfDate} · operating metrics = yesterday, with MTD</div>
      </div>

      <div style="padding:24px;">
        <div style="display:flex; gap:14px;">
          ${chip({ label: "Live ARR", value: money(f.live.arr), sub: `${mrr(f.live.arr)} · ${num(f.live.agents)} agents${p.overallArrDeltas?.liveArr ? ` · <span style="color:${dColorLight(p.overallArrDeltas.liveArr)}; font-weight:800;">${signedMoney(p.overallArrDeltas.liveArr)} d/d</span>` : ""}`, bg: PAL.chipBlue, valueColor: PAL.blue })}
          ${chip({ label: "In OB",    value: money(f.ob.arr),   sub: `${num(f.ob.agents)} agents`,          bg: PAL.chipGray })}
          ${chip({ label: "Churn MTD", value: money(f.churned.arr), sub: `${num(f.churned.agents)} agents`,  bg: PAL.chipRed,   valueColor: PAL.red })}
          ${chip({ label: "% Green",  value: pct(rag.total ? rag.green / rag.total : null), sub: `${rag.green}G · ${rag.amber}A · ${rag.red}R`, bg: PAL.chipGreen, valueColor: PAL.green })}
        </div>

        <div style="margin-top:18px;">${healthBar(rag)}</div>

        <table width="100%" style="margin-top:20px; border:1px solid ${PAL.border}; border-radius:10px; overflow:hidden;">
          <tr style="background:${PAL.navy};">
            ${headCell("Metric")}
            ${AGENTS.map(a => agentHeadCell(a)).join("")}
            ${headCell("Overall", "right")}
          </tr>
          ${bodyRows}
        </table>
      </div>
    </div>
  </body></html>`;
}
