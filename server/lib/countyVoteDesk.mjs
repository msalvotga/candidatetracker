import {
  buildCivixNameToCountyKeyMap,
  getLatestCountyRows,
  getLatestSosCountyRows,
  listCountySosCandidateLinks,
  listCountySosManualVotes,
  listCountySosRaceLinks,
  listCountySosRaceVoteSources,
  listVoteHistoryForRace,
} from "../db.mjs";
import { rowMatchesLinkedContests, suggestSosCandidateForCountyRow } from "./countySosRaceMatch.mjs";
import { civixCountyNameToKey } from "./texasCountyKeys.mjs";
import { resolveVoteSource } from "./voteSource.mjs";

export function isGovernorRaceName(name) {
  const n = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /\bgovernor\b/.test(n) && !n.includes("lieutenant");
}

export function pickDefaultSosRaceId(races) {
  const list = races ?? [];
  const gov = list.find((r) => isGovernorRaceName(r.N ?? r.name));
  if (gov) return String(gov.id ?? "");
  const statewide = list.find((r) => String(r.section ?? "") === "StateWide");
  return String((statewide ?? list[0])?.id ?? "");
}

function emptyNumbers() {
  return { earlyVotes: 0, electionDayVotes: 0, mailVotes: 0, totalVotes: 0 };
}

function addNumbers(bucket, row, { mailSeparate = false } = {}) {
  const early = Number(row.earlyVotes ?? 0);
  const day = Number(row.electionDayVotes ?? 0);
  const mail = mailSeparate ? Number(row.mailVotes ?? 0) : 0;
  const total = Number(row.totalVotes ?? 0) || early + day + mail;
  bucket.earlyVotes += early;
  bucket.electionDayVotes += day;
  bucket.mailVotes += mail;
  bucket.totalVotes += total;
}

function sumTotals(byCandidate) {
  let total = 0;
  for (const n of Object.values(byCandidate)) total += Number(n.totalVotes ?? 0);
  return total;
}

function resolveCountyKey(countyName, civixToCountyKey) {
  const upper = String(countyName ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+COUNTY$/i, "")
    .trim();
  if (!upper) return "";
  if (civixToCountyKey[upper]) return civixToCountyKey[upper];
  let key = civixCountyNameToKey(upper);
  if (key === "de_witt") key = "dewitt";
  return key;
}

function numbersForCandidate(map, candidateId) {
  return map[candidateId] ?? emptyNumbers();
}

function raceListFrom(races) {
  return (races ?? []).map((race) => ({
    id: String(race.id ?? ""),
    name: String(race.N ?? ""),
    section: String(race.section ?? ""),
  }));
}

function raceCandidates(race) {
  return (race?.Candidates ?? []).map((candidate) => ({
    id: String(candidate.ID ?? ""),
    name: String(candidate.N ?? ""),
    party: String(candidate.P ?? ""),
  }));
}

async function loadVoteDeskContext(electionId) {
  const id = String(electionId);
  const [byCivixName, sosRows, links, manualVotes, voteSources, candidateLinks, civixToCountyKey] = await Promise.all([
    getLatestCountyRows(id),
    getLatestSosCountyRows(id),
    listCountySosRaceLinks(id),
    listCountySosManualVotes(id),
    listCountySosRaceVoteSources(id),
    listCountySosCandidateLinks(id),
    buildCivixNameToCountyKeyMap(id),
  ]);
  return { byCivixName, sosRows, links, manualVotes, voteSources, candidateLinks, civixToCountyKey };
}

