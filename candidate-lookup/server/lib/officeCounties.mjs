import { TEXAS_COUNTIES } from "../data/texas-counties.mjs";

export async function syncOfficeCounties(db, officeId, countyNames) {
  const names = [
    ...new Set(
      countyNames
        .map((name) => String(name ?? "").trim())
        .filter(Boolean)
    ),
  ];

  for (const name of names) {
    if (!TEXAS_COUNTIES.includes(name)) throw new Error(`invalid county: ${name}`);
  }

  const apply = db.transaction(async () => {
    await db.prepare(`DELETE FROM office_counties WHERE office_id = ?`).run(officeId);
    const insert = db.prepare(`INSERT INTO office_counties (office_id, county_name) VALUES (?, ?)`);
    for (const name of names) {
      await insert.run(officeId, name);
    }
  });
  await apply();
}

export async function loadOfficeCountiesMap(db) {
  const map = new Map();

  const rows = await db.prepare(`SELECT office_id, county_name FROM office_counties`).all();
  for (const row of rows) {
    if (!map.has(row.office_id)) map.set(row.office_id, new Set());
    map.get(row.office_id).add(row.county_name);
  }

  const singleCountyRows = await db
    .prepare(`SELECT id, county_name FROM offices WHERE county_name IS NOT NULL AND TRIM(county_name) != ''`)
    .all();
  for (const row of singleCountyRows) {
    if (!map.has(row.id)) map.set(row.id, new Set());
    map.get(row.id).add(String(row.county_name).trim());
  }

  return map;
}

export async function enrichOfficeRowsWithCounties(db, rows) {
  if (!rows.length) return [];

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map((_, index) => `@id${index}`).join(", ");
  const params = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));

  const countyRows = await db
    .prepare(
      `SELECT office_id, county_name
       FROM office_counties
       WHERE office_id IN (${placeholders})
       ORDER BY county_name`
    )
    .all(params);

  const countiesByOffice = new Map();
  for (const row of countyRows) {
    if (!countiesByOffice.has(row.office_id)) countiesByOffice.set(row.office_id, []);
    countiesByOffice.get(row.office_id).push(row.county_name);
  }

  return rows.map((row) => {
    const counties = countiesByOffice.get(row.id) ?? [];
    return {
      ...row,
      county_names: counties.join(","),
      county_labels: counties.join(", "),
    };
  });
}
