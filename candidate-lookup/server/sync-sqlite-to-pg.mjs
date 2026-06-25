import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sqlitePathFromArgs() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const dataPath = path.join(__dirname, "..", "data", "candidates.db");
  const rootPath = path.join(__dirname, "..", "candidates.db");
  if (fs.existsSync(dataPath)) return dataPath;
  return rootPath;
}

function pgUrlFromEnv() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

function sqliteCols(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

async function pgCols(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((row) => row.column_name);
}

async function buildPgOfficeIdByCode(pool) {
  const r = await pool.query(`SELECT id, office_code FROM offices`);
  return new Map(r.rows.map((row) => [row.office_code, row.id]));
}

function buildSqliteOfficeCodeById(sqlite) {
  const rows = sqlite.prepare(`SELECT id, office_code FROM offices`).all();
  return new Map(rows.map((row) => [row.id, row.office_code]));
}

async function resolvePgCandidateId(pool, sqlite, sqliteCandidateId, pgOfficeIdByCode, sqliteOfficeCodeById) {
  const row = sqlite
    .prepare(
      `SELECT office_id, cycle_year, party, name, is_incumbent FROM candidates WHERE id = ?`,
    )
    .get(sqliteCandidateId);
  if (!row) return null;
  const officeCode = sqliteOfficeCodeById.get(row.office_id);
  const pgOfficeId = pgOfficeIdByCode.get(officeCode);
  if (!pgOfficeId) return null;
  const pg = await pool.query(
    `SELECT id FROM candidates
     WHERE office_id = $1 AND cycle_year = $2 AND party = $3 AND name = $4 AND is_incumbent = $5
     LIMIT 1`,
    [pgOfficeId, row.cycle_year, row.party, row.name, row.is_incumbent],
  );
  return pg.rows[0]?.id ?? null;
}

async function syncOfficeHolders(sqlite, pool) {
  const cols = sqliteCols(sqlite, "offices");
  if (!cols.includes("seat_holder_name")) {
    console.warn("  offices: SQLite has no seat_holder columns — use data/candidates.db");
    return 0;
  }
  const rows = sqlite
    .prepare(
      `SELECT office_code, seat_holder_name, seat_holder_party
       FROM offices
       WHERE seat_holder_name IS NOT NULL AND TRIM(seat_holder_name) != ''`,
    )
    .all();
  let updated = 0;
  for (const row of rows) {
    const r = await pool.query(
      `UPDATE offices
       SET seat_holder_name = $1, seat_holder_party = $2
       WHERE office_code = $3
         AND (seat_holder_name IS NULL OR TRIM(seat_holder_name) = '' OR seat_holder_name IS DISTINCT FROM $1)`,
      [row.seat_holder_name, row.seat_holder_party ?? null, row.office_code],
    );
    updated += r.rowCount ?? 0;
  }
  console.log(`  offices seat holders: ${updated} updated (${rows.length} in SQLite)`);
  return updated;
}

async function upsertSimpleTable(sqlite, pool, table, keyColumn, valueColumns = []) {
  if (!sqliteCols(sqlite, table).length) return 0;
  const pgColumns = await pgCols(pool, table);
  const columns = [keyColumn, ...valueColumns].filter((c) => pgColumns.includes(c));
  if (!columns.includes(keyColumn)) return 0;

  const rows = sqlite.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  if (rows.length === 0) return 0;

  const sets = valueColumns
    .filter((c) => pgColumns.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const sql = sets
    ? `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
       ON CONFLICT (${keyColumn}) DO UPDATE SET ${sets}`
    : `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
       ON CONFLICT (${keyColumn}) DO NOTHING`;

  let upserted = 0;
  for (const row of rows) {
    const values = columns.map((c) => row[c]);
    const r = await pool.query(sql, values);
    upserted += r.rowCount ?? 0;
  }
  console.log(`  ${table}: ${rows.length} source rows, ${upserted} upserted`);
  return upserted;
}

async function syncCandidateConsultants(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById) {
  if (!sqliteCols(sqlite, "candidate_consultants").length) return 0;
  const rows = sqlite.prepare(`SELECT candidate_id, consultant_key FROM candidate_consultants`).all();
  let inserted = 0;
  for (const row of rows) {
    const pgCandidateId = await resolvePgCandidateId(
      pool,
      sqlite,
      row.candidate_id,
      pgOfficeIdByCode,
      sqliteOfficeCodeById,
    );
    if (!pgCandidateId) continue;
    const r = await pool.query(
      `INSERT INTO candidate_consultants (candidate_id, consultant_key)
       VALUES ($1, $2)
       ON CONFLICT (candidate_id, consultant_key) DO NOTHING`,
      [pgCandidateId, row.consultant_key],
    );
    inserted += r.rowCount ?? 0;
  }
  console.log(`  candidate_consultants: ${inserted} inserted (${rows.length} in SQLite)`);
  return inserted;
}

async function syncOfficeTargets(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById) {
  if (!sqliteCols(sqlite, "office_targets").length) return 0;
  const rows = sqlite.prepare(`SELECT office_id, cycle_year, org_key FROM office_targets`).all();
  let inserted = 0;
  for (const row of rows) {
    const officeCode = sqliteOfficeCodeById.get(row.office_id);
    const pgOfficeId = pgOfficeIdByCode.get(officeCode);
    if (!pgOfficeId) continue;
    const r = await pool.query(
      `INSERT INTO office_targets (office_id, cycle_year, org_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (office_id, cycle_year, org_key) DO NOTHING`,
      [pgOfficeId, row.cycle_year, row.org_key],
    );
    inserted += r.rowCount ?? 0;
  }
  console.log(`  office_targets: ${inserted} inserted (${rows.length} in SQLite)`);
  return inserted;
}

async function syncCandidateFields(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById) {
  const updateCols = [
    "running_for_reelection",
    "tec_filer_id",
    "consultant",
    "endorsements",
    "notes",
    "website",
    "social_media",
    "race_category",
    "vuid",
    "filed",
    "withdrew",
  ].filter((c) => sqliteCols(sqlite, "candidates").includes(c));

  const rows = sqlite
    .prepare(
      `SELECT c.id, c.office_id, c.cycle_year, c.party, c.name, c.is_incumbent,
              ${updateCols.map((c) => `c.${c}`).join(", ")}
       FROM candidates c`,
    )
    .all();

  let updated = 0;
  for (const row of rows) {
    const pgId = await resolvePgCandidateId(pool, sqlite, row.id, pgOfficeIdByCode, sqliteOfficeCodeById);
    if (!pgId) continue;

    const sets = [];
    const values = [];
    let n = 1;
    for (const col of updateCols) {
      const val = row[col];
      if (val == null || val === "") continue;
      sets.push(`${col} = CASE WHEN ${col} IS NULL OR TRIM(CAST(${col} AS TEXT)) = '' THEN $${n} ELSE ${col} END`);
      values.push(val);
      n += 1;
    }
    if (sets.length === 0) continue;
    values.push(pgId);
    const r = await pool.query(
      `UPDATE candidates SET ${sets.join(", ")} WHERE id = $${n}`,
      values,
    );
    updated += r.rowCount ?? 0;
  }
  console.log(`  candidates field merge: ${updated} rows updated`);
  return updated;
}

async function syncRaceSheetRows(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById) {
  const textCols = [
    "incumbent_name",
    "incumbent_party",
    "running_for_reelection",
    "candidate_name",
    "candidate_party",
    "tec_filer_id",
    "consultant",
    "endorsements",
    "notes",
    "social_media",
    "website",
    "race_category",
  ].filter((c) => sqliteCols(sqlite, "race_sheet_rows").includes(c));

  const rows = sqlite
    .prepare(
      `SELECT office_id, cycle_year, category, row_order, filed, ${textCols.join(", ")}
       FROM race_sheet_rows`,
    )
    .all();

  let updated = 0;
  for (const row of rows) {
    const officeCode = sqliteOfficeCodeById.get(row.office_id);
    const pgOfficeId = pgOfficeIdByCode.get(officeCode);
    if (!pgOfficeId) continue;

    const sets = [];
    const values = [];
    let n = 1;
    for (const col of textCols) {
      const val = row[col];
      if (val == null || val === "") continue;
      sets.push(
        `${col} = CASE WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN $${n} ELSE ${col} END`,
      );
      values.push(val);
      n += 1;
    }
    if (row.filed != null) {
      sets.push(`filed = CASE WHEN filed IS NULL OR filed = 0 THEN $${n} ELSE filed END`);
      values.push(row.filed);
      n += 1;
    }
    if (sets.length === 0) continue;

    values.push(pgOfficeId, row.cycle_year, row.category, row.row_order);
    const r = await pool.query(
      `UPDATE race_sheet_rows SET ${sets.join(", ")}
       WHERE office_id = $${n} AND cycle_year = $${n + 1} AND category = $${n + 2} AND row_order = $${n + 3}`,
      values,
    );
    updated += r.rowCount ?? 0;
  }
  console.log(`  race_sheet_rows field merge: ${updated} rows updated`);
  return updated;
}

async function syncOfficeMetrics(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById) {
  const rows = sqlite
    .prepare(`SELECT office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022 FROM office_metrics`)
    .all();
  let upserted = 0;
  for (const row of rows) {
    const officeCode = sqliteOfficeCodeById.get(row.office_id);
    const pgOfficeId = pgOfficeIdByCode.get(officeCode);
    if (!pgOfficeId) continue;
    const r = await pool.query(
      `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (office_id) DO UPDATE SET
         trump_2024 = COALESCE(EXCLUDED.trump_2024, office_metrics.trump_2024),
         cruz_2024 = COALESCE(EXCLUDED.cruz_2024, office_metrics.cruz_2024),
         abbott_2022 = COALESCE(EXCLUDED.abbott_2022, office_metrics.abbott_2022),
         leg_2024 = COALESCE(EXCLUDED.leg_2024, office_metrics.leg_2024),
         leg_2022 = COALESCE(EXCLUDED.leg_2022, office_metrics.leg_2022)`,
      [pgOfficeId, row.trump_2024, row.cruz_2024, row.abbott_2022, row.leg_2024, row.leg_2022],
    );
    upserted += r.rowCount ?? 0;
  }
  console.log(`  office_metrics: ${upserted} upserted (${rows.length} in SQLite)`);
  return upserted;
}

async function main() {
  const sqliteFile = sqlitePathFromArgs();
  if (!fs.existsSync(sqliteFile)) throw new Error(`SQLite file not found: ${sqliteFile}`);

  console.log(`Syncing from SQLite: ${sqliteFile}`);
  const sqlite = new DatabaseSync(sqliteFile, { readOnly: true });
  const pool = new pg.Pool({
    connectionString: pgUrlFromEnv(),
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  try {
    const pgOfficeIdByCode = await buildPgOfficeIdByCode(pool);
    const sqliteOfficeCodeById = buildSqliteOfficeCodeById(sqlite);

    console.log("Merging into PostgreSQL...");
    await upsertSimpleTable(sqlite, pool, "filing_periods", "period_key", ["label", "sort_order", "default_report_period_end"]);
    await upsertSimpleTable(sqlite, pool, "targeting_organizations", "org_key", ["name"]);
    await upsertSimpleTable(sqlite, pool, "consultants", "consultant_key", ["name"]);
    await upsertSimpleTable(sqlite, pool, "app_meta", "key", ["value"]);
    await syncOfficeHolders(sqlite, pool);
    await syncOfficeTargets(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById);
    await syncCandidateConsultants(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById);
    await syncCandidateFields(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById);
    await syncRaceSheetRows(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById);
    await syncOfficeMetrics(sqlite, pool, pgOfficeIdByCode, sqliteOfficeCodeById);

    const holders = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM offices WHERE seat_holder_name IS NOT NULL AND TRIM(seat_holder_name) != ''`,
      )
    ).rows[0].n;
    const consultants = (await pool.query(`SELECT COUNT(*)::int AS n FROM candidate_consultants`)).rows[0].n;
    console.log(`Done. Postgres now has ${holders} office seat holders and ${consultants} candidate-consultant links.`);
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