function assembleRaceCounties(ctx, race) {
  const raceId = String(race.id ?? "");
  const candidates = raceCandidates(race);
  const raceName = String(race.N ?? "");
  const raceLinks = ctx.links.filter((link) => link.sosRaceId === raceId);
  const linksByCounty = new Map();
  for (const link of raceLinks) {
    const list = linksByCounty.get(link.countyKey) ?? [];
    list.push(link.countyContestName);
    linksByCounty.set(link.countyKey, list);
  }

  const candidateLinkByChoice = new Map(
    ctx.candidateLinks
      .filter((link) => link.sosRaceId === raceId)
      .map((link) => [`${link.countyKey}|${String(link.countyChoiceName ?? "").trim()}`, link.sosCandidateId]),
  );

  /** @type {Map<string, Record<string, ReturnType<typeof emptyNumbers>>>} */
  const feedByCounty = new Map();
  for (const [civixName, rows] of Object.entries(ctx.byCivixName)) {
    const countyKey = ctx.civixToCountyKey[civixName] ?? resolveCountyKey(civixName, ctx.civixToCountyKey);
    if (!countyKey) continue;
    const contestNames = linksByCounty.get(countyKey) ?? [];
    for (const row of rows ?? []) {
      const contestName = String(row.contestName ?? "");
      const linked = contestNames.length > 0 && rowMatchesLinkedContests(row, contestNames);
      const nameMatch = isGovernorRaceName(raceName)
        ? isGovernorRaceName(contestName)
        : contestName.trim().toLowerCase() === raceName.trim().toLowerCase();
      if (!linked && !nameMatch) continue;
      const choice = String(row.choiceName ?? "").trim();
      const linkedId = candidateLinkByChoice.get(`${countyKey}|${choice}`);
      const target = linkedId
        ? candidates.find((candidate) => candidate.id === String(linkedId))
        : suggestSosCandidateForCountyRow(race.Candidates ?? [], row);
      const candidateId = linkedId || (target?.ID != null ? String(target.ID) : "");
      if (!candidateId) continue;
      const bucket = feedByCounty.get(countyKey) ?? {};
      bucket[candidateId] = bucket[candidateId] ?? emptyNumbers();
      addNumbers(bucket[candidateId], row);
      feedByCounty.set(countyKey, bucket);
    }
  }

  /** @type {Map<string, Record<string, ReturnType<typeof emptyNumbers>>>} */
  const sosByCounty = new Map();
  for (const row of ctx.sosRows ?? []) {
    const contestName = String(row.contestName ?? "");
    const nameMatch = isGovernorRaceName(raceName)
      ? isGovernorRaceName(contestName)
      : contestName.trim().toLowerCase() === raceName.trim().toLowerCase();
    if (!nameMatch) continue;
    const countyKey = resolveCountyKey(row.countyName, ctx.civixToCountyKey);
    if (!countyKey) continue;
    const target = suggestSosCandidateForCountyRow(race.Candidates ?? [], row);
    const candidateId = target?.ID != null ? String(target.ID) : "";
    if (!candidateId) continue;
    const bucket = sosByCounty.get(countyKey) ?? {};
    bucket[candidateId] = bucket[candidateId] ?? emptyNumbers();
    addNumbers(bucket[candidateId], row);
    sosByCounty.set(countyKey, bucket);
  }

  /** @type {Map<string, Record<string, ReturnType<typeof emptyNumbers>>>} */
  const manualByCounty = new Map();
  for (const manual of ctx.manualVotes) {
    if (manual.sosRaceId !== raceId) continue;
    const bucket = manualByCounty.get(manual.countyKey) ?? {};
    bucket[manual.sosCandidateId] = {
      earlyVotes: Number(manual.earlyVotes ?? 0),
      electionDayVotes: Number(manual.electionDayVotes ?? 0),
      mailVotes: Number(manual.mailVotes ?? 0),
      totalVotes:
        Number(manual.totalVotes ?? 0) ||
        Number(manual.earlyVotes ?? 0) + Number(manual.electionDayVotes ?? 0) + Number(manual.mailVotes ?? 0),
    };
    manualByCounty.set(manual.countyKey, bucket);
  }

  const sourceByCounty = new Map(
    ctx.voteSources.filter((source) => source.sosRaceId === raceId).map((source) => [source.countyKey, source.voteSource]),
  );

  const countyKeys = new Set([
    ...feedByCounty.keys(),
    ...sosByCounty.keys(),
    ...manualByCounty.keys(),
    ...sourceByCounty.keys(),
    ...linksByCounty.keys(),
  ]);

  return [...countyKeys].map((countyKey) => {
    const feed = feedByCounty.get(countyKey) ?? {};
    const sos = sosByCounty.get(countyKey) ?? {};
    const manual = manualByCounty.get(countyKey) ?? {};
    const hasManual = Object.keys(manual).length > 0;
    const configured = sourceByCounty.get(countyKey) ?? "auto";
    const pack = (map) =>
      candidates.map((candidate) => ({
        sosCandidateId: candidate.id,
        ...numbersForCandidate(map, candidate.id),
      }));
    const origin = resolveVoteSource(configured, sumTotals(feed), sumTotals(sos), sumTotals(manual), hasManual);
    const active = origin === "manual" ? manual : origin === "county_feed" ? feed : origin === "sos" ? sos : {};
    return {
      countyKey,
      voteSource: configured === "auto" ? "auto" : configured,
      origin,
      linked: linksByCounty.has(countyKey),
      sos: pack(sos),
      countyFeed: pack(feed),
      manual: pack(manual),
      candidates: pack(active),
    };
  });
}

