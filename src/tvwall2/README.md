# TV wall 2 — agent health by CSM

Route: **`/tv-wall-2`**, reachable from the **TV wall 2** entry in the View pill on `/`,
beside **TV wall**. It is a link rather than a view toggle, so right-click and open-in-new-tab
work: one wall per screen is the actual use case. Sales on the left (Inbound, Outbound), service on the right
(Inbound, Outbound). Each product shows a live summary, a proportional RAG bar, and a
per-CSM table. Nothing is clickable: it hangs on a wall.

This is a second wall, not a change to the one on `/`. That one is a 2x2 agent-type KPI
grid over the last 6 periods and is untouched.

## Showing it on a TV

Open `/tv-wall-2` and leave it. After 10 seconds of no input it goes immersive
(full-viewport, chrome hidden). There is also a fullscreen button in the header for real
browser fullscreen. Both are independent, so clicking one never cancels the other.

The basis for every number sits behind the **Info** button in the header rather than across
the bottom of the wall. It used to be a permanent four-line footer, which nobody reads from
across a room and which cost the tables height. Escape or a click anywhere outside closes
it, and clicking either header button does not drop the wall out of immersive.

The tables size themselves by measurement on BOTH axes: each block grows until either the
height runs out or a CSM name starts to ellipse, all four are then levelled to the smallest
that fits so the wall reads as one design, and whatever height is left over goes back into
row padding so no table stops short of its box.

Height alone was not enough. Past about 20px a CSM column is too narrow for "Deepanshu
Agarwal", and it was silently clipping on a wall whose whole job is naming who owns what.
The name column therefore gets 40% of the table and the numeric columns share the rest.

| Screen | Table type | Before the tightening |
|---|---|---|
| 3840x2160 | 52px | 34px |
| 2560x1440 | 33px | - |
| 1920x1080 | **23px** | 14px |
| 1600x900 | 18px | - |
| 1366x768 | 14px | 8px |

**What actually bought that: row height, not padding.** A row used to be 2.2x the font size,
0.6em of cell padding on top of a default 1.4 line-height. At 1.6x the same box holds the
same 13 rows a third larger. The block chrome came down too (padding, gaps, the bar, the
change note) but that is worth only a few pixels of type: the rows dominate. Everything is
expressed in em so it all scales with whatever size the fit routine lands on.

23px on a 55-inch 1080p panel is roughly 15mm of cap height, comfortable to about 4 metres.

## Where the numbers come from

`public/tvwall2-snapshot.json`, written by `scripts/buildTvWall2Snapshot.mjs`.

### The public file is deliberately thin

This app has **no route gate**. There is no `middleware.js`, and only `/email-tracker` sits
behind a sign-in, explicitly because it shows PII. So anything in `public/` is fetchable by
anyone with the URL, and a client-side gate would not change that: the JSON is a static
file, not an API response.

So the generator writes two files:

| File | Contains | Committed |
|---|---|---|
| `public/tvwall2-snapshot.json` | per-product and per-CSM aggregates only, ~9KB | yes |
| `scripts/tvwall2-agents.local.json` | 204 per-agent rows: dealer name, team_id, ARR, MRR, ratio, factor | **no, gitignored** |

The view renders only aggregates, so the per-agent rows would have shipped 204 real dealer
names and their contract values to an open route to display nothing. Use the local file to
audit a figure.

**What the public file still exposes**: CSM names, agent counts and ARR per CSM. That is
more than the existing `public/agent-overall-snapshot.json` carries (which has no CSM names
and no ARR by owner). If that is not acceptable on an open URL, the fix is to serve this
snapshot from the gated server surface (the `/api/tracker/*` pattern) rather than `public/`,
and point `useSnapshot` at that route. That is a server change, not a view change.

The generator reads the **vini-success** dashboard's own dataset files and does nothing but
group and count. That is deliberate. RAG bands, appointment values, dormancy and the CSM
roster are already defined and cross-checked there; re-deriving them from ClickHouse here
would create a second definition of "Red" to keep in step with the first, and they would
drift the first time either side changed.

### It refreshes itself daily

`.github/workflows/tvwall2-refresh.yml`, **08:00 UTC = 13:30 IST**, every day. That is 90
minutes after the vini-success repo rebuilds its datasets at 06:30 UTC, which leaves slack
because scheduled GitHub runs are best-effort and can fire tens of minutes late.

**It needs one secret: `VINI_SUCCESS_READ_TOKEN`**, a token with Contents:Read on
`Product14/vini-success`. The default `GITHUB_TOKEN` cannot reach another private repo, so
until that secret exists the workflow fails on its third step with an explicit message, and
the wall keeps its previous snapshot. Add it under Settings, Secrets and variables, Actions.

If it runs before the source has moved, nothing breaks: the snapshot comes out identical,
the commit step finds no diff and skips, and the wall keeps what it had. The job summary
prints the data dates it saw, so an early run is visible rather than silent. A failed
scheduled run opens an issue, because the bad outcome for a wall is not going blank, it is
quietly showing a confident number that stopped being refreshed.

