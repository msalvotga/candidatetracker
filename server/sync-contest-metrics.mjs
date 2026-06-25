import { getDb, closeDb, initDb } from "./db.mjs";
import { recomputeAllOfficeMetrics } from "./lib/contestMetrics.mjs";

await initDb();
const db = getDb();

const result = await recomputeAllOfficeMetrics(db);
console.log(`Recomputed margins for ${result.updated} contests (${result.contests} contest groups in database).`);

await closeDb();
