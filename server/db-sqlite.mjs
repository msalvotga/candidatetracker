import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { resolveVoterActivityDate } from "./lib/evRosterVoterDates.mjs";
import {
  ensureEvRosterSummaryCacheSchemaSqlite,
  loadSummaryRollupsFromCache,
  rebuildEvRosterSummaryCache,
} from "./lib/evRosterSummaryCache.mjs";
import {
  restoreElectionConfigsFromBackup,
  applyDefaultCatalogFromBackup,
  writeElectionConfigBackup,
} from "./lib/electionConfigBackup.mjs";
import {
  restoreElectionFeedsFromBackup,
  restoreSingleElectionFeedsFromBackup,
  writeElectionFeedBackupForElection,
} from "./lib/electionFeedConfigBackup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Resolved via package exports: `"./dist/*": "./dist/*"`. */
const WASM_PATH = fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.wasm"));

export const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "elections.db");
const RECOVERY_DB_PATH = path.join(DATA_DIR, "elections.recovered.db");
const LEGACY_MANIFEST = path.join(DATA_DIR, "manual-manifest.json");
const LEGACY_MANUAL_DIR = path.join(DATA_DIR, "manual");

/** @type {import('sql.js').Database | null} */
let _db = null;
/** @type {Promise<import('sql.js').Database> | null} */
let _init = null;
let _dbMtimeMs = 0;
let _activeDbPath = DB_PATH;
let _dbReady = false;
let _electionSourceColumnsEnsured = false;
let _persistDebounceTimer = null;

function isMalformedError(err) {
  return /malformed/i.test(String(err?.message ?? err));
}

function isFileLockedError(err) {
  return /used by another process|EBUSY|EPERM/i.test(String(err?.message ?? err));
}

function isDbHealthy(db) {
  try {
    const rows = db.exec("PRAGMA quick_check;");
    const value = rows?.[0]?.values?.[0]?.[0];
    return String(value ?? "").toLowerCase() === "ok";
  } catch {
    return false;
  }
}

function selectWritableDbPath(preferredPath) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.closeSync(fs.openSync(preferredPath, "a"));
    return preferredPath;
  } catch {
    return RECOVERY_DB_PATH;
  }
}

const LARGE_DB_BYTES = 40 * 1024 * 1024;

function readHealthyDbFromPath(SQL, dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const st = fs.statSync(dbPath);
  const file = fs.readFileSync(dbPath);
  const db = new SQL.Database(file);
  if (!isDbHealthy(db)) return null;
  const skipCounts = st.size >= LARGE_DB_BYTES;
  return {
    db,
    path: dbPath,
    mtimeMs: st.mtimeMs,
    bytes: st.size,
    evRosterVoters: skipCounts ? 0 : countTableRows(db, "ev_roster_voters"),
    evRosterPulls: skipCounts ? 0 : countTableRows(db, "ev_roster_pulls"),
  };
}

function countTableRows(db, table) {
  try {
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
    stmt.step();
    const n = Number(stmt.getAsObject().n ?? 0);
    stmt.free();
    return n;
  } catch {
    return 0;
  }
}

/** Prefer the snapshot that actually has roster data; break ties with newest mtime / file size. */
function pickBestDbSnapshot(primary, recovery) {
  if (!primary) return recovery;
  if (!recovery) return primary;
  const score = (s) =>
    s.evRosterVoters * 1_000_000 +
    s.evRosterPulls * 1_000 +
    Number(s.bytes ?? 0) / 1024 +
    s.mtimeMs / 1e6;
  return score(recovery) > score(primary) ? recovery : primary;
}

/** Choose which on-disk file to open (only load one into memory). */
function pickDbPathToOpen() {
  const meta = (p) => {
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    return { path: p, mtimeMs: st.mtimeMs, bytes: st.size, evRosterVoters: 0, evRosterPulls: 0 };
  };
  const primary = meta(DB_PATH);
  const recovery = meta(RECOVERY_DB_PATH);
  const picked = pickBestDbSnapshot(primary, recovery);
  return picked?.path ?? DB_PATH;
}

/**
 * If elections.db / elections.recovered.db changed on disk (DB Browser, SSMS export, DELETE ALL),
 * replace the in-memory sql.js DB so we do not demote "ghost" rows that no longer exist on disk.
 * Uses strict mtime: any newer disk snapshot wins (no ms slack — that skipped reloads after quick saves).
 */
async function reloadFromDiskIfStale() {
  if (!_db) return;
  try {
    if (!isDbHealthy(_db)) return;
    const primaryMtime = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).mtimeMs : 0;
    const recoveryMtime = fs.existsSync(RECOVERY_DB_PATH) ? fs.statSync(RECOVERY_DB_PATH).mtimeMs : 0;
    const newestDiskMtime = Math.max(primaryMtime, recoveryMtime);
    if (newestDiskMtime <= _dbMtimeMs) return;
    const primaryBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    if (primaryBytes >= LARGE_DB_BYTES) {
      _dbMtimeMs = newestDiskMtime;
      return;
    }
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(WASM_PATH) });
      const picked = readHealthyDbFromPath(SQL, pickDbPathToOpen());
      if (picked) {
        _db = picked.db;
        _activeDbPath = DB_PATH;
        _dbMtimeMs = picked.mtimeMs;
        initSchema(_db);
      }
  } catch {
    /* keep current in-memory DB */
  }
}

async function recoverDatabaseInstance() {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(WASM_PATH) });
  _activeDbPath = DB_PATH;
  try {
    if (fs.existsSync(RECOVERY_DB_PATH)) {
      const file = fs.readFileSync(RECOVERY_DB_PATH);
      _db = new SQL.Database(file);
      _dbMtimeMs = fs.statSync(RECOVERY_DB_PATH).mtimeMs;
      if (!isDbHealthy(_db)) throw new Error("recovery database is malformed");
    } else {
      _db = new SQL.Database();
      _dbMtimeMs = 0;
    }
  } catch {
    _db = new SQL.Database();
    _dbMtimeMs = 0;
  }
  initSchema(_db);
  migrateLegacyJsonIfNeeded(_db);
  persistDb(_db);
  _dbReady = true;
  return _db;
}

function persistDbNow(db) {
  const targetPath = selectWritableDbPath(DB_PATH);
  _activeDbPath = DB_PATH;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const data = db.export();
  fs.writeFileSync(targetPath, Buffer.from(data));
  try {
    _dbMtimeMs = fs.statSync(targetPath).mtimeMs;
  } catch {
    _dbMtimeMs = 0;
  }
}

/** Full sql.js export needs ~2× file size RAM; avoid crashing the API process. */
function persistDbNowSafe(db) {
  try {
    persistDbNow(db);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/allocation failed|out of memory|Array buffer/i.test(msg)) {
      console.warn(
        "[db] Skipped writing elections.db to disk (not enough memory for full export). " +
          "Run with NODE_OPTIONS=--max-old-space-size=4096 or close other apps, then save again.",
      );
      return false;
    }
    throw err;
  }
  return true;
}

function persistDb(db) {
  const bytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  if (bytes >= LARGE_DB_BYTES) {
    clearTimeout(_persistDebounceTimer);
    _persistDebounceTimer = setTimeout(() => {
      _persistDebounceTimer = null;
      if (_db) persistDbNowSafe(_db);
    }, 8000);
    return false;
  }
  return persistDbNowSafe(db);
}

/** Flush a pending large-db write immediately (e.g. after saving county feeds). */
export function flushPendingDatabasePersist() {
  if (_persistDebounceTimer) {
    clearTimeout(_persistDebounceTimer);
    _persistDebounceTimer = null;
  }
  if (!_db) return false;
  return persistDbNowSafe(_db);
}

export function isDatabaseLoaded() {
  return _dbReady && _db != null;
}

