function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanCountyHistoricalText(value) {
  return cleanText(value);
}

export function normalizeCountyHistoricalKey(value) {
  return cleanText(value)
    .replace(/\s+county\s*$/i, "")
    .toLowerCase();
}

export function normalizeCountyHistoricalDimensionKey(value) {
  return cleanText(value).toLowerCase();
}

export function isCountyHistoricalTotalVotes(candidateName) {
  return normalizeCountyHistoricalDimensionKey(candidateName) === "total votes";
}

export function isCountyHistoricalRegisteredVoters(candidateName) {
  return normalizeCountyHistoricalDimensionKey(candidateName) === "registered voters";
}

function electionBucketKey(year, electionTypeKey) {
  return `${year}|${electionTypeKey}`;
}

function totalVotesKey(year, electionTypeKey, officeKey, partyKey) {
  return `${year}|${electionTypeKey}|${officeKey}|${partyKey}`;
}

function groupKey(year, electionTypeKey, officeKey, partyKey) {
  return `${year}|${electionTypeKey}|${officeKey}|${partyKey}`;
}

function displayElectionType(electionType) {
  const key = normalizeCountyHistoricalDimensionKey(electionType);
  if (key === "general") return "General";
  if (key === "primary") return "Primary";
  return cleanText(electionType) || "Other";
}

function formatElectionLabel(group) {
  if (group.electionTypeKey === "primary" && group.partyName) {
    return `${group.year} ${group.partyName} Primary - ${group.officeName}`;
  }
  return `${group.year} ${group.electionType} Election - ${group.officeName}`;
}

function numericOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {string} countyName
 * @param {Array<{
 *   year?: number | string,
 *   electionType?: string,
 *   officeName?: string,
 *   candidateName?: string,
 *   partyName?: string | null,
 *   votes?: number | string,
 *   sortOrder?: number | string,
 * }>} rows
 */
