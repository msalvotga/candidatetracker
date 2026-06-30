import type { AppTab, OfficeCategory } from "../types";

const STORAGE_KEY = "candidate-lookup.active-tab";
const DEFAULT_TAB: AppTab = "races";

const VALID_TABS = new Set<AppTab>(["races", "counties", "staffers", "data", "admin"]);

const LEGACY_RACE_TABS = new Set<OfficeCategory>(["house", "senate", "sboe", "statewide", "congressional"]);

export function loadLegacyRaceCategory(): OfficeCategory | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && LEGACY_RACE_TABS.has(raw as OfficeCategory)) return raw as OfficeCategory;
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return null;
}

export function loadAppTab(): AppTab {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && VALID_TABS.has(raw as AppTab)) return raw as AppTab;
    if (raw && LEGACY_RACE_TABS.has(raw as OfficeCategory)) return "races";
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return DEFAULT_TAB;
}

export function saveAppTab(tab: AppTab) {
  try {
    localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}
