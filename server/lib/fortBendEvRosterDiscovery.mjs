const FORT_BEND_EV_STATS_HUB =
  "https://www.fortbendcountytx.gov/government/departments/elections-voter-registration/early-voting-statistics";

/** @type {Array<{ variantKey: string; sourceLabel: string; stageId: string; votingMethodScope: string; rosterPartyScope: string; isEnabled?: boolean; trainingNotes: string }>} */
export const FORT_BEND_ROSTER_SOURCE_DEFS = [
  {
    variantKey: "bbm-pdf",
    stageId: "bbm_pdf",
    sourceLabel: "Ballot by mail roster (PDF)",
    votingMethodScope: "AB",
    rosterPartyScope: "COMBINED",
    isEnabled: true,
    trainingNotes:
      "Fort Bend posts a BBM PDF on the early voting statistics hub (VUID list plus Return Date / Party). Parsed as cumulative mail ballots with per-voter return date and party.",
  },
  {
    variantKey: "ev-pdf",
    stageId: "ev_pdf",
    sourceLabel: "Early voting in person roster (PDF)",
    votingMethodScope: "EV",
    rosterPartyScope: "COMBINED",
    isEnabled: false,
    trainingNotes:
      "Enable when the hub EV link points at a voter-level PDF (not the sample ballot). Same PDF layout as BBM when available.",
  },
];

/**
 * @param {number} evrElectionId
 * @param {import("../db.mjs").listEvRosterCountySources} listFn
 * @param {import("../db.mjs").upsertEvRosterCountySource} upsertFn
 */
export async function ensureFortBendEvRosterSources(evrElectionId, { listFn, upsertFn }) {
  const eid = Number(evrElectionId);
  const existing = await listFn(eid);
  const fortBend = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "fort_bend");
  if (!fortBend.length) return existing;
  const base = fortBend.find((s) => s.civixCountyName) ?? fortBend[0];
  if (!base) return existing;

  let changed = false;
  for (const def of FORT_BEND_ROSTER_SOURCE_DEFS) {
    const row = fortBend.find((s) => s.variantKey === def.variantKey);
    const needsUpsert =
      !row ||
      row.handlerKey !== "hub_page_discover" ||
      String(row.dateScope ?? "").toUpperCase() !== "CUMULATIVE" ||
      String(row.fileFormat ?? "").toLowerCase() !== "pdf" ||
      String(row.rosterPartyScope ?? "").toUpperCase() !== def.rosterPartyScope ||
      String(row.votingMethodScope ?? "").toUpperCase() !== def.votingMethodScope ||
      !String(row.hubPageUrl ?? "").trim() ||
      row.isEnabled !== def.isEnabled;

    if (!needsUpsert) continue;

    await upsertFn({
      id: row?.id,
      evrElectionId: eid,
      countyKey: "fort_bend",
      variantKey: def.variantKey,
      sourceLabel: def.sourceLabel,
      civixCountyName: base.civixCountyName ?? "FORT BEND",
      civixCountyId: base.civixCountyId,
      handlerKey: "hub_page_discover",
      hubPageUrl: String(row?.hubPageUrl ?? "").trim() || FORT_BEND_EV_STATS_HUB,
      rosterUrl: "",
      votingMethodScope: def.votingMethodScope,
      dateScope: "CUMULATIVE",
      fileFormat: "pdf",
      rosterPartyScope: def.rosterPartyScope,
      discoveryProfileKey: "fort_bend",
      trainingNotes: def.trainingNotes,
      isEnabled: def.isEnabled,
    });
    changed = true;
  }

  const refreshed = changed ? await listFn(eid) : existing;
  const fortBendAfter = refreshed.filter((s) => String(s.countyKey ?? "").toLowerCase() === "fort_bend");
  const hasCustom = fortBendAfter.some(
    (s) => s.variantKey !== "sos-default" && s.isEnabled !== false,
  );
  const sos = fortBendAfter.find((s) => s.variantKey === "sos-default");
  if (hasCustom && sos && sos.isEnabled !== false) {
    await upsertFn({
      id: sos.id,
      evrElectionId: eid,
      countyKey: "fort_bend",
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
