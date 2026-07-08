/** Normalize TEC filer IDs for storage/display (no leading zeros). */
export function normalizeTecFilerId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.replace(/^0+(?=\d)/, "");
}

/** Strip leading zeros from all stored candidate TEC filer IDs. */
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
