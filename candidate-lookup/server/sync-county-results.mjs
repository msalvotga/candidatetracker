import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { normalizeCountyResultRow } from "./lib/countyElection.mjs";

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

async function main() {
  const sqliteFile = sqlitePathFromArgs();
  if (!fs.existsSync(sqliteFile)) {
    throw new Error(`SQLite file not found: ${sqliteFile}`);
  }

  const sqlite = new DatabaseSync(sqliteFile, { readOnly: true });
  if (!sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='county_election_results'`).get()) {
    throw new Error("county_election_results table not found in SQLite");
  }

  const rows = sqlite.prepare(`SELECT * FROM county_election_results`).all();
  const pool = new pg.Pool({ connectionString: pgUrlFromEnv() });

  const insert = `
    INSERT INTO county_election_results (
      election_key, county_name, county_key, margin, gop_pct, dem_pct, gop_votes, dem_votes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (election_key, county_key) DO UPDATE SET
      county_name = EXCLUDED.county_name,
      margin = EXCLUDED.margin,
      gop_pct = EXCLUDED.gop_pct,
      dem_pct = EXCLUDED.dem_pct,
      gop_votes = EXCLUDED.gop_votes,
      dem_votes = EXCLUDED.dem_votes
  `;

  let upserted = 0;
  for (const row of rows) {
    const normalized = normalizeCountyResultRow(row);
    await pool.query(insert, [
      row.election_key,
      normalized.county_name,
      normalized.county_key,
      normalized.margin,
      normalized.gop_pct,
      normalized.dem_pct,
      normalized.gop_votes,
      normalized.dem_votes,
    ]);
    upserted += 1;
  }

  await pool.end();
  console.log(`Synced ${upserted} county result rows from ${sqliteFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
