import { getDb, closeDb, initDb } from "./db.mjs";
import { migrateGopShareToBenchmarkMargin } from "./lib/benchmarkMargin.mjs";

await initDb();
const db = getDb();
const changed = await migrateGopShareToBenchmarkMargin(db);
console.log(`Migrated ${changed} house/senate/sboe offices to benchmark margin format.`);
await closeDb();
