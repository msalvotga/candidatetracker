import type { RaceInput } from "../types/election";
import { toCandidateRows } from "../lib/voteMath";
import { LiveCount, LivePercent } from "./LiveCount";

function voteShare(value: number, total: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return (value / total) * 100;
}

function usesElectionDayEstimate(race: RaceInput): boolean {
  if (race.officeType === "STATEWIDE OFFICES") return true;
  if (race.officeType !== "FEDERAL OFFICES") return false;
  return /\bpresident\b|\bsenat(?:e|or)\b/i.test(race.title);
}

export function RaceSummary({
  race,
  onContestDetails,
  isFavorite,
  onToggleFavorite,
  canMoveFavoriteUp,
  canMoveFavoriteDown,
  onMoveFavoriteUp,
  onMoveFavoriteDown,
  electionDayEstimate,
}: {
  race: RaceInput;
  onContestDetails: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  canMoveFavoriteUp?: boolean;
  canMoveFavoriteDown?: boolean;
  onMoveFavoriteUp?: () => void;
  onMoveFavoriteDown?: () => void;
  electionDayEstimate?: number | null;
}) {
  const rows = toCandidateRows(race.candidates);
  const maxVotes = Math.max(...rows.map((r) => r.totalVotes), 1);
  const raceTotal = rows.reduce((s, r) => s + r.totalVotes, 0);
  const raceEarlyTotal = rows.reduce((sum, row) => sum + row.earlyVotes, 0);
  const raceElectionDayTotal = rows.reduce((sum, row) => sum + row.electionDayVotes, 0);
  const showElectionDayEstimate = usesElectionDayEstimate(race) && electionDayEstimate != null && electionDayEstimate >= 0;
  const estimatedElectionDayRemaining = showElectionDayEstimate
    ? Math.max(0, Math.round(electionDayEstimate - raceElectionDayTotal))
    : null;

  return (
    <section className="enr-card">
      <header className="enr-card__head">
        <div className="enr-card__titleRow">
          <button
            type="button"
            className={`enr-star ${isFavorite ? "is-active" : ""}`}
            onClick={onToggleFavorite}
            disabled={!onToggleFavorite}
            aria-label={isFavorite ? "Remove race from favorites" : "Add race to favorites"}
            title={isFavorite ? "Remove race from favorites" : "Add race to favorites"}
          >
            {isFavorite ? "★" : "☆"}
          </button>
          <h2 className="enr-card__title">{race.title}</h2>
          {(onMoveFavoriteUp || onMoveFavoriteDown) && isFavorite ? (
            <div className="enr-favoriteOrderControls">
              <button
                type="button"
                className="enr-favoriteOrderBtn"
                onClick={onMoveFavoriteUp}
                disabled={!canMoveFavoriteUp}
                aria-label="Move favorite up"
                title="Move favorite up"
              >
                ↑
              </button>
              <button
                type="button"
                className="enr-favoriteOrderBtn"
                onClick={onMoveFavoriteDown}
                disabled={!canMoveFavoriteDown}
                aria-label="Move favorite down"
                title="Move favorite down"
              >
                ↓
              </button>
            </div>
          ) : null}
        </div>
        <button type="button" className="enr-linkbtn" onClick={onContestDetails}>
          County Returns
        </button>
      </header>

      <div className="enr-tablewrap">
        <table className="enr-table">
          <thead>
            <tr>
              <th className="col-name">Candidate</th>
              <th>Party</th>
              <th className="num">Early votes</th>
              <th className="num">Election day</th>
              <th className="num">Total votes</th>
              <th className="num">Percent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="col-name">
                  <div className="enr-name">
                    {r.name}
                    {r.incumbent ? <span className="enr-inc"> (I)</span> : null}
                  </div>
                  <div className="enr-barTrack" aria-hidden>
                    <div
                      className={`enr-barFill ${r.totalVotes === maxVotes && maxVotes > 0 ? "enr-barFill--leader" : ""}`}
                      style={{ width: `${Math.max(0, Math.min(100, r.percent))}%` }}
                    />
                  </div>
                </td>
                <td>{r.party}</td>
                <td className="num">
                  <div className="enr-voteCellStack">
                    <LiveCount value={r.earlyVotes} />
                    <span className="enr-voteCellPct">
                      {voteShare(r.earlyVotes, raceEarlyTotal) == null ? "—" : <LivePercent value={voteShare(r.earlyVotes, raceEarlyTotal) ?? 0} />}
                    </span>
                  </div>
                </td>
                <td className="num">
                  <div className="enr-voteCellStack">
                    <LiveCount value={r.electionDayVotes} />
                    <span className="enr-voteCellPct">
                      {voteShare(r.electionDayVotes, raceElectionDayTotal) == null ? (
                        "—"
                      ) : (
                        <LivePercent value={voteShare(r.electionDayVotes, raceElectionDayTotal) ?? 0} />
                      )}
                    </span>
                  </div>
                </td>
                <td className="num">
                  <LiveCount value={r.totalVotes} />
                </td>
                <td className="num">
                  <LivePercent value={r.percent} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {estimatedElectionDayRemaining != null ? (
        <div className="enr-estimateBanner">
          Estimated <LiveCount value={estimatedElectionDayRemaining} /> Election Day Votes Remaining
        </div>
      ) : null}

      <footer className="enr-card__foot">
        <div className="enr-legend">(I) - Incumbent</div>
        <div className="enr-raceTotal">
          Race total:{" "}
          <strong>
            <LiveCount value={raceTotal} />
          </strong>
        </div>
      </footer>
    </section>
  );
}
