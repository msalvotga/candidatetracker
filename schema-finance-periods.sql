-- Canonical TEC filing periods (extensible via Data tab)

CREATE TABLE IF NOT EXISTS filing_periods (
  period_key TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL,
  default_report_period_end TEXT
);

CREATE INDEX IF NOT EXISTS idx_filing_periods_sort ON filing_periods(sort_order);
