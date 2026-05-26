import { useEffect, useMemo, useState } from "react";
import type { OfficeHistoricalElectionResult, OfficeHistoricalResultsPayload } from "../lib/dataBackend";

type HistoricalTab = "general" | "primary";

function partyToneClass(partyName: string | null): string {
  const party = String(partyName ?? "")
    .trim()
    .toLowerCase();
  if (party.startsWith("rep")) return "enr-countyHistoryCandidate--rep";
  if (party.startsWith("dem")) return "enr-countyHistoryCandidate--dem";
  return "";
}

function formatCount(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

function formatPct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function tabCountLabel(items: OfficeHistoricalElectionResult[]): string {
  return items.length ? `${items.length}` : "0";
}

export function OfficeHistoricalModal({
  officeName,
  payload,
  loading,
  error,
  onClose,
}: {
  officeName: string | null;
  payload: OfficeHistoricalResultsPayload | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<HistoricalTab>("general");
  const [yearFilter, setYearFilter] = useState("all");
  const [raceLabelFilter, setRaceLabelFilter] = useState("all");

  useEffect(() => {
    setActiveTab("general");
    setYearFilter("all");
    setRaceLabelFilter("all");
  }, [officeName]);

  useEffect(() => {
    if (!officeName) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [officeName, onClose]);

  const general = payload?.generalElections ?? [];
  const primary = payload?.primaryElections ?? [];
  const activeItems = useMemo(
    () => (activeTab === "general" ? general : primary),
    [activeTab, general, primary],
  );
  const yearOptions = useMemo(
    () => Array.from(new Set(activeItems.map((item) => String(item.year)))).sort((a, b) => Number(b) - Number(a)),
    [activeItems],
  );
  const raceLabelOptions = useMemo(() => Array.from(new Set(activeItems.map((item) => item.label))), [activeItems]);
  const filteredItems = useMemo(
    () =>
      activeItems.filter(
        (item) => (yearFilter === "all" || String(item.year) === yearFilter) && (raceLabelFilter === "all" || item.label === raceLabelFilter),
      ),
    [activeItems, yearFilter, raceLabelFilter],
  );

  useEffect(() => {
    if (yearFilter !== "all" && !yearOptions.includes(yearFilter)) {
      setYearFilter("all");
    }
  }, [yearFilter, yearOptions]);

  useEffect(() => {
    if (raceLabelFilter !== "all" && !raceLabelOptions.includes(raceLabelFilter)) {
      setRaceLabelFilter("all");
    }
  }, [raceLabelFilter, raceLabelOptions]);

  if (!officeName) return null;

  return (
    <div className="enr-modalBackdrop" onClick={onClose}>
      <div
        className="enr-countyHistoryModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="enr-office-history-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="enr-countyHistoryModal__header">
          <div>
            <h3 id="enr-office-history-title" className="enr-countyHistoryModal__title">
              {payload?.officeName || officeName} History
            </h3>
            <p className="enr-muted enr-countyHistoryModal__subtitle">
              Historical results aggregated across available counties, newest elections first.
            </p>
          </div>
          <button type="button" className="enr-countyHistoryModal__close" onClick={onClose} aria-label="Close historical data">
            Close
          </button>
        </div>

        <div className="enr-countyHistoryTabs" role="tablist" aria-label="Historical election types">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "general"}
            className={activeTab === "general" ? "is-active" : undefined}
            onClick={() => setActiveTab("general")}
          >
            General
            <span>{tabCountLabel(general)}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "primary"}
            className={activeTab === "primary" ? "is-active" : undefined}
            onClick={() => setActiveTab("primary")}
          >
            Primary
            <span>{tabCountLabel(primary)}</span>
          </button>
        </div>

        <div className="enr-countyHistoryModal__body">
          {loading ? <p className="enr-muted">Loading historical data…</p> : null}
          {!loading && error ? <p className="enr-muted">{error}</p> : null}
          {!loading && !error && !activeItems.length ? (
            <p className="enr-muted">No {activeTab} historical data is available for this race yet.</p>
          ) : null}
          {!loading && !error && activeItems.length ? (
            <div className="enr-countyHistoryFilters">
              <label className="enr-selectLabel enr-countyHistoryFilters__label">
                Year
                <select className="enr-select" value={yearFilter} onChange={(event) => setYearFilter(event.target.value)}>
                  <option value="all">All years</option>
                  {yearOptions.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
              <label className="enr-selectLabel enr-countyHistoryFilters__label">
                Election
                <select className="enr-select" value={raceLabelFilter} onChange={(event) => setRaceLabelFilter(event.target.value)}>
                  <option value="all">All elections</option>
                  {raceLabelOptions.map((raceLabel) => (
                    <option key={raceLabel} value={raceLabel}>
                      {raceLabel}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {!loading && !error && activeItems.length && !filteredItems.length ? (
            <p className="enr-muted">No historical results match the selected year and election filters.</p>
          ) : null}

          {!loading && !error
            ? filteredItems.map((election) => (
                <section key={election.id} className="enr-countyHistoryCard">
                  <div className="enr-countyHistoryCard__header">
                    <h4>{election.label}</h4>
                    <div className="enr-countyHistoryCard__meta">
                      <span>Total Votes Cast: {formatCount(election.totalVotes)}</span>
                      <span>Registered Voters: {formatCount(election.registeredVoters)}</span>
                      <span>Turnout: {formatPct(election.turnoutPct)}</span>
                    </div>
                  </div>

                  <div className="enr-countyHistoryCard__rows">
                    {election.candidates.map((candidate) => (
                      <div
                        key={`${election.id}-${candidate.candidateName}`}
                        className={`enr-countyHistoryCandidate ${partyToneClass(candidate.partyName)}`.trim()}
                      >
                        <div className="enr-countyHistoryCandidate__name">
                          <span>{candidate.candidateName}</span>
                          {candidate.partyName ? (
                            <span className="enr-muted enr-countyHistoryCandidate__party">{candidate.partyName}</span>
                          ) : null}
                        </div>
                        <div className="enr-countyHistoryCandidate__values">
                          <span>{formatCount(candidate.votes)} votes</span>
                          <span>{formatPct(candidate.votePct)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
