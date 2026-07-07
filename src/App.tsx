import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addFinanceReport, fetchCounties, fetchMetricContest, fetchRaces, fetchStafferMap, saveCandidateConsultants } from "./api";
import { AdminDataPanel } from "./components/AdminData";
import { AdminUsersPanel } from "./components/AdminUsers";
import { CandidateDetailModal, CandidateSummary } from "./components/CandidateDetailModal";
import { CandidateConsultantEditor, FinanceHistoryEditor, LatestFinanceDisplay } from "./components/CandidateFinance";
import { CountyHeatmap, RaceMetrics } from "./components/CountyHeatmap";
import { MetricContestModal } from "./components/MetricContestModal";
import { StafferMap } from "./components/StafferMap";
import { PendingSaveBar } from "./components/PendingSaveBar";
import { loadRaceLayoutPrefs, saveRaceLayoutPrefs } from "./lib/raceLayoutPrefs";
import { loadAppTab, saveAppTab } from "./lib/appTabPrefs";
import {
  isRacesTab,
  loadCountiesTabFilters,
  loadInitialTabFilters,
  loadRaceTabFilters,
  saveCountiesTabFilters,
  saveRaceTabFilters,
  type RaceCategoryFilter,
  type RaceTabFilters,
} from "./lib/appTabFilters";
import { candidateKey, setFilingPeriods } from "./lib/finance";
import { isBenchmarkMetricKey, metricFieldsForCategory } from "./lib/metrics";
import {
  matchesOrganizationFilter,
  matchesConsultantFilter,
  normalizeConsultantFilterMode,
  matchesOpenSeatFilter,
  matchesUpForReelectionFilter,
  isOfficeFlagTrue,
  matchesSeatHolderFilter,
  matchesTrumpSwingFilter,
  raceSeatHolder,
  raceCurrentHolderLabel,
  raceGopCandidateLabel,
  raceRunningForReelectionLabel,
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
  StafferDistrictEntry,
  StafferMapEntry,
  TargetingOrganization,
} from "./types";

const RACE_CATEGORIES: OfficeCategory[] = ["house", "senate", "sboe", "statewide", "congressional"];

const RACE_CATEGORY_OPTIONS: { id: RaceCategoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "house", label: "Texas House" },
  { id: "senate", label: "Texas Senate" },
  { id: "sboe", label: "SBOE" },
  { id: "statewide", label: "Statewide" },
  { id: "congressional", label: "Congressional" },
];

const RACE_CATEGORY_LABELS: Record<OfficeCategory, string> = {
  house: "Texas House",
  senate: "Texas Senate",
  sboe: "SBOE",
  statewide: "Statewide",
  congressional: "Congressional",
};

const COUNTY_ELECTIONS: { id: CountyElection; label: string }[] = [
  { id: "pres_2024", label: "2024 President" },
  { id: "cruz_2024", label: "2024 Cruz" },
  { id: "abbott_2022", label: "2022 Abbott" },
];

function partyLabel(party: string) {
  if (party === "R") return "GOP";
  if (party === "D") return "DEM";
  if (party === "L") return "LIB";
  if (party === "G") return "GREEN";
  return party;
}

function partyBadgeClass(party: string | null | undefined) {
  if (party === "R") return "party-badge party-badge-r";
  if (party === "D") return "party-badge party-badge-d";
  if (party === "L") return "party-badge party-badge-l";
  if (party === "G") return "party-badge party-badge-g";
  return null;
}

function raceCategory(race: Race): OfficeCategory {
  return race.category ?? "house";
}

function raceListLabel(race: Race) {
  if (raceCategory(race) === "statewide") return race.office_name;
  if (race.district != null) return `District ${race.district}`;
  return race.office_code;
}

function raceDetailTitle(race: Race) {
  return `${race.office_code} — ${race.office_name}`;
}

