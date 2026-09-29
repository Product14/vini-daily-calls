import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
// The email tracker stays in the entry bundle: it is the page CSMs keep open, and loading it
// lazily would add a second serial round-trip (entry, then chunk) before its data can render.
// Every other dashboard is split into its own chunk, so the tracker no longer downloads them.
import { EmailerTracker } from "./email/EmailerTracker.tsx";
import { TrackerAuthGate } from "./email/TrackerAuthGate.tsx";
import { Analytics } from "@vercel/analytics/react";

// A tab opened before a deploy (the TV walls stay open for days) still knows the old build's chunk
// names, which the new deploy no longer serves, so its next route change would fail to import and
// blank the page. Reload once to pick up the new build; a second failure is a real error.
const CHUNK_RELOAD_KEY = "vini-chunk-reload";
function lazyRoute(load) {
  return lazy(() =>
    load()
      .then((m) => { try { sessionStorage.removeItem(CHUNK_RELOAD_KEY); } catch { /* ignore */ } return m; })
      .catch((err) => {
        let reloaded = true;
        try { reloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1"; if (!reloaded) sessionStorage.setItem(CHUNK_RELOAD_KEY, "1"); } catch { /* no storage: don't loop */ }
        if (reloaded) throw err;
        window.location.reload();
        return new Promise(() => {}); // the reload replaces this page
      }),
  );
}

const Dashboard = lazyRoute(() => import("../inventory-dashboard.tsx"));
const AgentsDashboard = lazyRoute(() => import("./agents/AgentsDashboard.tsx"));
const DreamDashboard = lazyRoute(() => import("./dream/DreamDashboard.tsx"));
const ProgramsDashboard = lazyRoute(() => import("./programs/ProgramsDashboard.tsx"));
const RealtimeLog = lazyRoute(() => import("./email/RealtimeLog.tsx").then((m) => ({ default: m.RealtimeLog })));
const TvWall2View = lazyRoute(() => import("./tvwall2/TvWall2View.tsx"));

function Router() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (path === "/programs" || path.startsWith("/programs/")) {
    return <ProgramsDashboard />;
  }
  // Four faces of the agent dashboard, split by route:
  //   "/"             → Overall (company-wide, agent-type level)
  //   "/agents"       → Rooftop level (per-rooftop ROI table)
  //   "/rag-analysis" → RAG health view (critical-metric red/amber/green)
  //   "/scorecard"    → Agent Scorecard (week/month, click-to-drill-down)
  // The in-page toggle navigates between these paths.
  if (path === "/agents" || path.startsWith("/agents/")) {
    return <AgentsDashboard mainView="rooftop" />;
  }
  if (path === "/rag-analysis" || path.startsWith("/rag-analysis/")) {
    return <AgentsDashboard mainView="rag" />;
  }
  if (path === "/scorecard" || path.startsWith("/scorecard/")) {
    return <AgentsDashboard mainView="scorecard" />;
  }
  if (path === "/dream" || path.startsWith("/dream/")) {
    return <DreamDashboard />;
  }
  // Second TV wall: the RAG board, sales on the left and service on the right.
  // Separate route rather than a tab inside AgentsDashboard because it is a wall
  // display with no chrome, not a view someone drills into.
  if (path === "/tv-wall-2" || path.startsWith("/tv-wall-2/")) {
    return <TvWall2View />;
  }
  if (path === "/email-tracker/realtime") {
    return (
      <TrackerAuthGate>
        <RealtimeLog />
      </TrackerAuthGate>
    );
  }
  if (path === "/email-tracker" || path.startsWith("/email-tracker/")) {
    return (
      <div style={{ height: "100vh", width: "100%" }}>
        <TrackerAuthGate>
          <EmailerTracker />
        </TrackerAuthGate>
      </div>
    );
  }
  // VIN inventory dashboard — moved off "/" (now the Overall view) to an
  // explicit path; still the fallback for any unmatched route.
  if (path === "/inventory" || path.startsWith("/inventory/")) {
    return <Dashboard />;
  }
  if (path === "/") {
    return <AgentsDashboard mainView="overall" />;
  }
  return <Dashboard />;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Router />
    </Suspense>
    <Analytics />
  </StrictMode>
);
