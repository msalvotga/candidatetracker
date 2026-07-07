/**
 * Update candidates.tec_filer_id from the lege races Excel workbook.
 * Rows are matched by category + district + name (same keys as candidates-export.csv).
 * Uses Excel when a TEC filer ID is present; otherwise falls back to the CSV column.
 *
 * Usage:
 *   node server/update-tec-filer-ids.mjs [xlsx-path] [csv-path] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { closeDb, getDb, initDb } from "./db.mjs";
import { SHEET_CONFIGS, parseSheetRows } from "./lib/legesXlsx.mjs";
import { normalizeTecFilerId } from "./lib/tecFilerId.mjs";

const defaultXlsx = path.resolve(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  "Downloads",
  "2026 TX Lege Races (2).xlsx"
);
const defaultCsv = path.resolve(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  "Downloads",
  "candidates-export.csv"
);

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
const xlsxPath = args[0] ? path.resolve(args[0]) : defaultXlsx;
const csvPath = args[1] ? path.resolve(args[1]) : defaultCsv;

function normalizeTecId(value) {
  return normalizeTecFilerId(value);
}

function normalizeNameKey(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function matchKey(category, district, name) {
  const dist = district == null || district === "" ? "" : String(Number(district));
  return `${category}|${dist}|${normalizeNameKey(name)}`;
}

function buildExcelTecMap(workbook) {
  const map = new Map();

  for (const config of SHEET_CONFIGS) {
    const sheet = workbook.Sheets[config.sheetName];
    if (!sheet) continue;

    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    const parsed = parseSheetRows(rawRows, config);

    for (const row of parsed) {
      const district = row.office?.district ?? null;
      const tecId = normalizeTecId(row.tecFilerId);
      if (!tecId) continue;

      if (row.candidateName) {
        map.set(matchKey(config.category, district, row.candidateName), tecId);
      }
      if (row.incumbentName) {
        map.set(matchKey(config.category, district, row.incumbentName), tecId);
      }
    }
  }

  return map;
}

function parseCsvExport(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 6) continue;
    rows.push({
      name: parts[0],
      party: parts[1],
      district: parts[3] === "" ? null : Number(parts[3]),
      category: parts[4],
      tec_filer_id: normalizeTecId(parts[5]),
    });
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(xlsxPath)) {
    console.error(`Excel file not found: ${xlsxPath}`);
    process.exit(1);
  }

  const csvRows = parseCsvExport(csvPath);
  const workbook = XLSX.readFile(xlsxPath);
  const excelMap = buildExcelTecMap(workbook);

  await initDb();
  const db = getDb();

  const dbRows = await db
    .prepare(
      `SELECT c.id, c.name, c.party, c.tec_filer_id, o.category, o.district
       FROM candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE c.cycle_year = 2026`
    )
    .all();

  const dbByKey = new Map(
    dbRows.map((row) => [matchKey(row.category, row.district, row.name), row])
  );

  const updates = [];
  const notInDb = [];
  const noTecSource = [];

  for (const csvRow of csvRows) {
    const key = matchKey(csvRow.category, csvRow.district, csvRow.name);
    const dbRow = dbByKey.get(key);
    if (!dbRow) {
      notInDb.push(csvRow);
      continue;
    }

    const excelId = excelMap.get(key) ?? null;
    const targetId = excelId ?? csvRow.tec_filer_id ?? null;
    if (!targetId) {
      noTecSource.push(csvRow);
      continue;
    }

    const current = normalizeTecId(dbRow.tec_filer_id);
    if (current === targetId) continue;

    updates.push({
      id: dbRow.id,
      name: dbRow.name,
      category: dbRow.category,
      district: dbRow.district,
      previous: current,
      next: targetId,
      source: excelId ? "excel" : "csv",
    });
  }

  console.log(`Excel: ${xlsxPath}`);
  console.log(`CSV:   ${csvPath}`);
  console.log(`Excel entries with TEC filer ID: ${excelMap.size}`);
  console.log(`CSV candidate rows: ${csvRows.length}`);
  console.log(`Updates planned: ${updates.length}`);
  console.log(`  from Excel: ${updates.filter((u) => u.source === "excel").length}`);
  console.log(`  from CSV fallback: ${updates.filter((u) => u.source === "csv").length}`);
  console.log(`CSV rows not found in DB: ${notInDb.length}`);
  console.log(`CSV rows with no TEC ID in Excel or CSV: ${noTecSource.length}`);

  if (updates.length) {
    console.log("\nSample updates:");
    for (const u of updates.slice(0, 20)) {
      console.log(
        `  [${u.source}] ${u.category} ${u.district ?? "—"} ${u.name}: ${u.previous ?? "(empty)"} -> ${u.next}`
      );
    }
    if (updates.length > 20) console.log(`  ... and ${updates.length - 20} more`);
  }

  if (notInDb.length) {
    console.log("\nCSV rows with no DB match:");
    for (const row of notInDb.slice(0, 10)) {
      console.log(`  ${row.category} ${row.district ?? "—"} ${row.name}`);
    }
    if (notInDb.length > 10) console.log(`  ... and ${notInDb.length - 10} more`);
  }

  if (dryRun) {
    console.log("\nDry run — no database changes made.");
    await closeDb();
    return;
  }

  let applied = 0;
  for (const u of updates) {
    await db.prepare(`UPDATE candidates SET tec_filer_id = ? WHERE id = ?`).run(u.next, u.id);
    applied += 1;
  }

  console.log(`\nUpdated ${applied} candidate row(s).`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
