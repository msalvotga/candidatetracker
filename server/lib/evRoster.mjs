import {
  buildOfficialEarlyVotingTurnoutPageUrl,
  countVotersByCounty,
  fetchEarlyVotingTurnoutByCounty,
  fetchStatewideEarlyVotingRosterCsv,
  formatCivixDate,
  toIsoDateKey,
} from "./civixEvr.mjs";
import { runCountyRosterFetch } from "./evRosterCountyHandlers.mjs";
import {
  applyCountyRosterTurnoutFromRecords,
  dedupeVotersByVuid,
  normalizeParty,
  normalizeVotingMethod,
} from "./evRosterNormalize.mjs";
import { getConfirmedEvRosterCountyNames } from "../db.mjs";
import {
  buildPulledCountyMatchers,
  countyNameMatchesPull,
  filterCountySourcesForPull,
} from "./evRosterPullScopes.mjs";
import { tagVotersForStorage } from "./evRosterVoterDates.mjs";

/**
 * Run SOS early-voting roster pull for one EVR election and voting day.
 */
export async function pullSosEarlyVotingRoster(config) {
  const votingDate = formatCivixDate(config.votingDate);
  const electionDate = formatCivixDate(config.electionDate);
  const hubPageUrl = buildOfficialEarlyVotingTurnoutPageUrl({
    date: votingDate,
    electionId: config.evrElectionId,
    electionDate,
    electionName: config.electionName,
    isCertified: false,
  });

  const [countyTurnout, roster] = await Promise.all([
    fetchEarlyVotingTurnoutByCounty(config.evrElectionId, votingDate),
    fetchStatewideEarlyVotingRosterCsv(config.evrElectionId, votingDate),
  ]);

  const noSosData =
    !!countyTurnout.noData &&
    !!roster.noData &&
    !countyTurnout.counties?.length &&
    !roster.rows?.length;

  const sosVotersByCounty = countVotersByCounty(roster.rows);
  const countySummaries = countyTurnout.counties
    .filter((c) => c.name && c.name !== "TOTAL")
    .map((c) => {
      const sosVoterCount = sosVotersByCounty.get(c.name) ?? 0;
      const cumulativeTotal =
        Number(c.totalInPersonVotesForElection ?? 0) + Number(c.totalMailVotesForElection ?? 0);
      return {
        countyName: c.name,
        countyId: c.countyId,
        registeredVoters: c.registeredVoters,
        inPersonVotesOnDate: c.inPersonVotesOnDate,
        totalInPersonVotesForElection: c.totalInPersonVotesForElection,
        totalMailVotesForElection: c.totalMailVotesForElection,
        cumulativeTotal,
        sosVoterCount,
        countyVoterCount: 0,
        chosenSource: "sos",
        chosenVoterCount: sosVoterCount,
      };
    });

  return {
    votingDateKey: toIsoDateKey(votingDate),
    hubPageUrl,
    countyTurnout,
    roster,
    countySummaries,
    statewideVoterCount: roster.voterCount,
    noSosData,
  };
}

function sosRowsToRecords(rows, party) {
  return rows.map((r) => ({
    vuid: r.vuid,
    countyName: String(r.county ?? "").toUpperCase(),
    voterName: r.voterName,
    votingMethod: r.votingMethod,
    methodCode: normalizeVotingMethod(r.votingMethod),
    party: normalizeParty(party),
    precinct: r.precinct,
    sourceKey: "sos",
  }));
}

function turnoutSummariesOnly(config) {
  return fetchEarlyVotingTurnoutByCounty(config.evrElectionId, config.votingDate).then((countyTurnout) => {
    const votingDateKey = toIsoDateKey(formatCivixDate(config.votingDate));
    const countySummaries = countyTurnout.counties
      .filter((c) => c.name && c.name !== "TOTAL")
      .map((c) => ({
        countyName: c.name,
        countyId: c.countyId,
        registeredVoters: c.registeredVoters,
        inPersonVotesOnDate: c.inPersonVotesOnDate,
        totalInPersonVotesForElection: c.totalInPersonVotesForElection,
        totalMailVotesForElection: c.totalMailVotesForElection,
        cumulativeTotal:
          Number(c.totalInPersonVotesForElection ?? 0) + Number(c.totalMailVotesForElection ?? 0),
        sosVoterCount: 0,
        countyVoterCount: 0,
        chosenSource: "county",
        chosenVoterCount: 0,
      }));
    return { votingDateKey, countyTurnout, countySummaries };
  });
}

