import { getDb, closeDb, initDb } from "./db.mjs";
import { parseBenchmarkMargin } from "./lib/benchmarkMargin.mjs";
import {
  recomputeAllOfficeMetrics,
  seedBenchmarkContestsForOffice,
} from "./lib/contestMetrics.mjs";
import { HOUSE_BENCHMARKS } from "./data/house-benchmarks.mjs";
import { SENATE_BENCHMARKS } from "./data/senate-benchmarks.mjs";
import { CONGRESSIONAL_BENCHMARKS } from "./data/congressional-benchmarks.mjs";

await initDb();
const db = getDb();

const upsert = db.prepare(
  `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
   VALUES (@officeId, @trump, @cruz, @abbott, NULL, NULL)
   ON CONFLICT(office_id) DO UPDATE SET
     trump_2024 = excluded.trump_2024,
     cruz_2024 = excluded.cruz_2024,
     abbott_2022 = excluded.abbott_2022`
);

async function seedCategory(rows, officeCodeForDistrict) {
  let metrics = 0;
  let contests = 0;
  for (const row of rows) {
    const officeCode = officeCodeForDistrict(row);
    if (!officeCode) continue;
    const office = await db.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(officeCode);
    if (!office) {
      console.warn(`Missing office ${officeCode}`);
      continue;
    }

    const margins = {
      trump_2024: parseBenchmarkMargin(row.trump, { format: "margin" }),
      cruz_2024: parseBenchmarkMargin(row.cruz, { format: "margin" }),
      abbott_2022: parseBenchmarkMargin(row.abbott, { format: "margin" }),
    };

    await upsert.run({
      officeId: office.id,
      trump: margins.trump_2024,
      cruz: margins.cruz_2024,
      abbott: margins.abbott_2022,
    });
    metrics += 1;
    contests += await seedBenchmarkContestsForOffice(db, officeCode, margins);
  }
  return { metrics, contests };
}

const house = await seedCategory(HOUSE_BENCHMARKS, (row) => `HD-${String(row.district).padStart(3, "0")}`);
const senate = await seedCategory(SENATE_BENCHMARKS, (row) => `SD-${String(row.district).padStart(2, "0")}`);
const cd = await seedCategory(CONGRESSIONAL_BENCHMARKS, (row) => `TX-${row.district}`);

const synced = await recomputeAllOfficeMetrics(db);

console.log(`Benchmark metrics: ${house.metrics} house, ${senate.metrics} senate, ${cd.metrics} congressional`);
console.log(`Benchmark contest rows: ${house.contests + senate.contests + cd.contests} contests seeded`);
console.log(`Recomputed ${synced.updated} office metric values from stored votes`);

await closeDb();
