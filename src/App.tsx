import { useCallback, useEffect, useMemo, useState } from "react";
import { addFinanceReport, fetchCounties, fetchCycles, fetchMetricContest, fetchRaces, saveCandidateConsultants } from "./api";
import { AdminDataPanel } from "./components/AdminData";
import { AdminUsersPanel } from "./components/AdminUsers";
import { CandidateDetailModal, CandidateSummary } from "./components/CandidateDetailModal";
import { CandidateConsultantEditor, FinanceHistoryEditor, LatestFinanceDisplay } from "./components/CandidateFinance";
import { CountyHeatmap, RaceMetrics } from "./components/CountyHeatmap";
import { MetricContestModal } from "./components/MetricContestModal";
import { PendingSaveBar } from "./components/PendingSaveBar";
import { candidateKey, setFilingPeriods } from "./lib/finance";
import { isBenchmarkMetricKey, metricFieldsForCategory } from "./lib/metrics";
import {
  matchesOrganizationFilter,
  matchesConsultantFilter,
  matchesOpenSeatFilter,
  matchesUpForReelectionFilter,
  isUpForReelectionRelevant,
  isOfficeFlagTrue,
  matchesSeatHolderFilter,
  matchesTrumpSwingFilter,
  raceSeatHolder,
  raceCurrentHolderLabel,
  raceGopCandidateLabel,
  raceRunningForReelectionLabel,
  HOUSE_TARGET_FILTER_OPTIONS,
  type SeatHolderFilter,
} from "./lib/raceFilters";
import { useAuth } from "./lib/auth";
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

function partyBadgeClass(party: string | null | undefined) {
  if (party === "R") return "party-badge party-badge-r";
  if (party === "D") return "party-badge party-badge-d";
  return null;
}

function raceListLabel(race: Race, tab: OfficeCategory) {
  if (tab === "statewide") return race.office_name;
  if (race.district != null) return `District ${race.district}`;
  return race.office_code;
}

