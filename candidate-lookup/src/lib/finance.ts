import type { FinanceReportEntry, PendingFinanceEntry, RaceCandidate } from "../types";

export interface FilingPeriodDef {
  period_key: string;
  label: string;
  sort_order: number;
  default_report_period_end: string | null;
}

const DEFAULT_FILING_PERIODS: FilingPeriodDef[] = [
  { period_key: "july_25", label: "July '25", sort_order: 0, default_report_period_end: "2025-07-31" },
  { period_key: "jan_26", label: "Jan '26", sort_order: 1, default_report_period_end: "2026-01-31" },
  { period_key: "primary_30day_26", label: "Primary 30-day", sort_order: 2, default_report_period_end: "label:primary_30day_26" },
  { period_key: "primary_8day_26", label: "Primary 8-day", sort_order: 3, default_report_period_end: "label:primary_8day_26" },
  { period_key: "july_26", label: "July '26", sort_order: 4, default_report_period_end: "2026-07-31" },
  { period_key: "general_30day_26", label: "General 30-day", sort_order: 5, default_report_period_end: "label:general_30day_26" },
  { period_key: "general_8day_26", label: "General 8-day", sort_order: 6, default_report_period_end: "label:general_8day_26" },
];

let filingPeriods: FilingPeriodDef[] = [...DEFAULT_FILING_PERIODS];

export function setFilingPeriods(periods: FilingPeriodDef[]) {
  filingPeriods = periods.length > 0 ? [...periods].sort((a, b) => a.sort_order - b.sort_order) : [...DEFAULT_FILING_PERIODS];
}

export function getFilingPeriods(): FilingPeriodDef[] {
  return filingPeriods;
}

export function formatMoney(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function candidateKey(candidate: Pick<RaceCandidate, "name" | "party" | "is_incumbent">) {
  return `${candidate.name}-${candidate.party}-${candidate.is_incumbent}`;
}

function periodByKey(periodKey: string) {
  return filingPeriods.find((period) => period.period_key === periodKey);
}

function periodByLabel(label: string) {
  const trimmed = label.trim().toLowerCase();
  return filingPeriods.find((period) => period.label.toLowerCase() === trimmed);
}

export function normalizeFilingPeriodKey(labelOrKey: string): string | null {
  const trimmed = String(labelOrKey ?? "").trim();
  if (!trimmed) return null;
  if (periodByKey(trimmed)) return trimmed;
  const byLabel = periodByLabel(trimmed);
  if (byLabel) return byLabel.period_key;
  return null;
}

export function filingPeriodLabel(periodKeyOrLabel: string): string {
  const key = normalizeFilingPeriodKey(periodKeyOrLabel);
  if (key) return periodByKey(key)?.label ?? periodKeyOrLabel;
  return periodKeyOrLabel;
}

export function filingPeriodSortIndex(entry: Pick<FinanceReportEntry, "period_key" | "period_label" | "sort_order">): number {
  if (entry.sort_order != null) return entry.sort_order;
  const key = entry.period_key ?? normalizeFilingPeriodKey(entry.period_label);
  if (key) {
    const period = periodByKey(key);
    if (period) return period.sort_order;
  }
  return 999;
}

export function defaultReportEndForPeriod(periodKey: string): string | null {
  const period = periodByKey(periodKey);
  if (!period?.default_report_period_end) return null;
  if (period.default_report_period_end.startsWith("label:")) return null;
  return period.default_report_period_end;
}

function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

export function formatMostRecentFilingLabel(
  entry: Pick<FinanceReportEntry, "period_key" | "period_label" | "report_period_end">
) {
  if (entry.period_label) return entry.period_label;
  if (entry.period_key) return filingPeriodLabel(entry.period_key);

  const end = entry.report_period_end;
  if (end && !end.startsWith("label:")) {
    const parsed = parseIsoDate(end);
    if (parsed) {
      const month = parsed.toLocaleString("en-US", { month: "short" });
      const year = String(parsed.getFullYear()).slice(-2);
      return `${month} '${year}`;
    }
  }

  return "—";
}

export function mergeFinanceHistory(
  candidate: Pick<RaceCandidate, "finance_history">
): FinanceReportEntry[] {
  return candidate.finance_history ?? [];
}

export function isFinanceReportFilled(
  entry: Pick<FinanceReportEntry, "contributions" | "expenditures" | "cash_on_hand">
) {
  return entry.contributions != null || entry.expenditures != null || entry.cash_on_hand != null;
}

export function sortFinanceHistoryByPeriod(entries: FinanceReportEntry[]): FinanceReportEntry[] {
  return [...entries].sort((a, b) => {
    const ai = filingPeriodSortIndex(a);
    const bi = filingPeriodSortIndex(b);
    if (ai !== bi) return ai - bi;
    const aDate = a.report_period_end ?? "";
    const bDate = b.report_period_end ?? "";
    return aDate.localeCompare(bDate);
  });
}

export function getLatestFilingReport(entries: FinanceReportEntry[]): FinanceReportEntry | null {
  let best: FinanceReportEntry | null = null;
  let bestIndex = -1;

  for (const entry of entries) {
    if (!isFinanceReportFilled(entry)) continue;
    const index = filingPeriodSortIndex(entry);
    if (index >= 0 && index > bestIndex) {
      bestIndex = index;
      best = entry;
    }
  }
  if (best) return best;

  let fallback: FinanceReportEntry | null = null;
  let fallbackDate = "";
  for (const entry of entries) {
    if (!isFinanceReportFilled(entry)) continue;
    const date = entry.report_period_end ?? "";
    if (!fallback || date.localeCompare(fallbackDate) > 0) {
      fallback = entry;
      fallbackDate = date;
    }
  }
  return fallback;
}

export function pendingToFinanceEntries(pending: PendingFinanceEntry[]): FinanceReportEntry[] {
  return pending.map((entry) => ({
    id: entry.localId,
    period_key: entry.period_key,
    period_label: entry.period_label,
    report_period_end: entry.report_period_end,
    contributions: entry.contributions,
    expenditures: entry.expenditures,
    cash_on_hand: entry.cash_on_hand,
    read_only: false,
  }));
}

export function latestFilingForCandidate(
  candidate: RaceCandidate,
  pendingAdds: PendingFinanceEntry[] = []
): FinanceReportEntry | null {
  const key = candidateKey(candidate);
  const pending = pendingAdds.filter((entry) => entry.candidateKey === key);
  const history = [...mergeFinanceHistory(candidate), ...pendingToFinanceEntries(pending)];
  return getLatestFilingReport(history);
}

export function mostRecentFinance(candidate: Pick<RaceCandidate, "finance_history">) {
  const latest = getLatestFilingReport(mergeFinanceHistory(candidate));
  if (!latest) return { label: "COH", value: null as number | null };
  return { label: `${formatMostRecentFilingLabel(latest)} COH`, value: latest.cash_on_hand };
}
