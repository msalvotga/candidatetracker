/**
 * Import July '26 TEC finance totals from TEC_data.xlsx.
 *
 * Blank raised/spent/COH for a filer = no report (skip).
 * Explicit $0 values = filed with zeros (import).
 * Multi-filer candidates store one finance_reports row per filer ID;
 * the API aggregates them for display.
 *
 * Usage:
 *   node server/import-tec-finance-xlsx.mjs [xlsx-path] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";
import { closeDb, initDb } from "./db.mjs";
import { addFinanceReport } from "./lib/financeReports.mjs";
import { normalizeTecFilerId, parseTecFilerIds } from "./lib/tecFilerId.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const CYCLE_YEAR = 2026;
const PERIOD_KEY = "july_26";
const REPORT_PERIOD_END = "2026-07-31";

const OFFICE_ALIASES = {
  "agriculture commissioner": "AGRI",
  "attorney general": "AG",
  "ccoa, pl 4": "CCA-PL4",
  "ccoa, pl 9": "CCA-PL9",
  "ccoa, pl 5": "CCA-PL5",
  "ccoa, pl 6": "CCA-PL6",
  "ccoa, pl 2": "CCA-PL2",
  "ccoa, pl 3": "CCA-PL3",
  "ccoa, pl 7": "CCA-PL7",
  "ccoa, pl 8": "CCA-PL8",
  "ccoa, presiding": "CCA-PRES",
  comptroller: "COMPT",
  governor: "GOV",
  "land commissioner": "GLO",
  "lt. governor": "LTGOV",
  "lieutenant governor": "LTGOV",
  "15th coa, chief": "15TH-CHIEF",
  "15th coa, pl 2": "15TH-PL2",
  "15th coa, pl 3": "15TH-PL3",
  "supreme court, chief": "SCOTX-CHIEF",
  "supreme court chief": "SCOTX-CHIEF",
};

/** Known spreadsheet office mislabels keyed by normalized candidate name. */
const CANDIDATE_OFFICE_OVERRIDES = {
  "michelle palmer": "SBOE-06",
};

function nameKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function partyCode(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "GOP" || raw === "R" || raw === "REP") return "R";
  if (raw === "DEM" || raw === "D") return "D";
  if (raw === "LIB" || raw === "L") return "L";
  if (raw === "GRN" || raw === "G" || raw === "GREEN") return "G";
  if (raw === "IND" || raw === "I") return "I";
  if (raw === "O" || raw === "OTH" || raw === "OTHER") return "O";
  return raw || null;
}