function initSchema(db) {
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS data_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS manual_elections (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      data_json TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT 'manual-default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (source_id) REFERENCES data_sources(id)
    );
    CREATE INDEX IF NOT EXISTS idx_manual_elections_updated ON manual_elections(updated_at);
    CREATE TABLE IF NOT EXISTS election_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      label TEXT,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_provider_ext ON election_snapshots(provider, external_id);
    CREATE TABLE IF NOT EXISTS sos_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'sos-civix',
      election_id TEXT NOT NULL,
      election_label TEXT,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sos_results_election ON sos_results(election_id, fetched_at DESC);
    CREATE TABLE IF NOT EXISTS sos_candidate_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id TEXT NOT NULL,
      election_label TEXT,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sos_candidate_results_fetch ON sos_candidate_results(election_id, fetched_at DESC);
    CREATE TABLE IF NOT EXISTS sos_county_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id TEXT NOT NULL,
      election_label TEXT,
      county_name TEXT NOT NULL,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sos_county_results_fetch ON sos_county_results(election_id, county_name, fetched_at DESC);
    CREATE TABLE IF NOT EXISTS county_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id TEXT NOT NULL DEFAULT '56181',
      county_id TEXT NOT NULL,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      ballots_cast INTEGER NOT NULL DEFAULT 0,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      over_votes INTEGER NOT NULL DEFAULT 0,
      under_votes INTEGER NOT NULL DEFAULT 0,
      line_number INTEGER,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_county_results_fetch ON county_results(county_id, fetched_at DESC);
    CREATE TABLE IF NOT EXISTS election_source_configs (
      election_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      auto_refresh_enabled INTEGER NOT NULL DEFAULT 1,
      sos_countyinfo_url TEXT,
      harris_source_url TEXT,
      galveston_source_url TEXT,
      jefferson_source_url TEXT,
      montgomery_source_url TEXT,
      chambers_source_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vote_update_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vote_update_history_lookup
      ON vote_update_history(election_id, source_key, contest_name, choice_name, party_name, captured_at DESC);
    CREATE TABLE IF NOT EXISTS county_harris_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      ballots_cast INTEGER NOT NULL DEFAULT 0,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      over_votes INTEGER NOT NULL DEFAULT 0,
      under_votes INTEGER NOT NULL DEFAULT 0,
      line_number INTEGER,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_county_harris_results_fetch ON county_harris_results(fetched_at DESC);
    CREATE TABLE IF NOT EXISTS county_galveston_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      ballots_cast INTEGER NOT NULL DEFAULT 0,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      over_votes INTEGER NOT NULL DEFAULT 0,
      under_votes INTEGER NOT NULL DEFAULT 0,
      line_number INTEGER,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_county_galveston_results_fetch ON county_galveston_results(fetched_at DESC);
    CREATE TABLE IF NOT EXISTS county_jefferson_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      ballots_cast INTEGER NOT NULL DEFAULT 0,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      over_votes INTEGER NOT NULL DEFAULT 0,
      under_votes INTEGER NOT NULL DEFAULT 0,
      line_number INTEGER,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_county_jefferson_results_fetch ON county_jefferson_results(fetched_at DESC);
    CREATE TABLE IF NOT EXISTS county_chambers_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      ballots_cast INTEGER NOT NULL DEFAULT 0,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      over_votes INTEGER NOT NULL DEFAULT 0,
      under_votes INTEGER NOT NULL DEFAULT 0,
      line_number INTEGER,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_county_chambers_results_fetch ON county_chambers_results(fetched_at DESC);
    CREATE TABLE IF NOT EXISTS county_montgomery_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contest_name TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      percent_of_votes TEXT,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      ballots_cast INTEGER NOT NULL DEFAULT 0,
      precinct_total INTEGER NOT NULL DEFAULT 0,
      precinct_reporting INTEGER NOT NULL DEFAULT 0,
      over_votes INTEGER NOT NULL DEFAULT 0,
      under_votes INTEGER NOT NULL DEFAULT 0,
      line_number INTEGER,
      source_url TEXT,
      payload_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_county_montgomery_results_fetch ON county_montgomery_results(fetched_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS source_import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      ok INTEGER NOT NULL,
      message TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_source_import_log_key_occurred ON source_import_log(source_key, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS ingest_vendors (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      vendor_tier TEXT NOT NULL DEFAULT 'other',
      handler_key TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS election_feed_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'county',
      county_key TEXT NOT NULL DEFAULT '',
      civix_county_name TEXT,
      vendor_id TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      hub_page_url TEXT NOT NULL DEFAULT '',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_election_feed_sources_election ON election_feed_sources(election_id);
    CREATE TABLE IF NOT EXISTS county_sos_race_links (
      election_id TEXT NOT NULL,
      county_key TEXT NOT NULL,
      county_contest_name TEXT NOT NULL,
      sos_race_id TEXT NOT NULL,
      sos_race_name TEXT,
      link_type TEXT NOT NULL DEFAULT 'manual',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (election_id, county_key, county_contest_name)
    );
    CREATE TABLE IF NOT EXISTS county_sos_manual_votes (
      election_id TEXT NOT NULL,
      county_key TEXT NOT NULL,
      sos_race_id TEXT NOT NULL,
      sos_candidate_id TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (election_id, county_key, sos_race_id, sos_candidate_id)
    );
    CREATE TABLE IF NOT EXISTS county_sos_race_vote_source (
      election_id TEXT NOT NULL,
      county_key TEXT NOT NULL,
      sos_race_id TEXT NOT NULL,
      vote_source TEXT NOT NULL DEFAULT 'sos',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (election_id, county_key, sos_race_id)
    );
  `);
  db.run(
    `INSERT OR IGNORE INTO data_sources (id, kind, display_name, notes)
     VALUES ('manual-default', 'manual_json', 'Manual JSON upload', 'Rows in manual_elections')`,
  );
  db.run(
    `INSERT OR IGNORE INTO data_sources (id, kind, display_name, notes)
     VALUES ('sos-civix', 'sos', 'Texas SOS Civix ENR', 'Live SOS results from Civix ENR')`,
  );
  db.run(
    `INSERT OR IGNORE INTO data_sources (id, kind, display_name, notes)
     VALUES ('county-harrisvotes', 'county', 'Harris Votes', 'County-level JSON feed from app.harrisvotes.com/appfiles.harrisvotes.com')`,
  );
  db.run(
    `INSERT OR IGNORE INTO data_sources (id, kind, display_name, notes)
     VALUES ('county-galveston-clarity', 'county', 'Galveston Clarity', 'summary.zip -> summary.csv parsed for county race results')`,
  );
  db.run(
    `INSERT OR IGNORE INTO data_sources (id, kind, display_name, notes)
     VALUES ('county-jefferson-clarity', 'county', 'Jefferson Clarity', 'summary.zip -> summary.csv parsed for county race results')`,
  );
  db.run(
    `INSERT OR IGNORE INTO data_sources (id, kind, display_name, notes)
     VALUES ('county-chambers', 'county', 'Chambers County', 'County table provisioned; pull logic pending')`,
  );
  db.run(
    `INSERT OR IGNORE INTO data_sources (id, kind, display_name, notes)
     VALUES ('county-montgomery', 'county', 'Montgomery County', 'County table provisioned; pull logic pending')`,
  );
  db.run(
    `INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('disable_auto_ingest', 'false')`,
  );
  db.run(
    `INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('auto_refresh_enabled', 'false')`,
  );
  db.run(
    `INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('auto_refresh_interval_sec', '60')`,
  );
  db.run(
    `INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('display_time_zone', 'America/Chicago')`,
  );
  db.run(
    `INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('sos_countyinfo_url', '')`,
  );
  db.run(`INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('harris_source_url', '')`);
  db.run(`INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('galveston_source_url', '')`);
  db.run(`INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('jefferson_source_url', '')`);
  db.run(`INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('montgomery_source_url', '')`);
  db.run(`INSERT OR IGNORE INTO app_settings (setting_key, value_json) VALUES ('chambers_source_url', '')`);
  db.run(
    `INSERT OR IGNORE INTO election_source_configs
      (election_id, label, is_enabled, auto_refresh_enabled, sos_countyinfo_url, harris_source_url, galveston_source_url, jefferson_source_url, montgomery_source_url, chambers_source_url)
     VALUES
      ('56181', 'May 2, 2026 Special Election', 1, 1, '', '', '', '', '', '')`,
  );
  seedIngestVendorsSqlite(db);
  ensureCountyResultsColumns(db);
  ensureElectionSourceConfigColumns(db);
  ensureElectionFeedSourcesHubColumn(db);
  ensureEvRosterSchema(db);
  ensureCountyRaceMappingTables(db);
}

function ensureEvRosterSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS ev_roster_configs (
      evr_election_id INTEGER PRIMARY KEY,
      party TEXT NOT NULL,
      election_name TEXT NOT NULL,
      election_date TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ev_roster_pulls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evr_election_id INTEGER NOT NULL,
      voting_date TEXT NOT NULL,
      hub_page_url TEXT,
      sos_turnout_url TEXT,
      sos_roster_url TEXT,
      statewide_voter_count INTEGER NOT NULL DEFAULT 0,
      pulled_at TEXT NOT NULL DEFAULT (datetime('now')),
      ok INTEGER NOT NULL DEFAULT 1,
      message TEXT NOT NULL DEFAULT '',
      UNIQUE(evr_election_id, voting_date)
    );
    CREATE INDEX IF NOT EXISTS idx_ev_roster_pulls_election ON ev_roster_pulls(evr_election_id, voting_date DESC);
    CREATE TABLE IF NOT EXISTS ev_roster_county_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pull_id INTEGER NOT NULL,
      county_name TEXT NOT NULL,
      county_id INTEGER,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      in_person_votes_on_date INTEGER NOT NULL DEFAULT 0,
      total_in_person_votes_for_election INTEGER NOT NULL DEFAULT 0,
      total_mail_votes_for_election INTEGER NOT NULL DEFAULT 0,
      cumulative_total INTEGER NOT NULL DEFAULT 0,
      sos_voter_count INTEGER NOT NULL DEFAULT 0,
      county_voter_count INTEGER NOT NULL DEFAULT 0,
      chosen_source TEXT NOT NULL DEFAULT 'sos',
      chosen_voter_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (pull_id) REFERENCES ev_roster_pulls(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ev_roster_county_pull ON ev_roster_county_summary(pull_id, county_name);
    CREATE TABLE IF NOT EXISTS ev_roster_voters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evr_election_id INTEGER NOT NULL,
      voting_date TEXT NOT NULL,
      county_name TEXT NOT NULL,
      vuid TEXT NOT NULL,
      voter_name TEXT,
      voting_method TEXT,
      precinct TEXT,
      source TEXT NOT NULL DEFAULT 'sos',
      UNIQUE(evr_election_id, voting_date, vuid)
    );
    CREATE INDEX IF NOT EXISTS idx_ev_roster_voters_lookup ON ev_roster_voters(evr_election_id, voting_date, county_name);
    CREATE TABLE IF NOT EXISTS ev_roster_county_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evr_election_id INTEGER NOT NULL,
      county_key TEXT NOT NULL,
      variant_key TEXT NOT NULL DEFAULT 'sos-default',
      source_label TEXT NOT NULL DEFAULT '',
      civix_county_name TEXT NOT NULL,
      civix_county_id INTEGER,
      handler_key TEXT NOT NULL DEFAULT 'civix_sos_county_slice',
      hub_page_url TEXT NOT NULL DEFAULT '',
      roster_url TEXT NOT NULL DEFAULT '',
      voting_method_scope TEXT NOT NULL DEFAULT 'ALL',
      date_scope TEXT NOT NULL DEFAULT 'SINGLE_DAY',
      file_format TEXT NOT NULL DEFAULT 'auto',
      discovery_profile_key TEXT,
      training_notes TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_pull_ok INTEGER,
      last_pull_message TEXT,
      last_pull_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(evr_election_id, county_key, variant_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ev_roster_county_sources_election ON ev_roster_county_sources(evr_election_id);
    CREATE TABLE IF NOT EXISTS ev_roster_county_pull_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pull_id INTEGER NOT NULL,
      county_key TEXT NOT NULL,
      county_name TEXT NOT NULL,
      handler_key TEXT NOT NULL,
      ok INTEGER NOT NULL,
      voter_count INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      message TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (pull_id) REFERENCES ev_roster_pulls(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ev_roster_county_pull_log ON ev_roster_county_pull_log(pull_id, county_key);
  `);
  db.run(
    `INSERT OR IGNORE INTO ev_roster_configs (evr_election_id, party, election_name, election_date, notes)
     VALUES (58315, 'REP', '2026 REPUBLICAN PRIMARY RUNOFF ELECTION', '05/26/2026', 'Civix EVR — statewide roster + county totals')`,
  );
  db.run(
    `INSERT OR IGNORE INTO ev_roster_configs (evr_election_id, party, election_name, election_date, notes)
     VALUES (58314, 'DEM', '2026 DEMOCRATIC PRIMARY RUNOFF ELECTION', '05/26/2026', 'Civix EVR — statewide roster + county totals')`,
  );
  ensureEvRosterVoterColumns(db);
  ensureEvRosterVoterCountyUnique(db);
  ensureEvRosterCountySourceVariantSchema(db);
  ensureEvRosterRosterPartyScopeColumn(db);
  ensureEvRosterCountyPullStatusTable(db);
  ensureEvRosterSummaryCacheSchemaSqlite(db);
}

function ensureEvRosterCountyPullStatusTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS ev_roster_county_pull_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evr_election_id INTEGER NOT NULL,
      voting_date TEXT NOT NULL,
      county_name TEXT NOT NULL,
      county_key TEXT,
      last_pull_ok INTEGER,
      last_pull_at TEXT,
      last_pull_message TEXT,
      voter_count INTEGER NOT NULL DEFAULT 0,
      confirmed_at TEXT,
      UNIQUE(evr_election_id, voting_date, county_name)
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_ev_roster_county_pull_status ON ev_roster_county_pull_status(evr_election_id, voting_date)`,
  );
}

/** Allow the same VUID on different counties (incremental county pulls must not steal rows). */
function ensureEvRosterVoterCountyUnique(db) {
  const row = db.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ev_roster_voters'`)[0]
    ?.values?.[0]?.[0];
  const ddl = String(row ?? "");
  if (!ddl || (ddl.includes("county_name") && /UNIQUE\s*\([^)]*county_name/i.test(ddl))) return;

  db.run(`
    CREATE TABLE ev_roster_voters_mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evr_election_id INTEGER NOT NULL,
      voting_date TEXT NOT NULL,
      county_name TEXT NOT NULL,
      vuid TEXT NOT NULL,
      voter_name TEXT,
      voting_method TEXT,
      precinct TEXT,
      source TEXT NOT NULL DEFAULT 'sos',
      party TEXT,
      method_code TEXT,
      UNIQUE(evr_election_id, voting_date, county_name, vuid)
    )
  `);
  db.run(`
    INSERT INTO ev_roster_voters_mig
      (id, evr_election_id, voting_date, county_name, vuid, voter_name, voting_method, precinct, source, party, method_code)
    SELECT id, evr_election_id, voting_date, county_name, vuid, voter_name, voting_method, precinct, source, party, method_code
    FROM ev_roster_voters
  `);
  db.run(`DROP TABLE ev_roster_voters`);
  db.run(`ALTER TABLE ev_roster_voters_mig RENAME TO ev_roster_voters`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_ev_roster_voters_lookup ON ev_roster_voters(evr_election_id, voting_date, county_name)`,
  );
}

function ensureEvRosterRosterPartyScopeColumn(db) {
  const cols = db.exec(`PRAGMA table_info(ev_roster_county_sources)`)[0]?.values?.map((r) => r[1]) ?? [];
  if (!cols.length || cols.includes("roster_party_scope")) return;
  db.run(
    `ALTER TABLE ev_roster_county_sources ADD COLUMN roster_party_scope TEXT NOT NULL DEFAULT 'COMBINED'`,
  );
}

function ensureEvRosterCountySourceVariantSchema(db) {
  const cols = db.exec(`PRAGMA table_info(ev_roster_county_sources)`)[0]?.values?.map((r) => r[1]) ?? [];
  if (!cols.length) return;
  if (cols.includes("variant_key")) return;

  db.run(`
    CREATE TABLE ev_roster_county_sources_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evr_election_id INTEGER NOT NULL,
      county_key TEXT NOT NULL,
      variant_key TEXT NOT NULL DEFAULT 'sos-default',
      source_label TEXT NOT NULL DEFAULT 'SOS default',
      civix_county_name TEXT NOT NULL,
      civix_county_id INTEGER,
      handler_key TEXT NOT NULL DEFAULT 'civix_sos_county_slice',
      hub_page_url TEXT NOT NULL DEFAULT '',
      roster_url TEXT NOT NULL DEFAULT '',
      voting_method_scope TEXT NOT NULL DEFAULT 'ALL',
      date_scope TEXT NOT NULL DEFAULT 'SINGLE_DAY',
      file_format TEXT NOT NULL DEFAULT 'auto',
      discovery_profile_key TEXT,
      training_notes TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_pull_ok INTEGER,
      last_pull_message TEXT,
      last_pull_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(evr_election_id, county_key, variant_key)
    )
  `);
  db.run(`
    INSERT INTO ev_roster_county_sources_new
      (id, evr_election_id, county_key, variant_key, source_label, civix_county_name, civix_county_id,
       handler_key, hub_page_url, roster_url, voting_method_scope, date_scope, file_format,
       discovery_profile_key, training_notes, is_enabled, last_pull_ok, last_pull_message, last_pull_at, created_at, updated_at)
    SELECT id, evr_election_id, county_key, 'sos-default', 'SOS default', civix_county_name, civix_county_id,
       handler_key, hub_page_url, roster_url, 'ALL', 'SINGLE_DAY', 'auto',
       discovery_profile_key, training_notes, is_enabled, last_pull_ok, last_pull_message, last_pull_at, created_at, updated_at
    FROM ev_roster_county_sources
  `);
  db.run(`DROP TABLE ev_roster_county_sources`);
  db.run(`ALTER TABLE ev_roster_county_sources_new RENAME TO ev_roster_county_sources`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ev_roster_county_sources_election ON ev_roster_county_sources(evr_election_id)`);
}

function ensureEvRosterVoterColumns(db) {
  const cols = db.exec(`PRAGMA table_info(ev_roster_voters)`)[0]?.values?.map((r) => r[1]) ?? [];
  if (!cols.includes("party")) db.run(`ALTER TABLE ev_roster_voters ADD COLUMN party TEXT`);
  if (!cols.includes("method_code")) db.run(`ALTER TABLE ev_roster_voters ADD COLUMN method_code TEXT`);
  if (!cols.includes("reporting_date")) {
    db.run(`ALTER TABLE ev_roster_voters ADD COLUMN reporting_date TEXT`);
    db.run(`UPDATE ev_roster_voters SET reporting_date = voting_date WHERE reporting_date IS NULL OR reporting_date = ''`);
  }
  const pullCols = db.exec(`PRAGMA table_info(ev_roster_pulls)`)[0]?.values?.map((r) => r[1]) ?? [];
  if (!pullCols.includes("raw_record_count")) db.run(`ALTER TABLE ev_roster_pulls ADD COLUMN raw_record_count INTEGER NOT NULL DEFAULT 0`);
  if (!pullCols.includes("deduped_voter_count")) {
    db.run(`ALTER TABLE ev_roster_pulls ADD COLUMN deduped_voter_count INTEGER NOT NULL DEFAULT 0`);
  }
}

function ensureElectionFeedSourcesHubColumn(db) {
  try {
    const r = db.exec(`PRAGMA table_info(election_feed_sources)`);
    const cols = r?.[0]?.values ?? [];
    const names = cols.map((row) => row[1]);
    if (!names.includes("hub_page_url")) {
      db.run(`ALTER TABLE election_feed_sources ADD COLUMN hub_page_url TEXT NOT NULL DEFAULT ''`);
      persistDb(db);
    }
  } catch {
    /* ignore */
  }
}

function ensureElectionFeedSourcesPreferOverSosColumn(db) {
  try {
    const r = db.exec(`PRAGMA table_info(election_feed_sources)`);
    const cols = r?.[0]?.values ?? [];
    const names = cols.map((row) => row[1]);
    if (!names.includes("prefer_over_sos")) {
      db.run(`ALTER TABLE election_feed_sources ADD COLUMN prefer_over_sos INTEGER NOT NULL DEFAULT 0`);
      persistDb(db);
    }
    migrateCountyPreferJsonToFeedsSqlite(db);
  } catch {
    /* ignore */
  }
}

/** One-time: copy legacy election_source_configs.county_prefer_over_sos_json onto matching feed rows, then clear JSON. */
function migrateCountyPreferJsonToFeedsSqlite(db) {
  try {
    ensureElectionSourceConfigColumns(db);
    const sel = db.prepare(`SELECT election_id, county_prefer_over_sos_json FROM election_source_configs`);
    while (sel.step()) {
      const row = sel.getAsObject();
      const eid = String(row.election_id ?? "");
      const raw = String(row.county_prefer_over_sos_json ?? "[]").trim();
      if (!raw || raw === "[]") continue;
      let keys = [];
      try {
        keys = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(keys) || !keys.length) continue;
      const upd = db.prepare(
        `UPDATE election_feed_sources SET prefer_over_sos = 1 WHERE election_id = ? AND lower(county_key) = lower(?)`,
      );
      for (const k of keys) {
        const slug = String(k ?? "")
          .trim()
          .toLowerCase();
        if (!slug) continue;
        upd.run([eid, slug]);
      }
      upd.free();
      db.run(`UPDATE election_source_configs SET county_prefer_over_sos_json = '[]' WHERE election_id = ?`, [eid]);
    }
    sel.free();
    persistDb(db);
  } catch {
    /* ignore */
  }
}

function ensureElectionSourceConfigColumns(db) {
  if (_electionSourceColumnsEnsured) return;
  try {
    const r = db.exec(`PRAGMA table_info(election_source_configs)`);
    const cols = r?.[0]?.values ?? [];
    const names = cols.map((row) => row[1]);
    if (!names.includes("uses_civix_sos")) {
      db.run(`ALTER TABLE election_source_configs ADD COLUMN uses_civix_sos INTEGER NOT NULL DEFAULT 1`);
      persistDb(db);
    }
    if (!names.includes("show_in_catalog")) {
      db.run(`ALTER TABLE election_source_configs ADD COLUMN show_in_catalog INTEGER NOT NULL DEFAULT 1`);
      persistDb(db);
    }
    if (!names.includes("is_default_catalog")) {
      db.run(`ALTER TABLE election_source_configs ADD COLUMN is_default_catalog INTEGER NOT NULL DEFAULT 0`);
      db.run(`UPDATE election_source_configs SET is_default_catalog = 1 WHERE election_id = '56181'`);
      const marked = db.exec(`SELECT COUNT(*) AS n FROM election_source_configs WHERE is_default_catalog = 1`);
      const n = Number(marked?.[0]?.values?.[0]?.[0] ?? 0);
      if (n === 0) {
        db.run(
          `UPDATE election_source_configs SET is_default_catalog = 1
           WHERE election_id = (SELECT election_id FROM election_source_configs ORDER BY election_id LIMIT 1)`,
        );
      }
      persistDb(db);
    }
    if (!names.includes("county_prefer_over_sos_json")) {
      db.run(`ALTER TABLE election_source_configs ADD COLUMN county_prefer_over_sos_json TEXT NOT NULL DEFAULT '[]'`);
      persistDb(db);
    }
    _electionSourceColumnsEnsured = true;
  } catch {
    _electionSourceColumnsEnsured = true;
  }
}

