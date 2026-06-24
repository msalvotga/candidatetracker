import fs from "node:fs";
import { fileURLToPath } from "node:url";

function slugKey(label, fallbackPrefix, id) {
  const letters = String(label ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (letters.length >= 2) return letters.slice(0, 12);
  return `${fallbackPrefix}${id}`;
}

function tableExists(database, name) {
  return Boolean(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  );
}

function columnExists(database, table, column) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => col.name === column);
}

export function migrateTargetingAndConsultants(database) {
  const schemaPath = fileURLToPath(new URL("../../schema-ref-targets-consultants.sql", import.meta.url));
  database.exec(fs.readFileSync(schemaPath, "utf8"));

  const orgHasKey = columnExists(database, "targeting_organizations", "org_key");
  if (!orgHasKey && tableExists(database, "targeting_organizations")) {
    const oldOrgs = database.prepare(`SELECT id, name FROM targeting_organizations`).all();
    database.exec(`
      CREATE TABLE targeting_organizations_new (
        org_key TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );
    `);
    const insertOrg = database.prepare(
      `INSERT OR IGNORE INTO targeting_organizations_new (org_key, name) VALUES (?, ?)`
    );
    const idToKey = new Map();
    for (const row of oldOrgs) {
      const key = slugKey(row.name, "ORG", row.id);
      insertOrg.run(key, row.name);
      idToKey.set(row.id, key);
    }
    database.exec(`DROP TABLE targeting_organizations`);
    database.exec(`ALTER TABLE targeting_organizations_new RENAME TO targeting_organizations`);

    if (tableExists(database, "race_targets")) {
      if (!tableExists(database, "office_targets")) {
        database.exec(`
          CREATE TABLE office_targets (
            office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
            cycle_year INTEGER NOT NULL,
            org_key TEXT NOT NULL REFERENCES targeting_organizations(org_key) ON DELETE CASCADE,
            PRIMARY KEY (office_id, cycle_year, org_key)
          );
        `);
      }
      const oldTargets = database
        .prepare(`SELECT office_id, cycle_year, organization_id FROM race_targets`)
        .all();
      const insertTarget = database.prepare(
        `INSERT OR IGNORE INTO office_targets (office_id, cycle_year, org_key) VALUES (?, ?, ?)`
      );
      for (const row of oldTargets) {
        const key = idToKey.get(row.organization_id);
        if (key) insertTarget.run(row.office_id, row.cycle_year, key);
      }
      database.exec(`DROP TABLE race_targets`);
    }
  } else if (tableExists(database, "race_targets") && !tableExists(database, "office_targets")) {
    database.exec(`ALTER TABLE race_targets RENAME TO office_targets_old`);
    database.exec(`
      CREATE TABLE office_targets (
        office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
        cycle_year INTEGER NOT NULL,
        org_key TEXT NOT NULL REFERENCES targeting_organizations(org_key) ON DELETE CASCADE,
        PRIMARY KEY (office_id, cycle_year, org_key)
      );
    `);
    database.exec(`DROP TABLE office_targets_old`);
  }

  if (!tableExists(database, "consultants")) {
    database.exec(`
      CREATE TABLE consultants (
        consultant_key TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );
    `);
  }

  if (!tableExists(database, "candidate_consultants")) {
    database.exec(`
      CREATE TABLE candidate_consultants (
        candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        consultant_key TEXT NOT NULL REFERENCES consultants(consultant_key) ON DELETE CASCADE,
        PRIMARY KEY (candidate_id, consultant_key)
      );
    `);
  }

  migrateLegacyConsultantText(database);
}

function migrateLegacyConsultantText(database) {
  if (!columnExists(database, "candidates", "consultant")) return;

  database.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const done = database
    .prepare(`SELECT value FROM app_meta WHERE key = 'legacy_consultant_migrated'`)
    .get();
  if (done?.value === "1") return;

  if (tableExists(database, "candidate_consultants")) {
    const hasLinks = database.prepare(`SELECT 1 FROM candidate_consultants LIMIT 1`).get();
    if (hasLinks) {
      database
        .prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('legacy_consultant_migrated', '1')`)
        .run();
      return;
    }
  }

  const rows = database
    .prepare(`SELECT id, consultant FROM candidates WHERE consultant IS NOT NULL AND TRIM(consultant) != ''`)
    .all();

  const insertConsultant = database.prepare(
    `INSERT OR IGNORE INTO consultants (consultant_key, name) VALUES (?, ?)`
  );
  const link = database.prepare(
    `INSERT OR IGNORE INTO candidate_consultants (candidate_id, consultant_key) VALUES (?, ?)`
  );

  for (const row of rows) {
    const name = String(row.consultant).trim();
    if (!name) continue;
    const key = slugKey(name, "CON", row.id);
    insertConsultant.run(key, name);
    link.run(row.id, key);
  }

  database
    .prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('legacy_consultant_migrated', '1')`)
    .run();
}
