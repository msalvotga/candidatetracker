import { toIsoDateKey } from "./evRosterDateMatch.mjs";

const HARRIS_REPORTS_BASE = "https://appfiles.harrisvotes.com/harrisvotes/prd/Reports";

/**
 * Harris cumulative roster ZIPs use a 4-digit code from election day (e.g. 05/26/2026 → 0526).
 * @param {string} electionDate
 */
export function electionDateToHarrisReportCode(electionDate) {
  const raw = String(electionDate ?? "").trim();
  const iso = toIsoDateKey(raw);
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (isoMatch) return `${isoMatch[2]}${isoMatch[3]}`;
  const civix = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (civix) return `${civix[1].padStart(2, "0")}${civix[2].padStart(2, "0")}`;
  return "";
}

/**
 * Harris roster ZIPs are not linked in static hub HTML; probe known appfiles URLs.
 * @param {{ electionDate?: string, reportCode?: string }} [options]
 */
export async function discoverHarrisReportZipUrls(options = {}) {
  const code =
    String(options.reportCode ?? "").trim() || electionDateToHarrisReportCode(options.electionDate ?? "");
  if (!code) return [];

  /** @type {Array<{ url: string, matchedStage: string, matchedLabel: string, linkText: string, suggestedVariantKey: string, suggestedLabel: string, suggestedMethodScope: string, suggestedDateScope: string, suggestedFileFormat: string }>} */
  const defs = [
    {
      url: `${HARRIS_REPORTS_BASE}/Cumulative_EV_${code}.zip`,
      matchedStage: "ev_roster",
      matchedLabel: "Harris cumulative EV roster (ZIP)",
      linkText: "Cumulative EV roster",
      suggestedVariantKey: "ev-zip",
      suggestedLabel: "Harris EV roster ZIP",
      suggestedMethodScope: "EV",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "zip",
      suggestedRosterPartyScope: "COMBINED",
    },
    {
      url: `${HARRIS_REPORTS_BASE}/Cumulative_BBM_${code}.zip`,
      matchedStage: "bbm_roster",
      matchedLabel: "Harris cumulative BBM roster (ZIP)",
      linkText: "Cumulative BBM roster",
      suggestedVariantKey: "bbm-zip",
      suggestedLabel: "Harris BBM roster ZIP",
      suggestedMethodScope: "AB",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "zip",
      suggestedRosterPartyScope: "COMBINED",
    },
  ];

  const matches = [];
  for (const d of defs) {
    try {
      const res = await fetch(d.url, { method: "HEAD", redirect: "follow" });
      if (res.ok) {
        matches.push(d);
        continue;
      }
    } catch {
      /* try GET below */
    }
    try {
      const res = await fetch(d.url, { method: "GET", headers: { Range: "bytes=0-1" } });
      if (res.ok || res.status === 206) matches.push(d);
    } catch {
      /* unavailable */
    }
  }
  return matches;
}

/**
 * Upsert Harris EV + BBM ZIP sources when missing (hub page has no static roster links).
 * @param {number} evrElectionId
 * @param {string} electionDate
 * @param {import("../db.mjs").listEvRosterCountySources} listFn
 * @param {import("../db.mjs").upsertEvRosterCountySource} upsertFn
 */
export async function ensureHarrisEvRosterSources(evrElectionId, electionDate, { listFn, upsertFn }) {
  const eid = Number(evrElectionId);
  const existing = await listFn(eid);
  const harrisBase = existing.find((s) => s.countyKey === "harris" && s.variantKey === "sos-default");
  if (!harrisBase) return existing;

  const zips = await discoverHarrisReportZipUrls({ electionDate });
  if (!zips.length) return existing;

  let changed = false;
  for (const m of zips) {
    const variantKey = m.suggestedVariantKey;
    const row = existing.find((s) => s.countyKey === "harris" && s.variantKey === variantKey);
    const needsUpsert =
      !row ||
      row.handlerKey !== "generic_file_url" ||
      String(row.dateScope ?? "").toUpperCase() !== "CUMULATIVE" ||
      String(row.rosterUrl ?? "") !== m.url;

    if (!needsUpsert) continue;

    await upsertFn({
      id: row?.id,
      evrElectionId: eid,
      countyKey: "harris",
      variantKey,
      sourceLabel: m.suggestedLabel,
      civixCountyName: harrisBase.civixCountyName,
      civixCountyId: harrisBase.civixCountyId,
      handlerKey: "generic_file_url",
      hubPageUrl: "https://www.harrisvotes.com/Election-Results/Election-Rosters",
      rosterUrl: m.url,
      votingMethodScope: m.suggestedMethodScope,
      dateScope: "CUMULATIVE",
      fileFormat: m.suggestedFileFormat,
      rosterPartyScope: "COMBINED",
      isEnabled: true,
    });
    changed = true;
  }

  return changed ? listFn(eid) : existing;
}
