/**
 * Normalize all candidates.tec_filer_id values (remove leading zeros).
 *
 * Usage: node server/normalize-tec-filer-ids.mjs [--dry-run]
 */
import { closeDb, getDb, initDb } from "./db.mjs";
import { normalizeAllCandidateTecFilerIds, normalizeTecFilerId } from "./lib/tecFilerId.mjs";

const dryRun = process.argv.includes("--dry-run");

await initDb();
const db = getDb();

if (dryRun) {
  const rows = await db
    .prepare(
      `SELECT id, name, tec_filer_id FROM candidates
       WHERE tec_filer_id IS NOT NULL AND tec_filer_id != ''`
    )
    .all();
  const changes = rows.filter((row) => {
    const next = normalizeTecFilerId(row.tec_filer_id);
    return next !== String(row.tec_filer_id ?? "").trim();
  });
  console.log(`Would normalize ${changes.length} of ${rows.length} TEC filer ID(s).`);
  for (const row of changes.slice(0, 20)) {
    console.log(`  ${row.name}: ${row.tec_filer_id} -> ${normalizeTecFilerId(row.tec_filer_id)}`);
  }
  if (changes.length > 20) console.log(`  ... and ${changes.length - 20} more`);
} else {
  const result = await normalizeAllCandidateTecFilerIds(db);
  console.log(`Normalized ${result.updated} of ${result.scanned} TEC filer ID(s).`);
}

await closeDb();
