import { useState, type ReactNode, type FormEvent } from "react";

// ── Email-tracker access gate ──────────────────────────────────────────────────
// The tracker shows customer PII (names, phones, conversation summaries), so it sits behind a
// simple ID + password prompt. NOTE: this is a client-side gate — obfuscation, not real security.
// The credentials ship in the bundle and the backend PII endpoints are not themselves protected by
// it. For true protection the /api/email/* routes need server-side auth. Credentials are overridable
// via VITE_TRACKER_USER / VITE_TRACKER_PASS at build time; defaults below.
const TRACKER_USER = (import.meta.env.VITE_TRACKER_USER as string) || "spyne-devansh";
const TRACKER_PASS = (import.meta.env.VITE_TRACKER_PASS as string) || "SPYNE";
const AUTH_KEY = "vini-tracker-auth";
// Token derived from the credentials so a stored token is invalidated if the credentials change.
const token = () => btoa(`${TRACKER_USER}:${TRACKER_PASS}`);

export function isTrackerAuthed(): boolean {
  try { return localStorage.getItem(AUTH_KEY) === token(); } catch { return false; }
}

export function TrackerAuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(isTrackerAuthed);
  const [id, setId] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");

  if (authed) return <>{children}</>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (id.trim() === TRACKER_USER && pass === TRACKER_PASS) {
      try { localStorage.setItem(AUTH_KEY, token()); } catch { /* private mode → session-only */ }
      setErr("");
      setAuthed(true);
    } else {
      setErr("Incorrect ID or password.");
      setPass("");
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-surface-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-raised p-7 shadow-sm"
      >
        <div className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-brand-primary">Vini · Email Tracker</div>
        <h1 className="mb-1 text-lg font-bold text-text-primary">Restricted</h1>
        <p className="mb-5 text-[12px] leading-relaxed text-text-muted">
          This view contains customer contact details and conversation summaries. Sign in to continue.
        </p>
        <label className="mb-1 block text-[11px] font-semibold text-text-secondary">ID</label>
        <input
          autoFocus
          value={id}
          onChange={(e) => setId(e.target.value)}
          autoComplete="username"
          className="mb-3 w-full rounded-lg border border-border-subtle bg-surface-background px-3 py-2 text-[13px] text-text-primary focus:border-brand-primary focus:outline-none"
        />
        <label className="mb-1 block text-[11px] font-semibold text-text-secondary">Password</label>
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="current-password"
          className="mb-1 w-full rounded-lg border border-border-subtle bg-surface-background px-3 py-2 text-[13px] text-text-primary focus:border-brand-primary focus:outline-none"
        />
        {err ? <div className="mb-2 mt-1 text-[12px] font-medium text-red-600">{err}</div> : null}
        <button
          type="submit"
          className="mt-3 w-full rounded-lg bg-brand-primary px-3 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
