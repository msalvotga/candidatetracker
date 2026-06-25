import { CANONICAL_CONTESTS } from "./metricContest.mjs";
import { parseBenchmarkMargin } from "./benchmarkMargin.mjs";
import { computeContestStats, storedMarginForMetricKey, isBenchmarkMetricKey, contestMarginFromRows } from "./electionMargin.mjs";
import { saveContestCandidates } from "./tedElectionResults.mjs";

const BENCHMARK_KEYS = ["trump_2024", "cruz_2024", "abbott_2022"];

export async function loadContestCandidateRows(db, officeId, metricKey) {
  return db
    .prepare(
      `SELECT candidate_name, party, votes, vote_pct, contest_margin, unopposed, contest_name, source, sort_order
       FROM metric_contest_candidates
       WHERE office_id = ? AND metric_key = ?
       ORDER BY sort_order, votes DESC NULLS LAST, candidate_name`
    )
    .all(officeId, metricKey);
}

export async function upsertOfficeMetricValue(db, officeId, metricKey, margin) {
  await db
    .prepare(
      `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
       VALUES (@officeId, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(office_id) DO NOTHING`
    )
    .run({ officeId });

  await db.prepare(`UPDATE office_metrics SET ${metricKey} = @margin WHERE office_id = @officeId`).run({
    officeId,
    margin,
  });
}

/** Attach the contest margin to every candidate row in the same office + election. */
export function enrichElectionResultRows(rows) {
  const byContest = new Map();
  for (const row of rows) {
    const key = `${row.office_id}|${row.metric_key}`;
    if (!byContest.has(key)) byContest.set(key, []);
    byContest.get(key).push(row);
  }

  for (const contestRows of byContest.values()) {
    const metricKey = contestRows[0]?.metric_key;
    const margin = contestMarginFromRows(contestRows, metricKey);
    for (const row of contestRows) {
      row.contest_margin = margin;
    }
  }

  return rows;
}

export async function syncContestMargin(db, officeId, metricKey, { marginOverride = null } = {}) {
  const rows = await loadContestCandidateRows(db, officeId, metricKey);

  let margin = marginOverride;
  if (margin == null && rows.length > 0) {
    const stats = computeContestStats(rows);
    margin = storedMarginForMetricKey(metricKey, stats);
  }

  if (rows.length > 0) {
    await db
      .prepare(
        `UPDATE metric_contest_candidates
         SET contest_margin = @margin
         WHERE office_id = @officeId AND metric_key = @metricKey`
      )
      .run({ officeId, metricKey, margin });
  }

  if (margin != null && isBenchmarkMetricKey(metricKey)) {
    await upsertOfficeMetricValue(db, officeId, metricKey, margin);
  }

  return margin;
}

export async function recomputeOfficeMetric(db, officeId, metricKey) {
  return syncContestMargin(db, officeId, metricKey);
}

export async function recomputeAllOfficeMetrics(db, { metricKeys = null } = {}) {
  const keys = metricKeys ?? [...BENCHMARK_KEYS, "leg_2024", "leg_2022"];
  const pairs = await db
    .prepare(
      `SELECT DISTINCT office_id, metric_key
       FROM metric_contest_candidates
       WHERE metric_key IN (${keys.map(() => "?").join(", ")})`
    )
    .all(...keys);

  let updated = 0;
  for (const pair of pairs) {
    const margin = await recomputeOfficeMetric(db, pair.office_id, pair.metric_key);
    if (margin != null) updated += 1;
  }
  return { updated, contests: pairs.length };
}

export async function upsertBenchmarkContestFromMargin(db, officeCode, metricKey, marginDecimal) {
  const canonical = CANONICAL_CONTESTS[metricKey];
  if (!canonical || marginDecimal == null || Number.isNaN(marginDecimal)) return false;

  const total = 10_000;
  const rShare = 0.5 + marginDecimal / 2;
  const rVotes = Math.round(total * rShare);
  const dVotes = Math.max(total - rVotes, 0);

  const contest = {
    contestName: canonical.contestName,
    unopposed: false,
    candidates: [
      {
        name: canonical.candidates[0].name,
        party: canonical.candidates[0].party,
        votes: rVotes,
        vote_pct: rVotes / total,
        sort_order: 0,
        unopposed: false,
      },
      {
        name: canonical.candidates[1].name,
        party: canonical.candidates[1].party,
        votes: dVotes,
        vote_pct: dVotes / total,
        sort_order: 1,
        unopposed: false,
      },
    ],
  };

  const saved = await saveContestCandidates(db, officeCode, metricKey, contest);
  if (!saved) return false;

  const office = await db.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(officeCode);
  if (office) {
    await upsertOfficeMetricValue(db, office.id, metricKey, marginDecimal);
  }
  return true;
}

export async function seedBenchmarkContestsForOffice(db, officeCode, margins) {
  let count = 0;
  for (const metricKey of BENCHMARK_KEYS) {
    const margin = margins[metricKey];
    if (margin == null) continue;
    const ok = await upsertBenchmarkContestFromMargin(db, officeCode, metricKey, margin);
    if (ok) count += 1;
  }
  return count;
}

export async function seedBenchmarkContestsFromRows(db, rows, officeCodeForDistrict) {
  let offices = 0;
  let contests = 0;
  for (const row of rows) {
    const officeCode = officeCodeForDistrict(row);
    if (!officeCode) continue;
    const margins = {
      trump_2024: parseBenchmarkMargin(row.trump, { format: "margin" }),
      cruz_2024: parseBenchmarkMargin(row.cruz, { format: "margin" }),
      abbott_2022: parseBenchmarkMargin(row.abbott, { format: "margin" }),
    };
    const added = await seedBenchmarkContestsForOffice(db, officeCode, margins);
    if (added > 0) {
      offices += 1;
      contests += added;
    }
  }
  return { offices, contests };
}

export function contestSummaryFromRows(rows, metricKey) {
  const storedMargin = rows.find((row) => row.contest_margin != null)?.contest_margin ?? null;
  const stats = computeContestStats(rows);
  const margin = storedMargin ?? storedMarginForMetricKey(metricKey, stats);
  return {
    ...stats,
    margin,
    party_totals_label: stats.totalVotes > 0 ? formatPartySummary(stats.partyTotals) : "",
  };
}

function formatPartySummary(partyTotals) {
  return ["R", "D", "I", "L", "G", "O"]
    .map((party) => ({ party, votes: partyTotals[party] ?? 0 }))
    .filter((entry) => entry.votes > 0)
    .map((entry) => `${entry.party} ${entry.votes.toLocaleString()}`)
    .join(" · ");
}

export async function metricValueFromContests(db, officeId, metricKey, fallback = null) {
  const rows = await loadContestCandidateRows(db, officeId, metricKey);
  if (rows.length === 0) return fallback;
  const summary = contestSummaryFromRows(rows, metricKey);
  return summary.margin ?? fallback;
}
