import { getDb, closeDb, initDb } from "./db.mjs";
import { ensureMetricsSchema } from "./lib/metricsImport.mjs";
import { parseBenchmarkMargin } from "./lib/benchmarkMargin.mjs";
import { CONGRESSIONAL_BENCHMARKS } from "./data/congressional-benchmarks.mjs";

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
for (const row of CONGRESSIONAL_BENCHMARKS) {
  const office = await db.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(`TX-${row.district}`);
  if (!office) {
    console.warn(`Missing office TX-${row.district}`);
    continue;
  }

  await upsert.run({
    officeId: office.id,
    trump: parseBenchmarkMargin(row.trump, { format: "margin" }),
    cruz: parseBenchmarkMargin(row.cruz, { format: "margin" }),
    abbott: parseBenchmarkMargin(row.abbott, { format: "margin" }),
  });
  updated += 1;
}

console.log(`Updated benchmark margins for ${updated} congressional districts.`);
await closeDb();
