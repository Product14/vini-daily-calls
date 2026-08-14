// ABR Trends — /abr-trends
//
// Where the appointment funnel broke and when, across SMS and calls.
// Data comes precomputed from /api/abr-trends (see server/abrTrends.js); this component
// only slices and renders. Every count in the payload is DISTINCT LEADS.
//
// Two rules the payload imposes on this component, both load-bearing:
//   1. Never sum across channel, bucket or grain. Each row is emitted under its real
//      value AND under 'all', so summing double-counts. Always read the 'all' slice.
//   2. Trailing partial periods are flagged and excluded from the per-row median that
//      drives the heat colour, and the stat tiles default to the last COMPLETE period.
//      Without that the current short week reads as a collapse on every page load.
import { useEffect, useMemo, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

type Grain = "d" | "w" | "m";
type Chan = "all" | "sms" | "call";

type Payload = {
  per: Record<Grain, string[]>;
  partial: Record<Grain, boolean[]>;
  buckets: string[];
  chans: string[];
  keys: string[];
  fun: Record<string, number[][]>;
  items: Record<string, Record<string, number[]>>;
  days: number;
  computedAt?: string | null;
  meta?: { computedAt?: string };
};

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const LBL: Record<string, string> = {
  all: "All agents",
  sales_inbound: "Sales inbound", sales_outbound: "Sales outbound",
  service_inbound: "Service inbound", service_outbound: "Service outbound",
  receptionist_inbound: "Receptionist inbound", receptionist_outbound: "Receptionist outbound",
  sales_unknown: "Sales (unmapped)", service_unknown: "Service (unmapped)",
  unknown_unknown: "Unmapped",
};
const CHLBL: Record<Chan, string> = { all: "All conversations", sms: "SMS", call: "Calls" };

const fmt = (p: string, g: Grain) => {
  const [y, m, d] = p.split("-").map(Number);
  return g === "m" ? `${MON[m - 1]} ${String(y).slice(2)}` : `${d} ${MON[m - 1]}`;
};
const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

const pEnd = (g: Grain, p: string) => {
  const [y, m, d] = p.split("-").map(Number);
  if (g === "d") return p;
  if (g === "w") return new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// median over the visible window, ignoring partial periods
function med(a: (number | null)[], pt: boolean[]) {
  const v = a.filter((x, i) => x != null && isFinite(x as number) && !pt[i]).sort((x, y) => (x as number) - (y as number)) as number[];
  if (!v.length) return null;
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}
function heat(v: number | null, m: number | null) {
  if (v == null || !m) return "hn";
  const d = ((v - m) / m) * 100;
  return d <= -50 ? "h1" : d <= -30 ? "h2" : d <= -15 ? "h3" : d >= 40 ? "h6" : d >= 15 ? "h5" : "h4";
}

type Row = { label: string; hint: string; vals: (number | null)[]; subs: (number | null)[] | null; unit: string; kind: "sp" | "at"; noheat?: boolean };

export default function AbrTrends() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [G, setG] = useState<Grain>("w");
  const [CH, setCH] = useState<Chan>("all");
  const [B, setB] = useState("all");
  const [d1, setD1] = useState("");
  const [d2, setD2] = useState("");
  const [pk, setPk] = useState<number | null>(null);
  const [open, setOpen] = useState<{ t: boolean; a: boolean }>({ t: false, a: false });

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/abr-trends`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error ?? r.statusText)))))
      .then((j: Payload) => {
        if (!alive) return;
        setData(j);
        const lo = j.per.m[0], hi = j.per.d[j.per.d.length - 1];
        setD1(lo); setD2(hi);
      })
      .catch((e) => alive && setErr(String(e.message ?? e)));
    return () => { alive = false; };
  }, []);

  // visible period indices — a period is kept when it OVERLAPS the range, so a week or
  // month the user is standing in is not clipped away by its start date alone
  const idx = useMemo(() => {
    if (!data) return [];
    const keep: number[] = [];
    data.per[G].forEach((s, i) => {
      const e = pEnd(G, s);
      if ((!d1 || e >= d1) && (!d2 || s <= d2)) keep.push(i);
    });
    return keep.length ? keep : data.per[G].map((_, i) => i);
  }, [data, G, d1, d2]);

  const sl = <T,>(a: T[]) => idx.map((i) => a[i]);
  const K = (k: string) => (data ? data.keys.indexOf(k) : -1);
  const periods = data ? sl(data.per[G]) : [];
  const pt = data ? sl(data.partial[G]) : [];
  const F = (ch: Chan = CH) => (data ? sl(data.fun[`${G}|${ch}|${B}`] ?? []) : []);
  const lastFull = () => { for (let i = pt.length - 1; i >= 0; i--) if (!pt[i]) return i; return pt.length - 1; };
  const sel = pk != null && pk < periods.length ? pk : lastFull();

  if (err) return <Shell><div className="msg err">Couldn’t load ABR Trends — {err}</div></Shell>;
  if (!data) return <Shell><div className="msg">Loading…</div></Shell>;

  const f = F();
  if (!f.length) return <Shell><div className="msg">No data for this combination.</div></Shell>;
  const g = (k: string) => f.map((r) => r[K(k)]);
  const att = g("att"), rch = g("rch"), eng = g("eng"), qual = g("qual"), bkd = g("bkd"), tool = g("tool");

  const pctv = (nu: number[], de: number[]) => nu.map((n, i) => (de[i] ? Math.round((n / de[i]) * 1000) / 10 : null));
  const RCH_HINT = { all: "% of attempted — delivered or answered", sms: "% of attempted — message delivered", call: "% of attempted — answered, not voicemail" }[CH];
  const ENG_HINT = { all: "% of leads reached — replied or spoke", sms: "% of leads reached — customer replied", call: "% of leads reached — customer spoke" }[CH];

  const rows: Row[] = [
    { label: "Leads attempted", hint: "lead count — no denominator", vals: att, subs: null, unit: "", kind: "sp", noheat: true },
    { label: "Reached", hint: RCH_HINT, vals: pctv(rch, att), subs: rch, unit: "%", kind: "sp" },
    { label: "Engaged", hint: ENG_HINT, vals: pctv(eng, rch), subs: eng, unit: "%", kind: "sp" },
    { label: "Qualified", hint: "% of leads engaged", vals: pctv(qual, eng), subs: qual, unit: "%", kind: "sp" },
    { label: "Booked", hint: "% of leads qualified", vals: pctv(bkd, qual), subs: bkd, unit: "%", kind: "sp" },
    { label: "Booked", hint: "% of leads engaged — skips qualified", vals: pctv(bkd, eng), subs: bkd, unit: "%", kind: "at" },
  ];
  // depth: different units per channel, so never averaged together
  if (CH !== "call") {
    const s = F("sms"), se = s.map((r) => r[K("eng")]), sd = s.map((r) => r[K("dnum")]);
    rows.push({ label: "Conversation depth — SMS", hint: "avg customer messages per engaged lead", vals: se.map((v, i) => (v ? Math.round((sd[i] / v) * 100) / 100 : null)), subs: null, unit: "", kind: "at" });
  }
  if (CH !== "sms") {
    const c = F("call"), ce = c.map((r) => r[K("eng")]), cd = c.map((r) => r[K("dnum")]);
    rows.push({ label: "Conversation depth — calls", hint: "avg talk minutes per engaged lead", vals: ce.map((v, i) => (v ? Math.round((cd[i] / v) * 100) / 100 : null)), subs: null, unit: "", kind: "at" });
  }
  rows.push({ label: "Any tool call", hint: "% of leads engaged", vals: pctv(tool, eng), subs: tool, unit: "%", kind: "at" });

  const bandAt = 5; // parallel-attribute band starts after the second Booked row

  const tiles = [
    { l: "Booked", dn: "leads", cur: bkd[sel], prev: sel > 0 ? bkd[sel - 1] : null, dp: 0 },
    { l: "Booked", dn: "% of leads qualified", cur: qual[sel] ? (bkd[sel] / qual[sel]) * 100 : null, prev: sel > 0 && qual[sel - 1] ? (bkd[sel - 1] / qual[sel - 1]) * 100 : null, dp: 1 },
    { l: "Reached", dn: "% of leads attempted", cur: att[sel] ? (rch[sel] / att[sel]) * 100 : null, prev: sel > 0 && att[sel - 1] ? (rch[sel - 1] / att[sel - 1]) * 100 : null, dp: 1 },
    { l: "Qualified", dn: "% of leads engaged", cur: eng[sel] ? (qual[sel] / eng[sel]) * 100 : null, prev: sel > 0 && eng[sel - 1] ? (qual[sel - 1] / eng[sel - 1]) * 100 : null, dp: 1 },
  ];

  const drill = (fam: "t" | "a") => {
    const raw = data.items[`${G}|${CH}|${B}|${fam}`] ?? {};
    const src: Record<string, number[]> = {};
    for (const k in raw) { const v = sl(raw[k]); if (v.some((x) => x > 0)) src[k] = v; }
    const names = Object.keys(src).sort((a, b) => src[b].reduce((x, y) => x + y, 0) - src[a].reduce((x, y) => x + y, 0));
    return { src, names };
  };
  const tools = drill("t"), acts = drill("a");
  const computedAt = data.computedAt ?? data.meta?.computedAt ?? null;

  return (
    <Shell>
      <header>
        <div className="hrow">
          <div>
            <div className="eyebrow">Vini · conversations</div>
            <h1>ABR Trends</h1>
          </div>
          <div className="ctl">
            <div className="seg" role="group" aria-label="Time grain">
              {(["d", "w", "m"] as Grain[]).map((x) => (
                <button key={x} type="button" aria-pressed={G === x} onClick={() => { setG(x); setPk(null); }}>
                  {x === "d" ? "Daily" : x === "w" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Channel">
              {(["all", "sms", "call"] as Chan[]).map((x) => (
                <button key={x} type="button" aria-pressed={CH === x} onClick={() => { setCH(x); setPk(null); }}>
                  {x === "all" ? "All" : x === "sms" ? "SMS" : "Calls"}
                </button>
              ))}
            </div>
            <select value={B} onChange={(e) => { setB(e.target.value); setPk(null); }} aria-label="Agent">
              {data.buckets.map((b) => <option key={b} value={b}>{LBL[b] ?? b}</option>)}
            </select>
            <span className="dates">
              <input type="date" value={d1} min={data.per.m[0]} max={data.per.d[data.per.d.length - 1]}
                onChange={(e) => { setD1(e.target.value); setPk(null); }} aria-label="From date" />
              <span className="to">to</span>
              <input type="date" value={d2} min={data.per.m[0]} max={data.per.d[data.per.d.length - 1]}
                onChange={(e) => { setD2(e.target.value); setPk(null); }} aria-label="To date" />
              <button type="button" onClick={() => { setD1(data.per.m[0]); setD2(data.per.d[data.per.d.length - 1]); setPk(null); }}>All</button>
            </span>
          </div>
        </div>
        <div className="stats">
          {tiles.map((t, i) => {
            const val = t.cur == null ? "—" : t.dp ? `${t.cur.toFixed(1)}%` : num(Math.round(t.cur));
            let sev = "", d: React.ReactNode = null;
            if (t.cur != null && t.prev != null && t.prev !== 0) {
              const ch = ((t.cur - t.prev) / t.prev) * 100;
              sev = ch <= -25 ? "s-crit" : ch <= -10 ? "s-warn" : ch >= 10 ? "s-good" : "";
              const tone = ch <= -25 ? "t-crit" : ch <= -10 ? "t-warn" : ch >= 10 ? "t-good" : "t-flat";
              d = <div className={`d ${tone}`}>{ch >= 0 ? "▲" : "▼"} {Math.abs(ch).toFixed(0)}% · prev {t.dp ? `${t.prev.toFixed(1)}%` : num(Math.round(t.prev))}</div>;
            }
            return (
              <div key={i} className={`stat ${sev}`}>
                <div className="l">{pt[sel] && <span className="pw">part period</span>} {t.l}<span className="dn">{t.dn}</span></div>
                <div className="v">{val}</div>{d}
              </div>
            );
          })}
        </div>
      </header>

      <section className="open static">
        <div className="sh">
          <h2>Funnel</h2>
          <span className="cnt">{CHLBL[CH]} · {LBL[B] ?? B} · {num(att.reduce((a, c) => a + c, 0))} leads attempted</span>
        </div>
        <div className="sbody">
          <Matrix rowLabel={{ d: `Last ${data.days} days`, w: "Week of", m: "Month" }[G]}
            periods={periods} partial={pt} G={G} pk={pk} setPk={setPk} rows={rows} bandAt={bandAt}
            bandText="Of leads engaged — parallel attributes, not funnel steps" />
        </div>
        <div className="legend">
          <span>Cell colour vs that row’s median —</span>
          <i style={{ background: "var(--crit-bg2)" }} /><span>−50%</span>
          <i style={{ background: "var(--crit-bg)" }} /><span>−30%</span>
          <i style={{ background: "var(--warn-bg)" }} /><span>−15%</span>
          <i style={{ background: "var(--surface)" }} /><span>flat</span>
          <i style={{ background: "var(--good-bg)" }} /><span>+15%</span>
          <i style={{ background: "var(--good-bg2)" }} /><span>+40%</span>
          <span>· big = rate, small = leads · click a column to inspect it</span>
        </div>
      </section>

      {([["t", "Tool calls", tools, "tools"], ["a", "Action items", acts, "intents"]] as const).map(([fam, title, d, unit]) => (
        <section key={fam} className={open[fam] ? "open" : ""}>
          <button className="sh" type="button" aria-expanded={open[fam]}
            onClick={() => setOpen((o) => ({ ...o, [fam]: !o[fam] }))}>
            <h2>{title}</h2><span className="cnt">{d.names.length} {unit}</span><span className="chev">▶</span>
          </button>
          <div className="sbody">
            <Matrix rowLabel={fam === "t" ? "Tool" : "Action item intent"} rowLabelHint="every cell is % of leads engaged"
              periods={periods} partial={pt} G={G} pk={pk} setPk={setPk}
              rows={d.names.map((n) => ({ label: n, hint: "", vals: pctv(d.src[n], eng), subs: d.src[n], unit: "%", kind: "at" as const }))} />
          </div>
        </section>
      ))}

      <div className="foot">
        Distinct leads throughout · weeks Monday-start UTC · {periods.length} of {data.per[G].length}{" "}
        {{ d: "days", w: "weeks", m: "months" }[G]} shown · inspecting {fmt(periods[sel], G)}
        {pt[sel] ? " (incomplete period)" : ""}
        {computedAt ? <> · data refreshed {new Date(computedAt).toLocaleString()}</> : null}
        <br />
        Booked = AI-attributed appointment on the same conversation. SMS additionally requires the
        conversation to have invoked a booking tool, which excludes CRM-imported appointments a
        campaign only references.
      </div>
    </Shell>
  );
}

function Matrix({ rowLabel, rowLabelHint, periods, partial, G, pk, setPk, rows, bandAt, bandText }: {
  rowLabel: string; rowLabelHint?: string; periods: string[]; partial: boolean[]; G: Grain;
  pk: number | null; setPk: (n: number | null) => void; rows: Row[]; bandAt?: number; bandText?: string;
}) {
  const toggle = (i: number) => setPk(pk === i ? null : i);
  return (
    <table>
      <thead>
        <tr>
          <th className="rl">{rowLabel}{rowLabelHint && <span className="dn">{rowLabelHint}</span>}</th>
          {periods.map((p, i) => (
            <th key={p} className={`ph${pk === i ? " pk" : ""}${partial[i] ? " part" : ""}`}
              tabIndex={0} role="button" onClick={() => toggle(i)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(i); } }}>
              {fmt(p, G)}{partial[i] && <span className="pt">part</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <>
            {bandAt === ri && bandText && (
              <tr className="bd" key="band"><th className="rl" colSpan={periods.length + 1}>{bandText}</th></tr>
            )}
            <tr key={`${r.label}-${r.hint}`} className={r.kind}>
              <th className="rl">{r.label}{r.hint && <span className="dn">{r.hint}</span>}</th>
              {r.vals.map((v, i) => {
                const m = r.noheat ? null : med(r.vals, partial);
                const cls = r.noheat ? "hn" : heat(v, m);
                return (
                  <td key={i} className={`${cls}${pk === i ? " pk" : ""}`}>
                    <span className="n">{v == null ? "—" : `${v}${r.unit}`}</span>
                    {r.subs && r.subs[i] != null && <span className="s">{num(r.subs[i])}</span>}
                  </td>
                );
              })}
            </tr>
          </>
        ))}
      </tbody>
    </table>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="abr"><style>{CSS}</style><div className="wrap">{children}</div></div>;
}

// Scoped under .abr so Tailwind preflight and the app's global font don't fight it, and
// so these tokens don't leak to the other dashboards.
const CSS = `
.abr{
  --ground:#F6F8FA;--surface:#FFF;--surface-2:#EDF1F5;--surface-3:#E3E9F0;
  --ink:#141D29;--ink-2:#31445C;--muted:#69788C;--line:#D9E0E9;--line-2:#C0CCDA;
  --accent:#1D4E77;--accent-2:#2E6FA3;--accent-soft:#E3EDF6;
  --good:#0A6B5F;--good-bg:#DBEEEA;--good-bg2:#B8DED6;
  --warn:#96470A;--warn-bg:#F8E9D6;--warn-bg2:#F0D2AC;
  --crit:#9B2530;--crit-bg:#F7DEE1;--crit-bg2:#EFBCC2;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.5;
}
@media (prefers-color-scheme:dark){.abr{
  --ground:#0E131A;--surface:#141B23;--surface-2:#1C2530;--surface-3:#25313E;
  --ink:#E8EEF5;--ink-2:#B6C4D3;--muted:#8493A6;--line:#242F3C;--line-2:#374556;
  --accent:#7FB2DE;--accent-2:#A8CCE8;--accent-soft:#1A2B3B;
  --good:#6FD5C4;--good-bg:#11362F;--good-bg2:#1A554A;
  --warn:#EFB273;--warn-bg:#382713;--warn-bg2:#5A3F1C;
  --crit:#F29CA5;--crit-bg:#411E23;--crit-bg2:#68303A;
}}
.abr .wrap{max-width:1520px;margin:0 auto;padding:0 20px 80px}
.abr h1{font-size:24px;font-weight:650;letter-spacing:-.02em;margin:0}
.abr .eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600}
.abr .msg{padding:60px 0;font-family:var(--mono);font-size:12px;color:var(--muted)}
.abr .msg.err{color:var(--crit)}
.abr header{position:sticky;top:0;z-index:30;background:var(--ground);padding:20px 0 14px;border-bottom:1px solid var(--line)}
.abr .hrow{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between}
.abr .ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.abr .seg{display:flex;border:1px solid var(--line-2);border-radius:5px;overflow:hidden;background:var(--surface)}
.abr .seg button{font-family:var(--mono);font-size:11px;letter-spacing:.05em;padding:7px 12px;border:0;background:transparent;color:var(--muted);cursor:pointer;font-weight:600;border-right:1px solid var(--line)}
.abr .seg button:last-child{border-right:0}
.abr .seg button[aria-pressed="true"]{background:var(--accent);color:#fff}
.abr select{font-family:var(--mono);font-size:11.5px;font-weight:600;padding:7px 10px;border-radius:5px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);cursor:pointer}
.abr button:focus-visible,.abr select:focus-visible,.abr [tabindex]:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
.abr .dates{display:inline-flex;align-items:center;gap:5px;background:var(--surface);border:1px solid var(--line-2);border-radius:5px;padding:3px 5px}
.abr .dates input{font-family:var(--mono);font-size:11px;font-weight:600;border:0;background:transparent;color:var(--ink);padding:3px 4px;color-scheme:light dark}
.abr .dates .to{font-family:var(--mono);font-size:9.5px;color:var(--muted);letter-spacing:.06em}
.abr .dates button{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.06em;border:1px solid var(--line-2);background:var(--surface-2);color:var(--muted);border-radius:3px;padding:3px 7px;cursor:pointer}
.abr .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:10px;margin:18px 0 6px}
.abr .stat{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px;position:relative;overflow:hidden}
.abr .stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--line-2)}
.abr .stat.s-crit::before{background:var(--crit)}.abr .stat.s-warn::before{background:var(--warn)}.abr .stat.s-good::before{background:var(--good)}
.abr .stat .l{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600}
.abr .stat .v{font-family:var(--mono);font-size:25px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:6px;line-height:1.05}
.abr .stat .d{font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums;margin-top:4px;font-weight:600}
.abr .pw{font-family:var(--mono);font-size:8.5px;letter-spacing:.06em;color:var(--warn);background:var(--warn-bg);padding:1px 4px;border-radius:2px;margin-right:3px}
.abr .t-crit{color:var(--crit)}.abr .t-warn{color:var(--warn)}.abr .t-good{color:var(--good)}.abr .t-flat{color:var(--muted)}
.abr section{background:var(--surface);border:1px solid var(--line);border-radius:7px;margin-top:14px;overflow:hidden}
.abr .sh{display:flex;align-items:center;gap:10px;width:100%;padding:13px 15px;background:transparent;border:0;border-bottom:1px solid transparent;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit}
.abr section.open .sh{border-bottom-color:var(--line)}
.abr .sh h2{font-size:14.5px;font-weight:650;letter-spacing:-.01em;margin:0;flex:0 0 auto}
.abr .sh .cnt{font-family:var(--mono);font-size:10.5px;color:var(--muted);font-weight:600}
.abr .sh .chev{margin-left:auto;color:var(--muted);font-size:11px;transition:transform .16s ease;font-family:var(--mono)}
.abr section.open .sh .chev{transform:rotate(90deg)}
.abr .sh:hover{background:var(--surface-2)}
.abr section.static .sh{cursor:default}.abr section.static .sh:hover{background:transparent}
.abr .sbody{display:none;overflow:auto;max-height:74vh}
.abr section.open .sbody{display:block}
.abr table{border-collapse:separate;border-spacing:0;width:100%;font-variant-numeric:tabular-nums}
.abr th,.abr td{text-align:right;padding:0;white-space:nowrap}
.abr thead th{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.03em;color:var(--muted);padding:8px 9px;background:var(--surface-2);border-bottom:1px solid var(--line-2);position:sticky;top:0;z-index:5;min-width:78px}
.abr thead th.rl,.abr tbody th.rl{text-align:left;position:sticky;left:0;z-index:6;width:296px;min-width:296px;max-width:296px}
.abr thead th.rl{background:var(--surface-2);z-index:20;white-space:normal}
.abr tbody th.rl{background:var(--surface);border-bottom:1px solid var(--line);padding:6px 12px;font-weight:600;font-size:12.5px;line-height:1.3}
.abr tbody td{padding:5px 9px;border-bottom:1px solid var(--line);min-width:78px}
.abr thead th.ph{cursor:pointer}
.abr thead th.ph:hover{color:var(--ink)}
.abr thead th.pk{color:var(--accent);background:var(--accent-soft)}
.abr td.pk{background:var(--accent-soft)}
.abr thead th.part{color:var(--muted)}
.abr thead th.part .pt{display:block;font-size:8px;letter-spacing:.08em;opacity:.75;font-weight:600}
.abr .dn{display:block;font-family:var(--mono);font-size:9px;font-weight:500;letter-spacing:.02em;color:var(--muted);text-transform:none;margin-top:2px;line-height:1.35;white-space:normal}
.abr thead th .dn{font-size:8.5px;opacity:.85}
.abr .n{font-family:var(--mono);font-size:12.5px;font-weight:600;letter-spacing:-.01em;display:block}
.abr .s{font-family:var(--mono);font-size:9px;font-weight:500;opacity:.6;display:block;margin-top:1px}
.abr td.h1{background:var(--crit-bg2)}.abr td.h1 .n{color:var(--crit)}
.abr td.h2{background:var(--crit-bg)}.abr td.h2 .n{color:var(--crit)}
.abr td.h3{background:var(--warn-bg)}.abr td.h3 .n{color:var(--warn)}
.abr td.h5{background:var(--good-bg)}.abr td.h5 .n{color:var(--good)}
.abr td.h6{background:var(--good-bg2)}.abr td.h6 .n{color:var(--good)}
.abr td.h4 .n{color:var(--ink-2)}
.abr td.hn .n{color:var(--muted);font-weight:500}
.abr tr.sp th.rl{color:var(--ink);font-size:13px}
.abr tr.at th.rl{color:var(--ink-2);font-weight:500;padding-left:24px;font-size:12px}
.abr tr.bd th{background:var(--surface-3);padding:4px 12px;font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600;text-align:left;border-bottom:1px solid var(--line);position:sticky;left:0}
.abr tbody tr:hover td:not(.pk){background:var(--surface-2)}
.abr tbody tr:hover th.rl{background:var(--surface-2)}
.abr .legend{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:9px 15px;font-family:var(--mono);font-size:9.5px;color:var(--muted);border-top:1px solid var(--line);background:var(--surface-2)}
.abr .legend i{width:26px;height:10px;border-radius:2px;display:inline-block;border:1px solid var(--line-2)}
.abr .foot{margin-top:22px;font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.7}
`;
