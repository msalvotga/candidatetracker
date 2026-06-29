import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalCountyKey } from "../lib/countyElection.mjs";

const texasPaths = JSON.parse(readFileSync(new URL("../../src/data/texasCountyPaths.json", import.meta.url), "utf8"));
const dbPath = process.argv[2] ?? "candidates.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

const pathEntries = Object.entries(texasPaths.counties);
const dbRows = db.prepare("SELECT county_name, county_key FROM county_election_results WHERE election_key = ?").all("pres_2024");
const dbKeys = new Set(dbRows.map((row) => canonicalCountyKey(row.county_key)));

const missingInDb = [];
for (const [, entry] of pathEntries) {
  const key = canonicalCountyKey(entry.name);
  if (!dbKeys.has(key)) missingInDb.push(`${entry.name} -> ${key}`);
}

const missingOnMap = [];
for (const row of dbRows) {
  const key = canonicalCountyKey(row.county_key);
  const pathMatch = pathEntries.find(([, entry]) => canonicalCountyKey(entry.name) === key);
  if (!pathMatch) missingOnMap.push(`${row.county_name} -> ${key}`);
}

console.log("map counties:", pathEntries.length);
console.log("db counties:", dbKeys.size);
console.log("missingInDb:", missingInDb.length, missingInDb);
console.log("missingOnMap:", missingOnMap.length, missingOnMap);

const la = db.prepare("SELECT county_name, county_key FROM county_election_results WHERE county_name LIKE '%SALLE%'").all();
console.log("la salle rows:", la);
