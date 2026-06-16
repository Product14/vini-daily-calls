// Real "send now" for the ROI tracker: render the digest, POST to the Express
// endpoint (/api/email/roi-send-now) which forwards to the mail proxy AND marks
// the run sent in Supabase. After this resolves ok, reload the tracker — the cell
// flips to "sent" (from the DB) with the stored HTML + recipients viewable.
import { renderDigestEmail } from "./renderDigest";
import type { DeptKind, DigestMetrics } from "./mockData";

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

/** Add a recipient to roi_recipients for a rooftop+department (email_enabled + receives_<dept>=true). */
export async function addRecipientNow(opts: { teamId?: string; dept?: DeptKind; email: string; name?: string; emailEnabled?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const email = String(opts.email || "").trim();
  if (!/\S+@\S+\.\S+/.test(email)) return { ok: false, error: "Enter a valid email." };
  try {
    const res = await fetch("/api/recipients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: opts.teamId, department: opts.dept === "service" ? "service" : "sales", email, name: opts.name, emailEnabled: opts.emailEnabled }),
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
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !(j as { ok?: boolean }).ok) return { ok: false, error: (j as { error?: string }).error || `Request failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** Toggle a recipient's email_enabled (persist; does NOT send). */
export const toggleRecipientNow = (opts: { teamId?: string; email: string; enabled: boolean }) =>
  postJson("/api/recipients/toggle", { teamId: opts.teamId, email: opts.email, enabled: opts.enabled });

/** Update a rooftop's send hour / minute / timezone. */
export const updateRooftopConfigNow = (opts: { teamId?: string; sendHour?: number; sendMinute?: number; timezone?: string }) =>
  postJson("/api/rooftop-config", opts);

/** Assign a CSM (name + email both required) → enables both departments. */
export const addCsmNow = (opts: { teamId?: string; name: string; email: string }) => {
  if (!opts.name?.trim() || !/\S+@\S+\.\S+/.test(opts.email || "")) return Promise.resolve({ ok: false, error: "CSM name and a valid email are required." });
  return postJson("/api/csm", { teamId: opts.teamId, name: opts.name.trim(), email: opts.email.trim() });
};

/** Report a missing rooftop → emails product@spyne.ai + subhav.malhotra@spyne.ai. */
export const reportMissingRooftopNow = (opts: { teamId?: string; teamName?: string; departments?: string[]; csm?: string; csmEmail?: string; note?: string }) =>
  postJson("/api/missing-rooftop", opts);

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
    const res = await fetch("/api/email/roi-send-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: opts.teamId, department: dept, localDate: opts.localDate, to: recipients, subject, html }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) {
      return { ok: false, error: (body as { error?: string }).error || `Send failed (HTTP ${res.status})` };
    }
    if ((body as { dbUpdated?: boolean }).dbUpdated === false) {
      return { ok: true, error: "Email sent, but the run wasn't marked in Supabase (set ROI_SUPABASE_SERVICE_KEY on the server)." };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
