import type { AppTab, CountyElection, OfficeCategory } from "../types";
import type { SeatHolderFilter } from "./raceFilters";
import { loadLegacyRaceCategory } from "./appTabPrefs";

const STORAGE_KEY = "candidate-lookup.tab-filters";

const OFFICE_CATEGORIES: OfficeCategory[] = ["house", "senate", "sboe", "statewide", "congressional"];
const SEAT_HOLDER_FILTERS = new Set<SeatHolderFilter>(["all", "gop", "dem"]);
const COUNTY_ELECTIONS = new Set<CountyElection>(["pres_2024", "cruz_2024", "abbott_2022"]);

export type RaceCategoryFilter = OfficeCategory | "all";

export type RaceTabFilters = {
  categoryFilter: RaceCategoryFilter;
  filter: string;
  seatHolderFilter: SeatHolderFilter;
  trumpSwingFilter: boolean;
  openSeatFilter: boolean;
  upForReelectionOnly: boolean;
  organizationFilter: string[];
  consultantFilter: string[];
  consultantFilterMode: "all" | "select";
  filtersExpanded: boolean;
  selectedOfficeId: number | null;
};

export type CountiesTabFilters = {
  countyElection: CountyElection;
};

export type DataTabFilters = {
  filterCategory: OfficeCategory | "";
  singleCandidateRacesOnly: boolean;
  selectedTable: string;
};

type TabFiltersStore = {
  races?: RaceTabFilters;
  /** @deprecated Migrated to unified `races` on read. */
  race?: Partial<Record<OfficeCategory, Omit<RaceTabFilters, "categoryFilter">>>;
  counties: CountiesTabFilters;
  data: DataTabFilters;
};

export const DEFAULT_RACE_TAB_FILTERS: RaceTabFilters = {
  categoryFilter: "all",
  filter: "",
  seatHolderFilter: "all",
  trumpSwingFilter: false,
  openSeatFilter: false,
  upForReelectionOnly: true,
  organizationFilter: [],
  consultantFilter: [],
  consultantFilterMode: "all",
  filtersExpanded: false,
  selectedOfficeId: null,
};

export const DEFAULT_COUNTIES_TAB_FILTERS: CountiesTabFilters = {
  countyElection: "pres_2024",
};

export const DEFAULT_DATA_TAB_FILTERS: DataTabFilters = {
  filterCategory: "house",
  singleCandidateRacesOnly: false,
  selectedTable: "candidates",
};

export function isRacesTab(tab: AppTab): boolean {
  return tab === "races";
}

function defaultStore(): TabFiltersStore {
  return {
    counties: { ...DEFAULT_COUNTIES_TAB_FILTERS },
    data: { ...DEFAULT_DATA_TAB_FILTERS },
  };
}

function normalizeRaceCategoryFilter(value: unknown): RaceCategoryFilter {
  if (value === "all") return "all";
  if (typeof value === "string" && OFFICE_CATEGORIES.includes(value as OfficeCategory)) {
    return value as OfficeCategory;
  }
  return DEFAULT_RACE_TAB_FILTERS.categoryFilter;
}

function normalizeRaceTabFilters(raw: Partial<RaceTabFilters> | undefined): RaceTabFilters {
  if (!raw) return { ...DEFAULT_RACE_TAB_FILTERS };
  return {
    categoryFilter: normalizeRaceCategoryFilter(raw.categoryFilter),
    filter: typeof raw.filter === "string" ? raw.filter : DEFAULT_RACE_TAB_FILTERS.filter,
    seatHolderFilter: SEAT_HOLDER_FILTERS.has(raw.seatHolderFilter as SeatHolderFilter)
      ? (raw.seatHolderFilter as SeatHolderFilter)
      : DEFAULT_RACE_TAB_FILTERS.seatHolderFilter,
    trumpSwingFilter: Boolean(raw.trumpSwingFilter),
    openSeatFilter: Boolean(raw.openSeatFilter),
    upForReelectionOnly:
      raw.upForReelectionOnly === undefined ? DEFAULT_RACE_TAB_FILTERS.upForReelectionOnly : Boolean(raw.upForReelectionOnly),
    organizationFilter: Array.isArray(raw.organizationFilter)
      ? raw.organizationFilter.filter((value): value is string => typeof value === "string")
      : [],
    consultantFilter: Array.isArray(raw.consultantFilter)
      ? raw.consultantFilter.filter((value): value is string => typeof value === "string")
      : [],
    consultantFilterMode: raw.consultantFilterMode === "select" ? "select" : "all",
    filtersExpanded: Boolean(raw.filtersExpanded),
    selectedOfficeId:
      typeof raw.selectedOfficeId === "number" && Number.isInteger(raw.selectedOfficeId)
        ? raw.selectedOfficeId
        : null,
  };
}

