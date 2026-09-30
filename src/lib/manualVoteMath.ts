export type ManualVoteSource = "sos" | "county_feed" | "manual" | "empty";

export type ManualVoteCell = {
  sosCandidateId: string;
  earlyVotes: number;
  electionDayVotes: number;
  mailVotes: number;
  totalVotes: number;
};

/** Same rule as server/lib/voteSource.mjs. */
export function resolveVoteSource(
  configured: string | undefined,
  countyFeedTotal: number,
  sosTotal: number,
  manualTotal: number,
  hasManualRows: boolean,
): ManualVoteSource {
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

export function sumVoteCells(rows: ManualVoteCell[] | undefined): number {
  let total = 0;
  for (const row of rows ?? []) {
    const parts = row.earlyVotes + row.electionDayVotes + row.mailVotes;
    total += row.totalVotes > 0 ? row.totalVotes : parts;
  }
  return total;
}

export function cellTotal(cell: Pick<ManualVoteCell, "earlyVotes" | "electionDayVotes" | "mailVotes" | "totalVotes">): number {
  const parts = cell.earlyVotes + cell.electionDayVotes + cell.mailVotes;
  return cell.totalVotes > 0 ? cell.totalVotes : parts;
}
