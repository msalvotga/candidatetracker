import type { AppTab } from "../types";

const STORAGE_KEY = "candidate-lookup.active-tab";
const DEFAULT_TAB: AppTab = "house";

const VALID_TABS = new Set<AppTab>([
  "house",
  "senate",
  "sboe",
  "statewide",
  "congressional",
  "counties",
  "staffers",
  "data",
  "admin",
]);

export function loadAppTab(): AppTab {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && VALID_TABS.has(raw as AppTab)) return raw as AppTab;
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
