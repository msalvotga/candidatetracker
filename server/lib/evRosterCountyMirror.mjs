import {
  countySourceMatchesElectionParty,
  isTrainableCountySource,
} from "./evRosterPullScopes.mjs";

/**
 * Other runoff configs on the same election day (e.g. DEM 58314 + REP 58315).
 * @param {Array<{ evrElectionId: number, party?: string, electionDate?: string }>} configs
 * @param {number} evrElectionId
 */
export function siblingElectionConfigs(configs, evrElectionId) {
  const me = configs.find((c) => Number(c.evrElectionId) === Number(evrElectionId));
  if (!me?.electionDate) return [];
  return configs.filter(
    (c) =>
      Number(c.evrElectionId) !== Number(evrElectionId) &&
      String(c.electionDate ?? "").trim() === String(me.electionDate ?? "").trim(),
  );
}

/**
 * Copy trained hub/file sources from the sibling runoff so COMBINED files (e.g. Harris)
 * do not need to be configured twice. Party-exclusive sources (Collin) copy only to the matching party.
 *
 * @param {number} evrElectionId
 * @param {string} electionParty
 * @param {{ listFn: Function, upsertFn: Function, listConfigsFn: Function }} deps
 */
export async function mirrorTrainableCountySources(evrElectionId, electionParty, { listFn, upsertFn, listConfigsFn }) {
  const configs = await listConfigsFn();
  const siblings = siblingElectionConfigs(configs, evrElectionId);
  if (!siblings.length) return listFn(evrElectionId);

  let sources = await listFn(evrElectionId);

  for (const sib of siblings) {
    const sibSources = await listFn(sib.evrElectionId);
    for (const src of sibSources) {
      if (!isTrainableCountySource(src)) continue;
      if (!countySourceMatchesElectionParty(src, electionParty)) continue;

      const exists = sources.some(
        (s) => s.countyKey === src.countyKey && s.variantKey === src.variantKey,
      );
      if (exists) continue;

      const localBase = sources.find(
        (s) => s.countyKey === src.countyKey && s.variantKey === "sos-default",
      );

      await upsertFn({
        evrElectionId: Number(evrElectionId),
        countyKey: src.countyKey,
        variantKey: src.variantKey,
        sourceLabel: src.sourceLabel,
        civixCountyName: src.civixCountyName,
        civixCountyId: localBase?.civixCountyId ?? src.civixCountyId,
        handlerKey: src.handlerKey,
        hubPageUrl: src.hubPageUrl,
        rosterUrl: src.rosterUrl,
        votingMethodScope: src.votingMethodScope,
        dateScope: src.dateScope,
        fileFormat: src.fileFormat,
        rosterPartyScope: src.rosterPartyScope,
        discoveryProfileKey: src.discoveryProfileKey,
        trainingNotes: src.trainingNotes,
        isEnabled: src.isEnabled,
      });
      sources = await listFn(evrElectionId);
    }
  }

  return sources;
}

/**
 * After saving a source on one runoff, mirror to sibling election configs when applicable.
 * @param {object} row saved source fields
 * @param {{ listFn: Function, upsertFn: Function, listConfigsFn: Function }} deps
 */
export async function propagateCountySourceToSiblingElections(row, { listFn, upsertFn, listConfigsFn }) {
  if (!isTrainableCountySource(row)) return;

  const configs = await listConfigsFn();
  const siblings = siblingElectionConfigs(configs, row.evrElectionId);
  if (!siblings.length) return;

  for (const sib of siblings) {
    if (!countySourceMatchesElectionParty(row, sib.party)) continue;

    const sibSources = await listFn(sib.evrElectionId);
    const existing = sibSources.find(
      (s) => s.countyKey === row.countyKey && s.variantKey === row.variantKey,
    );
    const base = sibSources.find(
      (s) => s.countyKey === row.countyKey && s.variantKey === "sos-default",
    );

    await upsertFn({
      id: existing?.id,
      evrElectionId: sib.evrElectionId,
      countyKey: row.countyKey,
      variantKey: row.variantKey,
      sourceLabel: row.sourceLabel,
      civixCountyName: row.civixCountyName,
      civixCountyId: base?.civixCountyId ?? row.civixCountyId,
      handlerKey: row.handlerKey,
      hubPageUrl: row.hubPageUrl,
      rosterUrl: row.rosterUrl,
      votingMethodScope: row.votingMethodScope,
      dateScope: row.dateScope,
      fileFormat: row.fileFormat,
      rosterPartyScope: row.rosterPartyScope,
      discoveryProfileKey: row.discoveryProfileKey,
      trainingNotes: row.trainingNotes,
      isEnabled: row.isEnabled,
    });
  }
}
