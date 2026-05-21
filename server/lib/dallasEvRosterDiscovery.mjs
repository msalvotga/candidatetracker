const DALLAS_RESULTS_HUB = "https://www.dallascountyvotes.org/election-results/current/";

/** @type {Array<{ variantKey: string; sourceLabel: string; votingMethodScope: string; dateScope: string; fileFormat: string }>} */
export const DALLAS_ROSTER_SOURCE_DEFS = [
  {
    variantKey: "ev-inperson-xlsx",
    sourceLabel: "In-person early voter list",
    votingMethodScope: "EV",
    dateScope: "CUMULATIVE",
    fileFormat: "xlsx",
  },
  {
    variantKey: "bbm-returned-xlsx",
    sourceLabel: "Mail ballots returned",
    votingMethodScope: "AB",
    dateScope: "CUMULATIVE",
    fileFormat: "xlsx",
  },
];

/**
 * Dallas posts daily in-person XLSX and cumulative mail-return XLSX on the current results hub.
 * @param {number} evrElectionId
 * @param {import("../db.mjs").listEvRosterCountySources} listFn
 * @param {import("../db.mjs").upsertEvRosterCountySource} upsertFn
 */
export async function ensureDallasEvRosterSources(evrElectionId, { listFn, upsertFn }) {
  const eid = Number(evrElectionId);
  const existing = await listFn(eid);
  const dallas = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "dallas");
  if (!dallas.length) return existing;
  const base = dallas.find((s) => s.civixCountyName) ?? dallas[0];

  let changed = false;
  for (const def of DALLAS_ROSTER_SOURCE_DEFS) {
    const row = dallas.find((s) => s.variantKey === def.variantKey);
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
      countyKey: "dallas",
      variantKey: def.variantKey,
      sourceLabel: def.sourceLabel,
      civixCountyName: base.civixCountyName ?? "DALLAS",
      civixCountyId: base.civixCountyId,
      handlerKey: "hub_page_discover",
      hubPageUrl: String(row?.hubPageUrl ?? "").trim() || DALLAS_RESULTS_HUB,
      rosterUrl: "",
      votingMethodScope: def.votingMethodScope,
      dateScope: def.dateScope,
      fileFormat: def.fileFormat,
      rosterPartyScope: "COMBINED",
      discoveryProfileKey: "dallas",
      trainingNotes:
        "Dallas In-Person Early Voter List XLSX is cumulative through the report date (DATE VOTED column); use Cumulative scope. Mail Ballots Returned is also cumulative. Hub: current election results page.",
      isEnabled: true,
    });
    changed = true;
  }

  const refreshed = changed ? await listFn(eid) : existing;
  const dallasAfter = refreshed.filter((s) => String(s.countyKey ?? "").toLowerCase() === "dallas");
  const hasCustom = dallasAfter.some((s) => s.variantKey !== "sos-default" && s.isEnabled !== false);
  const sos = dallasAfter.find((s) => s.variantKey === "sos-default");
  if (hasCustom && sos && sos.isEnabled !== false) {
    await upsertFn({
      id: sos.id,
      evrElectionId: eid,
      countyKey: "dallas",
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