export function buildCountyHistoricalResultsPayload(countyName, rows) {
  /** @type {Map<string, number>} */
  const registeredVotersByBucket = new Map();
  /** @type {Map<string, number>} */
  const totalVotesByBucket = new Map();
  /** @type {Map<string, {
   *   id: string,
   *   year: number,
   *   electionType: string,
   *   electionTypeKey: string,
   *   officeName: string,
   *   officeKey: string,
   *   partyName: string | null,
   *   partyKey: string,
   *   sortOrder: number,
   *   candidates: Array<{ candidateName: string, partyName: string | null, votes: number, sortOrder: number }>,
   * }>} */
  const groups = new Map();

  for (const row of rows) {
    const year = Number(row.year ?? 0);
    if (!Number.isFinite(year) || year <= 0) continue;

    const electionType = displayElectionType(row.electionType);
    const electionTypeKey = normalizeCountyHistoricalDimensionKey(electionType);
    const officeName = cleanText(row.officeName);
    const officeKey = normalizeCountyHistoricalDimensionKey(officeName);
    const candidateName = cleanText(row.candidateName);
    const partyName = cleanText(row.partyName) || null;
    const partyKey = normalizeCountyHistoricalDimensionKey(partyName);
    const votes = Number(row.votes ?? 0);
    const sortOrder = Number(row.sortOrder ?? 0);

    if (isCountyHistoricalRegisteredVoters(candidateName)) {
      registeredVotersByBucket.set(electionBucketKey(year, electionTypeKey), votes);
      continue;
    }

    if (isCountyHistoricalTotalVotes(candidateName)) {
      totalVotesByBucket.set(totalVotesKey(year, electionTypeKey, officeKey, partyKey), votes);
      continue;
    }

    if (!officeName || !candidateName) continue;

    const effectivePartyKey = electionTypeKey === "primary" ? partyKey : "";
    const effectivePartyName = electionTypeKey === "primary" ? partyName : null;
    const key = groupKey(year, electionTypeKey, officeKey, effectivePartyKey);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        id: key,
        year,
        electionType,
        electionTypeKey,
        officeName,
        officeKey,
        partyName: effectivePartyName,
        partyKey: effectivePartyKey,
        sortOrder,
        candidates: [{ candidateName, partyName, votes, sortOrder }],
      });
      continue;
    }

    existing.sortOrder = Math.min(existing.sortOrder, sortOrder);
    existing.candidates.push({ candidateName, partyName, votes, sortOrder });
  }

  /** @type {Array<{
   *   id: string,
   *   year: number,
   *   electionType: string,
   *   officeName: string,
   *   partyName: string | null,
   *   label: string,
   *   totalVotes: number | null,
   *   registeredVoters: number | null,
   *   turnoutPct: number | null,
   *   candidates: Array<{ candidateName: string, partyName: string | null, votes: number, votePct: number | null }>,
   *   sortOrder: number,
   * }>} */
  const allGroups = [];

  for (const group of groups.values()) {
    group.candidates.sort((a, b) => b.votes - a.votes || a.sortOrder - b.sortOrder || a.candidateName.localeCompare(b.candidateName));

    const explicitTotalVotes =
      totalVotesByBucket.get(totalVotesKey(group.year, group.electionTypeKey, group.officeKey, group.partyKey)) ??
      totalVotesByBucket.get(totalVotesKey(group.year, group.electionTypeKey, "", group.partyKey));
    const sumVotes = group.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
    const totalVotes = numericOrNull(explicitTotalVotes ?? sumVotes);
    const registeredVoters = numericOrNull(
      registeredVotersByBucket.get(electionBucketKey(group.year, group.electionTypeKey)) ?? null,
    );
    const turnoutPct =
      totalVotes != null && registeredVoters != null && registeredVoters > 0 ? (totalVotes / registeredVoters) * 100 : null;

    allGroups.push({
      id: group.id,
      year: group.year,
      electionType: group.electionType,
      officeName: group.officeName,
      partyName: group.partyName,
      label: formatElectionLabel(group),
      totalVotes,
      registeredVoters,
      turnoutPct,
      sortOrder: group.sortOrder,
      candidates: group.candidates.map((candidate) => ({
        candidateName: candidate.candidateName,
        partyName: candidate.partyName,
        votes: candidate.votes,
        votePct: totalVotes != null && totalVotes > 0 ? (candidate.votes / totalVotes) * 100 : null,
      })),
    });
  }

  allGroups.sort(
    (a, b) =>
      b.year - a.year ||
      a.sortOrder - b.sortOrder ||
      a.officeName.localeCompare(b.officeName) ||
      String(a.partyName ?? "").localeCompare(String(b.partyName ?? "")),
  );

  return {
    countyName: cleanText(countyName),
    generalElections: allGroups.filter((group) => normalizeCountyHistoricalDimensionKey(group.electionType) === "general"),
    primaryElections: allGroups.filter((group) => normalizeCountyHistoricalDimensionKey(group.electionType) === "primary"),
  };
}

/**
 * Aggregate office history across all counties that share one normalized office key.
 *
 * @param {string} officeName
 * @param {Array<{
 *   year?: number | string,
 *   electionType?: string,
 *   officeName?: string,
 *   candidateName?: string,
 *   partyName?: string | null,
 *   votes?: number | string,
 *   sortOrder?: number | string,
 * }>} rows
 */
