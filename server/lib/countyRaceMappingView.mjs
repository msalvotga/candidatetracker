import {
  buildCivixNameToCountyKeyMap,
  getLatestCountyRows,
  listCountySosManualVotes,
  listCountySosRaceLinks,
  listCountySosRaceVoteSources,
} from "../db.mjs";
import { suggestSosRaceForCountyContest } from "./countySosRaceMatch.mjs";

/**
 * @param {string} electionId
 * @param {Array<{ id: string|number, N?: string, Candidates?: unknown[] }>} sosRaces
 */
export async function buildCountyRaceMappingView(electionId, sosRaces) {
  const [byCivixName, links, manualVotes, voteSources, civixToCountyKey] = await Promise.all([
    getLatestCountyRows(String(electionId)),
    listCountySosRaceLinks(String(electionId)),
    listCountySosManualVotes(String(electionId)),
    listCountySosRaceVoteSources(String(electionId)),
    buildCivixNameToCountyKeyMap(String(electionId)),
  ]);

  const linkKey = (countyKey, contest) => `${countyKey}\u0000${contest}`;
  const linkByContest = new Map();
  for (const l of links) {
    linkByContest.set(linkKey(l.countyKey, l.countyContestName), l);
  }

  const unlinked = [];
  const linkedCountyRows = [];

  for (const [civixName, rows] of Object.entries(byCivixName)) {
    const countyKey = civixToCountyKey[civixName] ?? civixName.toLowerCase().replace(/\s+county$/i, "").replace(/\s+/g, "");
    for (const row of rows ?? []) {
      const contestName = String(row.contestName ?? "").trim();
      if (!contestName) continue;
      const lk = linkKey(countyKey, contestName);
      const link = linkByContest.get(lk);
      const entry = {
        countyKey,
        civixCountyName: civixName,
        contestName,
        choiceName: String(row.choiceName ?? ""),
        partyName: String(row.partyName ?? ""),
        earlyVotes: Number(row.earlyVotes ?? 0),
        electionDayVotes: Number(row.electionDayVotes ?? 0),
        totalVotes: Number(row.totalVotes ?? 0),
        percentOfVotes: String(row.percentOfVotes ?? ""),
      };
      if (link) {
        linkedCountyRows.push({ ...entry, sosRaceId: link.sosRaceId, sosRaceName: link.sosRaceName, linkType: link.linkType });
      } else {
        const suggestion = suggestSosRaceForCountyContest(sosRaces, contestName);
        unlinked.push({
          ...entry,
          suggestedSosRaceId: suggestion?.race?.id != null ? String(suggestion.race.id) : "",
          suggestedSosRaceName: suggestion?.race?.N != null ? String(suggestion.race.N) : "",
          suggestedScore: suggestion?.score ?? 0,
        });
      }
    }
  }

  return {
    sosRaces: (sosRaces ?? []).map((r) => ({
      id: String(r.id ?? ""),
      name: String(r.N ?? ""),
      candidateCount: Array.isArray(r.Candidates) ? r.Candidates.length : 0,
      candidates: (r.Candidates ?? []).map((c) => ({
        id: String(c.ID ?? ""),
        name: String(c.N ?? ""),
        party: String(c.P ?? ""),
      })),
    })),
    links,
    manualVotes,
    voteSources,
    unlinked,
    linkedCountyRows,
    note:
      "County-only contests (not on the SOS ballot) stay in the unlinked list until you link them to an SOS race or ignore them. Linked contests honor the vote source: SOS, county feed, or manual entry.",
  };
}
