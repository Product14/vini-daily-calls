// Real "send now" for the ROI tracker: render the digest, POST to the Express
// endpoint (/api/email/roi-send-now) which forwards to the mail proxy AND marks
// the run sent in Supabase. After this resolves ok, reload the tracker — the cell
// flips to "sent" (from the DB) with the stored HTML + recipients viewable.
import { renderDigestEmail } from "./renderDigest";
import { getActorName, trackerAuthHeaders } from "./dataSource";
import type { Cadence, DeptKind, DigestMetrics } from "./mockData";

export type SendDigestOpts = {
  teamId?: string;
  enterpriseId?: string;
  dept?: DeptKind;
  rooftopName: string;
  timezone?: string;
  localDate: string; // the cell's date (roi_digest_runs.local_date)
  metrics?: DigestMetrics | null;
  recipients: string[];
};

/** Add a recipient to roi_recipients for a rooftop+department (email_enabled + receives_<dept>=true).
 *  Also carries the SMS-channel fields (phone / smsEnabled) — this same endpoint updates an existing
 *  recipient by email, so it doubles as "set this person's phone / flip their SMS opt-in". */
export async function addRecipientNow(opts: { teamId?: string; dept?: DeptKind; email: string; name?: string; emailEnabled?: boolean; phone?: string; smsEnabled?: boolean; role?: "salesperson" | "bdc" | "gm" | null }): Promise<{ ok: boolean; error?: string }> {
  const email = String(opts.email || "").trim();
  const phone = String(opts.phone || "").trim();
  // A recipient needs at least one channel: a valid email OR a phone (phone-only → the
  // server stores a non-deliverable placeholder email as the identity key).
  if (email && !/\S+@\S+\.\S+/.test(email)) return { ok: false, error: "Enter a valid email." };
  if (!email && !phone) return { ok: false, error: "Add an email or a phone." };
  try {
    const res = await fetch("/api/recipients", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ teamId: opts.teamId, department: opts.dept === "service" ? "service" : "sales", email, name: opts.name, emailEnabled: opts.emailEnabled, phone: opts.phone, smsEnabled: opts.smsEnabled, role: opts.role }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) return { ok: false, error: (body as { error?: string }).error || `Add failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...trackerAuthHeaders() }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !(j as { ok?: boolean }).ok) return { ok: false, error: (j as { error?: string }).error || `Request failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Anti-churn override prompt: every customer-facing send goes through this. `doPost`
// performs the request with an optional override password in its body. If the server
// replies { blocked: true } (the email shows no value → churn risk), we prompt the
// operator for the password and retry once with it; the server only sends if it
// matches (DANGER). Returns the parsed body plus an `ok`/`blocked` summary.
type SendResult = { ok: boolean; error?: string; blocked?: boolean; body?: Record<string, unknown> };
async function sendWithOverridePrompt(doPost: (override?: string) => Promise<Response>): Promise<SendResult> {
  const run = async (override?: string): Promise<{ status: number; b: Record<string, unknown> }> => {
    const res = await doPost(override);
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, b };
  };
  let { status, b } = await run();
  if (b && b.blocked === true && b.ok !== true) {
    const pw = typeof window !== "undefined"
      ? window.prompt("⚠ This email shows NO value to the customer.\nSending it now is a churn risk.\n\nType the override password to send anyway:")
      : null;
    if (!pw || !pw.trim()) return { ok: false, blocked: true, error: "Send cancelled — the email shows no value.", body: b };
    ({ status, b } = await run(pw.trim()));
  }
  if (b && b.ok === true) return { ok: true, body: b };
  return { ok: false, blocked: b?.blocked === true, error: (b?.error as string) || `Request failed (HTTP ${status})`, body: b };
}

/** Toggle a recipient's email_enabled (default) or sms_enabled (channel:'sms'). Persist; does NOT send. */
export const toggleRecipientNow = (opts: { teamId?: string; email: string; enabled: boolean; channel?: "email" | "sms" }) =>
  postJson("/api/recipients/toggle", { teamId: opts.teamId, email: opts.email, enabled: opts.enabled, channel: opts.channel });

/** Verify (or un-verify) a recipient for its rooftop. Unverified recipients are HELD — never emailed —
 * so a wrong-rooftop address can't leak another rooftop's data. Confirm the person belongs here first. */
export const verifyRecipientNow = (opts: { teamId?: string; email: string; verified: boolean }) =>
  postJson("/api/recipients/verify", { teamId: opts.teamId, email: opts.email, verified: opts.verified });

/** Set (or clear) a recipient's phone number for the SMS channel. */
export const setRecipientPhoneNow = (opts: { teamId?: string; dept?: DeptKind; email: string; phone: string }) =>
  addRecipientNow({ teamId: opts.teamId, dept: opts.dept, email: opts.email, phone: opts.phone });

/** Edit an existing recipient's identity by row id — email (rename), phone, or name.
 * Only id-based updates can RENAME the email; the email-keyed upsert path would clone the row. */
export const updateRecipientNow = (opts: { teamId?: string; id: string; email?: string; phone?: string; name?: string }) =>
  postJson("/api/recipients/update", { teamId: opts.teamId, id: opts.id, email: opts.email, phone: opts.phone, name: opts.name });

/** Set (or clear) a recipient's role (salesperson|bdc|gm|null) for role-tiered transactional routing. */
export const setRecipientRoleNow = (opts: { teamId?: string; dept?: DeptKind; email: string; role: "salesperson" | "bdc" | "gm" | null }) =>
  addRecipientNow({ teamId: opts.teamId, dept: opts.dept, email: opts.email, role: opts.role });

/** Set ONE cell of a recipient's subscription matrix (type × channel). */
export const setRecipientSubscriptionNow = (opts: { teamId?: string; email: string; type: string; channel: "email" | "sms"; enabled: boolean }) =>
  postJson("/api/recipients/subscription", { teamId: opts.teamId, email: opts.email, type: opts.type, channel: opts.channel, enabled: opts.enabled });

/** Update a rooftop's send hour / minute / timezone / weekly-monthly send-day, or the SMS master switch (sms_enabled). */
export const updateRooftopConfigNow = (opts: { teamId?: string; sendHour?: number; sendMinute?: number; timezone?: string; sms_enabled?: boolean; weekly_send_dow?: number; monthly_send_day?: number }) =>
  postJson("/api/rooftop-config", { ...opts, actor: getActorName() });

/** Assign a CSM (name + email both required) → enables both departments. */
export const addCsmNow = (opts: { teamId?: string; name: string; email: string }) => {
  if (!opts.name?.trim() || !/\S+@\S+\.\S+/.test(opts.email || "")) return Promise.resolve({ ok: false, error: "CSM name and a valid email are required." });
  return postJson("/api/csm", { teamId: opts.teamId, name: opts.name.trim(), email: opts.email.trim(), actor: getActorName() });
};

/** Report a missing rooftop → emails product@spyne.ai + subhav.malhotra@spyne.ai. */
export const reportMissingRooftopNow = (opts: { teamId?: string; teamName?: string; departments?: string[]; csm?: string; csmEmail?: string; note?: string }) =>
  postJson("/api/missing-rooftop", opts);

export type GenerateSendSummary = {
  cadence: Cadence;
  scope: "rooftop" | "all";
  sent: number;
  suppressed: number;
  no_recipients: number;
  no_data: number;
  errors: number;
};

/**
 * On-demand "Generate & send {cadence}": the server fetches fresh metrics for the
 * rolling window (weekly = last 7 days, monthly = last 30), renders the digest, and
 * sends to the rooftop's real recipients — bypassing the cron's send-day/send-hour
 * gates. Scope to one rooftop with teamId+dept, or omit both to run all live rooftops.
 * Pass dryRun:true to render + store a suppressed preview without emailing.
 */
export type DigestPreview = {
  ok: boolean;
  cadence: Cadence;
  subject: string;
  dateLabel: string;
  hasData: boolean;
  reason?: string | null;
  html: string;
  metrics: DigestMetrics;
};

/**
 * Render-only preview for "Generate & send {cadence}": the server builds the SAME
 * metrics + HTML the send would produce (rolling window) and returns it WITHOUT
 * writing to the DB or emailing. The drawer shows it so the user previews the
 * weekly/monthly digest before manually triggering the actual send.
 */
/**
 * Render a STORED digest day in a chosen template (v1 = Classic, v2 = New) — render-only, no send.
 * Lets the drawer preview any past day under either template, regardless of what was actually sent.
 */
export async function renderStoredPreview(opts: { teamId: string; dept: DeptKind; localDate: string; cadence?: Cadence; tpl: "v1" | "v2" }): Promise<{ ok: boolean; html?: string; error?: string }> {
  try {
    const q = new URLSearchParams({
      teamId: opts.teamId,
      department: opts.dept === "service" ? "service" : "sales",
      localDate: opts.localDate,
      cadence: opts.cadence || "daily",
      tpl: opts.tpl,
    });
    const res = await fetch(`/api/email/roi-render-preview?${q.toString()}`, { headers: trackerAuthHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) {
      return { ok: false, error: (body as { error?: string }).error || `Preview failed (HTTP ${res.status})` };
    }
    return { ok: true, html: (body as { html?: string }).html };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function generatePreviewNow(opts: { cadence: Cadence; teamId?: string; dept?: DeptKind }): Promise<{ ok: boolean; error?: string; preview?: DigestPreview }> {
  try {
    const res = await fetch("/api/email/roi-generate-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
      body: JSON.stringify({ cadence: opts.cadence, teamId: opts.teamId, department: opts.dept === "service" ? "service" : "sales" }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) {
      return { ok: false, error: (body as { error?: string }).error || `Preview failed (HTTP ${res.status})` };
    }
    return { ok: true, preview: body as DigestPreview };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function generateAndSendNow(opts: { cadence: Cadence; teamId?: string; dept?: DeptKind; dryRun?: boolean }): Promise<{ ok: boolean; error?: string; summary?: GenerateSendSummary }> {
  try {
    const r = await sendWithOverridePrompt((override) =>
      fetch("/api/email/roi-generate-send", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
        body: JSON.stringify({
          cadence: opts.cadence,
          teamId: opts.teamId,
          department: opts.teamId ? (opts.dept === "service" ? "service" : "sales") : undefined,
          dryRun: opts.dryRun === true,
          override,
        }),
      }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, summary: r.body as unknown as GenerateSendSummary };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Render a transactional email live (from ClickHouse) and send it to the rooftop's
 * recipients — the per-cell "Send to customer" for a type with no stored event yet.
 */
export async function generateSendEventNow(opts: { teamId?: string; enterpriseId?: string; department?: DeptKind; emailType: string; eventKey?: string; rooftopName?: string; tz?: string }): Promise<{ ok: boolean; error?: string; to?: string[] }> {
  try {
    const r = await sendWithOverridePrompt((override) =>
      fetch("/api/email/roi-event-generate-send", {
        method: "POST", headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
        body: JSON.stringify({
          teamId: opts.teamId, enterpriseId: opts.enterpriseId,
          department: opts.department === "service" ? "service" : "sales",
          emailType: opts.emailType, eventKey: opts.eventKey, rooftopName: opts.rooftopName, tz: opts.tz,
          override,
        }),
      }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, to: (r.body as { to?: string[] })?.to };
  } catch (e) { return { ok: false, error: String(e) }; }
}

export async function sendDigestNow(opts: SendDigestOpts): Promise<{ ok: boolean; error?: string }> {
  const recipients = (opts.recipients ?? []).map((s) => String(s || "").trim()).filter((e) => /\S+@\S+\.\S+/.test(e));
  if (!recipients.length) return { ok: false, error: "No valid recipient email." };
  if (!opts.metrics) return { ok: false, error: "No metrics to render for this rooftop yet." };

  const dept = opts.dept === "service" ? "service" : "sales";
  const reportDate = (opts.metrics.reportDate as string) || opts.localDate;
  const html = renderDigestEmail(opts.metrics, {
    rooftopName: opts.rooftopName, dept, teamId: opts.teamId,
    enterpriseId: opts.enterpriseId, reportDate, timezone: opts.timezone,
  });
  const subject = `${dept === "service" ? "Service" : "Sales"} Daily Digest — ${opts.rooftopName}`;

  try {
    const r = await sendWithOverridePrompt((override) =>
      fetch("/api/email/roi-send-now", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
        body: JSON.stringify({ teamId: opts.teamId, department: dept, localDate: opts.localDate, to: recipients, subject, html, override }),
      }));
    if (!r.ok) return { ok: false, error: r.error };
    if ((r.body as { dbUpdated?: boolean })?.dbUpdated === false) {
      return { ok: true, error: "Email sent, but the run wasn't marked in Supabase (set ROI_SUPABASE_SERVICE_KEY on the server)." };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Resend a STORED transactional event email by row id (anti-churn gated). */
export async function sendStoredEventNow(opts: { id: string; to?: string[] }): Promise<{ ok: boolean; error?: string; to?: string[] }> {
  try {
    const r = await sendWithOverridePrompt((override) =>
      fetch("/api/email/roi-event-send-now", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...trackerAuthHeaders() },
        body: JSON.stringify({ id: opts.id, to: opts.to, override }),
      }));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, to: (r.body as { to?: string[] })?.to };
  } catch (e) { return { ok: false, error: String(e) }; }
}
