import { useEffect, useMemo } from "react";
import { formatMetricDisplay, metricDisplayClass } from "../lib/metrics";
import type { MetricContest } from "../types";

function partyLabel(party: string) {
  if (party === "R") return "GOP";
  if (party === "D") return "DEM";
  if (party === "L") return "LIB";
  if (party === "I") return "IND";
  return party;
}

function formatVotes(value: number | null) {
  if (value == null) return "—";
  return value.toLocaleString("en-US");
}

function formatPct(value: number | null) {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function winnerKeys(contest: MetricContest): Set<string> {
  const keys = new Set<string>();
  const { candidates, uncontested, winning_party } = contest;
  if (candidates.length === 0) return keys;

  const keyFor = (name: string, party: string) => `${name}-${party}`;

  if (uncontested && winning_party) {
    for (const candidate of candidates) {
      if (candidate.party === winning_party) {
        keys.add(keyFor(candidate.candidate_name, candidate.party));
      }
    }
    if (keys.size === 0 && candidates.length === 1) {
      keys.add(keyFor(candidates[0].candidate_name, candidates[0].party));
    }
    return keys;
  }

  let best = -1;
  for (const candidate of candidates) {
    const score = candidate.votes ?? (candidate.vote_pct != null ? candidate.vote_pct : -1);
    if (score > best) best = score;
  }
  if (best < 0) return keys;

  for (const candidate of candidates) {
    const score = candidate.votes ?? (candidate.vote_pct != null ? candidate.vote_pct : -1);
    if (score === best) {
      keys.add(keyFor(candidate.candidate_name, candidate.party));
    }
  }
  return keys;
}

export function MetricContestModal({
  contest,
  loading,
  error,
  onClose,
}: {
  contest: MetricContest | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const winners = useMemo(() => (contest ? winnerKeys(contest) : new Set<string>()), [contest]);

  if (!contest && !loading && !error) return null;

  return (
    <div className="metric-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="metric-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="metric-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="metric-modal-header">
          <div>
            <h3 id="metric-modal-title">{contest?.label ?? "Election results"}</h3>
            {contest ? (
              <p className="metric-modal-subtitle">
                {contest.office_code} — {contest.contest_name}
              </p>
            ) : null}
          </div>
          <button type="button" className="metric-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {loading ? <p className="loading">Loading contest…</p> : null}
        {error ? <div className="banner error">{error}</div> : null}

        {contest ? (
          <div className="metric-modal-body">
            <div
              className={`metric-modal-margin ${metricDisplayClass(contest.gop_share, {
                uncontested: contest.uncontested,
                winningParty: contest.winning_party,
                metricKey: contest.metric_key,
              })}`}
            >
              {contest.uncontested ? (
                <>
                  Result: <strong>Uncontested</strong>
                </>
              ) : (
                <>
                  District margin:{" "}
                  <strong>
                    {formatMetricDisplay(contest.gop_share, { metricKey: contest.metric_key })}
                  </strong>
                </>
              )}
            </div>

            <table className="metric-contest-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Party</th>
                  <th>Votes</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {contest.candidates.map((candidate) => {
                  const rowKey = `${candidate.candidate_name}-${candidate.party}`;
                  const isWinner = winners.has(rowKey);
                  return (
                    <tr
                      key={rowKey}
                      className={`party-row-${candidate.party.toLowerCase()}${isWinner ? " contest-winner-row" : ""}`}
                    >
                      <td>
                        <span className="candidate-name-cell">
                          {isWinner ? (
                            <span className="winner-check" aria-label="Winner" title="Winner">
                              ✓
                            </span>
                          ) : (
                            <span className="winner-check-spacer" aria-hidden="true" />
                          )}
                          {candidate.candidate_name}
                        </span>
                      </td>
                      <td>{partyLabel(candidate.party)}</td>
                      <td>{formatVotes(candidate.votes)}</td>
                      <td>{formatPct(candidate.vote_pct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {contest.derived && contest.note ? (
              <p className="metric-modal-note">{contest.note}</p>
            ) : null}
            {contest.source ? <p className="metric-modal-source">Source: {contest.source}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
