import { Fragment, useEffect, useRef, useState } from "react";
import { Info, Maximize2, Minimize2, X } from "lucide-react";
import {
  BAND_COLOR, SIDES, money, moneyShort, pct,
  useSnapshot, type Band, type Change, type Product, type Snapshot,
} from "./tvWall2Data";
import { bandCell, sideRows, sideTotals, type SideRow } from "./tvWall2Rows";

/**
 * TV WALL 2 — the RAG board, sales on the left and service on the right.
 *
 * WHAT IT IS FOR. One screen that answers "where is the book unhealthy, and whose
 * is it" without anyone clicking. Sales Inbound and Sales Outbound on the left,
 * Service Inbound and Service Outbound on the right, each as a live summary plus a
 * per-CSM breakdown. Nothing is interactive by design: it hangs on a wall.
 *
 * HOW IT FILLS A SCREEN. Same measurement approach as the TV wall on /: measure the
 * real rendered height and step the font size until the block fills its box with no
 * scroll. A formula based on row count would be wrong on the first TV with a
 * different aspect ratio, and a wall that scrolls is a wall nobody reads.
 *
 * WHY EVERY NUMBER CARRIES ITS BASIS. The footer names the appointment value per
 * product, the band thresholds, the dormancy rule, and the two places the four
 * products genuinely differ. A percentage on a wall with no stated basis gets
 * argued with in the room and then ignored.
 */

const IMMERSIVE_IDLE_MS = 10_000;

