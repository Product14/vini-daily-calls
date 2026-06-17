import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import "./index.css";
import Dashboard from "../inventory-dashboard.tsx";
import AgentsDashboard from "./agents/AgentsDashboard.tsx";
import DreamDashboard from "./dream/DreamDashboard.tsx";
import ProgramsDashboard from "./programs/ProgramsDashboard.tsx";
import { EmailerTracker } from "./email/EmailerTracker.tsx";

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
  // Two faces of the agent dashboard, split by route:
  //   "/"       → Overall (company-wide, agent-type level)
  //   "/agents" → Rooftop level (per-rooftop ROI table)
  // The in-page toggle navigates between these two paths.
  if (path === "/agents" || path.startsWith("/agents/")) {
    return <AgentsDashboard mainView="rooftop" />;
  }
  if (path === "/dream" || path.startsWith("/dream/")) {
    return <DreamDashboard />;
  }
  if (path === "/email-tracker" || path.startsWith("/email-tracker/")) {
    return (
      <div style={{ height: "100vh", width: "100%" }}>
        <EmailerTracker />
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
