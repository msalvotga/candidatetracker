import { getDb, closeDb } from "./db.mjs";
import { ensureMetricsSchema } from "./lib/metricsImport.mjs";
import { parseBenchmarkMargin } from "./lib/benchmarkMargin.mjs";
import { SENATE_BENCHMARKS } from "./data/senate-benchmarks.mjs";

const db = getDb();
ensureMetricsSchema(db);

const seededDistricts = new Set(SENATE_BENCHMARKS.map((row) => row.district));

// Clear benchmark columns for senate districts not in the spreadsheet
const senateOffices = db
  .prepare(`SELECT id, district FROM offices WHERE category = 'senate' ORDER BY district`)
  .all();
for (const office of senateOffices) {
  if (!seededDistricts.has(office.district)) {
    db.prepare(
      `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
       VALUES (?, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(office_id) DO UPDATE SET trump_2024 = NULL, cruz_2024 = NULL, abbott_2022 = NULL`
    ).run(office.id);
  }
}

const upsert = db.prepare(
  `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
   VALUES (@officeId, @trump, @cruz, @abbott, NULL, NULL)
   ON CONFLICT(office_id) DO UPDATE SET
     trump_2024 = excluded.trump_2024,
     cruz_2024 = excluded.cruz_2024,
     abbott_2022 = excluded.abbott_2022`
);

let updated = 0;
for (const row of SENATE_BENCHMARKS) {
  const office = db
    .prepare(`SELECT id FROM offices WHERE office_code = ?`)
    .get(`SD-${String(row.district).padStart(2, "0")}`);
  if (!office) {
    console.warn(`Missing office SD-${row.district}`);
    continue;
  }

  upsert.run({
    officeId: office.id,
    trump: parseBenchmarkMargin(row.trump, { format: "margin" }),
    cruz: parseBenchmarkMargin(row.cruz, { format: "margin" }),
    abbott: parseBenchmarkMargin(row.abbott, { format: "margin" }),
  });
  updated += 1;
}

console.log(`Updated benchmark margins for ${updated} senate districts.`);
closeDb();