function seedIngestVendorsSqlite(db) {
  const rows = [
    ["civix-sos", "Texas SOS / Civix ENR", "enr", "civix_sos", "Civix applies only to statewide SOS (election + countyInfo). County feeds use ingest processes, not Civix."],
    ["harris-pdf", "Harris Votes (PDF cumulative)", "enr", "harris_pdf", "Harris cumulative PDF layout (distinct line format from Montgomery/Chambers)."],
    [
      "clarity-enr-summary-zip",
      "Clarity ENR (summary.zip)",
      "enr",
      "clarity_enr_summary_zip",
      "ElectionSystems Clarity: summary.zip → summary.csv for any county URL. Imports all contests; align comparable races when combining totals across counties.",
    ],
    ["montgomery-pdf", "Montgomery cumulative PDF (SD4)", "enr", "montgomery_pdf", "Official cumulative results PDF from the county (not the live eResults web page)."],
    [
      "montgomery-eresults-html",
      "Montgomery County eResults (live HTML)",
      "enr",
      "montgomery_eresults_html",
      "Live ASP.NET eResults page (elections.mctx.org). Paste the browser URL for the results page — parses SD4 from HTML tables.",
    ],
    ["chambers-pdf", "Chambers cumulative PDF (SD4)", "enr", "chambers_pdf", "Cumulative PDF SD4 parser. Related to Montgomery (both PDF text → SD4) but line formats differ — not the same code path."],
    [
      "dallas-pdf",
      "Dallas County (Electionware summary PDF)",
      "enr",
      "dallas_pdf",
      "Dallas County Votes: Electionware 'Summary Results Report' PDF (Final Election Night). Imports all contests in the file; layout differs from Harris / Montgomery / Chambers PDFs.",
    ],
    [
      "collin-pdf",
      "Collin County (Electionware EV summary PDF)",
      "enr",
      "collin_electionware_pdf",
      "Collin County Electionware early-voting summary PDF (Mail + Early Voting columns). Example: collincountytx.gov/.../early-voting-summary-report.pdf. Imports all contests in the file.",
    ],
    [
      "cameron-pdf",
      "Cameron County (results / reconciliation PDF)",
      "enr",
      "cameron_pdf",
      "Cameron County PDFs: Electionware summary (all contests) when posted, or SOS Form 12-1 preliminary reconciliation (P26-*-reconciliation-REP/DEM.pdf) for turnout totals only — not per-candidate SD4 from reconciliation alone.",
    ],
    [
      "hays-pdf",
      "Hays County (eGovlink cumulative PDF)",
      "enr",
      "hays_egovlink_cumulative_pdf",
      "Hays County official cumulative results PDF on egovlink.com (Absentee + Early + Election Day columns). Example: …/Cumulative Results - Democratic Party - official.pdf",
    ],
    [
      "mclennan-pdf",
      "McLennan County (CivicPlus cumulative PDF)",
      "enr",
      "mclennan_civicplus_cumulative_pdf",
      "McLennan County official cumulative PDF on tx-mclennancounty.civicplus.com (Absentee + Early + Election Day). Separate DEM/REP PDFs.",
    ],
    [
      "ellis-enr-html",
      "Ellis County (livevoterturnout ENR HTML)",
      "enr",
      "ellis_livevoterturnout_html",
      "Ellis County Election Night Results on livevoterturnout.com — paste Index URL (e.g. …/ellistxenr/9/en/Index_9.html). Sums all precinct tables to county totals.",
    ],
    ["other-vendor", "Other / custom (no ingest yet)", "other", "unimplemented", "Document the URL; automated ingest can be added later."],
  ];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ingest_vendors (id, display_name, vendor_tier, handler_key, notes, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  );
  for (const r of rows) stmt.run(r);
  stmt.free();
  migrateClarityProcessSqlite(db);
  syncIngestVendorMetadataSqlite(db);
}

/** Point legacy Clarity feeds at the unified process and drop obsolete ingest_vendors rows. */
function migrateClarityProcessSqlite(db) {
  db.run(
    `UPDATE election_feed_sources SET vendor_id = 'clarity-enr-summary-zip', updated_at = datetime('now')
     WHERE vendor_id IN ('clarity-galveston-sd4', 'clarity-jefferson-sd4')`,
  );
  db.run(`DELETE FROM ingest_vendors WHERE id IN ('clarity-galveston-sd4', 'clarity-jefferson-sd4')`);
}

/** Refresh notes/tiers for existing DBs. */
function syncIngestVendorMetadataSqlite(db) {
  const patches = [
    [
      "clarity-enr-summary-zip",
      "Clarity ENR (summary.zip)",
      "enr",
      "ElectionSystems Clarity: summary.zip → summary.csv for any county URL. Imports all contests; align comparable races when combining totals across counties.",
    ],
    [
      "montgomery-pdf",
      "Montgomery cumulative PDF (SD4)",
      "enr",
      "Official cumulative results PDF from the county (not the live eResults web page).",
    ],
    [
      "montgomery-eresults-html",
      "Montgomery County eResults (live HTML)",
      "enr",
      "Live ASP.NET eResults page (elections.mctx.org). Paste the browser URL for the results page — parses SD4 from HTML tables.",
    ],
    [
      "chambers-pdf",
      "Chambers cumulative PDF (SD4)",
      "enr",
      "Cumulative PDF SD4 parser. Related to Montgomery (both PDF text → SD4) but line formats differ — not the same code path.",
    ],
    [
      "dallas-pdf",
      "Dallas County (Electionware summary PDF)",
      "enr",
      "Dallas County Votes: Electionware 'Summary Results Report' PDF (Final Election Night). Imports all contests in the file; layout differs from Harris / Montgomery / Chambers PDFs.",
    ],
    [
      "collin-pdf",
      "Collin County (Electionware EV summary PDF)",
      "enr",
      "Collin County Electionware early-voting summary PDF (Mail + Early Voting). Imports all contests in the file.",
    ],
    [
      "cameron-pdf",
      "Cameron County (results / reconciliation PDF)",
      "enr",
      "Cameron County PDFs: Electionware summary when posted, or SOS preliminary reconciliation (P26-*-reconciliation-*.pdf) for turnout only.",
    ],
    [
      "hays-pdf",
      "Hays County (eGovlink cumulative PDF)",
      "enr",
      "Hays egovlink.com cumulative results PDF (official). Imports all contests; separate DEM/REP PDFs per party.",
    ],
    [
      "mclennan-pdf",
      "McLennan County (CivicPlus cumulative PDF)",
      "enr",
      "McLennan CivicPlus cumulative PDF (official). Imports all contests; separate DEM/REP PDFs per party.",
    ],
    [
      "ellis-enr-html",
      "Ellis County (livevoterturnout ENR HTML)",
      "enr",
      "Ellis livevoterturnout.com ENR Index page — imports all contests (precinct tables summed to county).",
    ],
    ["harris-pdf", "Harris Votes (PDF cumulative)", "enr", "Harris cumulative PDF layout (distinct line format from Montgomery/Chambers)."],
  ];
  const u = db.prepare(
    `UPDATE ingest_vendors SET display_name = ?, vendor_tier = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  for (const [id, displayName, tier, notes] of patches) {
    u.run([displayName, tier, notes, id]);
  }
  u.free();
}

function ensureCountyResultsColumns(db) {
  try {
    const r = db.exec(`PRAGMA table_info(county_results)`);
    const cols = r?.[0]?.values ?? [];
    const names = cols.map((row) => row[1]);
    // Best-effort schema cleanup for existing DBs.
    if (names.includes("curr_in")) {
      try {
        db.run(`ALTER TABLE county_results DROP COLUMN curr_in`);
      } catch {
        /* ignore sqlite versions that don't support DROP COLUMN */
      }
    }
    if (names.includes("old_in")) {
      try {
        db.run(`ALTER TABLE county_results DROP COLUMN old_in`);
      } catch {
        /* ignore sqlite versions that don't support DROP COLUMN */
      }
    }
    if (!names.includes("election_id")) {
      try {
        db.run(`ALTER TABLE county_results ADD COLUMN election_id TEXT NOT NULL DEFAULT '56181'`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** @returns {boolean} true if rows were imported from legacy JSON */
function migrateLegacyJsonIfNeeded(db) {
  const cStmt = db.prepare("SELECT COUNT(*) AS c FROM manual_elections");
  cStmt.step();
  const count = Number(cStmt.getAsObject().c);
  cStmt.free();
  if (count > 0) return false;
  if (!fs.existsSync(LEGACY_MANIFEST)) return false;

  const manifest = JSON.parse(fs.readFileSync(LEGACY_MANIFEST, "utf8"));
  const ins = db.prepare(
    `INSERT INTO manual_elections (id, label, data_json, source_id, created_at, updated_at)
     VALUES (?, ?, ?, 'manual-default', ?, ?)`,
  );

  for (const e of manifest.elections || []) {
    const fp = path.join(LEGACY_MANUAL_DIR, e.filename);
    if (!fs.existsSync(fp)) continue;
    const dataJson = fs.readFileSync(fp, "utf8");
    const updatedAt = e.updatedAt || new Date().toISOString();
    ins.run([e.id, e.label, dataJson, updatedAt, updatedAt]);
  }
  ins.free();

  try {
    fs.renameSync(LEGACY_MANIFEST, `${LEGACY_MANIFEST}.migrated`);
  } catch {
    /* ignore */
  }
  persistDb(db);
  return true;
}

export async function ensureDb() {
  if (_db && _dbReady) {
    try {
      if (!isDbHealthy(_db)) {
        _dbReady = false;
        return await recoverDatabaseInstance();
      }
      await reloadFromDiskIfStale();
    } catch (err) {
      if (isMalformedError(err) || isFileLockedError(err)) {
        return await recoverDatabaseInstance();
      }
      // If stat/read fails for other reasons, keep current in-memory DB.
    }
    return _db;
  }
  if (_init) return _init;
  _init = (async () => {
    const wasmBinary = fs.readFileSync(WASM_PATH);
    const SQL = await initSqlJs({ wasmBinary });
    let picked = null;
    let consolidatedFromRecovery = false;
    try {
      const openPath = pickDbPathToOpen();
      consolidatedFromRecovery = openPath !== DB_PATH;
      picked = readHealthyDbFromPath(SQL, openPath);
      if (picked) {
        _db = picked.db;
        _activeDbPath = DB_PATH;
        _dbMtimeMs = picked.mtimeMs;
        if (consolidatedFromRecovery) {
          console.warn(
            `Using EV roster data from ${path.basename(picked.path)} (${(picked.bytes / 1024 / 1024).toFixed(1)} MB); consolidating into elections.db`,
          );
        } else if (picked.bytes >= LARGE_DB_BYTES) {
          console.log(`Opened ${path.basename(openPath)} (${(picked.bytes / 1024 / 1024).toFixed(1)} MB)`);
        }
      } else {
        _db = new SQL.Database();
        _activeDbPath = DB_PATH;
        _dbMtimeMs = 0;
      }
    } catch (err) {
      // Primary DB is corrupted/locked; continue on a clean recovery file.
      if (!isMalformedError(err) && !isFileLockedError(err)) throw err;
      return await recoverDatabaseInstance();
    }
    initSchema(_db);
    const legacyMigrated = migrateLegacyJsonIfNeeded(_db);
    const restoredConfigs = restoreElectionConfigsFromBackup(_db);
    const appliedDefault = applyDefaultCatalogFromBackup(_db);
    const restoredFeeds = restoreElectionFeedsFromBackup(_db);
    if (restoredFeeds > 0) {
      console.warn(`Restored ${restoredFeeds} county feed row(s) from election-feed-configs.json`);
      persistDb(_db);
      flushPendingDatabasePersist();
    }
    if (restoredConfigs > 0) {
      console.log(`Restored ${restoredConfigs} election(s) from election-source-configs.json backup`);
      persistDb(_db);
    }
    if (appliedDefault) {
      console.log("Applied home default election from election-source-configs.json backup");
      persistDb(_db);
    }
    if (legacyMigrated || consolidatedFromRecovery || !picked) {
      persistDb(_db);
    }
    _dbReady = true;
    return _db;
  })();
  return _init;
}

export function getDbInfo() {
  return {
    engine: "sqlite",
    path: _activeDbPath,
    driver: "sql.js",
    ssms: false,
    hint: "Set MSSQL_SERVER (+ MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD) to use SQL Server with SSMS.",
  };
}

export async function listManualElectionsMeta() {
  const db = await ensureDb();
  const stmt = db.prepare(
    `SELECT id, label, updated_at AS updatedAt FROM manual_elections ORDER BY datetime(updated_at) DESC`,
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export async function getManualElectionJsonById(id) {
  const db = await ensureDb();
  const stmt = db.prepare("SELECT data_json FROM manual_elections WHERE id = ?");
  stmt.bind([id]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return row.data_json;
}

export async function insertManualElection(id, label, electionFileObj) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  const dataJson = JSON.stringify(electionFileObj);
  db.run(
    `INSERT INTO manual_elections (id, label, data_json, source_id, created_at, updated_at)
     VALUES (?, ?, ?, 'manual-default', ?, ?)`,
    [id, label, dataJson, now, now],
  );
  persistDb(db);
}

export async function deleteManualElection(id) {
  const db = await ensureDb();
  db.run("DELETE FROM manual_elections WHERE id = ?", [id]);
  const n = db.getRowsModified();
  persistDb(db);
  return n > 0;
}

export async function manualElectionExists(id) {
  const db = await ensureDb();
  const stmt = db.prepare("SELECT 1 AS x FROM manual_elections WHERE id = ?");
  stmt.bind([id]);
  const ok = stmt.step();
  stmt.free();
  return ok;
}

export async function updateManualElection(id, label, electionFileObj) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  const dataJson = JSON.stringify(electionFileObj);
  db.run(`UPDATE manual_elections SET label = ?, data_json = ?, updated_at = ? WHERE id = ?`, [label, dataJson, now, id]);
  const changed = db.getRowsModified();
  if (changed > 0) persistDb(db);
  return changed > 0;
}

export async function listDbTablesWithCounts() {
  const db = await ensureDb();
  const namesStmt = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const out = [];
  while (namesStmt.step()) {
    const { name } = namesStmt.getAsObject();
    const cStmt = db.prepare(`SELECT COUNT(*) AS c FROM "${String(name).replace(/"/g, '""')}"`);
    cStmt.step();
    const rowCount = Number(cStmt.getAsObject().c ?? 0);
    cStmt.free();
    out.push({ name: String(name), rowCount });
  }
  namesStmt.free();
  return out;
}

export async function getDbTablePreview(tableName, limit = 20) {
  const db = await ensureDb();
  const allowed = new Set(["data_sources", "sos_county_results"]);
  const table = String(tableName ?? "").trim().toLowerCase();
  if (!allowed.has(table)) {
    throw new Error(`Preview not allowed for table: ${tableName}`);
  }
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const stmt = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" ORDER BY id DESC LIMIT ${safeLimit}`);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { table, columns, rows };
}

export async function insertSosResultSnapshot({ electionId, electionLabel, payload }) {
  const db = await ensureDb();
  db.run(`INSERT INTO sos_results (election_id, election_label, payload_json) VALUES (?, ?, ?)`, [
    String(electionId),
    electionLabel ?? null,
    JSON.stringify(payload),
  ]);
  persistDb(db);
}

