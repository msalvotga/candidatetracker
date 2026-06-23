import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalReportEndForPeriod,
  loadFilingPeriodMaps,
  resolvePeriodKey,
  seedFilingPeriods,
} from "./filingPeriods.mjs";
import { ensureCandidate } from "./candidates.mjs";

function sheetHasFinanceColumns(database) {
  return database
    .prepare(`PRAGMA table_info(race_sheet_rows)`)
    .all()
    .some((col) => col.name === "july_raised" || col.name === "july_25_raised");
}

function candidateIdForSheetRow(database, row, preferIncumbent) {
  const lookup = (name, party, isIncumbent) => {
    const trimmed = String(name ?? "").trim();
    const partyCode = String(party ?? "").trim();
    if (!trimmed || !partyCode) return null;
    return database
      .prepare(
        `SELECT id FROM candidates
         WHERE office_id = ? AND cycle_year = ? AND name = ? AND party = ? AND is_incumbent = ?`
      )
      .get(row.office_id, row.cycle_year, trimmed, partyCode, isIncumbent ? 1 : 0)?.id;
  };

  if (preferIncumbent) {
    return (
      lookup(row.incumbent_name, row.incumbent_party, true) ??
      lookup(row.candidate_name, row.candidate_party, false)
    );
  }
  return (
    lookup(row.candidate_name, row.candidate_party, false) ??
    lookup(row.incumbent_name, row.incumbent_party, true)
  );
}

function upsertReportFromSheet(database, candidateId, periodKey, raised, spent, coh, maps) {
  if (raised == null && spent == null && coh == null) return;
  const reportEnd = canonicalReportEndForPeriod(periodKey, maps, null);
  database
    .prepare(
      `INSERT INTO finance_reports (candidate_id, period_key, report_period_end, report_type, total_raised, total_spent, cash_on_hand)
       VALUES (?, ?, ?, 'TEC', ?, ?, ?)
       ON CONFLICT(candidate_id, report_period_end, report_type) DO UPDATE SET
         period_key = excluded.period_key,
         total_raised = COALESCE(excluded.total_raised, finance_reports.total_raised),
         total_spent = COALESCE(excluded.total_spent, finance_reports.total_spent),
         cash_on_hand = COALESCE(excluded.cash_on_hand, finance_reports.cash_on_hand)`
    )
    .run(candidateId, periodKey, reportEnd, raised, spent, coh);
}

export function migrateSheetFinanceToReports(database) {
  if (!sheetHasFinanceColumns(database)) return 0;

  seedFilingPeriods(database);
  const maps = loadFilingPeriodMaps(database);

  const cols = database.prepare(`PRAGMA table_info(race_sheet_rows)`).all().map((c) => c.name);
  const julyRaised = cols.includes("july_25_raised") ? "july_25_raised" : "july_raised";
  const julySpent = cols.includes("july_25_spent") ? "july_25_spent" : "july_spent";
  const julyCoh = cols.includes("july_25_coh") ? "july_25_coh" : "july_coh";
  const janRaised = cols.includes("jan_26_raised") ? "jan_26_raised" : "jan_raised";
  const janSpent = cols.includes("jan_26_spent") ? "jan_26_spent" : "jan_spent";
  const janCoh = cols.includes("jan_26_coh") ? "jan_26_coh" : "jan_coh";

  const rows = database
    .prepare(
      `SELECT office_id, cycle_year, category, incumbent_name, incumbent_party, candidate_name, candidate_party,
              ${julyRaised} AS july_raised, ${julySpent} AS july_spent, ${julyCoh} AS july_coh,
              ${janRaised} AS jan_raised, ${janSpent} AS jan_spent, ${janCoh} AS jan_coh
       FROM race_sheet_rows
       WHERE ${julyRaised} IS NOT NULL OR ${julySpent} IS NOT NULL OR ${julyCoh} IS NOT NULL
          OR ${janRaised} IS NOT NULL OR ${janSpent} IS NOT NULL OR ${janCoh} IS NOT NULL`
    )
    .all();

  let migrated = 0;
  for (const row of rows) {
    let candidateId = candidateIdForSheetRow(database, row, true);
    if (!candidateId) {
      const office = database.prepare(`SELECT id FROM offices WHERE id = ?`).get(row.office_id);
      if (!office) continue;
      const name = String(row.incumbent_name ?? row.candidate_name ?? "").trim();
      const party = String(row.incumbent_party ?? row.candidate_party ?? "").trim();
      if (!name || !party) continue;
      const meta = ensureCandidate(database, {
        officeId: row.office_id,
        cycleYear: row.cycle_year,
        name,
        party,
        isIncumbent: Boolean(String(row.incumbent_name ?? "").trim()),
      });
      candidateId = meta?.id;
    }
    if (!candidateId) continue;

    upsertReportFromSheet(database, candidateId, "july_25", row.july_raised, row.july_spent, row.july_coh, maps);
    upsertReportFromSheet(database, candidateId, "jan_26", row.jan_raised, row.jan_spent, row.jan_coh, maps);
    migrated += 1;
  }

  return migrated;
}

