import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ELECTION_CONFIGS_BACKUP_PATH = path.join(__dirname, "..", "data", "election-source-configs.json");

/**
 * Small JSON sidecar so election rows survive when full elections.db export fails (low RAM).
 * @param {Array<object>} rows
 */
export function writeElectionConfigBackup(rows) {
  fs.mkdirSync(path.dirname(ELECTION_CONFIGS_BACKUP_PATH), { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    elections: rows.map((r) => ({
      electionId: String(r.electionId ?? ""),
      label: String(r.label ?? ""),
      isEnabled: r.isEnabled !== false,
      autoRefreshEnabled: r.autoRefreshEnabled !== false,
      usesCivixSos: r.usesCivixSos !== false,
      showInCatalog: r.showInCatalog !== false,
      isDefaultCatalog: !!r.isDefaultCatalog,
      sosCountyInfoUrl: String(r.sosCountyInfoUrl ?? ""),
      harrisSourceUrl: String(r.harrisSourceUrl ?? ""),
      galvestonSourceUrl: String(r.galvestonSourceUrl ?? ""),
      jeffersonSourceUrl: String(r.jeffersonSourceUrl ?? ""),
      montgomerySourceUrl: String(r.montgomerySourceUrl ?? ""),
      chambersSourceUrl: String(r.chambersSourceUrl ?? ""),
      updatedAt: String(r.updatedAt ?? new Date().toISOString()),
    })),
  };
  fs.writeFileSync(ELECTION_CONFIGS_BACKUP_PATH, JSON.stringify(payload, null, 2), "utf8");
}

/** @returns {Array<object>} */
export function readElectionConfigBackup() {
  if (!fs.existsSync(ELECTION_CONFIGS_BACKUP_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(ELECTION_CONFIGS_BACKUP_PATH, "utf8"));
    return Array.isArray(raw?.elections) ? raw.elections : [];
  } catch {
    return [];
  }
}

/**
 * Restore any elections present in the JSON backup but missing from SQLite.
 * @param {import("sql.js").Database} db
 */
export function restoreElectionConfigsFromBackup(db) {
  const backup = readElectionConfigBackup();
  if (!backup.length) return 0;

  const existing = new Set();
  const stmt = db.prepare(`SELECT election_id FROM election_source_configs`);
  while (stmt.step()) existing.add(String(stmt.getAsObject().election_id ?? ""));
  stmt.free();

  const ins = db.prepare(
    `INSERT OR IGNORE INTO election_source_configs
      (election_id, label, is_enabled, auto_refresh_enabled, uses_civix_sos, show_in_catalog, is_default_catalog,
       sos_countyinfo_url, harris_source_url, galveston_source_url, jefferson_source_url,
       montgomery_source_url, chambers_source_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let restored = 0;
  for (const r of backup) {
    const id = String(r.electionId ?? "").trim();
    if (!id || existing.has(id)) continue;
    ins.run([
      id,
      String(r.label ?? id),
      r.isEnabled === false ? 0 : 1,
      r.autoRefreshEnabled === false ? 0 : 1,
      r.usesCivixSos === false ? 0 : 1,
      r.showInCatalog === false ? 0 : 1,
      r.isDefaultCatalog ? 1 : 0,
      String(r.sosCountyInfoUrl ?? ""),
      String(r.harrisSourceUrl ?? ""),
      String(r.galvestonSourceUrl ?? ""),
      String(r.jeffersonSourceUrl ?? ""),
      String(r.montgomerySourceUrl ?? ""),
      String(r.chambersSourceUrl ?? ""),
      String(r.updatedAt ?? new Date().toISOString()),
    ]);
    existing.add(id);
    restored += 1;
  }
  ins.free();
  return restored;
}

/**
 * Apply home-default flag from JSON sidecar (survives when full elections.db export is skipped).
 * @param {import("sql.js").Database} db
 * @returns {boolean} whether a default was applied
 */
export function applyDefaultCatalogFromBackup(db) {
  const backup = readElectionConfigBackup();
  const defaults = backup.filter((r) => r.isDefaultCatalog);
  if (defaults.length !== 1) return false;

  const id = String(defaults[0].electionId ?? "").trim();
  if (!id) return false;

  const exists = db.prepare(`SELECT 1 FROM election_source_configs WHERE election_id = ? LIMIT 1`);
  exists.bind([id]);
  const ok = exists.step();
  exists.free();
  if (!ok) return false;

  db.run(`UPDATE election_source_configs SET is_default_catalog = 0`);
  db.run(`UPDATE election_source_configs SET is_default_catalog = 1, updated_at = datetime('now') WHERE election_id = ?`, [
    id,
  ]);
  return true;
}
