import { useCallback, useEffect, useMemo, useState } from "react";
import { addFinanceReport, fetchCounties, fetchCycles, fetchMetricContest, fetchRaces, saveOfficeMetric } from "./api";
import { AdminDataPanel } from "./components/AdminData";
import { CandidateDetailModal, CandidateSummary } from "./components/CandidateDetailModal";
import { FinanceHistoryEditor, LatestFinanceDisplay } from "./components/CandidateFinance";
import { CountyHeatmap, RaceMetrics } from "./components/CountyHeatmap";
import { MetricContestModal } from "./components/MetricContestModal";
import { PendingSaveBar } from "./components/PendingSaveBar";
import { candidateKey, setFilingPeriods } from "./lib/finance";
import { isBenchmarkMetricKey, metricFieldsForCategory } from "./lib/metrics";
import {
  matchesOrganizationFilter,
  matchesConsultantFilter,
  matchesOpenSeatFilter,
  matchesSeatHolderFilter,
  matchesTrumpSwingFilter,
  raceHasSeatHolder,
  raceSeatHolder,
  type SeatHolderFilter,
} from "./lib/raceFilters";
import type {
  AppTab,
  Consultant,
  CountyElection,
  CountyResult,
  FinanceReportEntry,
  MetricContest,
  OfficeCategory,
  PendingFinanceEntry,
  Race,
  RaceCandidate,
  RaceMetric,
  TargetingOrganization,
} from "./types";

const RACE_TABS: { id: OfficeCategory; label: string }[] = [
  { id: "house", label: "Texas House" },
  { id: "senate", label: "Texas Senate" },
  { id: "sboe", label: "SBOE" },
  { id: "statewide", label: "Statewide" },
  { id: "congressional", label: "Congressional" },
];

const COUNTY_ELECTIONS: { id: CountyElection; label: string }[] = [
  { id: "pres_2024", label: "2024 President" },
  { id: "cruz_2024", label: "2024 Cruz" },
  { id: "abbott_2022", label: "2022 Abbott" },
];

function partyLabel(party: string) {
  if (party === "R") return "GOP";
  if (party === "D") return "DEM";
  return party;
}

function raceListLabel(race: Race, tab: OfficeCategory) {
  if (tab === "statewide") return race.office_name;
  if (race.district != null) return `District ${race.district}`;
  return race.office_code;
}

function raceDetailTitle(race: Race) {
  return `${race.office_code} — ${race.office_name}`;
}

function raceHasIncumbent(race: Race) {
  return raceHasSeatHolder(race);
}

function mergeRaceMetrics(race: Race, tab: OfficeCategory): RaceMetric[] {
  const byKey = new Map((race.metrics ?? []).map((m) => [m.key, m]));
  return metricFieldsForCategory(tab).map((field) => {
    const existing = byKey.get(field.key);
    return {
      key: field.key,
      label: field.label,
      value: existing?.value ?? null,
      uncontested: existing?.uncontested,
      winning_party: existing?.winning_party,
    };
  });
}

function updateRaceMetric(races: Race[], officeId: number, key: string, value: number | null): Race[] {
  return races.map((race) => {
    if (race.office_id !== officeId) return race;
    return {
      ...race,
      metrics: (race.metrics ?? []).map((m) => (m.key === key ? { ...m, value } : m)),
    };
  });
}

function updateCandidateFinanceHistory(
  races: Race[],
  officeId: number,
  candidateKeyValue: string,
  entry: FinanceReportEntry
): Race[] {
  return races.map((race) => {
    if (race.office_id !== officeId) return race;
    return {
      ...race,
      candidates: race.candidates.map((candidate) => {
        if (candidateKey(candidate) !== candidateKeyValue) return candidate;
        const history = [...(candidate.finance_history ?? [])];
        if (!history.some((item) => item.id === entry.id)) history.unshift(entry);
        return { ...candidate, finance_history: history };
      }),
    };
  });
}