export function buildOfficeHistoricalResultsPayload(officeName, rows) {
  /** @type {Map<string, number>} */
  const registeredVotersByBucket = new Map();
  /** @type {Map<string, number>} */
  const totalVotesByBucket = new Map();
  /** @type {Map<string, {
   *   id: string,
   *   year: number,
   *   electionType: string,
   *   electionTypeKey: string,
   *   officeName: string,
   *   officeKey: string,
   *   partyName: string | null,
   *   partyKey: string,
   *   sortOrder: number,
   *   candidates: Map<string, { candidateName: string, partyName: string | null, votes: number, sortOrder: number }>,
   * }>} */
  const groups = new Map();

  for (const row of rows) {
    const year = Number(row.year ?? 0);
    if (!Number.isFinite(year) || year <= 0) continue;

    const electionType = displayElectionType(row.electionType);
    const electionTypeKey = normalizeCountyHistoricalDimensionKey(electionType);
    const normalizedOfficeName = cleanText(row.officeName);
    const officeKey = normalizeCountyHistoricalDimensionKey(normalizedOfficeName);
    const candidateName = cleanText(row.candidateName);
    const partyName = cleanText(row.partyName) || null;
    const partyKey = normalizeCountyHistoricalDimensionKey(partyName);
    const votes = Number(row.votes ?? 0);
    const sortOrder = Number(row.sortOrder ?? 0);

    if (isCountyHistoricalRegisteredVoters(candidateName)) {
      registeredVotersByBucket.set(
        electionBucketKey(year, electionTypeKey),
        (registeredVotersByBucket.get(electionBucketKey(year, electionTypeKey)) ?? 0) + votes,
      );
      continue;
    }

    if (isCountyHistoricalTotalVotes(candidateName)) {
      const key = totalVotesKey(year, electionTypeKey, officeKey, partyKey);
      totalVotesByBucket.set(key, (totalVotesByBucket.get(key) ?? 0) + votes);
      continue;
    }

    if (!normalizedOfficeName || !candidateName) continue;

    const effectivePartyKey = electionTypeKey === "primary" ? partyKey : "";
    const effectivePartyName = electionTypeKey === "primary" ? partyName : null;
    const key = groupKey(year, electionTypeKey, officeKey, effectivePartyKey);
    const candidateKey = `${candidateName}|${partyName ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        year,
        electionType,
        electionTypeKey,
        officeName: normalizedOfficeName,
        officeKey,
        partyName: effectivePartyName,
        partyKey: effectivePartyKey,
        sortOrder,
        candidates: new Map(),
      };
      groups.set(key, group);
    } else {
      group.sortOrder = Math.min(group.sortOrder, sortOrder);
    }

    const existingCandidate = group.candidates.get(candidateKey);
    if (!existingCandidate) {
      group.candidates.set(candidateKey, { candidateName, partyName, votes, sortOrder });
    } else {
      existingCandidate.votes += votes;
      existingCandidate.sortOrder = Math.min(existingCandidate.sortOrder, sortOrder);
    }
  }

  const allGroups = [];

  for (const group of groups.values()) {
    const candidates = [...group.candidates.values()].sort(
      (a, b) => b.votes - a.votes || a.sortOrder - b.sortOrder || a.candidateName.localeCompare(b.candidateName),
    );

    const explicitTotalVotes =
      totalVotesByBucket.get(totalVotesKey(group.year, group.electionTypeKey, group.officeKey, group.partyKey)) ??
      totalVotesByBucket.get(totalVotesKey(group.year, group.electionTypeKey, "", group.partyKey));
    const sumVotes = candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
    const totalVotes = numericOrNull(explicitTotalVotes ?? sumVotes);
    const registeredVoters = numericOrNull(
      registeredVotersByBucket.get(electionBucketKey(group.year, group.electionTypeKey)) ?? null,
    );
    const turnoutPct =
      totalVotes != null && registeredVoters != null && registeredVoters > 0 ? (totalVotes / registeredVoters) * 100 : null;

    allGroups.push({
      id: group.id,
      year: group.year,
      electionType: group.electionType,
      officeName: group.officeName,
      partyName: group.partyName,
      label: formatElectionLabel(group),
      totalVotes,
      registeredVoters,
      turnoutPct,
      sortOrder: group.sortOrder,
      candidates: candidates.map((candidate) => ({
        candidateName: candidate.candidateName,
        partyName: candidate.partyName,
        votes: candidate.votes,
        votePct: totalVotes != null && totalVotes > 0 ? (candidate.votes / totalVotes) * 100 : null,
      })),
    });
  }

  allGroups.sort(
    (a, b) =>
      b.year - a.year ||
      a.sortOrder - b.sortOrder ||
      a.officeName.localeCompare(b.officeName) ||
      String(a.partyName ?? "").localeCompare(String(b.partyName ?? "")),
  );

  return {
    officeName: cleanText(officeName),
    generalElections: allGroups.filter((group) => normalizeCountyHistoricalDimensionKey(group.electionType) === "general"),
    primaryElections: allGroups.filter((group) => normalizeCountyHistoricalDimensionKey(group.electionType) === "primary"),
  };
}