function officeCodeFromLabel(label, candidateName = "") {
  const override = CANDIDATE_OFFICE_OVERRIDES[nameKey(candidateName)];
  if (override) return override;

  const raw = String(label ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (OFFICE_ALIASES[lower]) return OFFICE_ALIASES[lower];

  const hd = raw.match(/^HD\s+(\d+)$/i);
  if (hd) return `HD-${String(Number(hd[1])).padStart(3, "0")}`;

  const sd = raw.match(/^SD\s+(\d+)$/i);
  if (sd) return `SD-${String(Number(sd[1])).padStart(2, "0")}`;

  const sboe = raw.match(/^SBOE\s+(\d+)$/i);
  if (sboe) return `SBOE-${String(Number(sboe[1])).padStart(2, "0")}`;

  const scotx = raw.match(/^Supreme Court,?\s*Pl(?:ace)?\s*(\d+)$/i);
  if (scotx) return `SCOTX-PL${scotx[1]}`;

  return null;
}

/** Excel blank vs 0: undefined/null/'' = blank; 0 is a real value. */
function cellNumber(value) {
  if (value === undefined || value === null) return { blank: true, value: null };
  if (typeof value === "string" && value.trim() === "") return { blank: true, value: null };
  const num = Number(String(value).replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(num)) return { blank: true, value: null };
  return { blank: false, value: num };
}

function extractFilerTotals(row, prefix) {
  const raised = cellNumber(row[`${prefix}_Raised`]);
  const spent = cellNumber(row[`${prefix}_Spent`]);
  const coh = cellNumber(row[`${prefix}_COH`]);
  if (raised.blank && spent.blank && coh.blank) return null;
  return {
    contributions: raised.blank ? null : raised.value,
    expenditures: spent.blank ? null : spent.value,
    cash_on_hand: coh.blank ? null : coh.value,
  };
}

function buildFilerIndex(candidates) {
  const byFiler = new Map();
  for (const candidate of candidates) {
    for (const filerId of parseTecFilerIds(candidate.tec_filer_id)) {
      if (!byFiler.has(filerId)) byFiler.set(filerId, []);
      byFiler.get(filerId).push(candidate);
    }
  }
  return byFiler;
}

async function resolveCandidate(db, { name, party, officeLabel, filerId }, byFiler, byNameOffice) {
  const matches = byFiler.get(filerId) ?? [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const officeCode = officeCodeFromLabel(officeLabel, name);
    const narrowed = matches.filter(
      (c) => c.party === party && (!officeCode || c.office_code === officeCode)
    );
    if (narrowed.length === 1) return narrowed[0];
    if (narrowed.length > 1) {
      const byName = narrowed.filter((c) => nameKey(c.name) === nameKey(name));
      if (byName.length === 1) return byName[0];
    }
  }

  const officeCode = officeCodeFromLabel(officeLabel, name);
  if (officeCode) {
    const key = `${nameKey(name)}|${party}|${officeCode}`;
    const fallback = byNameOffice.get(key);
    if (fallback) return fallback;
  }

  return null;
}

async function ensureCandidateFilerIds(db, candidate, filerIds, dryRun) {
  const existing = parseTecFilerIds(candidate.tec_filer_id);
  const merged = normalizeTecFilerId([...existing, ...filerIds].join(", "));
  const current = normalizeTecFilerId(candidate.tec_filer_id);
  if (!merged || merged === current) return false;
  if (dryRun) {
    console.log(`  would update tec_filer_id ${candidate.name}: ${current ?? "—"} -> ${merged}`);
    return true;
  }
  await db.prepare(`UPDATE candidates SET tec_filer_id = ? WHERE id = ?`).run(merged, candidate.id);
  candidate.tec_filer_id = merged;
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const xlsxPath = path.resolve(
    args.find((a) => !a.startsWith("--")) ?? path.join(projectRoot, "TEC_data.xlsx")
  );
  if (!fs.existsSync(xlsxPath)) throw new Error(`File not found: ${xlsxPath}`);

  const workbook = xlsx.readFile(xlsxPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: undefined });

  const db = await initDb();
  const candidates = await db
    .prepare(
      `SELECT c.id, c.name, c.party, c.tec_filer_id, c.cycle_year, o.office_code, o.office_name, o.category, o.district
       FROM candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE c.cycle_year = ?`
    )
    .all(CYCLE_YEAR);

  const byFiler = buildFilerIndex(candidates);
  const byNameOffice = new Map();
  for (const c of candidates) {
    byNameOffice.set(`${nameKey(c.name)}|${c.party}|${c.office_code}`, c);
  }

  const stats = {
    rows: rows.length,
    reports: 0,
    skippedBlank: 0,
    unmatched: [],
    filerIdUpdates: 0,
    errors: [],
  };

  for (const [index, row] of rows.entries()) {
    const name = String(row.CandidateName ?? "").trim();
    const party = partyCode(row.Party);
    const officeLabel = String(row.Office ?? "").trim();
    const primaryId = normalizeTecFilerId(row.TEC_FilerID);
    const secondaryId = normalizeTecFilerId(row.Second_FilerID);

    if (!name || !party || !primaryId) {
      stats.errors.push({ row: index + 2, error: "missing name/party/TEC_FilerID" });
      continue;
    }

    const candidate = await resolveCandidate(
      db,
      { name, party, officeLabel, filerId: primaryId },
      byFiler,
      byNameOffice
    );
    if (!candidate) {
      stats.unmatched.push({ row: index + 2, name, party, officeLabel, primaryId });
      continue;
    }

    const filerIdsOnRow = [primaryId, secondaryId].filter(Boolean);
    if (await ensureCandidateFilerIds(db, candidate, filerIdsOnRow, dryRun)) {
      stats.filerIdUpdates += 1;
      for (const id of filerIdsOnRow) {
        if (!byFiler.has(id)) byFiler.set(id, []);
        if (!byFiler.get(id).some((c) => c.id === candidate.id)) byFiler.get(id).push(candidate);
      }
    }

    const segments = [
      { filerId: primaryId, totals: extractFilerTotals(row, "Primary") },
      { filerId: secondaryId, totals: secondaryId ? extractFilerTotals(row, "Secondary") : null },
    ];

    for (const segment of segments) {
      if (!segment.filerId) continue;
      if (!segment.totals) {
        stats.skippedBlank += 1;
        continue;
      }

      stats.reports += 1;
      const payload = {
        candidateId: candidate.id,
        period_key: PERIOD_KEY,
        period_label: "July '26",
        report_period_end: REPORT_PERIOD_END,
        tec_filer_id: segment.filerId,
        contributions: segment.totals.contributions,
        expenditures: segment.totals.expenditures,
        cash_on_hand: segment.totals.cash_on_hand,
      };

      if (dryRun) {
        console.log(
          `  would upsert ${candidate.name} filer=${segment.filerId} raised=${payload.contributions} spent=${payload.expenditures} coh=${payload.cash_on_hand}`
        );
        continue;
      }

      try {
        await addFinanceReport(db, payload);
      } catch (err) {
        stats.errors.push({
          row: index + 2,
          name,
          filerId: segment.filerId,
          error: err.message,
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: dryRun ? "dry-run" : "apply",
        file: xlsxPath,
        ...stats,
        unmatched: stats.unmatched.slice(0, 50),
        unmatchedCount: stats.unmatched.length,
        errors: stats.errors.slice(0, 50),
        errorCount: stats.errors.length,
      },
      null,
      2
    )
  );

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDb();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
