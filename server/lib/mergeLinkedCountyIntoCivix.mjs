import { decodeUploadPayload, encodeBase64Json } from "./b64.mjs";
import {
  CIVIX_RACE_SECTION_KEYS,
  decodeCivixRaceSections,
  encodeCivixRaceSections,
} from "./civixSosRaces.mjs";
import {
  buildCivixNameToCountyKeyMap,
  getLatestCountyRows,
  listCountySosCandidateLinks,
  listCountySosManualVotes,
  listCountySosRaceLinks,
  listCountySosRaceVoteSources,
} from "../db.mjs";
import {
  isSd4SosRaceName,
  normalizePersonNameForMatch,
  rowMatchesLinkedContests,
  suggestSosCandidateForCountyRow,
} from "./countySosRaceMatch.mjs";
import { resolveVoteSource } from "./voteSource.mjs";

function findTargetRaceCandidateFromRow(raceCandidates, row, countyKey, raceId, candidateLinkByKey) {
  const choice = String(row.choiceName ?? "").trim();
  const manualId = candidateLinkByKey?.get(`${countyKey}|${raceId}|${choice}`);
  if (manualId) {
    return raceCandidates.find((c) => String(c.ID) === String(manualId)) ?? null;
  }
  return suggestSosCandidateForCountyRow(raceCandidates, row) ?? null;
}

function findCountyCellForRaceCandidate(rr, targetCandidate) {
  if (!rr?.C || !targetCandidate) return null;
  const exact = rr.C[String(targetCandidate.ID)];
  if (exact) return exact;
  const entries = Object.values(rr.C);
  const wantedName = normalizePersonNameForMatch(targetCandidate.N);
  const wantedParty = String(targetCandidate.P ?? "").toUpperCase();
  const byNameParty = entries.find((c) => {
    const candName = normalizePersonNameForMatch(c?.N);
    const candParty = String(c?.P ?? "").toUpperCase();
    return (
      candParty === wantedParty &&
      (candName === wantedName || candName.includes(wantedName) || wantedName.includes(candName))
    );
  });
  if (byNameParty) return byNameParty;
  return null;
}

function createDefaultCountyCellFromCandidate(candidate, order) {
  return {
    id: Number(candidate?.ID ?? 0),
    N: String(candidate?.N ?? ""),
    P: String(candidate?.P ?? ""),
    V: 0,
    PE: 0,
    C: String(candidate?.C ?? ""),
    O: Number(candidate?.O ?? order ?? 0),
    EV: 0,
    LN: String(candidate?.LN ?? ""),
    FN: String(candidate?.FN ?? ""),
    ED: 0,
  };
}

/** @param {Iterable<string>} contestNames */
function sumCountyFeedVotesForRace(countyRows, contestNames) {
  let total = 0;
  for (const row of countyRows ?? []) {
    if (!rowMatchesLinkedContests(row, contestNames)) continue;
    const tv = Number(row.totalVotes ?? 0);
    const ev = Number(row.earlyVotes ?? 0);
    const ed = Number(row.electionDayVotes ?? 0);
    total += tv > 0 ? tv : ev + ed;
  }
  return total;
}

function sumSosCountyRaceVotes(raceBlock, raceCandidates) {
  if (!raceBlock?.C) return 0;
  let total = 0;
  for (const c of raceCandidates ?? []) {
    const cell = findCountyCellForRaceCandidate(raceBlock, c);
    if (cell) total += Number(cell.V ?? 0);
  }
  return total;
}

function sumManualVotes(list) {
  let total = 0;
  for (const m of list ?? []) {
    const early = Number(m.earlyVotes ?? 0);
    const day = Number(m.electionDayVotes ?? 0);
    const mail = Number(m.mailVotes ?? 0);
    const summed = early + day + mail;
    total += Math.max(Number(m.totalVotes ?? 0), summed);
  }
  return total;
}

function applyVoteRowToCell(cell, row, forceCounty) {
  const nextTotal = Number(row.totalVotes ?? 0);
  const nextEarly = Number(row.earlyVotes ?? 0);
  const nextEd = Number(row.electionDayVotes ?? 0);
  if (forceCounty) {
    cell.V = nextTotal > 0 ? nextTotal : nextEarly + nextEd;
    cell.EV = nextEarly;
    cell.ED = nextEd;
    return;
  }
  const currentTotal = Number(cell.V ?? 0);
  const currentEarly = Number(cell.EV ?? 0);
  const currentEd = Number(cell.ED ?? Math.max(currentTotal - currentEarly, 0));
  const mergedTotal = Math.max(currentTotal, nextTotal, nextEarly + nextEd);
  const mergedEarly = Math.max(currentEarly, nextEarly);
  const mergedEd = Math.max(currentEd, nextEd, mergedTotal - mergedEarly);
  cell.V = mergedTotal;
  cell.EV = mergedEarly;
  cell.ED = mergedEd;
}

