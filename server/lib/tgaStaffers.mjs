import { TEXAS_COUNTIES } from "../data/texas-counties.mjs";
import { parseKeyList } from "./consultants.mjs";
import { loadOfficeCountiesMap } from "./officeCounties.mjs";

export const TGA_STAFFER_EDITABLE_COLUMNS = ["name", "office_ids", "county_names"];

export async function syncStafferOffices(db, stafferId, officeIds) {
  const ids = [
    ...new Set(
      officeIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];

  const apply = db.transaction(async () => {
    await db.prepare(`DELETE FROM tga_staffer_offices WHERE staffer_id = ?`).run(stafferId);
    const insert = db.prepare(`INSERT INTO tga_staffer_offices (staffer_id, office_id) VALUES (?, ?)`);
    for (const officeId of ids) {
      const office = await db.prepare(`SELECT id FROM offices WHERE id = ? AND category != 'statewide'`).get(officeId);
      if (!office) throw new Error(`office ${officeId} not found or is statewide`);
      await insert.run(stafferId, officeId);
    }
  });
  await apply();
}

export async function syncStafferCounties(db, stafferId, countyNames) {
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
    await db.prepare(`DELETE FROM tga_staffer_counties WHERE staffer_id = ?`).run(stafferId);
    const insert = db.prepare(`INSERT INTO tga_staffer_counties (staffer_id, county_name) VALUES (?, ?)`);
    for (const name of names) {
      await insert.run(stafferId, name);
    }
  });
  await apply();
}

export async function enrichTgaStafferRows(db, rows) {
  if (!rows.length) return [];

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map((_, index) => `@id${index}`).join(", ");
  const params = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));

  const officeRows = await db
    .prepare(
      `SELECT so.staffer_id, o.id AS office_id, o.office_code, o.office_name, o.category
       FROM tga_staffer_offices so
       JOIN offices o ON o.id = so.office_id
       WHERE so.staffer_id IN (${placeholders})
       ORDER BY o.category, o.sort_order, o.district, o.office_code`
    )
    .all(params);

  const countyRows = await db
    .prepare(
      `SELECT staffer_id, county_name
       FROM tga_staffer_counties
       WHERE staffer_id IN (${placeholders})
       ORDER BY county_name`
    )
    .all(params);

  const officesByStaffer = new Map();
  for (const row of officeRows) {
    if (!officesByStaffer.has(row.staffer_id)) officesByStaffer.set(row.staffer_id, []);
    officesByStaffer.get(row.staffer_id).push(row);
  }

  const countiesByStaffer = new Map();
  for (const row of countyRows) {
    if (!countiesByStaffer.has(row.staffer_id)) countiesByStaffer.set(row.staffer_id, []);
    countiesByStaffer.get(row.staffer_id).push(row.county_name);
  }

  return rows.map((row) => {
    const offices = officesByStaffer.get(row.id) ?? [];
    const counties = countiesByStaffer.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      office_ids: offices.map((office) => String(office.office_id)).join(","),
      office_codes: offices.map((office) => office.office_code).join(", "),
      office_labels: offices.map((office) => `${office.office_code} — ${office.office_name}`).join("; "),
      county_names: counties.join(","),
      county_labels: counties.join(", "),
    };
  });
}

export async function fetchTgaStafferRow(db, stafferId) {
  const row = await db.prepare(`SELECT id, name FROM tga_staffers WHERE id = ?`).get(stafferId);
  if (!row) return null;
  const [enriched] = await enrichTgaStafferRows(db, [row]);
  return enriched;
}

/** County coverage for the staffer map (direct county assignments only). */
export async function fetchStafferMapData(db) {
  const stafferRows = await db.prepare(`SELECT id, name FROM tga_staffers ORDER BY name`).all();
  if (!stafferRows.length) return { staffers: [] };

  const enriched = await enrichTgaStafferRows(db, stafferRows);

  const staffers = [];
  for (const row of enriched) {
    const counties = [...new Set(parseKeyList(row.county_names))].sort((a, b) => a.localeCompare(b));
    if (!counties.length) continue;
    staffers.push({
      id: row.id,
      name: row.name,
      counties,
    });
  }

  return { staffers };
}

function staffersForOffice(officeId, stafferRows, officeCountiesMap) {
  const officeCounties = officeCountiesMap.get(officeId) ?? new Set();
  const matched = new Set();
  const names = [];

  for (const staffer of stafferRows) {
    const officeIds = parseKeyList(staffer.office_ids);
    if (officeIds.includes(String(officeId))) {
      if (!matched.has(staffer.id)) {
        matched.add(staffer.id);
        names.push(staffer.name);
      }
      continue;
    }

    const stafferCounties = parseKeyList(staffer.county_names);
    if (stafferCounties.some((county) => officeCounties.has(county))) {
      if (!matched.has(staffer.id)) {
        matched.add(staffer.id);
        names.push(staffer.name);
      }
    }
  }

  return names.sort((a, b) => a.localeCompare(b));
}

export async function attachTgaStaffersToRaces(db, races, category) {
  if (!races.length || category === "statewide") return races;

  try {
    const stafferRows = await db.prepare(`SELECT id, name FROM tga_staffers ORDER BY name`).all();
    if (!stafferRows.length) return races;

    const enriched = await enrichTgaStafferRows(db, stafferRows);
    const officeCounties = await loadOfficeCountiesMap(db);

    return races.map((race) => {
      const tga_staffer_names = staffersForOffice(race.office_id, enriched, officeCounties);
      if (!tga_staffer_names.length) return race;
      return { ...race, tga_staffer_names };
    });
  } catch (err) {
    console.error("attachTgaStaffersToRaces failed:", err);
    return races;
  }
}
