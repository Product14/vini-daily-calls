// Email rendering + dispatch for the Account Programs Daily Snapshot.
// Inline-styled, table-based HTML — Outlook-safe. Mirrors the in-app
// Email Report view as closely as Outlook 365 can render.
//
// Dispatch goes through Spyne's internal Mailgun proxy at mail.spyne.ai.
// The proxy fixes the sender + handles deliverability — we only supply the
// recipient list, subject, and HTML body (sent in `templateData.HTMLdata`).
// Auth: the proxy currently accepts unauthenticated POSTs. If that changes,
// set EMAIL_PROXY_COOKIE in .env and we'll forward it as the Cookie header.

const RAG_COLORS = {
  red:   { bg: "#fee2e2", fg: "#991b1b" },
  amber: { bg: "#fef3c7", fg: "#92400e" },
  green: { bg: "#dcfce7", fg: "#166534" },
};
const AGENT_LABELS = {
  "Sales Inbound":    "Sales IB",
  "Service Inbound":  "Service IB",
  "Sales Outbound":   "Sales OB",
  "Service Outbound": "Service OB",
};
const ETA_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const fmtMoney = (n) => n == null ? "—" : `$${Math.round(n).toLocaleString()}`;
const fmtPct   = (n) => `${Number(n).toFixed(0)}%`;
function fmtEtaShort(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${ETA_MONTHS[Number(m[2]) - 1]}`;
}
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Cell + header style helpers — inline so every email client gets them.
const cellTd  = `padding:6px 8px;border-top:1px solid #f3f4f6;color:#111827;font-size:11px;font-family:Arial,Helvetica,sans-serif;`;
const headTh  = `padding:6px 6px;background:#e5e7eb;color:#374151;text-transform:uppercase;letter-spacing:0.3px;font-size:10px;font-weight:700;font-family:Arial,Helvetica,sans-serif;border-bottom:1px solid #cbd5e1;`;
const bandTd  = `padding:8px 10px;background:#f3f4f6;font-weight:700;color:#111827;font-size:12px;font-family:Arial,Helvetica,sans-serif;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;`;
const totalTd = `padding:6px 8px;border-top:2px solid #e5e7eb;font-weight:700;color:#111827;background:#fafafa;font-size:11px;font-family:Arial,Helvetica,sans-serif;`;

function ragLabelCell(rag) {
  const c = RAG_COLORS[rag];
  const label = rag === "red" ? "Red" : rag === "amber" ? "Amber" : "Green";
  return `<td style="${cellTd}background:${c.bg};color:${c.fg};font-weight:700;text-align:center;">${label}</td>`;
}

// ─── Section 1 — RAG split (Section in a left column, rowspan per band) ────
function renderRagSplit(overall, perAgent) {
  // sectionLabel spans 4 rows: red / amber / green / total. The label cell
  // uses rowspan=4 so it's only emitted on the first row of the band.
  const sectionCellStyle = "padding:8px 10px;font-weight:700;color:#111827;font-size:11px;font-family:Arial,Helvetica,sans-serif;background:#f9fafb;border-top:1px solid #e5e7eb;border-right:1px solid #e5e7eb;vertical-align:top;";
  const band = (label, cnt, arr, red, amber, green, totalLabel) => {
    const rags = ["red","amber","green"];
    const rows = rags.map((r, i) => {
      const b = r === "red" ? red : r === "amber" ? amber : green;
      const sectionTd = i === 0 ? `<td rowspan="4" style="${sectionCellStyle}">${escapeHtml(label)}</td>` : "";
      return `<tr>
        ${sectionTd}
        ${ragLabelCell(r)}
        <td style="${cellTd}text-align:right;">${b.count}</td>
        <td style="${cellTd}text-align:right;">${fmtPct(b.pctCount)}</td>
        <td style="${cellTd}text-align:right;">${fmtMoney(b.arr)}</td>
        <td style="${cellTd}text-align:right;">${fmtPct(b.pctArr)}</td>
      </tr>`;
    }).join("");
    const totalRow = `<tr>
      <td style="${totalTd}">${escapeHtml(totalLabel)}</td>
      <td style="${totalTd}text-align:right;">${cnt}</td>
      <td style="${totalTd}text-align:right;">${cnt > 0 ? "100%" : "—"}</td>
      <td style="${totalTd}text-align:right;">${fmtMoney(arr)}</td>
      <td style="${totalTd}text-align:right;">${arr > 0 ? "100%" : "—"}</td>
    </tr>`;
    return rows + totalRow;
  };
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e5e7eb;margin:0 auto;">
      <thead>
        <tr>
          <th style="${headTh}width:88px;border-right:1px solid #cbd5e1;">Section</th>
          <th style="${headTh}width:64px;">RAG</th>
          <th style="${headTh}width:60px;text-align:right;">Agents</th>
          <th style="${headTh}width:44px;text-align:right;">%</th>
          <th style="${headTh}width:92px;text-align:right;">ARR</th>
          <th style="${headTh}width:44px;text-align:right;">%</th>
        </tr>
      </thead>
      <tbody>
        ${band("Overall", overall.totalCount, overall.totalArr, overall.red, overall.amber, overall.green, "Total")}
        ${perAgent.map(row =>
          band(AGENT_LABELS[row.agent] ?? row.agent, row.totalCount, row.totalArr, row.red, row.amber, row.green, "Subtotal")
        ).join("")}
      </tbody>
    </table>
  `;
}

// ─── Section 2 — Per-CSM RAG summary ────────────────────────────────────────
// For each account's CSM, count how many of their live accounts are Red /
// Amber / Green, with ARR sums. RAG buckets become columns (tinted); each CSM
// emits two rows ("# Agents" + "$ ARR") joined by a rowspan=2 CSM cell. CSMs
// sorted by Not-Green ARR desc; "No CSM Mapped" pinned to the bottom.
function renderCsmRagSummary(section2) {
  const ownerCellStyle = "padding:8px 10px;font-weight:700;color:#111827;font-size:12px;font-family:Arial,Helvetica,sans-serif;background:#f9fafb;border-top:1px solid #e5e7eb;border-right:1px solid #e5e7eb;vertical-align:middle;";
  const metricTd = `padding:6px 10px;border-top:1px solid #f3f4f6;color:#374151;font-size:11px;font-family:Arial,Helvetica,sans-serif;font-weight:700;background:#fafafa;border-right:1px solid #e5e7eb;white-space:nowrap;`;
  const valueTd  = (rag) => `padding:6px 10px;border-top:1px solid #f3f4f6;color:${RAG_COLORS[rag].fg};font-size:11px;font-family:Arial,Helvetica,sans-serif;font-weight:700;text-align:right;background:${RAG_COLORS[rag].bg};`;
  const headRagTh = (rag) => `padding:6px 10px;background:${RAG_COLORS[rag].bg};color:${RAG_COLORS[rag].fg};text-transform:uppercase;letter-spacing:0.3px;font-size:10px;font-weight:700;font-family:Arial,Helvetica,sans-serif;border-bottom:1px solid #cbd5e1;text-align:right;`;
  const ownerHtml = ({ csmLabel, csmKey, red, amber, green }) => {
    const labelMarkup = csmKey
      ? `<span style="color:#111827;">${escapeHtml(csmLabel)}</span>`
      : `<span style="color:#dc2626;">No CSM Mapped</span>`;
    return `
      <tr>
        <td rowspan="2" style="${ownerCellStyle}">${labelMarkup}</td>
        <td style="${metricTd}"># Agents</td>
        <td style="${valueTd("red")}">${red.count}</td>
        <td style="${valueTd("amber")}">${amber.count}</td>
        <td style="${valueTd("green")}">${green.count}</td>
      </tr>
      <tr>
        <td style="${metricTd}">$ ARR</td>
        <td style="${valueTd("red")}">${fmtMoney(red.arr)}</td>
        <td style="${valueTd("amber")}">${fmtMoney(amber.arr)}</td>
        <td style="${valueTd("green")}">${fmtMoney(green.arr)}</td>
      </tr>
    `;
  };
  const bodyHtml = section2.length
    ? section2.map(ownerHtml).join("")
    : `<tr><td colspan="5" style="${cellTd}color:#9ca3af;text-align:center;">No CSMs with open tasks on live accounts.</td></tr>`;
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e5e7eb;margin:0 auto;">
      <thead>
        <tr>
          <th style="${headTh}width:140px;border-right:1px solid #cbd5e1;text-align:left;">CSM</th>
          <th style="${headTh}width:80px;border-right:1px solid #cbd5e1;"></th>
          <th style="${headRagTh("red")}width:80px;">Red</th>
          <th style="${headRagTh("amber")}width:80px;">Amber</th>
          <th style="${headRagTh("green")}width:80px;">Green</th>
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  `;
}

// ─── Full email shell ──────────────────────────────────────────────────────
export function renderProgramsEmailHtml({ overall, perAgent, section2, dateText, dashboardUrl }) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Account Programs · Daily Snapshot</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;">
      <tr>
        <td align="center" style="padding:20px 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:580px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
            <tr>
              <td style="padding:16px;">
                <h1 style="margin:0 0 4px;font-size:18px;font-weight:800;color:#111827;font-family:Arial,Helvetica,sans-serif;">
                  Account Programs · Daily Snapshot
                </h1>
                <div style="font-size:12px;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(dateText)}</div>

                <div style="margin-top:18px;display:flex;align-items:center;">
                  <span style="display:inline-block;width:20px;height:20px;background:#111827;color:#ffffff;border-radius:4px;text-align:center;font-size:11px;font-weight:700;line-height:20px;font-family:Arial,Helvetica,sans-serif;">1</span>
                  <span style="margin-left:8px;font-size:14px;font-weight:700;color:#111827;font-family:Arial,Helvetica,sans-serif;">Portfolio · RAG split</span>
                </div>
                <div style="margin-top:10px;">${renderRagSplit(overall, perAgent)}</div>

                ${dashboardUrl ? `
                <div style="margin-top:22px;text-align:center;">
                  <a href="${escapeHtml(dashboardUrl)}#tasks" style="display:inline-block;padding:10px 22px;background:#0f766e;color:#ffffff;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;font-family:Arial,Helvetica,sans-serif;letter-spacing:0.2px;">
                    View all tasks →
                  </a>
                </div>` : ""}

                <div style="margin-top:24px;display:flex;align-items:center;">
                  <span style="display:inline-block;width:20px;height:20px;background:#111827;color:#ffffff;border-radius:4px;text-align:center;font-size:11px;font-weight:700;line-height:20px;font-family:Arial,Helvetica,sans-serif;">2</span>
                  <span style="margin-left:8px;font-size:14px;font-weight:700;color:#111827;font-family:Arial,Helvetica,sans-serif;">CSMs · path to green</span>
                </div>
                <div style="margin-top:10px;">${renderCsmRagSummary(section2)}</div>

                <div style="margin-top:18px;font-size:11px;color:#9ca3af;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">
                  Each CSM row counts the distinct live (rooftop × agent) accounts they cover that have at least one open next-step. CSMs sorted by Not-Green ARR descending — the bigger their red/amber pile, the higher they appear. Accounts with no CSM bucket under "No CSM Mapped".
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ─── Send via Spyne mail proxy (Mailgun) ───────────────────────────────────
// The proxy endpoint accepts a single `to` and arrays for `cc` / `bcc`. For a
// portfolio report we want every recipient visible to every other recipient
// (it's a CS standup, not a marketing blast), so the first address goes in
// `to` and the rest go in `cc`. `bcc` stays empty.
export async function sendProgramsReportEmail({ payload, recipients, subject, dashboardUrl }) {
  if (!recipients || recipients.length === 0) throw new Error("No recipients");
  const url      = (process.env.EMAIL_PROXY_URL      || "https://mail.spyne.ai/api/v1/send-template-email").trim();
  const template = (process.env.EMAIL_PROXY_TEMPLATE || "email-control-tower-report").trim();
  const cookie   = (process.env.EMAIL_PROXY_COOKIE   || "").trim();   // optional

  const dateText = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "short", year: "numeric"
  });
  const html = renderProgramsEmailHtml({ ...payload, dateText, dashboardUrl });
  const [primary, ...rest] = recipients;

  const body = {
    to: primary,
    cc: rest,
    bcc: [],
    subject: subject || `Vini RAG Report · Daily Snapshot · ${dateText}`,
    template,
    templateData: { HTMLdata: html },
  };

  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }

  if (!resp.ok) {
    const reason = json?.message || json?.error || text || `HTTP ${resp.status}`;
    throw new Error(`mail.spyne.ai ${resp.status}: ${reason}`);
  }
  return { ok: true, status: resp.status, response: json ?? text, recipients };
}
