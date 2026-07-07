// ─── Shared per-agent identity colors ───────────────────────────────────────
// One color per agent, used consistently across the email and both Slack
// layouts. Chosen distinct from the RAG palette (green/amber/red) so an
// agent's identity color is never confused with its health status.
export const AGENT_COLOR = {
  "Sales IB":   "#2563eb", // blue
  "Service IB": "#0d9488", // teal
  "Sales OB":   "#7c3aed", // violet
  "Service OB": "#db2777", // magenta
};
export const agentColor = (agent) => AGENT_COLOR[agent] || "#1f1d18";

// Shared RAG thresholds so the email and both Slack layouts grade metrics
// identically. Mirrors condColor() in agentsEmailTemplate.js — keep in sync.
const COND = {
  abr:         { good: 0.05,   amber: 0.02 },
  roiMultiple: { good: 3,      amber: 1.5 },
  pctGreen:    { good: 0.30,   amber: 0.15 },
  pctAllClear: { good: 0.30,   amber: 0.20 },
  arrBlocked:  { good: 20_000, amber: 50_000, inverse: true },
};
// Appointments is a raw count, so it grades per agent TYPE: IB books high
// volume, OB books few but high-value (user 3-Jul, option B).
const APPT_COND = { IB: { good: 10, amber: 3 }, OB: { good: 3, amber: 1 } };
export const apptThreshold = (agent) => (agent && agent.endsWith("OB")) ? APPT_COND.OB : APPT_COND.IB;
export const RAG = { green: "#0b6635", amber: "#b85a08", red: "#c92626" };
export function condColor(metric, v, agent) {
  if (v == null || isNaN(v)) return null;
  const t = metric === "appts" ? apptThreshold(agent) : COND[metric];
  if (!t) return null;
  if (t.inverse) return v < t.good ? RAG.green : v < t.amber ? RAG.amber : RAG.red;
  return v >= t.good ? RAG.green : v >= t.amber ? RAG.amber : RAG.red;
}
