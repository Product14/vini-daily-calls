/**
 * Manual cron trigger from the tracker UI — ALWAYS dry-run.
 *
 * The tracker can fire the 4-cron pipeline (cron1 → cron2 → cron3 → cron4) for a
 * single rooftop or for all live rooftops, but it hard-codes `dry=true`, so cron4
 * SUPPRESSES every row instead of sending. No real email can leave through this
 * path — regardless of each rooftop's dry_run flag. This is the "let me manually
 * trigger a cron for dry-run-ready rooftops" entry point.
 *
 * To actually send, you flip dry_run=false AND let the scheduled hourly cron run
 * (or call the functions without dry=true from a trusted context) — never from here.
 *
 * Requires the Edge Functions to be deployed and these envs set:
 *   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
 * When unset (mock mode), the trigger is simulated.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const SUPA_URL = env.VITE_ROI_SUPABASE_URL;
const ANON = env.VITE_ROI_SUPABASE_KEY;
const SEND_SERVER_URL = env.VITE_SEND_SERVER_URL || "http://localhost:8787";

/**
 * Send a REAL email NOW via the local send server (email-render/server.cjs), which
 * renders the actual component + POSTs to mail.spyne.ai. The mail token lives on the
 * server, not the browser. This is what the "Send now" button calls on click.
 */
