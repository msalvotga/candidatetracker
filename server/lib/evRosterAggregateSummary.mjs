import { configsForPartyFilter } from "./evRosterRunoff.mjs";

/**
 * Merge per-day county summary rows into one row per county for the filtered range.
 * @param {Array<object>} rows county summary rows with votingDate + evrElectionId
 * @param {Map<string, object>} voterCountsByCounty uppercased county name -> count
 */
export function aggregateCountySummaryRows(rows, voterCountsByCounty) {
  /** @type {Map<string, object>} */
  const byCounty = new Map();

  for (const r of rows ?? []) {
    const countyName = String(r.countyName ?? "").toUpperCase();
    if (!countyName) continue;
    const cur =
      byCounty.get(countyName) ??
      {
        countyName,
        countyId: r.countyId != null ? Number(r.countyId) : null,
        registeredVoters: 0,
        inPersonVotesOnDate: 0,
        totalInPersonVotesForElection: 0,
        totalMailVotesForElection: 0,
        cumulativeTotal: 0,
        sosVoterCount: 0,
        countyVoterCount: 0,
        chosenSource: "county",
        chosenVoterCount: 0,
        pullStatus: null,
        latestVotingDate: "",
      };

    cur.registeredVoters = Math.max(cur.registeredVoters, Number(r.registeredVoters ?? 0));
    cur.inPersonVotesOnDate += Number(r.inPersonVotesOnDate ?? 0);
    cur.totalInPersonVotesForElection = Math.max(
      cur.totalInPersonVotesForElection,
      Number(r.totalInPersonVotesForElection ?? 0),
    );
    cur.totalMailVotesForElection = Math.max(
      cur.totalMailVotesForElection,
      Number(r.totalMailVotesForElection ?? 0),
    );
    cur.cumulativeTotal = Math.max(cur.cumulativeTotal, Number(r.cumulativeTotal ?? 0));
    cur.sosVoterCount += Number(r.sosVoterCount ?? 0);
    cur.countyVoterCount += Number(r.countyVoterCount ?? 0);

    const vDate = String(r.votingDate ?? "");
    if (vDate >= cur.latestVotingDate) {
      cur.latestVotingDate = vDate;
      if (r.pullStatus) cur.pullStatus = { ...r.pullStatus, votingDate: vDate };
      if (r.chosenSource) cur.chosenSource = r.chosenSource;
    }

    byCounty.set(countyName, cur);
  }

  return [...byCounty.values()]
    .map((c) => {
      const roster = voterCountsByCounty.get(c.countyName) ?? 0;
      return {
        countyName: c.countyName,
        countyId: c.countyId,
        registeredVoters: c.registeredVoters,
        inPersonVotesOnDate: c.inPersonVotesOnDate,
        totalInPersonVotesForElection: c.totalInPersonVotesForElection,
        totalMailVotesForElection: c.totalMailVotesForElection,
        cumulativeTotal: Math.max(
          c.cumulativeTotal,
          c.totalInPersonVotesForElection + c.totalMailVotesForElection,
        ),
        sosVoterCount: c.sosVoterCount,
        countyVoterCount: c.countyVoterCount,
        chosenSource: roster > 0 ? "county" : c.chosenSource,
        chosenVoterCount: roster > 0 ? roster : c.sosVoterCount,
        pullStatus: c.pullStatus,
      };
    })
    .sort((a, b) => a.countyName.localeCompare(b.countyName));
}

/**
 * @param {Array<object>} configs
 * @param {string} partyFilter
 */
export function evrIdsForSummaryFilter(configs, partyFilter) {
  return configsForPartyFilter(configs, partyFilter).map((c) => Number(c.evrElectionId));
}

/**
 * County summary rows driven by voter activity dates in the filtered range (not Civix pull/report dates).
 * @param {{
 *   rosterByCounty: Map<string, number>,
 *   methodByCounty: Map<string, { ev: number, ab: number, ed: number }>,
 *   evInPersonDayByCounty: Map<string, number>,
 *   registeredByCounty?: Map<string, { registeredVoters: number, countyId: number | null }>,
 *   statusByCounty?: Map<string, object>,
 * }} rollups
 */
export function countiesFromVoterActivityInRange(rollups) {
  const counties = new Set([
    ...rollups.rosterByCounty.keys(),
    ...rollups.methodByCounty.keys(),
    ...(rollups.registeredByCounty?.keys() ?? []),
  ]);

  return [...counties]
    .sort((a, b) => a.localeCompare(b))
    .map((countyName) => {
      const methods = rollups.methodByCounty.get(countyName) ?? { ev: 0, ab: 0, ed: 0 };
      const roster = rollups.rosterByCounty.get(countyName) ?? 0;
      const reg = rollups.registeredByCounty?.get(countyName);
      const inPersonDay = rollups.evInPersonDayByCounty.get(countyName) ?? methods.ev;
      const cumulativeTotal = methods.ev + methods.ab + methods.ed;
      const st = rollups.statusByCounty?.get(countyName);
      const hasCountyRoster = roster > 0;
      return {
        countyName,
        countyId: reg?.countyId ?? null,
        registeredVoters: reg?.registeredVoters ?? 0,
        inPersonVotesOnDate: inPersonDay,
        totalInPersonVotesForElection: methods.ev,
        totalMailVotesForElection: methods.ab,
        cumulativeTotal: roster > 0 ? roster : cumulativeTotal,
        sosVoterCount: 0,
        countyVoterCount: roster,
        chosenSource: hasCountyRoster ? "county" : "sos",
        chosenVoterCount: roster,
        pullStatus: st ?? null,
      };
    });
}

/**
 * Statewide footer totals: county registered sums + distinct statewide voter counts by method.
 * @param {object} rollups
 * @param {number} storedVoterCount distinct VUIDs in filtered range
 * @param {{ ev: number, ab: number, ed: number }} statewideDistinct
 */
export function computeSummaryTotals(rollups, storedVoterCount, statewideDistinct) {
  let registeredVoters = 0;
  for (const r of rollups.registeredByCounty?.values() ?? []) {
    registeredVoters += Number(r.registeredVoters ?? 0);
  }
  let inPersonVotesOnDate = 0;
  for (const n of rollups.evInPersonDayByCounty?.values() ?? []) {
    inPersonVotesOnDate += Number(n ?? 0);
  }
  const ev = Number(statewideDistinct?.ev ?? 0);
  const ab = Number(statewideDistinct?.ab ?? 0);
  const ed = Number(statewideDistinct?.ed ?? 0);
  const roster = Number(storedVoterCount ?? 0);
  return {
    registeredVoters,
    inPersonVotesOnDate,
    totalInPersonVotesForElection: ev,
    totalMailVotesForElection: ab,
    cumulativeTotal: roster || ev + ab + ed,
    chosenVoterCount: roster,
  };
}
