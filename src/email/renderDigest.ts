// Canonical email template entry point for the SPA preview + manual "send now".
// The HTML itself lives in the shared, email-safe template `digestTemplate.cjs`
// (the SAME module the cron renderer requires — single source of truth, so the
// preview and the sent bytes never drift). This file only builds the view-model
// (links + dept + date label + enrichment) from the stored DigestMetrics.
import { buildConsoleLinks } from "./links";
import { renderDigestHtml, type DigestAppointment, type DigestDeployment, type DigestUpsell } from "./digestTemplate.cjs";
import type { DeptKind, DigestMetrics } from "./mockData";

function fmtDate(reportDate?: string): string {
  const [y, m, d] = String(reportDate ?? "").split("-").map(Number);
  if (!y || !m || !d) return String(reportDate ?? "");
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export type RenderOpts = {
  rooftopName: string;
  dept?: DeptKind;
  teamId?: string;
  enterpriseId?: string;
  reportDate?: string;
  timezone?: string;
  /** ClickHouse-enriched upcoming appointments (car name + $ est + schedule). */
  appointments?: DigestAppointment[];
  /** Top vehicles of interest (car names). */
  topVehicles?: { name: string; count: number }[];
  /** Configurable $ per appointment used to estimate pipeline value. */
  dollarRate?: number;
  /** Open-tracking pixel URL (omit in the SPA preview). */
  pixelUrl?: string;
  /** Base URL prefix for bundled assets (hero photo, campaign creatives). */
  assetBase?: string;
  /** Decorative campaign-card header images (by index). */
  campaignImages?: string[];
  /** Agent deployment state → drives the logic-driven upsell banner. */
  deployment?: DigestDeployment;
  /** Force/suppress the upsell banner. */
  upsell?: DigestUpsell | false;
};

export function renderDigestEmail(metrics: DigestMetrics, opts: RenderOpts): string {
  const m = metrics as Record<string, unknown>;
  const dept = opts.dept === "service" ? "service" : "sales";
  const reportDate = (m.reportDate as string) || opts.reportDate;
  const dateLabel = fmtDate(reportDate);
  const L = buildConsoleLinks({ enterpriseId: opts.enterpriseId, teamId: opts.teamId, dept, reportDate, timezone: opts.timezone });

  return renderDigestHtml(m, {
    rooftopName: opts.rooftopName,
    dept,
    dateLabel,
    agentPerson: (m.agentPerson as string) || undefined,
    links: { ...L, console: L.reports },
    // enrichment: prefer explicit opts, else fall back to anything carried on metrics
    appointments: opts.appointments ?? (Array.isArray(m.appointments) ? (m.appointments as DigestAppointment[]) : undefined),
    topVehicles: opts.topVehicles ?? (Array.isArray(m.topVehicles) ? (m.topVehicles as { name: string; count: number }[]) : undefined),
    dollarRate: opts.dollarRate ?? (typeof m.dollarRate === "number" ? (m.dollarRate as number) : undefined),
    pixelUrl: opts.pixelUrl,
    // In-app preview serves bundled assets from /public at the site root.
    assetBase: opts.assetBase ?? "",
    campaignImages: opts.campaignImages ?? ["/digest-assets/campaign-honda.jpg", "/digest-assets/campaign-tata.jpg"],
    // Upsell banner: prefer an explicit opt, else any deployment state carried on the metrics.
    deployment: opts.deployment ?? (m.deployment as DigestDeployment | undefined),
    upsell: opts.upsell,
  });
}
