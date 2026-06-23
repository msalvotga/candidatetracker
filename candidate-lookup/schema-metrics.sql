-- Per-office metrics: trump/cruz/abbott and leg_* store R% − D% margin as decimal (0.136 = R+13.6)

CREATE TABLE IF NOT EXISTS office_metrics (
  office_id INTEGER PRIMARY KEY REFERENCES offices(id) ON DELETE CASCADE,
  trump_2024 REAL,
  cruz_2024 REAL,
  abbott_2022 REAL,
  leg_2024 REAL,
  leg_2022 REAL
);

-- County-level results for heat maps (margin = GOP share minus Dem share)
CREATE TABLE IF NOT EXISTS county_election_results (
  id INTEGER PRIMARY KEY,
  election_key TEXT NOT NULL CHECK (election_key IN ('pres_2024', 'cruz_2024', 'abbott_2022')),
  county_name TEXT NOT NULL,
  county_key TEXT NOT NULL,
  margin REAL,
  gop_pct REAL,
  dem_pct REAL,
  gop_votes INTEGER,
  dem_votes INTEGER,
  UNIQUE (election_key, county_key)
);

CREATE INDEX IF NOT EXISTS idx_county_election ON county_election_results(election_key, county_key);

-- Candidate-level results behind each office metric chip (leg races from TED, etc.)
CREATE TABLE IF NOT EXISTS metric_contest_candidates (
  id INTEGER PRIMARY KEY,
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  party TEXT NOT NULL,
  votes INTEGER,
  vote_pct REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  unopposed INTEGER NOT NULL DEFAULT 0 CHECK (unopposed IN (0, 1)),
  contest_name TEXT,
  source TEXT,
  UNIQUE (office_id, metric_key, candidate_name, party)
);

CREATE INDEX IF NOT EXISTS idx_metric_contest_lookup ON metric_contest_candidates(office_id, metric_key);

-- Append-only COH snapshots added in the app (spreadsheet July/Jan values stay on race_sheet_rows)
CREATE TABLE IF NOT EXISTS candidate_coh_history (
  id INTEGER PRIMARY KEY,
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  cycle_year INTEGER NOT NULL,
  candidate_name TEXT NOT NULL,
  party TEXT NOT NULL,
  is_incumbent INTEGER NOT NULL DEFAULT 0 CHECK (is_incumbent IN (0, 1)),
  period_label TEXT NOT NULL,
  report_period_end TEXT,
  cash_on_hand REAL NOT NULL,
  UNIQUE (office_id, cycle_year, candidate_name, party, is_incumbent, period_label)
);

CREATE INDEX IF NOT EXISTS idx_coh_history_lookup
  ON candidate_coh_history(office_id, cycle_year, candidate_name, party, is_incumbent);