/** Last stored Civix election + countyInfo JSON (from a prior successful ingest). */
export async function getLatestSosCivixSnapshot(electionId) {
  const db = await ensureDb();
  const stmt = db.prepare(
    `SELECT payload_json, fetched_at FROM sos_results WHERE election_id = ? ORDER BY fetched_at DESC LIMIT 1`,
  );
  stmt.bind([String(electionId)]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  try {
    const payload = JSON.parse(String(row.payload_json ?? "{}"));
    const election = payload?.election;
    const county = payload?.county;
    if (!election || !county) return null;
    return {
      election,
      county,
      fetchedAt: String(row.fetched_at ?? ""),
      sosCountyInfoUrlUsed: String(payload?.sosCountyInfoUrlUsed ?? ""),
    };
  } catch {
    return null;
  }
}

function normalizeCountyCandidateName(value) {
  const raw = String(value ?? "").toUpperCase();
  const stripped = raw
    .replace(/\((DEM|REP|LIB|GRN|IND)\)/g, " ")
    .replace(/\b(DEM|REP|LIB|GRN|IND)\b/g, " ")
    .replace(/[^A-Z\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = stripped
    .split(" ")
    .filter(Boolean)
    .filter((t) => !["MR", "MRS", "MS", "DR", "JR", "SR", "II", "III", "IV", "V"].includes(t))
    .filter((t) => t.length > 1);
  if (!tokens.length) return String(value ?? "").trim();
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const toTitle = (s) => s.charAt(0) + s.slice(1).toLowerCase();
  return first === last ? toTitle(first) : `${toTitle(first)} ${toTitle(last)}`;
}

/**
 * After all county sources are fetched: replace county_results atomically.
 * 1) DELETE all existing county_results rows.
 * 2) INSERT the new fetched rows.
 * 3) COMMIT once so UI doesn't see an intermediate empty table.
 * @param {{ batchAt: string|Date, segments: { countyId: string, sourceUrl: string|null, rows: unknown[] }[] }} payload
 */
export async function commitCountyResultsBatch({ electionId, batchAt, segments }) {
  await ensureDb();
  await reloadFromDiskIfStale();
  const db = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const batchAtStr =
    batchAt != null ? (typeof batchAt === "string" ? batchAt : new Date(batchAt).toISOString()) : new Date().toISOString();
  const segs = segments ?? [];
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`DELETE FROM county_results WHERE election_id = ?`, [electionKey]);

    const insertStmt = db.prepare(
      `INSERT INTO county_results
        (election_id, county_id, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes,
         registered_voters, ballots_cast, precinct_total, precinct_reporting, over_votes, under_votes, line_number, source_url, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const seg of segs) {
      for (const row of seg.rows ?? []) {
        const normalizedChoice = normalizeCountyCandidateName(row.choiceName);
        insertStmt.run([
          electionKey,
          seg.countyId,
          row.contestName ?? "",
          normalizedChoice,
          row.partyName ?? null,
          Number(row.earlyVotes ?? 0),
          Number(row.electionDayVotes ?? 0),
          Number(row.totalVotes ?? 0),
          row.percentOfVotes ?? null,
          Number(row.registeredVoters ?? 0),
          Number(row.ballotsCast ?? 0),
          Number(row.precinctTotal ?? 0),
          Number(row.precinctReporting ?? 0),
          Number(row.overVotes ?? 0),
          Number(row.underVotes ?? 0),
          row.lineNumber == null ? null : Number(row.lineNumber),
          seg.sourceUrl ?? null,
          JSON.stringify(row),
          batchAtStr,
        ]);
      }
    }
    insertStmt.free();

    db.run("COMMIT");
  } catch (e) {
    try {
      db.run("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
  persistDb(db);
}

export async function insertCountyResultRows({ electionId, countyId, sourceUrl, rows, fetchedAt }) {
  await commitCountyResultsBatch({
    electionId: String(electionId ?? "56181"),
    batchAt: fetchedAt ?? new Date().toISOString(),
    segments: [{ countyId, sourceUrl, rows }],
  });
}

export async function insertSosCandidateRows({ electionId, electionLabel, sourceUrl, rows }) {
  const db = await ensureDb();
  const stmt = db.prepare(
    `INSERT INTO sos_candidate_results
      (election_id, election_label, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes,
       precinct_total, precinct_reporting, source_url, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows ?? []) {
    stmt.run([
      String(electionId),
      electionLabel ?? null,
      row.contestName ?? "",
      row.choiceName ?? "",
      row.partyName ?? null,
      Number(row.earlyVotes ?? 0),
      Number(row.electionDayVotes ?? 0),
      Number(row.totalVotes ?? 0),
      row.percentOfVotes ?? null,
      Number(row.precinctTotal ?? 0),
      Number(row.precinctReporting ?? 0),
      sourceUrl ?? null,
      JSON.stringify(row),
    ]);
  }
  stmt.free();
  persistDb(db);
}

export async function insertSosCountyRows({ electionId, electionLabel, sourceUrl, rows }) {
  const db = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  db.run("BEGIN IMMEDIATE");
  try {
    // Atomic replace so UI never observes a half-cleared write.
    db.run(`DELETE FROM sos_county_results WHERE election_id = ?`, [electionKey]);
  const stmt = db.prepare(
    `INSERT INTO sos_county_results
      (election_id, election_label, county_name, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes,
       precinct_total, precinct_reporting, source_url, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows ?? []) {
    stmt.run([
      String(electionId),
      electionLabel ?? null,
      row.countyName ?? "",
      row.contestName ?? "",
      row.choiceName ?? "",
      row.partyName ?? null,
      Number(row.earlyVotes ?? 0),
      Number(row.electionDayVotes ?? 0),
      Number(row.totalVotes ?? 0),
      row.percentOfVotes ?? null,
      Number(row.precinctTotal ?? 0),
      Number(row.precinctReporting ?? 0),
      sourceUrl ?? null,
      JSON.stringify(row),
    ]);
  }
  stmt.free();
    db.run("COMMIT");
  } catch (e) {
    try {
      db.run("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
  persistDb(db);
}

export async function getLatestSosCountyRows(electionId) {
  const db = await ensureDb();
  const maxStmt = db.prepare(
    `SELECT county_name AS countyName, MAX(fetched_at) AS fetchedAt
     FROM sos_county_results
     WHERE election_id = ?
     GROUP BY county_name`,
  );
  maxStmt.bind([String(electionId)]);
  const latest = [];
  while (maxStmt.step()) latest.push(maxStmt.getAsObject());
  maxStmt.free();
  const out = [];
  for (const row of latest) {
    const stmt = db.prepare(
      `SELECT county_name AS countyName, contest_name AS contestName, choice_name AS choiceName, party_name AS partyName,
              early_votes AS earlyVotes, election_day_votes AS electionDayVotes, total_votes AS totalVotes, percent_of_votes AS percentOfVotes,
              precinct_total AS precinctTotal, precinct_reporting AS precinctReporting, fetched_at AS fetchedAt
       FROM sos_county_results
       WHERE election_id = ? AND county_name = ? AND fetched_at = ?
       ORDER BY id`,
    );
    stmt.bind([String(electionId), String(row.countyName), String(row.fetchedAt)]);
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
  }
  return out;
}

function latestRowsForCounty(db, countyId, electionId) {
  if (!countyId) return [];
  /**
   * One logical line per contest + candidate: MAX() vote columns across all ingests / duplicate timestamps.
   * Manual DB edits then affect the live merge whenever they set the highest totals (or only row) for that key.
   */
  const stmt = db.prepare(
    `SELECT
        MAX(line_number) AS lineNumber,
        contest_name AS contestName,
        choice_name AS choiceName,
        MAX(party_name) AS partyName,
        MAX(early_votes) AS earlyVotes,
        MAX(election_day_votes) AS electionDayVotes,
        MAX(total_votes) AS totalVotes,
        NULL AS percentOfVotes,
        MAX(registered_voters) AS registeredVoters,
        MAX(ballots_cast) AS ballotsCast,
        MAX(precinct_total) AS precinctTotal,
        MAX(precinct_reporting) AS precinctReporting,
        MAX(over_votes) AS overVotes,
        MAX(under_votes) AS underVotes,
        MAX(fetched_at) AS fetchedAt,
        NULL AS sourceUrl
     FROM county_results
     WHERE county_id = ? AND election_id = ?
     GROUP BY contest_name, choice_name, COALESCE(party_name, '')
     ORDER BY contest_name, choice_name`,
  );
  stmt.bind([countyId, String(electionId ?? "56181")]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function civixCountyLabelForSlug(db, electionId, slug) {
  const stmt = db.prepare(
    `SELECT civix_county_name FROM election_feed_sources WHERE election_id = ? AND county_key = ? LIMIT 1`,
  );
  stmt.bind([String(electionId), String(slug)]);
  let civix = null;
  if (stmt.step()) civix = stmt.getAsObject().civix_county_name;
  stmt.free();
  if (civix != null && String(civix).trim()) return String(civix).trim().toUpperCase();
  return String(slug).replace(/-/g, " ").toUpperCase();
}

/**
 * Latest county feed rows grouped by Civix county label (uppercase), keyed to match `countyDoc` block.N.
 */
export async function getLatestCountyRows(electionId = "56181") {
  const db = await ensureDb();
  const idStmt = db.prepare(`SELECT DISTINCT county_id FROM county_results WHERE election_id = ?`);
  idStmt.bind([String(electionId)]);
  const slugs = [];
  while (idStmt.step()) slugs.push(String(idStmt.getAsObject().county_id ?? ""));
  idStmt.free();
  const byCivixName = {};
  for (const slug of slugs) {
    if (!slug) continue;
    const civix = civixCountyLabelForSlug(db, electionId, slug);
    byCivixName[civix] = latestRowsForCounty(db, slug, electionId);
  }
  return byCivixName;
}

/**
 * Civix county labels (uppercase) for feeds with “prefer county over SOS” enabled.
 * Used when merging SD4: those counties use ingested county feeds only, not SOS/countyInfo numbers.
 */
export async function getSd4MergePreferCountyFeedNameSet(electionId = "56181") {
  const db = await ensureDb();
  ensureElectionFeedSourcesPreferOverSosColumn(db);
  const stmt = db.prepare(
    `SELECT county_key FROM election_feed_sources WHERE election_id = ? AND prefer_over_sos = 1 AND is_enabled = 1`,
  );
  stmt.bind([String(electionId)]);
  const set = new Set();
  while (stmt.step()) {
    const slug = String(stmt.getAsObject().county_key ?? "")
      .trim()
      .toLowerCase();
    if (!slug) continue;
    set.add(civixCountyLabelForSlug(db, electionId, slug));
  }
  stmt.free();
  return set;
}

function ensureCountyRaceMappingTables(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS county_sos_race_links (
      election_id TEXT NOT NULL,
      county_key TEXT NOT NULL,
      county_contest_name TEXT NOT NULL,
      sos_race_id TEXT NOT NULL,
      sos_race_name TEXT,
      link_type TEXT NOT NULL DEFAULT 'manual',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (election_id, county_key, county_contest_name)
    );
    CREATE TABLE IF NOT EXISTS county_sos_manual_votes (
      election_id TEXT NOT NULL,
      county_key TEXT NOT NULL,
      sos_race_id TEXT NOT NULL,
      sos_candidate_id TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      party_name TEXT,
      early_votes INTEGER NOT NULL DEFAULT 0,
      election_day_votes INTEGER NOT NULL DEFAULT 0,
      total_votes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (election_id, county_key, sos_race_id, sos_candidate_id)
    );
    CREATE TABLE IF NOT EXISTS county_sos_race_vote_source (
      election_id TEXT NOT NULL,
      county_key TEXT NOT NULL,
      sos_race_id TEXT NOT NULL,
      vote_source TEXT NOT NULL DEFAULT 'sos',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (election_id, county_key, sos_race_id)
    );
  `);
}

export async function listCountySosRaceLinks(electionId) {
  const db = await ensureDb();
  ensureCountyRaceMappingTables(db);
  const stmt = db.prepare(
    `SELECT county_key AS countyKey, county_contest_name AS countyContestName, sos_race_id AS sosRaceId,
            sos_race_name AS sosRaceName, link_type AS linkType, updated_at AS updatedAt
     FROM county_sos_race_links WHERE election_id = ? ORDER BY county_key, county_contest_name`,
  );
  stmt.bind([String(electionId)]);
  const out = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    out.push({
      countyKey: String(r.countyKey ?? ""),
      countyContestName: String(r.countyContestName ?? ""),
      sosRaceId: String(r.sosRaceId ?? ""),
      sosRaceName: String(r.sosRaceName ?? ""),
      linkType: String(r.linkType ?? "manual"),
      updatedAt: String(r.updatedAt ?? ""),
    });
  }
  stmt.free();
  return out;
}

export async function upsertCountySosRaceLink(electionId, link) {
  const db = await ensureDb();
  ensureCountyRaceMappingTables(db);
  db.run(
    `INSERT INTO county_sos_race_links (election_id, county_key, county_contest_name, sos_race_id, sos_race_name, link_type, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(election_id, county_key, county_contest_name) DO UPDATE SET
       sos_race_id = excluded.sos_race_id,
       sos_race_name = excluded.sos_race_name,
       link_type = excluded.link_type,
       updated_at = datetime('now')`,
    [
      String(electionId),
      String(link.countyKey ?? "").toLowerCase().trim(),
      String(link.countyContestName ?? "").trim(),
      String(link.sosRaceId ?? "").trim(),
      String(link.sosRaceName ?? "").trim(),
      String(link.linkType ?? "manual"),
    ],
  );
  persistDb(db);
}

export async function deleteCountySosRaceLink(electionId, countyKey, countyContestName) {
  const db = await ensureDb();
  ensureCountyRaceMappingTables(db);
  db.run(
    `DELETE FROM county_sos_race_links WHERE election_id = ? AND county_key = ? AND county_contest_name = ?`,
    [String(electionId), String(countyKey).toLowerCase().trim(), String(countyContestName).trim()],
  );
  persistDb(db);
}

export async function listCountySosManualVotes(electionId) {
  const db = await ensureDb();
  ensureCountyRaceMappingTables(db);
  const stmt = db.prepare(
    `SELECT county_key AS countyKey, sos_race_id AS sosRaceId, sos_candidate_id AS sosCandidateId,
            choice_name AS choiceName, party_name AS partyName, early_votes AS earlyVotes,
            election_day_votes AS electionDayVotes, total_votes AS totalVotes, updated_at AS updatedAt
     FROM county_sos_manual_votes WHERE election_id = ? ORDER BY county_key, sos_race_id, sos_candidate_id`,
  );
  stmt.bind([String(electionId)]);
  const out = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    out.push({
      countyKey: String(r.countyKey ?? ""),
      sosRaceId: String(r.sosRaceId ?? ""),
      sosCandidateId: String(r.sosCandidateId ?? ""),
      choiceName: String(r.choiceName ?? ""),
      partyName: String(r.partyName ?? ""),
      earlyVotes: Number(r.earlyVotes ?? 0),
      electionDayVotes: Number(r.electionDayVotes ?? 0),
      totalVotes: Number(r.totalVotes ?? 0),
      updatedAt: String(r.updatedAt ?? ""),
    });
  }
  stmt.free();
  return out;
}

export async function upsertCountySosManualVote(electionId, row) {
  const db = await ensureDb();
  ensureCountyRaceMappingTables(db);
  db.run(
    `INSERT INTO county_sos_manual_votes
       (election_id, county_key, sos_race_id, sos_candidate_id, choice_name, party_name, early_votes, election_day_votes, total_votes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(election_id, county_key, sos_race_id, sos_candidate_id) DO UPDATE SET
       choice_name = excluded.choice_name,
       party_name = excluded.party_name,
       early_votes = excluded.early_votes,
       election_day_votes = excluded.election_day_votes,
       total_votes = excluded.total_votes,
       updated_at = datetime('now')`,
    [
      String(electionId),
      String(row.countyKey ?? "").toLowerCase().trim(),
      String(row.sosRaceId ?? "").trim(),
      String(row.sosCandidateId ?? "").trim(),
      String(row.choiceName ?? "").trim(),
      String(row.partyName ?? "").trim(),
      Number(row.earlyVotes ?? 0),
      Number(row.electionDayVotes ?? 0),
      Number(row.totalVotes ?? 0),
    ],
  );
  persistDb(db);
}

export async function listCountySosRaceVoteSources(electionId) {
  const db = await ensureDb();
  ensureCountyRaceMappingTables(db);
  const stmt = db.prepare(
    `SELECT county_key AS countyKey, sos_race_id AS sosRaceId, vote_source AS voteSource, updated_at AS updatedAt
     FROM county_sos_race_vote_source WHERE election_id = ?`,
  );
  stmt.bind([String(electionId)]);
  const out = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    out.push({
      countyKey: String(r.countyKey ?? ""),
      sosRaceId: String(r.sosRaceId ?? ""),
      voteSource: String(r.voteSource ?? "sos"),
      updatedAt: String(r.updatedAt ?? ""),
    });
  }
  stmt.free();
  return out;
}

export async function upsertCountySosRaceVoteSource(electionId, row) {
  const db = await ensureDb();
  ensureCountyRaceMappingTables(db);
  const src = String(row.voteSource ?? "sos").toLowerCase();
  if (!["sos", "county_feed", "manual"].includes(src)) {
    throw new Error("voteSource must be sos, county_feed, or manual");
  }
  db.run(
    `INSERT INTO county_sos_race_vote_source (election_id, county_key, sos_race_id, vote_source, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(election_id, county_key, sos_race_id) DO UPDATE SET
       vote_source = excluded.vote_source,
       updated_at = datetime('now')`,
    [String(electionId), String(row.countyKey ?? "").toLowerCase().trim(), String(row.sosRaceId ?? "").trim(), src],
  );
  persistDb(db);
}

/** Civix county label (uppercase) → county_key slug for mapping UI and merge. */
export async function buildCivixNameToCountyKeyMap(electionId) {
  const db = await ensureDb();
  const feeds = await listElectionFeedSources(electionId);
  const map = {};
  for (const f of feeds) {
    const slug = String(f.countyKey ?? "").trim().toLowerCase();
    if (!slug) continue;
    const civix = civixCountyLabelForSlug(db, electionId, slug);
    map[civix] = slug;
  }
  return map;
}

export async function listIngestVendors() {
  const db = await ensureDb();
  const stmt = db.prepare(
    `SELECT id, display_name AS displayName, vendor_tier AS vendorTier, handler_key AS handlerKey, notes
     FROM ingest_vendors ORDER BY vendor_tier DESC, display_name`,
  );
  const out = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    out.push({
      id: String(r.id),
      displayName: String(r.displayName ?? ""),
      vendorTier: String(r.vendorTier ?? "other"),
      handlerKey: String(r.handlerKey ?? ""),
      notes: r.notes == null ? "" : String(r.notes),
    });
  }
  stmt.free();
  return out;
}

