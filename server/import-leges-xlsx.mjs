import path from "node:path";
import XLSX from "xlsx";
import { getDb, closeDb } from "./db.mjs";
import { importCountySheets } from "./lib/countyImport.mjs";
import {
  clearAllOfficeMetrics,
  ensureMetricsSchema,
  importDataSheetMetrics,
  importSheetRowMetrics,
} from "./lib/metricsImport.mjs";
import { SHEET_CONFIGS, importParsedRows, parseSheetRows } from "./lib/legesXlsx.mjs";

const defaultPath = path.resolve(
  process.env.HOME ?? process.env.USERPROFILE ?? "",
  "Downloads",
  "2026 TX Lege Races (2).xlsx"
);

const filePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultPath;

const workbook = XLSX.readFile(filePath);
const database = getDb();

ensureMetricsSchema(database);
clearAllOfficeMetrics(database);

let totalRows = 0;

for (const config of SHEET_CONFIGS) {
  const sheet = workbook.Sheets[config.sheetName];
  if (!sheet) {
    console.warn(`Sheet not found: ${config.sheetName}`);
    continue;
  }

  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const parsed = parseSheetRows(rawRows, config);
  const count = importParsedRows(database, config, parsed);
  const metricCount = importSheetRowMetrics(database, rawRows, config);
  totalRows += count;
  console.log(`${config.sheetName}: ${count} rows, ${metricCount} offices with metrics`);
}

const dataSheet = workbook.Sheets.Data;
if (dataSheet) {
  const dataRows = XLSX.utils.sheet_to_json(dataSheet, { header: 1, defval: "" });
  const n = importDataSheetMetrics(database, dataRows);
  console.log(`Data sheet: ${n} office metric rows`);
} else {
  console.warn("Data sheet not found");
}

console.log("\nImporting county results…");
importCountySheets(database, workbook);

const summary = database
  .prepare(
    `SELECT category, COUNT(*) AS n FROM race_sheet_rows WHERE cycle_year = 2026 GROUP BY category ORDER BY category`
  )
  .all();

console.log(`\nImported ${totalRows} sheet rows from ${filePath}`);
for (const row of summary) {
  console.log(`  ${row.category}: ${row.n}`);
}

closeDb();