export default function App() {
  const currentYear = new Date().getFullYear();
  const [tab, setTab] = useState<AppTab>("house");
  const [countyElection, setCountyElection] = useState<CountyElection>("pres_2024");
  const [cycleYear, setCycleYear] = useState(2026);
  const [cycles, setCycles] = useState<number[]>(() => [...new Set([2026, currentYear])]);
  const [races, setRaces] = useState<Race[]>([]);
  const [counties, setCounties] = useState<Awaited<ReturnType<typeof fetchCounties>>["counties"]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [incumbentFilter, setIncumbentFilter] = useState<"all" | "incumbent" | "non-incumbent">("all");
  const [seatHolderFilter, setSeatHolderFilter] = useState<SeatHolderFilter>("all");
  const [trumpSwingFilter, setTrumpSwingFilter] = useState(false);
  const [openSeatFilter, setOpenSeatFilter] = useState(false);
  const [organizationFilter, setOrganizationFilter] = useState<string[]>([]);
  const [consultantFilter, setConsultantFilter] = useState<string[]>([]);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [targetingOrgs, setTargetingOrgs] = useState<TargetingOrganization[]>([]);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [showCoh, setShowCoh] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [pendingMetrics, setPendingMetrics] = useState<Record<string, number | null>>({});
  const [pendingCohAdds, setPendingCohAdds] = useState<PendingFinanceEntry[]>([]);
  const [raceSaving, setRaceSaving] = useState(false);
  const [raceSaved, setRaceSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [contestModal, setContestModal] = useState<MetricContest | null>(null);
  const [candidateDetail, setCandidateDetail] = useState<RaceCandidate | null>(null);
  const [contestLoading, setContestLoading] = useState(false);
  const [contestError, setContestError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadRaces = useCallback(async () => {
    if (tab === "counties" || tab === "data") return;
    setLoading(true);
    setError("");
    try {
      const data = await fetchRaces(tab, cycleYear);
      if (data.filing_periods?.length) setFilingPeriods(data.filing_periods);
      const nextRaces = data.races ?? [];
      setRaces(nextRaces);
      setTargetingOrgs(data.targeting_organizations ?? []);
      setConsultants(data.consultants ?? []);
      setSelectedOfficeId((prev) => {
        if (prev && nextRaces.some((race) => race.office_id === prev)) return prev;
        return nextRaces[0]?.office_id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setRaces([]);
      setSelectedOfficeId(null);
    } finally {
      setLoading(false);
    }
  }, [tab, cycleYear]);

  const loadCounties = useCallback(async () => {
    if (tab !== "counties") return;
    setLoading(true);
    setError("");
    try {
      const data = await fetchCounties(countyElection);
      setCounties(data.counties ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load counties");
      setCounties([]);
    } finally {
      setLoading(false);
    }
  }, [tab, countyElection]);

  useEffect(() => {
    void fetchCycles().then((years) => {
      setCycles([...new Set(years)]);
    });
  }, []);

  useEffect(() => {
    setFilter("");
    setIncumbentFilter("all");
    setSeatHolderFilter("all");
    setTrumpSwingFilter(false);
    setOrganizationFilter([]);
    setConsultantFilter([]);
    setShowMoreFilters(false);
    if (tab === "counties") {
      void loadCounties();
    } else if (tab === "data") {
      setLoading(false);
    } else {
      void loadRaces();
    }
  }, [loadRaces, loadCounties, tab, cycleYear]);

  const filteredRaces = useMemo(() => {
    if (tab === "counties" || tab === "data") return [];
    return races.filter((race) => {
      const query = filter.trim().toLowerCase();
      if (query) {
        const label = raceListLabel(race, tab as OfficeCategory).toLowerCase();
        const matchesSearch =
          label.includes(query) ||
          race.office_code.toLowerCase().includes(query) ||
          race.office_name.toLowerCase().includes(query) ||
          race.candidates.some((c) => c.name.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      if (incumbentFilter === "incumbent" && !raceHasIncumbent(race)) return false;
      if (incumbentFilter === "non-incumbent" && raceHasIncumbent(race)) return false;
      if (!matchesSeatHolderFilter(race, seatHolderFilter)) return false;
      if (!matchesTrumpSwingFilter(race, trumpSwingFilter)) return false;
      if (!matchesOpenSeatFilter(race, openSeatFilter)) return false;
      if (!matchesOrganizationFilter(race, organizationFilter)) return false;
      if (!matchesConsultantFilter(race, consultantFilter)) return false;

      return true;
    });
  }, [races, filter, tab, incumbentFilter, seatHolderFilter, trumpSwingFilter, openSeatFilter, organizationFilter, consultantFilter]);

  useEffect(() => {
    if (tab === "counties" || tab === "data") return;
    if (filteredRaces.length === 0) {
      setSelectedOfficeId(null);
      return;
    }
    if (!filteredRaces.some((race) => race.office_id === selectedOfficeId)) {
      setSelectedOfficeId(filteredRaces[0].office_id);
    }
  }, [filteredRaces, selectedOfficeId, tab]);

  const selectedRace = filteredRaces.find((race) => race.office_id === selectedOfficeId) ?? null;
  const selectedMetrics =
    selectedRace && tab !== "counties" && tab !== "data"
      ? mergeRaceMetrics(selectedRace, tab as OfficeCategory)
      : [];
  const countyTitle = COUNTY_ELECTIONS.find((e) => e.id === countyElection)?.label ?? "County results";

  useEffect(() => {
    setPendingMetrics({});
    setPendingCohAdds([]);
    setRaceSaved(false);
    setSaveError("");
  }, [selectedOfficeId, editMode, cycleYear, tab]);

  useEffect(() => {
    if (!raceSaved) return;
    const timer = window.setTimeout(() => setRaceSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [raceSaved]);

  const hasPendingRaceEdits =
    Object.keys(pendingMetrics).length > 0 || pendingCohAdds.length > 0;

  const handlePendingMetricChange = useCallback((key: string, value: number | null | undefined) => {
    setPendingMetrics((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
    setRaceSaved(false);
    setSaveError("");
  }, []);

  function addPendingFinance(entry: PendingFinanceEntry) {
    setPendingCohAdds((prev) => [...prev, entry]);
    setRaceSaved(false);
    setSaveError("");
  }

  function removePendingFinance(localId: string) {
    setPendingCohAdds((prev) => prev.filter((entry) => entry.localId !== localId));
    setRaceSaved(false);
    setSaveError("");
  }

  function toggleOrganizationFilter(orgKey: string) {
    setOrganizationFilter((prev) =>
      prev.includes(orgKey) ? prev.filter((key) => key !== orgKey) : [...prev, orgKey]
    );
  }

  function toggleConsultantFilter(consultantKey: string) {
    setConsultantFilter((prev) =>
      prev.includes(consultantKey) ? prev.filter((key) => key !== consultantKey) : [...prev, consultantKey]
    );
  }

  function discardRaceEdits() {
    setPendingMetrics({});
    setPendingCohAdds([]);
    setSaveError("");
    setRaceSaved(false);
  }

  async function handleRaceSave() {
    if (!selectedRace || !hasPendingRaceEdits) return;
    setRaceSaving(true);
    setSaveError("");
    try {
      const tasks: Promise<void>[] = [];

      for (const [key, value] of Object.entries(pendingMetrics)) {
        if (!isBenchmarkMetricKey(key)) continue;
        tasks.push(
          saveOfficeMetric(selectedRace.office_id, key, value).then(() => {
            setRaces((prev) => updateRaceMetric(prev, selectedRace.office_id, key, value));
          })
        );
      }

      for (const pending of pendingCohAdds) {
        const candidate = selectedRace.candidates.find((item) => candidateKey(item) === pending.candidateKey);
        if (!candidate) continue;
        tasks.push(
          addFinanceReport({
            candidateId: candidate.candidate_id,
            officeId: selectedRace.office_id,
            cycleYear,
            candidateName: candidate.name,
            party: candidate.party,
            isIncumbent: candidate.is_incumbent,
            period_key: pending.period_key,
            period_label: pending.period_label,
            report_period_end: pending.report_period_end,
            contributions: pending.contributions,
            expenditures: pending.expenditures,
            cash_on_hand: pending.cash_on_hand,
          }).then(({ entry }) => {
            setRaces((prev) =>
              updateCandidateFinanceHistory(prev, selectedRace.office_id, pending.candidateKey, entry)
            );
          })
        );
      }

      await Promise.all(tasks);
      setPendingMetrics({});
      setPendingCohAdds([]);
      setRaceSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setRaceSaving(false);
    }
  }

  const handleCountySaved = useCallback((county: CountyResult) => {
    setCounties((prev) => prev.map((c) => (c.county_key === county.county_key ? county : c)));
    setSaveError("");
  }, []);

  const handleMetricClick = useCallback(async (metric: RaceMetric) => {
    if (!selectedOfficeId || editMode || isBenchmarkMetricKey(metric.key)) return;
    setContestModal(null);
    setContestError("");
    setContestLoading(true);
    try {
      const contest = await fetchMetricContest(selectedOfficeId, metric.key);
      setContestModal(contest);
    } catch (err) {
      setContestError(err instanceof Error ? err.message : "Failed to load contest");
    } finally {
      setContestLoading(false);
    }
  }, [selectedOfficeId, editMode]);

  function closeContestModal() {
    setContestModal(null);
    setContestError("");
    setContestLoading(false);
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Texas Candidate Lookup</h1>
          <p className="subtitle">Select a race to view candidates, results, and campaign finance</p>
        </div>
        <div className="header-controls">
          <label className="toggle">
            <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} />
            Edit mode
          </label>
          {tab !== "counties" && tab !== "data" ? (
            <label className="toggle">
              <input type="checkbox" checked={showCoh} onChange={(e) => setShowCoh(e.target.checked)} />
              Show finance
            </label>
          ) : null}
          {tab !== "counties" ? (
            <label className="year-picker">
              Cycle year
              <select value={cycleYear} onChange={(e) => setCycleYear(Number(e.target.value))}>
                {cycles.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {RACE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "tab active" : "tab"}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className={tab === "counties" ? "tab active" : "tab"}
          onClick={() => setTab("counties")}
        >
          Counties
        </button>
        <button
          type="button"
          className={tab === "data" ? "tab active" : "tab"}
          onClick={() => setTab("data")}
        >
          Data
        </button>
      </nav>

      {error ? <div className="banner error">{error}</div> : null}
      {saveError ? <div className="banner error">{saveError}</div> : null}

      {loading && tab !== "data" ? (
        <p className="loading">Loading…</p>
      ) : tab === "data" ? (
        <AdminDataPanel cycleYear={cycleYear} editMode={editMode} />
      ) : tab === "counties" ? (
        <div className="counties-panel">
          <div className="county-election-tabs">
            {COUNTY_ELECTIONS.map((election) => (
              <button
                key={election.id}
                type="button"
                className={countyElection === election.id ? "filter-chip active" : "filter-chip"}
                onClick={() => setCountyElection(election.id)}
              >
                {election.label}
              </button>
            ))}
          </div>
          <CountyHeatmap
            counties={counties}
            title={countyTitle}
            editMode={editMode}
            election={countyElection}
            onCountySaved={handleCountySaved}
          />
        </div>
      ) : races.length === 0 ? (
        <p className="loading">
          No races for {cycleYear}. Run <code>npm run db:import</code> with your Excel file.
        </p>
      ) : (
        <div className="race-layout">
          <aside className="race-list-panel">
            <input
              className="race-search"
              type="search"
              placeholder="Search district, office, or candidate…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="race-filters-scroll">
              <div className="race-filters">
                <div className="filter-group">
                  <span className="filter-label">Seat held by</span>
                  <div className="filter-chips">
                    {(
                      [
                        { id: "all", label: "All" },
                        { id: "gop", label: "GOP" },
                        { id: "dem", label: "DEM" },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={seatHolderFilter === option.id ? "filter-chip active" : "filter-chip"}
                        onClick={() => setSeatHolderFilter(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="filter-group">
                  <span className="filter-label">Current seat holder</span>
                  <div className="filter-chips">
                    {(
                      [
                        { id: "all", label: "All" },
                        { id: "incumbent", label: "Listed" },
                        { id: "non-incumbent", label: "Not listed" },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={incumbentFilter === option.id ? "filter-chip active" : "filter-chip"}
                        onClick={() => setIncumbentFilter(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="filter-group">
                  <span className="filter-label">Open seat</span>
                  <div className="filter-chips">
                    <button
                      type="button"
                      className={!openSeatFilter ? "filter-chip active" : "filter-chip"}
                      onClick={() => setOpenSeatFilter(false)}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className={openSeatFilter ? "filter-chip active" : "filter-chip"}
                      onClick={() => setOpenSeatFilter(true)}
                      title="Races where the incumbent is not on the November ballot"
                    >
                      Open only
                    </button>
                  </div>
                </div>

                <div className="filter-group">
                  <span className="filter-label">2024 Trump margin</span>
                  <div className="filter-chips">
                    <button
                      type="button"
                      className={!trumpSwingFilter ? "filter-chip active" : "filter-chip"}
                      onClick={() => setTrumpSwingFilter(false)}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className={trumpSwingFilter ? "filter-chip active" : "filter-chip"}
                      onClick={() => setTrumpSwingFilter(true)}
                      title="Races where 2024 Trump margin is within ±10 points"
                    >
                      ±10 pts
                    </button>
                  </div>
                </div>

                <div className="filter-group">
                  <button
                    type="button"
                    className={showMoreFilters ? "filter-chip active" : "filter-chip"}
                    onClick={() => setShowMoreFilters((open) => !open)}
                  >
                    More filters
                  </button>
                </div>

                {showMoreFilters ? (
                  <>
                    {targetingOrgs.length > 0 ? (
                      <div className="filter-group">
                        <span className="filter-label">Targets</span>
                        <div className="filter-checklist">
                          {targetingOrgs.map((org) => {
                            const checked = organizationFilter.includes(org.org_key);
                            return (
                              <label key={org.org_key} className="filter-check-item">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleOrganizationFilter(org.org_key)}
                                />
                                <span>{org.name}</span>
                              </label>
                            );
                          })}
                        </div>
                        {organizationFilter.length > 0 ? (
                          <button
                            type="button"
                            className="filter-clear-link"
                            onClick={() => setOrganizationFilter([])}
                          >
                            Clear targets
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <p className="filter-hint">
                        Add targeting organizations in the <strong>Data</strong> tab, then assign them on the{" "}
                        <strong>Offices</strong> table.
                      </p>
                    )}

                    {consultants.length > 0 ? (
                      <div className="filter-group">
                        <span className="filter-label">Consultant</span>
                        <div className="filter-checklist">
                          {consultants.map((consultant) => {
                            const checked = consultantFilter.includes(consultant.consultant_key);
                            return (
                              <label key={consultant.consultant_key} className="filter-check-item">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleConsultantFilter(consultant.consultant_key)}
                                />
                                <span>
                                  {consultant.name}
                                  {consultant.candidate_count != null ? ` (${consultant.candidate_count})` : ""}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        {consultantFilter.length > 0 ? (
                          <button
                            type="button"
                            className="filter-clear-link"
                            onClick={() => setConsultantFilter([])}
                          >
                            Clear consultants
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <p className="filter-hint">
                        Add consultants in the <strong>Data</strong> tab, then assign them on the{" "}
                        <strong>Candidates</strong> table.
                      </p>
                    )}
                  </>
                ) : null}
              </div>
            </div>
            <ul className="race-list" role="listbox" aria-label="Races">
              {filteredRaces.map((race) => {
                const selected = race.office_id === selectedOfficeId;
                const holder = raceSeatHolder(race);
                return (
                  <li key={race.office_id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={selected ? "race-item selected" : "race-item"}
                      onClick={() => setSelectedOfficeId(race.office_id)}
                    >
                      <span className="race-item-label">
                        {raceListLabel(race, tab as OfficeCategory)}
                        {race.is_open ? <span className="open-badge">Open</span> : null}
                      </span>
                      {holder ? (
                        <span
                          className={
                            holder.party
                              ? `race-item-meta party-text-${holder.party.toLowerCase()}`
                              : "race-item-meta"
                          }
                        >
                          {holder.name}
                          {holder.party ? ` · ${partyLabel(holder.party)}` : ""}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {filteredRaces.length === 0 ? (
              <p className="race-list-empty">No races match your filters.</p>
            ) : null}
          </aside>

          <section className="race-detail-panel">
            {selectedRace ? (
              <>
                <header className="race-detail-header">
                  <h2>{raceDetailTitle(selectedRace)}</h2>
                </header>

                <RaceMetrics
                  metrics={selectedMetrics}
                  category={tab}
                  editMode={editMode}
                  onPendingMetricChange={handlePendingMetricChange}
                  onMetricClick={(metric) => void handleMetricClick(metric)}
                />

                {editMode && (hasPendingRaceEdits || raceSaved) ? (
                  <PendingSaveBar
                    visible={hasPendingRaceEdits}
                    saving={raceSaving}
                    saved={raceSaved}
                    error={saveError}
                    onSave={() => void handleRaceSave()}
                    onDiscard={discardRaceEdits}
                  />
                ) : null}

                <ul className="candidate-list">
                  {selectedRace.candidates.map((candidate) => {
                    const key = candidateKey(candidate);
                    return (
                      <li
                        key={key}
                        className={`candidate-item party-${candidate.party.toLowerCase()}${editMode ? "" : " candidate-item-clickable"}`}
                      >
                        {editMode ? (
                          <>
                            <div className="candidate-main">
                              <span className="candidate-name-row">
                                <span className="candidate-name">{candidate.name}</span>
                                {candidate.is_incumbent ? (
                                  <span className="incumbent-badge">Incumbent</span>
                                ) : null}
                              </span>
                              <span className="candidate-party">{partyLabel(candidate.party)}</span>
                            </div>
                            <CandidateSummary candidate={candidate} />
                            <div className="candidate-finance candidate-finance-edit">
                              <strong className="coh-section-title">Finance reports</strong>
                              <FinanceHistoryEditor
                                candidate={candidate}
                                pendingAdds={pendingCohAdds}
                                onAddPending={addPendingFinance}
                                onRemovePending={removePendingFinance}
                              />
                            </div>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="candidate-item-button"
                            onClick={() => setCandidateDetail(candidate)}
                            title="View candidate details"
                          >
                            <div className="candidate-main">
                              <span className="candidate-name-row">
                                <span className="candidate-name">{candidate.name}</span>
                                {candidate.is_incumbent ? (
                                  <span className="incumbent-badge">Incumbent</span>
                                ) : null}
                              </span>
                              <span className="candidate-party">{partyLabel(candidate.party)}</span>
                            </div>
                            <CandidateSummary candidate={candidate} />
                            {showCoh ? (
                              <div className="candidate-finance">
                                <LatestFinanceDisplay candidate={candidate} />
                              </div>
                            ) : null}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="loading">Select a race from the list.</p>
            )}
          </section>
        </div>
      )}

      <MetricContestModal
        contest={contestModal}
        loading={contestLoading}
        error={contestError}
        onClose={closeContestModal}
      />

      <CandidateDetailModal
        candidate={candidateDetail}
        officeCode={selectedRace?.office_code ?? ""}
        onClose={() => setCandidateDetail(null)}
      />
    </div>
  );
}
