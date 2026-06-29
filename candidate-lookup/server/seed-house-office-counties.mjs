import { getDb, closeDb, initDb } from "./db.mjs";
import { TEXAS_COUNTIES } from "./data/texas-counties.mjs";
import { COUNTY_HOUSE_DISTRICTS, houseDistrictCountiesMap } from "./data/texas-house-county-districts.mjs";

function validateCountyData() {
  const countySet = new Set(TEXAS_COUNTIES);
  const seen = new Set();
  const errors = [];

  for (const { county, districts } of COUNTY_HOUSE_DISTRICTS) {
    if (!countySet.has(county)) {
      errors.push(`unknown county: ${county}`);
    }
    if (seen.has(county)) {
      errors.push(`duplicate county entry: ${county}`);
    }
    seen.add(county);

    for (const district of districts) {
      if (!Number.isInteger(district) || district < 1 || district > 150) {
        errors.push(`${county}: invalid district ${district}`);
      }
    }
  }

  if (seen.size !== TEXAS_COUNTIES.length) {
    const missing = TEXAS_COUNTIES.filter((name) => !seen.has(name));
    errors.push(`missing counties (${missing.length}): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
  }

  if (errors.length) {
    throw new Error(`County/district data validation failed:\n${errors.join("\n")}`);
  }
}

export async function seedHouseOfficeCounties(db, { replace = true } = {}) {
  validateCountyData();

  const houseOffices = await db
    .prepare(`SELECT id, district FROM offices WHERE category = 'house' ORDER BY district`)
    .all();
  const officeIdByDistrict = new Map(houseOffices.map((office) => [office.district, office.id]));

  const districtCounties = houseDistrictCountiesMap();
  const missingDistricts = [...districtCounties.keys()].filter((district) => !officeIdByDistrict.has(district));
  if (missingDistricts.length) {
    throw new Error(`House offices missing for districts: ${missingDistricts.sort((a, b) => a - b).join(", ")}`);
  }

  const apply = db.transaction(async () => {
    if (replace) {
      const houseIds = houseOffices.map((office) => office.id);
      if (houseIds.length) {
        const placeholders = houseIds.map((_, index) => `@id${index}`).join(", ");
        const params = Object.fromEntries(houseIds.map((id, index) => [`id${index}`, id]));
        await db
          .prepare(`DELETE FROM office_counties WHERE office_id IN (${placeholders})`)
          .run(params);
      }
    }

    const insert = db.prepare(
      `INSERT INTO office_counties (office_id, county_name) VALUES (?, ?) ON CONFLICT DO NOTHING`
    );

    let inserted = 0;
    for (const [district, counties] of districtCounties) {
      const officeId = officeIdByDistrict.get(district);
      for (const county of counties) {
        const result = await insert.run(officeId, county);
        inserted += result.changes ?? 0;
      }
    }
    return inserted;
  });

  const inserted = await apply();
  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM office_counties`).get()).count;
  const houseMapped = (
    await db.prepare(
      `SELECT COUNT(DISTINCT oc.office_id) AS count
       FROM office_counties oc
       JOIN offices o ON o.id = oc.office_id
       WHERE o.category = 'house'`
    ).get()
  ).count;

  return { inserted, total, houseDistrictsMapped: houseMapped, houseDistricts: houseOffices.length };
}

const isMain = process.argv[1]?.endsWith("seed-house-office-counties.mjs");
if (isMain) {
  await initDb();
  const db = getDb();
  const result = await seedHouseOfficeCounties(db);
  console.log(
    `Seeded house office counties: ${result.inserted} rows inserted, ${result.total} total mappings, ${result.houseDistrictsMapped}/${result.houseDistricts} house districts have counties.`
  );
  const harris = await db
    .prepare(
      `SELECT o.office_code, COUNT(*) AS county_count
       FROM office_counties oc
       JOIN offices o ON o.id = oc.office_id
       WHERE o.office_code = 'HD-126'
       GROUP BY o.office_code`
    )
    .get();
  if (harris) {
    console.log(`HD-126 counties: ${harris.county_count} (includes Harris)`);
  }
  await closeDb();
}
