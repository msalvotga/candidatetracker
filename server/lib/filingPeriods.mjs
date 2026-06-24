/** Default filing periods — earliest → latest. Keys are stable DB identifiers. */
export const DEFAULT_FILING_PERIODS = [
  {
    period_key: "july_25",
    label: "July '25",
    sort_order: 0,
    default_report_period_end: "2025-07-31",
  },
  {
    period_key: "jan_26",
    label: "Jan '26",
    sort_order: 1,
    default_report_period_end: "2026-01-31",
  },
  {
    period_key: "primary_30day_26",
    label: "Primary 30-day",
    sort_order: 2,
    default_report_period_end: "label:primary_30day_26",
  },
  {
    period_key: "primary_8day_26",
    label: "Primary 8-day",
    sort_order: 3,
    default_report_period_end: "label:primary_8day_26",
  },
  {
    period_key: "july_26",
    label: "July '26",
    sort_order: 4,
    default_report_period_end: "2026-07-31",
  },
  {
    period_key: "general_30day_26",
    label: "General 30-day",
    sort_order: 5,
    default_report_period_end: "label:general_30day_26",
  },
  {
    period_key: "general_8day_26",
    label: "General 8-day",
    sort_order: 6,
    default_report_period_end: "label:general_8day_26",
  },
];

const LABEL_ALIASES = {
  "july '25": "july_25",
  "july 25": "july_25",
  "jan '26": "jan_26",
  "january '26": "jan_26",
  "jan 26": "jan_26",
  "primary 30-day": "primary_30day_26",
  "primary 30 day": "primary_30day_26",
  "primary 8-day": "primary_8day_26",
  "primary 8 day": "primary_8day_26",
  "july '26": "july_26",
  "july 26": "july_26",
  "general 30-day": "general_30day_26",
  "general 30 day": "general_30day_26",
  "general 8-day": "general_8day_26",
  "general 8 day": "general_8day_26",
};

export function seedFilingPeriods(database) {
  const insert = database.prepare(
    `INSERT INTO filing_periods (period_key, label, sort_order, default_report_period_end)
     VALUES (@period_key, @label, @sort_order, @default_report_period_end)
     ON CONFLICT(period_key) DO NOTHING`
  );
  for (const period of DEFAULT_FILING_PERIODS) {
    insert.run(period);
  }
}

export function listFilingPeriods(database) {
  return database
    .prepare(
      `SELECT period_key, label, sort_order, default_report_period_end
       FROM filing_periods ORDER BY sort_order, period_key`
    )
    .all();
}

export function loadFilingPeriodMaps(database) {
  const periods = listFilingPeriods(database);
  const byKey = new Map(periods.map((p) => [p.period_key, p]));
  const byLabel = new Map(periods.map((p) => [p.label.toLowerCase(), p]));
  const byEnd = new Map();
  for (const period of periods) {
    if (period.default_report_period_end) {
      byEnd.set(period.default_report_period_end, period);
    }
  }
  return { periods, byKey, byLabel, byEnd };
}

export function resolvePeriodKey(periodLabel, reportPeriodEnd, maps) {
  const label = String(periodLabel ?? "").trim();
  if (label) {
    const byKey = maps.byKey.get(label);
    if (byKey) return byKey.period_key;
    const alias = LABEL_ALIASES[label.toLowerCase()];
    if (alias) return alias;
    const byLabel = maps.byLabel.get(label.toLowerCase());
    if (byLabel) return byLabel.period_key;
  }

  const end = String(reportPeriodEnd ?? "").trim();
  if (end) {
    if (end.startsWith("label:")) {
      const key = end.slice(6);
      if (maps.byKey.has(key)) return key;
    }
    const byEnd = maps.byEnd.get(end);
    if (byEnd) return byEnd.period_key;
    if (end === "2025-07-31") return "july_25";
    if (end === "2026-01-31") return "jan_26";
    if (end === "2026-07-31") return "july_26";
  }

  if (label) return `label:${label}`;
  return null;
}

export function periodLabelFromKey(periodKey, maps) {
  if (!periodKey) return "Report";
  const period = maps?.byKey?.get(periodKey);
  if (period) return period.label;
  if (periodKey.startsWith("label:")) return periodKey.slice(6);
  return periodKey;
}

export function canonicalReportEndForPeriod(periodKey, maps, overrideEnd) {
  const end = overrideEnd?.trim();
  if (end) return end;
  const period = maps.byKey.get(periodKey);
  if (period?.default_report_period_end) return period.default_report_period_end;
  if (periodKey) return `label:${periodKey}`;
  return "label:report";
}

export function addFilingPeriod(database, { period_key, label, sort_order, default_report_period_end }) {
  const key = String(period_key ?? "").trim();
  const periodLabel = String(label ?? "").trim();
  if (!key || !periodLabel) throw new Error("period_key and label required");
  const order = Number(sort_order);
  if (!Number.isInteger(order)) throw new Error("sort_order must be an integer");

  database
    .prepare(
      `INSERT INTO filing_periods (period_key, label, sort_order, default_report_period_end)
       VALUES (?, ?, ?, ?)`
    )
    .run(key, periodLabel, order, default_report_period_end?.trim() || null);

  return database.prepare(`SELECT * FROM filing_periods WHERE period_key = ?`).get(key);
}
