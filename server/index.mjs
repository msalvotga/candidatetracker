import cors from "cors";
import express from "express";
import { getDb } from "./db.mjs";
import {
  adminQueryTable,
  bulkUpdateAdminTableRows,
  exportTableCsv,
  FINANCE_BULK_TEMPLATE,
  insertAdminTableRow,
  listAdminTables,
  loadAdminMultiSelectOptions,
  deleteAdminTableRow,
} from "./lib/adminData.mjs";
import { listConsultants, loadCandidateConsultantsMap, attachConsultantsToRaces, addConsultant } from "./lib/consultants.mjs";
import { syncRaceCandidates, updateCandidateVuid } from "./lib/candidates.mjs";
import { addFinanceReport, attachFinanceHistoryToRaces, bulkImportFinanceReports, loadFinanceHistoryMap } from "./lib/financeReports.mjs";
import { buildBallotWorkbookBuffer } from "./lib/ballotExport.mjs";
import { addFilingPeriod, listFilingPeriods } from "./lib/filingPeriods.mjs";
import { buildContestResponse, detectUncontested } from "./lib/metricContest.mjs";
import { gopShareFromMargin, isLegMetricKey } from "./lib/benchmarkMargin.mjs";
import { seedOfficesIfEmpty } from "./seed-offices.mjs";
import {
  attachSeatHoldersToRaces,
} from "./lib/seatHolder.mjs";
import {
  addTargetingOrganization,
  attachTargetsToRaces,
  listTargetingOrganizations,
  loadOfficeTargetsByOffice,
} from "./lib/targeting.mjs";

const PORT = Number(process.env.CANDIDATE_LOOKUP_PORT ?? 3850);
const app = express();

app.use(cors());
app.use(express.json());

const VALID_CATEGORIES = new Set(["house", "senate", "sboe", "statewide", "congressional"]);

