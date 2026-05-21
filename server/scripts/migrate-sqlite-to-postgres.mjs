/**
 * Copy all data from a SQLite elections.db into PostgreSQL.
 *
 * Usage:
 *   $env:DATABASE_URL="postgresql://..."
 *   node server/scripts/migrate-sqlite-to-postgres.mjs [path/to/elections.db]
 *
 * Default SQLite path: server/data/elections.db, then ./elections.db
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import pg from "pg";
import { getDatabaseUrl } from "../lib/pgPool.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.wasm"));
const SCHEMA_PATH = path.join(__dirname, "../schema/postgres.sql");

const SKIP_TABLES = new Set(["sqlite_sequence", "ev_roster_voters_mig", "ev_roster_county_sources_new"]);

function resolveSqlitePath(arg) {
  const candidates = [
    arg,
    path.join(process.cwd(), "elections.db"),
    path.join(process.cwd(), "server", "data", "elections.db"),
    path.join(__dirname, "../data/elections.db"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return path.resolve(p);
  }
  throw new Error(
    `SQLite file not found. Pass path as argument or place elections.db in project root or server/data/.`,
  );
}

function sqliteTables(db) {
  const r = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return (r[0]?.values ?? []).map((row) => String(row[0]));
}

function sqliteColumns(db, table) {
  const stmt = db.prepare(`PRAGMA table_info("${table}")`);
  const cols = [];
  while (stmt.step()) {
    const o = stmt.getAsObject();
    cols.push({ name: String(o.name), type: String(o.type) });
  }
  stmt.free();
  return cols;
}

/** @param {pg.Pool} pool */
async function pgColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return new Set(r.rows.map((row) => row.column_name));
}

/** @param {import("sql.js").Database} sqliteDb */
function readAllRows(sqliteDb, table, colNames) {
  const quoted = colNames.map((c) => `"${c}"`).join(", ");
  const stmt = sqliteDb.prepare(`SELECT ${quoted} FROM "${table}"`);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** @param {pg.Pool} pool */
async function copyTable(pool, sqliteDb, table) {
  const sqliteCols = sqliteColumns(sqliteDb, table);
  if (!sqliteCols.length) return { table, copied: 0, skipped: "no columns" };

  const pgCols = await pgColumns(pool, table);
  if (!pgCols.size) return { table, copied: 0, skipped: "table missing in postgres" };

  const shared = sqliteCols.map((c) => c.name).filter((n) => pgCols.has(n));
  if (!shared.length) return { table, copied: 0, skipped: "no shared columns" };

  const rows = readAllRows(sqliteDb, table, shared);
  if (!rows.length) return { table, copied: 0 };

  await pool.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);

  const batchSize = 500;
  let copied = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const placeholders = chunk
      .map((_, ri) => `(${shared.map((_, ci) => `$${ri * shared.length + ci + 1}`).join(", ")})`)
      .join(", ");
    const values = [];
    for (const row of chunk) {
      for (const col of shared) {
        let v = row[col];
        if (v === undefined) v = null;
        values.push(v);
      }
    }
    await pool.query(
      `INSERT INTO "${table}" (${shared.map((c) => `"${c}"`).join(", ")}) VALUES ${placeholders}`,
      values,
    );
    copied += chunk.length;
  }

  if (shared.includes("id")) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1), true)`,
    ).catch(() => {});
  }

  return { table, copied };
}

async function main() {
  const sqlitePath = resolveSqlitePath(process.argv[2]);
  const databaseUrl = getDatabaseUrl();

  console.log("SQLite:", sqlitePath, `(${(fs.statSync(sqlitePath).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log("Postgres:", new URL(databaseUrl).host);

  const SQL = await initSqlJs({ locateFile: () => WASM_PATH, wasmBinary: fs.readFileSync(WASM_PATH) });
  const sqliteDb = new SQL.Database(fs.readFileSync(sqlitePath));

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  });

  try {
    console.log("Applying PostgreSQL schema…");
    const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
    await pool.query(schemaSql);

    const tables = sqliteTables(sqliteDb).filter((t) => !SKIP_TABLES.has(t));
    console.log(`Copying ${tables.length} tables…`);

    const order = [
      "data_sources",
      "ingest_vendors",
      "manual_elections",
      "election_snapshots",
      "sos_results",
      "sos_candidate_results",
      "sos_county_results",
      "county_results",
      "county_harris_results",
      "county_galveston_results",
      "county_jefferson_results",
      "county_chambers_results",
      "county_montgomery_results",
      "app_settings",
      "source_import_log",
      "election_source_configs",
      "election_feed_sources",
      "vote_update_history",
      "county_sos_race_links",
      "county_sos_manual_votes",
      "county_sos_race_vote_source",
      "ev_roster_configs",
      "ev_roster_pulls",
      "ev_roster_county_summary",
      "ev_roster_voters",
      "ev_roster_county_sources",
      "ev_roster_county_pull_log",
      "ev_roster_county_pull_status",
      "ev_roster_activity_cache",
      "ev_roster_registered_cache",
    ];
    const rest = tables.filter((t) => !order.includes(t));
    const sorted = [...order.filter((t) => tables.includes(t)), ...rest];

    for (const table of sorted) {
      const result = await copyTable(pool, sqliteDb, table);
      console.log(
        result.skipped
          ? `  skip ${table}: ${result.skipped}`
          : `  ${table}: ${result.copied} rows`,
      );
    }

    console.log("Done. Verify with: node server/scripts/inspectDbCounts.mjs");
  } finally {
    sqliteDb.close();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
