/** Compute vote totals, party aggregates, and margins from stored contest candidates. */

const PARTY_KEYS = ["R", "D", "I", "L", "G", "O"];

export function normalizeContestCandidate(row) {
  return {
    candidate_name: String(row.candidate_name ?? row.name ?? "").trim(),
    party: String(row.party ?? "O").trim().toUpperCase(),
    votes: row.votes == null ? null : Number(row.votes),
    vote_pct: row.vote_pct == null ? null : Number(row.vote_pct),
    unopposed: Boolean(row.unopposed),
  };
}

export function computeContestStats(candidates) {
  const rows = (candidates ?? []).map(normalizeContestCandidate).filter((row) => row.candidate_name);

  const withVotes = rows.filter((row) => row.votes != null && Number.isFinite(row.votes) && row.votes > 0);
  const totalVotes = withVotes.reduce((sum, row) => sum + row.votes, 0);

  const partyTotals = Object.fromEntries(PARTY_KEYS.map((party) => [party, 0]));
  for (const row of withVotes) {
    const party = PARTY_KEYS.includes(row.party) ? row.party : "O";
    partyTotals[party] += row.votes;
  }

  const sorted = [...withVotes].sort((a, b) => b.votes - a.votes);
  let firstSecondMargin = null;
  if (sorted.length >= 2 && totalVotes > 0) {
    firstSecondMargin = (sorted[0].votes - sorted[1].votes) / totalVotes;
  } else if (sorted.length === 1 && totalVotes > 0) {
    if (sorted[0].party === "R") firstSecondMargin = 1;
    else if (sorted[0].party === "D") firstSecondMargin = -1;
  }

  const twoPartyVotes = partyTotals.R + partyTotals.D;
  let rdMargin = null;
  if (twoPartyVotes > 0) {
    rdMargin = (partyTotals.R - partyTotals.D) / twoPartyVotes;
  }

  const pctRows = rows.map((row) => {
    if (row.votes != null && totalVotes > 0) {
      return { ...row, vote_pct: row.votes / totalVotes };
    }
    return row;
  });

  const unopposed =
    rows.some((row) => row.unopposed) ||
    (sorted.length === 1 && withVotes.length === 1) ||
    (partyTotals.R > 0 && partyTotals.D === 0) ||
    (partyTotals.D > 0 && partyTotals.R === 0);

  // TED unopposed races often store the winner with null votes.
  if (totalVotes === 0 && unopposed) {
    const parties = new Set(rows.map((row) => row.party));
    if (parties.has("R") && !parties.has("D")) {
      firstSecondMargin = 1;
      rdMargin = 1;
    } else if (parties.has("D") && !parties.has("R")) {
      firstSecondMargin = -1;
      rdMargin = -1;
    } else if (rows.length === 1) {
      if (rows[0].party === "R") {
        firstSecondMargin = 1;
        rdMargin = 1;
      } else if (rows[0].party === "D") {
        firstSecondMargin = -1;
        rdMargin = -1;
      }
    }
  }

  return {
    totalVotes,
    partyTotals,
    firstSecondMargin,
    rdMargin,
    sorted,
    candidates: pctRows,
    unopposed,
  };
}

/** R−D margin decimal: positive = R+, negative = D+. */
export function signedContestMargin(stats) {
  if (!stats) return null;
  if (stats.rdMargin != null) {
    return stats.rdMargin;
  }
  if (stats.firstSecondMargin == null) return null;
  const winner = stats.sorted?.[0];
  const magnitude = Math.abs(stats.firstSecondMargin);
  if (winner?.party === "D") return -magnitude;
  if (winner?.party === "R") return magnitude;
  return stats.firstSecondMargin;
}

export function isBenchmarkMetricKey(metricKey) {
  return metricKey === "trump_2024" || metricKey === "cruz_2024" || metricKey === "abbott_2022";
}

export function storedMarginForMetricKey(metricKey, stats) {
  return signedContestMargin(stats);
}

/** Prefer vote-derived margin; fall back to stored contest_margin. */
export function contestMarginFromRows(rows, metricKey) {
  const stats = computeContestStats(rows);
  const margin = storedMarginForMetricKey(metricKey, stats);
  if (margin != null) return margin;
  return rows.find((row) => row.contest_margin != null)?.contest_margin ?? null;
}

export function formatPartyTotals(partyTotals) {
  return PARTY_KEYS.map((party) => `${party}:${partyTotals[party] ?? 0}`).join(" ");
}
