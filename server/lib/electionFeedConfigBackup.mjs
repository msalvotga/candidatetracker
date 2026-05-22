import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ELECTION_FEEDS_BACKUP_PATH = path.join(__dirname, "..", "data", "election-feed-configs.json");

/** @param {object} s */
function normalizeFeedSource(s) {
  return {
    countyKey: String(s.countyKey ?? "").trim().toLowerCase(),
    vendorId: String(s.vendorId ?? "").trim() || "other-vendor",
    sourceUrl: String(s.sourceUrl ?? ""),
    hubPageUrl: String(s.hubPageUrl ?? ""),
    isEnabled: s.isEnabled !== false,
    civixCountyName: String(s.civixCountyName ?? ""),
    preferOverSos: s.preferOverSos === true,
  };
}

/**
 * Persist county feeds for one election to a small JSON sidecar (survives when full elections.db export is skipped).
 * @param {string} electionId
 * @param {object[]} sources
 */
export function writeElectionFeedBackupForElection(electionId, sources) {
  const eid = String(electionId ?? "").trim();
  if (!eid) return;

  /** @type {{ savedAt: string, elections: Record<string, { updatedAt: string, sources: object[] }> }} */
  let payload = { savedAt: new Date().toISOString(), elections: {} };
  if (fs.existsSync(ELECTION_FEEDS_BACKUP_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ELECTION_FEEDS_BACKUP_PATH, "utf8"));
      if (raw && typeof raw === "object") {
        payload.savedAt = String(raw.savedAt ?? payload.savedAt);
        payload.elections = raw.elections && typeof raw.elections === "object" ? raw.elections : {};
      }
    } catch {
      /* rewrite corrupt backup */
    }
  }

  const now = new Date().toISOString();
  payload.savedAt = now;
  payload.elections[eid] = {
    updatedAt: now,
    sources: (sources ?? []).map(normalizeFeedSource).filter((s) => s.countyKey),
  };

  fs.mkdirSync(path.dirname(ELECTION_FEEDS_BACKUP_PATH), { recursive: true });
  fs.writeFileSync(ELECTION_FEEDS_BACKUP_PATH, JSON.stringify(payload, null, 2), "utf8");
}

/** Remove one election from the feed-config sidecar (e.g. after deleting source configuration). */
export function removeElectionFeedBackupForElection(electionId) {
  const eid = String(electionId ?? "").trim();
  if (!eid || !fs.existsSync(ELECTION_FEEDS_BACKUP_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(ELECTION_FEEDS_BACKUP_PATH, "utf8"));
    if (!raw?.elections || typeof raw.elections !== "object") return;
    delete raw.elections[eid];
    raw.savedAt = new Date().toISOString();
    fs.writeFileSync(ELECTION_FEEDS_BACKUP_PATH, JSON.stringify(raw, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

/** @returns {Record<string, { updatedAt: string, sources: object[] }>} */
export function readElectionFeedBackupByElection() {
  if (!fs.existsSync(ELECTION_FEEDS_BACKUP_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(ELECTION_FEEDS_BACKUP_PATH, "utf8"));
    return raw?.elections && typeof raw.elections === "object" ? raw.elections : {};
  } catch {
    return {};
  }
}

/**
 * @param {import("sql.js").Database} db
 * @param {string} electionId
 * @param {object[]} sources
 */
function insertFeedSourcesIntoDb(db, electionId, sources) {
  const eid = String(electionId ?? "").trim();
  const now = new Date().toISOString();
  db.run(`DELETE FROM election_feed_sources WHERE election_id = ?`, [eid]);
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
}

/**
 * Restore county feeds from JSON when disk DB is stale or empty (large-db deferred persist).
 * @param {import("sql.js").Database} db
 */
export function restoreElectionFeedsFromBackup(db) {
  const byElection = readElectionFeedBackupByElection();
  let restoredRows = 0;

  for (const [eid, block] of Object.entries(byElection)) {
    const sources = Array.isArray(block?.sources) ? block.sources : [];
    if (!sources.length) continue;

    const stmt = db.prepare(
      `SELECT COUNT(*) AS c, MAX(updated_at) AS maxAt FROM election_feed_sources WHERE election_id = ?`,
    );
    stmt.bind([eid]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();

    const dbCount = Number(row.c ?? 0);
    const dbMax = String(row.maxAt ?? "");
    const backupAt = String(block.updatedAt ?? "");

    const shouldRestore =
      dbCount === 0 ||
      (backupAt && (!dbMax || backupAt > dbMax)) ||
      (sources.length > dbCount && backupAt >= dbMax);

    if (!shouldRestore) continue;

    insertFeedSourcesIntoDb(db, eid, sources);
    restoredRows += sources.length;
  }

  return restoredRows;
}

/**
 * Restore one election's feeds from JSON into SQLite (used when DB row set is empty but backup exists).
 * @param {import("sql.js").Database} db
 * @param {string} electionId
 */
export function restoreSingleElectionFeedsFromBackup(db, electionId) {
  const eid = String(electionId ?? "").trim();
  const block = readElectionFeedBackupByElection()[eid];
  const sources = Array.isArray(block?.sources) ? block.sources : [];
  if (!sources.length) return 0;
  insertFeedSourcesIntoDb(db, eid, sources);
  return sources.length;
}