export async function listElectionFeedSources(electionId) {
  const db = await ensureDb();
  ensureElectionFeedSourcesHubColumn(db);
  ensureElectionFeedSourcesPreferOverSosColumn(db);
  ensureElectionFeedsSeededFromLegacy(db, String(electionId));
  const stmt = db.prepare(
    `SELECT id, election_id AS electionId, scope, county_key AS countyKey, civix_county_name AS civixCountyName,
            vendor_id AS vendorId, source_url AS sourceUrl, hub_page_url AS hubPageUrl,
            is_enabled AS isEnabled, prefer_over_sos AS preferOverSos, sort_order AS sortOrder, updated_at AS updatedAt
     FROM election_feed_sources WHERE election_id = ? ORDER BY sort_order, id`,
  );
  stmt.bind([String(electionId)]);
  const out = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    out.push({
      id: Number(r.id),
      electionId: String(r.electionId),
      scope: String(r.scope ?? "county"),
      countyKey: String(r.countyKey ?? ""),
      civixCountyName: r.civixCountyName == null ? "" : String(r.civixCountyName),
      vendorId: String(r.vendorId ?? ""),
      sourceUrl: String(r.sourceUrl ?? ""),
      hubPageUrl: String(r.hubPageUrl ?? ""),
      isEnabled: !!r.isEnabled,
      preferOverSos: !!r.preferOverSos,
      sortOrder: Number(r.sortOrder ?? 0),
      updatedAt: String(r.updatedAt ?? ""),
    });
  }
  stmt.free();
  if (out.length === 0) {
    try {
      const n = restoreSingleElectionFeedsFromBackup(db, String(electionId));
      if (n > 0) return listElectionFeedSources(electionId);
    } catch (e) {
      console.warn("election feed backup restore failed:", e?.message ?? e);
    }
  }
  return out;
}

function ensureElectionFeedsSeededFromLegacy(db, electionId) {
  const chk = db.prepare(`SELECT COUNT(*) AS c FROM election_feed_sources WHERE election_id = ?`);
  chk.bind([electionId]);
  chk.step();
  const n = Number(chk.getAsObject().c ?? 0);
  chk.free();
  if (n > 0) return;

  const cfgStmt = db.prepare(
    `SELECT harris_source_url, galveston_source_url, jefferson_source_url, montgomery_source_url, chambers_source_url
     FROM election_source_configs WHERE election_id = ?`,
  );
  cfgStmt.bind([electionId]);
  if (!cfgStmt.step()) {
    cfgStmt.free();
    return;
  }
  const cfg = cfgStmt.getAsObject();
  cfgStmt.free();
  const now = new Date().toISOString();
  /** @type {Array<[string, string, string, number]>} */
  const feeds = [];
  let ord = 0;
  const push = (countyKey, vendorId, url) => {
    const u = String(url ?? "").trim();
    if (!u) return;
    feeds.push([countyKey, vendorId, u, ord++]);
  };
  push("harris", "harris-pdf", cfg.harris_source_url);
  push("galveston", "clarity-enr-summary-zip", cfg.galveston_source_url);
  push("jefferson", "clarity-enr-summary-zip", cfg.jefferson_source_url);
  push("montgomery", "montgomery-eresults-html", cfg.montgomery_source_url);
  push("chambers", "chambers-pdf", cfg.chambers_source_url);
  if (!feeds.length) return;

  const ins = db.prepare(
    `INSERT INTO election_feed_sources (election_id, scope, county_key, vendor_id, source_url, is_enabled, sort_order, updated_at)
     VALUES (?, 'county', ?, ?, ?, 1, ?, ?)`,
  );
  for (const [countyKey, vendorId, url, sortOrder] of feeds) {
    ins.run([electionId, countyKey, vendorId, url, sortOrder, now]);
  }
  ins.free();
  persistDb(db);
}

export async function replaceElectionFeedSourcesForElection(electionId, sources) {
  const db = await ensureDb();
  const eid = String(electionId ?? "").trim();
  if (!eid) throw new Error("electionId is required");
  const now = new Date().toISOString();
  db.run(`DELETE FROM election_feed_sources WHERE election_id = ?`, [eid]);
  ensureElectionFeedSourcesPreferOverSosColumn(db);
  const ins = db.prepare(
    `INSERT INTO election_feed_sources (election_id, scope, county_key, civix_county_name, vendor_id, source_url, hub_page_url, is_enabled, prefer_over_sos, sort_order, updated_at)
     VALUES (?, 'county', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let ord = 0;
  for (const s of sources ?? []) {
    const countyKey = String(s.countyKey ?? "").trim().toLowerCase();
    if (!countyKey) continue;
    ins.run([
      eid,
      countyKey,
      s.civixCountyName != null && String(s.civixCountyName).trim() ? String(s.civixCountyName).trim() : null,
      String(s.vendorId ?? "").trim() || "other-vendor",
      String(s.sourceUrl ?? ""),
      String(s.hubPageUrl ?? ""),
      s.isEnabled === false ? 0 : 1,
      s.preferOverSos === true ? 1 : 0,
      ord++,
      now,
    ]);
  }
  ins.free();
  try {
    writeElectionFeedBackupForElection(eid, sources);
  } catch (e) {
    console.warn("election feed backup write failed:", e?.message ?? e);
  }
  persistDb(db);
  flushPendingDatabasePersist();
  return listElectionFeedSources(eid);
}

export async function updateElectionFeedSourceUrl(electionId, feedId, sourceUrl) {
  const db = await ensureDb();
  ensureElectionFeedSourcesHubColumn(db);
  db.run(
    `UPDATE election_feed_sources SET source_url = ?, updated_at = datetime('now') WHERE election_id = ? AND id = ?`,
    [String(sourceUrl ?? ""), String(electionId ?? "").trim(), Number(feedId)],
  );
  persistDb(db);
}

export async function ensureElectionFeedsSeededFromLegacyForElection(electionId) {
  const db = await ensureDb();
  ensureElectionFeedsSeededFromLegacy(db, String(electionId));
}

export async function getAppSettings() {
  const db = await ensureDb();
  function getSetting(key, fallback) {
    const stmt = db.prepare(`SELECT value_json FROM app_settings WHERE setting_key = ?`);
    stmt.bind([key]);
    let value = fallback;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      value = String(row.value_json ?? fallback);
    }
    stmt.free();
    return value;
  }
  const disableAutoIngest = getSetting("disable_auto_ingest", "false").trim().toLowerCase() === "true";
  const autoRefreshEnabled = getSetting("auto_refresh_enabled", "false").trim().toLowerCase() === "true";
  const autoRefreshIntervalSec = Number(getSetting("auto_refresh_interval_sec", "60")) || 60;
  const sosCountyInfoUrl = getSetting("sos_countyinfo_url", "").trim();
  const harrisSourceUrl = getSetting("harris_source_url", "").trim();
  const galvestonSourceUrl = getSetting("galveston_source_url", "").trim();
  const jeffersonSourceUrl = getSetting("jefferson_source_url", "").trim();
  const montgomerySourceUrl = getSetting("montgomery_source_url", "").trim();
  const chambersSourceUrl = getSetting("chambers_source_url", "").trim();
  const displayTimeZone = getSetting("display_time_zone", "America/Chicago").trim() || "America/Chicago";
  return {
    disableAutoIngest,
    autoRefreshEnabled,
    autoRefreshIntervalSec,
    sosCountyInfoUrl,
    harrisSourceUrl,
    galvestonSourceUrl,
    jeffersonSourceUrl,
    montgomerySourceUrl,
    chambersSourceUrl,
    displayTimeZone,
  };
}

export async function updateAppSettings({
  disableAutoIngest,
  autoRefreshEnabled,
  autoRefreshIntervalSec,
  sosCountyInfoUrl,
  harrisSourceUrl,
  galvestonSourceUrl,
  jeffersonSourceUrl,
  montgomerySourceUrl,
  chambersSourceUrl,
  displayTimeZone,
}) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  const upsert = (key, value) =>
    db.run(
      `INSERT INTO app_settings (setting_key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, String(value), now],
    );
  upsert("disable_auto_ingest", disableAutoIngest ? "true" : "false");
  if (typeof autoRefreshEnabled === "boolean") upsert("auto_refresh_enabled", autoRefreshEnabled ? "true" : "false");
  if (autoRefreshIntervalSec != null) upsert("auto_refresh_interval_sec", Math.max(15, Number(autoRefreshIntervalSec) || 60));
  if (sosCountyInfoUrl != null) upsert("sos_countyinfo_url", String(sosCountyInfoUrl));
  if (harrisSourceUrl != null) upsert("harris_source_url", String(harrisSourceUrl));
  if (galvestonSourceUrl != null) upsert("galveston_source_url", String(galvestonSourceUrl));
  if (jeffersonSourceUrl != null) upsert("jefferson_source_url", String(jeffersonSourceUrl));
  if (montgomerySourceUrl != null) upsert("montgomery_source_url", String(montgomerySourceUrl));
  if (chambersSourceUrl != null) upsert("chambers_source_url", String(chambersSourceUrl));
  if (displayTimeZone != null) upsert("display_time_zone", String(displayTimeZone || "America/Chicago"));
  persistDb(db);
  return getAppSettings();
}

export async function clearLiveResultTables() {
  const db = await ensureDb();
  db.run(`DELETE FROM sos_results`);
  db.run(`DELETE FROM sos_candidate_results`);
  db.run(`DELETE FROM sos_county_results`);
  db.run(`DELETE FROM county_results`);
  db.run(`DELETE FROM county_harris_results`);
  db.run(`DELETE FROM county_galveston_results`);
  db.run(`DELETE FROM county_jefferson_results`);
  db.run(`DELETE FROM county_chambers_results`);
  db.run(`DELETE FROM county_montgomery_results`);
  persistDb(db);
}

export async function pruneLiveResultHistory(keepSosBatches = 2) {
  const db = await ensureDb();
  const keep = Math.max(1, Number(keepSosBatches) || 2);
  db.run(
    `DELETE FROM sos_results
     WHERE id IN (
       WITH ranked AS (
         SELECT id,
                DENSE_RANK() OVER (PARTITION BY election_id ORDER BY fetched_at DESC) AS dr
         FROM sos_results
       )
       SELECT id FROM ranked WHERE dr > ?
     )`,
    [keep],
  );
  db.run(
    `DELETE FROM sos_candidate_results
     WHERE id IN (
       WITH ranked AS (
         SELECT id,
                DENSE_RANK() OVER (PARTITION BY election_id ORDER BY fetched_at DESC) AS dr
         FROM sos_candidate_results
       )
       SELECT id FROM ranked WHERE dr > ?
     )`,
    [keep],
  );
  db.run(
    `DELETE FROM sos_county_results
     WHERE id IN (
       WITH ranked AS (
         SELECT id,
                DENSE_RANK() OVER (PARTITION BY election_id, county_name ORDER BY fetched_at DESC) AS dr
         FROM sos_county_results
       )
       SELECT id FROM ranked WHERE dr > ?
     )`,
    [keep],
  );
  persistDb(db);
}

export async function listElectionSourceConfigs() {
  const db = await ensureDb();
  ensureElectionSourceConfigColumns(db);
  const stmt = db.prepare(
    `SELECT election_id AS electionId, label, is_enabled AS isEnabled, auto_refresh_enabled AS autoRefreshEnabled,
            uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog, is_default_catalog AS isDefaultCatalog,
            sos_countyinfo_url AS sosCountyInfoUrl, harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl,
            jefferson_source_url AS jeffersonSourceUrl, montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl,
            updated_at AS updatedAt
     FROM election_source_configs
     ORDER BY is_default_catalog DESC, election_id`,
  );
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push({
      electionId: String(row.electionId),
      label: String(row.label ?? ""),
      isEnabled: !!row.isEnabled,
      autoRefreshEnabled: !!row.autoRefreshEnabled,
      usesCivixSos: row.usesCivixSos == null ? true : !!row.usesCivixSos,
      showInCatalog: row.showInCatalog == null ? true : !!row.showInCatalog,
      isDefaultCatalog: !!row.isDefaultCatalog,
      sosCountyInfoUrl: String(row.sosCountyInfoUrl ?? ""),
      harrisSourceUrl: String(row.harrisSourceUrl ?? ""),
      galvestonSourceUrl: String(row.galvestonSourceUrl ?? ""),
      jeffersonSourceUrl: String(row.jeffersonSourceUrl ?? ""),
      montgomerySourceUrl: String(row.montgomerySourceUrl ?? ""),
      chambersSourceUrl: String(row.chambersSourceUrl ?? ""),
      updatedAt: String(row.updatedAt ?? ""),
    });
  }
  stmt.free();
  return rows;
}

