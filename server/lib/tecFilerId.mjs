/** Split a stored TEC filer ID field into individual IDs (comma/semicolon/whitespace). */
export function parseTecFilerIds(value) {
  return String(value ?? "")
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Normalize one TEC filer ID (no leading zeros). */
function normalizeOneTecFilerId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.replace(/^0+(?=\d)/, "");
}

/**
 * Normalize TEC filer ID(s) for storage/display.
 * Supports a single ID or multiple IDs separated by commas, semicolons, or whitespace.
 * Returns a comma-separated string, or null when empty.
 */
export function normalizeTecFilerId(value) {
  const ids = [];
  const seen = new Set();
  for (const part of parseTecFilerIds(value)) {
    const next = normalizeOneTecFilerId(part);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    ids.push(next);
  }
  if (ids.length === 0) return null;
  return ids.join(", ");
}

/** Strip leading zeros / normalize formatting for all stored candidate TEC filer IDs. */
export async function normalizeAllCandidateTecFilerIds(db) {
  const rows = await db
    .prepare(
      `SELECT id, tec_filer_id FROM candidates
       WHERE tec_filer_id IS NOT NULL AND tec_filer_id != ''`
    )
    .all();

  let updated = 0;
  for (const row of rows) {
    const next = normalizeTecFilerId(row.tec_filer_id);
    const current = String(row.tec_filer_id ?? "").trim();
    if (next === current || (next == null && !current)) continue;
    await db.prepare(`UPDATE candidates SET tec_filer_id = ? WHERE id = ?`).run(next, row.id);
    updated += 1;
  }

  return { scanned: rows.length, updated };
}
