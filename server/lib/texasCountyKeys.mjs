/** Civix SOS county name (uppercase, no " County") → ingest county_key slug. */
export function civixCountyNameToKey(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}