export async function getElectionSourceConfig(electionId) {
  const db = await ensureDb();
  ensureElectionSourceConfigColumns(db);
  const stmt = db.prepare(
    `SELECT election_id AS electionId, label, is_enabled AS isEnabled, auto_refresh_enabled AS autoRefreshEnabled,
            uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog, is_default_catalog AS isDefaultCatalog,
            sos_countyinfo_url AS sosCountyInfoUrl, harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl,
            jefferson_source_url AS jeffersonSourceUrl, montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl
     FROM election_source_configs
     WHERE election_id = ?`,
  );
  stmt.bind([String(electionId)]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return {
    electionId: String(row.electionId),
    label: String(row.label ?? ""),
    isEnabled: !!row.isEnabled,
    autoRefreshEnabled: !!row.autoRefreshEnabled,
    usesCivixSos: row.usesCivixSos == null ? true : !!row.usesCivixSos,
    showInCatalog: row.showInCatalog == null ? true : !!row.showInCatalog,
    isDefaultCatalog: !!row.isDefaultCatalog,
    sosCountyInfoUrl: String(row.sosCountyInfoUrl ?? ""),
    harrisSourceUrl: String(row.harrisSourceUrl ?? ""),
    galvestonSourceUrl: String(row.galvestonSourceUrl ?? ""),
    jeffersonSourceUrl: String(row.jeffersonSourceUrl ?? ""),
    montgomerySourceUrl: String(row.montgomerySourceUrl ?? ""),
    chambersSourceUrl: String(row.chambersSourceUrl ?? ""),
  };
}

export async function upsertElectionSourceConfig({
  electionId,
  label,
  isEnabled,
  autoRefreshEnabled,
  usesCivixSos,
  showInCatalog,
  sosCountyInfoUrl,
  harrisSourceUrl,
  galvestonSourceUrl,
  jeffersonSourceUrl,
  montgomerySourceUrl,
  chambersSourceUrl,
}) {
  const db = await ensureDb();
  ensureElectionSourceConfigColumns(db);
  const id = String(electionId ?? "").trim();
  if (!id) throw new Error("electionId is required");
  const now = new Date().toISOString();
  const uSos = usesCivixSos === false ? 0 : 1;
  const uCat = showInCatalog === false ? 0 : 1;
  db.run(
    `INSERT INTO election_source_configs
      (election_id, label, is_enabled, auto_refresh_enabled, uses_civix_sos, show_in_catalog, sos_countyinfo_url, harris_source_url, galveston_source_url, jefferson_source_url, montgomery_source_url, chambers_source_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(election_id) DO UPDATE SET
      label = excluded.label,
      is_enabled = excluded.is_enabled,
      auto_refresh_enabled = excluded.auto_refresh_enabled,
      uses_civix_sos = excluded.uses_civix_sos,
      show_in_catalog = excluded.show_in_catalog,
      sos_countyinfo_url = excluded.sos_countyinfo_url,
      harris_source_url = excluded.harris_source_url,
      galveston_source_url = excluded.galveston_source_url,
      jefferson_source_url = excluded.jefferson_source_url,
      montgomery_source_url = excluded.montgomery_source_url,
      chambers_source_url = excluded.chambers_source_url,
      updated_at = excluded.updated_at`,
    [
      id,
      String(label ?? id),
      isEnabled ? 1 : 0,
      autoRefreshEnabled ? 1 : 0,
      uSos,
      uCat,
      String(sosCountyInfoUrl ?? ""),
      String(harrisSourceUrl ?? ""),
      String(galvestonSourceUrl ?? ""),
      String(jeffersonSourceUrl ?? ""),
      String(montgomerySourceUrl ?? ""),
      String(chambersSourceUrl ?? ""),
      now,
    ],
  );
  persistDb(db);
  const saved = await getElectionSourceConfig(id);
  try {
    writeElectionConfigBackup(await listElectionSourceConfigs());
  } catch (e) {
    console.warn("election config backup write failed:", e?.message ?? e);
  }
  return saved;
}

/** Mark one election as the default home-page / ingest selection; clears the flag on all others. */
export async function setDefaultElectionCatalog(electionId) {
  const db = await ensureDb();
  ensureElectionSourceConfigColumns(db);
  const id = String(electionId ?? "").trim();
  if (!id) throw new Error("electionId is required");
  const exists = db.prepare(`SELECT 1 FROM election_source_configs WHERE election_id = ? LIMIT 1`);
  exists.bind([id]);
  const ok = exists.step();
  exists.free();
  if (!ok) throw new Error(`Election ${id} not found`);
  db.run(`UPDATE election_source_configs SET is_default_catalog = 0`);
  db.run(`UPDATE election_source_configs SET is_default_catalog = 1, updated_at = datetime('now') WHERE election_id = ?`, [
    id,
  ]);
  persistDb(db);
  flushPendingDatabasePersist();
  try {
    writeElectionConfigBackup(await listElectionSourceConfigs());
  } catch (e) {
    console.warn("election config backup write failed:", e?.message ?? e);
  }
  return getElectionSourceConfig(id);
}

export async function appendVoteHistoryIfChanged({ electionId, sourceKey, capturedAt, rows }) {
  const db = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const source = String(sourceKey ?? "unknown");
  const ts = capturedAt != null ? (typeof capturedAt === "string" ? capturedAt : new Date(capturedAt).toISOString()) : new Date().toISOString();
  const selectStmt = db.prepare(
    `SELECT early_votes AS earlyVotes, election_day_votes AS electionDayVotes, total_votes AS totalVotes, percent_of_votes AS percentOfVotes
     FROM vote_update_history
     WHERE election_id = ? AND source_key = ? AND contest_name = ? AND choice_name = ? AND COALESCE(party_name, '') = COALESCE(?, '')
     ORDER BY id DESC LIMIT 1`,
  );
  const ins = db.prepare(
    `INSERT INTO vote_update_history
      (election_id, source_key, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows ?? []) {
    const contestName = String(row.contestName ?? "");
    const choiceName = String(row.choiceName ?? "");
    const partyName = row.partyName == null ? null : String(row.partyName);
    const earlyVotes = Number(row.earlyVotes ?? 0);
    const electionDayVotes = Number(row.electionDayVotes ?? 0);
    const totalVotes = Number(row.totalVotes ?? 0);
    const percentOfVotes = row.percentOfVotes == null ? null : String(row.percentOfVotes);
    selectStmt.bind([electionKey, source, contestName, choiceName, partyName]);
    let changed = true;
    if (selectStmt.step()) {
      const prev = selectStmt.getAsObject();
      changed =
        Number(prev.earlyVotes ?? 0) !== earlyVotes ||
        Number(prev.electionDayVotes ?? 0) !== electionDayVotes ||
        Number(prev.totalVotes ?? 0) !== totalVotes ||
        String(prev.percentOfVotes ?? "") !== String(percentOfVotes ?? "");
    }
    selectStmt.reset();
    if (!changed) continue;
    ins.run([electionKey, source, contestName, choiceName, partyName, earlyVotes, electionDayVotes, totalVotes, percentOfVotes, ts]);
  }
  selectStmt.free();
  ins.free();
  persistDb(db);
}

const SOURCE_IMPORT_LOG_CAP = 500;

/** Ensures table exists when `ensureDb()` returns a long-lived DB loaded before this migration shipped. */
function ensureSourceImportLogTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS source_import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      ok INTEGER NOT NULL,
      message TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_source_import_log_key_occurred ON source_import_log(source_key, occurred_at DESC)`);
}

export async function appendSourceImportLog({ sourceKey, ok, message }) {
  try {
    const db = await ensureDb();
    ensureSourceImportLogTable(db);
    const key = String(sourceKey ?? "").trim().slice(0, 64) || "unknown";
    const msg = String(message ?? "").slice(0, 10000);
    const okVal = ok ? 1 : 0;
    db.run(`INSERT INTO source_import_log (source_key, ok, message) VALUES (?, ?, ?)`, [key, okVal, msg]);
    db.run(`DELETE FROM source_import_log WHERE id NOT IN (SELECT id FROM source_import_log ORDER BY id DESC LIMIT ?)`, [
      SOURCE_IMPORT_LOG_CAP,
    ]);
    persistDb(db);
  } catch (e) {
    console.error("appendSourceImportLog", e);
  }
}

export async function getSourceImportLogPayload({ recentLimit = 200 } = {}) {
  const db = await ensureDb();
  ensureSourceImportLogTable(db);
  const limit = Math.max(1, Math.min(500, Number(recentLimit) || 200));
  const recentStmt = db.prepare(
    `SELECT id, source_key AS sourceKey, ok, message, occurred_at AS occurredAt
     FROM source_import_log ORDER BY id DESC LIMIT ${limit}`,
  );
  const entries = [];
  while (recentStmt.step()) {
    const row = recentStmt.getAsObject();
    entries.push({
      id: Number(row.id),
      sourceKey: String(row.sourceKey ?? ""),
      ok: !!row.ok,
      message: String(row.message ?? ""),
      occurredAt: String(row.occurredAt ?? ""),
    });
  }
  recentStmt.free();

  const latestStmt = db.prepare(`
    SELECT s.id, s.source_key AS sourceKey, s.ok, s.message, s.occurred_at AS occurredAt
    FROM source_import_log s
    INNER JOIN (
      SELECT source_key AS sk, MAX(id) AS mid FROM source_import_log GROUP BY source_key
    ) t ON s.source_key = t.sk AND s.id = t.mid
  `);
  const latestBySource = {};
  while (latestStmt.step()) {
    const row = latestStmt.getAsObject();
    latestBySource[String(row.sourceKey ?? "")] = {
      ok: !!row.ok,
      message: String(row.message ?? ""),
      occurredAt: String(row.occurredAt ?? ""),
    };
  }
  latestStmt.free();

  return { entries, latestBySource };
}

export async function listEvRosterConfigs() {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const stmt = db.prepare(
    `SELECT evr_election_id AS evrElectionId, party, election_name AS electionName, election_date AS electionDate,
            is_enabled AS isEnabled, notes, updated_at AS updatedAt
     FROM ev_roster_configs ORDER BY party, evr_election_id`,
  );
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      evrElectionId: Number(r.evrElectionId),
      party: String(r.party ?? ""),
      electionName: String(r.electionName ?? ""),
      electionDate: String(r.electionDate ?? ""),
      isEnabled: !!r.isEnabled,
      notes: r.notes ? String(r.notes) : null,
      updatedAt: String(r.updatedAt ?? ""),
    });
  }
  stmt.free();
  return rows;
}

export async function upsertEvRosterConfig({ evrElectionId, party, electionName, electionDate, isEnabled, notes }) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  db.run(
    `INSERT INTO ev_roster_configs (evr_election_id, party, election_name, election_date, is_enabled, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(evr_election_id) DO UPDATE SET
       party = excluded.party,
       election_name = excluded.election_name,
       election_date = excluded.election_date,
       is_enabled = excluded.is_enabled,
       notes = excluded.notes,
       updated_at = datetime('now')`,
    [
      Number(evrElectionId),
      String(party ?? "").slice(0, 16),
      String(electionName ?? "").slice(0, 512),
      String(electionDate ?? "").slice(0, 32),
      isEnabled === false ? 0 : 1,
      notes != null ? String(notes).slice(0, 2000) : null,
    ],
  );
  persistDb(db);
  return listEvRosterConfigs();
}

export async function getConfirmedEvRosterCountyNames(evrElectionId, votingDate) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const stmt = db.prepare(
    `SELECT county_name AS countyName FROM ev_roster_county_pull_status
     WHERE evr_election_id = ? AND voting_date = ? AND confirmed_at IS NOT NULL`,
  );
  stmt.bind([Number(evrElectionId), String(votingDate ?? "").trim()]);
  const names = new Set();
  while (stmt.step()) names.add(String(stmt.getAsObject().countyName ?? "").toUpperCase());
  stmt.free();
  return names;
}

export async function listEvRosterCountyPullStatuses(evrElectionId, votingDate) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const stmt = db.prepare(
    `SELECT county_name AS countyName, county_key AS countyKey, last_pull_ok AS lastPullOk,
            last_pull_at AS lastPullAt, last_pull_message AS lastPullMessage, voter_count AS voterCount,
            confirmed_at AS confirmedAt
     FROM ev_roster_county_pull_status
     WHERE evr_election_id = ? AND voting_date = ?`,
  );
  stmt.bind([Number(evrElectionId), String(votingDate ?? "").trim()]);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      countyName: String(r.countyName ?? ""),
      countyKey: r.countyKey != null ? String(r.countyKey) : null,
      lastPullOk: r.lastPullOk == null ? null : !!r.lastPullOk,
      lastPullAt: r.lastPullAt ? String(r.lastPullAt) : null,
      lastPullMessage: r.lastPullMessage ? String(r.lastPullMessage) : null,
      voterCount: Number(r.voterCount ?? 0),
      confirmedAt: r.confirmedAt ? String(r.confirmedAt) : null,
    });
  }
  stmt.free();
  return rows;
}

