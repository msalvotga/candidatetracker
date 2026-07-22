import { candidateLookupKey, ensureCandidate } from "./candidates.mjs";
import {
  canonicalReportEndForPeriod,
  loadFilingPeriodMaps,
  periodLabelFromKey,
  resolvePeriodKey,
} from "./filingPeriods.mjs";
import { normalizeTecFilerId, parseTecFilerIds } from "./tecFilerId.mjs";

function periodLabelForRow(row, maps) {
  if (row.period_label) return row.period_label;
  if (row.period_key) return periodLabelFromKey(row.period_key, maps);
  const end = row.report_period_end;
  if (!end) return "Report";
  if (end.startsWith("label:")) return end.slice(6);
  return end;
}

function sumNullable(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0);
}

function periodGroupKey(row) {
  return `${row.period_key ?? ""}|${row.report_period_end ?? ""}|${row.period_label ?? ""}`;
}

/** Aggregate per-filer finance rows into one display row per filing period. */
export function aggregateFinanceRowsByPeriod(rows, maps) {
  const groups = new Map();

  for (const row of rows) {
    const key = periodGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        id: row.id,
        period_key: row.period_key ?? null,
        period_label: periodLabelForRow(row, maps),
        report_period_end: row.report_period_end?.startsWith("label:") ? null : row.report_period_end,
        sort_order: row.sort_order ?? null,
        contributions: [],
        expenditures: [],
        cash_on_hand: [],
        filer_ids: [],
        source_ids: [],
      });
    }
    const group = groups.get(key);
    group.contributions.push(row.total_raised);
    group.expenditures.push(row.total_spent);
    group.cash_on_hand.push(row.cash_on_hand);
    group.source_ids.push(row.id);
    const filerId = String(row.tec_filer_id ?? "").trim();
    if (filerId) group.filer_ids.push(filerId);
    if (row.sort_order != null && (group.sort_order == null || row.sort_order < group.sort_order)) {
      group.sort_order = row.sort_order;
    }
  }

  return [...groups.values()].map((group) => ({
    id: group.source_ids.length === 1 ? group.id : `sum:${group.source_ids.join("+")}`,
    period_key: group.period_key,
    period_label: group.period_label,
    report_period_end: group.report_period_end,
    contributions: sumNullable(group.contributions),
    expenditures: sumNullable(group.expenditures),
    cash_on_hand: sumNullable(group.cash_on_hand),
    sort_order: group.sort_order,
    tec_filer_ids: group.filer_ids.length ? group.filer_ids : undefined,
    read_only: false,
  }));
}

export async function loadFinanceHistoryMap(db, category, cycleYear) {
  const maps = await loadFilingPeriodMaps(db);
  const rows = await db
    .prepare(
      `SELECT f.id, c.office_id, c.name, c.party, c.is_incumbent,
              f.period_key, f.report_period_end, f.tec_filer_id,
              f.total_raised, f.total_spent, f.cash_on_hand,
              fp.label AS period_label, fp.sort_order
       FROM finance_reports f
       JOIN candidates c ON c.id = f.candidate_id
       JOIN offices o ON o.id = c.office_id
       LEFT JOIN filing_periods fp ON fp.period_key = f.period_key
       WHERE o.category = ? AND c.cycle_year = ?
       ORDER BY COALESCE(fp.sort_order, 999), COALESCE(f.report_period_end, ''), f.id DESC`
    )
    .all(category, cycleYear);

  const byCandidate = new Map();
  for (const row of rows) {
    const key = candidateLookupKey(row.office_id, row.name, row.party, row.is_incumbent);
    if (!byCandidate.has(key)) byCandidate.set(key, []);
    byCandidate.get(key).push(row);
  }

  const map = new Map();
  for (const [key, candidateRows] of byCandidate) {
    map.set(key, aggregateFinanceRowsByPeriod(candidateRows, maps));
  }
  return map;
}

function sortFinanceEntries(entries) {
  return [...entries].sort((a, b) => {
    const aOrder = a.sort_order ?? 999;
    const bOrder = b.sort_order ?? 999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aDate = a.report_period_end ?? "";
    const bDate = b.report_period_end ?? "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return String(a.id).localeCompare(String(b.id));
  });
}

export function attachFinanceHistoryToRaces(races, financeMap) {
  return races.map((race) => ({
    ...race,
    candidates: race.candidates.map((candidate) => {
      const key = candidateLookupKey(race.office_id, candidate.name, candidate.party, candidate.is_incumbent);
      const finance_history = sortFinanceEntries(financeMap.get(key) ?? []);
      return { ...candidate, finance_history };
    }),
  }));
}

