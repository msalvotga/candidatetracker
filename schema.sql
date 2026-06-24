-- Texas candidate lookup — SQLite schema
-- Five UI tabs map to offices.category: house | senate | sboe | statewide | congressional

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS offices (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('house', 'senate', 'sboe', 'statewide', 'congressional')),
  district INTEGER,
  office_code TEXT NOT NULL UNIQUE,
  office_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  seat_holder_name TEXT,
  seat_holder_party TEXT CHECK (seat_holder_party IS NULL OR seat_holder_party IN ('R', 'D', 'I', 'L', 'G', 'O'))
);

CREATE INDEX IF NOT EXISTS idx_offices_category_sort ON offices(category, sort_order, district);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  cycle_year INTEGER NOT NULL,
  party TEXT NOT NULL CHECK (party IN ('R', 'D', 'I', 'L', 'G', 'O')),
  name TEXT NOT NULL DEFAULT '',
  is_incumbent INTEGER NOT NULL DEFAULT 0 CHECK (is_incumbent IN (0, 1)),
  withdrew INTEGER NOT NULL DEFAULT 0 CHECK (withdrew IN (0, 1)),
  filed INTEGER NOT NULL DEFAULT 0 CHECK (filed IN (0, 1)),
  running_for_reelection TEXT,
  tec_filer_id TEXT,
  consultant TEXT,
  endorsements TEXT,
  notes TEXT,
  website TEXT,
  social_media TEXT,
  race_category TEXT,
  vuid TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_office_cycle ON candidates(office_id, cycle_year);
CREATE INDEX IF NOT EXISTS idx_candidates_lookup ON candidates(office_id, cycle_year, party, name);

CREATE TABLE IF NOT EXISTS election_results (
  id INTEGER PRIMARY KEY,
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  cycle_year INTEGER NOT NULL,
  election_type TEXT NOT NULL CHECK (election_type IN ('primary', 'runoff', 'general')),
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
  candidate_name TEXT NOT NULL,
  party TEXT NOT NULL,
  votes INTEGER,
  vote_pct REAL,
  won INTEGER NOT NULL DEFAULT 0 CHECK (won IN (0, 1)),
  source TEXT,
  UNIQUE (office_id, cycle_year, election_type, party, candidate_name)
);

CREATE INDEX IF NOT EXISTS idx_results_office_cycle ON election_results(office_id, cycle_year);

-- Canonical TEC filing periods (extensible via Data tab)
CREATE TABLE IF NOT EXISTS filing_periods (
  period_key TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL,
  default_report_period_end TEXT
);

CREATE INDEX IF NOT EXISTS idx_filing_periods_sort ON filing_periods(sort_order);

CREATE TABLE IF NOT EXISTS finance_reports (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  period_key TEXT REFERENCES filing_periods(period_key),
  report_period_end TEXT NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'TEC',
  total_raised REAL,
  total_spent REAL,
  cash_on_hand REAL,
  debt REAL,
  filed_at TEXT,
  source_url TEXT,
  UNIQUE (candidate_id, report_period_end, report_type)
);

CREATE INDEX IF NOT EXISTS idx_finance_candidate ON finance_reports(candidate_id);

-- Mirrors spreadsheet rows (incumbent/challenger metadata only — finance lives in finance_reports)
CREATE TABLE IF NOT EXISTS race_sheet_rows (
  id INTEGER PRIMARY KEY,
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  cycle_year INTEGER NOT NULL,
  category TEXT NOT NULL,
  row_order INTEGER NOT NULL,
  incumbent_name TEXT NOT NULL DEFAULT '',
  incumbent_party TEXT,
  running_for_reelection TEXT,
  candidate_name TEXT NOT NULL DEFAULT '',
  candidate_party TEXT,
  filed INTEGER NOT NULL DEFAULT 0 CHECK (filed IN (0, 1)),
  tec_filer_id TEXT,
  consultant TEXT,
  endorsements TEXT,
  notes TEXT,
  social_media TEXT,
  website TEXT,
  race_category TEXT
);

CREATE INDEX IF NOT EXISTS idx_sheet_rows_category ON race_sheet_rows(category, cycle_year, row_order);
