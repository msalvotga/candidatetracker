import { earlyVotingDatesThroughToday, runoffConfigsForElection } from "./evRosterRunoff.mjs";
import { pullEvRoster } from "./evRoster.mjs";

/**
 * Pull every early voting day through today for each party runoff config in the group.
 * @param {object} params
 * @param {Array<object>} params.configs all ev roster configs
 * @param {number} params.evrElectionId primary id from UI
 * @param {Array<object>} params.countySourcesByElectionId map evr id -> sources[]
 * @param {{ pullScope?: string, countyKey?: string }} params.options
 */
export async function pullRunoffThroughToday({
  configs,
  evrElectionId,
  countySourcesByElectionId,
  options = {},
}) {
  const runoffCfgs = runoffConfigsForElection(configs, evrElectionId);
  const primary = runoffCfgs.find((c) => Number(c.evrElectionId) === Number(evrElectionId)) ?? runoffCfgs[0];
  if (!primary) throw new Error("No runoff config for this election");

  const dates =
    options.dates?.length > 0
      ? options.dates.map(String)
      : earlyVotingDatesThroughToday(primary.electionDate);
  const pullScope = String(options.pullScope ?? "all");
  const results = [];

  const skipped = [];
  const onProgress = options.onProgress;
  const batchTotal = dates.length * runoffCfgs.length;
  let batchStep = 0;

  for (const votingDate of dates) {
    for (const cfg of runoffCfgs) {
      batchStep += 1;
      onProgress?.({
        phase: "day",
        message: `${cfg.party ?? "Runoff"} · ${votingDate} — starting`,
        votingDate,
        party: cfg.party ?? "",
        pullScope,
        step: batchStep,
        totalSteps: batchTotal,
      });
      try {
        const sources = countySourcesByElectionId.get(Number(cfg.evrElectionId)) ?? [];
        const pulled = await pullEvRoster(
          {
            evrElectionId: cfg.evrElectionId,
            electionName: cfg.electionName,
            electionDate: cfg.electionDate,
            votingDate,
            party: cfg.party ?? "",
          },
          sources,
          {
            pullScope,
            countyKey: options.countyKey,
            onProgress: (detail) =>
              onProgress?.({
                ...detail,
                votingDate,
                party: cfg.party ?? "",
                batchStep,
                batchTotal,
              }),
          },
        );
        if (pulled.skippedNoData) {
          skipped.push({
            votingDate: pulled.votingDateKey,
            party: cfg.party,
            message: pulled.skipMessage ?? "No data",
          });
          continue;
        }
        results.push({ cfg, votingDate: pulled.votingDateKey, pulled });
      } catch (e) {
        skipped.push({
          votingDate,
          party: cfg.party,
          message: String(e?.message || e),
        });
        console.warn(`EV pull skipped ${cfg.party} ${votingDate}:`, e?.message ?? e);
      }
    }
  }

  return { dates, results, skipped, runoffConfigs: runoffCfgs };
}