export async function addFinanceReport(db, input) {
  const maps = await loadFilingPeriodMaps(db);
  const candidate =
    input.candidateId != null
      ? await db.prepare(`SELECT id, office_id, cycle_year, name, party, is_incumbent FROM candidates WHERE id = ?`).get(input.candidateId)
      : await ensureCandidate(db, {
          officeId: input.officeId,
          cycleYear: input.cycleYear,
          name: input.candidateName,
          party: input.party,
          isIncumbent: input.isIncumbent,
        });

  if (!candidate?.id) throw new Error("candidate not found");

  const label = String(input.period_label ?? "").trim();
  const periodKeyInput = String(input.period_key ?? "").trim();
  const periodKey = periodKeyInput || resolvePeriodKey(label, input.report_period_end, maps);
  const reportEnd = canonicalReportEndForPeriod(periodKey ?? label, maps, input.report_period_end);
  const tecFilerId = normalizeTecFilerId(input.tec_filer_id) ?? "";
  if (tecFilerId && parseTecFilerIds(tecFilerId).length > 1) {
    throw new Error("finance report tec_filer_id must be a single filer ID");
  }

  const row = await db
    .prepare(
      `INSERT INTO finance_reports (candidate_id, period_key, report_period_end, report_type, tec_filer_id, total_raised, total_spent, cash_on_hand)
       VALUES (?, ?, ?, 'TEC', ?, ?, ?, ?)
       ON CONFLICT(candidate_id, report_period_end, report_type, tec_filer_id) DO UPDATE SET
         period_key = excluded.period_key,
         total_raised = excluded.total_raised,
         total_spent = excluded.total_spent,
         cash_on_hand = excluded.cash_on_hand
       RETURNING id, period_key, report_period_end, tec_filer_id, total_raised, total_spent, cash_on_hand`
    )
    .get(
      candidate.id,
      periodKey,
      reportEnd,
      tecFilerId,
      input.contributions ?? null,
      input.expenditures ?? null,
      input.cash_on_hand ?? null
    );

  return {
    id: row.id,
    period_key: row.period_key ?? periodKey ?? null,
    period_label: periodLabelFromKey(row.period_key ?? periodKey, maps) || label || "Report",
    report_period_end: row.report_period_end?.startsWith("label:") ? null : row.report_period_end,
    contributions: row.total_raised,
    expenditures: row.total_spent,
    cash_on_hand: row.cash_on_hand,
    tec_filer_id: row.tec_filer_id || null,
    read_only: false,
  };
}

function parseOptionalNumber(value) {
  if (value === "" || value == null) return null;
  const num = Number(String(value).replace(/[$,%\s]/g, ""));
  return Number.isFinite(num) ? num : null;
}

async function resolveCandidateForImport(db, row) {
  if (row.candidate_id != null) {
    const candidate = await db
      .prepare(
        `SELECT c.id, c.office_id, c.cycle_year, c.name, c.party, c.is_incumbent, o.office_code
         FROM candidates c JOIN offices o ON o.id = c.office_id WHERE c.id = ?`
      )
      .get(Number(row.candidate_id));
    if (!candidate) throw new Error(`candidate_id ${row.candidate_id} not found`);
    return candidate;
  }

  const officeCode = String(row.office_code ?? "").trim();
  const year = Number(row.cycle_year);
  const name = String(row.candidate_name ?? "").trim();
  const party = String(row.party ?? "").trim();
  if (!officeCode || !year || !name || !party) {
    throw new Error("row must include candidate_id or office_code, cycle_year, candidate_name, party");
  }

  const office = await db.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(officeCode);
  if (!office) throw new Error(`office_code ${officeCode} not found`);

  const isIncumbent = ["1", "true", "yes", "y"].includes(String(row.is_incumbent ?? "0").toLowerCase());
  const meta = await ensureCandidate(db, {
    officeId: office.id,
    cycleYear: year,
    name,
    party,
    isIncumbent,
  });
  if (!meta) throw new Error(`could not create candidate for ${name}`);

  return await db
    .prepare(
      `SELECT c.id, c.office_id, c.cycle_year, c.name, c.party, c.is_incumbent, o.office_code
       FROM candidates c JOIN offices o ON o.id = c.office_id WHERE c.id = ?`
    )
    .get(meta.id);
}

export async function bulkImportFinanceReports(db, rows) {
  const results = { imported: 0, errors: [] };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    try {
      const candidate = await resolveCandidateForImport(db, row);
      await addFinanceReport(db, {
        candidateId: candidate.id,
        period_key: row.period_key ? String(row.period_key).trim() : null,
        period_label: String(row.period_label ?? "").trim(),
        report_period_end: row.report_period_end ? String(row.report_period_end).trim() : null,
        tec_filer_id: row.tec_filer_id ?? null,
        contributions: parseOptionalNumber(row.contributions ?? row.total_raised ?? row.raised),
        expenditures: parseOptionalNumber(row.expenditures ?? row.total_spent ?? row.spent),
        cash_on_hand: parseOptionalNumber(row.cash_on_hand ?? row.coh),
      });
      results.imported += 1;
    } catch (err) {
      results.errors.push({ row: index + 1, error: err.message });
    }
  }
  return results;
}
