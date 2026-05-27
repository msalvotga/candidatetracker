import { useEffect, useState } from "react";
import { fetchCountyRaceSources, type CountyRaceSourcesPayload } from "../lib/dataBackend";

export function CountySourceResultsModal({
  open,
  electionId,
  raceId,
  raceTitle,
  onClose,
}: {
  open: boolean;
  electionId: string | null;
  raceId: string;
  raceTitle: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<CountyRaceSourcesPayload | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!electionId || !/^\d+$/.test(electionId)) {
      setError("County source results are only available for Civix/SOS elections.");
      setPayload(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchCountyRaceSources(electionId, raceId);
        if (!cancelled) setPayload(next);
      } catch (e) {
        if (!cancelled) {
          setPayload(null);
          setError(e instanceof Error ? e.message : "Failed to load county source results");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, electionId, raceId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="enr-modalBackdrop" onClick={onClose}>
      <div className="enr-countyHistoryModal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="enr-countyHistoryModal__header">
          <div>
            <h3 className="enr-countyHistoryModal__title">County Source Results</h3>
            <p className="enr-muted enr-countyHistoryModal__subtitle">{raceTitle}</p>
          </div>
          <button type="button" className="enr-countyHistoryModal__close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="enr-countyHistoryModal__body">
          {loading ? <p className="enr-muted">Loading county source rows…</p> : null}
          {!loading && error ? <p className="enr-muted">{error}</p> : null}
          {!loading && !error && payload?.note ? <p className="enr-muted">{payload.note}</p> : null}
          {!loading && !error && payload && payload.rows.length === 0 ? (
            <p className="enr-muted">No county source rows for this race yet.</p>
          ) : null}
          {!loading && !error && payload && payload.rows.length > 0 ? (
            <div className="enr-tableWrap">
              <table className="enr-table enr-table--compact">
                <thead>
                  <tr>
                    <th>County</th>
                    <th>Contest</th>
                    <th>Candidate (county)</th>
                    <th>Party</th>
                    <th>Total</th>
                    <th>Mapped to SOS</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.rows.map((row) => (
                    <tr key={`${row.countyKey}-${row.countyContestName}-${row.countyChoiceName || "empty"}`}>
                      <td>{row.countyKey}</td>
                      <td>{row.countyContestName}</td>
                      <td>{row.countyChoiceName || "—"}</td>
                      <td>{row.partyName || "—"}</td>
                      <td>{row.totalVotes.toLocaleString()}</td>
                      <td>{row.effectiveSosCandidateName || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
