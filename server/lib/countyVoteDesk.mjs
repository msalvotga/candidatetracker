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

function resolveOrigin(configured, feedTotal, sosTotal, hasManual) {
  const cfg = String(configured ?? "auto").toLowerCase();
  if (cfg === "manual") return hasManual ? "manual" : sosTotal > 0 ? "sos" : feedTotal > 0 ? "county_feed" : "empty";
  if (cfg === "sos") return sosTotal > 0 ? "sos" : "empty";
  if (cfg === "county_feed") return feedTotal > 0 ? "county_feed" : sosTotal > 0 ? "sos" : "empty";
  if (feedTotal > sosTotal && feedTotal > 0) return "county_feed";
  if (sosTotal > 0) return "sos";
  if (feedTotal > 0) return "county_feed";
  return "empty";
}

function numbersForCandidate(map, candidateId) {
  return map[candidateId] ?? emptyNumbers();
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
  const race = races.find((r) => String(r.id ?? "") === raceId) ?? null;
  const raceList = races.map((r) => ({
    id: String(r.id ?? ""),
    name: String(r.N ?? ""),
    section: String(r.section ?? ""),
  }));

  if (!race) {
    return {
      race: null,
      races: raceList,
      counties: [],
      history: [],
    };
  }

  const candidates = (race.Candidates ?? []).map((c) => ({
    id: String(c.ID ?? ""),
    name: String(c.N ?? ""),
    party: String(c.P ?? ""),
  }));
  const raceName = String(race.N ?? "");

  const [byCivixName, sosRows, links, manualVotes, voteSources, candidateLinks, civixToCountyKey, history] =
    await Promise.all([
      getLatestCountyRows(String(electionId)),
      getLatestSosCountyRows(String(electionId)),
      listCountySosRaceLinks(String(electionId)),
      listCountySosManualVotes(String(electionId)),
      listCountySosRaceVoteSources(String(electionId)),
      listCountySosCandidateLinks(String(electionId), raceId),
      buildCivixNameToCountyKeyMap(String(electionId)),
      listVoteHistoryForRace(String(electionId), {
        sosRaceId: raceId,
        raceName,
        isGovernor: isGovernorRaceName(raceName),
        limit: 200,
      }),
    ]);

  const raceLinks = links.filter((l) => l.sosRaceId === raceId);
  const linksByCounty = new Map();
  for (const link of raceLinks) {
    const list = linksByCounty.get(link.countyKey) ?? [];
    list.push(link.countyContestName);
    linksByCounty.set(link.countyKey, list);
  }

  const candidateLinkByChoice = new Map(
    candidateLinks.map((cl) => [`${cl.countyKey}|${String(cl.countyChoiceName ?? "").trim()}`, cl.sosCandidateId]),
  );

  /** @type {Map<string, Record<string, ReturnType<typeof emptyNumbers>>>} */
  const feedByCounty = new Map();
  for (const [civixName, rows] of Object.entries(byCivixName)) {
    const countyKey = civixToCountyKey[civixName] ?? resolveCountyKey(civixName, civixToCountyKey);
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
        ? candidates.find((c) => c.id === String(linkedId))
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
  for (const row of sosRows ?? []) {
    const contestName = String(row.contestName ?? "");
    const nameMatch = isGovernorRaceName(raceName)
      ? isGovernorRaceName(contestName)
      : contestName.trim().toLowerCase() === raceName.trim().toLowerCase();
    if (!nameMatch) continue;
    const countyKey = resolveCountyKey(row.countyName, civixToCountyKey);
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
  for (const m of manualVotes) {
    if (m.sosRaceId !== raceId) continue;
    const bucket = manualByCounty.get(m.countyKey) ?? {};
    bucket[m.sosCandidateId] = {
      earlyVotes: Number(m.earlyVotes ?? 0),
      electionDayVotes: Number(m.electionDayVotes ?? 0),
      mailVotes: Number(m.mailVotes ?? 0),
      totalVotes: Number(m.totalVotes ?? 0) || Number(m.earlyVotes ?? 0) + Number(m.electionDayVotes ?? 0) + Number(m.mailVotes ?? 0),
    };
    manualByCounty.set(m.countyKey, bucket);
  }

  const sourceByCounty = new Map(voteSources.filter((s) => s.sosRaceId === raceId).map((s) => [s.countyKey, s.voteSource]));

  const countyKeys = new Set([
    ...feedByCounty.keys(),
    ...sosByCounty.keys(),
    ...manualByCounty.keys(),
    ...sourceByCounty.keys(),
    ...linksByCounty.keys(),
  ]);

  const counties = [...countyKeys].map((countyKey) => {
    const feed = feedByCounty.get(countyKey) ?? {};
    const sos = sosByCounty.get(countyKey) ?? {};
    const manual = manualByCounty.get(countyKey) ?? {};
    const hasManual = Object.keys(manual).length > 0;
    const configured = sourceByCounty.get(countyKey) ?? "auto";
    const origin = resolveOrigin(configured, sumTotals(feed), sumTotals(sos), hasManual);
    const active = origin === "manual" ? manual : origin === "county_feed" ? feed : origin === "sos" ? sos : {};
    return {
      countyKey,
      voteSource: configured === "auto" ? "auto" : configured,
      origin,
      linked: linksByCounty.has(countyKey),
      candidates: candidates.map((c) => ({
        sosCandidateId: c.id,
        ...numbersForCandidate(active, c.id),
      })),
    };
  });

  return {
    race: {
      id: raceId,
      name: raceName,
      section: String(race.section ?? ""),
      candidates,
    },
    races: raceList,
    counties,
    history,
  };
}