export type SendPayload = {
  teamId?: string;
  enterpriseId?: string;
  dept?: "sales" | "service";
  rooftopName?: string;
  timezone?: string;
  reportDate?: string;
  subject?: string;
  metrics: Record<string, unknown> | null | undefined;
  recipients: Array<string | { email: string }>;
};
export async function sendViaServer(payload: SendPayload): Promise<{ ok: boolean; status?: number; error?: string; to?: string[] }> {
  try {
    const res = await fetch(`${SEND_SERVER_URL}/send-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as { ok?: boolean }).ok) {
      return { ok: false, status: res.status, error: (body as { error?: string }).error || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, to: (body as { to?: string[] }).to };
  } catch (e) {
    const msg = String(e);
    return { ok: false, error: /failed to fetch/i.test(msg) ? "Send server not running — start it: MAIL_TOKEN=… node email-render/server.cjs" : msg };
  }
}

export const isPipelineConfigured = Boolean(SUPA_URL && ANON);

export type PipelineResult = {
  ok: boolean;
  simulated?: boolean;
  status?: number;
  body?: unknown;
  error?: string;
  /** mail token/cookie was missing or rejected (401/403) → prompt for a token on the FE */
  authFailed?: boolean;
  /** convenience: per-cron4 counts pulled out of the nested body */
  counts?: { queued?: number; sent?: number; suppressed?: number; preview?: number; errors?: number; skipped?: number };
};

/* ── Mail token (cookie) supplied from the FE, kept only for this browser session ──
 * Stored in sessionStorage (cleared when the tab closes), sent to the Edge Function
 * in the `x-mail-token` HEADER — never the URL. Used when the server-side MAIL_COOKIE
 * is missing or expired. */
const TOKEN_KEY = "roi_mail_token";
export function getMailToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
export function setMailToken(token: string): void {
  try { token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export function hasMailToken(): boolean {
  return getMailToken().trim().length > 0;
}

type RunOpts = {
  teamId?: string; // scope to one rooftop; omit = all live rooftops
  skipSync?: boolean; // default true — don't re-pull ClickHouse on a UI click
  bypass?: boolean; // default true — ignore the dealer-local send-hour gate for manual runs
  /**
   * "dry"     → force suppress on every row (no email).
   * "respect" → honour each rooftop's dry_run flag: SEND to live (dry_run=false),
   *             suppress the rest. This is the global manual CTA.
   * "live"    → force send for the targeted rooftop, overriding its dry_run flag.
   * "preview" → real send, but recipients filtered to ONLY @spyne.ai addresses
   *             (every customer address dropped). The header "preview" button.
   */
  mode?: "dry" | "respect" | "live" | "preview";
  /** mail cookie/token for a real send; falls back to the stored session token. */
  token?: string;
};

function extractCounts(body: unknown): PipelineResult["counts"] {
  const b = body as { cron3?: { body?: { queued?: number } }; cron4?: { body?: Record<string, number> } } | undefined;
  return {
    queued: b?.cron3?.body?.queued,
    sent: b?.cron4?.body?.sent,
    suppressed: b?.cron4?.body?.suppressed,
    preview: b?.cron4?.body?.preview,
    errors: b?.cron4?.body?.errors,
    skipped: b?.cron4?.body?.skipped,
  };
}
function detectAuthFailed(body: unknown): boolean {
  const b = body as { cron4?: { body?: { auth_failed?: boolean } } } | undefined;
  return b?.cron4?.body?.auth_failed === true;
}

/**
 * Fire cron1-sync-live. cron1 chains cron2→3→4 internally.
 * - mode "dry"     (default): cron4 suppresses every row — nothing is emailed.
 * - mode "respect": cron4 honours each rooftop's dry_run flag — SENDS to live ones
 *   (dry_run=false), suppresses the rest. Real emails go out to live rooftops.
 * - mode "live":    cron4 force-sends the targeted rooftop, overriding its flag.
 * "respect" and "live" really POST to mail.spyne.ai, so they need a mail token
 * (server MAIL_COOKIE or FE-supplied via `token` / the stored session token).
 */
export async function runPipeline(opts: RunOpts = {}): Promise<PipelineResult> {
  if (!isPipelineConfigured) return { ok: true, simulated: true };

  const mode = opts.mode ?? "dry";
  const mayEmail = mode === "live" || mode === "respect" || mode === "preview";
  const p = new URLSearchParams();
  if (mode === "live") p.set("force", "true"); // override flag for this one rooftop
  else if (mode === "dry") p.set("dry", "true"); // ← hard safety: cron4 suppresses all
  else if (mode === "preview") {
    // Real send, but cron4 keeps ONLY @spyne.ai recipients. We ALSO set dry=true as
    // a deploy-safety fallback: a NEW cron4 gives spyneOnly precedence (filtered
    // preview), while an OLD cron4 that doesn't understand spyneOnly sees dry=true
    // and suppresses everything — so an un-upgraded function can never email a
    // customer through this button.
    p.set("spyneOnly", "true");
    p.set("dry", "true");
  }
  // mode "respect": set NEITHER → cron4 sends iff dry_run=false
  if (opts.teamId) p.set("team", opts.teamId);
  if (opts.skipSync ?? true) p.set("skipSync", "true");
  if (opts.bypass ?? true) p.set("bypass", "true");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ANON}`,
    apikey: ANON as string,
  };
  if (mayEmail) {
    const tok = (opts.token ?? getMailToken()).trim();
    if (tok) headers["x-mail-token"] = tok; // secret travels in a header, not the URL
  }

  try {
    const res = await fetch(`${SUPA_URL}/functions/v1/cron1-sync-live?${p.toString()}`, { method: "POST", headers });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      body,
      authFailed: mayEmail && detectAuthFailed(body),
      counts: extractCounts(body),
    };
  } catch (e) {
    const msg = String(e);
    // cross-origin fetch to a missing/non-CORS endpoint throws "Failed to fetch"
    const friendly = /failed to fetch|networkerror/i.test(msg)
      ? "Couldn’t reach the functions endpoint — deploy the Edge Functions (with CORS) first."
      : msg;
    return { ok: false, error: friendly };
  }
}

/** Forced dry-run (no email). Kept for existing callers. */
export function runDryPipeline(opts: Omit<RunOpts, "mode" | "token"> = {}): Promise<PipelineResult> {
  return runPipeline({ ...opts, mode: "dry" });
}

/**
 * Preview send: real email via mail.spyne.ai, but cron4 filters every rooftop's
 * recipient list down to ONLY @spyne.ai addresses — customers are never emailed.
 * Needs a mail token (server MAIL_COOKIE or FE-supplied), like a live send.
 */
export function runPreviewPipeline(opts: Omit<RunOpts, "mode"> = {}): Promise<PipelineResult> {
  return runPipeline({ ...opts, mode: "preview" });
}

/** Honour flags: send to live rooftops (dry_run=false), suppress dry ones. Global CTA. */
export function runRespectPipeline(opts: Omit<RunOpts, "mode"> = {}): Promise<PipelineResult> {
  return runPipeline({ ...opts, mode: "respect" });
}

/** Real send via mail.spyne.ai for one rooftop, overriding its flag (per-rooftop "Send now"). */
export function runLivePipeline(opts: Omit<RunOpts, "mode"> = {}): Promise<PipelineResult> {
  return runPipeline({ ...opts, mode: "live" });
}
