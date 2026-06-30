/**
 * Staffer map colors grouped by hue family. Assignment walks legend order (name sort)
 * and round-robins across families so adjacent legend entries never share a family
 * (e.g. yellow next to orange, orange next to red).
 */
const STAFFER_PALETTE_FAMILIES: string[][] = [
  ["#2563eb", "#1e40af", "#6366f1", "#818cf8", "#38bdf8", "#0891b2", "#22d3ee"],
  ["#991b1b", "#dc2626"],
  ["#65a30d", "#84cc16", "#a3e635", "#4ade80", "#86efac"],
  ["#fb923c", "#f97316"],
  ["#9333ea", "#c4b5fd", "#e879f9"],
  ["#0d9488", "#14b8a6", "#2dd4bf"],
  ["#eab308", "#fbbf24", "#facc15"],
  ["#f472b6", "#fb7185"],
  ["#78716c"],
];

const STAFFER_PALETTE_FLAT = STAFFER_PALETTE_FAMILIES.flat();

export const STAFFER_MAP_UNASSIGNED = "#3a3d47";

/** Fixed legend colors for named staffers (case-sensitive). */
const STAFFER_COLOR_OVERRIDES: Record<string, string> = {
  "Vacant 1": "#f87171",
  "Vacant 2": "#eab308",
  "Vacant 3": "#166534",
};

/** Hue family for override colors not present in STAFFER_PALETTE_FAMILIES. */
const OVERRIDE_COLOR_FAMILIES: Record<string, number> = {
  "#f87171": 1,
  "#166534": 2,
};

function normalizeHex(color: string) {
  return color.trim().toLowerCase();
}

function colorFamilyIndex(hex: string): number {
  const normalized = normalizeHex(hex);
  for (let family = 0; family < STAFFER_PALETTE_FAMILIES.length; family++) {
    if (STAFFER_PALETTE_FAMILIES[family]!.some((color) => normalizeHex(color) === normalized)) {
      return family;
    }
  }
  return OVERRIDE_COLOR_FAMILIES[normalized] ?? -1;
}

function pickNextColor(
  familyIndices: number[],
  startFamily: number,
  avoidFamily: number | null,
  reserved: Set<string>,
  strict = true
): { color: string; family: number; nextStart: number } | null {
  for (let offset = 0; offset < STAFFER_PALETTE_FAMILIES.length; offset++) {
    const family = (startFamily + offset) % STAFFER_PALETTE_FAMILIES.length;
    if (strict && avoidFamily !== null && family === avoidFamily) continue;

    const colors = STAFFER_PALETTE_FAMILIES[family]!;
    const index = familyIndices[family]!;
    if (index >= colors.length) continue;

    const color = colors[index]!;
    if (reserved.has(normalizeHex(color))) {
      familyIndices[family] = index + 1;
      continue;
    }

    familyIndices[family] = index + 1;
    return {
      color,
      family,
      nextStart: (family + 1) % STAFFER_PALETTE_FAMILIES.length,
    };
  }

  for (let i = 0; i < STAFFER_PALETTE_FLAT.length; i++) {
    const color = STAFFER_PALETTE_FLAT[i]!;
    if (reserved.has(normalizeHex(color))) continue;
    const family = colorFamilyIndex(color);
    if (strict && avoidFamily !== null && family === avoidFamily) continue;
    return { color, family, nextStart: startFamily };
  }

  return null;
}

export function buildStafferColorMap(stafferNames: string[]) {
  const sorted = [...new Set(stafferNames)].sort((a, b) => a.localeCompare(b));
  const reserved = new Set(
    [STAFFER_MAP_UNASSIGNED, ...Object.values(STAFFER_COLOR_OVERRIDES)].map(normalizeHex)
  );

  const familyIndices = STAFFER_PALETTE_FAMILIES.map(() => 0);
  let startFamily = 0;
  let lastFamily: number | null = null;
  let fallbackIndex = 0;
  const map = new Map<string, string>();

  for (const name of sorted) {
    const override = STAFFER_COLOR_OVERRIDES[name];
    if (override) {
      map.set(name, override);
      lastFamily = colorFamilyIndex(override);
      continue;
    }

    let picked =
      pickNextColor(familyIndices, startFamily, lastFamily, reserved, true) ??
      pickNextColor(familyIndices, startFamily, lastFamily, reserved, false);

    if (!picked) {
      while (fallbackIndex < STAFFER_PALETTE_FLAT.length * 2) {
        const color = STAFFER_PALETTE_FLAT[fallbackIndex % STAFFER_PALETTE_FLAT.length]!;
        fallbackIndex += 1;
        if (reserved.has(normalizeHex(color))) continue;
        picked = { color, family: colorFamilyIndex(color), nextStart: startFamily };
        break;
      }
    }

    if (!picked) continue;

    map.set(name, picked.color);
    reserved.add(normalizeHex(picked.color));
    lastFamily = picked.family;
    startFamily = picked.nextStart;
  }

  return map;
}

export function splitLabel(names: string[]) {
  return names.map((name) => name.split(/\s+/)[0]).join(" / ");
}

/** Colors reserved for manual county highlighting (not used in the staffer legend). */
const HIGHLIGHT_COLOR_POOL = [
  "#e11d48",
  "#7c3aed",
  "#059669",
  "#d97706",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#475569",
  "#be123c",
  "#5b21b6",
  "#0f766e",
  "#b45309",
];

/** Up to six highlight colors that do not appear in the current legend. */
export function pickHighlightColors(legendColors: Iterable<string>, count = 6): string[] {
  const used = new Set([STAFFER_MAP_UNASSIGNED, ...legendColors].map(normalizeHex));
  const picked: string[] = [];
  for (const color of HIGHLIGHT_COLOR_POOL) {
    if (used.has(normalizeHex(color))) continue;
    picked.push(color);
    if (picked.length >= count) break;
  }
  return picked;
}
