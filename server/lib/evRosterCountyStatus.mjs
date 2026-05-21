/**
 * Per-county pull success + user confirmation for a voting date (locks county from bulk re-pull).
 */

/**
 * @param {Array<{ countyName?: string, countyKey?: string, ok?: boolean, voterCount?: number, message?: string }>} countyPullLog
 */
export function aggregateCountyPullResults(countyPullLog) {
  /** @type {Map<string, { countyKey: string, countyName: string, lastPullOk: boolean, voterCount: number, messages: string[] }>} */
  const byCounty = new Map();
  for (const entry of countyPullLog ?? []) {
    const countyName = String(entry.countyName ?? "").toUpperCase();
    if (!countyName) continue;
    const countyKey = String(entry.countyKey ?? "").toLowerCase();
    const cur = byCounty.get(countyName) ?? {
      countyKey,
      countyName,
      lastPullOk: true,
      voterCount: 0,
      messages: [],
    };
    if (entry.ok === false) cur.lastPullOk = false;
    cur.voterCount += Number(entry.voterCount ?? 0);
    const msg = String(entry.message ?? "").trim();
    if (msg) cur.messages.push(msg);
    if (countyKey && !cur.countyKey) cur.countyKey = countyKey;
    byCounty.set(countyName, cur);
  }
  return [...byCounty.values()];
}

/**
 * @param {string} countyName
 * @param {Set<string>} lockedCountyNames uppercased
 */
export function isCountyPullLocked(countyName, lockedCountyNames) {
  return lockedCountyNames.has(String(countyName ?? "").toUpperCase());
}

/**
 * @param {Array<{ countyName?: string }>} countySummaries
 * @param {Set<string>} lockedCountyNames
 */
export function filterSummariesForLocked(countySummaries, lockedCountyNames) {
  if (!lockedCountyNames?.size) return countySummaries ?? [];
  return (countySummaries ?? []).filter((c) => !isCountyPullLocked(c.countyName, lockedCountyNames));
}

/**
 * @param {Array<{ countyName?: string, county?: string }>} voters
 * @param {Set<string>} lockedCountyNames
 */
export function filterVotersForLocked(voters, lockedCountyNames) {
  if (!lockedCountyNames?.size) return voters ?? [];
  return (voters ?? []).filter(
    (v) => !isCountyPullLocked(String(v.countyName ?? v.county ?? ""), lockedCountyNames),
  );
}
