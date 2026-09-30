/**
 * Pick which numbers a county uses for one race.
 * Manual wins on auto when its total is strictly higher than SOS and the county site.
 * `configured === "manual"` uses the manual numbers even when they are lower.
 *
 * @param {string | undefined} configured auto | sos | county_feed | manual
 * @param {number} countyFeedTotal
 * @param {number} sosTotal
 * @param {number} manualTotal
 * @param {boolean} hasManualRows
 * @returns {"sos"|"county_feed"|"manual"|"empty"}
 */
export function resolveVoteSource(configured, countyFeedTotal, sosTotal, manualTotal = 0, hasManualRows = false) {
  const cfg = String(configured ?? "auto").toLowerCase();
  const feed = Number(countyFeedTotal) || 0;
  const sos = Number(sosTotal) || 0;
  const manual = Number(manualTotal) || 0;

  if (cfg === "manual") {
    if (hasManualRows) return "manual";
    if (sos > 0) return "sos";
    if (feed > 0) return "county_feed";
    return "empty";
  }
  if (cfg === "sos") return sos > 0 ? "sos" : "empty";
  if (cfg === "county_feed") {
    if (feed > 0) return "county_feed";
    if (sos > 0) return "sos";
    return "empty";
  }

  const pulled = Math.max(feed, sos);
  if (hasManualRows && manual > pulled) return "manual";
  if (feed > sos && feed > 0) return "county_feed";
  if (sos > 0) return "sos";
  if (feed > 0) return "county_feed";
  if (hasManualRows && manual > 0) return "manual";
  return "empty";
}

/** @param {Array<{ earlyVotes?: number, electionDayVotes?: number, mailVotes?: number, totalVotes?: number }> | undefined} rows */
export function sumVoteRows(rows) {
  let total = 0;
  for (const row of rows ?? []) {
    const early = Number(row.earlyVotes ?? 0);
    const day = Number(row.electionDayVotes ?? 0);
    const mail = Number(row.mailVotes ?? 0);
    const parts = early + day + mail;
    const stated = Number(row.totalVotes ?? 0);
    total += stated > 0 ? stated : parts;
  }
  return total;
}
