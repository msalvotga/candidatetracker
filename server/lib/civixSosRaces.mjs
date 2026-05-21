import { decodeBase64Json, encodeBase64Json } from "./b64.mjs";

/** Civix election JSON sections that contain ballot races (same order as mapCivixElection). */
export const CIVIX_RACE_SECTION_KEYS = ["Federal", "StateWide", "Districted", "StateWideQ"];

/**
 * Collect all SOS races from Federal, StateWide, Districted, and StateWideQ.
 * @param {Record<string, unknown>} electionPayload Civix election object (base64 sections)
 * @returns {Array<{ id: string|number, N?: string, Candidates?: unknown[], section: string }>}
 */
export function collectCivixSosRaces(electionPayload) {
  const seen = new Set();
  const out = [];
  for (const sectionKey of CIVIX_RACE_SECTION_KEYS) {
    const encoded = electionPayload?.[sectionKey];
    if (!encoded) continue;
    const section = decodeBase64Json(encoded);
    for (const race of section?.Races ?? []) {
      const id = String(race?.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ ...race, section: sectionKey });
    }
  }
  return out;
}

/**
 * Decode every race section on the election payload (mutates nothing).
 * @returns {Record<string, { Races?: object[] } | null>}
 */
export function decodeCivixRaceSections(electionPayload) {
  /** @type {Record<string, { Races?: object[] } | null>} */
  const decoded = {};
  for (const sectionKey of CIVIX_RACE_SECTION_KEYS) {
    const encoded = electionPayload?.[sectionKey];
    decoded[sectionKey] = encoded ? decodeBase64Json(encoded) : null;
  }
  return decoded;
}

/**
 * Re-encode decoded sections back onto a copy of the election payload.
 */
export function encodeCivixRaceSections(electionPayload, decodedSections) {
  const next = { ...electionPayload };
  for (const sectionKey of CIVIX_RACE_SECTION_KEYS) {
    const section = decodedSections[sectionKey];
    if (section) next[sectionKey] = encodeBase64Json(section);
  }
  return next;
}

/**
 * Find a race object by id across all sections.
 * @returns {{ sectionKey: string, section: object, race: object } | null}
 */
export function findCivixRaceById(decodedSections, raceId) {
  const want = String(raceId ?? "");
  if (!want) return null;
  for (const sectionKey of CIVIX_RACE_SECTION_KEYS) {
    const section = decodedSections[sectionKey];
    if (!section?.Races) continue;
    const race = section.Races.find((r) => String(r?.id ?? "") === want);
    if (race) return { sectionKey, section, race };
  }
  return null;
}
