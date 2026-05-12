import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

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

function readHealthyDbFromPath(SQL, dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const file = fs.readFileSync(dbPath);
  const db = new SQL.Database(file);
  if (!isDbHealthy(db)) return null;
  return {
    db,
    path: dbPath,
    mtimeMs: fs.statSync(dbPath).mtimeMs,
  };
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
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(WASM_PATH) });
    const primary = readHealthyDbFromPath(SQL, DB_PATH);
    const recovery = readHealthyDbFromPath(SQL, RECOVERY_DB_PATH);
    const picked = primary || recovery;
    if (picked) {
      _db = picked.db;
      _activeDbPath = picked.path;
      _dbMtimeMs = picked.mtimeMs;
      initSchema(_db);
    }
  } catch {
    /* keep current in-memory DB */
  }
}

async function recoverDatabaseInstance() {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(WASM_PATH) });
  _activeDbPath = RECOVERY_DB_PATH;
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
  return _db;
}

function persistDb(db) {
  const targetPath = selectWritableDbPath(_activeDbPath);
  _activeDbPath = targetPath;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const data = db.export();
  fs.writeFileSync(targetPath, Buffer.from(data));
  try {
    _dbMtimeMs = fs.statSync(targetPath).mtimeMs;
  } catch {
    _dbMtimeMs = 0;
  }
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
    if (!names.includes("county_prefer_over_sos_json")) {
      db.run(`ALTER TABLE election_source_configs ADD COLUMN county_prefer_over_sos_json TEXT NOT NULL DEFAULT '[]'`);
      persistDb(db);
    }
  } catch {
    /* ignore */
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

function migrateLegacyJsonIfNeeded(db) {
  const cStmt = db.prepare("SELECT COUNT(*) AS c FROM manual_elections");
  cStmt.step();
  const count = Number(cStmt.getAsObject().c);
  cStmt.free();
  if (count > 0) return;
  if (!fs.existsSync(LEGACY_MANIFEST)) return;

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
}

export async function ensureDb() {
  if (_db) {
    try {
      if (!isDbHealthy(_db)) {
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
    try {
      // Prefer the primary DB file users edit directly; use recovery only when needed.
      const primary = readHealthyDbFromPath(SQL, DB_PATH);
      const recovery = readHealthyDbFromPath(SQL, RECOVERY_DB_PATH);
      const picked = primary || recovery;
      if (picked) {
        _db = picked.db;
        _activeDbPath = picked.path;
        _dbMtimeMs = picked.mtimeMs;
      } else {
        _db = new SQL.Database();
        _activeDbPath = selectWritableDbPath(DB_PATH);
        _dbMtimeMs = 0;
      }
    } catch (err) {
      // Primary DB is corrupted/locked; continue on a clean recovery file.
      if (!isMalformedError(err) && !isFileLockedError(err)) throw err;
      return await recoverDatabaseInstance();
    }
    initSchema(_db);
    migrateLegacyJsonIfNeeded(_db);
    persistDb(_db);
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
  persistDb(db);
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
            uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog,
            sos_countyinfo_url AS sosCountyInfoUrl, harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl,
            jefferson_source_url AS jeffersonSourceUrl, montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl,
            updated_at AS updatedAt
     FROM election_source_configs
     ORDER BY election_id`,
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
            uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog,
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