/**
 * Admin vote desk for one SOS race: county-site numbers, SOS numbers, and manual overrides.
 * @param {string} electionId
 * @param {string} sosRaceId
 * @param {Array<{ id: string|number, N?: string, Candidates?: unknown[], section?: string }>} sosRaces
 */
export async function buildCountyVoteDesk(electionId, sosRaceId, sosRaces) {
  const races = sosRaces ?? [];
  const requested = String(sosRaceId ?? "").trim();
  const raceId = requested || pickDefaultSosRaceId(races);
  const race = races.find((item) => String(item.id ?? "") === raceId) ?? null;
  const raceList = raceListFrom(races);

  if (!race) {
    return {
      race: null,
      races: raceList,
      counties: [],
      history: [],
    };
  }

  const raceName = String(race.N ?? "");
  const [ctx, history] = await Promise.all([
    loadVoteDeskContext(electionId),
    listVoteHistoryForRace(String(electionId), {
      sosRaceId: raceId,
      raceName,
      isGovernor: isGovernorRaceName(raceName),
      limit: 200,
    }),
  ]);

  return {
    race: {
      id: raceId,
      name: raceName,
      section: String(race.section ?? ""),
      candidates: raceCandidates(race),
    },
    races: raceList,
    counties: assembleRaceCounties(ctx, race),
    history,
  };
}

/**
 * Every SOS race for one county, with SOS, county-pull, and manual numbers.
 * @param {string} electionId
 * @param {string} countyKey
 * @param {Array<{ id: string|number, N?: string, Candidates?: unknown[], section?: string }>} sosRaces
 */
export async function buildCountyAllRaces(electionId, countyKey, sosRaces) {
  const key = String(countyKey ?? "").trim().toLowerCase();
  const ctx = await loadVoteDeskContext(electionId);
  const races = (sosRaces ?? []).map((race) => {
    const candidates = raceCandidates(race);
    const emptyPack = candidates.map((candidate) => ({ sosCandidateId: candidate.id, ...emptyNumbers() }));
    const hit = assembleRaceCounties(ctx, race).find((county) => county.countyKey === key);
    return {
      id: String(race.id ?? ""),
      name: String(race.N ?? ""),
      section: String(race.section ?? ""),
      candidates,
      voteSource: hit?.voteSource ?? "auto",
      origin: hit?.origin ?? "empty",
      sos: hit?.sos ?? emptyPack,
      countyFeed: hit?.countyFeed ?? emptyPack,
      manual: hit?.manual ?? emptyPack,
    };
  });
  return { countyKey: key, races };
}