function parseYear(value, fallback = new Date().getFullYear()) {
  const year = Number(value ?? fallback);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return fallback;
  }
  return year;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/cycles", (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT cycle_year AS year FROM race_sheet_rows
       UNION
       SELECT DISTINCT cycle_year AS year FROM candidates
       ORDER BY year DESC`
    )
    .all();
  const years = [...new Set(rows.map((r) => r.year).filter(Boolean))];
  const currentYear = new Date().getFullYear();
  if (!years.includes(currentYear)) {
    years.unshift(currentYear);
  }
  res.json({ years: [...new Set(years)] });
});

function metricFieldsForCategory(category) {
  const fields = [
    { key: "trump_2024", label: "2024 Trump" },
    { key: "cruz_2024", label: "2024 Cruz" },
    { key: "abbott_2022", label: "2022 Abbott" },
  ];
  if (category === "house") {
    fields.push(
      { key: "leg_2024", label: "2024 TX House" },
      { key: "leg_2022", label: "2022 TX House" }
    );
  } else if (category === "senate") {
    fields.push(
      { key: "leg_2024", label: "2024 TX Senate" },
      { key: "leg_2022", label: "2022 TX Senate" }
    );
  } else if (category === "sboe") {
    fields.push(
      { key: "leg_2024", label: "2024 SBOE" },
      { key: "leg_2022", label: "2022 SBOE" }
    );
  } else if (category === "congressional") {
    fields.push(
      { key: "leg_2024", label: "2024 TX CD" },
      { key: "leg_2022", label: "2022 TX CD" }
    );
  } else if (category === "statewide") {
    fields.push(
      { key: "leg_2024", label: "2024 result" },
      { key: "leg_2022", label: "2022 result" }
    );
  }
  return fields;
}

function buildUncontestedMap(database, category) {
  const rows = database
    .prepare(
      `SELECT c.office_id, c.metric_key, c.party, c.unopposed
       FROM metric_contest_candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE o.category = ?`
    )
    .all(category);

  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.office_id}|${row.metric_key}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const map = new Map();
  for (const [key, contestRows] of grouped) {
    const { uncontested, winning_party } = detectUncontested(contestRows, null);
    if (uncontested && winning_party) {
      map.set(key, winning_party);
    }
  }
  return map;
}

const EDITABLE_METRIC_KEYS = new Set(["trump_2024", "cruz_2024", "abbott_2022"]);

function attachSheetMeta(candidate, row, isIncumbent) {
  candidate.filed = Boolean(row.filed);
  candidate.tec_filer_id = row.tec_filer_id ?? null;
  candidate.consultant = row.consultant ?? null;
  candidate.endorsements = row.endorsements ?? null;
  candidate.notes = row.notes ?? null;
  candidate.website = row.website ?? null;
  candidate.social_media = row.social_media ?? null;
  candidate.race_category = row.race_category ?? null;
  candidate.running_for_reelection = isIncumbent ? row.running_for_reelection ?? null : null;
}

function buildRacesFromSheetRows(sheetRows, metricsByOffice, category, uncontestedMap = new Map()) {
  const byOffice = new Map();

  for (const row of sheetRows) {
    if (!byOffice.has(row.office_id)) {
      const metrics = metricsByOffice.get(row.office_id) ?? {};
      const metricFields = metricFieldsForCategory(category);
      byOffice.set(row.office_id, {
        office_id: row.office_id,
        office_code: row.office_code,
        office_name: row.office_name,
        district: row.district,
        metrics: metricFields
          .map((field) => {
            const winningParty = uncontestedMap.get(`${row.office_id}|${field.key}`) ?? null;
            return {
              key: field.key,
              label: field.label,
              value: metrics[field.key] ?? null,
              uncontested: winningParty != null,
              winning_party: winningParty,
            };
          }),
        candidates: [],
      });
    }

    const race = byOffice.get(row.office_id);

    const addCandidate = (name, party, isIncumbent) => {
      const trimmed = String(name ?? "").trim();
      if (!trimmed || !party) return;

      const key = `${trimmed.toLowerCase()}|${party}|${isIncumbent ? 1 : 0}`;
      const existing = race.candidates.find((c) => c._key === key);
      if (existing) {
        attachSheetMeta(existing, row, isIncumbent);
        return;
      }

      const candidate = {
        _key: key,
        name: trimmed,
        party,
        is_incumbent: isIncumbent,
        filed: false,
        tec_filer_id: null,
        consultant: null,
        endorsements: null,
        notes: null,
        website: null,
        social_media: null,
        race_category: null,
        running_for_reelection: null,
      };
      attachSheetMeta(candidate, row, isIncumbent);
      race.candidates.push(candidate);
    };

    addCandidate(row.incumbent_name, row.incumbent_party, true);
    addCandidate(row.candidate_name, row.candidate_party, false);
  }

  const partyOrder = { R: 0, D: 1, I: 2, L: 3, G: 4, O: 5 };

  return [...byOffice.values()]
    .map((race) => ({
      office_id: race.office_id,
      office_code: race.office_code,
      office_name: race.office_name,
      district: race.district,
      metrics: race.metrics,
      candidates: race.candidates
        .map(({ _key, ...candidate }) => candidate)
        .sort((a, b) => {
          const partyDiff = (partyOrder[a.party] ?? 9) - (partyOrder[b.party] ?? 9);
          if (partyDiff !== 0) return partyDiff;
          if (a.is_incumbent !== b.is_incumbent) return a.is_incumbent ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    }))
    .filter((race) => race.candidates.length > 0);
}

app.get("/api/races", (req, res) => {
  const category = String(req.query.category ?? "");
  if (!VALID_CATEGORIES.has(category)) {
    res.status(400).json({ error: "category must be house, senate, sboe, statewide, or congressional" });
    return;
  }

  const cycleYear = parseYear(req.query.year);
  const db = getDb();

  const rows = db
    .prepare(
      `
      SELECT
        r.id AS row_id,
        o.id AS office_id,
        o.office_code,
        o.office_name,
        o.district,
        r.incumbent_name,
        r.incumbent_party,
        r.running_for_reelection,
        r.candidate_name,
        r.candidate_party,
        r.filed,
        r.tec_filer_id,
        r.consultant,
        r.endorsements,
        r.notes,
        r.social_media,
        r.website,
        r.race_category
      FROM race_sheet_rows r
      JOIN offices o ON o.id = r.office_id
      WHERE r.category = @category AND r.cycle_year = @cycleYear
      ORDER BY o.sort_order, o.district, o.office_code, r.row_order
      `
    )
    .all({ category, cycleYear });

  const metricsRows = db
    .prepare(
      `SELECT m.* FROM office_metrics m
       JOIN offices o ON o.id = m.office_id
       WHERE o.category = ?`
    )
    .all(category);
  const metricsByOffice = new Map(metricsRows.map((m) => [m.office_id, m]));
  const uncontestedMap = buildUncontestedMap(db, category);
  const financeMap = loadFinanceHistoryMap(db, category, cycleYear);
  let races = buildRacesFromSheetRows(rows, metricsByOffice, category, uncontestedMap);
  syncRaceCandidates(db, races, cycleYear, category);
  races = attachFinanceHistoryToRaces(races, financeMap);
  races = attachSeatHoldersToRaces(db, races, rows, category);
  const targetsByOffice = loadOfficeTargetsByOffice(db, category, cycleYear);
  races = attachTargetsToRaces(races, targetsByOffice);
  const consultantsMap = loadCandidateConsultantsMap(db, category, cycleYear);
  races = attachConsultantsToRaces(races, consultantsMap);

  res.json({
    category,
    cycleYear,
    races,
    filing_periods: listFilingPeriods(db),
    targeting_organizations: listTargetingOrganizations(db),
    consultants: listConsultants(db, { cycleYear, category }),
  });
});

app.get("/api/filing-periods", (_req, res) => {
  const db = getDb();
  res.json({ periods: listFilingPeriods(db) });
});

app.post("/api/filing-periods", (req, res) => {
  const db = getDb();
  try {
    const period = addFilingPeriod(db, req.body ?? {});
    res.json({ period });
  } catch (err) {
    const status = err.code === "SQLITE_CONSTRAINT" ? 409 : 400;
    res.status(status).json({ error: err.message ?? "failed to add filing period" });
  }
});

const VALID_ELECTIONS = new Set(["pres_2024", "cruz_2024", "abbott_2022"]);

app.get("/api/counties", (req, res) => {
  const election = String(req.query.election ?? "");
  if (!VALID_ELECTIONS.has(election)) {
    res.status(400).json({ error: "election must be pres_2024, cruz_2024, or abbott_2022" });
    return;
  }

  const db = getDb();
  const counties = db
    .prepare(
      `SELECT county_name, county_key, margin, gop_pct, dem_pct, gop_votes, dem_votes
       FROM county_election_results
       WHERE election_key = ?
       ORDER BY county_name`
    )
    .all(election);

  res.json({ election, counties });
});

const VALID_METRIC_KEYS = new Set(["trump_2024", "cruz_2024", "abbott_2022", "leg_2024", "leg_2022"]);

app.get("/api/offices/:officeId/metrics/:metricKey/contest", (req, res) => {
  const officeId = Number(req.params.officeId);
  const metricKey = String(req.params.metricKey ?? "");
  if (!Number.isInteger(officeId) || officeId < 1) {
    res.status(400).json({ error: "invalid officeId" });
    return;
  }
  if (!VALID_METRIC_KEYS.has(metricKey)) {
    res.status(400).json({ error: "invalid metric key" });
    return;
  }

  const db = getDb();
  const office = db
    .prepare(`SELECT id, office_code, office_name, category FROM offices WHERE id = ?`)
    .get(officeId);
  if (!office) {
    res.status(404).json({ error: "office not found" });
    return;
  }

  const metrics = db.prepare(`SELECT * FROM office_metrics WHERE office_id = ?`).get(officeId);
  const stored = metrics?.[metricKey] ?? null;
  const gopShare = isLegMetricKey(metricKey) ? gopShareFromMargin(stored) : stored;
  const label = metricFieldsForCategory(office.category).find((field) => field.key === metricKey)?.label ?? metricKey;

  const rows = db
    .prepare(
      `SELECT candidate_name, party, votes, vote_pct, unopposed, contest_name, source
       FROM metric_contest_candidates
       WHERE office_id = ? AND metric_key = ?
       ORDER BY sort_order, votes DESC`
    )
    .all(officeId, metricKey);

  const contest = buildContestResponse(office, metricKey, label, gopShare, rows);
  if (!contest) {
    res.status(404).json({ error: "no contest data for this metric" });
    return;
  }

  res.json(contest);
});


function parseOptionalNumber(value) {
  if (value === "" || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

app.patch("/api/offices/:officeId/metrics", (req, res) => {
  const officeId = Number(req.params.officeId);
  const { key, value } = req.body ?? {};
  if (!Number.isInteger(officeId) || officeId < 1) {
    res.status(400).json({ error: "invalid officeId" });
    return;
  }
  if (!VALID_METRIC_KEYS.has(key)) {
    res.status(400).json({ error: "invalid metric key" });
    return;
  }
  if (!EDITABLE_METRIC_KEYS.has(key)) {
    res.status(403).json({ error: "prior election results cannot be edited" });
    return;
  }

  const db = getDb();
  const office = db.prepare(`SELECT id FROM offices WHERE id = ?`).get(officeId);
  if (!office) {
    res.status(404).json({ error: "office not found" });
    return;
  }

  const parsed = parseOptionalNumber(value);
  const columns = {
    trump_2024: null,
    cruz_2024: null,
    abbott_2022: null,
    leg_2024: null,
    leg_2022: null,
  };
  columns[key] = parsed;

  db.prepare(
    `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
     VALUES (@officeId, @trump_2024, @cruz_2024, @abbott_2022, @leg_2024, @leg_2022)
     ON CONFLICT(office_id) DO UPDATE SET ${key} = excluded.${key}`
  ).run({ officeId, ...columns });

  const updated = db.prepare(`SELECT * FROM office_metrics WHERE office_id = ?`).get(officeId);
  res.json({ office_id: officeId, metrics: updated });
});

app.post("/api/races/finance-reports", (req, res) => {
  const {
    candidate_id,
    office_id,
    cycle_year,
    candidate_name,
    party,
    is_incumbent,
    period_key,
    period_label,
    report_period_end,
    contributions,
    expenditures,
    cash_on_hand,
  } = req.body ?? {};

  const db = getDb();
  try {
    const entry = addFinanceReport(db, {
      candidateId: candidate_id != null ? Number(candidate_id) : null,
      officeId: Number(office_id),
      cycleYear: Number(cycle_year),
      candidateName: candidate_name,
      party,
      isIncumbent: Boolean(is_incumbent),
      period_key,
      period_label,
      report_period_end,
      contributions: parseOptionalNumber(contributions),
      expenditures: parseOptionalNumber(expenditures),
      cash_on_hand: parseOptionalNumber(cash_on_hand),
    });
    res.json({ entry });
  } catch (err) {
    res.status(400).json({ error: err.message ?? "failed to save finance report" });
  }
});

app.get("/api/targeting/organizations", (_req, res) => {
  const db = getDb();
  res.json({ organizations: listTargetingOrganizations(db) });
});

app.post("/api/targeting/organizations", (req, res) => {
  try {
    const db = getDb();
    const org = addTargetingOrganization(db, req.body ?? {});
    res.json(org);
  } catch (err) {
    const status = err.code === "SQLITE_CONSTRAINT" ? 409 : 400;
    res.status(status).json({ error: err.message ?? "failed to create organization" });
  }
});

app.get("/api/consultants", (req, res) => {
  const db = getDb();
  const cycleYear = req.query.cycle_year ? Number(req.query.cycle_year) : null;
  const category = req.query.category ? String(req.query.category) : null;
  res.json({ consultants: listConsultants(db, { cycleYear, category }) });
});

app.post("/api/consultants", (req, res) => {
  try {
    const db = getDb();
    const consultant = addConsultant(db, req.body ?? {});
    res.json(consultant);
  } catch (err) {
    const status = err.code === "SQLITE_CONSTRAINT" ? 409 : 400;
    res.status(status).json({ error: err.message ?? "failed to create consultant" });
  }
});

app.get("/api/admin/tables", (_req, res) => {
  res.json({ tables: listAdminTables() });
});

app.get("/api/admin/tables/:tableName", (req, res) => {
  const tableName = String(req.params.tableName ?? "");
  const cycleYear = req.query.cycle_year ? Number(req.query.cycle_year) : null;
  const category = req.query.category ? String(req.query.category) : null;
  const singleCandidateRaces = String(req.query.single_candidate_races ?? "") === "1";
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  try {
    const db = getDb();
    const result = adminQueryTable(db, tableName, {
      cycleYear,
      category,
      limit,
      offset,
      singleCandidateRaces,
    });
    res.json({ table: tableName, ...result, limit, offset });
  } catch (err) {
    res.status(400).json({ error: err.message ?? "invalid table" });
  }
});

app.patch("/api/admin/tables/:tableName", (req, res) => {
  const tableName = String(req.params.tableName ?? "");
  const updates = req.body?.updates;
  const cycleYear = req.body?.cycle_year ? Number(req.body.cycle_year) : null;
  if (!Array.isArray(updates) || updates.length === 0) {
    res.status(400).json({ error: "updates array required" });
    return;
  }

  try {
    const db = getDb();
    const result = bulkUpdateAdminTableRows(db, tableName, updates, { cycleYear });
    res.json(result);
  } catch (err) {
    const status = err.code === "SQLITE_CONSTRAINT" ? 409 : 400;
    res.status(status).json({ error: err.message ?? "update failed" });
  }
});

app.post("/api/admin/tables/:tableName/rows", (req, res) => {
  const tableName = String(req.params.tableName ?? "");
  const fields = req.body?.fields ?? req.body ?? {};
  try {
    const db = getDb();
    const row = insertAdminTableRow(db, tableName, fields);
    res.json({ row });
  } catch (err) {
    const status = err.code === "SQLITE_CONSTRAINT" ? 409 : 400;
    res.status(status).json({ error: err.message ?? "insert failed" });
  }
});

app.delete("/api/admin/tables/:tableName/rows", (req, res) => {
  const tableName = String(req.params.tableName ?? "");
  const rowId = req.body?.id ?? req.query?.id;
  if (rowId == null || String(rowId).trim() === "") {
    res.status(400).json({ error: "id required" });
    return;
  }
  try {
    const db = getDb();
    const result = deleteAdminTableRow(db, tableName, rowId);
    res.json(result);
  } catch (err) {
    const status = err.code === "SQLITE_CONSTRAINT" ? 409 : 400;
    res.status(status).json({ error: err.message ?? "delete failed" });
  }
});

app.get("/api/admin/multi-select/:refTable", (req, res) => {
  const refTable = String(req.params.refTable ?? "");
  const cycleYear = req.query.cycle_year ? Number(req.query.cycle_year) : null;
  const category = req.query.category ? String(req.query.category) : null;
  try {
    const db = getDb();
    res.json({ options: loadAdminMultiSelectOptions(db, refTable, { cycleYear, category }) });
  } catch (err) {
    res.status(400).json({ error: err.message ?? "invalid reference table" });
  }
});

app.get("/api/admin/export/:tableName.csv", (req, res) => {
  const tableName = String(req.params.tableName ?? "").replace(/\.csv$/i, "");
  const cycleYear = req.query.cycle_year ? Number(req.query.cycle_year) : null;
  const category = req.query.category ? String(req.query.category) : null;

  try {
    const db = getDb();
    const csv = exportTableCsv(db, tableName, { cycleYear, category });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${tableName}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(400).json({ error: err.message ?? "export failed" });
  }
});

app.get("/api/export/ballot", (req, res) => {
  const cycleYear = parseYear(req.query.year);
  try {
    const db = getDb();
    const buffer = buildBallotWorkbookBuffer(db, cycleYear);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ballot-summary-${cycleYear}.xlsx"`
    );
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message ?? "export failed" });
  }
});

