import { initDb, getDb, closeDb } from "../db.mjs";

await initDb();
const db = getDb();
const offices = await db.prepare("SELECT COUNT(*)::int AS n FROM offices").get();
console.log("offices:", offices.n);
const races = await db
  .prepare("SELECT COUNT(*)::int AS n FROM race_sheet_rows WHERE category = ? AND cycle_year = ?")
  .get("house", 2026);
console.log("house 2026 rows:", races.n);
await closeDb();
