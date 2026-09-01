// One row per CSM per SIDE, with both products on that row.
//
// WHY THIS EXISTS. The wall used to stack two tables per side, four in all. Measured on a
// 1080p screen that left each table 395px for 13 rows, so the fit routine settled at 14px and
// nobody could read it across a room. The chrome was only 290px of 1080, so tightening padding
// could not fix it: even with ZERO chrome, 13 rows in a half-height block caps out near 19px.
// The row count was the constraint, not the spacing.
//
// Merging the two products of a side into one row per CSM halves the rows and gives each side
// the full column height. Same data, same numbers, roughly double the type. It also reads
// better: a CSM's inbound and outbound health sit on one line instead of in two tables you
// have to match up by name.

import type { Band, CsmRow, Product, Summary } from "./tvWall2Data";

export type SideRow = {
  csm: string;
  /** Total ARR across both products for this CSM on this side. */
  arr: number;
  /** Total agents across both products, which is what the rows are ordered by. */
  agents: number;
  /** Per-product cells, keyed by product key. Absent when the CSM has none of that product. */
  cells: Record<string, CsmRow | undefined>;
};

/**
 * Union of the CSMs across the two products of a side.
 *
 * A CSM with Service Inbound but no Service Outbound gets a row with the outbound half blank,
 * rather than being dropped or being shown as zeros: no agents and zero-of-zero-red are
 * different facts and the wall should not conflate them.
 */
export function sideRows(products: Product[]): SideRow[] {
  const by = new Map<string, SideRow>();
  for (const p of products) {
    for (const c of p.csms) {
      let r = by.get(c.csm);
      if (!r) { r = { csm: c.csm, arr: 0, agents: 0, cells: {} }; by.set(c.csm, r); }
      r.cells[p.key] = c;
      r.arr += c.arr;
      r.agents += c.agents;
    }
  }
  // Biggest book first by agents, ARR breaking ties: same order rule as the per-product tables.
  return [...by.values()].sort((x, y) => y.agents - x.agents || y.arr - x.arr);
}

/** Column totals for a side, per product, so the footer row ties to the block headers. */
export function sideTotals(products: Product[]): { arr: number; agents: number; per: Record<string, Summary> } {
  const per: Record<string, Summary> = {};
  let arr = 0, agents = 0;
  for (const p of products) { per[p.key] = p.total; arr += p.total.arr; agents += p.total.agents; }
  return { arr, agents, per };
}

/**
 * Conditional formatting: the fill deepens with the percentage, so a 100% Red block and a
 * 100% Green block are the things the eye lands on from across the room.
 *
 * Four steps rather than a continuous gradient, because every step is a contrast-checked
 * pair. Continuous alpha would drift text through the 4.5:1 floor somewhere in the middle
 * with nothing to catch it. Measured ratios, background against its text:
 *   zero    white       + #667085   4.97
 *   light   wash        + dark ink  6.6 to 7.2
 *   mid     mid fill    + dark ink  5.8 to 6.1
 *   strong  strong fill + white     4.8 to 6.6
 * The strong greens and ambers are NOT the brand #12B76A and #D97706: white on those is
 * 2.62 and 3.19, which fails. #027A48 and #B54708 carry the same meaning and pass.
 */
export const SCALE: Record<Band, { zero: string; light: string; mid: string; strong: string; ink: string }> = {
  red:   { zero: "#FFFFFF", light: "#FEE4E2", mid: "#FECDCA", strong: "#DC2626", ink: "#912018" },
  amber: { zero: "#FFFFFF", light: "#FEF0C7", mid: "#FEDF89", strong: "#B54708", ink: "#93370D" },
  green: { zero: "#FFFFFF", light: "#D1FADF", mid: "#A6F4C5", strong: "#027A48", ink: "#05603A" },
};

export function bandCell(band: Band, pct: number, hasAgents: boolean) {
  const s = SCALE[band];
  if (!hasAgents) return { background: "transparent", color: "#D0D5DD", fontWeight: 400 };
  if (pct <= 0) return { background: s.zero, color: "#667085", fontWeight: 400 };
  if (pct < 0.34) return { background: s.light, color: s.ink, fontWeight: 600 };
  if (pct < 0.67) return { background: s.mid, color: s.ink, fontWeight: 700 };
  return { background: s.strong, color: "#FFFFFF", fontWeight: 800 };
}
