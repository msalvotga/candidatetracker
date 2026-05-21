const COLLIN_ROSTERS_HUB = "https://www.collincountytx.gov/Elections/rosters";

/** @type {Array<{ variantKey: string, sourceLabel: string, stageId: string, votingMethodScope: string, rosterPartyScope: string }>} */
export const COLLIN_ROSTER_SOURCE_DEFS = [
  {
    variantKey: "ab-rep",
    stageId: "ab_rep",
    sourceLabel: "Absentee returns — Republican",
    votingMethodScope: "AB",
    rosterPartyScope: "REP_ONLY",
  },
  {
    variantKey: "ab-dem",
    stageId: "ab_dem",
    sourceLabel: "Absentee returns — Democrat",
    votingMethodScope: "AB",
    rosterPartyScope: "DEM_ONLY",
  },
  {
    variantKey: "ev-rep",
    stageId: "ev_rep",
    sourceLabel: "Early voters — Republican",
    votingMethodScope: "EV",
    rosterPartyScope: "REP_ONLY",
  },
  {
    variantKey: "ev-dem",
    stageId: "ev_dem",
    sourceLabel: "Early voters — Democrat",
    votingMethodScope: "EV",
    rosterPartyScope: "DEM_ONLY",
  },
];

import { countySourceMatchesElectionParty } from "./evRosterPullScopes.mjs";

/**
 * Collin posts cumulative party-specific XLSX links on the rosters hub (URLs change daily).
 * Only the Republican or Democrat pair is created per runoff config (not all four on both).
 * @param {number} evrElectionId
 * @param {string} [electionParty] REP | DEM for this evr_election_id
 * @param {import("../db.mjs").listEvRosterCountySources} listFn
 * @param {import("../db.mjs").upsertEvRosterCountySource} upsertFn
 */
export async function ensureCollinEvRosterSources(evrElectionId, electionParty, { listFn, upsertFn }) {
  const eid = Number(evrElectionId);
  let existing = await listFn(eid);
  let collin = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "collin");
  let base = collin.find((s) => s.civixCountyName) ?? collin[0];
  if (!base) {
    await upsertFn({
      evrElectionId: eid,
      countyKey: "collin",
      variantKey: "sos-default",
      sourceLabel: "SOS default",
      civixCountyName: "COLLIN",
      civixCountyId: null,
      handlerKey: "civix_sos_county_slice",
      hubPageUrl: "",
      rosterUrl: "",
      votingMethodScope: "ALL",
      dateScope: "SINGLE_DAY",
      fileFormat: "auto",
      rosterPartyScope: "COMBINED",
      isEnabled: true,
    });
    existing = await listFn(eid);
    collin = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "collin");
    base = collin.find((s) => s.civixCountyName) ?? collin[0];
    if (!base) return existing;
  }

  const defs = COLLIN_ROSTER_SOURCE_DEFS.filter((def) =>
    countySourceMatchesElectionParty({ rosterPartyScope: def.rosterPartyScope }, electionParty),
  );

  let changed = false;
  for (const def of defs) {
    const row = collin.find((s) => s.variantKey === def.variantKey);
    const needsUpsert =
      !row ||
      row.handlerKey !== "hub_page_discover" ||
      String(row.dateScope ?? "").toUpperCase() !== "CUMULATIVE" ||
      String(row.fileFormat ?? "").toLowerCase() !== "xlsx" ||
      String(row.rosterPartyScope ?? "").toUpperCase() !== def.rosterPartyScope ||
      String(row.votingMethodScope ?? "").toUpperCase() !== def.votingMethodScope ||
      !String(row.hubPageUrl ?? "").trim();

    if (!needsUpsert) continue;

    await upsertFn({
      id: row?.id,
      evrElectionId: eid,
      countyKey: "collin",
      variantKey: def.variantKey,
      sourceLabel: def.sourceLabel,
      civixCountyName: base.civixCountyName ?? "COLLIN",
      civixCountyId: base.civixCountyId,
      handlerKey: "hub_page_discover",
      hubPageUrl: String(row?.hubPageUrl ?? "").trim() || COLLIN_ROSTERS_HUB,
      rosterUrl: "",
      votingMethodScope: def.votingMethodScope,
      dateScope: "CUMULATIVE",
      fileFormat: "xlsx",
      rosterPartyScope: def.rosterPartyScope,
      discoveryProfileKey: "collin",
      trainingNotes:
        "Collin posts four party-specific cumulative XLSX links on the rosters hub; URLs change daily. File URL is resolved from the hub on each pull.",
      isEnabled: true,
    });
    changed = true;
  }

  collin = (changed ? await listFn(eid) : existing).filter(
    (s) => String(s.countyKey ?? "").toLowerCase() === "collin",
  );
  for (const s of collin) {
    if (s.variantKey === "sos-default") continue;
    if (countySourceMatchesElectionParty(s, electionParty)) continue;
    await upsertFn({
      id: s.id,
      evrElectionId: eid,
      countyKey: "collin",
      variantKey: s.variantKey,
      sourceLabel: s.sourceLabel,
      civixCountyName: s.civixCountyName ?? base.civixCountyName,
      civixCountyId: s.civixCountyId,
      handlerKey: s.handlerKey,
      hubPageUrl: s.hubPageUrl,
      rosterUrl: s.rosterUrl,
      votingMethodScope: s.votingMethodScope,
      dateScope: s.dateScope,
      fileFormat: s.fileFormat,
      rosterPartyScope: s.rosterPartyScope,
      discoveryProfileKey: s.discoveryProfileKey,
      trainingNotes: s.trainingNotes,
      isEnabled: false,
    });
    changed = true;
  }

  const refreshed = changed ? await listFn(eid) : existing;
  const collinAfter = refreshed.filter((s) => String(s.countyKey ?? "").toLowerCase() === "collin");
  const hasCustom = collinAfter.some((s) => s.variantKey !== "sos-default");
  const sos = collinAfter.find((s) => s.variantKey === "sos-default");
  if (hasCustom && sos && sos.isEnabled !== false) {
    await upsertFn({
      id: sos.id,
      evrElectionId: eid,
      countyKey: "collin",
      variantKey: "sos-default",
      sourceLabel: sos.sourceLabel,
      civixCountyName: sos.civixCountyName,
      civixCountyId: sos.civixCountyId,
      handlerKey: sos.handlerKey,
      hubPageUrl: sos.hubPageUrl,
      rosterUrl: sos.rosterUrl,
      votingMethodScope: sos.votingMethodScope,
      dateScope: sos.dateScope,
      fileFormat: sos.fileFormat,
      rosterPartyScope: sos.rosterPartyScope,
      discoveryProfileKey: sos.discoveryProfileKey,
      trainingNotes: sos.trainingNotes,
      isEnabled: false,
    });
    return listFn(eid);
  }

  return refreshed;
}