export async function recordEvRosterCountyPullResults(evrElectionId, votingDate, countyPullLog) {
  const { aggregateCountyPullResults } = await import("./lib/evRosterCountyStatus.mjs");
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO ev_roster_county_pull_status
      (evr_election_id, voting_date, county_name, county_key, last_pull_ok, last_pull_at, last_pull_message, voter_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(evr_election_id, voting_date, county_name) DO UPDATE SET
      county_key = COALESCE(excluded.county_key, county_key),
      last_pull_ok = excluded.last_pull_ok,
      last_pull_at = excluded.last_pull_at,
      last_pull_message = excluded.last_pull_message,
      voter_count = excluded.voter_count`,
  );
  for (const row of aggregateCountyPullResults(countyPullLog)) {
    upsert.run([
      eid,
      vDate,
      row.countyName,
      row.countyKey || null,
      row.lastPullOk ? 1 : 0,
      now,
      row.messages.join(" | ").slice(0, 4000) || null,
      Number(row.voterCount ?? 0),
    ]);
  }
  upsert.free();
  persistDb(db);
}

export async function confirmEvRosterCountyPull(evrElectionId, votingDate, countyName) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const name = String(countyName ?? "").toUpperCase();
  const check = db.prepare(
    `SELECT last_pull_ok AS lastPullOk FROM ev_roster_county_pull_status
     WHERE evr_election_id = ? AND voting_date = ? AND county_name = ?`,
  );
  check.bind([eid, vDate, name]);
  if (!check.step()) {
    check.free();
    throw new Error(`No county pull recorded for ${name} on this date — pull the county first.`);
  }
  if (!check.getAsObject().lastPullOk) {
    check.free();
    throw new Error(`Latest pull for ${name} did not succeed — fix sources and pull again before confirming.`);
  }
  check.free();
  db.run(
    `UPDATE ev_roster_county_pull_status SET confirmed_at = datetime('now')
     WHERE evr_election_id = ? AND voting_date = ? AND county_name = ?`,
    [eid, vDate, name],
  );
  persistDb(db);
  return listEvRosterCountyPullStatuses(eid, vDate);
}

/** Remove all stored pulls, voters, summaries, and per-county pull status (keeps configs & county sources). */
export async function clearEvRosterPullData() {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const count = (table) => {
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
    stmt.step();
    const n = Number(stmt.getAsObject().n ?? 0);
    stmt.free();
    return n;
  };
  const before = {
    voters: count("ev_roster_voters"),
    pulls: count("ev_roster_pulls"),
  };
  db.run("DELETE FROM ev_roster_county_pull_log");
  db.run("DELETE FROM ev_roster_county_summary");
  db.run("DELETE FROM ev_roster_county_pull_status");
  db.run("DELETE FROM ev_roster_voters");
  db.run("DELETE FROM ev_roster_pulls");
  db.run("DELETE FROM ev_roster_activity_cache");
  db.run("DELETE FROM ev_roster_registered_cache");
  persistDb(db);
  return { cleared: before, remaining: { voters: 0, pulls: 0 } };
}

export async function saveEvRosterPull(payload, options = {}) {
  if (options?.merge) return mergeEvRosterPull(payload);
  const {
    evrElectionId,
    votingDate,
    hubPageUrl,
    sosTurnoutUrl,
    sosRosterUrl,
    statewideVoterCount,
    rawRecordCount,
    dedupedVoterCount,
    ok,
    message,
    countySummaries,
    voters,
    countyPullLog,
  } = payload;
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const locked = await getConfirmedEvRosterCountyNames(eid, vDate);
  const { filterSummariesForLocked, filterVotersForLocked } = await import("./lib/evRosterCountyStatus.mjs");
  let preservedSummaries = [];
  if (locked.size) {
    const existing = await getEvRosterPullPayload(eid, vDate);
    preservedSummaries = (existing?.counties ?? []).filter((c) =>
      locked.has(String(c.countyName ?? "").toUpperCase()),
    );
  }
  const summariesToWrite = [
    ...filterSummariesForLocked(countySummaries, locked),
    ...preservedSummaries,
  ];
  const votersToWrite = filterVotersForLocked(voters, locked);
  db.run(`DELETE FROM ev_roster_pulls WHERE evr_election_id = ? AND voting_date = ?`, [eid, vDate]);
  db.run(
    `INSERT INTO ev_roster_pulls
      (evr_election_id, voting_date, hub_page_url, sos_turnout_url, sos_roster_url, statewide_voter_count,
       raw_record_count, deduped_voter_count, ok, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eid,
      vDate,
      hubPageUrl ?? null,
      sosTurnoutUrl ?? null,
      sosRosterUrl ?? null,
      Number(statewideVoterCount ?? 0),
      Number(rawRecordCount ?? 0),
      Number(dedupedVoterCount ?? 0),
      ok === false ? 0 : 1,
      String(message ?? "").slice(0, 4000),
    ],
  );
  const pullId = db.exec(`SELECT last_insert_rowid() AS id`)[0]?.values?.[0]?.[0];
  const insCounty = db.prepare(
    `INSERT INTO ev_roster_county_summary
      (pull_id, county_name, county_id, registered_voters, in_person_votes_on_date, total_in_person_votes_for_election,
       total_mail_votes_for_election, cumulative_total, sos_voter_count, county_voter_count, chosen_source, chosen_voter_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of summariesToWrite) {
    insCounty.run([
      pullId,
      String(c.countyName ?? "").slice(0, 128),
      c.countyId != null ? Number(c.countyId) : null,
      Number(c.registeredVoters ?? 0),
      Number(c.inPersonVotesOnDate ?? 0),
      Number(c.totalInPersonVotesForElection ?? 0),
      Number(c.totalMailVotesForElection ?? 0),
      Number(c.cumulativeTotal ?? 0),
      Number(c.sosVoterCount ?? 0),
      Number(c.countyVoterCount ?? 0),
      String(c.chosenSource ?? "sos").slice(0, 32),
      Number(c.chosenVoterCount ?? 0),
    ]);
  }
  insCounty.free();
  if (locked.size) {
    const placeholders = [...locked].map(() => "?").join(", ");
    db.run(
      `DELETE FROM ev_roster_voters WHERE evr_election_id = ? AND COALESCE(reporting_date, voting_date) = ? AND county_name NOT IN (${placeholders})`,
      [eid, vDate, ...locked],
    );
  } else {
    db.run(
      `DELETE FROM ev_roster_voters WHERE evr_election_id = ? AND COALESCE(reporting_date, voting_date) = ?`,
      [eid, vDate],
    );
  }
  const insVoter = db.prepare(
    `INSERT OR REPLACE INTO ev_roster_voters
      (evr_election_id, voting_date, reporting_date, county_name, vuid, voter_name, voting_method, method_code, party, precinct, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const v of votersToWrite) {
    const activityDate = resolveVoterActivityDate(v, vDate);
    insVoter.run([
      eid,
      activityDate,
      vDate,
      String(v.countyName ?? v.county ?? "").slice(0, 128),
      String(v.vuid ?? "").slice(0, 32),
      v.voterName != null ? String(v.voterName).slice(0, 256) : null,
      v.votingMethod != null ? String(v.votingMethod).slice(0, 64) : null,
      v.methodCode != null ? String(v.methodCode).slice(0, 8) : null,
      v.party != null ? String(v.party).slice(0, 16) : null,
      v.precinct != null ? String(v.precinct).slice(0, 64) : null,
      String(v.sourceKey ?? v.source ?? "sos").slice(0, 32),
    ]);
  }
  insVoter.free();
  const insLog = db.prepare(
    `INSERT INTO ev_roster_county_pull_log
      (pull_id, county_key, county_name, handler_key, ok, voter_count, source_url, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const log of countyPullLog ?? []) {
    insLog.run([
      pullId,
      String(log.countyKey ?? "").slice(0, 64),
      String(log.countyName ?? "").slice(0, 128),
      String(log.handlerKey ?? "").slice(0, 64),
      log.ok === false ? 0 : 1,
      Number(log.voterCount ?? 0),
      log.sourceUrl ?? null,
      String(log.message ?? "").slice(0, 2000),
    ]);
  }
  insLog.free();
  await rebuildEvRosterSummaryCache(eid, { db });
  await rebuildEvRosterSummaryCache(eid, { db });
  persistDb(db);
  return getEvRosterPullPayload(eid, vDate);
}

/**
 * One row per VUID per runoff election — keep earliest voting_date (then lowest id).
 * @returns {Promise<{ removed: number, distinctVuids: number }>}
 */
export async function dedupeEvRosterVotersKeepOldestDate(evrElectionId) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const eid = Number(evrElectionId);

  const beforeStmt = db.prepare(`SELECT COUNT(*) AS n FROM ev_roster_voters WHERE evr_election_id = ?`);
  beforeStmt.bind([eid]);
  beforeStmt.step();
  const before = Number(beforeStmt.getAsObject().n ?? 0);
  beforeStmt.free();

  db.run(
    `DELETE FROM ev_roster_voters
     WHERE evr_election_id = ?
     AND id NOT IN (
       SELECT id FROM (
         SELECT id,
           ROW_NUMBER() OVER (PARTITION BY vuid ORDER BY voting_date ASC, id ASC) AS rn
         FROM ev_roster_voters
         WHERE evr_election_id = ?
       ) ranked WHERE rn = 1
     )`,
    [eid, eid],
  );

  const afterStmt = db.prepare(`SELECT COUNT(*) AS n FROM ev_roster_voters WHERE evr_election_id = ?`);
  afterStmt.bind([eid]);
  afterStmt.step();
  const after = Number(afterStmt.getAsObject().n ?? 0);
  afterStmt.free();

  const distinctStmt = db.prepare(
    `SELECT COUNT(DISTINCT vuid) AS n FROM ev_roster_voters WHERE evr_election_id = ?`,
  );
  distinctStmt.bind([eid]);
  distinctStmt.step();
  const distinctVuids = Number(distinctStmt.getAsObject().n ?? 0);
  distinctStmt.free();

  db.run(
    `UPDATE ev_roster_pulls SET deduped_voter_count = (
       SELECT COUNT(*) FROM ev_roster_voters v
       WHERE v.evr_election_id = ev_roster_pulls.evr_election_id
         AND v.voting_date = ev_roster_pulls.voting_date
     )
     WHERE evr_election_id = ?`,
    [eid],
  );

  await rebuildEvRosterSummaryCache(eid, { db });
  persistDb(db);
  return { removed: Math.max(0, before - after), distinctVuids };
}

/** Merge voters for counties in this pull into an existing voting-date pull (single-county / incremental). */
export async function mergeEvRosterPull({
  evrElectionId,
  votingDate,
  hubPageUrl,
  sosTurnoutUrl,
  sosRosterUrl,
  statewideVoterCount,
  rawRecordCount,
  dedupedVoterCount,
  ok,
  message,
  countySummaries,
  voters,
  countyPullLog,
}) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const locked = await getConfirmedEvRosterCountyNames(eid, vDate);
  const { filterSummariesForLocked, filterVotersForLocked } = await import("./lib/evRosterCountyStatus.mjs");
  const countySummariesWritable = filterSummariesForLocked(countySummaries, locked);
  const votersWritable = filterVotersForLocked(voters, locked);

  let pullId = null;
  const findPull = db.prepare(
    `SELECT id FROM ev_roster_pulls WHERE evr_election_id = ? AND voting_date = ? LIMIT 1`,
  );
  findPull.bind([eid, vDate]);
  if (findPull.step()) pullId = Number(findPull.getAsObject().id);
  findPull.free();

  if (pullId == null) {
    db.run(
      `INSERT INTO ev_roster_pulls
        (evr_election_id, voting_date, hub_page_url, sos_turnout_url, sos_roster_url, statewide_voter_count,
         raw_record_count, deduped_voter_count, ok, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eid,
        vDate,
        hubPageUrl ?? null,
        sosTurnoutUrl ?? null,
        sosRosterUrl ?? null,
        Number(statewideVoterCount ?? 0),
        0,
        0,
        1,
        String(message ?? "Merged county pull").slice(0, 4000),
      ],
    );
    pullId = db.exec(`SELECT last_insert_rowid() AS id`)[0]?.values?.[0]?.[0];
  }

  const voterCountyNames = [
    ...new Set(
      (votersWritable ?? []).map((v) => String(v.countyName ?? v.county ?? "").toUpperCase()).filter(Boolean),
    ),
  ];
  for (const name of voterCountyNames) {
    db.run(
      `DELETE FROM ev_roster_voters WHERE evr_election_id = ? AND COALESCE(reporting_date, voting_date) = ? AND county_name = ?`,
      [eid, vDate, name],
    );
  }

  const summaryCountyNames = [
    ...new Set(
      (countySummariesWritable ?? []).map((c) => String(c.countyName ?? "").toUpperCase()).filter(Boolean),
    ),
  ];
  for (const name of summaryCountyNames) {
    db.run(`DELETE FROM ev_roster_county_summary WHERE pull_id = ? AND county_name = ?`, [pullId, name]);
  }

  const insCounty = db.prepare(
    `INSERT INTO ev_roster_county_summary
      (pull_id, county_name, county_id, registered_voters, in_person_votes_on_date, total_in_person_votes_for_election,
       total_mail_votes_for_election, cumulative_total, sos_voter_count, county_voter_count, chosen_source, chosen_voter_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of countySummariesWritable) {
    insCounty.run([
      pullId,
      String(c.countyName ?? "").slice(0, 128),
      c.countyId != null ? Number(c.countyId) : null,
      Number(c.registeredVoters ?? 0),
      Number(c.inPersonVotesOnDate ?? 0),
      Number(c.totalInPersonVotesForElection ?? 0),
      Number(c.totalMailVotesForElection ?? 0),
      Number(c.cumulativeTotal ?? 0),
      Number(c.sosVoterCount ?? 0),
      Number(c.countyVoterCount ?? 0),
      String(c.chosenSource ?? "county").slice(0, 32),
      Number(c.chosenVoterCount ?? 0),
    ]);
  }
  insCounty.free();

  const insVoter = db.prepare(
    `INSERT OR REPLACE INTO ev_roster_voters
      (evr_election_id, voting_date, reporting_date, county_name, vuid, voter_name, voting_method, method_code, party, precinct, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const v of votersWritable) {
    const activityDate = resolveVoterActivityDate(v, vDate);
    insVoter.run([
      eid,
      activityDate,
      vDate,
      String(v.countyName ?? v.county ?? "").slice(0, 128),
      String(v.vuid ?? "").slice(0, 32),
      v.voterName != null ? String(v.voterName).slice(0, 256) : null,
      v.votingMethod != null ? String(v.votingMethod).slice(0, 64) : null,
      v.methodCode != null ? String(v.methodCode).slice(0, 8) : null,
      v.party != null ? String(v.party).slice(0, 16) : null,
      v.precinct != null ? String(v.precinct).slice(0, 64) : null,
      String(v.sourceKey ?? v.source ?? "county").slice(0, 64),
    ]);
  }
  insVoter.free();

  const insLog = db.prepare(
    `INSERT INTO ev_roster_county_pull_log
      (pull_id, county_key, county_name, handler_key, ok, voter_count, source_url, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const log of countyPullLog ?? []) {
    insLog.run([
      pullId,
      String(log.countyKey ?? "").slice(0, 64),
      String(log.countyName ?? "").slice(0, 128),
      String(log.handlerKey ?? "").slice(0, 64),
      log.ok === false ? 0 : 1,
      Number(log.voterCount ?? 0),
      log.sourceUrl ?? null,
      String(log.message ?? "").slice(0, 2000),
    ]);
  }
  insLog.free();

  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ev_roster_voters WHERE evr_election_id = ? AND voting_date = ?`,
  );
  countStmt.bind([eid, vDate]);
  countStmt.step();
  const totalVoters = Number(countStmt.getAsObject().n ?? 0);
  countStmt.free();

  await dedupeEvRosterVotersKeepOldestDate(eid);

  const countAfterDedup = db.prepare(
    `SELECT COUNT(*) AS n FROM ev_roster_voters WHERE evr_election_id = ? AND voting_date = ?`,
  );
  countAfterDedup.bind([eid, vDate]);
  countAfterDedup.step();
  const totalVotersAfterDedup = Number(countAfterDedup.getAsObject().n ?? 0);
  countAfterDedup.free();

  db.run(
    `UPDATE ev_roster_pulls SET
      raw_record_count = COALESCE(raw_record_count, 0) + ?,
      deduped_voter_count = ?,
      message = ?,
      pulled_at = datetime('now'),
      ok = ?
     WHERE id = ?`,
    [
      Number(rawRecordCount ?? 0),
      totalVotersAfterDedup,
      String(message ?? "").slice(0, 4000),
      ok === false ? 0 : 1,
      pullId,
    ],
  );
  await rebuildEvRosterSummaryCache(eid, { db });
  persistDb(db);
  return getEvRosterPullPayload(eid, vDate);
}

export async function rebuildEvRosterSummaryCacheForElection(evrElectionId) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  return rebuildEvRosterSummaryCache(Number(evrElectionId), { db });
}

export async function listEvRosterVoters(evrElectionId, votingDate, options = {}) {
  const { normalizeVoterCountyFilter } = await import("./lib/evRosterVoters.mjs");
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 5000);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const countyList = normalizeVoterCountyFilter(options.counties, options.county);
  const q = options.q ? String(options.q).trim() : "";

  let where = `WHERE evr_election_id = ? AND voting_date = ?`;
  const params = [eid, vDate];
  if (countyList.length) {
    where += ` AND county_name IN (${countyList.map(() => "?").join(", ")})`;
    params.push(...countyList);
  }
  if (q) {
    where += ` AND (vuid LIKE ? OR county_name LIKE ? OR party LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM ev_roster_voters ${where}`);
  countStmt.bind(params);
  countStmt.step();
  const total = Number(countStmt.getAsObject().n ?? 0);
  countStmt.free();

  const stmt = db.prepare(
    `SELECT vuid, party, voting_date AS votingDate, county_name AS countyName,
            COALESCE(method_code, 'EV') AS methodCode
     FROM ev_roster_voters ${where}
     ORDER BY county_name, vuid
     LIMIT ? OFFSET ?`,
  );
  stmt.bind([...params, limit, offset]);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      vuid: String(r.vuid ?? ""),
      party: String(r.party ?? ""),
      votingDate: String(r.votingDate ?? ""),
      countyName: String(r.countyName ?? ""),
      methodCode: String(r.methodCode ?? "EV"),
    });
  }
  stmt.free();
  return { total, limit, offset, rows };
}

export async function listEvRosterPullDates(evrElectionId) {
  return listEvRosterPullDatesForElections([Number(evrElectionId)]);
}

export async function listEvRosterPullDatesForElections(evrElectionIds) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const placeholders = ids.map(() => "?").join(", ");
  const stmt = db.prepare(
    `SELECT voting_date AS votingDate, MAX(pulled_at) AS pulledAt,
            SUM(statewide_voter_count) AS statewideVoterCount, MIN(ok) AS okMin, MAX(message) AS message
     FROM ev_roster_pulls WHERE evr_election_id IN (${placeholders})
     GROUP BY voting_date ORDER BY voting_date DESC`,
  );
  stmt.bind(ids);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      votingDate: String(r.votingDate ?? ""),
      pulledAt: String(r.pulledAt ?? ""),
      statewideVoterCount: Number(r.statewideVoterCount ?? 0),
      ok: r.okMin == null ? true : !!r.okMin,
      message: String(r.message ?? ""),
    });
  }
  stmt.free();
  return rows;
}

/** Distinct activity dates on stored voter rows (county summary date filter). */
export async function listEvRosterVoterDatesForElections(evrElectionIds) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const placeholders = ids.map(() => "?").join(", ");
  const stmt = db.prepare(
    `SELECT voting_date AS votingDate, COUNT(DISTINCT vuid) AS voterCount
     FROM ev_roster_voters WHERE evr_election_id IN (${placeholders})
     GROUP BY voting_date ORDER BY voting_date DESC`,
  );
  stmt.bind(ids);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      votingDate: String(r.votingDate ?? ""),
      pulledAt: "",
      statewideVoterCount: Number(r.voterCount ?? 0),
      ok: true,
      message: "",
    });
  }
  stmt.free();
  return rows;
}