function mergeRaceMetrics(race: Race, category: OfficeCategory): RaceMetric[] {
  const byKey = new Map((race.metrics ?? []).map((m) => [m.key, m]));
  return metricFieldsForCategory(category).map((field) => {
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

const INITIAL_TAB = loadAppTab();
const INITIAL_TAB_FILTERS = loadInitialTabFilters(INITIAL_TAB);

export default function App() {
  const { permissions, user, logout, guestAccess, promptLogin } = useAuth();
  const [tab, setTab] = useState<AppTab>(INITIAL_TAB);
  const [countyElection, setCountyElection] = useState(INITIAL_TAB_FILTERS.counties.countyElection);
  const [cycleYear] = useState(2026);
  const [races, setRaces] = useState<Race[]>([]);
  const [counties, setCounties] = useState<Awaited<ReturnType<typeof fetchCounties>>["counties"]>([]);
  const [stafferMap, setStafferMap] = useState<StafferMapEntry[]>([]);
  const [stafferDistrictMap, setStafferDistrictMap] = useState<StafferDistrictEntry[]>([]);
  const [stafferColorMap, setStafferColorMap] = useState<Record<string, string>>({});
  const [selectedOfficeId, setSelectedOfficeId] = useState<number | null>(
    INITIAL_TAB_FILTERS.race.selectedOfficeId
  );
  const [categoryFilter, setCategoryFilter] = useState<RaceCategoryFilter>(
    INITIAL_TAB_FILTERS.race.categoryFilter
  );
  const [filter, setFilter] = useState(INITIAL_TAB_FILTERS.race.filter);
  const [seatHolderFilter, setSeatHolderFilter] = useState<SeatHolderFilter>(
    INITIAL_TAB_FILTERS.race.seatHolderFilter
  );
  const [trumpSwingFilter, setTrumpSwingFilter] = useState(INITIAL_TAB_FILTERS.race.trumpSwingFilter);
  const [openSeatFilter, setOpenSeatFilter] = useState(INITIAL_TAB_FILTERS.race.openSeatFilter);
  const [upForReelectionOnly, setUpForReelectionOnly] = useState(INITIAL_TAB_FILTERS.race.upForReelectionOnly);
  const [organizationFilter, setOrganizationFilter] = useState<string[]>(
    INITIAL_TAB_FILTERS.race.organizationFilter
  );
  const [consultantFilter, setConsultantFilter] = useState<string[]>(INITIAL_TAB_FILTERS.race.consultantFilter);
  const [consultantFilterMode, setConsultantFilterMode] = useState<"all" | "select">(
    INITIAL_TAB_FILTERS.race.consultantFilterMode
  );
  const [filtersExpanded, setFiltersExpanded] = useState(INITIAL_TAB_FILTERS.race.filtersExpanded);
  const [navOpen, setNavOpen] = useState(false);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [targetingOrganizations, setTargetingOrganizations] = useState<TargetingOrganization[]>([]);
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
  const [listPanelWidth, setListPanelWidth] = useState(() => loadRaceLayoutPrefs().listPanelWidth);
  const [listPanelHeight, setListPanelHeight] = useState(() => loadRaceLayoutPrefs().listPanelHeight);
  const raceLayoutRef = useRef<HTMLDivElement>(null);
  const listPanelRef = useRef<HTMLElement>(null);
  const filtersScrollRef = useRef<HTMLDivElement>(null);
  const listPanelWidthRef = useRef(listPanelWidth);
  const listPanelHeightRef = useRef(listPanelHeight);
  const listPanelHeightBeforeFiltersRef = useRef<number | null>(null);
  const prevFiltersExpandedRef = useRef(filtersExpanded);

  useEffect(() => {
    listPanelWidthRef.current = listPanelWidth;
  }, [listPanelWidth]);

  useEffect(() => {
    listPanelHeightRef.current = listPanelHeight;
  }, [listPanelHeight]);

  const persistRaceLayoutPrefs = useCallback(() => {
    saveRaceLayoutPrefs({
      listPanelWidth: listPanelWidthRef.current,
      listPanelHeight: listPanelHeightRef.current,
    });
  }, []);

  const LIST_PANEL_MIN_WIDTH = 200;
  const LIST_PANEL_DETAIL_MIN = 240;
  const LIST_PANEL_FILTERS_MIN_WIDTH = 360;
  const LIST_PANEL_MIN_HEIGHT = 180;
  const LIST_PANEL_DETAIL_MIN_HEIGHT = 200;
  const LIST_PANEL_FILTERS_MIN_HEIGHT = 320;

  const isStackedRaceLayout = useCallback(
    () => window.matchMedia("(max-width: 900px)").matches,
    []
  );

  const expandListPanelForFilters = useCallback(() => {
    const layout = raceLayoutRef.current;
    const panel = listPanelRef.current;
    if (!layout) return;

    if (isStackedRaceLayout()) {
      const maxHeight = Math.max(
        LIST_PANEL_MIN_HEIGHT,
        layout.clientHeight - LIST_PANEL_DETAIL_MIN_HEIGHT - 28
      );

      let targetHeight = Math.max(
        LIST_PANEL_FILTERS_MIN_HEIGHT,
        Math.round(layout.clientHeight * 0.55)
      );

      if (panel && filtersScrollRef.current) {
        const heading = panel.querySelector<HTMLElement>(".race-panel-heading");
        const search = panel.querySelector<HTMLElement>(".race-search-row");
        const measured =
          (heading?.offsetHeight ?? 0) +
          (search?.offsetHeight ?? 0) +
          filtersScrollRef.current.scrollHeight +
          88;
        targetHeight = Math.max(targetHeight, measured);
      }

      setListPanelHeight((current) => Math.min(maxHeight, Math.max(current, targetHeight)));
      return;
    }

    const maxWidth = Math.max(
      LIST_PANEL_MIN_WIDTH,
      layout.clientWidth - LIST_PANEL_DETAIL_MIN - 28
    );
    const targetWidth = Math.min(
      maxWidth,
      Math.max(LIST_PANEL_FILTERS_MIN_WIDTH, Math.round(layout.clientWidth * 0.4))
    );
    setListPanelWidth((current) => Math.max(current, targetWidth));
  }, [isStackedRaceLayout]);

  const handleFiltersToggle = useCallback(() => {
    setFiltersExpanded((open) => !open);
  }, []);

  useLayoutEffect(() => {
    const wasExpanded = prevFiltersExpandedRef.current;
    prevFiltersExpandedRef.current = filtersExpanded;

    if (filtersExpanded) {
      if (isStackedRaceLayout() && !wasExpanded) {
        listPanelHeightBeforeFiltersRef.current = listPanelHeightRef.current;
      }
      expandListPanelForFilters();
      return;
    }

    if (wasExpanded && isStackedRaceLayout()) {
      const restoreHeight =
        listPanelHeightBeforeFiltersRef.current ?? loadRaceLayoutPrefs().listPanelHeight;
      listPanelHeightBeforeFiltersRef.current = null;
      setListPanelHeight(restoreHeight);
    }
  }, [filtersExpanded, expandListPanelForFilters, tab, consultants.length, isStackedRaceLayout]);

  const effectiveEditMode = editMode && permissions.canEdit;

  const handleListPanelResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const layout = raceLayoutRef.current;
      if (!layout) return;

      const stacked = isStackedRaceLayout();

      if (stacked) {
        const startY = event.clientY;
        const startHeight = listPanelHeight;

        const onPointerMove = (moveEvent: PointerEvent) => {
          const maxHeight = Math.max(
            LIST_PANEL_MIN_HEIGHT,
            layout.clientHeight - LIST_PANEL_DETAIL_MIN_HEIGHT - 28
          );
          const nextHeight = Math.min(
            maxHeight,
            Math.max(LIST_PANEL_MIN_HEIGHT, startHeight + moveEvent.clientY - startY)
          );
          setListPanelHeight(nextHeight);
        };

        const onPointerUp = () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          document.body.classList.remove("race-layout-resizing", "race-layout-resizing-vertical");
          persistRaceLayoutPrefs();
        };

        document.body.classList.add("race-layout-resizing", "race-layout-resizing-vertical");
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        return;
      }

      const startX = event.clientX;
      const startWidth = listPanelWidth;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const maxWidth = Math.max(
          LIST_PANEL_MIN_WIDTH,
          layout.clientWidth - LIST_PANEL_DETAIL_MIN - 28
        );
        const nextWidth = Math.min(
          maxWidth,
          Math.max(LIST_PANEL_MIN_WIDTH, startWidth + moveEvent.clientX - startX)
        );
        setListPanelWidth(nextWidth);
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        document.body.classList.remove("race-layout-resizing", "race-layout-resizing-vertical");
        persistRaceLayoutPrefs();
      };

      document.body.classList.add("race-layout-resizing");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [isStackedRaceLayout, listPanelHeight, listPanelWidth, persistRaceLayoutPrefs]
  );

  useEffect(() => {
    saveAppTab(tab);
  }, [tab]);

  const currentRaceFilters = useCallback((): RaceTabFilters => {
    return {
      categoryFilter,
      filter,
      seatHolderFilter,
      trumpSwingFilter,
      openSeatFilter,
      upForReelectionOnly,
      organizationFilter,
      consultantFilter,
      consultantFilterMode,
      filtersExpanded,
      selectedOfficeId,
    };
  }, [
    categoryFilter,
    filter,
    seatHolderFilter,
    trumpSwingFilter,
    openSeatFilter,
    upForReelectionOnly,
    organizationFilter,
    consultantFilter,
    consultantFilterMode,
    filtersExpanded,
    selectedOfficeId,
  ]);

  const applyRaceFilters = useCallback((saved: RaceTabFilters) => {
    setCategoryFilter(saved.categoryFilter);
    setFilter(saved.filter);
    setSeatHolderFilter(saved.seatHolderFilter);
    setTrumpSwingFilter(saved.trumpSwingFilter);
    setOpenSeatFilter(saved.openSeatFilter);
    setUpForReelectionOnly(saved.upForReelectionOnly);
    setOrganizationFilter(saved.organizationFilter);
    setConsultantFilter(saved.consultantFilter);
    setConsultantFilterMode(saved.consultantFilterMode);
    setFiltersExpanded(saved.filtersExpanded);
    setSelectedOfficeId(saved.selectedOfficeId);
  }, []);

  useEffect(() => {
    if (!isRacesTab(tab)) return;
    saveRaceTabFilters(currentRaceFilters());
  }, [tab, currentRaceFilters]);

  useEffect(() => {
    if (tab !== "counties") return;
    saveCountiesTabFilters({ countyElection });
  }, [tab, countyElection]);

  useEffect(() => {
    if (!permissions.canEdit && editMode) setEditMode(false);
  }, [permissions.canEdit, editMode]);

  const loadRaces = useCallback(async () => {
    if (tab !== "races") return;
    setLoading(true);
    setError("");
    try {
      const results = await Promise.all(RACE_CATEGORIES.map((category) => fetchRaces(category, cycleYear)));
      let filingPeriodsLoaded = false;
      const consultantMap = new Map<string, Consultant>();
      const targetingOrgMap = new Map<string, TargetingOrganization>();
      const nextRaces: Race[] = [];

      for (let index = 0; index < RACE_CATEGORIES.length; index++) {
        const category = RACE_CATEGORIES[index];
        const data = results[index];
        if (!filingPeriodsLoaded && data.filing_periods?.length) {
          setFilingPeriods(data.filing_periods);
          filingPeriodsLoaded = true;
        }
        for (const consultant of data.consultants ?? []) {
          consultantMap.set(consultant.consultant_key, consultant);
        }
        for (const org of data.targeting_organizations ?? []) {
          targetingOrgMap.set(org.org_key, org);
        }
        for (const race of data.races ?? []) {
          nextRaces.push({
            ...race,
            category,
            up_for_reelection: isOfficeFlagTrue(race.up_for_reelection),
          });
        }
      }

      setRaces(nextRaces);
      setConsultants(
        [...consultantMap.values()].sort((a, b) => a.name.localeCompare(b.name))
      );
      const nextTargetingOrgs = [...targetingOrgMap.values()].sort((a, b) =>
        a.org_key.localeCompare(b.org_key)
      );
      setTargetingOrganizations(nextTargetingOrgs);
      setOrganizationFilter((prev) =>
        prev.filter((orgKey) => targetingOrgMap.has(orgKey))
      );
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

  const loadStafferMap = useCallback(async () => {
    if (tab !== "staffers") return;
    setLoading(true);
    setError("");
    try {
      const data = await fetchStafferMap();
      setStafferMap(data.staffers ?? []);
      setStafferDistrictMap(data.districtStaffers ?? []);
      setStafferColorMap(data.stafferColors ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load staffer map");
      setStafferMap([]);
      setStafferDistrictMap([]);
      setStafferColorMap({});
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    if (tab !== "staffers") return;
    void loadStafferMap();
  }, [tab, loadStafferMap]);

  useEffect(() => {
    if (tab !== "counties") return;
    void loadCounties();
  }, [tab, countyElection, loadCounties]);

  useEffect(() => {
    if (tab === "data" || tab === "admin" || tab === "staffers") {
      setLoading(false);
    } else if (tab === "races") {
      setRaces([]);
      void loadRaces();
    }
  }, [loadRaces, tab, cycleYear]);

  const handleUpForReelectionOnlyChange = useCallback((upOnly: boolean) => {
    setUpForReelectionOnly(upOnly);
  }, []);

  const resetRaceFilters = useCallback(() => {
    setCategoryFilter("all");
    setFilter("");
    setSeatHolderFilter("all");
    setTrumpSwingFilter(false);
    setOpenSeatFilter(false);
    setUpForReelectionOnly(false);
    setOrganizationFilter([]);
    setConsultantFilter([]);
    setConsultantFilterMode("all");
  }, []);

  const filteredRaces = useMemo(() => {
    if (tab !== "races") return [];
    return races.filter((race) => {
      const category = raceCategory(race);
      if (categoryFilter !== "all" && category !== categoryFilter) return false;

      const query = filter.trim().toLowerCase();
      if (query) {
        const label = raceListLabel(race).toLowerCase();
        const incumbentName = raceSeatHolder(race)?.name?.toLowerCase() ?? "";
        const matchesSearch =
          label.includes(query) ||
          race.office_code.toLowerCase().includes(query) ||
          race.office_name.toLowerCase().includes(query) ||
          RACE_CATEGORY_LABELS[category].toLowerCase().includes(query) ||
          incumbentName.includes(query) ||
          race.candidates.some((c) => c.name.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      if (!matchesSeatHolderFilter(race, seatHolderFilter)) return false;
      if (!matchesTrumpSwingFilter(race, trumpSwingFilter)) return false;
      if (!matchesOpenSeatFilter(race, openSeatFilter)) return false;
      if (!matchesUpForReelectionFilter(race, category, upForReelectionOnly)) return false;
      if (!matchesOrganizationFilter(race, organizationFilter)) return false;
      if (!matchesConsultantFilter(race, consultantFilter)) return false;

      return true;
    });
  }, [
    races,
    filter,
    tab,
    categoryFilter,
    seatHolderFilter,
    trumpSwingFilter,
    openSeatFilter,
    upForReelectionOnly,
    organizationFilter,
    consultantFilter,
  ]);

  const showUpForReelectionFilter =
    categoryFilter === "all" ||
    categoryFilter === "senate" ||
    categoryFilter === "sboe" ||
    categoryFilter === "statewide";

  const showOrganizationFilter =
    (categoryFilter === "all" || categoryFilter === "house") && targetingOrganizations.length > 0;

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (categoryFilter !== "all") count += 1;
    if (filter.trim()) count += 1;
    if (seatHolderFilter !== "all") count += 1;
    if (trumpSwingFilter) count += 1;
    if (openSeatFilter) count += 1;
    if (showUpForReelectionFilter && upForReelectionOnly) count += 1;
    if (organizationFilter.length > 0) count += 1;
    if (consultantFilterMode === "select" && consultantFilter.length > 0) count += 1;
    return count;
  }, [
    categoryFilter,
    filter,
    seatHolderFilter,
    trumpSwingFilter,
    openSeatFilter,
    showUpForReelectionFilter,
    upForReelectionOnly,
    organizationFilter,
    consultantFilter,
    consultantFilterMode,
  ]);

  useEffect(() => {
    if (tab !== "races") return;
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
    selectedRace && tab === "races" ? mergeRaceMetrics(selectedRace, raceCategory(selectedRace)) : [];
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

  const changeTab = useCallback(
    (next: AppTab) => {
      if (next === tab) return;

      if (tab === "races") saveRaceTabFilters(currentRaceFilters());
      if (tab === "counties") saveCountiesTabFilters({ countyElection });

      if (next === "races") applyRaceFilters(loadRaceTabFilters());
      else if (next === "counties") setCountyElection(loadCountiesTabFilters().countyElection);

      setTab(next);
    },
    [tab, countyElection, currentRaceFilters, applyRaceFilters]
  );

  const selectTab = useCallback(
    (next: AppTab) => {
      if (next !== tab) {
        setConsultantFilterMode((mode) => normalizeConsultantFilterMode(mode, consultantFilter));
        changeTab(next);
      }
      setNavOpen(false);
    },
    [consultantFilter, tab, changeTab]
  );

  useEffect(() => {
    if (tab === "data" && !permissions.canAccessData) changeTab("races");
    else if (tab === "admin" && !permissions.canManageUsers) changeTab("races");
  }, [tab, permissions.canAccessData, permissions.canManageUsers, changeTab]);

  function navLinkClass(id: AppTab) {
    return tab === id ? "app-topbar-link is-active" : "app-topbar-link";
  }

  const activeNavLabel = useMemo(() => {
    if (tab === "races") return "Races";
    if (tab === "counties") return "Counties";
    if (tab === "staffers") return "Staffers";
    if (tab === "data") return "Data";
    if (tab === "admin") return "Admin";
    return "";
  }, [tab]);

  return (
    <div className="app">
      <header className={permissions.isAdmin ? "app-topbar app-topbar-admin" : "app-topbar"}>
        <div className="app-topbar-row">
          <div className="app-topbar-brand">
            <span className="app-topbar-title">Texas Candidate Lookup</span>
            {activeNavLabel ? (
              <span className="app-topbar-subtitle">{activeNavLabel}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="app-topbar-menu-btn"
            aria-label={navOpen ? "Close menu" : "Open menu"}
            aria-expanded={navOpen}
            aria-controls="app-main-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            <span className="app-topbar-menu-icon" aria-hidden="true" />
          </button>
          <nav
            id="app-main-nav"
            className={navOpen ? "app-topbar-nav is-open" : "app-topbar-nav"}
            aria-label="Sections"
          >
            <div className="app-topbar-links">
              <button
                type="button"
                className={navLinkClass("races")}
                aria-current={tab === "races" ? "page" : undefined}
                onClick={() => selectTab("races")}
              >
                Races
              </button>
              <button
                type="button"
                className={navLinkClass("counties")}
                aria-current={tab === "counties" ? "page" : undefined}
                onClick={() => selectTab("counties")}
              >
                Counties
              </button>
              <button
                type="button"
                className={navLinkClass("staffers")}
                aria-current={tab === "staffers" ? "page" : undefined}
                onClick={() => selectTab("staffers")}
              >
                Staffers
              </button>
              {permissions.canAccessData ? (
                <button
                  type="button"
                  className={navLinkClass("data")}
                  aria-current={tab === "data" ? "page" : undefined}
                  onClick={() => selectTab("data")}
                >
                  Data
                </button>
              ) : null}
              {permissions.canManageUsers ? (
                <button
                  type="button"
                  className={navLinkClass("admin")}
                  aria-current={tab === "admin" ? "page" : undefined}
                  onClick={() => selectTab("admin")}
                >
                  Admin
                </button>
              ) : null}
            </div>
            <div className="app-topbar-util">
              {permissions.canEdit ? (
                <label className="app-topbar-edit toggle">
                  <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} />
                  Edit mode
                </label>
              ) : null}
              {user ? (
                <>
                  <span className="app-topbar-user">{user.display_name}</span>
                  <button type="button" className="app-topbar-auth" onClick={() => void logout()}>
                    Log out
                  </button>
                </>
              ) : guestAccess ? (
                <button type="button" className="app-topbar-auth" onClick={promptLogin}>
                  Log in
                </button>
              ) : null}
            </div>
          </nav>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      {saveError ? <div className="banner error">{saveError}</div> : null}

      {loading && tab !== "data" && tab !== "admin" ? (
        <p className="loading">Loading…</p>
      ) : tab === "data" ? (
        <AdminDataPanel cycleYear={cycleYear} editMode={effectiveEditMode} />
      ) : tab === "admin" ? (
        <AdminUsersPanel />
      ) : tab === "staffers" ? (
        <div className="staffers-panel">
          {stafferMap.length === 0 ? (
            <p className="loading">
              No staffer county assignments yet. Add staffers and counties in the Data tab, or run{" "}
              <code>npm run db:seed-tga-staffers</code>.
            </p>
          ) : (
            <StafferMap
              staffers={stafferMap}
              districtStaffers={stafferDistrictMap}
              stafferColors={stafferColorMap}
            />
          )}
        </div>
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
          {counties.length === 0 ? (
            <p className="loading">
              No county results for this election. Run <code>npm run db:import</code> with your lege Excel file, or{" "}
              <code>npm run db:sync-county-results</code> to copy from SQLite.
            </p>
          ) : (
            <CountyHeatmap
              counties={counties}
              title={countyTitle}
              editMode={effectiveEditMode}
              election={countyElection}
              onCountySaved={handleCountySaved}
            />
          )}
        </div>
      ) : races.length === 0 ? (
        <p className="loading">
          No races for {cycleYear}. Run <code>npm run db:import</code> with your Excel file.
        </p>
      ) : (
        <div
          className="race-layout"
          ref={raceLayoutRef}
          style={
            {
              "--race-list-panel-width": `${listPanelWidth}px`,
              "--race-list-panel-height": `${listPanelHeight}px`,
            } as React.CSSProperties
          }
        >
          <aside
            ref={listPanelRef}
            className={filtersExpanded ? "race-list-panel filters-expanded" : "race-list-panel"}
          >
            <h2 className="race-panel-heading">Select an office/race</h2>
            <div className="race-search-row">
              <input
                className="race-search"
                type="search"
                placeholder="Search district, office, incumbent, or candidate…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button
                type="button"
                className="race-filters-toggle"
                aria-expanded={filtersExpanded}
                onClick={handleFiltersToggle}
              >
                <span>{filtersExpanded ? "Hide filters" : "Show filters"}</span>
                {activeFilterCount > 0 ? (
                  <span className="race-filters-toggle-count">{activeFilterCount} active</span>
                ) : null}
              </button>
            </div>
            {filtersExpanded ? (
            <div className="race-filters-scroll" ref={filtersScrollRef}>
              <div className="race-filters">
                <div className="filter-group">
                  <span className="filter-label">Office type</span>
                  <div className="filter-chips">
                    {RACE_CATEGORY_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={categoryFilter === option.id ? "filter-chip active" : "filter-chip"}
                        onClick={() => setCategoryFilter(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

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

                {showUpForReelectionFilter ? (
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

                {showOrganizationFilter ? (
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
                      {targetingOrganizations.map((org) => (
                        <button
                          key={org.org_key}
                          type="button"
                          className={
                            organizationFilter.includes(org.org_key) ? "filter-chip active" : "filter-chip"
                          }
                          onClick={() => toggleOrganizationFilter(org.org_key)}
                          title={org.name}
                        >
                          {org.org_key}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {consultants.length > 0 ? (
                  <div className="filter-group">
                    <span className="filter-label">Consultant</span>
                    <div className="filter-chips">
                      <button
                        type="button"
                        className={consultantFilterMode === "all" ? "filter-chip active" : "filter-chip"}
                        onClick={() => {
                          setConsultantFilterMode("all");
                          setConsultantFilter([]);
                        }}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        className={consultantFilterMode === "select" ? "filter-chip active" : "filter-chip"}
                        onClick={() => setConsultantFilterMode("select")}
                      >
                        Select
                      </button>
                    </div>
                    {consultantFilterMode === "select" ? (
                      <>
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
                      </>
                    ) : null}
                  </div>
                ) : (
                  <p className="filter-hint">
                    Add consultants in the <strong>Data</strong> tab, then assign them on the{" "}
                    <strong>Candidates</strong> table.
                  </p>
                )}

                <div className="filter-reset-row">
                  <button
                    type="button"
                    className="filter-reset-btn"
                    disabled={activeFilterCount === 0}
                    onClick={resetRaceFilters}
                  >
                    Reset filters
                  </button>
                </div>
              </div>
            </div>
            ) : null}
            <div className="race-list-region">
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
                        {raceListLabel(race)}
                        {categoryFilter === "all" ? (
                          <span className="race-item-category">{RACE_CATEGORY_LABELS[raceCategory(race)]}</span>
                        ) : null}
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
            </div>
          </aside>

          <div
            className="race-layout-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize office list panel"
            aria-valuemin={LIST_PANEL_MIN_WIDTH}
            aria-valuemax={640}
            aria-valuenow={listPanelWidth}
            tabIndex={0}
            onPointerDown={handleListPanelResizeStart}
          >
            <span className="race-layout-resizer-grip" aria-hidden="true" />
          </div>

          <section className="race-detail-panel">
            <h2 className="race-panel-heading">Candidate/Race Info</h2>
            <div className="race-detail-scroll">
            {selectedRace ? (
              <>
                <header className="race-detail-header">
                  <h2>{raceDetailTitle(selectedRace)}</h2>
                </header>

                {(() => {
                  const holder = raceSeatHolder(selectedRace);
                  const holderParty = holder?.party ?? null;
                  const holderPartyBadge = holderParty ? partyBadgeClass(holderParty) : null;
                  const tgaStaffers = selectedRace.tga_staffer_names ?? [];
                  return (
                    <>
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
                      {tgaStaffers.length > 0 ? (
                        <div className="race-tga-staffer-block">
                          <h3 className="race-seat-holder-heading">Abbott staffer</h3>
                          <span className="race-tga-staffer-name">{tgaStaffers.join(", ")}</span>
                        </div>
                      ) : null}
                    </>
                  );
                })()}

                <RaceMetrics
                  metrics={selectedMetrics}
                  category={raceCategory(selectedRace)}
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
                            <div className="candidate-finance">
                              <LatestFinanceDisplay candidate={candidate} />
                            </div>
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
            </div>
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
