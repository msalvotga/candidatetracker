import { initDb, getDb, closeDb } from "../db.mjs";

await initDb();
const db = getDb();
const offices = await db.prepare("SELECT COUNT(*)::int AS n FROM offices").get();
console.log("offices:", offices.n);
const candidates = await db
  .prepare(
    `SELECT COUNT(*)::int AS n
     FROM candidates c
     JOIN offices o ON o.id = c.office_id
     WHERE o.category = ? AND c.cycle_year = ?`
  )
  .get("house", 2026);
console.log("house 2026 candidates:", candidates.n);
await closeDb();
