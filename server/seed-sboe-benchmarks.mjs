import { getDb, closeDb, initDb } from "./db.mjs";
import { ensureMetricsSchema } from "./lib/metricsImport.mjs";
import { parseBenchmarkMargin } from "./lib/benchmarkMargin.mjs";
import { seedBenchmarkContestsForOffice } from "./lib/contestMetrics.mjs";
import { SBOE_BENCHMARKS } from "./data/sboe-benchmarks.mjs";

await initDb();
const db = getDb();
await ensureMetricsSchema(db);

const upsert = db.prepare(
  `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
   VALUES (@officeId, @trump, @cruz, @abbott, NULL, NULL)
   ON CONFLICT(office_id) DO UPDATE SET
     trump_2024 = excluded.trump_2024,
     cruz_2024 = excluded.cruz_2024,
     abbott_2022 = excluded.abbott_2022`
);

let updated = 0;
let contests = 0;
for (const row of SBOE_BENCHMARKS) {
  const officeCode = `SBOE-${String(row.district).padStart(2, "0")}`;
  const office = await db.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(officeCode);
  if (!office) {
    console.warn(`Missing office ${officeCode}`);
    continue;
  }

  const margins = {
    trump_2024: row.trump != null ? parseBenchmarkMargin(row.trump, { format: "margin" }) : null,
    cruz_2024: row.cruz != null ? parseBenchmarkMargin(row.cruz, { format: "margin" }) : null,
    abbott_2022: parseBenchmarkMargin(row.abbott, { format: "margin" }),
  };

  await upsert.run({
    officeId: office.id,
    trump: margins.trump_2024,
    cruz: margins.cruz_2024,
    abbott: margins.abbott_2022,
  });
  updated += 1;
  contests += await seedBenchmarkContestsForOffice(db, officeCode, margins);
}

console.log(`Updated benchmark margins for ${updated} SBOE districts (${contests} benchmark contests seeded).`);
await closeDb();
