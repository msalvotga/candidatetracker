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
};

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
    const row = await db.prepare(`SELECT id FROM tga_staffers WHERE name = ? AND map_color IS NULL`).get(name);
    if (!row) continue;
    await update.run(color, row.id);
    seeded += 1;
  }
  return seeded;
}
