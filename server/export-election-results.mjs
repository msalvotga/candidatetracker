/**
 * Export metric_contest_candidates ("Election results" in admin) to CSV.
 *
 * Usage: node server/export-election-results.mjs [output-path]
 */
import fs from "node:fs";
import path from "node:path";
import { closeDb, getDb, initDb } from "./db.mjs";
import { enrichElectionResultRows } from "./lib/contestMetrics.mjs";

const defaultOut = path.resolve(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  "Downloads",
  "election-results-export.csv"
);
const outPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultOut;

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

await initDb();
const db = getDb();

const rows = await db
  .prepare(
    `SELECT c.id, c.office_id, o.office_code, o.office_name, o.category, o.district,
            c.metric_key, c.candidate_name, c.party, c.votes, c.vote_pct,
            c.contest_margin, c.unopposed, c.contest_name, c.source, c.sort_order
     FROM metric_contest_candidates c
     JOIN offices o ON o.id = c.office_id
     ORDER BY o.category, o.sort_order, o.district, c.metric_key, c.sort_order, c.votes DESC NULLS LAST`
  )
  .all();

enrichElectionResultRows(rows);

const headers = [
  "id",
  "office_id",
  "office_code",
  "office_name",
  "category",
  "district",
  "metric_key",
  "candidate_name",
  "party",
  "votes",
  "vote_pct",
  "contest_margin",
  "unopposed",
  "contest_name",
  "source",
  "sort_order",
];

const lines = [headers.join(",")];
for (const row of rows) {
  lines.push(headers.map((h) => csvEscape(row[h])).join(","));
}

fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Exported ${rows.length} row(s) to ${outPath}`);

await closeDb();
