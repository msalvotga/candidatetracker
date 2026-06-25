export async function listTargetingOrganizations(db) {
  return db
    .prepare(`SELECT org_key, name FROM targeting_organizations ORDER BY name COLLATE NOCASE`)
    .all();
}

export async function loadOfficeTargetsByOffice(db, category, cycleYear) {
  const rows = await db
    .prepare(
      `SELECT t.office_id, t.org_key, org.name
       FROM office_targets t
       JOIN offices o ON o.id = t.office_id
       JOIN targeting_organizations org ON org.org_key = t.org_key
       WHERE o.category = ? AND t.cycle_year = ?
       ORDER BY org.name COLLATE NOCASE`
    )
    .all(category, cycleYear);

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.office_id)) map.set(row.office_id, []);
    map.get(row.office_id).push({
      org_key: row.org_key,
      name: row.name,
    });
  }
  return map;
}

export function attachTargetsToRaces(races, targetsByOffice) {
  return races.map((race) => {
    const targets = targetsByOffice.get(race.office_id) ?? [];
    return {
      ...race,
      targeting_organizations: targets,
      targeting_organization_keys: targets.map((t) => t.org_key),
    };
  });
}

export async function syncOfficeTargets(db, officeId, cycleYear, orgKeys) {
  const keys = [...new Set(orgKeys.map((key) => String(key).trim()).filter(Boolean))];
  const apply = db.transaction(async () => {
    await db.prepare(`DELETE FROM office_targets WHERE office_id = ? AND cycle_year = ?`).run(officeId, cycleYear);
    const insert = db.prepare(
      `INSERT INTO office_targets (office_id, cycle_year, org_key) VALUES (?, ?, ?)`
    );
    for (const orgKey of keys) {
      await insert.run(officeId, cycleYear, orgKey);
    }
  });
  await apply();
  return keys;
}

export async function addTargetingOrganization(db, { org_key, name }) {
  const key = String(org_key ?? "").trim();
  const orgName = String(name ?? "").trim();
  if (!key || !orgName) throw new Error("org_key and name required");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error("org_key must start with a letter and contain only letters, numbers, _ or -");
  }
  await db.prepare(`INSERT INTO targeting_organizations (org_key, name) VALUES (?, ?)`).run(key, orgName);
  return { org_key: key, name: orgName };
}
