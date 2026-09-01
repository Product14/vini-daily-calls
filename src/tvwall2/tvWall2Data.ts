// Data layer for TV wall 2 (/tv-wall-2).
//
// Reads the snapshot that scripts/buildTvWall2Snapshot.mjs writes into public/.
// There is no API call and no ClickHouse dependency on purpose: every number here
// is already defined and cross-checked in the vini-success dashboard, so this view
// groups and counts rather than re-deriving. See the generator's header for why.
//
// The snapshot is refetched on an interval so an always-on screen picks up a new
// deploy without anyone touching the TV.

export type Band = "red" | "amber" | "green";

export type AgentRow = {
  teamId: string;
  rooftop: string;
  csm: string;
  arr: number;
  mrr: number;
  liveDate: string | null;
  daysLive: number | null;
  /** 30 / daysLive for an agent live under 30 days, else 1. Always 1 on service. */
  factor: number;
  apptsRaw: number;
  /** apptsRaw x factor. */
  appts: number;
  ratio: number | null;
  /** The band the ratio alone earned, before dormancy and missing MRR are folded in. */
  ratioBand: Band | "none";
  reach7: number;
  dormant: boolean;
  /** What the wall shows: ratioBand, forced to red when dormant or unrateable. */
  band: Band;
};

export type Summary = {
  agents: number;
  arr: number;
  red: number;
  amber: number;
  green: number;
  dormant: number;
  unrateable: number;
  pct: { red: number; amber: number; green: number };
};

export type CsmRow = Summary & { csm: string };

export type Product = {
  key: "salesIb" | "salesOb" | "serviceIb" | "serviceOb";
  label: string;
  side: "sales" | "service";
  apptValue: number;
  /** "Leads reached", or "Conversations held" on Service Inbound where nothing is reached. */
  reachLabel: string;
  asOf: string;
  /** False on service: those datasets carry no go-live date, so nothing can be scaled. */
  proRata: boolean;
  total: Summary;
  csms: CsmRow[];
  /* No per-agent array on purpose: it would put 204 real dealer names on an ungated
     route to render nothing. The generator writes those to a gitignored local file. */
};

export type Snapshot = {
  generatedAt: string;
  source: string;
  rules: {
    rag: { green: number; amber: number };
    dormantBelow: number;
    matureDays: number;
    apptValue: Record<string, number>;
    redAbsorbs: string[];
  };
  products: Record<Product["key"], Product>;
};

export const SIDES: { side: "sales" | "service"; label: string; keys: Product["key"][] }[] = [
  { side: "sales", label: "Sales", keys: ["salesIb", "salesOb"] },
  { side: "service", label: "Service", keys: ["serviceIb", "serviceOb"] },
];

export const BAND_COLOR: Record<Band, { solid: string; wash: string; ink: string }> = {
  // Wash + coloured ink for table cells, solid only for the one stacked bar per product:
  // two solid blocks of the same hue side by side read as heavy and repetitive.
  red: { solid: "#DC2626", wash: "#FEE4E2", ink: "#B42318" },
  amber: { solid: "#D97706", wash: "#FEF0C7", ink: "#B54708" },
  green: { solid: "#16A34A", wash: "#D1FADF", ink: "#027A48" },
};

export function useSnapshot(refreshMs = 5 * 60 * 1000) {
  const [snap, setSnap] = useStateSafe<Snapshot | null>(null);
  const [error, setError] = useStateSafe<string | null>(null);

  useEffectSafe(() => {
    let alive = true;
    const load = () =>
      fetch("/tvwall2-snapshot.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
          if (alive) {
            setSnap(j);
            setError(null);
          }
        })
        .catch((e) => {
          // Keep whatever is already on screen. A wall that blanks itself on a
          // transient fetch failure is worse than a wall showing the last good read.
          if (alive) setError(String(e && e.message ? e.message : e));
        });
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, refreshMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshMs]);

  return { snap, error };
}

// Imported here rather than at the top so this module stays a plain data module
// for anything that only wants the types.
import { useState as useStateSafe, useEffect as useEffectSafe } from "react";

export const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
export const moneyShort = (n: number) =>
  n >= 1000 ? "$" + Math.round(n / 1000).toLocaleString("en-US") + "k" : "$" + Math.round(n);
export const pct = (n: number) => Math.round(n * 100) + "%";
