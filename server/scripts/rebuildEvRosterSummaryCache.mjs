/**
 * One-time / maintenance: rebuild pre-aggregated summary cache for all configured runoff elections.
 * Usage: node server/scripts/rebuildEvRosterSummaryCache.mjs
 */
import { ensureDb, listEvRosterConfigs, rebuildEvRosterSummaryCacheForElection } from "../db.mjs";

await ensureDb();
const configs = await listEvRosterConfigs();
const ids = [...new Set((configs ?? []).map((c) => Number(c.evrElectionId)).filter(Boolean))];
for (const eid of ids) {
  const result = await rebuildEvRosterSummaryCacheForElection(eid);
  console.log(`evr_election_id ${eid}: ${result.activityRows} activity rows, ${result.registeredRows} registered rows`);
}
console.log("Done.");
