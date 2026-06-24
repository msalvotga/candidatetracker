import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "schema-postgres.sql");

const TABLES_IN_ORDER = [
  "offices",
  "candidates",
  "election_results",
  "filing_periods",
  "finance_reports",
  "race_sheet_rows",
  "office_metrics",
  "county_election_results",
  "metric_contest_candidates",
  "candidate_coh_history",
  "targeting_organizations",
  "office_targets",
  "consultants",
  "candidate_consultants",
  "app_meta",
];

const IDENTITY_TABLES = new Set([
  "offices",
  "candidates",
  "election_results",
  "finance_reports",
  "race_sheet_rows",
  "county_election_results",
  "metric_contest_candidates",
  "candidate_coh_history",
]);

function sqlitePathFromArgs() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  return path.join(__dirname, "..", "data", "candidates.db");
}

function pgUrlFromEnv() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

function listSqliteTables(sqlite) {
  return sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((row) => row.name);
}

async function resetPostgres(pool) {
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(`
    DO $$ DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
  await pool.query(schema);
}

async function copyTable(sqlite, pool, table) {
  if (!listSqliteTables(sqlite).includes(table)) {
    console.log(`  skip ${table} (not in SQLite)`);
    return 0;
  }

  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (columns.length === 0) return 0;

  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows`);
    return 0;
  }

  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const insertSql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const values = columns.map((col) => row[col]);
      await client.query(insertSql, values);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (IDENTITY_TABLES.has(table)) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`
    );
  }

  console.log(`  ${table}: ${rows.length} rows`);
  return rows.length;
}

async function main() {
  const sqliteFile = sqlitePathFromArgs();
  if (!fs.existsSync(sqliteFile)) {
    throw new Error(`SQLite file not found: ${sqliteFile}`);
  }

  console.log(`Reading SQLite: ${sqliteFile}`);
  const sqlite = new DatabaseSync(sqliteFile, { readOnly: true });
  const pool = new pg.Pool({
    connectionString: pgUrlFromEnv(),
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  try {
    console.log("Resetting PostgreSQL schema...");
    await resetPostgres(pool);

    console.log("Copying tables...");
    let total = 0;
    const sqliteTables = new Set(listSqliteTables(sqlite));
    for (const table of TABLES_IN_ORDER) {
      if (!sqliteTables.has(table)) continue;
      total += await copyTable(sqlite, pool, table);
    }

    const extras = [...sqliteTables].filter((t) => !TABLES_IN_ORDER.includes(t));
    for (const table of extras) {
      console.warn(`  warning: unmapped SQLite table "${table}" was not copied`);
    }

    console.log(`Done — imported ${total} rows.`);
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