export async function getEvRosterAggregatedSummary(evrElectionIds, dateFrom, dateTo) {
  const { countiesFromVoterActivityInRange, computeSummaryTotals } = await import(
    "./lib/evRosterAggregateSummary.mjs"
  );
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  const from = String(dateFrom ?? "").trim();
  const to = String(dateTo ?? "").trim();
  if (!ids.length || !from || !to) {
    return { pull: null, counties: [], dateFrom: from, dateTo: to, countyPullLog: [] };
  }

  const db = await ensureDb();
  ensureEvRosterSchema(db);

  const {
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statewideDistinct,
    storedVoterCount,
  } = await loadSummaryRollupsFromCache(ids, from, to, { db });

  const ph = ids.map(() => "?").join(", ");
  const statusStmt = db.prepare(
    `SELECT county_name AS countyName, county_key AS countyKey, voting_date AS votingDate,
            last_pull_ok AS lastPullOk, last_pull_at AS lastPullAt, last_pull_message AS lastPullMessage,
            voter_count AS voterCount, confirmed_at AS confirmedAt
     FROM ev_roster_county_pull_status
     WHERE evr_election_id IN (${ph})`,
  );
  statusStmt.bind(ids);
  /** @type {Map<string, object>} */
  const statusByCounty = new Map();
  while (statusStmt.step()) {
    const s = statusStmt.getAsObject();
    const county = String(s.countyName ?? "").toUpperCase();
    const vDate = String(s.votingDate ?? "");
    const prev = statusByCounty.get(county);
    if (!prev || vDate >= String(prev.votingDate ?? "")) {
      statusByCounty.set(county, {
        votingDate: vDate,
        lastPullOk: s.lastPullOk == null ? null : !!s.lastPullOk,
        lastPullAt: s.lastPullAt ? String(s.lastPullAt) : null,
        lastPullMessage: s.lastPullMessage ? String(s.lastPullMessage) : null,
        voterCount: Number(s.voterCount ?? 0),
        confirmedAt: s.confirmedAt ? String(s.confirmedAt) : null,
      });
    }
  }
  statusStmt.free();

  const counties = countiesFromVoterActivityInRange({
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statusByCounty,
  });

  const summaryTotals = computeSummaryTotals(
    { registeredByCounty, evInPersonDayByCounty },
    0,
    statewideDistinct,
  );
  summaryTotals.cumulativeTotal = storedVoterCount || summaryTotals.cumulativeTotal;
  summaryTotals.chosenVoterCount = storedVoterCount;

  const pullStmt = db.prepare(
    `SELECT MAX(pulled_at) AS pulledAt, MIN(ok) AS okMin FROM ev_roster_pulls WHERE evr_election_id IN (${ph})`,
  );
  pullStmt.bind(ids);
  pullStmt.step();
  const pullAgg = pullStmt.getAsObject();
  pullStmt.free();

  return {
    dateFrom: from,
    dateTo: to,
    pull: {
      evrElectionIds: ids,
      votingDate: `${from}..${to}`,
      pulledAt: String(pullAgg.pulledAt ?? ""),
      ok: pullAgg.okMin == null ? true : !!pullAgg.okMin,
      storedVoterCount,
      dedupedVoterCount: storedVoterCount,
      message: `Voter activity ${from} through ${to}`,
    },
    counties,
    countyPullLog: [],
    summaryTotals,
  };
}

export async function getEvRosterPullPayload(evrElectionId, votingDate) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const pullStmt = db.prepare(
    `SELECT id, evr_election_id AS evrElectionId, voting_date AS votingDate, hub_page_url AS hubPageUrl,
            sos_turnout_url AS sosTurnoutUrl, sos_roster_url AS sosRosterUrl, statewide_voter_count AS statewideVoterCount,
            raw_record_count AS rawRecordCount, deduped_voter_count AS dedupedVoterCount,
            pulled_at AS pulledAt, ok, message
     FROM ev_roster_pulls WHERE evr_election_id = ? AND voting_date = ? LIMIT 1`,
  );
  pullStmt.bind([eid, vDate]);
  if (!pullStmt.step()) {
    pullStmt.free();
    return null;
  }
  const pull = pullStmt.getAsObject();
  pullStmt.free();
  const pullId = Number(pull.id);
  const countyStmt = db.prepare(
    `SELECT county_name AS countyName, county_id AS countyId, registered_voters AS registeredVoters,
            in_person_votes_on_date AS inPersonVotesOnDate, total_in_person_votes_for_election AS totalInPersonVotesForElection,
            total_mail_votes_for_election AS totalMailVotesForElection, cumulative_total AS cumulativeTotal,
            sos_voter_count AS sosVoterCount, county_voter_count AS countyVoterCount,
            chosen_source AS chosenSource, chosen_voter_count AS chosenVoterCount
     FROM ev_roster_county_summary WHERE pull_id = ? ORDER BY county_name`,
  );
  countyStmt.bind([pullId]);
  const pullStatuses = await listEvRosterCountyPullStatuses(eid, vDate);
  const statusByCounty = new Map(pullStatuses.map((s) => [String(s.countyName).toUpperCase(), s]));
  const counties = [];
  while (countyStmt.step()) {
    const r = countyStmt.getAsObject();
    const countyName = String(r.countyName ?? "");
    const st = statusByCounty.get(countyName.toUpperCase());
    counties.push({
      countyName,
      countyId: r.countyId != null ? Number(r.countyId) : null,
      registeredVoters: Number(r.registeredVoters ?? 0),
      inPersonVotesOnDate: Number(r.inPersonVotesOnDate ?? 0),
      totalInPersonVotesForElection: Number(r.totalInPersonVotesForElection ?? 0),
      totalMailVotesForElection: Number(r.totalMailVotesForElection ?? 0),
      cumulativeTotal: Number(r.cumulativeTotal ?? 0),
      sosVoterCount: Number(r.sosVoterCount ?? 0),
      countyVoterCount: Number(r.countyVoterCount ?? 0),
      chosenSource: String(r.chosenSource ?? "sos"),
      chosenVoterCount: Number(r.chosenVoterCount ?? 0),
      pullStatus: st
        ? {
            lastPullOk: st.lastPullOk,
            lastPullAt: st.lastPullAt,
            lastPullMessage: st.lastPullMessage,
            voterCount: st.voterCount,
            confirmedAt: st.confirmedAt,
          }
        : null,
    });
  }
  countyStmt.free();
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ev_roster_voters WHERE evr_election_id = ? AND voting_date = ?`,
  );
  countStmt.bind([eid, vDate]);
  countStmt.step();
  const storedVoterCount = Number(countStmt.getAsObject().n ?? 0);
  countStmt.free();
  return {
    pull: {
      evrElectionId: eid,
      votingDate: String(pull.votingDate ?? ""),
      hubPageUrl: pull.hubPageUrl ? String(pull.hubPageUrl) : null,
      sosTurnoutUrl: pull.sosTurnoutUrl ? String(pull.sosTurnoutUrl) : null,
      sosRosterUrl: pull.sosRosterUrl ? String(pull.sosRosterUrl) : null,
      statewideVoterCount: Number(pull.statewideVoterCount ?? 0),
      rawRecordCount: Number(pull.rawRecordCount ?? 0),
      dedupedVoterCount: Number(pull.dedupedVoterCount ?? 0),
      pulledAt: String(pull.pulledAt ?? ""),
      ok: !!pull.ok,
      message: String(pull.message ?? ""),
      storedVoterCount,
    },
    counties,
    countyPullLog: await getEvRosterCountyPullLog(eid, vDate),
  };
}

export async function listEvRosterCountySources(evrElectionId) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const stmt = db.prepare(
    `SELECT id, evr_election_id AS evrElectionId, county_key AS countyKey, variant_key AS variantKey,
            source_label AS sourceLabel, civix_county_name AS civixCountyName, civix_county_id AS civixCountyId,
            handler_key AS handlerKey, hub_page_url AS hubPageUrl, roster_url AS rosterUrl,
            voting_method_scope AS votingMethodScope, date_scope AS dateScope, file_format AS fileFormat,
            roster_party_scope AS rosterPartyScope,
            discovery_profile_key AS discoveryProfileKey, training_notes AS trainingNotes,
            is_enabled AS isEnabled, last_pull_ok AS lastPullOk, last_pull_message AS lastPullMessage, last_pull_at AS lastPullAt
     FROM ev_roster_county_sources WHERE evr_election_id = ? ORDER BY civix_county_name, variant_key`,
  );
  stmt.bind([Number(evrElectionId)]);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      id: Number(r.id),
      evrElectionId: Number(r.evrElectionId),
      countyKey: String(r.countyKey ?? ""),
      variantKey: String(r.variantKey ?? "sos-default"),
      sourceLabel: String(r.sourceLabel ?? ""),
      civixCountyName: String(r.civixCountyName ?? ""),
      civixCountyId: r.civixCountyId != null ? Number(r.civixCountyId) : null,
      handlerKey: String(r.handlerKey ?? "civix_sos_county_slice"),
      hubPageUrl: String(r.hubPageUrl ?? ""),
      rosterUrl: String(r.rosterUrl ?? ""),
      votingMethodScope: String(r.votingMethodScope ?? "ALL"),
      dateScope: String(r.dateScope ?? "SINGLE_DAY"),
      fileFormat: String(r.fileFormat ?? "auto"),
      rosterPartyScope: String(r.rosterPartyScope ?? "COMBINED"),
      discoveryProfileKey: r.discoveryProfileKey ? String(r.discoveryProfileKey) : null,
      trainingNotes: r.trainingNotes ? String(r.trainingNotes) : null,
      isEnabled: !!r.isEnabled,
      lastPullOk: r.lastPullOk == null ? null : !!r.lastPullOk,
      lastPullMessage: r.lastPullMessage ? String(r.lastPullMessage) : null,
      lastPullAt: r.lastPullAt ? String(r.lastPullAt) : null,
    });
  }
  stmt.free();
  return rows;
}

export async function upsertEvRosterCountySource(row) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const variantKey = String(row.variantKey ?? "custom").slice(0, 64);
  const params = [
    Number(row.evrElectionId),
    String(row.countyKey ?? "").slice(0, 64),
    variantKey,
    String(row.sourceLabel ?? "").slice(0, 256),
    String(row.civixCountyName ?? "").slice(0, 128),
    row.civixCountyId != null ? Number(row.civixCountyId) : null,
    String(row.handlerKey ?? "generic_file_url").slice(0, 64),
    String(row.hubPageUrl ?? "").slice(0, 2048),
    String(row.rosterUrl ?? "").slice(0, 2048),
    String(row.votingMethodScope ?? "ALL").slice(0, 16),
    String(row.dateScope ?? "SINGLE_DAY").slice(0, 32),
    String(row.fileFormat ?? "auto").slice(0, 16),
    String(row.rosterPartyScope ?? "COMBINED").slice(0, 16),
    row.discoveryProfileKey != null ? String(row.discoveryProfileKey).slice(0, 64) : null,
    row.trainingNotes != null ? String(row.trainingNotes).slice(0, 4000) : null,
    row.isEnabled === false ? 0 : 1,
  ];
  if (row.id != null) {
    db.run(
      `UPDATE ev_roster_county_sources SET
        source_label = ?, civix_county_name = ?, civix_county_id = COALESCE(?, civix_county_id),
        handler_key = ?, hub_page_url = ?, roster_url = ?,
        voting_method_scope = ?, date_scope = ?, file_format = ?, roster_party_scope = ?,
        discovery_profile_key = ?, training_notes = ?, is_enabled = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        params[3],
        params[4],
        params[5],
        params[6],
        params[7],
        params[8],
        params[9],
        params[10],
        params[11],
        params[12],
        params[13],
        params[14],
        params[15],
        Number(row.id),
      ],
    );
  } else {
    db.run(
      `INSERT INTO ev_roster_county_sources
        (evr_election_id, county_key, variant_key, source_label, civix_county_name, civix_county_id, handler_key,
         hub_page_url, roster_url, voting_method_scope, date_scope, file_format, roster_party_scope,
         discovery_profile_key, training_notes, is_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(evr_election_id, county_key, variant_key) DO UPDATE SET
         source_label = excluded.source_label,
         civix_county_name = excluded.civix_county_name,
         civix_county_id = COALESCE(excluded.civix_county_id, civix_county_id),
         handler_key = excluded.handler_key,
         hub_page_url = excluded.hub_page_url,
         roster_url = excluded.roster_url,
         voting_method_scope = excluded.voting_method_scope,
         date_scope = excluded.date_scope,
         file_format = excluded.file_format,
         roster_party_scope = excluded.roster_party_scope,
         discovery_profile_key = excluded.discovery_profile_key,
         training_notes = excluded.training_notes,
         is_enabled = excluded.is_enabled,
         updated_at = datetime('now')`,
      params,
    );
  }
  persistDb(db);
}

export async function syncEvRosterCountySourcesFromTurnout(evrElectionId, counties) {
  const { civixCountyNameToKey } = await import("./lib/texasCountyKeys.mjs");
  for (const c of counties ?? []) {
    const name = String(c.name ?? c.countyName ?? "").toUpperCase();
    if (!name || name === "TOTAL") continue;
    const countyKey = civixCountyNameToKey(name);
    await upsertEvRosterCountySource({
      evrElectionId,
      countyKey,
      variantKey: "sos-default",
      sourceLabel: "SOS default",
      civixCountyName: name,
      civixCountyId: c.id ?? c.countyId ?? null,
      handlerKey: "civix_sos_county_slice",
      hubPageUrl: "",
      rosterUrl: "",
      votingMethodScope: "ALL",
      dateScope: "SINGLE_DAY",
      fileFormat: "auto",
      isEnabled: true,
    });
  }
  return listEvRosterCountySources(evrElectionId);
}

export async function getEvRosterExportRows(evrElectionId, votingDate) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const stmt = db.prepare(
    `SELECT vuid, party, voting_date AS votingDate, county_name AS countyName,
            COALESCE(method_code, 'EV') AS methodCode
     FROM ev_roster_voters WHERE evr_election_id = ? AND voting_date = ? ORDER BY county_name, vuid`,
  );
  stmt.bind([Number(evrElectionId), String(votingDate ?? "").trim()]);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      vuid: String(r.vuid ?? ""),
      party: String(r.party ?? ""),
      votingDate: String(r.votingDate ?? ""),
      countyName: String(r.countyName ?? ""),
      methodCode: String(r.methodCode ?? "EV"),
    });
  }
  stmt.free();
  return rows;
}

export async function getEvRosterCountyPullLog(evrElectionId, votingDate) {
  const db = await ensureDb();
  ensureEvRosterSchema(db);
  const pullStmt = db.prepare(
    `SELECT id FROM ev_roster_pulls WHERE evr_election_id = ? AND voting_date = ? LIMIT 1`,
  );
  pullStmt.bind([Number(evrElectionId), String(votingDate ?? "").trim()]);
  if (!pullStmt.step()) {
    pullStmt.free();
    return [];
  }
  const pullId = Number(pullStmt.getAsObject().id);
  pullStmt.free();
  const stmt = db.prepare(
    `SELECT county_key AS countyKey, county_name AS countyName, handler_key AS handlerKey, ok,
            voter_count AS voterCount, source_url AS sourceUrl, message
     FROM ev_roster_county_pull_log WHERE pull_id = ? ORDER BY county_name`,
  );
  stmt.bind([pullId]);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      countyKey: String(r.countyKey ?? ""),
      countyName: String(r.countyName ?? ""),
      handlerKey: String(r.handlerKey ?? ""),
      ok: !!r.ok,
      voterCount: Number(r.voterCount ?? 0),
      sourceUrl: r.sourceUrl ? String(r.sourceUrl) : null,
      message: String(r.message ?? ""),
    });
  }
  stmt.free();
  return rows;
}
