import { canonicalReportEndForPeriod, loadFilingPeriodMaps } from "./filingPeriods.mjs";
import { SENATE_DISTRICTS } from "../data/senate-districts.mjs";
import { SBOE_DISTRICTS } from "../data/sboe-districts.mjs";

const SENATE_DISTRICT_SET = new Set(SENATE_DISTRICTS);
const SBOE_DISTRICT_SET = new Set(SBOE_DISTRICTS);

const STATEWIDE_OFFICE_MAP = {
  Governor: { code: "GOV", name: "Governor" },
  "Lt. Governor": { code: "LTGOV", name: "Lieutenant Governor" },
  "Attorney General": { code: "AG", name: "Attorney General" },
  Comptroller: { code: "COMPT", name: "Comptroller" },
  GLO: { code: "GLO", name: "General Land Office" },
  "Ag Comm": { code: "AGRI", name: "Commissioner of Agriculture" },
  RRC: { code: "RRC", name: "Railroad Commissioner" },
  "US Senate": { code: "USS-TX", name: "U.S. Senate (Texas)", category: "congressional" },
  "SCOTX Chief": { code: "SCOTX-CHIEF", name: "Supreme Court, Chief Justice" },
  "SCOTX Pl 2": { code: "SCOTX-PL2", name: "Supreme Court, Place 2" },
  "SCOTX Pl 7": { code: "SCOTX-PL7", name: "Supreme Court, Place 7" },
  "SCOTX Pl 8": { code: "SCOTX-PL8", name: "Supreme Court, Place 8" },
  "CCA, Pl 3": { code: "CCA-PL3", name: "Court of Criminal Appeals, Place 3" },
  "CCA Presiding": { code: "CCA-PRES", name: "Court of Criminal Appeals, Presiding Judge" },
  "CCA, Pl 4": { code: "CCA-PL4", name: "Court of Criminal Appeals, Place 4" },
  "CCA, Pl 9": { code: "CCA-PL9", name: "Court of Criminal Appeals, Place 9" },
  "15th Court, Chief": { code: "15TH-CHIEF", name: "15th Court of Appeals, Chief" },
  "15th Court, Pl 2": { code: "15TH-PL2", name: "15th Court of Appeals, Place 2" },
  "15th Court, Pl 3": { code: "15TH-PL3", name: "15th Court of Appeals, Place 3" },
};

