import type { IngestProgress, IngestStepTiming } from "../lib/dataBackend";

export function IngestSpinner({ label = "Loading" }: { label?: string }) {
  return <span className="enr-ev-roster__pull-spinner" role="status" aria-label={label} title={label} />;
}

export function formatIngestDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function IngestTimingsTable({ timings, runStartedAt }: { timings: IngestStepTiming[]; runStartedAt?: number }) {
  const total =
    runStartedAt != null ? Date.now() - runStartedAt : timings.reduce((s, t) => s + t.durationMs, 0);
  return (
    <table className="enr-table enr-ingestTimings" style={{ marginTop: 8, fontSize: 13 }}>
      <thead>
        <tr>
          <th>Step</th>
          <th>Time</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {timings.map((t, i) => (
          <tr key={`${t.phase}-${t.label}-${i}`} className={t.status === "error" ? "enr-feedRow--noUrl" : undefined}>
            <td>
              {t.label}
              {t.detail ? (
                <span className="enr-muted" style={{ display: "block", fontSize: 12 }}>
                  {t.detail}
                </span>
              ) : null}
            </td>
            <td>{formatIngestDuration(t.durationMs)}</td>
            <td>{t.status === "ok" ? "OK" : t.status === "error" ? "Failed" : t.status}</td>
          </tr>
        ))}
        <tr>
          <td>
            <strong>Total (so far)</strong>
          </td>
          <td>
            <strong>{formatIngestDuration(total)}</strong>
          </td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}

export function IngestProgressStatus({
  progress,
  fallback = "Updating sources…",
}: {
  progress: IngestProgress | null;
  fallback?: string;
}) {
  const detail = progress?.detail?.trim() || fallback;
  const steps =
    progress?.step != null && progress?.totalSteps != null && progress.totalSteps > 0
      ? ` (${progress.step}/${progress.totalSteps})`
      : "";
  const timings = progress?.stepTimings ?? [];
  return (
    <div className="enr-ingest-progress" role="status" aria-live="polite">
      <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <IngestSpinner label={detail} />
        <span>
          {detail}
          {steps}
        </span>
      </p>
      {timings.length > 0 ? (
        <IngestTimingsTable timings={timings} runStartedAt={progress?.runStartedAt} />
      ) : null}
    </div>
  );
}

/** One-line + optional table for completed ingest results. */
export function formatIngestResultSummary(result: {
  sos?: { inserted?: number; durationMs?: number };
  counties?: Record<string, { inserted?: number; durationMs?: number }>;
  stepTimings?: IngestStepTiming[];
  totalDurationMs?: number;
}): string {
  const sosMs = result.sos?.durationMs;
  const countyParts = Object.entries(result.counties ?? {}).map(([k, v]) => {
    const t = v.durationMs != null ? ` ${formatIngestDuration(v.durationMs)}` : "";
    return `${k}: ${v.inserted ?? 0}${t}`;
  });
  const total =
    result.totalDurationMs != null
      ? formatIngestDuration(result.totalDurationMs)
      : result.stepTimings?.length
        ? formatIngestDuration(result.stepTimings.reduce((s, t) => s + t.durationMs, 0))
        : null;
  const sosPart = `SOS: ${result.sos?.inserted ?? 0}${sosMs != null ? ` (${formatIngestDuration(sosMs)})` : ""}`;
  return `${sosPart}. Counties: ${countyParts.join(", ") || "none"}.${total ? ` Total: ${total}.` : ""}`;
}

export function IngestResultTimings({ stepTimings, runStartedAt }: { stepTimings?: IngestStepTiming[]; runStartedAt?: number }) {
  if (!stepTimings?.length) return null;
  return <IngestTimingsTable timings={stepTimings} runStartedAt={runStartedAt} />;
}
