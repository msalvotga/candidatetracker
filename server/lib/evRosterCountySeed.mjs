import { mirrorTrainableCountySources } from "./evRosterCountyMirror.mjs";

/**
 * Ensure trained county sources exist for counties with known hub/file patterns,
 * then mirror COMBINED (and party-matching) sources from the sibling runoff.
 * @param {number} evrElectionId
 * @param {string} [electionDate]
 * @param {string} [electionParty]
 * @param {{ listFn: Function, upsertFn: Function, listConfigsFn: Function }} deps
 */
export async function ensureKnownCountyEvRosterSources(
  evrElectionId,
  electionDate,
  electionParty,
  { listFn, upsertFn, listConfigsFn },
) {
  const { ensureHarrisEvRosterSources } = await import("./harrisEvRosterDiscovery.mjs");
  const { ensureTravisEvRosterSources } = await import("./travisEvRosterDiscovery.mjs");
  const { ensureDallasEvRosterSources } = await import("./dallasEvRosterDiscovery.mjs");
  const { ensureCollinEvRosterSources } = await import("./collinEvRosterDiscovery.mjs");
  const { ensureBexarEvRosterSources } = await import("./bexarEvRosterDiscovery.mjs");
  const { ensureFortBendEvRosterSources } = await import("./fortBendEvRosterDiscovery.mjs");
  const { ensureWilliamsonEvRosterSources } = await import("./williamsonEvRosterDiscovery.mjs");

  let sources = await listFn(evrElectionId);
  sources = await ensureHarrisEvRosterSources(evrElectionId, electionDate, { listFn, upsertFn });
  sources = await ensureTravisEvRosterSources(evrElectionId, { listFn, upsertFn });
  sources = await ensureDallasEvRosterSources(evrElectionId, { listFn, upsertFn });
  sources = await ensureCollinEvRosterSources(evrElectionId, electionParty, { listFn, upsertFn });
  sources = await ensureBexarEvRosterSources(evrElectionId, electionParty, { listFn, upsertFn });
  sources = await ensureFortBendEvRosterSources(evrElectionId, { listFn, upsertFn });
  sources = await ensureWilliamsonEvRosterSources(evrElectionId, { listFn, upsertFn });
  sources = await mirrorTrainableCountySources(evrElectionId, electionParty, {
    listFn,
    upsertFn,
    listConfigsFn,
  });
  return sources;
}