export const SHEET_CONFIGS = [
  {
    sheetName: "2026 TX House",
    category: "house",
    cycleYear: 2026,
    cols: {
      district: 0,
      incumbentName: 1,
      incumbentParty: 2,
      runningForReelection: 3,
      candidateName: 4,
      candidateParty: 5,
      filed: 6,
      tecFilerId: 8,
      notes: 9,
      consultant: 10,
      endorsements: 11,
      socialMedia: 12,
      website: 13,
      julyRaised: 14,
      julySpent: 15,
      julyCoh: 16,
      janRaised: 17,
      janSpent: 18,
      janCoh: 19,
    },
    metricCols: {
      leg2024: 21,
      leg2022: 22,
      trump2024: 23,
      cruz2024: 24,
      abbott2022: 25,
    },
  },
  {
    sheetName: "2026 TX Senate",
    category: "senate",
    cycleYear: 2026,
    cols: {
      district: 0,
      incumbentName: 1,
      incumbentParty: 2,
      runningForReelection: 3,
      candidateName: 4,
      candidateParty: 5,
      filed: 6,
      tecFilerId: 10,
      endorsements: 11,
      notes: 12,
      socialMedia: 13,
      website: 14,
      raceCategory: 15,
      julyRaised: 16,
      julySpent: 17,
      julyCoh: 18,
      janRaised: 19,
      janSpent: 20,
      janCoh: 21,
      consultant: 9,
    },
    metricCols: {
      trump2024: 22,
      cruz2024: 23,
      abbott2022: 24,
    },
  },
  {
    sheetName: "2026 SBOE",
    category: "sboe",
    cycleYear: 2026,
    cols: {
      district: 0,
      incumbentName: 1,
      incumbentParty: 2,
      runningForReelection: 3,
      candidateName: 4,
      candidateParty: 5,
      filed: 6,
      tecFilerId: 8,
      notes: 9,
      consultant: 10,
      endorsements: 11,
      socialMedia: 12,
      website: 13,
      julyRaised: 14,
      julySpent: 15,
      julyCoh: 16,
      janRaised: 17,
      janSpent: 18,
      janCoh: 19,
    },
    metricCols: {
      cruz2024: 20,
      trump2024: 21,
      abbott2022: 22,
    },
  },
  {
    sheetName: "2026 TX Statewides",
    category: "statewide",
    cycleYear: 2026,
    cols: {
      district: 0,
      incumbentName: 1,
      incumbentParty: 2,
      runningForReelection: 3,
      candidateName: 4,
      candidateParty: 5,
      filed: 6,
      tecFilerId: 8,
      consultant: 9,
      endorsements: 10,
      notes: 11,
      socialMedia: 12,
      website: 13,
      julyRaised: 14,
      julySpent: 15,
      julyCoh: 16,
      janRaised: 17,
      janSpent: 18,
      janCoh: 19,
    },
  },
  {
    sheetName: "2026 TX - US Congress",
    category: "congressional",
    cycleYear: 2026,
    cols: {
      district: 0,
      incumbentName: 1,
      incumbentParty: 2,
      runningForReelection: 3,
      candidateName: 4,
      candidateParty: 5,
      filed: 6,
      consultant: 8,
      endorsements: 9,
      notes: 10,
      socialMedia: 11,
      website: 12,
      julyRaised: 13,
      julySpent: 14,
      julyCoh: 15,
    },
    metricCols: {
      cruz2024: 16,
      trump2024: 17,
      leg2024: 18,
      abbott2022: 19,
      leg2022: 20,
    },
  },
];

const HEADER_LABELS = new Set(["HD", "SD", "Dist", "Office", "CD"]);

export function normalizeParty(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return null;
  if (value === "GOP" || value === "R" || value === "REPUBLICAN") return "R";
  if (value === "DEM" || value === "D" || value === "DEMOCRAT" || value === "DEMOCRATIC") return "D";
  if (value === "IND" || value === "I" || value === "INDEPENDENT") return "I";
  if (value === "LIB" || value === "L" || value === "LIBERTARIAN") return "L";
  if (value === "GRN" || value === "G" || value === "GREEN") return "G";
  return "O";
}