/**
 * Apply county feed rows and manual overrides for SOS races linked in county_sos_race_links (non-SD4 auto path).
 * SD4 continues to use mergeSd4CountyOverridesIntoCivix in createApiApp.mjs.
 */
export async function mergeLinkedCountyOverridesIntoCivix(electionId, electionPayload, countyDoc) {
  const hasRaceSection = CIVIX_RACE_SECTION_KEYS.some((k) => electionPayload?.[k]);
  if (!hasRaceSection || !countyDoc?.upload) return { electionPayload, countyDoc };

  const links = await listCountySosRaceLinks(String(electionId));
  if (!links.length) return { electionPayload, countyDoc };

  const [manualVotes, voteSources, byCivixName, civixToCountyKey, candidateLinks] = await Promise.all([
    listCountySosManualVotes(String(electionId)),
    listCountySosRaceVoteSources(String(electionId)),
    getLatestCountyRows(String(electionId)),
    buildCivixNameToCountyKeyMap(String(electionId)),
    listCountySosCandidateLinks(String(electionId)),
  ]);

  const candidateLinkByKey = new Map(
    candidateLinks.map((cl) => [
      `${cl.countyKey}|${cl.sosRaceId}|${String(cl.countyChoiceName ?? "").trim()}`,
      cl.sosCandidateId,
    ]),
  );

  const sourceKey = (countyKey, sosRaceId) => `${countyKey}|${sosRaceId}`;
  const sourceMap = new Map(voteSources.map((s) => [sourceKey(s.countyKey, s.sosRaceId), s.voteSource]));

  const manualByCountyRace = new Map();
  for (const m of manualVotes) {
    const k = `${m.countyKey}|${m.sosRaceId}`;
    const list = manualByCountyRace.get(k) ?? [];
    list.push(m);
    manualByCountyRace.set(k, list);
  }

  const linksBySosRace = new Map();
  for (const l of links) {
    const list = linksBySosRace.get(l.sosRaceId) ?? [];
    list.push(l);
    linksBySosRace.set(l.sosRaceId, list);
  }

  const decodedSections = decodeCivixRaceSections(electionPayload);
  const countyRoot = decodeUploadPayload(countyDoc);
  const races = [];
  for (const sectionKey of CIVIX_RACE_SECTION_KEYS) {
    const section = decodedSections[sectionKey];
    for (const race of section?.Races ?? []) {
      races.push({ sectionKey, race });
    }
  }

  for (const { race } of races) {
    const raceId = String(race.id ?? "");
    const raceName = String(race.N ?? "");
    if (!raceId || !Array.isArray(race.Candidates) || !race.Candidates.length) continue;
    if (isSd4SosRaceName(raceName)) continue;

    const raceLinks = linksBySosRace.get(raceId) ?? [];
    const hasManualForRace = manualVotes.some((m) => m.sosRaceId === raceId);
    if (!raceLinks.length && !hasManualForRace) continue;

    let appliedOverride = false;
    for (const block of Object.values(countyRoot)) {
      const civixName = String(block?.N ?? "").toUpperCase();
      const countyKey = civixToCountyKey[civixName] ?? "";
      if (!countyKey) continue;

      const countyRows = byCivixName[civixName] ?? [];
      const contestNames = raceLinks.filter((l) => l.countyKey === countyKey).map((l) => l.countyContestName);
      const existingRaceBlock = block.Races?.[raceId];
      const configuredSource = sourceMap.get(sourceKey(countyKey, raceId));
      const manualList = manualByCountyRace.get(`${countyKey}|${raceId}`) ?? [];
      const voteSource = resolveVoteSource(
        configuredSource,
        sumCountyFeedVotesForRace(countyRows, contestNames),
        sumSosCountyRaceVotes(existingRaceBlock, race.Candidates),
        sumManualVotes(manualList),
        manualList.length > 0,
      );
      if (voteSource === "sos" || voteSource === "empty") continue;
      appliedOverride = true;

      block.Races = block.Races ?? {};
      if (!block.Races[raceId]) block.Races[raceId] = { C: {} };
      const raceBlock = block.Races[raceId];
      raceBlock.C = raceBlock.C ?? {};

      const normalizedCells = {};
      for (let idx = 0; idx < race.Candidates.length; idx++) {
        const rc = race.Candidates[idx];
        normalizedCells[String(rc.ID)] = createDefaultCountyCellFromCandidate(rc, idx + 1);
      }
      raceBlock.C = normalizedCells;

      if (voteSource === "manual") {
        for (const m of manualList) {
          const target = race.Candidates.find((c) => String(c.ID) === String(m.sosCandidateId));
          if (!target) continue;
          const cell = raceBlock.C[String(target.ID)];
          if (!cell) continue;
          const early = Number(m.earlyVotes ?? 0);
          const day = Number(m.electionDayVotes ?? 0);
          const mail = Number(m.mailVotes ?? 0);
          const summed = early + day + mail;
          applyVoteRowToCell(
            cell,
            {
              totalVotes: Math.max(Number(m.totalVotes ?? 0), summed),
              earlyVotes: early + mail,
              electionDayVotes: day,
            },
            true,
          );
          if (block?.Summary) block.Summary.SRC = "CNTY";
        }
      } else {
        for (const row of countyRows) {
          if (!rowMatchesLinkedContests(row, contestNames)) continue;
          const target = findTargetRaceCandidateFromRow(race.Candidates, row, countyKey, raceId, candidateLinkByKey);
          if (!target) continue;
          const cell = raceBlock.C[String(target.ID)];
          if (!cell) continue;
          applyVoteRowToCell(cell, row, true);
          if (block?.Summary) block.Summary.SRC = "CNTY";
        }
      }
    }

    if (!raceLinks.length && !appliedOverride) continue;

    let total = 0;
    let early = 0;
    let electionDay = 0;
    for (const block of Object.values(countyRoot)) {
      const rr = block?.Races?.[raceId];
      if (!rr?.C) continue;
      for (const c of race.Candidates) {
        const cell = findCountyCellForRaceCandidate(rr, c);
        if (!cell) continue;
        total += Number(cell.V ?? 0);
        early += Number(cell.EV ?? 0);
        electionDay += Number(cell.ED ?? Math.max(Number(cell.V ?? 0) - Number(cell.EV ?? 0), 0));
      }
    }
    for (const c of race.Candidates) {
      let cTotal = 0;
      let cEarly = 0;
      let cEd = 0;
      for (const block of Object.values(countyRoot)) {
        const rr = block?.Races?.[raceId];
        const cell = findCountyCellForRaceCandidate(rr, c);
        if (!cell) continue;
        cTotal += Number(cell.V ?? 0);
        cEarly += Number(cell.EV ?? 0);
        cEd += Number(cell.ED ?? Math.max(Number(cell.V ?? 0) - Number(cell.EV ?? 0), 0));
      }
      const usesCountyForCounty = (ck) => {
        const cfg = sourceMap.get(sourceKey(ck, raceId));
        const civixLabel = Object.entries(civixToCountyKey).find(([, v]) => v === ck)?.[0] ?? "";
        const rows = civixLabel ? (byCivixName[civixLabel] ?? []) : [];
        const names = raceLinks.filter((l) => l.countyKey === ck).map((l) => l.countyContestName);
        const blockForCounty = Object.values(countyRoot).find(
          (b) => (civixToCountyKey[String(b?.N ?? "").toUpperCase()] ?? "") === ck,
        );
        const manualForCounty = manualByCountyRace.get(`${ck}|${raceId}`) ?? [];
        const chosen = resolveVoteSource(
          cfg,
          sumCountyFeedVotesForRace(rows, names),
          sumSosCountyRaceVotes(blockForCounty?.Races?.[raceId], race.Candidates),
          sumManualVotes(manualForCounty),
          manualForCounty.length > 0,
        );
        return chosen !== "sos" && chosen !== "empty";
      };
      const countiesToCheck = new Set(raceLinks.map((l) => l.countyKey));
      for (const m of manualVotes) {
        if (m.sosRaceId === raceId) countiesToCheck.add(m.countyKey);
      }
      if (cTotal > 0 || [...countiesToCheck].some((ck) => usesCountyForCounty(ck))) {
        c.V = cTotal;
        c.EV = cEarly;
        c.ED = cEd;
      }
    }
    race.T = race.Candidates.reduce((n, c) => n + Number(c.V ?? 0), 0);
  }

  return {
    electionPayload: encodeCivixRaceSections(electionPayload, decodedSections),
    countyDoc: { ...countyDoc, upload: encodeBase64Json(countyRoot) },
  };
}
