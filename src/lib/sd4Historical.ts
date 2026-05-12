/** Match Civix / CSV county labels for historical GE lookups (must mirror server `normalizeCountyLookupKey`). */
export function normalizeCountyLookupKey(displayName: string): string {
  return displayName
    .trim()
    .replace(/\s+county\s*$/i, "")
    .trim()
    .toLowerCase();
}

/** True when the race is Texas Senate District 4 (precinct history file applies). */
export function isSd4SenateRaceTitle(title: string): boolean {
  return /\bstate\s+senat(?:e|or)\b.*\bdistrict\s*#?\s*4\b|\bstate\s+senate\b.*\bdistrict\s*#?\s*4\b|\bsd\s*4\b/i.test(
    title.trim(),
  );
}
