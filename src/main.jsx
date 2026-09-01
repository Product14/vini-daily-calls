import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import Dashboard from "../inventory-dashboard.tsx";
import AgentsDashboard from "./agents/AgentsDashboard.tsx";
import DreamDashboard from "./dream/DreamDashboard.tsx";
import ProgramsDashboard from "./programs/ProgramsDashboard.tsx";
import { EmailerTracker } from "./email/EmailerTracker.tsx";
import { RealtimeLog } from "./email/RealtimeLog.tsx";
import { TrackerAuthGate } from "./email/TrackerAuthGate.tsx";
import TvWall2View from "./tvwall2/TvWall2View.tsx";
import { Analytics } from "@vercel/analytics/react";

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
    <Router />
    <Analytics />
  </StrictMode>
);
