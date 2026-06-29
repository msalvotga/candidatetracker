import { getDb, closeDb, initDb } from "./db.mjs";
import { TEXAS_COUNTIES } from "./data/texas-counties.mjs";
import { TGA_STAFFERS } from "./data/tga-staffers.mjs";
import { seedOfficesIfEmpty } from "./seed-offices.mjs";
import { syncStafferCounties, syncStafferOffices } from "./lib/tgaStaffers.mjs";

function normalizeName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

function normalizeCounties(counties = []) {
  return counties.map((name) => String(name ?? "").trim()).filter(Boolean);
}

function normalizeDistricts(districts = []) {
  return [
    ...new Set(
      districts
        .map((district) => Number(district))
        .filter((district) => Number.isInteger(district) && district >= 1 && district <= 150)
    ),
  ].sort((a, b) => a - b);
}

function validateStafferData() {
  const countySet = new Set(TEXAS_COUNTIES);
  const errors = [];

  for (const staffer of TGA_STAFFERS) {
    const name = normalizeName(staffer.name);
    if (!name) {
      errors.push("missing staffer name");
      continue;
    }

    const counties = normalizeCounties(staffer.counties);
    const districts = normalizeDistricts(staffer.districts);
    if (!counties.length && !districts.length) {
      errors.push(`${name}: must have counties and/or house districts`);
    }

    const seenCounties = new Set();
    for (const county of counties) {
      if (!countySet.has(county)) {
        errors.push(`${name}: unknown county "${county}"`);
      }
      if (seenCounties.has(county)) {
        errors.push(`${name}: duplicate county "${county}"`);
      }
      seenCounties.add(county);
    }

    if (staffer.districts?.length && districts.length !== staffer.districts.length) {
      errors.push(`${name}: invalid house district number`);
    }
  }

  if (errors.length) {
    throw new Error(`TGA staffer data validation failed:\n${errors.join("\n")}`);
  }
}

async function loadHouseOfficeIdsByDistrict(db) {
  const rows = await db
    .prepare(`SELECT id, district, office_code FROM offices WHERE category = 'house' ORDER BY district`)
    .all();
  const map = new Map();
  for (const row of rows) {
    const district = Number(row.district);
    if (Number.isInteger(district) && district > 0) {
      map.set(district, row.id);
    }
    const match = String(row.office_code ?? "").match(/^HD-(\d+)$/i);
    if (match) {
      map.set(Number(match[1]), row.id);
    }
  }
  return map;
}

function resolveOfficeIds(entry, officeIdByDistrict) {
  const districts = normalizeDistricts(entry.districts);
  const officeIds = [];
  for (const district of districts) {
    const officeId = officeIdByDistrict.get(district);
    if (!officeId) throw new Error(`${entry.name}: house district ${district} not found in offices table`);
    officeIds.push(officeId);
  }
  return officeIds;
}

export async function seedTgaStaffers(db) {
  validateStafferData();
  await seedOfficesIfEmpty(db);
  const officeIdByDistrict = await loadHouseOfficeIdsByDistrict(db);

  const added = [];
  const updated = [];

  for (const entry of TGA_STAFFERS) {
    const name = normalizeName(entry.name);
    const counties = normalizeCounties(entry.counties);
    const districts = normalizeDistricts(entry.districts);
    const officeIds = resolveOfficeIds(entry, officeIdByDistrict);

    const existing = await db
      .prepare(`SELECT id, name FROM tga_staffers WHERE LOWER(name) = LOWER(?)`)
      .get(name);

    let stafferId;
    if (existing) {
      stafferId = existing.id;
      if (existing.name !== name) {
        await db.prepare(`UPDATE tga_staffers SET name = ? WHERE id = ?`).run(name, stafferId);
      }
      updated.push({ name, countyCount: counties.length, districtCount: districts.length });
    } else {
      const result = await db
        .prepare(`INSERT INTO tga_staffers (name) VALUES (?) RETURNING id`)
        .run(name);
      stafferId = result.lastInsertRowid;
      added.push({ name, countyCount: counties.length, districtCount: districts.length });
    }

    await syncStafferOffices(db, stafferId, officeIds);
    await syncStafferCounties(db, stafferId, counties);
  }

  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM tga_staffers`).get()).count;
  const countyLinks = (await db.prepare(`SELECT COUNT(*) AS count FROM tga_staffer_counties`).get()).count;
  const officeLinks = (await db.prepare(`SELECT COUNT(*) AS count FROM tga_staffer_offices`).get()).count;

  return { added, updated, total, countyLinks, officeLinks };
}

async function logTargetDatabase(db) {
  const row = await db.prepare(`SELECT current_database() AS db_name`).get();
  console.log(`Target database: ${row?.db_name ?? "(unknown)"}`);
}

function formatAssignment(row) {
  const parts = [];
  if (row.districtCount) parts.push(`${row.districtCount} district${row.districtCount === 1 ? "" : "s"}`);
  if (row.countyCount) parts.push(`${row.countyCount} ${row.countyCount === 1 ? "county" : "counties"}`);
  return parts.join(", ") || "no assignments";
}

const isMain = process.argv[1]?.endsWith("seed-tga-staffers.mjs");
if (isMain) {
  await initDb();
  const db = getDb();
  await logTargetDatabase(db);
  const result = await seedTgaStaffers(db);
  console.log(`Seeded TGA staffers: ${result.added.length} added, ${result.updated.length} updated.`);
  console.log(
    `Database now has ${result.total} staffers with ${result.officeLinks} district links and ${result.countyLinks} county links.`
  );
  for (const row of result.added) {
    console.log(`  + ${row.name} (${formatAssignment(row)})`);
  }
  for (const row of result.updated) {
    console.log(`  ~ ${row.name} (${formatAssignment(row)})`);
  }
  await closeDb();
}