export function backfillFinanceReportPeriodKeys(database) {
  seedFilingPeriods(database);
  const maps = loadFilingPeriodMaps(database);
  const rows = database.prepare(`SELECT id, report_period_end, period_key FROM finance_reports`).all();
  const update = database.prepare(`UPDATE finance_reports SET period_key = ? WHERE id = ?`);
  let changed = 0;

  for (const row of rows) {
    if (row.period_key && maps.byKey.has(row.period_key)) continue;
    const label = row.report_period_end?.startsWith("label:") ? row.report_period_end.slice(6) : "";
    const key = resolvePeriodKey(label, row.report_period_end, maps);
    if (key) {
      update.run(key, row.id);
      changed += 1;
    }
  }
  return changed;
}

export function dropSheetFinanceColumns(database) {
  if (!sheetHasFinanceColumns(database)) return;

  database.exec(`
    CREATE TABLE race_sheet_rows_new (
      id INTEGER PRIMARY KEY,
      office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
      cycle_year INTEGER NOT NULL,
      category TEXT NOT NULL,
      row_order INTEGER NOT NULL,
      incumbent_name TEXT NOT NULL DEFAULT '',
      incumbent_party TEXT,
      running_for_reelection TEXT,
      candidate_name TEXT NOT NULL DEFAULT '',
      candidate_party TEXT,
      filed INTEGER NOT NULL DEFAULT 0 CHECK (filed IN (0, 1)),
      tec_filer_id TEXT,
      consultant TEXT,
      endorsements TEXT,
      notes TEXT,
      social_media TEXT,
      website TEXT,
      race_category TEXT
    );

    INSERT INTO race_sheet_rows_new (
      id, office_id, cycle_year, category, row_order,
      incumbent_name, incumbent_party, running_for_reelection,
      candidate_name, candidate_party, filed, tec_filer_id,
      consultant, endorsements, notes, social_media, website, race_category
    )
    SELECT
      id, office_id, cycle_year, category, row_order,
      incumbent_name, incumbent_party, running_for_reelection,
      candidate_name, candidate_party, filed, tec_filer_id,
      consultant, endorsements, notes, social_media, website, race_category
    FROM race_sheet_rows;

    DROP TABLE race_sheet_rows;
    ALTER TABLE race_sheet_rows_new RENAME TO race_sheet_rows;
    CREATE INDEX IF NOT EXISTS idx_sheet_rows_category ON race_sheet_rows(category, cycle_year, row_order);
  `);
}

export function migrateFinanceSchema(database) {
  const periodsSchema = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'filing_periods'`)
    .get();
  if (!periodsSchema) {
    const schemaPath = fileURLToPath(new URL("../../schema-finance-periods.sql", import.meta.url));
    database.exec(fs.readFileSync(schemaPath, "utf8"));
  }

  const financeCols = database.prepare(`PRAGMA table_info(finance_reports)`).all().map((c) => c.name);
  if (!financeCols.includes("period_key")) {
    database.exec(`ALTER TABLE finance_reports ADD COLUMN period_key TEXT REFERENCES filing_periods(period_key)`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_finance_period_key ON finance_reports(period_key)`);
  }

  seedFilingPeriods(database);
  migrateSheetFinanceToReports(database);
  backfillFinanceReportPeriodKeys(database);
  dropSheetFinanceColumns(database);
}
