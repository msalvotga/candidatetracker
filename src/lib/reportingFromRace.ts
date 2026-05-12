import type { RaceInput, ReportingSnapshot } from "../types/election";

/** Derive ribbon gauges from per-county rows for this race (not Civix global Home). */
export function reportingSnapshotForRace(base: ReportingSnapshot, race: RaceInput | null): ReportingSnapshot {
  if (!race?.counties?.length) return base;
  const rows = race.counties.filter((r) => !r.isTotalRow);
  const total = rows.length;
  const reported = rows.filter((row) => {
    const votes = Object.values(row.candidates).reduce((n, c) => n + (c.totalVotes ?? 0), 0);
    const pr = row.precinctReportingCount;
    if (pr != null && pr > 0) return true;
    if (votes > 0) return true;
    const m = row.precinctsReporting.match(/(\d+)\s+of\s+(\d+)/i);
    if (m && Number(m[1]) > 0) return true;
    return false;
  }).length;

  let pollR = 0;
  let pollT = 0;
  for (const row of rows) {
    if (row.precinctReportingCount != null && row.precinctTotalCount != null) {
      pollR += row.precinctReportingCount;
      pollT += row.precinctTotalCount;
    } else {
      const m = row.precinctsReporting.match(/(\d+)\s+of\s+(\d+)/i);
      if (m) {
        pollR += Number(m[1]);
        pollT += Number(m[2]);
      }
    }
  }

  return {
    ...base,
    counties: { reported, total },
    pollingLocations: { reported: pollR, total: pollT },
  };
}
