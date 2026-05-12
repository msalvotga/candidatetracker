import type { RaceInput } from "../types/election";
import { toCandidateRows } from "../lib/voteMath";
import { LiveCount, LivePercent } from "./LiveCount";

export function RaceSummary({
  race,
  onContestDetails,
}: {
  race: RaceInput;
  onContestDetails: () => void;
}) {
  const rows = toCandidateRows(race.candidates);
  const maxVotes = Math.max(...rows.map((r) => r.totalVotes), 1);
  const raceTotal = rows.reduce((s, r) => s + r.totalVotes, 0);

  return (
    <section className="enr-card">
      <header className="enr-card__head">
        <div className="enr-card__titleRow">
          <h2 className="enr-card__title">{race.title}</h2>
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
                  <LiveCount value={r.earlyVotes} />
                </td>
                <td className="num">
                  <LiveCount value={r.electionDayVotes} />
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
