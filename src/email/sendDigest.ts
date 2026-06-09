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