export function parseMoney(value) {
  if (value === "" || value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export const parseMetricValue = parseMoney;

export function parseFiled(value) {
  if (value === true || value === 1) return 1;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "yes" || text === "y" || text === "1" ? 1 : 0;
}

function slugOfficeCode(name) {
  return String(name)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveOfficeCode(category, districtLabel) {
  const label = String(districtLabel ?? "").trim();
  if (!label || HEADER_LABELS.has(label)) return null;

  if (category === "house") {
    const d = Number.parseInt(label, 10);
    if (!Number.isFinite(d)) return null;
    return { code: `HD-${String(d).padStart(3, "0")}`, name: `Texas House District ${d}`, district: d };
  }

  if (category === "senate") {
    const d = Number.parseInt(label, 10);
    if (!Number.isFinite(d)) return null;
    return { code: `SD-${String(d).padStart(2, "0")}`, name: `Texas Senate District ${d}`, district: d };
  }

  if (category === "sboe") {
    const d = Number.parseInt(label, 10);
    if (!Number.isFinite(d)) return null;
    return { code: `SBOE-${String(d).padStart(2, "0")}`, name: `State Board of Education District ${d}`, district: d };
  }

  if (category === "congressional") {
    const d = Number.parseInt(label, 10);
    if (!Number.isFinite(d)) return null;
    return { code: `TX-${d}`, name: `U.S. House District ${d}`, district: d };
  }

  if (category === "statewide") {
    const mapped = STATEWIDE_OFFICE_MAP[label];
    if (mapped) {
      return {
        code: mapped.code,
        name: mapped.name,
        district: null,
        category: mapped.category ?? "statewide",
      };
    }
    return { code: slugOfficeCode(label), name: label, district: null, category: "statewide" };
  }

  return null;
}

function cell(row, index) {
  if (index == null || index < 0) return "";
  return row[index] ?? "";
}

function str(value) {
  return String(value ?? "").trim();
}

export function parseSheetRows(sheetRows, config) {
  const parsed = [];

  for (let i = 1; i < sheetRows.length; i += 1) {
    const row = sheetRows[i];
    const c = config.cols;
    const districtLabel = str(cell(row, c.district));
    const incumbentName = str(cell(row, c.incumbentName));
    const candidateName = str(cell(row, c.candidateName));

    if (!districtLabel || HEADER_LABELS.has(districtLabel)) continue;
    if (!incumbentName && !candidateName) continue;

    const office = resolveOfficeCode(config.category, districtLabel);
    if (!office) continue;
    if (config.category === "senate" && office.district != null && !SENATE_DISTRICT_SET.has(office.district)) {
      continue;
    }
    if (config.category === "sboe" && office.district != null && !SBOE_DISTRICT_SET.has(office.district)) {
      continue;
    }

    const finance = {
      julyRaised: parseMoney(cell(row, c.julyRaised)),
      julySpent: parseMoney(cell(row, c.julySpent)),
      julyCoh: parseMoney(cell(row, c.julyCoh)),
      janRaised: parseMoney(cell(row, c.janRaised)),
      janSpent: parseMoney(cell(row, c.janSpent)),
      janCoh: parseMoney(cell(row, c.janCoh)),
    };

    const financeTarget = incumbentName ? "incumbent" : "challenger";

    parsed.push({
      rowOrder: i,
      office,
      incumbentName,
      incumbentParty: normalizeParty(cell(row, c.incumbentParty)),
      runningForReelection: str(cell(row, c.runningForReelection)),
      candidateName,
      candidateParty: normalizeParty(cell(row, c.candidateParty)),
      filed: parseFiled(cell(row, c.filed)),
      tecFilerId: str(cell(row, c.tecFilerId)) || null,
      consultant: str(cell(row, c.consultant)) || null,
      endorsements: str(cell(row, c.endorsements)) || null,
      notes: str(cell(row, c.notes)) || null,
      socialMedia: str(cell(row, c.socialMedia)) || null,
      website: str(cell(row, c.website)) || null,
      raceCategory: null,
      finance,
      financeTarget,
    });
  }

  return parsed;
}

export async function upsertOffice(database, office, defaultCategory) {
  const category = office.category ?? defaultCategory;
  const existing = await database
    .prepare(`SELECT id FROM offices WHERE office_code = ?`)
    .get(office.code);

  if (existing) return existing.id;

  const district = office.district ?? null;
  const countRow = district ?? await database.prepare(`SELECT COUNT(*) AS n FROM offices WHERE category = ?`).get(category);
  const sortOrder = district ?? countRow.n + 1;

  const result = await database
    .prepare(
      `INSERT INTO offices (category, district, office_code, office_name, sort_order)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .run(category, district, office.code, office.name, sortOrder);

  return Number(result.lastInsertRowid);
}

async function upsertCandidate(database, input) {
  const existing = await database
    .prepare(
      `SELECT id FROM candidates
       WHERE office_id = ? AND cycle_year = ? AND party = ? AND name = ? AND is_incumbent = ?`
    )
    .get(input.officeId, input.cycleYear, input.party, input.name, input.isIncumbent);

  if (existing) {
    await database
      .prepare(
        `UPDATE candidates SET
          filed = @filed,
          running_for_reelection = @runningForReelection,
          tec_filer_id = @tecFilerId,
          consultant = @consultant,
          endorsements = @endorsements,
          notes = @notes,
          website = @website,
          social_media = @socialMedia,
          race_category = @raceCategory
         WHERE id = @id`
      )
      .run({ ...input, id: existing.id });
    return existing.id;
  }

  const result = await database
    .prepare(
      `INSERT INTO candidates (
        office_id, cycle_year, party, name, is_incumbent, filed,
        running_for_reelection, tec_filer_id, consultant, endorsements,
        notes, website, social_media, race_category
      ) VALUES (
        @officeId, @cycleYear, @party, @name, @isIncumbent, @filed,
        @runningForReelection, @tecFilerId, @consultant, @endorsements,
        @notes, @website, @socialMedia, @raceCategory
      )
      RETURNING id`
    )
    .run(input);

  return Number(result.lastInsertRowid);
}

async function upsertFinance(database, candidateId, periodKey, finance, prefix) {
  const raised = finance[`${prefix}Raised`];
  const spent = finance[`${prefix}Spent`];
  const coh = finance[`${prefix}Coh`];
  if (raised == null && spent == null && coh == null) return;

  const maps = await loadFilingPeriodMaps(database);
  const reportEnd = canonicalReportEndForPeriod(periodKey, maps, null);

  await database
    .prepare(
      `INSERT INTO finance_reports (candidate_id, period_key, report_period_end, report_type, total_raised, total_spent, cash_on_hand)
       VALUES (@candidateId, @periodKey, @reportEnd, 'TEC', @raised, @spent, @coh)
       ON CONFLICT(candidate_id, report_period_end, report_type) DO UPDATE SET
         period_key = excluded.period_key,
         total_raised = excluded.total_raised,
         total_spent = excluded.total_spent,
         cash_on_hand = excluded.cash_on_hand`
    )
    .run({ candidateId, periodKey, reportEnd, raised, spent, coh });
}

export async function importParsedRows(database, config, parsedRows) {
  const clearCandidates = database.prepare(
    `DELETE FROM candidates WHERE office_id IN (SELECT id FROM offices WHERE category = ?) AND cycle_year = ?`
  );

  await clearCandidates.run(config.category, config.cycleYear);

  const importMany = database.transaction(async (rows) => {
    for (const row of rows) {
      const officeId = await upsertOffice(database, row.office, config.category);
      const finance = row.finance;

      if (String(row.incumbentName ?? "").trim()) {
        await database
          .prepare(
            `UPDATE offices SET seat_holder_name = @name, seat_holder_party = @party WHERE id = @officeId`
          )
          .run({
            officeId,
            name: String(row.incumbentName).trim(),
            party: row.incumbentParty ? String(row.incumbentParty).trim() : null,
          });
      }

      const syncCandidate = async (name, party, isIncumbent, runningForReelection) => {
        if (!name || !party) return;
        const candidateId = await upsertCandidate(database, {
          officeId,
          cycleYear: config.cycleYear,
          party,
          name,
          isIncumbent,
          filed: row.filed,
          runningForReelection,
          tecFilerId: row.tecFilerId,
          consultant: row.consultant,
          endorsements: row.endorsements,
          notes: row.notes,
          website: row.website,
          socialMedia: row.socialMedia,
          raceCategory: row.raceCategory,
        });

        const attachFinance = row.financeTarget === (isIncumbent ? "incumbent" : "challenger");
        if (attachFinance) {
          await upsertFinance(database, candidateId, "july_25", finance, "july");
          await upsertFinance(database, candidateId, "jan_26", finance, "jan");
        }
      };

      await syncCandidate(row.incumbentName, row.incumbentParty, 1, row.runningForReelection);
      await syncCandidate(row.candidateName, row.candidateParty, 0, null);
    }
  });

  await importMany(parsedRows);
  return parsedRows.length;
}
