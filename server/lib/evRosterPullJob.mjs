import { randomUUID } from "crypto";
import {
  appendSourceImportLog,
  ensureDb,
  listEvRosterConfigs,
  listEvRosterCountySources,
  mergeEvRosterPull,
  recordEvRosterCountyPullResults,
  saveEvRosterPull,
  syncEvRosterCountySourcesFromTurnout,
  upsertEvRosterCountySource,
} from "../db.mjs";
import { pullRunoffThroughToday } from "./evRosterBulkPull.mjs";
import {
  beginPullProgress,
  finishPullProgress,
  updatePullProgress,
} from "./evRosterPullProgress.mjs";
import { earlyVotingDatesForRunoff, runoffConfigsForElection } from "./evRosterRunoff.mjs";

/**
 * Run EV roster pull in the background; progress via jobId poll.
 * @param {object} params
 */
export async function executeEvRosterPullJob(params) {
  const {
    jobId = randomUUID(),
    evrElectionId,
    pullScope = "all",
    countyKey,
    pullThroughToday = true,
    votingDateRaw,
    datesToPull: datesPreset,
  } = params;

  const report = (patch) => updatePullProgress(jobId, patch);

  try {
    await ensureDb();
    const configs = await listEvRosterConfigs();
    const runoffCfgs = runoffConfigsForElection(configs, evrElectionId);
    const primary =
      runoffCfgs.find((c) => Number(c.evrElectionId) === Number(evrElectionId)) ?? runoffCfgs[0] ?? null;
    if (!primary) throw new Error("Unknown evrElectionId — add a runoff config first");

    const datesToPull =
      datesPreset ??
      (pullThroughToday
        ? await earlyVotingDatesForRunoff(evrElectionId, primary.electionDate)
        : votingDateRaw
          ? [String(votingDateRaw)]
          : []);
    if (!datesToPull.length) {
      throw new Error("votingDate required when pullThroughToday is false");
    }

    const { fetchEarlyVotingTurnoutByCounty } = await import("./civixEvr.mjs");
    const { ensureKnownCountyEvRosterSources } = await import("./evRosterCountySeed.mjs");
    const countySourcesByElectionId = new Map();
    const seedDate = datesToPull[datesToPull.length - 1];
    report({ phase: "setup", message: "Syncing county source configuration…" });
    for (const cfg of runoffCfgs) {
      let turnout = { counties: [] };
      try {
        turnout = await fetchEarlyVotingTurnoutByCounty(cfg.evrElectionId, seedDate);
      } catch (e) {
        console.warn(`County source seed turnout failed for ${cfg.party}:`, e?.message ?? e);
      }
      let countySources = await syncEvRosterCountySourcesFromTurnout(cfg.evrElectionId, turnout.counties);
      countySources = await ensureKnownCountyEvRosterSources(cfg.evrElectionId, cfg.electionDate, cfg.party, {
        listFn: listEvRosterCountySources,
        upsertFn: upsertEvRosterCountySource,
        listConfigsFn: listEvRosterConfigs,
      });
      countySourcesByElectionId.set(Number(cfg.evrElectionId), countySources);
    }

    report({
      phase: "pulling",
      message: `Pulling ${datesToPull.length} day(s) × ${runoffCfgs.length} party runoff(s)…`,
      step: 0,
      totalSteps: datesToPull.length * runoffCfgs.length,
    });

    const bulk = await pullRunoffThroughToday({
      configs,
      evrElectionId,
      countySourcesByElectionId,
      options: { pullScope, countyKey, dates: datesToPull, onProgress: report },
    });

    const scopeLabel =
      pullScope === "counties"
        ? "County sources"
        : pullScope === "sos"
          ? "SOS only"
          : pullScope === "county"
            ? `County ${countyKey}`
            : "All sources";

    const useMerge = pullScope === "county" || pullScope === "counties";
    let totalRaw = 0;
    let totalDedup = 0;
    let totalCountyPulls = 0;
    const skipped = bulk.skipped ?? [];

    let saveStep = 0;
    const saveTotal = bulk.results.length;
    for (const { cfg, pulled } of bulk.results) {
      saveStep += 1;
      report({
        phase: "saving",
        message: `Saving ${cfg.party} ${pulled.votingDateKey} to database…`,
        party: cfg.party,
        votingDate: pulled.votingDateKey,
        step: saveStep,
        totalSteps: saveTotal,
      });
      totalRaw += Number(pulled.rawRecordCount ?? 0);
      totalDedup += Number(pulled.dedupedVoterCount ?? 0);
      totalCountyPulls += pulled.countyPullLog?.length ?? 0;

      const savePayload = {
        evrElectionId: cfg.evrElectionId,
        votingDate: pulled.votingDateKey,
        hubPageUrl: pulled.hubPageUrl,
        sosTurnoutUrl: pulled.countyTurnout?.sourceUrl ?? null,
        sosRosterUrl: pulled.roster?.sourceUrl ?? null,
        statewideVoterCount: pulled.statewideVoterCount,
        rawRecordCount: pulled.rawRecordCount,
        dedupedVoterCount: pulled.dedupedVoterCount,
        ok: true,
        message: `${scopeLabel} (${cfg.party} ${pulled.votingDateKey}): ${pulled.rawRecordCount} raw → ${pulled.dedupedVoterCount} VUIDs`,
        countySummaries: pulled.countySummaries,
        voters: pulled.dedupedVoters,
        countyPullLog: pulled.countyPullLog,
      };

      if (useMerge) await mergeEvRosterPull(savePayload);
      else await saveEvRosterPull(savePayload);
      await recordEvRosterCountyPullResults(cfg.evrElectionId, pulled.votingDateKey, pulled.countyPullLog);
    }

    const partyLabel = runoffCfgs.map((c) => c.party).filter(Boolean).join("+");
    if (!bulk.results.length && skipped.length) {
      const errMsg = `No pulls succeeded. First issue: ${skipped[0]?.message ?? "unknown"}`;
      await appendSourceImportLog({
        sourceKey: `ev-roster:${evrElectionId}`,
        ok: false,
        message: errMsg,
      });
      finishPullProgress(jobId, {
        phase: "error",
        message: errMsg,
        error: errMsg,
        active: false,
      });
      return { ok: false, jobId, error: errMsg, skipped };
    }

    await appendSourceImportLog({
      sourceKey: `ev-roster:${evrElectionId}`,
      ok: true,
      message: `EV roster ${partyLabel}: ${datesToPull.length} day(s), ${totalDedup} VUIDs`,
    });

    const result = {
      ok: true,
      jobId,
      pullThroughToday,
      daysPulled: datesToPull.length,
      daysSaved: bulk.results.length,
      electionsPulled: runoffCfgs.length,
      votingDates: datesToPull,
      skipped,
      rawRecordCount: totalRaw,
      dedupedVoterCount: totalDedup,
      countyPullCount: totalCountyPulls,
      pullScope,
      countyKey: countyKey ?? null,
    };

    finishPullProgress(jobId, {
      phase: "done",
      message: `Complete — ${totalDedup.toLocaleString("en-US")} unique VUIDs saved`,
      active: false,
      result,
    });

    return result;
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("ev-roster pull job", e);
    finishPullProgress(jobId, { phase: "error", message: msg, error: msg, active: false });
    const evrId = Number(evrElectionId);
    if (evrId) {
      await appendSourceImportLog({ sourceKey: `ev-roster:${evrId}`, ok: false, message: msg }).catch(() => {});
    }
    return { ok: false, jobId, error: msg };
  }
}

