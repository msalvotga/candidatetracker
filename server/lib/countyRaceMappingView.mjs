import {
  buildCivixNameToCountyKeyMap,
  getLatestCountyRows,
  listCountySosManualVotes,
  listCountySosRaceLinks,
  listCountySosRaceVoteSources,
} from "../db.mjs";
import {
  extractContestParty,
  inferElectionPartyFromConfig,
  suggestSosRaceForCountyContest,
} from "./countySosRaceMatch.mjs";

/**
 * @param {Array<{ partyName?: string }>} rows
 * @returns {import('./countySosRaceMatch.mjs').PartyCode | null}
 */
function dominantCountyPartyFromRows(rows) {
  const counts = /** @type {Record<string, number>} */ ({});
  for (const row of rows ?? []) {
    const p = String(row.partyName ?? "")
      .trim()
      .toUpperCase();
    if (!p || p === "—") continue;
    counts[p] = (counts[p] ?? 0) + 1;
  }
  let best = null;
  let n = 0;
  for (const [p, c] of Object.entries(counts)) {
    if (c > n) {
      best = p;
      n = c;
    }
  }
  return best === "REP" || best === "DEM" || best === "LIB" || best === "IND" || best === "GRN" ? best : null;
}

/**
 * @param {string} electionId
 * @param {Array<{ id: string|number, N?: string, Candidates?: unknown[] }>} sosRaces
 * @param {{ electionParty?: import('./countySosRaceMatch.mjs').PartyCode | null, electionLabel?: string }} [options]
 */
export async function buildCountyRaceMappingView(electionId, sosRaces, options = {}) {
  const electionParty =
    options.electionParty ??
    inferElectionPartyFromConfig({ electionId, label: options.electionLabel });
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
    const byContest = new Map();
    for (const row of rows ?? []) {
      const contestName = String(row.contestName ?? "").trim();
      if (!contestName) continue;
      const list = byContest.get(contestName) ?? [];
      list.push(row);
      byContest.set(contestName, list);
    }

    for (const [contestName, contestRows] of byContest) {
      const lk = linkKey(countyKey, contestName);
      const link = linkByContest.get(lk);
      const countyParty =
        extractContestParty(contestName) || dominantCountyPartyFromRows(contestRows);
      const suggestion = link
        ? null
        : suggestSosRaceForCountyContest(sosRaces, contestName, { electionParty, countyParty });

      for (const row of contestRows) {
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
          unlinked.push({
            ...entry,
            suggestedSosRaceId: suggestion?.race?.id != null ? String(suggestion.race.id) : "",
            suggestedSosRaceName: suggestion?.race?.N != null ? String(suggestion.race.N) : "",
            suggestedScore: suggestion?.score ?? 0,
          });
        }
      }
    }
  }

  return {
    sosRaces: (sosRaces ?? []).map((r) => ({
      id: String(r.id ?? ""),
      name: String(r.N ?? ""),
      section: String(r.section ?? ""),
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
    electionParty: electionParty ?? null,
    note:
      "SOS races include federal, statewide, district, and statewide proposition contests from Civix. After you link a contest, totals default to Auto: whichever of SOS county file vs county feed has more votes for that race. Override per county if needed.",
  };
}
