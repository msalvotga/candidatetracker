/** Ballot scores and county roster pulls are stored for the 2026 general election. */
export const ROSTER_SCORE_ELECTION_ID = "53815";

export function electionHasRosterScores(electionId: string | null | undefined) {
  return String(electionId ?? "") === ROSTER_SCORE_ELECTION_ID;
}
