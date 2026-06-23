import { getDb, closeDb } from "./db.mjs";
import { migrateGopShareToBenchmarkMargin } from "./lib/benchmarkMargin.mjs";

const db = getDb();
const changed = migrateGopShareToBenchmarkMargin(db);
console.log(`Migrated ${changed} house/senate/sboe offices to benchmark margin format.`);
closeDb();
