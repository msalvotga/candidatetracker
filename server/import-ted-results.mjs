import { getDb, closeDb, initDb } from "./db.mjs";
import { ensureMetricsSchema } from "./lib/metricsImport.mjs";
import { fetchCapitolMetadata, importTedElectionResults } from "./lib/tedElectionResults.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

async function ensureMetadata() {
  for (const year of [2024, 2022]) {
    const file = path.join(dataDir, `capitol-${year}-general.json`);
    if (!fs.existsSync(file)) {
      console.log(`Fetching ${year} general metadata…`);
      await fetchCapitolMetadata(year);
    }
  }
}

await initDb();
const db = getDb();
await ensureMetricsSchema(db);

await ensureMetadata();

console.log("Importing district race results from Texas Capitol Data Portal (TED)…");
const summary = await importTedElectionResults(db, { verbose: true });

console.log("\nTED import complete:");
for (const [year, stats] of Object.entries(summary.byYear)) {
  console.log(`  ${year}: ${stats.imported} districts updated (${stats.jobs} races checked, ${stats.skipped} skipped)`);
}
console.log(`  Total updated: ${summary.imported}`);
if (summary.errors.length > 0) {
  console.log(`  Errors: ${summary.errors.length}`);
  summary.errors.slice(0, 5).forEach((e) => console.log(`    - ${e.job}: ${e.error}`));
}

await closeDb();
