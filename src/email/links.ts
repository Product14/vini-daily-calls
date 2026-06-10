// Build the real console.spyne.ai deep links for a rooftop digest — same shape the
// email uses (enterprise_id, team_id, dealer-local "yesterday" window, serviceType).
import type { DeptKind } from "./mockData";

function localToUTC(y: number, m: number, day: number, tz: string): Date {
  const approx = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(approx);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value ?? "0");
  const asUTC = new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"), g("second")));
  return new Date(approx.getTime() + (approx.getTime() - asUTC.getTime()));
}
function windowFor(reportDate: string, tz: string): { startISO: string; endISO: string } {
  const [y, m, d] = reportDate.split("-").map(Number);
  const start = localToUTC(y, m, d, tz);
  const end = new Date(localToUTC(y, m, d + 1, tz).getTime() - 1);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export type DigestLinks = { appointments: string; conversations: string; actionItems: string };

export function buildConsoleLinks(opts: {
  enterpriseId?: string;
  teamId?: string;
  dept?: DeptKind;
  reportDate?: string; // ISO yyyy-mm-dd
  timezone?: string;
}): DigestLinks {
  const ent = opts.enterpriseId ?? "";
  const team = opts.teamId ?? "";
  const svc = opts.dept ?? "sales";
  const tz = opts.timezone || "America/New_York";
  const { startISO, endISO } = windowFor(opts.reportDate || "1970-01-01", tz);
  const enc = encodeURIComponent;
  const base = "https://console.spyne.ai/converse-ai";
  return {
    appointments: `${base}/appointments?enterprise_id=${ent}&team_id=${team}&all_createdAtStart=${enc(startISO)}&all_createdAtEnd=${enc(endISO)}&all_createdAtDateValue=yesterday&page=1&serviceType=${svc}&tab=all`,
    conversations: `${base}/conversations?enterprise_id=${ent}&team_id=${team}`,
    actionItems: `${base}/action-items?enterprise_id=${ent}&team_id=${team}&serviceType=${svc}&createdAtStart=${enc(startISO)}&createdAtEnd=${enc(endISO)}&page=1`,
  };
}