/**
 * Validate request and start background job; returns immediately.
 */
export async function startEvRosterPullJob(body) {
  await ensureDb();
  const evrElectionId = Number(body.evrElectionId);
  if (!evrElectionId) throw new Error("evrElectionId required");

  const configs = await listEvRosterConfigs();
  const runoffCfgs = runoffConfigsForElection(configs, evrElectionId);
  const primary =
    runoffCfgs.find((c) => Number(c.evrElectionId) === evrElectionId) ?? runoffCfgs[0] ?? null;
  if (!primary) throw new Error("Unknown evrElectionId — add a runoff config first");

  const pullScope = String(body.pullScope ?? "all");
  const countyKey = body.countyKey ? String(body.countyKey).toLowerCase() : undefined;
  if (pullScope === "county" && !countyKey) {
    throw new Error("countyKey required when pullScope is county");
  }

  const pullThroughToday = body.pullThroughToday !== false;
  const votingDateRaw = body.votingDate ?? body.date;
  const datesToPull = pullThroughToday
    ? await earlyVotingDatesForRunoff(evrElectionId, primary.electionDate)
    : votingDateRaw
      ? [String(votingDateRaw)]
      : [];
  if (!datesToPull.length) {
    throw new Error("votingDate required when pullThroughToday is false");
  }

  const jobId = String(body.jobId ?? "").trim() || randomUUID();
  beginPullProgress(jobId, {
    evrElectionId,
    pullScope,
    countyKey: countyKey ?? null,
    pullThroughToday,
    votingDates: datesToPull,
    totalSteps: datesToPull.length * runoffCfgs.length,
  });

  void executeEvRosterPullJob({
    jobId,
    evrElectionId,
    pullScope,
    countyKey,
    pullThroughToday,
    votingDateRaw,
    datesToPull,
  });

  return { ok: true, jobId, started: true, votingDates: datesToPull };
}
