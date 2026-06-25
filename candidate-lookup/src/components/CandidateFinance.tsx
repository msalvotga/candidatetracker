import { useState } from "react";
import {
  candidateKey,
  defaultReportEndForPeriod,
  filingPeriodLabel,
  formatMoney,
  formatMostRecentFilingLabel,
  getFilingPeriods,
  latestFilingForCandidate,
  mergeFinanceHistory,
  sortFinanceHistoryByPeriod,
} from "../lib/finance";
import type { Consultant, PendingFinanceEntry, RaceCandidate } from "../types";

export function consultantLabel(candidate: Pick<RaceCandidate, "consultants" | "consultant">) {
  const fromRefs = candidate.consultants?.map((c) => c.name).join(", ");
  const legacy = candidate.consultant?.trim();
  return fromRefs || legacy || null;
}

function sortedKeys(keys: string[]) {
  return [...keys].sort();
}

function keysEqual(a: string[], b: string[]) {
  const left = sortedKeys(a);
  const right = sortedKeys(b);
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function CandidateConsultantEditor({
  candidate,
  consultants,
  value,
  onChange,
}: {
  candidate: RaceCandidate;
  consultants: Consultant[];
  value?: string[];
  onChange: (keys: string[] | undefined) => void;
}) {
  const baseline = candidate.consultant_keys ?? [];
  const selectedKeys = value ?? baseline;
  const selected = new Set(selectedKeys);
  const changed = value !== undefined;

  function toggle(consultantKey: string) {
    const next = new Set(selectedKeys);
    if (next.has(consultantKey)) next.delete(consultantKey);
    else next.add(consultantKey);
    const keys = sortedKeys([...next]);
    onChange(keysEqual(keys, baseline) ? undefined : keys);
  }

  return (
    <div className={`candidate-consultant-editor${changed ? " candidate-consultant-editor-changed" : ""}`}>
      <span className="candidate-consultant-label">Consultant</span>
      {consultants.length === 0 ? (
        <span className="coh-empty">Add consultants on the Data tab first.</span>
      ) : (
        <div className="candidate-consultant-options">
          {consultants.map((consultant) => (
            <label key={consultant.consultant_key} className="candidate-consultant-option">
              <input
                type="checkbox"
                checked={selected.has(consultant.consultant_key)}
                onChange={() => toggle(consultant.consultant_key)}
              />
              <span>{consultant.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function reportSummary(entry: {
  contributions: number | null;
  expenditures: number | null;
  cash_on_hand: number | null;
}) {
  const parts: string[] = [];
  if (entry.contributions != null) parts.push(`In: ${formatMoney(entry.contributions)}`);
  if (entry.expenditures != null) parts.push(`Out: ${formatMoney(entry.expenditures)}`);
  if (entry.cash_on_hand != null) parts.push(`COH: ${formatMoney(entry.cash_on_hand)}`);
  return parts.join(" · ") || "—";
}

export function LatestFinanceDisplay({
  candidate,
  pendingAdds = [],
}: {
  candidate: RaceCandidate;
  pendingAdds?: PendingFinanceEntry[];
}) {
  const latest = latestFilingForCandidate(candidate, pendingAdds);

  if (!latest) return <span className="coh-empty">—</span>;

  return (
    <div className="latest-finance">
      <div className="latest-finance-primary">
        <span className="latest-finance-heading">
          <strong>Most recent filing:</strong> {formatMostRecentFilingLabel(latest)}
        </span>
      </div>
      <div className="latest-finance-metrics">
        <span className="latest-finance-metric">
          <strong>Contributions</strong> {formatMoney(latest.contributions)}
        </span>
        <span className="latest-finance-metric">
          <strong>Expenditures</strong> {formatMoney(latest.expenditures)}
        </span>
        <span className="latest-finance-metric">
          <strong>COH</strong> {formatMoney(latest.cash_on_hand)}
        </span>
      </div>
    </div>
  );
}

export function FinanceHistoryEditor({
  candidate,
  pendingAdds,
  onAddPending,
  onRemovePending,
}: {
  candidate: RaceCandidate;
  pendingAdds: PendingFinanceEntry[];
  onAddPending: (entry: PendingFinanceEntry) => void;
  onRemovePending: (localId: string) => void;
}) {
  const [periodKey, setPeriodKey] = useState("");
  const [reportDate, setReportDate] = useState("");
  const [contributions, setContributions] = useState("");
  const [expenditures, setExpenditures] = useState("");
  const [cashOnHand, setCashOnHand] = useState("");
  const key = candidateKey(candidate);
  const saved = sortFinanceHistoryByPeriod(mergeFinanceHistory(candidate));
  const pending = pendingAdds.filter((entry) => entry.candidateKey === key);
  const periods = getFilingPeriods();

  function handlePeriodChange(value: string) {
    setPeriodKey(value);
    if (!value) return;
    const defaultEnd = defaultReportEndForPeriod(value);
    if (defaultEnd) setReportDate(defaultEnd);
  }

  function handleAdd() {
    if (!periodKey) return;
    const coh = cashOnHand.trim() === "" ? null : Number(cashOnHand);
    const raised = contributions.trim() === "" ? null : Number(contributions);
    const spent = expenditures.trim() === "" ? null : Number(expenditures);
    if (coh == null && raised == null && spent == null) return;
    if ([coh, raised, spent].some((v) => v != null && !Number.isFinite(v))) return;

    onAddPending({
      localId: `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      candidateKey: key,
      candidate_id: candidate.candidate_id,
      period_key: periodKey,
      period_label: filingPeriodLabel(periodKey),
      report_period_end: reportDate.trim() || defaultReportEndForPeriod(periodKey),
      contributions: raised,
      expenditures: spent,
      cash_on_hand: coh,
    });
    setPeriodKey("");
    setReportDate("");
    setContributions("");
    setExpenditures("");
    setCashOnHand("");
  }

  return (
    <div className="coh-history-editor">
      {candidate.candidate_id != null ? (
        <p className="candidate-id-line">
          Candidate ID: <code>{candidate.candidate_id}</code>
          {candidate.vuid ? (
            <>
              {" "}
              · VUID: <code>{candidate.vuid}</code>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="latest-finance latest-finance-inline">
        <LatestFinanceDisplay candidate={candidate} pendingAdds={pendingAdds} />
      </div>

      {saved.length > 0 ? (
        <ul className="coh-history-list coh-history-list-saved">
          {saved.map((entry) => (
            <li key={String(entry.id)}>
              <strong>{formatMostRecentFilingLabel(entry)}</strong> {reportSummary(entry)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="coh-history-empty">No finance reports yet.</p>
      )}

      {pending.length > 0 ? (
        <ul className="coh-history-list coh-history-list-pending">
          {pending.map((entry) => (
            <li key={entry.localId}>
              <strong>{entry.period_label}</strong> {reportSummary(entry)}
              <span className="coh-pending-tag">pending</span>
              <button type="button" className="coh-remove-pending" onClick={() => onRemovePending(entry.localId)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="coh-add-form">
        <label>
          <span className="coh-add-label">Period</span>
          <select className="edit-input" value={periodKey} onChange={(e) => handlePeriodChange(e.target.value)}>
            <option value="">Select period…</option>
            {periods.map((period) => (
              <option key={period.period_key} value={period.period_key}>
                {period.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="coh-add-label">Report date</span>
          <input
            className="edit-input"
            type="date"
            value={reportDate}
            onChange={(e) => setReportDate(e.target.value)}
          />
        </label>
        <label>
          <span className="coh-add-label">Contributions</span>
          <input
            className="edit-input"
            type="number"
            step={1}
            value={contributions}
            onChange={(e) => setContributions(e.target.value)}
          />
        </label>
        <label>
          <span className="coh-add-label">Expenditures</span>
          <input
            className="edit-input"
            type="number"
            step={1}
            value={expenditures}
            onChange={(e) => setExpenditures(e.target.value)}
          />
        </label>
        <label>
          <span className="coh-add-label">COH</span>
          <input
            className="edit-input"
            type="number"
            step={1}
            value={cashOnHand}
            onChange={(e) => setCashOnHand(e.target.value)}
          />
        </label>
        <button type="button" className="coh-add-button" onClick={handleAdd} disabled={!periodKey}>
          Add report
        </button>
      </div>
    </div>
  );
}
