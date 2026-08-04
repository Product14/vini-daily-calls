import { useEffect, useRef, useState } from "react";
import { trackerAuthHeaders } from "./dataSource";

interface SendLog {
  id: string;
  timestamp: Date;
  rooftop: string;
  team_name: string;
  team_id: string;
  department: string;
  cadence: string;
  status: string;
  recipients_count: number;
  opened_count?: number;
}

export function RealtimeLog() {
  const [logs, setLogs] = useState<SendLog[]>([]);
  const [isPolling, setIsPolling] = useState(true);
  const [stats, setStats] = useState({
    totalSent: 0,
    todaySent: 0,
    lastUpdateTime: new Date(),
  });
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const lastCheckRef = useRef<string>("");

  const fetchRecentSends = async () => {
    try {
      const headers = trackerAuthHeaders();
      if (!headers) {
        console.warn("No auth headers available");
        return;
      }

      const response = await fetch("/api/tracker/rooftops-data", {
        headers,
      });

      if (!response.ok) {
        console.error("Failed to fetch rooftop data:", response.statusText);
        return;
      }

      const data = await response.json();

      if (!data.ok || !data.runs) {
        return;
      }

      // Parse runs and filter for recent sends (last 24 hours)
      const now = new Date();
      const last24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const newLogs: SendLog[] = [];
      const seenIds = new Set<string>();

      // Process runs in reverse chronological order (newest first)
      (data.runs || []).forEach((run: any) => {
        const sentAt = run.sent_at ? new Date(run.sent_at) : null;
        if (!sentAt) return;

        // Only include last 24 hours of sends
        if (sentAt < last24hAgo) return;

        const logId = `${run.team_id}-${run.department}-${run.cadence}-${run.local_date}-${run.sent_at}`;
        if (seenIds.has(logId)) return;
        seenIds.add(logId);

        newLogs.push({
          id: logId,
          timestamp: sentAt,
          rooftop: run.rooftop_name || run.team_id.slice(0, 8),
          team_name: run.team_name || run.enterprise_name || "",
          team_id: run.team_id,
          department: run.department,
          cadence: run.cadence,
          status: run.status,
          recipients_count: run.recipients ? (Array.isArray(run.recipients) ? run.recipients.length : 0) : 0,
          opened_count: run.open_count,
        });
      });

      // Sort by timestamp descending
      newLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      setLogs(newLogs);
      setStats({
        totalSent: newLogs.length,
        todaySent: newLogs.length,
        lastUpdateTime: new Date(),
      });

      lastCheckRef.current = new Date().toISOString();
    } catch (error) {
      console.error("Error fetching recent sends:", error);
    }
  };

  useEffect(() => {
    // Initial fetch
    fetchRecentSends();

    // Poll every 5 seconds
    pollingRef.current = setInterval(() => {
      if (isPolling) {
        fetchRecentSends();
      }
    }, 5000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [isPolling]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  };

  const formatDepartment = (dept: string) => {
    const deptMap: Record<string, string> = {
      sales_ib: "Sales IB",
      sales_ob: "Sales OB",
      service_ib: "Service IB",
      service_ob: "Service OB",
    };
    return deptMap[dept] || dept;
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", backgroundColor: "#0f172a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* Header */}
      <div style={{ padding: "20px", borderBottom: "1px solid #1e293b", backgroundColor: "#0f172a" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: "600" }}>📧 Email Sends (Realtime)</h1>
          <button
            onClick={() => setIsPolling(!isPolling)}
            style={{
              padding: "8px 16px",
              backgroundColor: isPolling ? "#ef4444" : "#22c55e",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: "500",
            }}
          >
            {isPolling ? "Pause" : "Resume"}
          </button>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
          <div style={{ padding: "12px", backgroundColor: "#1e293b", borderRadius: "8px", border: "1px solid #334155" }}>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "4px" }}>EMAILS SENT (24H)</div>
            <div style={{ fontSize: "32px", fontWeight: "700", color: "#4ade80" }}>{stats.todaySent}</div>
          </div>
          <div style={{ padding: "12px", backgroundColor: "#1e293b", borderRadius: "8px", border: "1px solid #334155" }}>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "4px" }}>LAST UPDATE</div>
            <div style={{ fontSize: "14px", color: "#cbd5e1" }}>{formatTime(stats.lastUpdateTime)}</div>
          </div>
        </div>
      </div>

      {/* Log Container */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column" }}>
        {logs.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#64748b" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "18px", marginBottom: "8px" }}>No emails sent in last 24 hours</div>
              <div style={{ fontSize: "14px" }}>Check if digest cron is running • Updates every 5 seconds</div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {logs.map((log, idx) => (
              <div
                key={log.id}
                style={{
                  padding: "12px 16px",
                  backgroundColor: "#1e293b",
                  borderRadius: "6px",
                  border: "1px solid #334155",
                  display: "grid",
                  gridTemplateColumns: "80px 120px 140px 100px 100px 100px 1fr",
                  gap: "12px",
                  alignItems: "center",
                  fontSize: "13px",
                  animation: idx === 0 ? "slideIn 0.3s ease-out" : "none",
                }}
              >
                <div style={{ color: "#4ade80", fontWeight: "600" }}>{formatTime(log.timestamp)}</div>
                <div style={{ color: "#cbd5e1", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={log.rooftop}>
                  {log.rooftop}
                </div>
                <div style={{ color: "#a78bfa", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={log.team_name}>
                  {log.team_name || "—"}
                </div>
                <div style={{ color: "#94a3b8" }}>{formatDepartment(log.department)}</div>
                <div style={{ color: "#94a3b8", textTransform: "capitalize" }}>{log.cadence}</div>
                <div style={{ color: log.status === "sent" ? "#4ade80" : log.status === "held" ? "#f59e0b" : "#ef4444" }}>
                  {log.status.toUpperCase()}
                </div>
                <div style={{ color: "#cbd5e1", textAlign: "right" }}>
                  {log.recipients_count} recipient{log.recipients_count !== 1 ? "s" : ""}
                  {log.opened_count !== undefined && log.opened_count > 0 && (
                    <span style={{ color: "#60a5fa", marginLeft: "8px" }}>
                      • {log.opened_count} opened
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
