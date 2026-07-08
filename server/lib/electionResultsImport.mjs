import { enrichElectionResultRows, loadContestCandidateRows, syncContestMargin } from "./contestMetrics.mjs";
import { computeContestStats } from "./electionMargin.mjs";

const VALID_METRIC_KEYS = new Set(["trump_2024", "cruz_2024", "abbott_2022", "leg_2024", "leg_2022"]);
const PARTY_VALUES = new Set(["R", "D", "I", "L", "G", "O"]);

export const ELECTION_RESULTS_BULK_TEMPLATE = [
  "id",
  "office_id",
  "office_code",
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
].join(",");

export const ELECTION_RESULTS_EXPORT_COLUMNS = [
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

function parseExportedContestMargin(value) {
  const cleaned = String(value ?? "")
    .replace(/%/g, "")
    .trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) throw new Error(`invalid contest_margin: ${value}`);
  // Election-results exports store signed margin decimals (R−D). Allow percent points too.
  if (Math.abs(num) > 1) return num / 100;
  return num;
}

function parseOptionalInteger(value) {
  if (value == null || String(value).trim() === "") return null;
  const num = Number(String(value).replace(/,/g, ""));
  if (!Number.isInteger(num)) throw new Error(`invalid integer: ${value}`);
  return num;
}

function parseOptionalNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const num = Number(String(value).replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(num)) throw new Error(`invalid number: ${value}`);
  return num;
}

function parseOptionalBooleanInt(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return 1;
  if (["0", "false", "no", "n"].includes(normalized)) return 0;
  throw new Error(`invalid boolean: ${value}`);
}

function parseParty(value) {
  const party = String(value ?? "").trim().toUpperCase();
  if (!PARTY_VALUES.has(party)) throw new Error(`invalid party: ${value}`);
  return party;
}

function parseMetricKey(value) {
  const metricKey = String(value ?? "").trim();
  if (!VALID_METRIC_KEYS.has(metricKey)) {
    throw new Error(`metric_key must be one of ${[...VALID_METRIC_KEYS].join(", ")}`);
  }
  return metricKey;
}

function contestKey(officeId, metricKey) {
  return `${officeId}|${metricKey}`;
}

function parseCsvLine(line) {
  const values = [];
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
    } else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

export function parseElectionResultsCsv(text) {
  const lines = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header.trim()] = values[index] ?? "";
    });
    return row;
  });
}

function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-9;
  }
  return String(a) === String(b);
}

async function resolveOffice(db, row) {
  const officeId = parseOptionalInteger(row.office_id);
  if (officeId != null) {
    const office = await db.prepare(`SELECT id, office_code FROM offices WHERE id = ?`).get(officeId);
    if (office) return office;
    throw new Error(`office_id ${officeId} not found`);
  }

  const officeCode = String(row.office_code ?? "").trim();
  if (!officeCode) throw new Error("office_id or office_code is required");

  const office = await db.prepare(`SELECT id, office_code FROM offices WHERE office_code = ?`).get(officeCode);
  if (!office) throw new Error(`office_code ${officeCode} not found`);
  return office;
}

function buildRowUpdates(existing, fields) {
  const updates = [];
  const params = { id: existing.id };

  for (const [column, nextValue] of Object.entries(fields)) {
    if (nextValue === undefined) continue;
    const currentValue = existing[column];
    if (valuesEqual(currentValue, nextValue)) continue;
    updates.push(`${column} = @${column}`);
    params[column] = nextValue;
  }

  return { updates, params };
}

export async function fetchElectionResultsForExport(db, { category } = {}) {
  const params = {};
  let where = "WHERE 1=1";
  if (category) {
    where += " AND o.category = @category";
    params.category = category;
  }

  const rows = await db
    .prepare(
      `SELECT c.id, c.office_id, o.office_code, o.office_name, o.category, o.district,
              c.metric_key, c.candidate_name, c.party, c.votes, c.vote_pct,
              c.contest_margin, c.unopposed, c.contest_name, c.source, c.sort_order
       FROM metric_contest_candidates c
       JOIN offices o ON o.id = c.office_id
       ${where}
       ORDER BY o.category, o.sort_order, o.district, c.metric_key, c.sort_order, c.votes DESC NULLS LAST`
    )
    .all(params);

  enrichElectionResultRows(rows);
  return rows;
}

