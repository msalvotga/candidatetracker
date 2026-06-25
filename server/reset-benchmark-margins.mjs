import { getDb, closeDb, initDb } from "./db.mjs";

await initDb();
const db = getDb();

const cleared = await db
  .prepare(
    `UPDATE office_metrics
     SET trump_2024 = NULL, cruz_2024 = NULL, abbott_2022 = NULL`
  )
  .run();

const deleted = await db
  .prepare(
    `DELETE FROM metric_contest_candidates
     WHERE metric_key IN ('trump_2024', 'cruz_2024', 'abbott_2022')`
  )
  .run();

console.log(
  `Cleared benchmark columns on ${cleared.changes} office_metrics rows; deleted ${deleted.changes} benchmark contest candidate rows.`
);

await closeDb();
