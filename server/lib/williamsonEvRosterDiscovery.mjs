const WILLIAMSON_ELECTIONS_HUB = "https://www.wilco.org/departments/elections";

/** @type {Array<{ variantKey: string; sourceLabel: string; votingMethodScope: string; dateScope: string; fileFormat: string }>} */
export const WILLIAMSON_ROSTER_SOURCE_DEFS = [
  {
    variantKey: "daily-roster-xlsx",
    sourceLabel: "Daily voting roster (XLSX)",
    votingMethodScope: "ALL",
    dateScope: "CUMULATIVE",
    fileFormat: "xlsx",
  },
];

/**
 * Williamson posts a cumulative daily voting roster XLSX on the elections department page.
 * @param {number} evrElectionId
 * @param {import("../db.mjs").listEvRosterCountySources} listFn
 * @param {import("../db.mjs").upsertEvRosterCountySource} upsertFn
 */
export async function ensureWilliamsonEvRosterSources(evrElectionId, { listFn, upsertFn }) {
  const eid = Number(evrElectionId);
  const existing = await listFn(eid);
  const williamson = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "williamson");
  if (!williamson.length) return existing;
  const base = williamson.find((s) => s.civixCountyName) ?? williamson[0];

  let changed = false;
  for (const def of WILLIAMSON_ROSTER_SOURCE_DEFS) {
    const row = williamson.find((s) => s.variantKey === def.variantKey);
    const needsUpsert =
      !row ||
      row.handlerKey !== "hub_page_discover" ||
      String(row.dateScope ?? "").toUpperCase() !== def.dateScope ||
      String(row.fileFormat ?? "").toLowerCase() !== def.fileFormat ||
      String(row.votingMethodScope ?? "").toUpperCase() !== def.votingMethodScope ||
      !String(row.hubPageUrl ?? "").trim();

    if (!needsUpsert) continue;

    await upsertFn({
      id: row?.id,
      evrElectionId: eid,
      countyKey: "williamson",
      variantKey: def.variantKey,
      sourceLabel: def.sourceLabel,
      civixCountyName: base.civixCountyName ?? "WILLIAMSON",
      civixCountyId: base.civixCountyId,
      handlerKey: "hub_page_discover",
      hubPageUrl: String(row?.hubPageUrl ?? "").trim() || WILLIAMSON_ELECTIONS_HUB,
      rosterUrl: "",
      votingMethodScope: def.votingMethodScope,
      dateScope: def.dateScope,
      fileFormat: def.fileFormat,
      rosterPartyScope: "COMBINED",
      discoveryProfileKey: "williamson",
      trainingNotes:
        "Williamson posts a Daily Voting Roster XLSX on the elections page (cumulative turnout file with VUID).",
      isEnabled: true,
    });
    changed = true;
  }

  const refreshed = changed ? await listFn(eid) : existing;
  const after = refreshed.filter((s) => String(s.countyKey ?? "").toLowerCase() === "williamson");
  const hasCustom = after.some((s) => s.variantKey !== "sos-default" && s.isEnabled !== false);
  const sos = after.find((s) => s.variantKey === "sos-default");
  if (hasCustom && sos && sos.isEnabled !== false) {
    await upsertFn({
      id: sos.id,
      evrElectionId: eid,
      countyKey: "williamson",
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