`workflow_dispatch` runs it on demand, with a `dry_run` input that builds and reports
without committing.

Manual refresh, if you need it:

```bash
VINI_SUCCESS_DIR=~/Desktop/repos/vini-success/prototype \
  node scripts/buildTvWall2Snapshot.mjs
```

It prints agent counts, ARR, band counts and what changed per product, so a wrong build
cannot pass quietly. Commit the two regenerated JSONs and push. The view refetches every 5
minutes while the tab is visible, so a deploy reaches the TV without anyone touching it.

### What changed, under each table

Every table carries a line saying what moved since the last refresh and why. It exists
because Sales OB went 20% Green to 14% overnight and the only way to find out whether that
mattered was to diff two datasets by hand: two of the three rooftops that fell had not got
worse at all, their pro-rata multiplier shrank because they aged a day.

To diff, a run needs yesterday's per-agent state, so `scripts/tvwall2-state.json` is
committed. It is not in `public/`, so Vercel never serves it, and agents are keyed by a
hash of `team_id`: enough to match an agent across runs, not enough to identify a dealer.

**The note gives counts and causes, never rooftop names**, for the same reason the public
snapshot carries none. If you want the names on the wall, they have to either go on a
public URL or the wall has to be gated first. Until then the names are in the local audit
file.

The note is always rendered, including when nothing moved. Partly so "nothing changed" is
a stated fact rather than an absence, and partly because the fit routine levels all four
tables to the smallest: a note on one block only would silently shrink the other three.

## Row order

**Worst first: share of Red descending, ARR breaking ties.** The wall is read as "who needs
attention", so the problem leads and the money decides between equally bad books.

Ties are common, because a CSM with two agents both Red is 100% just like one with eight.
ARR rather than agent count is the tiebreaker on purpose: it puts the expensive 100% above
the cheap one. On Service Outbound that means Tushar Srivastava's $73k over four agents
leads Puneet Sharma's $10k over one, though both read 100%.

This deliberately no longer matches the CSM tab in vini-success, which sorts on rooftops
assigned. That tab is a working list; this is a wall.

## The rules on screen

- **RAG** = appointments in 30 days x appointment value, divided by MRR (ARR / 12).
  Green 3x and above, Amber 1x to 3x, Red below 1x.
- **Red also absorbs** dormant agents and agents with no MRR on record, so Red + Amber +
  Green always equals the agent count. A wall where the three numbers do not sum invites
  the wrong question.
- **Dormant** = under 10 in the last 7 days.
- **Pro rata**: a sales agent live under 30 days has only part of a 30-day window, so its
  appointments are scaled up to 30 days before banding.

## Four things to know before quoting this wall

1. **Appointment values: the service pair is settled, Sales Outbound is not.**
   Sales IB $200, Sales OB $300, Service IB $100, Service OB $200. All are Spyne planning
   assumptions, not audited industry figures. Change them in one place, `APPT_VALUE` in the
   generator.

   Service went to `data-overall.json`'s figures on 2026-09-01 (Mehul), down from the $225
   both service datasets publish. On Service Inbound that is a 56% cut and it moved the
   board from 22/8/24 red/amber/green to 28/8/19: six rooftops left Green. Service Outbound
   did not move at all, because 31 of its 37 agents are dormant and therefore Red whatever
   the appointment is worth.

   **This wall and the vini-success service tabs now disagree.** Those tabs read $225 from
   their own datasets. Aligning them means changing the service builders so the datasets
   publish $100/$200, which is a change in that repo, not here.

2. **No service agent is pro-rated, because service datasets carry no go-live date.** The
   sales datasets carry `live_date` on every row; `data-service-inbound.json` and
   `data-service-outbound.json` carry none, anywhere. So a service rooftop that went live
   last week is banded on a partial 30-day window and will read Red. Fixing this needs a
   change to the service queries, not to this view.

3. **Dormancy on Service Inbound is a proxy.** Nothing is "reached" on an inbound service
   line: the calls come to the agent. It reads `spoke`, conversations actually held, which
   is the closest honest analogue for "did anything happen here this week". The other three
   products read leads reached.

4. **Pro rata makes Greens out of very small numbers.** A sales agent live 3 days with 1
   appointment is scaled x10 and can land Green. The `factor` and `apptsRaw` fields are in
   the local audit file so this is checkable, but the wall shows only the banded result. If that becomes a problem, the fix is to stop banding anything under 7 days live
   rather than to change the scaling.

## Files

| Path | What |
|---|---|
| `scripts/buildTvWall2Snapshot.mjs` | Generator. Owns the rules and the appointment values. |
| `public/tvwall2-snapshot.json` | Committed output, aggregates only. |
| `scripts/tvwall2-agents.local.json` | Per-agent audit detail. Gitignored, never deployed. |
| `src/tvwall2/tvWall2Data.ts` | Types, colours, the fetch hook. |
| `src/tvwall2/TvWall2View.tsx` | The view. |
| `src/main.jsx` | Route. |
