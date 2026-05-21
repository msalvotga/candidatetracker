/**
 * Match county feed contest/candidate labels to Texas SOS (Civix) races.
 * County feeds often prefix contests with REP/DEM (runoff PDFs) or suffix
 * "- Republican Party" (CivicPlus). SOS runoff elections may omit party on
 * the race title when the whole Civix election is party-specific.
 */

const PARTY_CODES = new Set(["REP", "DEM", "LIB", "IND", "GRN"]);

/** @typedef {'REP'|'DEM'|'LIB'|'IND'|'GRN'} PartyCode */

/**
 * @param {string} raw
 * @returns {PartyCode | null}
 */
export function extractContestParty(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;

  const suffix = s.match(/\s-\s*(Democratic|Republican|Libertarian|Green)\s+Party\s*$/i);
  if (suffix) {
    const word = suffix[1].toUpperCase();
    if (word.startsWith("REP")) return "REP";
    if (word.startsWith("DEM")) return "DEM";
    if (word.startsWith("LIB")) return "LIB";
    if (word.startsWith("GRN")) return "GRN";
  }

  const leadAbbrev = s.match(/^(REP|DEM|LIB|IND|GRN)\b/i);
  if (leadAbbrev) return /** @type {PartyCode} */ (leadAbbrev[1].toUpperCase());

  const leadWord = s.match(/^(REPUBLICAN|DEMOCRATIC|LIBERTARIAN|GREEN)\b/i);
  if (leadWord) {
    const w = leadWord[1].toUpperCase();
    if (w.startsWith("REP")) return "REP";
    if (w.startsWith("DEM")) return "DEM";
    if (w.startsWith("LIB")) return "LIB";
    if (w.startsWith("GRN")) return "GRN";
  }

  const paren = s.match(/\((REP|DEM|LIB|IND|GRN)\)/i);
  if (paren) return /** @type {PartyCode} */ (paren[1].toUpperCase());

  if (/\bREPUBLICAN\b/i.test(s) && !/\bDEMOCRATIC\b/i.test(s)) return "REP";
  if (/\bDEMOCRATIC\b/i.test(s) && !/\bREPUBLICAN\b/i.test(s)) return "DEM";

  return null;
}

/**
 * Office / contest title with party markers removed (for matching SOS race names).
 * @param {string} name
 */
export function normalizeOfficeName(name) {
  let s = String(name ?? "").trim();
  s = s.replace(/\s-\s*(Democratic|Republican|Libertarian|Green)\s+Party\s*$/i, "");
  s = s.replace(/\s*\((DEM|REP|LIB|IND|GRN)\)\s*/gi, " ");
  return String(s ?? "")
    .toUpperCase()
    .replace(/\bVOTE\s+FOR\s+\d+\b/gi, " ")
    .replace(/^(REP|DEM|LIB|IND|GRN)\s+/i, "")
    .replace(/^(REPUBLICAN|DEMOCRATIC|LIBERTARIAN|GREEN)\s+/i, "")
    .replace(/U\.S\./g, "US ")
    .replace(/UNITED STATES/g, "US")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @deprecated Use normalizeOfficeName — kept for imports that expect normalizeContestName */
export function normalizeContestName(name) {
  return normalizeOfficeName(name);
}

/**
 * @param {Array<{ P?: string }>} candidates
 * @returns {PartyCode | null}
 */
export function inferPartyFromCandidates(candidates) {
  const parties = new Set();
  for (const c of candidates ?? []) {
    const p = String(c?.P ?? "")
      .trim()
      .toUpperCase();
    if (p && PARTY_CODES.has(p)) parties.add(p);
  }
  if (parties.size === 1) return /** @type {PartyCode} */ ([...parties][0]);
  return null;
}

/**
 * @param {{ electionId?: string, label?: string }} cfg
 * @returns {PartyCode | null}
 */
export function inferElectionPartyFromConfig(cfg = {}) {
  const lab = String(cfg.label ?? "").toUpperCase();
  const hasRep = /\bREPUBLICAN\b/.test(lab);
  const hasDem = /\bDEMOCRATIC\b/.test(lab);
  if (hasRep && !hasDem) return "REP";
  if (hasDem && !hasRep) return "DEM";

  const id = String(cfg.electionId ?? "").trim();
  if (id === "58315") return "REP";
  if (id === "58314") return "DEM";

  return null;
}

/**
 * @param {PartyCode | null | undefined} countyParty
 * @param {PartyCode | null | undefined} sosParty
 * @param {PartyCode | null | undefined} electionParty
 */
export function partiesCompatible(countyParty, sosParty, electionParty) {
  if (countyParty && electionParty && countyParty !== electionParty) return false;
  const want = countyParty || electionParty || null;
  if (!want) return true;
  if (!sosParty) return true;
  return sosParty === want;
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

function officeMatchScore(officeNorm, sosOfficeNorm) {
  if (!officeNorm || !sosOfficeNorm) return 0;
  if (officeNorm === sosOfficeNorm) return 1;
  if (officeNorm.includes(sosOfficeNorm) || sosOfficeNorm.includes(officeNorm)) return 0.92;
  return tokenOverlapScore(officeNorm, sosOfficeNorm);
}

function partyScoreBoost(countyParty, sosParty, electionParty) {
  if (!countiesPartyApplies(countyParty, electionParty)) return 0;
  const want = countyParty || electionParty;
  if (!want) return 0;
  if (sosParty === want) return 0.08;
  if (!sosParty) return 0.03;
  return 0;
}

function countiesPartyApplies(countyParty, electionParty) {
  return !!(countyParty || electionParty);
}

/**
 * @param {Array<{ id: string|number, N?: string, Candidates?: unknown[] }>} sosRaces
 * @param {string} countyContestName
 * @param {{ electionParty?: PartyCode | null, countyParty?: PartyCode | null }} [options]
 * @returns {{ race: object, score: number } | null}
 */
export function suggestSosRaceForCountyContest(sosRaces, countyContestName, options = {}) {
  const officeNorm = normalizeOfficeName(countyContestName);
  if (!officeNorm) return null;

  const countyParty =
    extractContestParty(countyContestName) || options.countyParty || null;
  const electionParty = options.electionParty || null;

  let best = null;
  let bestScore = 0;

  for (const race of sosRaces ?? []) {
    const sosName = String(race?.N ?? "");
    const sosParty =
      extractContestParty(sosName) || inferPartyFromCandidates(race?.Candidates) || null;

    if (!partiesCompatible(countyParty, sosParty, electionParty)) continue;

    const sosOfficeNorm = normalizeOfficeName(sosName);
    let score = officeMatchScore(officeNorm, sosOfficeNorm);
    if (score <= 0) continue;

    score = Math.min(1, score + partyScoreBoost(countyParty, sosParty, electionParty));

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
