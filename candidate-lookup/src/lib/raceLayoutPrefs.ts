const STORAGE_KEY = "candidate-lookup.race-layout";

export type RaceLayoutPrefs = {
  listPanelWidth: number;
  listPanelHeight: number;
};

const DEFAULTS: RaceLayoutPrefs = {
  listPanelWidth: 260,
  listPanelHeight: 280,
};

function clamp(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function loadRaceLayoutPrefs(): RaceLayoutPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<RaceLayoutPrefs>;
    return {
      listPanelWidth: clamp(parsed.listPanelWidth, 200, 900, DEFAULTS.listPanelWidth),
      listPanelHeight: clamp(parsed.listPanelHeight, 180, 1200, DEFAULTS.listPanelHeight),
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveRaceLayoutPrefs(prefs: RaceLayoutPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}
