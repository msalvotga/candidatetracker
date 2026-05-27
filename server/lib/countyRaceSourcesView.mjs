import {
  buildCivixNameToCountyKeyMap,
  getLatestCountyRows,
  listCountySosCandidateLinks,
  listCountySosRaceLinks,
} from "../db.mjs";
import { rowMatchesLinkedContests, suggestSosCandidateForCountyRow } from "./countySosRaceMatch.mjs";

/**
 * County feed rows + candidate match status for one linked SOS race.
 * @param {string} electionId
 * @param {string} sosRaceId
 * @param {Array<{ id: string|number, N?: string, Candidates?: unknown[] }>} sosRaces
 */
export async function buildCountyRaceSourcesView(electionId, sosRaceId, sosRaces) {
  const raceId = String(sosRaceId ?? "").trim();
  const race = (sosRaces ?? []).find((r) => String(r.id ?? "") === raceId);
  if (!race) {
    return { error: "SOS race not found", sosRaceId: raceId, rows: [], links: [] };
  }

  const raceCandidates = race.Candidates ?? [];
  const [byCivixName, links, candidateLinks, civixToCountyKey] = await Promise.all([
    getLatestCountyRows(String(electionId)),
    listCountySosRaceLinks(String(electionId)),
    listCountySosCandidateLinks(String(electionId), raceId),
    buildCivixNameToCountyKeyMap(String(electionId)),
  ]);

  const raceLinks = links.filter((l) => l.sosRaceId === raceId);
  const candidateLinkByKey = new Map(
    candidateLinks.map((cl) => [`${cl.countyKey}|${String(cl.countyChoiceName ?? "").trim()}`, cl]),
  );

  /** @type {Array<object>} */
  const rows = [];

  for (const link of raceLinks) {
    const countyKey = link.countyKey;
    const civixName =
      Object.entries(civixToCountyKey).find(([, v]) => v === countyKey)?.[0] ??
      countyKey.toUpperCase().replace(/_/g, " ");
    const countyRows = (byCivixName[civixName] ?? []).filter((r) =>
      rowMatchesLinkedContests(r, [link.countyContestName]),
    );

    if (!countyRows.length) {
      rows.push({
        countyKey,
        civixCountyName: civixName,
        countyContestName: link.countyContestName,
        countyChoiceName: "",
        partyName: "",
        earlyVotes: 0,
        electionDayVotes: 0,
        totalVotes: 0,
        percentOfVotes: "",
        suggestedSosCandidateId: "",
        suggestedSosCandidateName: "",
        linkedSosCandidateId: "",
        linkedSosCandidateName: "",
        matchStatus: "no_feed",
      });
      continue;
    }

    for (const row of countyRows) {
      const choiceName = String(row.choiceName ?? "").trim();
      const manual = candidateLinkByKey.get(`${countyKey}|${choiceName}`);
      const suggested = suggestSosCandidateForCountyRow(raceCandidates, row);
      const linkedId = manual?.sosCandidateId ?? "";
      const suggestedId = suggested?.ID != null ? String(suggested.ID) : "";
      let matchStatus = "unmatched";
      if (manual) matchStatus = "manual";
      else if (suggested) matchStatus = "auto";

      rows.push({
        countyKey,
        civixCountyName: civixName,
        countyContestName: String(row.contestName ?? link.countyContestName),
        countyChoiceName: choiceName,
        partyName: String(row.partyName ?? ""),
        earlyVotes: Number(row.earlyVotes ?? 0),
        electionDayVotes: Number(row.electionDayVotes ?? 0),
        totalVotes: Number(row.totalVotes ?? 0),
        percentOfVotes: String(row.percentOfVotes ?? ""),
        suggestedSosCandidateId: suggestedId,
        suggestedSosCandidateName: suggested?.N != null ? String(suggested.N) : "",
        linkedSosCandidateId: linkedId,
        linkedSosCandidateName: manual?.sosCandidateName ?? "",
        effectiveSosCandidateId: linkedId || suggestedId,
        effectiveSosCandidateName: manual?.sosCandidateName || (suggested?.N != null ? String(suggested.N) : ""),
        matchStatus,
      });
    }
  }

  rows.sort((a, b) => {
    const c = a.countyKey.localeCompare(b.countyKey);
    if (c !== 0) return c;
    return a.countyChoiceName.localeCompare(b.countyChoiceName);
  });

  const unmatchedCount = rows.filter((r) => r.matchStatus === "unmatched" && r.countyChoiceName).length;
  const noFeedCount = rows.filter((r) => r.matchStatus === "no_feed").length;

  return {
    sosRace: {
      id: raceId,
      name: String(race.N ?? ""),
      candidates: raceCandidates.map((c) => ({
        id: String(c.ID ?? ""),
        name: String(c.N ?? ""),
        party: String(c.P ?? ""),
      })),
    },
    links: raceLinks,
    rows,
    unmatchedCount,
    noFeedCount,
    note:
      raceLinks.length === 0
        ? "Link county contests to this SOS race under “County results → SOS races” first."
        : "Map county candidate names to SOS candidates when auto-match fails. Manual links apply on the next election refresh.",
  };
}
