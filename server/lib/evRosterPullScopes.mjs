import { normalizeParty, normalizeRosterPartyScope } from "./evRosterNormalize.mjs";
import { isCountyPullLocked } from "./evRosterCountyStatus.mjs";
import { civixCountyNameToKey } from "./texasCountyKeys.mjs";

/** @typedef {'all' | 'counties' | 'sos' | 'county'} EvRosterPullScope */

export const EV_ROSTER_PULL_SCOPES = [
  { id: "all", label: "All sources (SOS statewide + counties)" },
  { id: "counties", label: "County sources only (trained hubs/files)" },
  { id: "sos", label: "SOS statewide only" },
  { id: "county", label: "Single county (use countyKey)" },
];

/**
 * County file/hub sources — not the auto SOS per-county slice row.
 * @param {object} src
 */
export function isTrainableCountySource(src) {
  const variant = String(src.variantKey ?? "");
  if (variant && variant !== "sos-default") return true;
  if (String(src.hubPageUrl ?? "").trim() || String(src.rosterUrl ?? "").trim()) return true;
  const hk = String(src.handlerKey ?? "");
  return hk !== "civix_sos_county_slice" && hk !== "unimplemented";
}

/** Skip party-exclusive county files that do not match the election being pulled. */
export function countySourceMatchesElectionParty(src, electionParty) {
  const want = normalizeParty(electionParty);
  const scope = normalizeRosterPartyScope(src?.rosterPartyScope ?? "COMBINED");
  if (!want || scope === "COMBINED") return true;
  if (scope === "REP_ONLY") return want === "REP";
  if (scope === "DEM_ONLY") return want === "DEM";
  return true;
}

/**
 * @param {object[]} countySources
 * @param {{ pullScope?: string, countyKey?: string, party?: string }} options
 */
/**
 * Match turnout/summary county names to configured source county_key + civixCountyName.
 * @param {object[]} sourcesToPull
 */
export function buildPulledCountyMatchers(sourcesToPull) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<string>} */
  const keys = new Set();
  for (const s of sourcesToPull ?? []) {
    const name = String(s.civixCountyName ?? "").toUpperCase();
    const key = String(s.countyKey ?? "").toLowerCase();
    if (name) names.add(name);
    if (key) keys.add(key);
  }
  return { names, keys };
}

/** @param {string} countyName */
export function countyNameMatchesPull(countyName, matchers) {
  const name = String(countyName ?? "").toUpperCase();
  if (!name) return false;
  if (matchers.names.has(name)) return true;
  return matchers.keys.has(civixCountyNameToKey(name));
}

export function filterCountySourcesForPull(countySources, options = {}) {
  const scope = String(options.pullScope ?? "all");
  const countyKey = String(options.countyKey ?? "")
    .toLowerCase()
    .trim();
  const party = options.party ?? "";

  let list = (countySources ?? []).filter((s) => s.isEnabled !== false && countySourceMatchesElectionParty(s, party));

  if (scope === "sos") return [];
  if (scope === "counties") {
    list = list.filter(isTrainableCountySource);
  }
  if (scope === "county") {
    if (!countyKey) throw new Error("countyKey required for single-county pull");
    list = list.filter((s) => String(s.countyKey ?? "").toLowerCase() === countyKey);
    const trainable = list.filter(isTrainableCountySource);
    if (trainable.length) list = trainable;
  }
  const locked = options.lockedCountyNames;
  if (locked?.size) {
    list = list.filter((s) => !isCountyPullLocked(s.civixCountyName, locked));
  }
  return list;
}
