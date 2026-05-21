const TRAVIS_ROSTER_ZIP_URL = "https://votetravis.gov/wp-content/uploads/PR26-Voter-Rosters.zip";

/**
 * Point trained Travis ZIP sources at generic_file_url + zip parser (not Civix SOS slice).
 * @param {number} evrElectionId
 * @param {import("../db.mjs").listEvRosterCountySources} listFn
 * @param {import("../db.mjs").upsertEvRosterCountySource} upsertFn
 */
export async function ensureTravisEvRosterSources(evrElectionId, { listFn, upsertFn }) {
  const eid = Number(evrElectionId);
  const existing = await listFn(eid);
  const travis = existing.filter((s) => String(s.countyKey ?? "").toLowerCase() === "travis");
  const base = travis.find((s) => s.civixCountyName) ?? travis[0];
  if (!base) return existing;

  const zipUrl =
    travis.map((s) => String(s.rosterUrl ?? "").trim()).find((u) => /votetravis|voter-rosters/i.test(u)) ||
    TRAVIS_ROSTER_ZIP_URL;

  let upserted = false;
  for (const s of travis) {
    if (s.variantKey === "sos-default" && !/votetravis|voter-rosters/i.test(String(s.rosterUrl ?? ""))) continue;

    const isZipSource = s.variantKey !== "sos-default" || /votetravis|voter-rosters/i.test(String(s.rosterUrl ?? ""));
    if (!isZipSource) continue;

    const needsFix =
      s.handlerKey !== "generic_file_url" ||
      String(s.fileFormat ?? "").toLowerCase() !== "zip" ||
      String(s.dateScope ?? "").toUpperCase() !== "CUMULATIVE";

    if (!needsFix && String(s.rosterUrl ?? "").trim() === zipUrl) continue;

    await upsertFn({
      id: s.id,
      evrElectionId: eid,
      countyKey: "travis",
      variantKey: s.variantKey === "sos-default" ? "pr26-daily-zip" : s.variantKey,
      sourceLabel: s.sourceLabel || "Travis daily rosters (ZIP)",
      civixCountyName: base.civixCountyName ?? "TRAVIS",
      civixCountyId: base.civixCountyId,
      handlerKey: "generic_file_url",
      hubPageUrl:
        s.hubPageUrl || "https://votetravis.gov/current-election-information/current-election/",
      rosterUrl: zipUrl,
      votingMethodScope: s.votingMethodScope || "ALL",
      dateScope: "CUMULATIVE",
      fileFormat: "zip",
      rosterPartyScope: "COMBINED",
      isEnabled: s.variantKey !== "sos-default",
    });
    upserted = true;
  }

  const refreshed = await listFn(eid);
  const hasZip = refreshed.some(
    (s) =>
      s.countyKey === "travis" &&
      s.variantKey !== "sos-default" &&
      s.handlerKey === "generic_file_url" &&
      s.isEnabled !== false,
  );
  if (hasZip) {
    const sos = refreshed.find((s) => s.countyKey === "travis" && s.variantKey === "sos-default");
    if (sos?.isEnabled !== false && sos?.id) {
      await upsertFn({
        id: sos.id,
        evrElectionId: eid,
        countyKey: "travis",
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
        isEnabled: false,
      });
    }
  }
  if (!hasZip) {
    await upsertFn({
      evrElectionId: eid,
      countyKey: "travis",
      variantKey: "pr26-daily-zip",
      sourceLabel: "Travis PR26 daily rosters (ZIP)",
      civixCountyName: base.civixCountyName ?? "TRAVIS",
      civixCountyId: base.civixCountyId,
      handlerKey: "generic_file_url",
      hubPageUrl: "https://votetravis.gov/current-election-information/current-election/",
      rosterUrl: zipUrl,
      votingMethodScope: "ALL",
      dateScope: "CUMULATIVE",
      fileFormat: "zip",
      rosterPartyScope: "COMBINED",
      isEnabled: true,
    });
    upserted = true;
  }

  return upserted ? listFn(eid) : existing;
}

export { TRAVIS_ROSTER_ZIP_URL };
