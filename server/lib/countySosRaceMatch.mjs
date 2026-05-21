/**
 * Match county feed contest/candidate labels to Texas SOS (Civix) races.
 */

export function normalizeContestName(name) {
  return String(name ?? "")
    .toUpperCase()
    .replace(/\s*-\s*(DEMOCRATIC|REPUBLICAN)\s+PARTY\s*$/i, "")
    .replace(/\s*\((DEM|REP|LIB|IND|GRN)\)\s*/gi, " ")
    .replace(/U\.S\./g, "US ")
    .replace(/UNITED STATES/g, "US")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contestTokens(norm) {
  return norm.split(" ").filter((t) => t.length > 1);
}

function tokenOverlapScore(a, b) {
  const ta = new Set(contestTokens(a));
  const tb = new Set(contestTokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) {
    if (tb.has(t)) hit += 1;
  }
  return hit / Math.max(ta.size, tb.size);
}

/**
 * @param {Array<{ id: string|number, N?: string }>} sosRaces
 * @param {string} countyContestName
 * @returns {{ race: object, score: number } | null}
 */
export function suggestSosRaceForCountyContest(sosRaces, countyContestName) {
  const norm = normalizeContestName(countyContestName);
  if (!norm) return null;

  let best = null;
  let bestScore = 0;
  for (const race of sosRaces ?? []) {
    const sosNorm = normalizeContestName(race?.N);
    if (!sosNorm) continue;
    let score = 0;
    if (norm === sosNorm) score = 1;
    else if (norm.includes(sosNorm) || sosNorm.includes(norm)) score = 0.92;
    else score = tokenOverlapScore(norm, sosNorm);
    if (score > bestScore) {
      bestScore = score;
      best = race;
    }
  }
  if (!best || bestScore < 0.55) return null;
  return { race: best, score: bestScore };
}

export function normalizePersonName(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {Array<{ ID?: number, N?: string, P?: string }>} sosCandidates
 * @param {{ choiceName?: string, partyName?: string }} countyRow
 */
export function suggestSosCandidateForCountyRow(sosCandidates, countyRow) {
  const rowParty = String(countyRow?.partyName ?? "").toUpperCase();
  const rowName = normalizePersonName(countyRow?.choiceName);
  if (!Array.isArray(sosCandidates) || !sosCandidates.length) return null;

  const byNameAndParty = sosCandidates.find((c) => {
    const cName = normalizePersonName(c?.N);
    const cParty = String(c?.P ?? "").toUpperCase();
    return cParty === rowParty && (cName === rowName || cName.includes(rowName) || rowName.includes(cName));
  });
  if (byNameAndParty) return byNameAndParty;

  const byNameOnly = sosCandidates.find((c) => {
    const cName = normalizePersonName(c?.N);
    return cName === rowName || cName.includes(rowName) || rowName.includes(cName);
  });
  if (byNameOnly) return byNameOnly;

  const byParty = sosCandidates.filter((c) => String(c?.P ?? "").toUpperCase() === rowParty);
  if (byParty.length === 1) return byParty[0];

  return null;
}

export function isSd4SosRaceName(raceName) {
  const text = String(raceName ?? "").toUpperCase();
  return (
    /STATE\s+SENAT(?:E|OR)/i.test(text) &&
    /DISTRICT\s*(?:NO\.?\s*)?\s*#?\s*4\b/i.test(text)
  );
}

export function isSd4CountyContestName(contestName) {
  const text = String(contestName ?? "").toUpperCase();
  return (
    /STATE\s+SENAT(?:E|OR)/i.test(text) &&
    /DISTRICT\s*(?:NO\.?\s*)?\s*#?\s*4\b/i.test(text)
  );
}
