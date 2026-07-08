/**
 * Export metric_contest_candidates ("Election results" in admin) to CSV.
 *
 * Usage: node server/export-election-results.mjs [output-path]
 */
import fs from "node:fs";
import path from "node:path";
import { closeDb, getDb, initDb } from "./db.mjs";
import { exportTableCsv } from "./lib/adminData.mjs";

const defaultOut = path.resolve(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  "Downloads",
  "election-results-export.csv"
);
const outPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultOut;

await initDb();
const db = getDb();

const csv = await exportTableCsv(db, "metric_contest_candidates", {});
fs.writeFileSync(outPath, csv ? `${csv}\n` : "", "utf8");

const rowCount = csv ? csv.split("\n").length - 1 : 0;
console.log(`Exported ${rowCount} row(s) to ${outPath}`);

await closeDb();
