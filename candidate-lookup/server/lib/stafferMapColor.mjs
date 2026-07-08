/** Default map colors seeded when map_color is unset (matches prior hardcoded overrides). */
export const DEFAULT_STAFFER_MAP_COLORS = {
  "Vanessa Garcia": "#5b9bd5",
  "Lucy Sisnega": "#e8b923",
  "Rick Cromack": "#8b2942",
  "Hayden Head": "#c8b4e8",
  "Elayna Hefner": "#1e3a8a",
  "Robert Bennett": "#87ceeb",
  "Lou Minnick": "#5cb8a8",
  "Carine Martinez": "#e74c3c",
  "Carolyn Bryant": "#22c55e",
  "Mallory McCoy": "#2563eb",
  "Sarah Rios": "#7b5ea7",
  "Jessica Colon": "#dc2626",
  "Vacant 1": "#f87171",
  "Vacant 2": "#eab308",
  "Vacant 3": "#166534",
  "Aberie Shea": "#6366f1",
  "Quinton Hitchcock": "#0891b2",
  "Howard Barker": "#84cc16",
  "Rodney Sims": "#65a30d",
  "Marga Matthews": "#ef4444",
  "Sara Tracey": "#ec4899",
  "Lee Vigil": "#3b82f6",
  "James Clayton": "#f472b6",
  "Harrison Hink": "#a855f7",
  "Kayla Hensley": "#f59e0b",
  "Helen Zhou": "#06b6d4",
  "Dwayne Bohac": "#f97316",
  "Julie Hunt": "#d946ef",
  "Paola Velasco": "#8b5cf6",
  "Jeff MacGeorge": "#0ea5e9",
  "Karen Ben-Moyal": "#10b981",
  "Coleton Emr": "#14b8a6",
};

/** Palette for any staffer still missing map_color after named defaults. */
const AUTO_ASSIGN_PALETTE = [
  "#1e40af",
  "#38bdf8",
  "#22d3ee",
  "#991b1b",
  "#4ade80",
  "#fb923c",
  "#9333ea",
  "#c4b5fd",
  "#0d9488",
  "#2dd4bf",
  "#eab308",
  "#fbbf24",
  "#fb7185",
  "#78716c",
  "#e11d48",
  "#7c3aed",
  "#059669",
  "#d97706",
  "#db2777",
  "#475569",
];

/** Normalize and validate a staffer map hex color (#rgb or #rrggbb). */
export function normalizeMapColor(value) {
  if (value === "" || value == null) return null;
  let raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (!raw.startsWith("#")) raw = `#${raw}`;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    raw = `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/.test(raw)) {
    throw new Error(`invalid map color: ${value}`);
  }
  return raw;
}

export async function seedDefaultStafferMapColors(db) {
  const update = db.prepare(`UPDATE tga_staffers SET map_color = ? WHERE id = ?`);
  let seeded = 0;

  for (const [name, color] of Object.entries(DEFAULT_STAFFER_MAP_COLORS)) {
    const row = await db
      .prepare(
        `SELECT id FROM tga_staffers
         WHERE name = ? AND (map_color IS NULL OR TRIM(map_color) = '')`
      )
      .get(name);
    if (!row) continue;
    await update.run(color, row.id);
    seeded += 1;
  }

  const used = new Set(
    (
      await db
        .prepare(`SELECT map_color FROM tga_staffers WHERE map_color IS NOT NULL AND TRIM(map_color) != ''`)
        .all()
    ).map((row) => String(row.map_color).trim().toLowerCase())
  );

  const unassigned = await db
    .prepare(
      `SELECT id, name FROM tga_staffers
       WHERE map_color IS NULL OR TRIM(map_color) = ''
       ORDER BY name COLLATE NOCASE`
    )
    .all();

  let paletteIndex = 0;
  for (const row of unassigned) {
    let color = null;
    while (paletteIndex < AUTO_ASSIGN_PALETTE.length * 3) {
      const candidate = AUTO_ASSIGN_PALETTE[paletteIndex % AUTO_ASSIGN_PALETTE.length];
      paletteIndex += 1;
      const normalized = candidate.toLowerCase();
      if (!used.has(normalized)) {
        color = candidate;
        used.add(normalized);
        break;
      }
    }
    if (!color) {
      color = AUTO_ASSIGN_PALETTE[paletteIndex % AUTO_ASSIGN_PALETTE.length];
      paletteIndex += 1;
    }
    await update.run(color, row.id);
    seeded += 1;
  }

  return seeded;
}