/**
 * @param {object} config
 * @param {Array<object>} countySources
 * @param {{ pullScope?: string, countyKey?: string }} [options]
 */
function reportPullProgress(options, patch) {
  if (typeof options.onProgress === "function") {
    options.onProgress(patch);
  }
}

export async function pullEvRoster(config, countySources = [], options = {}) {
  const scope = String(options.pullScope ?? "all");
  const party = normalizeParty(config.party);
  let votingDateKey = toIsoDateKey(formatCivixDate(config.votingDate));
  reportPullProgress(options, {
    phase: "prepare",
    message: "Preparing county sources…",
    pullScope: scope,
    party: config.party ?? party,
    votingDate: votingDateKey,
  });
  const lockedCountyNames = await getConfirmedEvRosterCountyNames(config.evrElectionId, votingDateKey);
  const sourcesToPull = filterCountySourcesForPull(countySources, {
    ...options,
    party,
    lockedCountyNames,
  });

  /** @type {import('./evRosterNormalize.mjs').RosterVoterInput[]} */
  let rawRecords = [];
  /** @type {Map<string, object>} */
  let summaryByCounty = new Map();
  let hubPageUrl = null;
  let countyTurnout = null;
  let roster = null;
  let statewideVoterCount = 0;

  if (scope === "all" || scope === "sos") {
    reportPullProgress(options, {
      phase: "sos",
      message: "Fetching SOS turnout and statewide roster…",
      pullScope: scope,
      party: config.party ?? party,
      votingDate: votingDateKey,
    });
    const sos = await pullSosEarlyVotingRoster(config);
    votingDateKey = sos.votingDateKey;
    if (sos.noSosData && scope === "all" && !sourcesToPull.length) {
      return {
        pullScope: scope,
        countyKey: options.countyKey ?? null,
        votingDateKey,
        skippedNoData: true,
        skipMessage: `No Civix SOS data for ${votingDateKey} (${config.party || "runoff"})`,
        hubPageUrl: sos.hubPageUrl,
        countyTurnout: sos.countyTurnout,
        roster: sos.roster,
        rawRecordCount: 0,
        dedupedVoters: [],
        dedupedVoterCount: 0,
        countySummaries: [],
        countyPullLog: [],
        statewideVoterCount: 0,
        sourcesAttempted: 0,
      };
    }
    hubPageUrl = sos.hubPageUrl;
    countyTurnout = sos.countyTurnout;
    roster = sos.roster;
    statewideVoterCount = sos.statewideVoterCount;
    rawRecords = sosRowsToRecords(sos.roster.rows, party);
    summaryByCounty = new Map(sos.countySummaries.map((c) => [c.countyName, { ...c }]));
  } else {
    reportPullProgress(options, {
      phase: "sos",
      message: "Fetching SOS county turnout…",
      pullScope: scope,
      party: config.party ?? party,
      votingDate: votingDateKey,
    });
    const partial = await turnoutSummariesOnly(config);
    votingDateKey = partial.votingDateKey;
    countyTurnout = partial.countyTurnout;
    summaryByCounty = new Map(partial.countySummaries.map((c) => [c.countyName, { ...c }]));

    // County-only pulls still need SOS voter counts for the selected runoff (58314 DEM / 58315 REP).
    try {
      const sos = await pullSosEarlyVotingRoster(config);
      hubPageUrl = hubPageUrl ?? sos.hubPageUrl;
      roster = roster ?? sos.roster;
      statewideVoterCount = sos.statewideVoterCount;
      for (const c of sos.countySummaries) {
        const prev = summaryByCounty.get(c.countyName) ?? c;
        summaryByCounty.set(c.countyName, {
          ...prev,
          registeredVoters: c.registeredVoters ?? prev.registeredVoters,
          inPersonVotesOnDate: c.inPersonVotesOnDate ?? prev.inPersonVotesOnDate,
          totalInPersonVotesForElection:
            c.totalInPersonVotesForElection ?? prev.totalInPersonVotesForElection,
          totalMailVotesForElection: c.totalMailVotesForElection ?? prev.totalMailVotesForElection,
          cumulativeTotal: c.cumulativeTotal ?? prev.cumulativeTotal,
          sosVoterCount: c.sosVoterCount,
          chosenSource: prev.countyVoterCount > 0 ? prev.chosenSource : "sos",
          chosenVoterCount: prev.countyVoterCount > 0 ? prev.chosenVoterCount : c.sosVoterCount,
        });
      }
    } catch (e) {
      console.warn("SOS roster merge for county pull failed:", e?.message ?? e);
    }
  }

  const ctxBase = {
    evrElectionId: config.evrElectionId,
    votingDate: config.votingDate,
    electionDate: config.electionDate,
    party,
    statewideRows: roster?.rows ?? [],
  };

  /** @type {Array<object>} */
  const countyPullLog = [];

  const countyTotal = sourcesToPull.length;
  let countyStep = 0;

  for (const src of sourcesToPull) {
    const countyName = String(src.civixCountyName ?? "").toUpperCase();
    const countyKey = String(src.countyKey ?? "").toLowerCase();
    if (!countyKey || !countyName) continue;

    countyStep += 1;
    reportPullProgress(options, {
      phase: "county",
      message: `Pulling ${countyName} — ${src.sourceLabel || src.variantKey || "source"}`,
      countyName,
      countyKey,
      sourceLabel: src.sourceLabel ?? src.variantKey ?? "",
      handlerKey: src.handlerKey ?? "",
      pullScope: scope,
      party: config.party ?? party,
      votingDate: votingDateKey,
      step: countyStep,
      totalSteps: countyTotal,
    });

    try {
      const result = await runCountyRosterFetch(src, {
        ...ctxBase,
        countyKey,
        civixCountyName: countyName,
        civixCountyId: src.civixCountyId ?? null,
        rosterUrl: src.rosterUrl ?? "",
        votingMethodScope: src.votingMethodScope,
        dateScope: src.dateScope,
        fileFormat: src.fileFormat,
      });

      if (result.skipped) {
        reportPullProgress(options, {
          phase: "county",
          message: `${countyName}: ${result.message ?? "Skipped"}`,
          countyName,
          countyKey,
          step: countyStep,
          totalSteps: countyTotal,
        });
        countyPullLog.push({
          countyKey,
          countyName,
          variantKey: src.variantKey,
          sourceLabel: src.sourceLabel,
          ok: true,
          voterCount: 0,
          sourceUrl: null,
          message: result.message ?? "Skipped",
          handlerKey: src.handlerKey ?? "unimplemented",
        });
        continue;
      }

      const handlerKey = src.handlerKey ?? "civix_sos_county_slice";
      const countyVoterCount = (result.rows ?? []).length;
      const isSosSlice = handlerKey === "civix_sos_county_slice";
      if (!isSosSlice) {
        rawRecords.push(...(result.rows ?? []));
      }
      countyPullLog.push({
        countyKey,
        countyName,
        variantKey: src.variantKey,
        sourceLabel: src.sourceLabel,
        ok: true,
        voterCount: countyVoterCount,
        sourceUrl: result.sourceUrl ?? null,
        message: result.message ?? `OK: ${countyVoterCount} rows`,
        handlerKey,
      });

      const sum = summaryByCounty.get(countyName) ?? {
        countyName,
        countyId: src.civixCountyId ?? null,
        registeredVoters: 0,
        inPersonVotesOnDate: 0,
        totalInPersonVotesForElection: 0,
        totalMailVotesForElection: 0,
        cumulativeTotal: 0,
        sosVoterCount: 0,
        countyVoterCount: 0,
        chosenSource: "county",
        chosenVoterCount: 0,
      };
      sum.countyVoterCount = countyVoterCount;
      if (!isSosSlice && countyVoterCount > 0) sum.chosenSource = "county";
      summaryByCounty.set(countyName, sum);
      reportPullProgress(options, {
        phase: "county",
        message: `${countyName}: ${countyVoterCount.toLocaleString("en-US")} rows`,
        countyName,
        countyKey,
        step: countyStep,
        totalSteps: countyTotal,
      });
    } catch (e) {
      reportPullProgress(options, {
        phase: "county",
        message: `${countyName}: failed — ${String(e?.message || e).slice(0, 120)}`,
        countyName,
        countyKey,
        step: countyStep,
        totalSteps: countyTotal,
      });
      countyPullLog.push({
        countyKey,
        countyName,
        variantKey: src.variantKey,
        sourceLabel: src.sourceLabel,
        ok: false,
        voterCount: 0,
        sourceUrl: null,
        message: String(e?.message || e),
        handlerKey: src.handlerKey ?? "civix_sos_county_slice",
      });
    }
  }

  reportPullProgress(options, {
    phase: "merge",
    message: "Merging and deduplicating voter records…",
    pullScope: scope,
    party: config.party ?? party,
    votingDate: votingDateKey,
  });
  const deduped = tagVotersForStorage(dedupeVotersByVuid(rawRecords), votingDateKey);
  applyCountyRosterTurnoutFromRecords(summaryByCounty, deduped, { votingDate: votingDateKey });
  const dedupedByCounty = countVotersByCounty(deduped.map((r) => ({ county: r.countyName })));

  let countySummaries = [...summaryByCounty.values()].map((c) => {
    const dedupCount = dedupedByCounty.get(c.countyName) ?? 0;
    const hasCountyData = c.countyVoterCount > 0 || dedupCount > 0;
    return {
      ...c,
      chosenVoterCount: scope === "sos" ? c.sosVoterCount : hasCountyData ? dedupCount : c.sosVoterCount,
      chosenSource: hasCountyData ? "county" : c.chosenSource ?? "sos",
    };
  });

  /** Single-county / county-sources pulls must not replace other counties in the DB. */
  let dedupedVoters = deduped;
  if (scope === "county" || scope === "counties") {
    const matchers = buildPulledCountyMatchers(sourcesToPull);
    if (scope === "county" && options.countyKey) {
      matchers.keys.add(String(options.countyKey).toLowerCase().trim());
    }
    dedupedVoters = deduped.filter((v) => countyNameMatchesPull(v.countyName, matchers));
    countySummaries = countySummaries.filter((c) => countyNameMatchesPull(c.countyName, matchers));
  }

  return {
    pullScope: scope,
    countyKey: options.countyKey ?? null,
    votingDateKey,
    hubPageUrl,
    countyTurnout,
    roster,
    rawRecordCount: rawRecords.length,
    dedupedVoters,
    dedupedVoterCount: dedupedVoters.length,
    countySummaries,
    countyPullLog,
    statewideVoterCount,
    sourcesAttempted: sourcesToPull.length,
  };
}

/** @deprecated use pullEvRoster */
export async function pullFullEvRoster(config, countySources = []) {
  return pullEvRoster(config, countySources, { pullScope: "all" });
}

/** @deprecated Use dedupeVotersByVuid via pullEvRoster */
export function mergeRosterSources(sosRows, countyRosters = []) {
  const records = [
    ...sosRows.map((r) => ({
      vuid: r.vuid,
      countyName: r.county,
      voterName: r.voterName,
      votingMethod: r.votingMethod,
      sourceKey: "sos",
    })),
  ];
  for (const cr of countyRosters) {
    for (const r of cr.rows ?? []) {
      records.push({
        vuid: r.vuid,
        countyName: cr.countyName,
        voterName: r.voterName,
        votingMethod: r.votingMethod,
        sourceKey: `county:${cr.countyName}`,
      });
    }
  }
  return dedupeVotersByVuid(records);
}
