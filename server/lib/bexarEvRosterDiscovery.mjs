const BEXAR_ROSTER_ARCHIVE_HUB = "https://www.bexar.org/Archive.aspx?AMID=81";

/** @type {Array<{ variantKey: string; sourceLabel: string; stageId: string; votingMethodScope: string; rosterPartyScope: string }>} */
export const BEXAR_ROSTER_SOURCE_DEFS = [
  {
    variantKey: "bbm-rep",
    stageId: "bbm_rep",
    sourceLabel: "Received ballots — Republican",
    votingMethodScope: "AB",
    rosterPartyScope: "REP_ONLY",
  },
  {
    variantKey: "bbm-dem",
    stageId: "bbm_dem",
    sourceLabel: "Received ballots — Democrat",
    votingMethodScope: "AB",
    rosterPartyScope: "DEM_ONLY",
  },
  {
    variantKey: "ev-rep",
    stageId: "ev_rep",
    sourceLabel: "Early voting — Republican",
    votingMethodScope: "EV",
    rosterPartyScope: "REP_ONLY",
  },
  {
    variantKey: "ev-dem",
    stageId: "ev_dem",
    sourceLabel: "Early voting — Democrat",
    votingMethodScope: "EV",
    rosterPartyScope: "DEM_ONLY",
  },
];

import { countySourceMatchesElectionParty } from "./evRosterPullScopes.mjs";

/**
 * Bexar posts daily party-specific PDFs on the archive hub (AMID=81).
 * "Received Primary Runoff Election" links are BBM; "Early Voting" links are in-person EV.
 * @param {number} evrElectionId
 * @param {string} [electionParty] REP | DEM
 * @param {{ listFn: Function, upsertFn: Function }} deps
 */
export async function ensureBexarEvRosterSources(evrElectionId, electionParty, { listFn, upsertFn }) {
  const eid = Number(evrElectionId);
  let existing = await listFn(eid);
  let bexar = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "bexar");
  let base = bexar.find((s) => s.civixCountyName) ?? bexar[0];
  if (!base) {
    await upsertFn({
      evrElectionId: eid,
      countyKey: "bexar",
      variantKey: "sos-default",
      sourceLabel: "SOS default",
      civixCountyName: "BEXAR",
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
    bexar = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "bexar");
    base = bexar.find((s) => s.civixCountyName) ?? bexar[0];
    if (!base) return existing;
  }

  const defs = BEXAR_ROSTER_SOURCE_DEFS.filter((def) =>
    countySourceMatchesElectionParty({ rosterPartyScope: def.rosterPartyScope }, electionParty),
  );

  let changed = false;
  for (const def of defs) {
    const row = bexar.find((s) => s.variantKey === def.variantKey);
    const needsUpsert =
      !row ||
      row.handlerKey !== "hub_page_discover" ||
      String(row.dateScope ?? "").toUpperCase() !== "SINGLE_DAY" ||
      String(row.fileFormat ?? "").toLowerCase() !== "pdf" ||
      String(row.rosterPartyScope ?? "").toUpperCase() !== def.rosterPartyScope ||
      String(row.votingMethodScope ?? "").toUpperCase() !== def.votingMethodScope ||
      !String(row.hubPageUrl ?? "").trim();

    if (!needsUpsert) continue;

    await upsertFn({
      id: row?.id,
      evrElectionId: eid,
      countyKey: "bexar",
      variantKey: def.variantKey,
      sourceLabel: def.sourceLabel,
      civixCountyName: base.civixCountyName ?? "BEXAR",
      civixCountyId: base.civixCountyId,
      handlerKey: "hub_page_discover",
      hubPageUrl: String(row?.hubPageUrl ?? "").trim() || BEXAR_ROSTER_ARCHIVE_HUB,
      rosterUrl: "",
      votingMethodScope: def.votingMethodScope,
      dateScope: "SINGLE_DAY",
      fileFormat: "pdf",
      rosterPartyScope: def.rosterPartyScope,
      discoveryProfileKey: "bexar",
      trainingNotes:
        "Bexar archive (AMID=81): Received Primary Runoff … Election Day PDFs = BBM; Early Voting PDFs = EV. One PDF per party per day; link resolved from hub on each pull.",
      isEnabled: true,
    });
    changed = true;
  }

  bexar = (changed ? await listFn(eid) : existing).filter(
    (s) => String(s.countyKey ?? "").toLowerCase() === "bexar",
  );
  for (const s of bexar) {
    if (s.variantKey === "sos-default") continue;
    if (countySourceMatchesElectionParty(s, electionParty)) continue;
    await upsertFn({
      id: s.id,
      evrElectionId: eid,
      countyKey: "bexar",
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
  const bexarAfter = refreshed.filter((s) => String(s.countyKey ?? "").toLowerCase() === "bexar");
  const hasCustom = bexarAfter.some((s) => s.variantKey !== "sos-default");
  const sos = bexarAfter.find((s) => s.variantKey === "sos-default");
  if (hasCustom && sos && sos.isEnabled !== false) {
    await upsertFn({
      id: sos.id,
      evrElectionId: eid,
      countyKey: "bexar",
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
