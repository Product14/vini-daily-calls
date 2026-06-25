// Type surface for the shared CommonJS digest template (digestTemplate.cjs).
export type DigestLinks = {
  appointments?: string;
  conversations?: string;
  actionItems?: string;
  console?: string;
};
export type DigestAppointment = {
  sched?: string;
  customer?: string;
  phone?: string;
  vehicle?: string;
  intent?: string;
  estValue?: number;
  /** Assigned rep/owner — shown as an avatar + name on the appointment card. */
  owner?: string;
};
/** Agent deployment state for a rooftop — drives the logic-driven upsell banner. */
export type DigestDeployment = {
  phone?: "after_hours" | "after_hours_overflow" | "24x7" | null;
  smartview?: boolean;
  stl?: boolean;
};
/** Explicit upsell override — pass `false` to suppress, or an object to force one. */
export type DigestUpsell = {
  eyebrow?: string;
  title: string;
  body?: string;
  cta?: string;
  href?: string;
};
export type DigestTemplateOpts = {
  rooftopName: string;
  dept?: "sales" | "service";
  dateLabel: string;
  agentPerson?: string;
  links?: DigestLinks;
  appointments?: DigestAppointment[];
  topVehicles?: { name: string; count: number }[];
  dollarRate?: number;
  pixelUrl?: string;
  /** Absolute (or root-relative) base URL prefix for bundled assets, e.g. the hero photo. */
  assetBase?: string;
  /** Decorative campaign-card header images (by index). */
  campaignImages?: string[];
  /** Agent deployment state → drives the upsell banner (also read from metrics.deployment). */
  deployment?: DigestDeployment;
  /** Force/suppress the upsell banner. `false` suppresses; an object overrides the logic. */
  upsell?: DigestUpsell | false;
  /** Leads/day threshold below which the upsell fires (default 15). */
  upsellLeadThreshold?: number;
  /** Cadence → period wording. Omitted/"daily" → "yesterday"; "weekly" → "this week"; "monthly" → "this month". */
  period?: "daily" | "weekly" | "monthly";
};
export function renderDigestHtml(
  metrics: Record<string, unknown>,
  opts: DigestTemplateOpts
): string;
export function buildCommentary(metrics: Record<string, unknown>, mode: "appts" | "warm" | "qual"): string;
export function pickUpsell(
  opts: DigestTemplateOpts,
  metrics: Record<string, unknown>,
  dept: "sales" | "service",
  leadsPerDay: number
): DigestUpsell | null;
