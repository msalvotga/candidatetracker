import type { IngestProgress } from "../lib/dataBackend";

export function IngestSpinner({ label = "Loading" }: { label?: string }) {
  return <span className="enr-ev-roster__pull-spinner" role="status" aria-label={label} title={label} />;
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
  return (
    <p className="enr-ingest-progress" role="status" aria-live="polite">
      <IngestSpinner label={detail} />
      <span>
        {detail}
        {steps}
      </span>
    </p>
  );
}
