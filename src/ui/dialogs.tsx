import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/**
 * In-page replacements for window.confirm / window.prompt / window.alert.
 *
 * The tracker is embedded in other consoles through an iframe, and a sandboxed iframe without
 * `allow-modals` silently blocks the browser's own dialogs: confirm() returns false, prompt()
 * returns null, and nothing is shown. Every action gated on one (verify a recipient, release a
 * hold, send, the kill switch, the audit-log name) then did nothing, with no error.
 *
 * Each call mounts its own React root on <body> and resolves when the person answers, so plain
 * modules (dataSource.ts, sendDigest.ts) can use them as well as components. The resolved values
 * match the native calls: confirm → boolean, prompt → string | null (null = cancelled).
 */

type Tone = "default" | "danger";

type BaseOpts = {
  title: string;
  /** Body copy. Newlines in a string render as line breaks. */
  message?: ReactNode;
};
export type ConfirmOpts = BaseOpts & { confirmLabel?: string; cancelLabel?: string; tone?: Tone };
export type PromptOpts = BaseOpts & {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Mask the input (send passwords). */
  secret?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
};
export type AlertOpts = BaseOpts & { okLabel?: string };

// Above the cell drawer (z-[9999]) and every other overlay in the app, so a dialog opened from
// inside the drawer is never hidden behind it.
const LAYER = "z-[10000]";

function mount<T>(fallback: T, render: (done: (value: T) => void) => ReactNode): Promise<T> {
  if (typeof document === "undefined") return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const opener = document.activeElement as HTMLElement | null;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
      // Unmount after the click/keypress that answered has finished, not inside it.
      setTimeout(() => {
        root.unmount();
        host.remove();
        if (opener && document.contains(opener)) opener.focus();
      }, 0);
    };
    root.render(render(done));
  });
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function DialogShell({
  title, message, onCancel, children,
}: BaseOpts & { onCancel: () => void; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  // Capture phase on window, so the dialog sees keys before anything behind it. The cell drawer
  // listens on window for Escape (close) and the arrow keys (move between cells); without this a
  // key meant for the dialog would also close or re-target the drawer underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel.current();
        return;
      }
      if (e.key.startsWith("Arrow")) { e.stopPropagation(); return; }
      if (e.key === "Tab" && panel.current) {
        // Keep focus inside the dialog.
        const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !panel.current.contains(active))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !panel.current.contains(active))) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      className={`fixed inset-0 ${LAYER} flex items-center justify-center overflow-y-auto bg-black/40 p-4`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div ref={panel} className="my-auto w-full max-w-md rounded-xl border border-border-subtle bg-surface-card p-6 shadow-xl">
        <h2 id={titleId} className="text-sm font-semibold text-text-primary">{title}</h2>
        {message ? <div className="mt-2 whitespace-pre-line text-sm text-text-secondary">{message}</div> : null}
        {children}
      </div>
    </div>
  );
}

const BTN = "rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60";
const BTN_SECONDARY = `${BTN} border border-border-strong bg-surface-card text-text-secondary hover:bg-surface-subtle`;
const btnPrimary = (tone: Tone = "default") =>
  tone === "danger"
    ? `${BTN} bg-negative text-white hover:opacity-90`
    : `${BTN} bg-brand-primary text-brand-foreground hover:bg-brand-primary-hover`;

function ConfirmDialog({ opts, done }: { opts: ConfirmOpts; done: (ok: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // A destructive confirm starts on Cancel, so a reflex Enter never fires it.
  useEffect(() => { (opts.tone === "danger" ? cancelRef : confirmRef).current?.focus(); }, [opts.tone]);
  return (
    <DialogShell title={opts.title} message={opts.message} onCancel={() => done(false)}>
      <div className="mt-6 flex justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={() => done(false)} className={BTN_SECONDARY}>{opts.cancelLabel ?? "Cancel"}</button>
        <button ref={confirmRef} type="button" onClick={() => done(true)} className={btnPrimary(opts.tone)}>{opts.confirmLabel ?? "Confirm"}</button>
      </div>
    </DialogShell>
  );
}

function PromptDialog({ opts, done }: { opts: PromptOpts; done: (value: string | null) => void }) {
  const [value, setValue] = useState(opts.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const submit = (e: FormEvent) => { e.preventDefault(); done(value); };
  return (
    <DialogShell title={opts.title} message={opts.message} onCancel={() => done(null)}>
      <form onSubmit={submit} className="mt-4">
        {opts.label ? <label htmlFor={inputId} className="mb-1 block text-xs font-semibold text-text-secondary">{opts.label}</label> : null}
        <input
          ref={inputRef}
          id={inputId}
          type={opts.secret ? "password" : "text"}
          autoComplete={opts.secret ? "off" : undefined}
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-border-strong bg-surface-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-brand-primary focus:outline-none"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => done(null)} className={BTN_SECONDARY}>{opts.cancelLabel ?? "Cancel"}</button>
          <button type="submit" className={btnPrimary(opts.tone)}>{opts.confirmLabel ?? "OK"}</button>
        </div>
      </form>
    </DialogShell>
  );
}

function AlertDialog({ opts, done }: { opts: AlertOpts; done: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { okRef.current?.focus(); }, []);
  return (
    <DialogShell title={opts.title} message={opts.message} onCancel={done}>
      <div className="mt-6 flex justify-end">
        <button ref={okRef} type="button" onClick={done} className={btnPrimary()}>{opts.okLabel ?? "OK"}</button>
      </div>
    </DialogShell>
  );
}

/** In-page window.confirm. Resolves true on confirm; false on cancel, Escape or a click outside. */
export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return mount<boolean>(false, (done) => <ConfirmDialog opts={opts} done={done} />);
}

/** In-page window.prompt. Resolves the typed value, or null when cancelled. */
export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return mount<string | null>(null, (done) => <PromptDialog opts={opts} done={done} />);
}

/** In-page window.alert. Resolves once dismissed. */
export function alertDialog(opts: AlertOpts): Promise<void> {
  return mount<void>(undefined, (done) => <AlertDialog opts={opts} done={() => done(undefined)} />);
}