export default function TvWall2View() {
  const { snap, error } = useSnapshot();
  const [idleImmersive, setIdleImmersive] = useState(false);
  const [isFs, setIsFs] = useState(false);
  /* The basis used to sit permanently across the bottom. It has to stay reachable, but on a
     wall it was four lines nobody reads from across the room eating height the tables want. */
  const [showInfo, setShowInfo] = useState(false);
  const immersive = idleImmersive || isFs;
  const rootRef = useRef<HTMLDivElement>(null);

  // Auto-immersive after idle, exactly like the TV wall on "/", except activity on
  // the fullscreen button itself is ignored so clicking it never kicks us out.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdleImmersive(true), IMMERSIVE_IDLE_MS);
    };
    const onActivity = (e: Event) => {
      const t = e.target as HTMLElement | null;
      // Clicking the chrome must not drop the wall out of immersive mid-read.
      if (t && t.closest && t.closest("[data-tv-keep]")) return;
      setIdleImmersive(false);
      schedule();
    };
    schedule();
    const evs: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"];
    evs.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => {
      clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, []);

  useEffect(() => {
    if (!showInfo) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowInfo(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showInfo]);

  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* Fit each table to its box on BOTH axes: shrink until it clears, then grow to fill.
     Height alone was not enough. Once the merged layout pushed the type to 32px, every CSM
     name wider than its column was silently ellipsed: "Deepanshu Agarwal" became "Deepanshu
     Ag…" on a wall whose entire purpose is naming who owns what. So a size only counts as
     fitting when no name is clipped either. */
  useEffect(() => {
    const clips = (tbl: HTMLElement) =>
      [...tbl.querySelectorAll<HTMLElement>(".tv2-csm")].some((c) => c.scrollWidth > c.clientWidth + 1);
    const fitOne = (wrap: HTMLElement, tbl: HTMLElement) => {
      const avail = wrap.clientHeight;
      if (!avail) return;
      const tooBig = () => tbl.offsetHeight > avail || clips(tbl);
      let fs = 15;
      let guard = 140;
      tbl.style.fontSize = fs + "px";
      while (tooBig() && fs > 7 && guard-- > 0) {
        fs -= 1;
        tbl.style.fontSize = fs + "px";
      }
      // Ceiling high enough that a 4K panel is limited by the content, not by this number.
      while (tbl.offsetHeight < avail - 2 && fs < 96 && guard-- > 0) {
        fs += 1;
        tbl.style.fontSize = fs + "px";
        if (tooBig()) {
          fs -= 1;
          tbl.style.fontSize = fs + "px";
          break;
        }
      }
      /* Now that the name column caps the type, height is no longer the binding constraint
         and the table stops short: at 1080p it left ~300px of white under the totals. Spend
         that on row padding rather than leaving a gap. Taller rows are easier to track
         across ten columns from a distance, so the leftover buys legibility twice. */
      tbl.style.setProperty("--rowpad", "0px");
      const rowCount = tbl.querySelectorAll("tr").length;
      const leftover = avail - tbl.offsetHeight;
      if (rowCount > 0 && leftover > 4) {
        const add = Math.min(leftover / rowCount / 2, fs * 0.7);
        tbl.style.setProperty("--rowpad", add.toFixed(2) + "px");
        // Padding can only ever add height, so one correction pass is enough.
        if (tbl.offsetHeight > avail) tbl.style.setProperty("--rowpad", "0px");
      }
    };
    /* Fit each block, then level them all to the smallest that fits. Four tables at
       14/15/15/16px on one wall reads as an accident rather than a design, and the
       row counts differ per product so an independent fit always diverges. */
    const fit = () => {
      const pairs: [HTMLElement, HTMLElement][] = [];
      document.querySelectorAll<HTMLElement>(".tv2-block").forEach((block) => {
        const wrap = block.querySelector<HTMLElement>(".tv2-wrap");
        const tbl = block.querySelector<HTMLElement>(".tv2-table");
        if (wrap && tbl) pairs.push([wrap, tbl]);
      });
      pairs.forEach(([wrap, tbl]) => fitOne(wrap, tbl));
      const smallest = Math.min(...pairs.map(([, tbl]) => parseFloat(tbl.style.fontSize) || 15));
      if (Number.isFinite(smallest)) pairs.forEach(([, tbl]) => { tbl.style.fontSize = smallest + "px"; });
    };
    const raf = requestAnimationFrame(fit);
    const settle = setTimeout(fit, 300);
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      window.removeEventListener("resize", fit);
    };
  }, [snap, immersive]);

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => { /* immersive CSS still covers the screen */ });
  };

  return (
    <div ref={rootRef} className={"tv2" + (immersive ? " tv2-immersive" : "")}>
      <style>{CSS}</style>

      <header className="tv2-top">
        <span className="tv2-brand">Vini</span>
        <h1>Agent health by CSM</h1>
        {snap && (
          <span className="tv2-asof">
            Sales through {snap.products.salesIb.asOf} · Service through {snap.products.serviceIb.asOf}
          </span>
        )}
        <button type="button" className="tv2-fs" data-tv-keep aria-expanded={showInfo}
                aria-controls="tv2-info" onClick={() => setShowInfo((v) => !v)}
                aria-label="How each number is built">
          <Info size={16} strokeWidth={1.75} />
        </button>
        <button type="button" className="tv2-fs" data-tv-keep onClick={toggleFullscreen}
                aria-label={isFs ? "Exit full screen" : "Go full screen"}>
          {isFs ? <Minimize2 size={16} strokeWidth={1.75} /> : <Maximize2 size={16} strokeWidth={1.75} />}
        </button>
      </header>

      {!snap && !error && <div className="tv2-msg">Loading the snapshot…</div>}
      {!snap && error && (
        <div className="tv2-msg tv2-err">
          Could not read /tvwall2-snapshot.json ({error}). Run
          <code> node scripts/buildTvWall2Snapshot.mjs </code> and deploy.
        </div>
      )}

      {snap && (
        <>
          <div className="tv2-grid">
            {SIDES.map(({ side, label, keys }) => (
              <SideBlock key={side} label={label} products={keys.map((k) => snap.products[k])} />
            ))}
          </div>
          {showInfo && (
            <>
              <div className="tv2-scrim" data-tv-keep onClick={() => setShowInfo(false)} />
              <InfoPanel snap={snap} onClose={() => setShowInfo(false)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Bar({ s }: { s: Product["total"] }) {
  // The one solid element per product. Readable across a room, and it carries the
  // same three numbers printed beside it, so nothing is encoded by colour alone.
  const seg = (b: Band) => ({ width: (s.pct[b] * 100).toFixed(2) + "%", background: BAND_COLOR[b].solid });
  return (
    <div className="tv2-bar" role="img"
         aria-label={`${pct(s.pct.red)} red, ${pct(s.pct.amber)} amber, ${pct(s.pct.green)} green`}>
      {(["red", "amber", "green"] as Band[]).map((b) =>
        s[b] > 0 ? <span key={b} style={seg(b)} title={`${b}: ${s[b]} of ${s.agents}`} /> : null
      )}
    </div>
  );
}

/**
 * One side of the wall: a header strip per product, then ONE table with a row per CSM and
 * both products on that row.
 *
 * The four-table layout this replaces settled at 14px on a 1080p screen. See tvWall2Rows.ts
 * for the measurement: the row count was the constraint, so halving the rows was the only
 * lever that actually moved the type.
 */
function SideBlock({ label, products }: { label: string; products: Product[] }) {
  const rows = sideRows(products);
  const tot = sideTotals(products);
  const BANDS: Band[] = ["red", "amber", "green"];

  return (
    <section className="tv2-side">
      <div className="tv2-sidehead">{label}</div>

      <div className="tv2-block">
        {products.map((p) => (
          <div key={p.key} className="tv2-strip">
            <span className="tv2-name">{p.label}</span>
            <span className="tv2-kpi"><b>{p.total.agents}</b> live</span>
            <span className="tv2-kpi"><b>{money(p.total.arr)}</b> ARR</span>
            {BANDS.map((b) => (
              <span key={b} className="tv2-kpi tv2-kpi-band" style={{ color: BAND_COLOR[b].ink }}>
                <b>{pct(p.total.pct[b])}</b> {b}
              </span>
            ))}
            <Bar s={p.total} />
          </div>
        ))}

        <div className="tv2-wrap">
          <table className="tv2-table">
            <colgroup>
              {/* The name column is what caps the type size, so it gets the room. */}
              <col style={{ width: "26%" }} />
              <col style={{ width: "10%" }} />
              {products.map((p) => (
                <Fragment key={p.key}>
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "8.33%" }} />
                  <col style={{ width: "8.33%" }} />
                  <col style={{ width: "8.33%" }} />
                </Fragment>
              ))}
            </colgroup>
            <thead>
              <tr className="tv2-group">
                <th /><th />
                {products.map((p) => (
                  <th key={p.key} colSpan={4} className="tv2-grouph">{p.label}</th>
                ))}
              </tr>
              <tr>
                <th>CSM</th>
                <th className="r">ARR</th>
                {products.map((p) => (
                  <Fragment key={p.key}>
                    <th className="r">Agents</th>
                    <th className="r">R</th>
                    <th className="r">A</th>
                    <th className="r">G</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <Row key={r.csm} r={r} products={products} />)}
              <tr className="tv2-total">
                <td>Total</td>
                <td className="r">{moneyShort(tot.arr)}</td>
                {products.map((p) => (
                  <Fragment key={p.key}>
                    <td className="r">{p.total.agents}</td>
                    {BANDS.map((b) => <td key={b} className="r">{pct(p.total.pct[b])}</td>)}
                  </Fragment>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {products.map((p) => (
          <ChangeNote key={p.key} label={p.label} c={p.changes} now={p.total.pct} />
        ))}
      </div>
    </section>
  );
}

function Row({ r, products }: { r: SideRow; products: Product[] }) {
  const BANDS: Band[] = ["red", "amber", "green"];
  return (
    <tr>
      <td className="tv2-csm">{r.csm}</td>
      <td className="r">{moneyShort(r.arr)}</td>
      {products.map((p) => {
        const c = r.cells[p.key];
        return (
          <Fragment key={p.key}>
            <td className={"r" + (c ? "" : " tv2-none")}>{c ? c.agents : "\u2013"}</td>
            {BANDS.map((b) => (
              <td key={b} className="r" style={bandCell(b, c ? c.pct[b] : 0, !!c)}>
                {c ? pct(c.pct[b]) : "\u2013"}
              </td>
            ))}
          </Fragment>
        );
      })}
    </tr>
  );
}

/**
 * What moved since the last refresh, and why.
 *
 * This exists because Sales OB went 20% Green to 14% overnight and the only way to know
 * whether that mattered was to diff two datasets by hand. Two of the three rooftops that
 * fell had not got worse at all: their pro-rata multiplier shrank because they aged a day.
 * A wall that moves without saying why gets read as broken.
 *
 * Always rendered, even when nothing changed. Partly so "nothing moved" is a stated fact
 * rather than an absence, and partly because the fit routine levels all four tables to the
 * smallest: a note on one block only would silently shrink the other three.
 *
 * Counts, never names. The public snapshot carries no rooftop names by design, so neither
 * does this. Open the local audit file to find out which rooftop it was.
 */
function ChangeNote({ label, c, now }: { label: string; c: Change | null; now: Product["total"]["pct"] }) {
  const tag = <span className="tv2-notetag">{label}</span>;
  if (!c) return <p className="tv2-note tv2-note-quiet">{tag}First run: nothing to compare against yet.</p>;

  const shifted = (["red", "amber", "green"] as Band[])
    .filter((b) => Math.round(c.sincePct[b] * 100) !== Math.round(now[b] * 100));

  const quiet = !shifted.length && !c.moved.length && !c.added && !c.removed;
  if (quiet)
    return <p className="tv2-note tv2-note-quiet">{tag}No band changed since {c.since}.</p>;

  return (
    <p className="tv2-note">
      {tag}<span className="tv2-notelab">Since {c.since}</span>
      {shifted.map((b) => (
        <span key={b} className="tv2-delta" style={{ color: BAND_COLOR[b].ink }}>
          {b} {pct(c.sincePct[b])} <span aria-hidden="true">&rarr;</span> {pct(now[b])}
        </span>
      ))}
      {c.moved.map((m, i) => (
        <span key={i} className="tv2-why">
          {m.n} {m.from} <span aria-hidden="true">&rarr;</span> {m.to}, {m.cause}
        </span>
      ))}
      {c.added ? <span className="tv2-why">{c.added} newly live</span> : null}
      {c.removed ? <span className="tv2-why">{c.removed} no longer live</span> : null}
    </p>
  );
}

function InfoPanel({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const r = snap.rules;
  const p = snap.products;
  const ref = useRef<HTMLDivElement>(null);
  // Focus the panel on open so Escape and a screen reader both land somewhere sensible.
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="tv2-info" id="tv2-info" role="dialog" aria-modal="false"
         aria-label="How each number is built" tabIndex={-1} ref={ref} data-tv-keep>
      <div className="tv2-infotop">
        <h2>How each number is built</h2>
        <button type="button" className="tv2-fs" data-tv-keep onClick={onClose} aria-label="Close">
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="tv2-foot">
      <span>
        <b>RAG</b> = appointments in 30 days x appointment value, divided by MRR (ARR / 12).
        Green {r.rag.green}x and above, Amber {r.rag.amber}x to {r.rag.green}x, Red below {r.rag.amber}x.
      </span>
      <span>
        <b>Appointment value</b> Sales IB ${p.salesIb.apptValue}, Sales OB ${p.salesOb.apptValue},
        Service IB ${p.serviceIb.apptValue}, Service OB ${p.serviceOb.apptValue}. Spyne planning
        figures, not audited industry data.
      </span>
      <span>
        <b>Red also absorbs</b> dormant agents (under {r.dormantBelow} in 7 days) and agents with no
        MRR on record, so Red + Amber + Green always equals the agent count.
      </span>
      <span>
        <b>Two ways the sides differ.</b> Sales agents live under {r.matureDays} days are scaled up to
        a full {r.matureDays} days before banding; service datasets carry no go-live date, so no
        service agent is scaled. And dormancy reads leads reached everywhere except Service Inbound,
        where nothing is reached, so it reads conversations held.
      </span>
      </div>
    </div>
  );
}

const CSS = `
.tv2{--brand:#4600F2;--ink:#101828;--quiet:#667085;--line:#E4E7EC;--bg:#F6F7F9;
  position:relative;display:flex;flex-direction:column;gap:10px;height:100vh;width:100%;
  padding:12px 16px;box-sizing:border-box;background:var(--bg);color:var(--ink);
  font-family:"Plus Jakarta Sans",system-ui,sans-serif;overflow:hidden}
.tv2-immersive{position:fixed;inset:0;z-index:9999}

.tv2-top{display:flex;align-items:center;gap:12px;flex:0 0 auto}
.tv2-brand{font-weight:800;font-size:13px;letter-spacing:.12em;text-transform:uppercase;
  color:#fff;background:var(--brand);padding:4px 9px;border-radius:6px}
.tv2-top h1{margin:0;font-size:19px;font-weight:800;letter-spacing:-.01em}
.tv2-asof{margin-left:auto;font-size:12px;font-weight:600;color:var(--quiet)}
.tv2-fs{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
  border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--quiet);cursor:pointer;
  transition:color .18s ease,border-color .18s ease}
.tv2-fs:hover{color:var(--brand);border-color:#D9CCFD}
.tv2-fs:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.tv2-immersive .tv2-fs{opacity:0}
.tv2-immersive .tv2-fs:focus-visible{opacity:1}

.tv2-msg{padding:24px;font-size:14px;color:var(--quiet)}
.tv2-err{color:#B42318}
.tv2-err code{background:#fff;border:1px solid var(--line);border-radius:4px;padding:1px 4px}

.tv2-grid{flex:1 1 auto;display:grid;grid-template-columns:1fr 1fr;gap:14px;min-height:0}
.tv2-side{display:grid;grid-template-rows:auto 1fr;gap:8px;min-height:0}
.tv2-sidehead{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;
  color:var(--brand);flex:0 0 auto}

.tv2-block{display:flex;flex-direction:column;gap:6px;min-height:0;background:#fff;
  border:1px solid var(--line);border-radius:12px;padding:9px 11px 10px}
/* One strip per product above the shared table: the per-product totals still need a home
   now that the two products share rows. The bar rides on the same line to save height. */
.tv2-strip{display:flex;align-items:center;gap:12px;flex-wrap:nowrap;flex:0 0 auto}
.tv2-strip .tv2-bar{flex:1 1 auto;min-width:60px;margin-left:2px}
.tv2-name{font-size:14px;font-weight:800;letter-spacing:-.01em}
.tv2-kpi{font-size:11.5px;font-weight:600;color:var(--quiet)}
.tv2-kpi b{font-size:15px;font-weight:800;color:var(--ink);margin-right:3px}
.tv2-kpi-band b{color:inherit}

.tv2-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:#EEF0F3;flex:0 0 auto}
.tv2-bar span{display:block;height:100%}

.tv2-wrap{flex:1 1 auto;min-height:0;overflow:hidden}

/* The overnight-change line. Sits under the table, one or two lines, and is always present
   so all four blocks keep the same shape for the fit routine. */
.tv2-note{margin:0;flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:baseline;
  gap:1px 9px;font-size:max(10.5px,0.78vh);line-height:1.3;color:#475467;
  padding-top:4px;border-top:1px solid #F2F4F7}
.tv2-note + .tv2-note{border-top:none;padding-top:1px}
.tv2-notetag{font-weight:700;color:var(--brand);font-size:.9em;text-transform:uppercase;
  letter-spacing:.05em}
.tv2-note-quiet{color:#98A2B3}
.tv2-notelab{font-weight:700;color:var(--ink)}
.tv2-delta{font-weight:700}
.tv2-why{color:var(--quiet)}
.tv2-why::before{content:"·";margin-right:8px;color:#D0D5DD}
/* Fixed layout with an explicit colgroup: "Deepanshu Agarwal" clipped to "Deepanshu Ag…"
   on a wall display, and a name nobody can read is a name nobody can act on. */
.tv2-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:15px;
  font-variant-numeric:tabular-nums}
.tv2-table th{font-size:.66em;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  color:var(--quiet);text-align:left;padding:calc(.24em + var(--rowpad,0px)) .4em;
  border-bottom:2px solid var(--line);white-space:nowrap}
.tv2-table td{padding:calc(.24em + var(--rowpad,0px)) .4em;border-bottom:1px solid #F2F4F7;
  white-space:nowrap}
/* Which product a block of four columns belongs to. Without it the row is eight unlabelled
   numbers and nobody can tell inbound from outbound at a glance. */
.tv2-group th{border-bottom:none;padding-bottom:.1em}
.tv2-grouph{text-align:center!important;color:var(--brand);font-size:.62em;letter-spacing:.1em}
.tv2-grouph:nth-of-type(even){background:#FBFAFF}
.tv2-none{color:#D0D5DD}
.tv2-table .r{text-align:right}
.tv2-csm{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.tv2-total td{border-bottom:none;border-top:2px solid var(--brand);font-weight:800;padding-top:.35em}

/* The basis lives behind the Info button rather than across the bottom. It still has to be
   one click away (a bare percentage on a wall gets argued with and then ignored), but as a
   permanent footer it was four lines nobody reads from across the room, eating height the
   tables want. Off the wall, the type can also be a readable size instead of 10px. */
/* Light, because this is a popover on a wall and not a modal on a form: at .28 it turned the
   tables muddy, and the point of a wall is that the tables stay readable while someone at the
   laptop checks the basis. Enough tint to signal "click anywhere to dismiss", no more. */
.tv2-scrim{position:absolute;inset:0;z-index:40;background:rgba(16,24,40,.10)}
.tv2-info{position:absolute;z-index:41;top:52px;right:16px;width:min(46vw,calc(100% - 32px));
  min-width:min(680px,calc(100% - 32px));
  max-height:calc(100% - 80px);overflow:auto;background:#fff;border:1px solid var(--line);
  border-radius:14px;padding:14px 16px 16px;box-shadow:0 16px 44px rgba(70,0,242,.16)}
.tv2-info:focus{outline:none}
.tv2-info:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.tv2-infotop{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.tv2-infotop h2{margin:0;font-size:max(13px,0.95vh);font-weight:800;letter-spacing:.04em;
  text-transform:uppercase;color:var(--brand)}
.tv2-infotop .tv2-fs{margin-left:auto}
/* Scales with the screen like the tables do: 13px on a laptop, ~18px on a 4K wall. A fixed
   13px was legible at a desk and unreadable on the panel someone opens from across a room. */
.tv2-foot{display:grid;gap:9px;font-size:max(13px,0.85vh);line-height:1.5;color:#475467}
.tv2-foot b{color:var(--ink)}

@media (prefers-reduced-motion:reduce){.tv2 *{transition:none!important;animation:none!important}}
`;
