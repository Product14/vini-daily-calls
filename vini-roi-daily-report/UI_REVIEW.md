# UI review — tracker + digest email

Reviewed live against Supabase (`roi_digest_runs`) on the running dev server, plus
the rendered email at `/digest-preview.html`. Mail service is linked via the
dry-run path; **no emails were sent**.

## What works ✅
- Tracker reads **live** Supabase data (header confirms "Supabase · roi_digest_runs").
- Grid renders correctly: Covina Kia → Sent / Sent / Suppr. / Sent / Sent (Jun 2–6),
  columns correctly anchored to the latest data date.
- Action board surfaces the unconfigured team with a **+ Classify** chip.
- Summary cards, live-agent matrix, and funnel render cleanly.
- Email HTML renders crisply: clear KPI cards, MTD sublines, action-required list,
  good visual hierarchy, email-client-safe inline styles.

## Findings (prioritized)

### P1 — fix before demo
1. **Department blocks are masked at the rooftop level.**
   Covina Jun 6 shows "Sent" even though the **sales** digest was `not_sent`
   (recipients_missing) — because **service** sent and the cell aggregates
   "any dept sent → Sent". A CSM can't see the sales gap from the grid.
   → *Fix:* split the cell into a sales/service mini-pair, or surface a per-dept
   badge; at minimum show a warning dot when ANY dept on that day failed.

2. **Rooftop name falls back to raw `team_id`** when no `roi_rooftop_config` row
   exists (the second team shows `b4df3297f5`).
   → *Fix:* always upsert a config row at onboarding, or show
   "Unnamed rooftop (team b4df…)" instead of the bare id.

### P2 — fix before launch
3. **CSM shows "Unassigned" for everyone** — CSM isn't stored in Supabase yet.
   The CSM filter + action board lose value without it.
   → *Fix:* add `csm` to `roi_rooftop_config` and map it in `dataSource.ts`.

4. **"across 1 rooftops" vs "2 rooftops" looks contradictory** — only Covina has
   live agents. Technically correct but reads as a bug.
   → *Fix:* reword to "1 of 2 rooftops have live agents".

### P3 — polish
5. Agent matrix only shows **IB** (DB has no inbound/outbound split). Either hide
   the OB column until tracked, or label it "not tracked yet".
6. Email: the **"View appointments" CTA is below the fold** — consider moving the
   primary CTA higher, and add a prior-period comparison (▲/▼ vs last week) for
   at-a-glance value.
7. Email lacks a visible logo/wordmark beyond the text label — add the Spyne mark.

## Mail-service link status
- Pipeline is fully wired to the mail service, but gated by `dryRun:true` →
  it renders + logs the would-be email and **does not send**.
- To review the exact email a dealer would get: open `/digest-preview.html`, or
  read `roi_digest_runs.rendered_html` for any dry-run row in the tracker drawer.
- When ready to actually send: set `dryRun:false` and confirm the raw-HTML
  endpoint (`mailRawApi`) — see CONFIG_TO_DO.md.

## Suggested next UI pass
Run `gsd:ui-review` (now installed) for a structured component-level audit, or I can
implement P1+P2 (split dept cells, name fallback, CSM field) in one change.
