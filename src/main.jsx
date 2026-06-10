import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
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
  if (path === "/agents" || path.startsWith("/agents/")) {
    return <AgentsDashboard />;
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
  return <Dashboard />;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Router />
  </StrictMode>
);
