# TV wall 2 — agent health by CSM

Route: **`/tv-wall-2`**. Sales on the left (Inbound, Outbound), service on the right
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

The tables size themselves by measurement: each block is fitted to its box, then all four
are levelled to the smallest that fits, so the wall reads as one design rather than four.
Measured type size, no scroll at any of them:

| Screen | Table type |
|---|---|
| 3840x2160 | 35px |
| 1920x1080 | 15px |
| 1366x768 | 8px, too small to read across a room |

1080p on a 55-inch panel is comfortable to about 3 metres. A laptop-sized viewport is not
a usable wall: there are 44 CSM rows on screen and no amount of fitting fixes that.

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

To refresh:

```bash
VINI_SUCCESS_DIR=~/Desktop/repos/vini-success/prototype \
  node scripts/buildTvWall2Snapshot.mjs
```

It prints agent counts, ARR and band counts per product, so a wrong build cannot pass
quietly. Commit the regenerated JSON and deploy. The view refetches every 5 minutes while
the tab is visible, so a deploy reaches the TV without anyone touching it.

## Row order

CSM rows are sorted by **agents assigned, descending, with ARR breaking ties**. The wall is
read as "who is carrying the most, and how much of it is Red", so the size of the book is
the ordering question and the money settles ties. This matches the CSM tab in vini-success,
which already sorts on rooftops assigned with ARR breaking ties.

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