function migrateLegacyRaceFilters(store: TabFiltersStore): RaceTabFilters {
  const legacyCategory = loadLegacyRaceCategory();
  if (store.races) {
    const filters = normalizeRaceTabFilters(store.races);
    if (legacyCategory && filters.categoryFilter === "all") {
      filters.categoryFilter = legacyCategory;
    }
    return filters;
  }

  const sourceCategory = legacyCategory ?? "house";
  const legacyFilters = store.race?.[sourceCategory] ?? store.race?.house;
  return normalizeRaceTabFilters({
    ...DEFAULT_RACE_TAB_FILTERS,
    ...legacyFilters,
    categoryFilter: legacyCategory ?? "all",
  });
}

function readStore(): TabFiltersStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw) as Partial<TabFiltersStore>;
    return {
      races: parsed.races ? normalizeRaceTabFilters(parsed.races) : undefined,
      race: parsed.race,
      counties: { ...DEFAULT_COUNTIES_TAB_FILTERS, ...parsed.counties },
      data: { ...DEFAULT_DATA_TAB_FILTERS, ...parsed.data },
    };
  } catch {
    return defaultStore();
  }
}

function writeStore(store: TabFiltersStore) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        races: store.races,
        counties: store.counties,
        data: store.data,
      })
    );
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function normalizeCountiesTabFilters(raw: Partial<CountiesTabFilters> | undefined): CountiesTabFilters {
  const countyElection =
    raw?.countyElection && COUNTY_ELECTIONS.has(raw.countyElection)
      ? raw.countyElection
      : DEFAULT_COUNTIES_TAB_FILTERS.countyElection;
  return { countyElection };
}

function normalizeDataTabFilters(raw: Partial<DataTabFilters> | undefined): DataTabFilters {
  let filterCategory: OfficeCategory | "" = DEFAULT_DATA_TAB_FILTERS.filterCategory;
  if (raw?.filterCategory === "") {
    filterCategory = "";
  } else if (raw?.filterCategory && OFFICE_CATEGORIES.includes(raw.filterCategory)) {
    filterCategory = raw.filterCategory;
  }
  return {
    filterCategory,
    singleCandidateRacesOnly: Boolean(raw?.singleCandidateRacesOnly),
    selectedTable: typeof raw?.selectedTable === "string" ? raw.selectedTable : DEFAULT_DATA_TAB_FILTERS.selectedTable,
  };
}

export function loadRaceTabFilters(): RaceTabFilters {
  return migrateLegacyRaceFilters(readStore());
}

export function saveRaceTabFilters(filters: RaceTabFilters) {
  const store = readStore();
  store.races = normalizeRaceTabFilters(filters);
  writeStore(store);
}

export function loadCountiesTabFilters(): CountiesTabFilters {
  return normalizeCountiesTabFilters(readStore().counties);
}

export function saveCountiesTabFilters(filters: CountiesTabFilters) {
  const store = readStore();
  store.counties = normalizeCountiesTabFilters(filters);
  writeStore(store);
}

export function loadDataTabFilters(): DataTabFilters {
  return normalizeDataTabFilters(readStore().data);
}

export function saveDataTabFilters(filters: DataTabFilters) {
  const store = readStore();
  store.data = normalizeDataTabFilters(filters);
  writeStore(store);
}

export function loadInitialTabFilters(tab: AppTab) {
  if (tab === "races") {
    return {
      race: loadRaceTabFilters(),
      counties: DEFAULT_COUNTIES_TAB_FILTERS,
    };
  }
  if (tab === "counties") {
    return {
      race: DEFAULT_RACE_TAB_FILTERS,
      counties: loadCountiesTabFilters(),
    };
  }
  return {
    race: DEFAULT_RACE_TAB_FILTERS,
    counties: DEFAULT_COUNTIES_TAB_FILTERS,
  };
}
