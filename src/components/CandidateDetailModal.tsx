import { useEffect } from "react";
import {
  formatMoney,
  isFinanceReportFilled,
  mergeFinanceHistory,
  sortFinanceHistoryByPeriod,
} from "../lib/finance";
import { consultantLabel } from "./CandidateFinance";
import type { RaceCandidate } from "../types";

function partyLabel(party: string) {
  if (party === "R") return "GOP";
  if (party === "D") return "DEM";
  if (party === "L") return "LIB";
  if (party === "G") return "GREEN";
  if (party === "I") return "IND";
  return party;
}

function displayValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

export function CandidateSummary({ candidate }: { candidate: RaceCandidate }) {
  const consultant = consultantLabel(candidate);

  return (
    <div className="candidate-summary">
      <span className="candidate-summary-detail">
        <strong>Consultant</strong> {consultant ?? "—"}
      </span>
    </div>
  );
}

export function CandidateDetailModal({
  candidate,
  officeCode,
  onClose,
}: {
  candidate: RaceCandidate | null;
  officeCode: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!candidate) return null;

  const history = sortFinanceHistoryByPeriod(mergeFinanceHistory(candidate)).filter(isFinanceReportFilled);

  return (
    <div className="metric-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="metric-modal candidate-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="candidate-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="metric-modal-header">
          <div>
            <h3 id="candidate-detail-title" className="candidate-detail-title-row">
              <span>{candidate.name}</span>
              {candidate.is_incumbent ? <span className="incumbent-badge">Incumbent</span> : null}
            </h3>
            <p className="metric-modal-subtitle">
              {officeCode} · {partyLabel(candidate.party)}
              {candidate.filed ? " · Filed" : ""}
            </p>
          </div>
          <button type="button" className="metric-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="metric-modal-body">
          <section className="candidate-detail-section">
            <h4 className="candidate-detail-section-title">Candidate profile</h4>
            <dl className="candidate-detail-meta">
              <div>
                <dt>Filed</dt>
                <dd>{candidate.filed ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt>Consultant</dt>
                <dd>
                  {candidate.consultants?.length
                    ? candidate.consultants.map((c) => c.name).join(", ")
                    : displayValue(candidate.consultant)}
                </dd>
              </div>
              <div>
                <dt>TEC filer ID</dt>
                <dd>{displayValue(candidate.tec_filer_id)}</dd>
              </div>
              <div>
                <dt>Endorsements</dt>
                <dd>{displayValue(candidate.endorsements)}</dd>
              </div>
              <div>
                <dt>Website</dt>
                <dd>
                  {candidate.website?.trim() ? (
                    <a href={candidate.website} target="_blank" rel="noreferrer">
                      {candidate.website}
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div className="candidate-detail-meta-wide">
                <dt>Notes</dt>
                <dd>{displayValue(candidate.notes)}</dd>
              </div>
            </dl>
          </section>

          <section className="candidate-detail-section">
            <h4 className="candidate-detail-section-title">Identifiers</h4>
            <dl className="candidate-detail-meta">
              <div>
                <dt>Candidate ID</dt>
                <dd>{candidate.candidate_id != null ? <code>{candidate.candidate_id}</code> : "—"}</dd>
              </div>
              <div>
                <dt>VUID</dt>
                <dd>{candidate.vuid ? <code>{candidate.vuid}</code> : "—"}</dd>
              </div>
            </dl>
          </section>

          <section className="candidate-detail-section">
            <h4 className="candidate-detail-section-title">Financial filings</h4>
            {history.length === 0 ? (
              <p className="candidate-detail-empty">No finance reports on file.</p>
            ) : (
              <table className="metric-contest-table finance-history-table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Contributions</th>
                    <th>Expenditures</th>
                    <th>COH</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={String(entry.id)}>
                      <td>
                        <strong>{entry.period_label}</strong>
                        {entry.read_only ? <span className="finance-readonly-tag">sheet</span> : null}
                      </td>
                      <td>{formatMoney(entry.contributions)}</td>
                      <td>{formatMoney(entry.expenditures)}</td>
                      <td>{formatMoney(entry.cash_on_hand)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="candidate-detail-section candidate-detail-future">
            <h4 className="candidate-detail-section-title">VUID-linked data</h4>
            <p className="candidate-detail-empty">Additional candidate data tied to VUID will appear here.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
