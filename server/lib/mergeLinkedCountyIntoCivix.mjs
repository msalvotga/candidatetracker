import { decodeUploadPayload, encodeBase64Json } from "./b64.mjs";
import {
  CIVIX_RACE_SECTION_KEYS,
  decodeCivixRaceSections,
  encodeCivixRaceSections,
} from "./civixSosRaces.mjs";
import {
  buildCivixNameToCountyKeyMap,
  getLatestCountyRows,
  listCountySosManualVotes,
  listCountySosRaceLinks,
  listCountySosRaceVoteSources,
} from "../db.mjs";
import { isSd4SosRaceName, suggestSosCandidateForCountyRow } from "./countySosRaceMatch.mjs";

function normalizePersonName(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findTargetRaceCandidateFromRow(raceCandidates, row) {
  const target = suggestSosCandidateForCountyRow(raceCandidates, row);
  return target ?? null;
}

function findCountyCellForRaceCandidate(rr, targetCandidate) {
  if (!rr?.C || !targetCandidate) return null;
  const exact = rr.C[String(targetCandidate.ID)];
  if (exact) return exact;
  const entries = Object.values(rr.C);
  const wantedName = normalizePersonName(targetCandidate.N);
  const wantedParty = String(targetCandidate.P ?? "").toUpperCase();
  const byNameParty = entries.find((c) => {
    const candName = normalizePersonName(c?.N);
    const candParty = String(c?.P ?? "").toUpperCase();
    return candName === wantedName && candParty === wantedParty;
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

  const [manualVotes, voteSources, byCivixName, civixToCountyKey] = await Promise.all([
    listCountySosManualVotes(String(electionId)),
    listCountySosRaceVoteSources(String(electionId)),
    getLatestCountyRows(String(electionId)),
    buildCivixNameToCountyKeyMap(String(electionId)),
  ]);

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
    if (!raceLinks.length) continue;

    for (const block of Object.values(countyRoot)) {
      const civixName = String(block?.N ?? "").toUpperCase();
      const countyKey = civixToCountyKey[civixName] ?? "";
      if (!countyKey) continue;

      const voteSource = sourceMap.get(sourceKey(countyKey, raceId)) ?? "county_feed";
      if (voteSource === "sos") continue;

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

      const countyRows = byCivixName[civixName] ?? [];
      const contestNames = new Set(
        raceLinks.filter((l) => l.countyKey === countyKey).map((l) => l.countyContestName),
      );

      if (voteSource === "manual") {
        const manualList = manualByCountyRace.get(`${countyKey}|${raceId}`) ?? [];
        for (const m of manualList) {
          const target = race.Candidates.find((c) => String(c.ID) === String(m.sosCandidateId));
          if (!target) continue;
          const cell = raceBlock.C[String(target.ID)];
          if (!cell) continue;
          applyVoteRowToCell(
            cell,
            {
              totalVotes: m.totalVotes,
              earlyVotes: m.earlyVotes,
              electionDayVotes: m.electionDayVotes,
            },
            true,
          );
          if (block?.Summary) block.Summary.SRC = "CNTY";
        }
      } else {
        for (const row of countyRows) {
          if (!contestNames.has(String(row.contestName ?? "").trim())) continue;
          const target = findTargetRaceCandidateFromRow(race.Candidates, row);
          if (!target) continue;
          const cell = raceBlock.C[String(target.ID)];
          if (!cell) continue;
          applyVoteRowToCell(cell, row, true);
          if (block?.Summary) block.Summary.SRC = "CNTY";
        }
      }
    }

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
      if (cTotal > 0 || voteSources.some((s) => s.sosRaceId === raceId && sourceMap.get(sourceKey(s.countyKey, raceId)) !== "sos")) {
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
