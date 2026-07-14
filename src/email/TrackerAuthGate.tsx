import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { TRACKER_TOKEN_KEY as TOKEN_KEY } from "./dataSource";

// ── Email-tracker access gate ──────────────────────────────────────────────────
// The tracker shows customer PII, so it sits behind a sign-in. The password is validated on the
// SERVER (POST /api/tracker/login) and is NOT shipped in this bundle; on success the server returns
// a short HMAC-signed token we store and re-check via /api/tracker/verify. The same token now also
// gates every config-mutation route (recipients*, rooftop-config, csm, …) — see trackerAuthHeaders()
// in dataSource.ts. NOTE: /api/email/* send routes and Supabase RLS are a separate, still-deferred
// hardening pass (the anon key can still read roi_* directly).


export function TrackerAuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = still checking a stored token
  const [id, setId] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // On mount, re-validate any stored token against the server (so a forged localStorage value fails).
  useEffect(() => {
    let live = true;
    const token = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
    if (!token) { setAuthed(false); return; }
    fetch("/api/tracker/verify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
    })
      .then((r) => r.json())
      .then((j) => { if (live) setAuthed(!!j.ok); })
      .catch(() => { if (live) setAuthed(false); });
    return () => { live = false; };
  }, []);

  if (authed === null) return <div className="flex h-screen w-full items-center justify-center bg-surface-background text-[13px] text-text-muted">Loading…</div>;
  if (authed) return <>{children}</>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/tracker/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id.trim(), password: pass }),
      });
      const j = await r.json();
      if (r.ok && j.ok && j.token) {
        try { localStorage.setItem(TOKEN_KEY, j.token); } catch { /* private mode → session only */ }
        setAuthed(true);
      } else {
        setErr(j.error || "Incorrect ID or password.");
        setPass("");
      }
    } catch {
      setErr("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
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
          disabled={busy}
          className="mt-3 w-full rounded-lg bg-brand-primary px-3 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="mt-5 border-t border-border-subtle pt-4 text-[12px] leading-relaxed text-text-muted">
          Need access or having trouble? Reach out to <span className="font-semibold text-text-secondary">Devansh Hasija</span> on Slack or email{" "}
          <a href="mailto:devansh.hasija@spyne.ai" className="font-medium text-brand-primary hover:underline">devansh.hasija@spyne.ai</a>.
        </div>
      </form>
    </div>
  );
}
