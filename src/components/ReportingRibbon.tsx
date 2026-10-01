import { useEffect, useState, type ReactNode } from "react";
import type { ReportingSnapshot } from "../types/election";
import { formatDateTime } from "../lib/voteMath";
import { LiveCount } from "./LiveCount";

function pctCircle(label: ReactNode, value: number, total: number, tone: "pink" | "green") {
  const pct = total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
  const ring = tone === "pink" ? "var(--tx-pink)" : "var(--tx-green)";
  return (
    <div className="enr-gauge">
      <div
        className="enr-gauge__ring"
        style={{
          background: `conic-gradient(${ring} ${pct * 3.6}deg, #e9eef5 0deg)`,
        }}
      >
        <div className="enr-gauge__inner">
          <div className="enr-gauge__pct">
            <LiveCount value={Math.round(pct)} />%
          </div>
        </div>
      </div>
      <div className="enr-gauge__text">{label}</div>
    </div>
  );
}

function formatCountdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return "00:00";
  const s = Math.ceil(msRemaining / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function ReportingRibbon({
  reporting,
  nextRunAt,
  autoRefreshEnabled,
  ingestRunning,
  displayTimeZone,
  appRefreshedAtMs,
}: {
  reporting: ReportingSnapshot;
  nextRunAt: number | null;
  autoRefreshEnabled: boolean;
  ingestRunning: boolean;
  displayTimeZone: string;
  /** When this app last finished ingest for the viewed election (overrides stale Civix Home time). */
  appRefreshedAtMs?: number | null;
}) {
  const { counties, pollingLocations, lastUpdated, lastUpdatedDisplay, resultStatus } = reporting;
  const dbRefreshMs = reporting.appRefreshedAt ? Date.parse(reporting.appRefreshedAt) : NaN;
  const refreshMs = [appRefreshedAtMs, dbRefreshMs].filter(
    (t): t is number => t != null && Number.isFinite(t),
  );
  const displayRefreshMs = refreshMs.length ? Math.max(...refreshMs) : Date.parse(lastUpdated);
  const sosReportedMs = Date.parse(lastUpdated);
  const showSosReported =
    Number.isFinite(sosReportedMs) &&
    Number.isFinite(displayRefreshMs) &&
    Math.abs(sosReportedMs - displayRefreshMs) > 60_000;
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) % 1000000), 250);
    return () => window.clearInterval(id);
  }, []);

  const now = Date.now();
  const msLeft = nextRunAt != null && autoRefreshEnabled ? Math.max(0, nextRunAt - now) : 0;
  const clockFace = ingestRunning ? "…" : autoRefreshEnabled ? formatCountdown(msLeft) : "—";
  const nextLine = ingestRunning
    ? "Refreshing data…"
    : autoRefreshEnabled
      ? "Next automatic refresh"
      : "Auto refresh off (enable under Settings)";

  return (
    <div className="enr-ribbon">
      <div className="enr-ribbon__inner">
        <div className="enr-ribbon__gauges">
          {pctCircle(
            <>
              <LiveCount value={counties.reported} /> of {counties.total.toLocaleString()} Counties with data
            </>,
            counties.reported,
            counties.total,
            "pink",
          )}
          {pctCircle(
            <>
              <LiveCount value={pollingLocations.reported} /> of {pollingLocations.total.toLocaleString()} Polling locations reporting
            </>,
            pollingLocations.reported,
            pollingLocations.total,
            "green",
          )}
        </div>
        <div className="enr-ribbon__clock">
          <div className="enr-clock__ring">
            <div className="enr-clock__inner">{clockFace}</div>
          </div>
          <div className="enr-clock__meta">
            <div className="enr-clock__line muted">{nextLine}</div>
            <div className="enr-clock__line">
              <span className="muted">Last refreshed</span>{" "}
              {Number.isFinite(displayRefreshMs)
                ? formatDateTime(new Date(displayRefreshMs).toISOString(), displayTimeZone)
                : formatDateTime(lastUpdated, displayTimeZone)}
            </div>
            {showSosReported ? (
              <div className="enr-clock__line muted" style={{ fontSize: 12 }}>
                SOS reported{" "}
                {lastUpdatedDisplay?.trim()
                  ? lastUpdatedDisplay
                  : formatDateTime(lastUpdated, displayTimeZone)}
              </div>
            ) : null}
            {resultStatus && (
              <div className="enr-clock__line">
                <span className="enr-pill">{resultStatus}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
