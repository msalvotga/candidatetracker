import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrateCohHistoryToFinanceReports } from "./lib/candidates.mjs";
import { migrateGopShareToBenchmarkMargin, migrateLegShareToMargin } from "./lib/benchmarkMargin.mjs";
import { migrateFinanceSchema } from "./lib/financeMigration.mjs";
import { migrateTargetingAndConsultants } from "./lib/targetConsultantMigration.mjs";
import { migrateOfficeSeatHolders } from "./lib/seatHolderMigration.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "candidates.db");
const schemaPath = path.join(__dirname, "..", "schema.sql");

let db;

function runMigrations(database) {
  const cols = database.prepare(`PRAGMA table_info(candidates)`).all().map((c) => c.name);
  const addCandidateCol = (name, ddl) => {
    if (!cols.includes(name)) database.exec(ddl);
  };
  addCandidateCol("filed", `ALTER TABLE candidates ADD COLUMN filed INTEGER NOT NULL DEFAULT 0`);
  addCandidateCol("running_for_reelection", `ALTER TABLE candidates ADD COLUMN running_for_reelection TEXT`);
  addCandidateCol("tec_filer_id", `ALTER TABLE candidates ADD COLUMN tec_filer_id TEXT`);
  addCandidateCol("consultant", `ALTER TABLE candidates ADD COLUMN consultant TEXT`);
  addCandidateCol("endorsements", `ALTER TABLE candidates ADD COLUMN endorsements TEXT`);
  addCandidateCol("notes", `ALTER TABLE candidates ADD COLUMN notes TEXT`);
  addCandidateCol("website", `ALTER TABLE candidates ADD COLUMN website TEXT`);
  addCandidateCol("social_media", `ALTER TABLE candidates ADD COLUMN social_media TEXT`);
  addCandidateCol("race_category", `ALTER TABLE candidates ADD COLUMN race_category TEXT`);
  addCandidateCol("vuid", `ALTER TABLE candidates ADD COLUMN vuid TEXT`);
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_vuid ON candidates(vuid) WHERE vuid IS NOT NULL AND vuid != ''`
  );

  const candidateSql =
    database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidates'`).get()?.sql ?? "";
  const hasPartyUnique = candidateSql.includes("UNIQUE (office_id, cycle_year, party)");

  if (hasPartyUnique) {
    database.exec(`
      CREATE TABLE candidates_new (
        id INTEGER PRIMARY KEY,
        office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
        cycle_year INTEGER NOT NULL,
        party TEXT NOT NULL CHECK (party IN ('R', 'D', 'I', 'L', 'G', 'O')),
        name TEXT NOT NULL DEFAULT '',
        is_incumbent INTEGER NOT NULL DEFAULT 0 CHECK (is_incumbent IN (0, 1)),
        withdrew INTEGER NOT NULL DEFAULT 0 CHECK (withdrew IN (0, 1)),
        filed INTEGER NOT NULL DEFAULT 0 CHECK (filed IN (0, 1)),
        running_for_reelection TEXT,
        tec_filer_id TEXT,
        consultant TEXT,
        endorsements TEXT,
        notes TEXT,
        website TEXT,
        social_media TEXT,
        race_category TEXT
      );
      INSERT INTO candidates_new (
        id, office_id, cycle_year, party, name, is_incumbent, withdrew, filed,
        running_for_reelection, tec_filer_id, consultant, endorsements, notes, website, social_media, race_category
      )
      SELECT
        id, office_id, cycle_year, party, name, is_incumbent, withdrew,
        COALESCE(filed, 0), running_for_reelection, tec_filer_id, consultant, endorsements, notes, website, social_media, race_category
      FROM candidates;
      DROP TABLE candidates;
      ALTER TABLE candidates_new RENAME TO candidates;
      CREATE INDEX IF NOT EXISTS idx_candidates_office_cycle ON candidates(office_id, cycle_year);
      CREATE INDEX IF NOT EXISTS idx_candidates_lookup ON candidates(office_id, cycle_year, party, name);
    `);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS race_sheet_rows (
      id INTEGER PRIMARY KEY,
      office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
      cycle_year INTEGER NOT NULL,
      category TEXT NOT NULL,
      row_order INTEGER NOT NULL,
      incumbent_name TEXT NOT NULL DEFAULT '',
      incumbent_party TEXT,
      running_for_reelection TEXT,
      candidate_name TEXT NOT NULL DEFAULT '',
      candidate_party TEXT,
      filed INTEGER NOT NULL DEFAULT 0 CHECK (filed IN (0, 1)),
      tec_filer_id TEXT,
      consultant TEXT,
      endorsements TEXT,
      notes TEXT,
      social_media TEXT,
      website TEXT,
      race_category TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sheet_rows_category ON race_sheet_rows(category, cycle_year, row_order);
  `);

  const metricsSchemaPath = path.join(__dirname, "..", "schema-metrics.sql");
  if (fs.existsSync(metricsSchemaPath)) {
    database.exec(fs.readFileSync(metricsSchemaPath, "utf8"));
  }

  const targetsSchemaPath = path.join(__dirname, "..", "schema-targets.sql");
  if (fs.existsSync(targetsSchemaPath)) {
    database.exec(fs.readFileSync(targetsSchemaPath, "utf8"));
  }

  const hasCohHistory = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidate_coh_history'`)
    .get();
  if (hasCohHistory) {
    migrateCohHistoryToFinanceReports(database);
  }

  migrateGopShareToBenchmarkMargin(database);
  migrateLegShareToMargin(database);
  migrateFinanceSchema(database);
  migrateTargetingAndConsultants(database);
  migrateOfficeSeatHolders(database);
}

export function getDb() {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  runMigrations(db);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