app.get("/api/admin/finance/template.csv", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="finance-import-template.csv"');
  res.send(`${FINANCE_BULK_TEMPLATE}\n`);
});

app.post("/api/admin/finance/bulk", (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows?.length) {
    res.status(400).json({ error: "body.rows must be a non-empty array" });
    return;
  }
  const db = getDb();
  const result = bulkImportFinanceReports(db, rows);
  res.json(result);
});

app.patch("/api/admin/candidates/:candidateId/vuid", (req, res) => {
  const candidateId = Number(req.params.candidateId);
  if (!Number.isInteger(candidateId) || candidateId < 1) {
    res.status(400).json({ error: "invalid candidate id" });
    return;
  }
  const db = getDb();
  const exists = db.prepare(`SELECT id FROM candidates WHERE id = ?`).get(candidateId);
  if (!exists) {
    res.status(404).json({ error: "candidate not found" });
    return;
  }
  try {
    const vuid = updateCandidateVuid(db, candidateId, req.body?.vuid);
    res.json({ id: candidateId, vuid });
  } catch (err) {
    res.status(409).json({ error: err.message ?? "failed to update vuid" });
  }
});

app.patch("/api/counties/:countyKey", (req, res) => {
  const countyKey = String(req.params.countyKey ?? "").trim();
  const { election, margin, gop_pct, dem_pct, gop_votes, dem_votes } = req.body ?? {};
  if (!countyKey || !VALID_ELECTIONS.has(election)) {
    res.status(400).json({ error: "election and countyKey required" });
    return;
  }

  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM county_election_results WHERE election_key = ? AND county_key = ?`)
    .get(election, countyKey);
  if (!existing) {
    res.status(404).json({ error: "county not found" });
    return;
  }

  const nextGopPct = gop_pct !== undefined ? parseOptionalNumber(gop_pct) : existing.gop_pct;
  const nextDemPct = dem_pct !== undefined ? parseOptionalNumber(dem_pct) : existing.dem_pct;
  let nextMargin = margin !== undefined ? parseOptionalNumber(margin) : existing.margin;
  if (margin === undefined && (gop_pct !== undefined || dem_pct !== undefined)) {
    if (nextGopPct != null && nextDemPct != null) nextMargin = nextGopPct - nextDemPct;
    else if (nextGopPct != null) nextMargin = nextGopPct - 0.5;
  }

  const nextGopVotes =
    gop_votes !== undefined
      ? gop_votes === "" || gop_votes == null
        ? null
        : Math.round(Number(gop_votes))
      : existing.gop_votes;
  const nextDemVotes =
    dem_votes !== undefined
      ? dem_votes === "" || dem_votes == null
        ? null
        : Math.round(Number(dem_votes))
      : existing.dem_votes;

  db.prepare(
    `UPDATE county_election_results
     SET margin = @margin, gop_pct = @gop_pct, dem_pct = @dem_pct, gop_votes = @gop_votes, dem_votes = @dem_votes
     WHERE election_key = @election AND county_key = @countyKey`
  ).run({
    election,
    countyKey,
    margin: nextMargin,
    gop_pct: nextGopPct,
    dem_pct: nextDemPct,
    gop_votes: Number.isFinite(nextGopVotes) ? nextGopVotes : null,
    dem_votes: Number.isFinite(nextDemVotes) ? nextDemVotes : null,
  });

  const updated = db
    .prepare(
      `SELECT county_name, county_key, margin, gop_pct, dem_pct, gop_votes, dem_votes
       FROM county_election_results WHERE election_key = ? AND county_key = ?`
    )
    .get(election, countyKey);

  res.json({ county: updated });
});

app.get("/api/offices/:officeId/history", (req, res) => {
  const officeId = Number(req.params.officeId);
  if (!Number.isInteger(officeId) || officeId < 1) {
    res.status(400).json({ error: "invalid officeId" });
    return;
  }

  const db = getDb();
  const office = db
    .prepare(`SELECT id, category, district, office_code, office_name FROM offices WHERE id = ?`)
    .get(officeId);
  if (!office) {
    res.status(404).json({ error: "office not found" });
    return;
  }

  const results = db
    .prepare(
      `SELECT cycle_year, election_type, candidate_name, party, votes, vote_pct, won, source
       FROM election_results
       WHERE office_id = ?
       ORDER BY cycle_year DESC, election_type, party, candidate_name`
    )
    .all(officeId);

  const finance = db
    .prepare(
      `
      SELECT
        c.cycle_year,
        c.party,
        c.name AS candidate_name,
        c.is_incumbent,
        f.report_period_end,
        f.report_type,
        f.total_raised,
        f.total_spent,
        f.cash_on_hand,
        f.debt,
        f.source_url
      FROM candidates c
      JOIN finance_reports f ON f.candidate_id = c.id
      WHERE c.office_id = ?
      ORDER BY f.report_period_end DESC, c.party, c.name
      `
    )
    .all(officeId);

  res.json({ office, results, finance });
});

seedOfficesIfEmpty(getDb());

app.listen(PORT, () => {
  console.log(`Candidate lookup API on http://127.0.0.1:${PORT}`);
});
