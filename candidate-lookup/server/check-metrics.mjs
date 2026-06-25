import { getDb, closeDb, initDb } from "./db.mjs";

await initDb();
const db = getDb();
const categories = ["house", "senate", "congressional", "sboe", "statewide"];

for (const cat of categories) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN m.leg_2024 IS NOT NULL THEN 1 ELSE 0 END) AS y24,
              SUM(CASE WHEN m.leg_2022 IS NOT NULL THEN 1 ELSE 0 END) AS y22
       FROM offices o
       LEFT JOIN office_metrics m ON m.office_id = o.id
       WHERE o.category = ?`
    )
    .get(cat);
  console.log(cat, row);
}

await closeDb();
