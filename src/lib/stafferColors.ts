/**
 * Staffer map colors grouped by hue family. Assignment round-robins across families
 * so alphabetically adjacent staffers (legend order) never get similar neighbors
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

function interleavedPalette(count: number): string[] {
  const familyIndices = STAFFER_PALETTE_FAMILIES.map(() => 0);
  const result: string[] = [];
  let startFamily = 0;

  while (result.length < count) {
    let picked = false;
    for (let offset = 0; offset < STAFFER_PALETTE_FAMILIES.length; offset++) {
      const family = (startFamily + offset) % STAFFER_PALETTE_FAMILIES.length;
      const colors = STAFFER_PALETTE_FAMILIES[family];
      const index = familyIndices[family];
      if (index < colors.length) {
        result.push(colors[index]);
        familyIndices[family]++;
        startFamily = (family + 1) % STAFFER_PALETTE_FAMILIES.length;
        picked = true;
        break;
      }
    }
    if (!picked) break;
  }

  if (result.length < count) {
    for (let i = result.length; i < count; i++) {
      result.push(STAFFER_PALETTE_FLAT[i % STAFFER_PALETTE_FLAT.length]);
    }
  }

  return result;
}

export function buildStafferColorMap(stafferNames: string[]) {
  const sorted = [...stafferNames].sort((a, b) => a.localeCompare(b));
  const colors = interleavedPalette(sorted.length);
  const map = new Map<string, string>();
  sorted.forEach((name, index) => {
    map.set(name, colors[index]!);
  });
  return map;
}

export function splitLabel(names: string[]) {
  return names.map((name) => name.split(/\s+/)[0]).join(" / ");
}