function raceDetailTitle(race: Race) {
  return `${race.office_code} — ${race.office_name}`;
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

function updateCandidateConsultants(
  races: Race[],
  officeId: number,
  candidateKeyValue: string,
  consultants: RaceCandidate["consultants"],
  consultantKeys: string[],
  consultantLabel: string | null
): Race[] {
  return races.map((race) => {
    if (race.office_id !== officeId) return race;
    return {
      ...race,
      candidates: race.candidates.map((candidate) => {
        if (candidateKey(candidate) !== candidateKeyValue) return candidate;
        return {
          ...candidate,
          consultants: consultants ?? [],
          consultant_keys: consultantKeys,
          consultant: consultantLabel,
        };
      }),
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
  const { permissions, user, logout } = useAuth();
  const currentYear = new Date().getFullYear();
  const [tab, setTab] = useState<AppTab>("house");
  const [countyElection, setCountyElection] = useState<CountyElection>("pres_2024");
  const [cycleYear, setCycleYear] = useState(2026);
  const [cycles, setCycles] = useState<number[]>(() => [...new Set([2026, currentYear])]);
  const [races, setRaces] = useState<Race[]>([]);
  const [counties, setCounties] = useState<Awaited<ReturnType<typeof fetchCounties>>["counties"]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [seatHolderFilter, setSeatHolderFilter] = useState<SeatHolderFilter>("all");
  const [trumpSwingFilter, setTrumpSwingFilter] = useState(false);
  const [openSeatFilter, setOpenSeatFilter] = useState(false);
  const [upForReelectionOnly, setUpForReelectionOnly] = useState(true);
  const [organizationFilter, setOrganizationFilter] = useState<string[]>([]);
  const [consultantFilter, setConsultantFilter] = useState<string[]>([]);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [showCoh, setShowCoh] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [pendingConsultantEdits, setPendingConsultantEdits] = useState<Record<string, string[]>>({});
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

  const effectiveEditMode = editMode && permissions.canEdit;

  useEffect(() => {
    if (tab === "data" && !permissions.canAccessData) setTab("house");
    if (tab === "admin" && !permissions.canManageUsers) setTab("house");
  }, [tab, permissions.canAccessData, permissions.canManageUsers]);

  useEffect(() => {
    if (!permissions.canEdit && editMode) setEditMode(false);
  }, [permissions.canEdit, editMode]);

  const loadRaces = useCallback(async () => {
    if (tab === "counties" || tab === "data" || tab === "admin") return;
    setLoading(true);
    setError("");
    try {
      const data = await fetchRaces(tab, cycleYear);
      if (data.filing_periods?.length) setFilingPeriods(data.filing_periods);
      const nextRaces = (data.races ?? []).map((race) => ({
        ...race,
        up_for_reelection: isOfficeFlagTrue(race.up_for_reelection),
      }));
      setRaces(nextRaces);
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
    setSeatHolderFilter("all");
    setTrumpSwingFilter(false);
    setOpenSeatFilter(false);
    setOrganizationFilter([]);
    setConsultantFilter([]);
    setShowMoreFilters(false);
    if (tab === "counties") {
      void loadCounties();
    } else if (tab === "data" || tab === "admin") {
      setLoading(false);
    } else {
      setRaces([]);
      void loadRaces();
    }
  }, [loadRaces, loadCounties, tab, cycleYear]);

  const handleUpForReelectionOnlyChange = useCallback((upOnly: boolean) => {
    setUpForReelectionOnly(upOnly);
  }, []);

  const filteredRaces = useMemo(() => {
    if (tab === "counties" || tab === "data" || tab === "admin") return [];
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

      if (!matchesSeatHolderFilter(race, seatHolderFilter)) return false;
      if (!matchesTrumpSwingFilter(race, trumpSwingFilter)) return false;
      if (!matchesOpenSeatFilter(race, openSeatFilter)) return false;
      if (!matchesUpForReelectionFilter(race, tab as OfficeCategory, upForReelectionOnly)) return false;
      if (!matchesOrganizationFilter(race, organizationFilter)) return false;
      if (!matchesConsultantFilter(race, consultantFilter)) return false;

      return true;
    });
  }, [races, filter, tab, seatHolderFilter, trumpSwingFilter, openSeatFilter, upForReelectionOnly, organizationFilter, consultantFilter]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filter.trim()) count += 1;
    if (seatHolderFilter !== "all") count += 1;
    if (trumpSwingFilter) count += 1;
    if (openSeatFilter) count += 1;
    if (isUpForReelectionRelevant(tab as OfficeCategory) && upForReelectionOnly) count += 1;
    if (organizationFilter.length > 0) count += 1;
    if (consultantFilter.length > 0) count += 1;
    return count;
  }, [filter, seatHolderFilter, trumpSwingFilter, openSeatFilter, tab, upForReelectionOnly, organizationFilter, consultantFilter]);

  useEffect(() => {
    if (tab === "counties" || tab === "data" || tab === "admin") return;
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
    selectedRace && tab !== "counties" && tab !== "data" && tab !== "admin"
      ? mergeRaceMetrics(selectedRace, tab as OfficeCategory)
      : [];
  const countyTitle = COUNTY_ELECTIONS.find((e) => e.id === countyElection)?.label ?? "County results";

  useEffect(() => {
    setPendingConsultantEdits({});
    setPendingCohAdds([]);
    setRaceSaved(false);
    setSaveError("");
  }, [selectedOfficeId, effectiveEditMode, cycleYear, tab]);

  useEffect(() => {
    if (!raceSaved) return;
    const timer = window.setTimeout(() => setRaceSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [raceSaved]);

  const hasPendingRaceEdits =
    Object.keys(pendingConsultantEdits).length > 0 || pendingCohAdds.length > 0;

  const handlePendingConsultantChange = useCallback((candidateKeyValue: string, keys: string[] | undefined) => {
    setPendingConsultantEdits((prev) => {
      const next = { ...prev };
      if (keys === undefined) delete next[candidateKeyValue];
      else next[candidateKeyValue] = keys;
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
    setPendingConsultantEdits({});
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

      for (const [candidateKeyValue, consultantKeys] of Object.entries(pendingConsultantEdits)) {
        const candidate = selectedRace.candidates.find((item) => candidateKey(item) === candidateKeyValue);
        if (!candidate?.candidate_id) continue;
        tasks.push(
          saveCandidateConsultants(candidate.candidate_id, consultantKeys).then((result) => {
            setRaces((prev) =>
              updateCandidateConsultants(
                prev,
                selectedRace.office_id,
                candidateKeyValue,
                result.consultants,
                result.consultant_keys,
                result.consultant
              )
            );
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
      setPendingConsultantEdits({});
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
    if (!selectedOfficeId || effectiveEditMode || isBenchmarkMetricKey(metric.key)) return;
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
  }, [selectedOfficeId, effectiveEditMode]);

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
          {permissions.canEdit ? (
            <label className="toggle">
              <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} />
              Edit mode
            </label>
          ) : null}
          {tab !== "counties" && tab !== "data" && tab !== "admin" ? (
            <label className="toggle">
              <input type="checkbox" checked={showCoh} onChange={(e) => setShowCoh(e.target.checked)} />
              Show finance
            </label>
          ) : null}
          {tab !== "counties" && tab !== "admin" ? (
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
          {user ? (
            <div className="header-user-row">
              <span className="header-user">{user.display_name}</span>
              <button type="button" className="header-logout" onClick={() => void logout()}>
                Log out
              </button>
            </div>
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
        {permissions.canAccessData ? (
          <button
            type="button"
            className={tab === "data" ? "tab active" : "tab"}
            onClick={() => setTab("data")}
          >
            Data
          </button>
        ) : null}
        {permissions.canManageUsers ? (
          <button
            type="button"
            className={tab === "admin" ? "tab active" : "tab"}
            onClick={() => setTab("admin")}
          >
            Admin
          </button>
        ) : null}
      </nav>

      {error ? <div className="banner error">{error}</div> : null}
      {saveError ? <div className="banner error">{saveError}</div> : null}

      {loading && tab !== "data" && tab !== "admin" ? (
        <p className="loading">Loading…</p>
      ) : tab === "data" ? (
        <AdminDataPanel cycleYear={cycleYear} editMode={effectiveEditMode} />
      ) : tab === "admin" ? (
        <AdminUsersPanel />
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
            editMode={effectiveEditMode}
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
            <button
              type="button"
              className="race-filters-toggle"
              aria-expanded={filtersExpanded}
              onClick={() => setFiltersExpanded((open) => !open)}
            >
              <span>{filtersExpanded ? "Hide filters" : "Show filters"}</span>
              {activeFilterCount > 0 ? (
                <span className="race-filters-toggle-count">{activeFilterCount} active</span>
              ) : null}
            </button>
            {filtersExpanded ? (
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

                {isUpForReelectionRelevant(tab as OfficeCategory) ? (
                  <div className="filter-group">
                    <span className="filter-label">Up for reelection</span>
                    <div className="filter-chips">
                      <button
                        type="button"
                        className={!upForReelectionOnly ? "filter-chip active" : "filter-chip"}
                        onClick={() => handleUpForReelectionOnlyChange(false)}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        className={upForReelectionOnly ? "filter-chip active" : "filter-chip"}
                        onClick={() => handleUpForReelectionOnlyChange(true)}
                        title="Offices marked up for reelection on the Data tab"
                      >
                        Up only
                      </button>
                    </div>
                  </div>
                ) : null}

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

                {tab === "house" ? (
                  <div className="filter-group">
                    <span className="filter-label">Targets</span>
                    <div className="filter-chips">
                      <button
                        type="button"
                        className={organizationFilter.length === 0 ? "filter-chip active" : "filter-chip"}
                        onClick={() => setOrganizationFilter([])}
                      >
                        All
                      </button>
                      {HOUSE_TARGET_FILTER_OPTIONS.map((option) => (
                        <button
                          key={option.orgKey}
                          type="button"
                          className={
                            organizationFilter.includes(option.orgKey) ? "filter-chip active" : "filter-chip"
                          }
                          onClick={() => toggleOrganizationFilter(option.orgKey)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

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
            ) : null}
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
                        {holder?.party && partyBadgeClass(holder.party) ? (
                          <span className={partyBadgeClass(holder.party)!}>{partyLabel(holder.party)}</span>
                        ) : null}
                      </span>
                      <span className="race-item-meta">
                        Incumbent: {raceCurrentHolderLabel(race)} | GOP Candidate: {raceGopCandidateLabel(race)}
                      </span>
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

                {(() => {
                  const holder = raceSeatHolder(selectedRace);
                  const holderParty = holder?.party ?? null;
                  const holderPartyBadge = holderParty ? partyBadgeClass(holderParty) : null;
                  return (
                    <div className="race-seat-holder-block">
                      <h3 className="race-seat-holder-heading">Current office holder</h3>
                      <div className="race-seat-holder-row">
                        <span className="race-seat-holder-name">{raceCurrentHolderLabel(selectedRace)}</span>
                        {holderPartyBadge && holderParty ? (
                          <span className={holderPartyBadge}>{partyLabel(holderParty)}</span>
                        ) : null}
                        <span className="race-seat-holder-reelection">
                          <span className="race-seat-holder-reelection-label">Running for re-election</span>
                          <span className="race-seat-holder-reelection-value">
                            {raceRunningForReelectionLabel(selectedRace)}
                          </span>
                        </span>
                      </div>
                    </div>
                  );
                })()}

                <RaceMetrics
                  metrics={selectedMetrics}
                  category={tab}
                  editMode={effectiveEditMode}
                  onMetricClick={(metric) => void handleMetricClick(metric)}
                />

                {effectiveEditMode && (hasPendingRaceEdits || raceSaved) ? (
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
                  {selectedRace.candidates.length === 0 ? (
                    <li className="candidate-list-empty">No candidates filed for this office yet.</li>
                  ) : null}
                  {selectedRace.candidates.map((candidate) => {
                    const key = candidateKey(candidate);
                    return (
                      <li
                        key={key}
                        className={`candidate-item party-${candidate.party.toLowerCase()}${effectiveEditMode ? "" : " candidate-item-clickable"}`}
                      >
                        {effectiveEditMode ? (
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
                            <CandidateConsultantEditor
                              candidate={candidate}
                              consultants={consultants}
                              value={pendingConsultantEdits[key]}
                              onChange={(keys) => handlePendingConsultantChange(key, keys)}
                            />
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