export async function recomputeContestDerivedFields(
  db,
  officeId,
  metricKey,
  { marginOverride = null, recomputeVotePct = true } = {}
) {
  const rows = await db
    .prepare(
      `SELECT id, candidate_name, party, votes, vote_pct, unopposed
       FROM metric_contest_candidates
       WHERE office_id = ? AND metric_key = ?`
    )
    .all(officeId, metricKey);

  if (rows.length === 0) return;

  if (recomputeVotePct) {
    const stats = computeContestStats(rows);
    for (const pctRow of stats.candidates) {
      const dbRow = rows.find(
        (row) => row.candidate_name === pctRow.candidate_name && row.party === pctRow.party
      );
      if (!dbRow) continue;
      await db
        .prepare(`UPDATE metric_contest_candidates SET vote_pct = @vote_pct WHERE id = @id`)
        .run({ id: dbRow.id, vote_pct: pctRow.vote_pct });
    }
  }

  await syncContestMargin(db, officeId, metricKey, { marginOverride });
}

async function upsertElectionResultRow(db, row) {
  const rowId = parseOptionalInteger(row.id);
  const candidateName =
    row.candidate_name !== undefined ? String(row.candidate_name ?? "").trim() : undefined;
  const party = row.party !== undefined ? parseParty(row.party) : undefined;
  const metricKey = row.metric_key !== undefined ? parseMetricKey(row.metric_key) : undefined;

  if (rowId == null) {
    if (!candidateName) throw new Error("candidate_name is required");
    if (!party) throw new Error("party is required");
    if (!metricKey) throw new Error("metric_key is required");
  }

  const votes = row.votes !== undefined ? parseOptionalInteger(row.votes) : undefined;
  const votePct =
    row.vote_pct !== undefined && String(row.vote_pct).trim() !== ""
      ? parseOptionalNumber(row.vote_pct)
      : undefined;
  const unopposed = row.unopposed !== undefined ? parseOptionalBooleanInt(row.unopposed) : undefined;
  const contestName = row.contest_name !== undefined ? String(row.contest_name ?? "").trim() || null : undefined;
  const source = row.source !== undefined ? String(row.source ?? "").trim() || null : undefined;
  const sortOrder = row.sort_order !== undefined ? parseOptionalInteger(row.sort_order) : undefined;
  const marginOverride =
    row.contest_margin !== undefined && String(row.contest_margin).trim() !== ""
      ? parseExportedContestMargin(row.contest_margin)
      : undefined;

  if (rowId != null) {
    const existing = await db
      .prepare(
        `SELECT id, office_id, metric_key, candidate_name, party, votes, vote_pct, contest_margin,
                unopposed, contest_name, source, sort_order
         FROM metric_contest_candidates WHERE id = ?`
      )
      .get(rowId);
    if (!existing) throw new Error(`id ${rowId} not found`);

    const { updates, params } = buildRowUpdates(existing, {
      metric_key: row.metric_key !== undefined ? metricKey : undefined,
      candidate_name: candidateName,
      party,
      votes,
      vote_pct: votePct,
      unopposed,
      contest_name: contestName,
      source,
      sort_order: sortOrder,
    });

    const marginChanged =
      marginOverride != null && !valuesEqual(existing.contest_margin, marginOverride);

    if (updates.length === 0 && !marginChanged) {
      return {
        officeId: existing.office_id,
        metricKey: existing.metric_key,
        action: "unchanged",
        changed: false,
        recomputeVotePct: false,
      };
    }

    if (updates.length > 0) {
      await db
        .prepare(`UPDATE metric_contest_candidates SET ${updates.join(", ")} WHERE id = @id`)
        .run(params);
    }

    return {
      officeId: existing.office_id,
      metricKey: params.metric_key ?? existing.metric_key,
      marginOverride: marginChanged ? marginOverride : undefined,
      action: "updated",
      changed: true,
      recomputeVotePct: votes !== undefined && votePct === undefined,
    };
  }

  const office = await resolveOffice(db, row);
  if (!candidateName || !party || !metricKey) {
    throw new Error("candidate_name, party, and metric_key are required for new rows");
  }
  const nextSort =
    sortOrder ??
    (
      await db
        .prepare(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
           FROM metric_contest_candidates WHERE office_id = ? AND metric_key = ?`
        )
        .get(office.id, metricKey)
    )?.next_sort ??
    0;

  const insertParams = {
    office_id: office.id,
    metric_key: metricKey,
    candidate_name: candidateName,
    party,
    votes: votes ?? null,
    vote_pct: votePct ?? null,
    unopposed: unopposed ?? 0,
    contest_name: contestName ?? null,
    source: source ?? "import",
    sort_order: nextSort,
  };

  const existing = await db
    .prepare(
      `SELECT id, office_id, metric_key, candidate_name, party, votes, vote_pct, contest_margin,
              unopposed, contest_name, source, sort_order
       FROM metric_contest_candidates
       WHERE office_id = @office_id AND metric_key = @metric_key
         AND candidate_name = @candidate_name AND party = @party`
    )
    .get(insertParams);

  if (existing) {
    const { updates, params } = buildRowUpdates(existing, {
      votes,
      vote_pct: votePct,
      unopposed,
      contest_name: contestName,
      source,
      sort_order: sortOrder,
    });
    const marginChanged =
      marginOverride != null && !valuesEqual(existing.contest_margin, marginOverride);

    if (updates.length === 0 && !marginChanged) {
      return {
        officeId: office.id,
        metricKey,
        action: "unchanged",
        changed: false,
        recomputeVotePct: false,
      };
    }

    if (updates.length > 0) {
      await db
        .prepare(`UPDATE metric_contest_candidates SET ${updates.join(", ")} WHERE id = @id`)
        .run(params);
    }

    return {
      officeId: office.id,
      metricKey,
      marginOverride: marginChanged ? marginOverride : undefined,
      action: "updated",
      changed: true,
      recomputeVotePct: votes !== undefined && votePct === undefined,
    };
  }

  await db
    .prepare(
      `INSERT INTO metric_contest_candidates (
         office_id, metric_key, candidate_name, party, votes, vote_pct, sort_order, unopposed, contest_name, source
       ) VALUES (
         @office_id, @metric_key, @candidate_name, @party, @votes, @vote_pct, @sort_order, @unopposed, @contest_name, @source
       )`
    )
    .run(insertParams);

  return {
    officeId: office.id,
    metricKey,
    marginOverride,
    action: "inserted",
    changed: true,
    recomputeVotePct: votes !== undefined && votePct === undefined,
  };
}

export async function bulkImportElectionResults(db, rows) {
  const results = {
    processed: rows.length,
    imported: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    errors: [],
  };
  const contests = new Map();
  const marginOverrides = new Map();
  const recomputeVotePctContests = new Set();

  const importRows = db.transaction(async () => {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      try {
        const outcome = await upsertElectionResultRow(db, row);
        results.imported += 1;
        if (outcome.action === "inserted") results.inserted += 1;
        else if (outcome.action === "updated") results.updated += 1;
        else results.unchanged += 1;

        const key = contestKey(outcome.officeId, outcome.metricKey);
        const csvMargin =
          row.contest_margin !== undefined && String(row.contest_margin).trim() !== ""
            ? parseExportedContestMargin(row.contest_margin)
            : null;

        if (outcome.changed || csvMargin != null) {
          contests.set(key, { officeId: outcome.officeId, metricKey: outcome.metricKey });
          if (csvMargin != null) marginOverrides.set(key, csvMargin);
          if (outcome.recomputeVotePct) recomputeVotePctContests.add(key);
        }
      } catch (err) {
        results.errors.push({ row: index + 1, error: err.message });
      }
    }
  });

  await importRows();

  for (const { officeId, metricKey } of contests.values()) {
    const key = contestKey(officeId, metricKey);
    const recomputeVotePct = recomputeVotePctContests.has(key);
    const marginOverride = marginOverrides.get(key) ?? null;
    await recomputeContestDerivedFields(db, officeId, metricKey, {
      marginOverride,
      recomputeVotePct,
    });
  }

  return results;
}

/** Verify contest rows are readable after import (used by tests/scripts). */
export async function loadContestSummary(db, officeId, metricKey) {
  const rows = await loadContestCandidateRows(db, officeId, metricKey);
  return computeContestStats(rows);
}
