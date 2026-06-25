import { getDb, closeDb, initDb } from "./db.mjs";
import { SENATE_DISTRICTS } from "./data/senate-districts.mjs";
import { SBOE_DISTRICTS } from "./data/sboe-districts.mjs";
import { STATEWIDE_OFFICES } from "./data/statewide-offices.mjs";

function padDistrict(n, width = 3) {
  return String(n).padStart(width, "0");
}

function buildOfficeRows() {
  const rows = [];

  for (let d = 1; d <= 150; d += 1) {
    rows.push({
      category: "house",
      district: d,
      office_code: `HD-${padDistrict(d)}`,
      office_name: `Texas House District ${d}`,
      sort_order: d,
    });
  }

  for (const d of SENATE_DISTRICTS) {
    rows.push({
      category: "senate",
      district: d,
      office_code: `SD-${String(d).padStart(2, "0")}`,
      office_name: `Texas Senate District ${d}`,
      sort_order: d,
    });
  }

  for (const d of SBOE_DISTRICTS) {
    rows.push({
      category: "sboe",
      district: d,
      office_code: `SBOE-${String(d).padStart(2, "0")}`,
      office_name: `State Board of Education District ${d}`,
      sort_order: d,
    });
  }

  STATEWIDE_OFFICES.forEach((office) => {
    rows.push({
      category: "statewide",
      district: null,
      office_code: office.code,
      office_name: office.name,
      sort_order: office.sort_order,
    });
  });

  rows.push({
    category: "congressional",
    district: null,
    office_code: "USS-TX",
    office_name: "U.S. Senate (Texas)",
    sort_order: 0,
  });

  for (let d = 1; d <= 38; d += 1) {
    rows.push({
      category: "congressional",
      district: d,
      office_code: `TX-${d}`,
      office_name: `U.S. House District ${d}`,
      sort_order: d,
    });
  }

  return rows;
}

export async function seedOfficesIfEmpty(database) {
  const countRow = await database.prepare(`SELECT COUNT(*) AS n FROM offices`).get();
  const count = countRow.n;
  if (count > 0) return { seeded: false, count };

  const insert = database.prepare(`
    INSERT OR IGNORE INTO offices (category, district, office_code, office_name, sort_order)
    VALUES (@category, @district, @office_code, @office_name, @sort_order)
  `);

  const seedMany = database.transaction(async (rows) => {
    for (const row of rows) await insert.run(row);
  });

  await seedMany(buildOfficeRows());
  const totalRow = await database.prepare(`SELECT COUNT(*) AS n FROM offices`).get();
  return { seeded: true, count: totalRow.n };
}

const isMain = process.argv[1]?.endsWith("seed-offices.mjs");
if (isMain) {
  await initDb();
  const database = getDb();
  const result = await seedOfficesIfEmpty(database);
  const counts = await database
    .prepare(`SELECT category, COUNT(*) AS n FROM offices GROUP BY category ORDER BY category`)
    .all();

  if (result.seeded) {
    console.log(`Seeded ${result.count} offices.`);
  } else {
    console.log(`Offices already present (${result.count} rows).`);
  }
  for (const row of counts) {
    console.log(`  ${row.category}: ${row.n}`);
  }
  await closeDb();
}
