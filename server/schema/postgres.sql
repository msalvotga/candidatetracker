-- Election Night Tracker — PostgreSQL schema (idempotent)

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS manual_elections (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  data_json TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT 'manual-default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  FOREIGN KEY (source_id) REFERENCES data_sources(id)
);
CREATE INDEX IF NOT EXISTS idx_manual_elections_updated ON manual_elections(updated_at);

CREATE TABLE IF NOT EXISTS election_snapshots (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  label TEXT,
  payload_json TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_snapshots_provider_ext ON election_snapshots(provider, external_id);

CREATE TABLE IF NOT EXISTS sos_results (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'sos-civix',
  election_id TEXT NOT NULL,
  election_label TEXT,
  payload_json TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_sos_results_election ON sos_results(election_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS sos_candidate_results (
  id BIGSERIAL PRIMARY KEY,
  election_id TEXT NOT NULL,
  election_label TEXT,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_sos_candidate_results_fetch ON sos_candidate_results(election_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS sos_county_results (
  id BIGSERIAL PRIMARY KEY,
  election_id TEXT NOT NULL,
  election_label TEXT,
  county_name TEXT NOT NULL,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_sos_county_results_fetch ON sos_county_results(election_id, county_name, fetched_at DESC);

CREATE TABLE IF NOT EXISTS county_results (
  id BIGSERIAL PRIMARY KEY,
  election_id TEXT NOT NULL DEFAULT '56181',
  county_id TEXT NOT NULL,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  ballots_cast BIGINT NOT NULL DEFAULT 0,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  over_votes BIGINT NOT NULL DEFAULT 0,
  under_votes BIGINT NOT NULL DEFAULT 0,
  line_number INTEGER,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_county_results_fetch ON county_results(county_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS county_historical_results (
  id BIGSERIAL PRIMARY KEY,
  county_name TEXT NOT NULL,
  county_key TEXT NOT NULL,
  year INTEGER NOT NULL,
  office_name TEXT NOT NULL DEFAULT '',
  office_key TEXT NOT NULL DEFAULT '',
  election_type TEXT NOT NULL,
  election_type_key TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  party_name TEXT,
  party_key TEXT NOT NULL DEFAULT '',
  votes BIGINT NOT NULL DEFAULT 0,
  is_total_votes SMALLINT NOT NULL DEFAULT 0,
  is_registered_voters SMALLINT NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_county_historical_results_lookup
  ON county_historical_results(county_key, election_type_key, year DESC, sort_order);

CREATE TABLE IF NOT EXISTS election_source_configs (
  election_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  is_enabled SMALLINT NOT NULL DEFAULT 1,
  auto_refresh_enabled SMALLINT NOT NULL DEFAULT 1,
  sos_countyinfo_url TEXT,
  harris_source_url TEXT,
  galveston_source_url TEXT,
  jefferson_source_url TEXT,
  montgomery_source_url TEXT,
  chambers_source_url TEXT,
  uses_civix_sos SMALLINT NOT NULL DEFAULT 1,
  show_in_catalog SMALLINT NOT NULL DEFAULT 1,
  is_default_catalog SMALLINT NOT NULL DEFAULT 0,
  election_day_estimate BIGINT,
  county_prefer_over_sos_json TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
ALTER TABLE election_source_configs ADD COLUMN IF NOT EXISTS election_day_estimate BIGINT;

CREATE TABLE IF NOT EXISTS vote_update_history (
  id BIGSERIAL PRIMARY KEY,
  election_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  mail_votes BIGINT NOT NULL DEFAULT 0,
  county_key TEXT NOT NULL DEFAULT '',
  sos_race_id TEXT NOT NULL DEFAULT '',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
ALTER TABLE vote_update_history ADD COLUMN IF NOT EXISTS mail_votes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE vote_update_history ADD COLUMN IF NOT EXISTS county_key TEXT NOT NULL DEFAULT '';
ALTER TABLE vote_update_history ADD COLUMN IF NOT EXISTS sos_race_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_vote_update_history_lookup
  ON vote_update_history(election_id, source_key, contest_name, choice_name, party_name, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_vote_update_history_race
  ON vote_update_history(election_id, sos_race_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS county_harris_results (
  id BIGSERIAL PRIMARY KEY,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  ballots_cast BIGINT NOT NULL DEFAULT 0,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  over_votes BIGINT NOT NULL DEFAULT 0,
  under_votes BIGINT NOT NULL DEFAULT 0,
  line_number INTEGER,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_county_harris_results_fetch ON county_harris_results(fetched_at DESC);

CREATE TABLE IF NOT EXISTS county_galveston_results (
  id BIGSERIAL PRIMARY KEY,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  ballots_cast BIGINT NOT NULL DEFAULT 0,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  over_votes BIGINT NOT NULL DEFAULT 0,
  under_votes BIGINT NOT NULL DEFAULT 0,
  line_number INTEGER,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_county_galveston_results_fetch ON county_galveston_results(fetched_at DESC);

CREATE TABLE IF NOT EXISTS county_jefferson_results (
  id BIGSERIAL PRIMARY KEY,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  ballots_cast BIGINT NOT NULL DEFAULT 0,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  over_votes BIGINT NOT NULL DEFAULT 0,
  under_votes BIGINT NOT NULL DEFAULT 0,
  line_number INTEGER,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_county_jefferson_results_fetch ON county_jefferson_results(fetched_at DESC);

CREATE TABLE IF NOT EXISTS county_chambers_results (
  id BIGSERIAL PRIMARY KEY,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  ballots_cast BIGINT NOT NULL DEFAULT 0,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  over_votes BIGINT NOT NULL DEFAULT 0,
  under_votes BIGINT NOT NULL DEFAULT 0,
  line_number INTEGER,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_county_chambers_results_fetch ON county_chambers_results(fetched_at DESC);

CREATE TABLE IF NOT EXISTS county_montgomery_results (
  id BIGSERIAL PRIMARY KEY,
  contest_name TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  percent_of_votes TEXT,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  ballots_cast BIGINT NOT NULL DEFAULT 0,
  precinct_total INTEGER NOT NULL DEFAULT 0,
  precinct_reporting INTEGER NOT NULL DEFAULT 0,
  over_votes BIGINT NOT NULL DEFAULT 0,
  under_votes BIGINT NOT NULL DEFAULT 0,
  line_number INTEGER,
  source_url TEXT,
  payload_json TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_county_montgomery_results_fetch ON county_montgomery_results(fetched_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS source_import_log (
  id BIGSERIAL PRIMARY KEY,
  source_key TEXT NOT NULL,
  ok SMALLINT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_source_import_log_key_occurred ON source_import_log(source_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS ingest_vendors (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  vendor_tier TEXT NOT NULL DEFAULT 'other',
  handler_key TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS election_feed_sources (
  id BIGSERIAL PRIMARY KEY,
  election_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'county',
  county_key TEXT NOT NULL DEFAULT '',
  civix_county_name TEXT,
  vendor_id TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  hub_page_url TEXT NOT NULL DEFAULT '',
  prefer_over_sos SMALLINT NOT NULL DEFAULT 0,
  is_enabled SMALLINT NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_election_feed_sources_election ON election_feed_sources(election_id);

CREATE TABLE IF NOT EXISTS election_favorite_races (
  election_id TEXT NOT NULL,
  race_id TEXT NOT NULL,
  office_type TEXT NOT NULL DEFAULT '',
  race_title TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (election_id, race_id)
);
CREATE INDEX IF NOT EXISTS idx_election_favorite_races_lookup
  ON election_favorite_races(election_id, sort_order, race_id);

CREATE TABLE IF NOT EXISTS county_sos_race_links (
  election_id TEXT NOT NULL,
  county_key TEXT NOT NULL,
  county_contest_name TEXT NOT NULL,
  sos_race_id TEXT NOT NULL,
  sos_race_name TEXT,
  link_type TEXT NOT NULL DEFAULT 'manual',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (election_id, county_key, county_contest_name)
);

CREATE TABLE IF NOT EXISTS county_sos_manual_votes (
  election_id TEXT NOT NULL,
  county_key TEXT NOT NULL,
  sos_race_id TEXT NOT NULL,
  sos_candidate_id TEXT NOT NULL,
  choice_name TEXT NOT NULL,
  party_name TEXT,
  early_votes BIGINT NOT NULL DEFAULT 0,
  election_day_votes BIGINT NOT NULL DEFAULT 0,
  total_votes BIGINT NOT NULL DEFAULT 0,
  mail_votes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (election_id, county_key, sos_race_id, sos_candidate_id)
);
ALTER TABLE county_sos_manual_votes ADD COLUMN IF NOT EXISTS mail_votes BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS county_sos_race_vote_source (
  election_id TEXT NOT NULL,
  county_key TEXT NOT NULL,
  sos_race_id TEXT NOT NULL,
  vote_source TEXT NOT NULL DEFAULT 'sos',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (election_id, county_key, sos_race_id)
);

CREATE TABLE IF NOT EXISTS county_sos_candidate_links (
  election_id TEXT NOT NULL,
  county_key TEXT NOT NULL,
  sos_race_id TEXT NOT NULL,
  county_choice_name TEXT NOT NULL,
  sos_candidate_id TEXT NOT NULL,
  sos_candidate_name TEXT,
  county_contest_name TEXT,
  link_type TEXT NOT NULL DEFAULT 'manual',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (election_id, county_key, sos_race_id, county_choice_name)
);

CREATE TABLE IF NOT EXISTS ev_roster_configs (
  evr_election_id INTEGER PRIMARY KEY,
  party TEXT NOT NULL,
  election_name TEXT NOT NULL,
  election_date TEXT NOT NULL,
  is_enabled SMALLINT NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS ev_roster_pulls (
  id BIGSERIAL PRIMARY KEY,
  evr_election_id INTEGER NOT NULL,
  voting_date TEXT NOT NULL,
  hub_page_url TEXT,
  sos_turnout_url TEXT,
  sos_roster_url TEXT,
  statewide_voter_count BIGINT NOT NULL DEFAULT 0,
  raw_record_count BIGINT NOT NULL DEFAULT 0,
  deduped_voter_count BIGINT NOT NULL DEFAULT 0,
  pulled_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  ok SMALLINT NOT NULL DEFAULT 1,
  message TEXT NOT NULL DEFAULT '',
  UNIQUE(evr_election_id, voting_date)
);
CREATE INDEX IF NOT EXISTS idx_ev_roster_pulls_election ON ev_roster_pulls(evr_election_id, voting_date DESC);

CREATE TABLE IF NOT EXISTS ev_roster_county_summary (
  id BIGSERIAL PRIMARY KEY,
  pull_id BIGINT NOT NULL REFERENCES ev_roster_pulls(id) ON DELETE CASCADE,
  county_name TEXT NOT NULL,
  county_id INTEGER,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  in_person_votes_on_date BIGINT NOT NULL DEFAULT 0,
  total_in_person_votes_for_election BIGINT NOT NULL DEFAULT 0,
  total_mail_votes_for_election BIGINT NOT NULL DEFAULT 0,
  cumulative_total BIGINT NOT NULL DEFAULT 0,
  sos_voter_count BIGINT NOT NULL DEFAULT 0,
  county_voter_count BIGINT NOT NULL DEFAULT 0,
  chosen_source TEXT NOT NULL DEFAULT 'sos',
  chosen_voter_count BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ev_roster_county_pull ON ev_roster_county_summary(pull_id, county_name);

CREATE TABLE IF NOT EXISTS ev_roster_voters (
  id BIGSERIAL PRIMARY KEY,
  evr_election_id INTEGER NOT NULL,
  voting_date TEXT NOT NULL,
  county_name TEXT NOT NULL,
  vuid TEXT NOT NULL,
  voter_name TEXT,
  voting_method TEXT,
  precinct TEXT,
  source TEXT NOT NULL DEFAULT 'sos',
  party TEXT,
  method_code TEXT,
  reporting_date TEXT,
  UNIQUE(evr_election_id, voting_date, county_name, vuid)
);
CREATE INDEX IF NOT EXISTS idx_ev_roster_voters_lookup ON ev_roster_voters(evr_election_id, voting_date, county_name);

CREATE TABLE IF NOT EXISTS ev_roster_county_sources (
  id BIGSERIAL PRIMARY KEY,
  evr_election_id INTEGER NOT NULL,
  county_key TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT 'sos-default',
  source_label TEXT NOT NULL DEFAULT 'SOS default',
  civix_county_name TEXT NOT NULL,
  civix_county_id INTEGER,
  handler_key TEXT NOT NULL DEFAULT 'civix_sos_county_slice',
  hub_page_url TEXT NOT NULL DEFAULT '',
  roster_url TEXT NOT NULL DEFAULT '',
  voting_method_scope TEXT NOT NULL DEFAULT 'ALL',
  date_scope TEXT NOT NULL DEFAULT 'SINGLE_DAY',
  file_format TEXT NOT NULL DEFAULT 'auto',
  roster_party_scope TEXT NOT NULL DEFAULT 'COMBINED',
  discovery_profile_key TEXT,
  training_notes TEXT,
  is_enabled SMALLINT NOT NULL DEFAULT 1,
  last_pull_ok SMALLINT,
  last_pull_message TEXT,
  last_pull_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  UNIQUE(evr_election_id, county_key, variant_key)
);
CREATE INDEX IF NOT EXISTS idx_ev_roster_county_sources_election ON ev_roster_county_sources(evr_election_id);

CREATE TABLE IF NOT EXISTS ev_roster_county_pull_log (
  id BIGSERIAL PRIMARY KEY,
  pull_id BIGINT NOT NULL REFERENCES ev_roster_pulls(id) ON DELETE CASCADE,
  county_key TEXT NOT NULL,
  county_name TEXT NOT NULL,
  handler_key TEXT NOT NULL,
  ok SMALLINT NOT NULL,
  voter_count BIGINT NOT NULL DEFAULT 0,
  source_url TEXT,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ev_roster_county_pull_log ON ev_roster_county_pull_log(pull_id, county_key);

CREATE TABLE IF NOT EXISTS ev_roster_county_pull_status (
  id BIGSERIAL PRIMARY KEY,
  evr_election_id INTEGER NOT NULL,
  voting_date TEXT NOT NULL,
  county_name TEXT NOT NULL,
  county_key TEXT,
  last_pull_ok SMALLINT,
  last_pull_at TIMESTAMPTZ,
  last_pull_message TEXT,
  voter_count BIGINT NOT NULL DEFAULT 0,
  confirmed_at TIMESTAMPTZ,
  UNIQUE(evr_election_id, voting_date, county_name)
);
CREATE INDEX IF NOT EXISTS idx_ev_roster_county_pull_status ON ev_roster_county_pull_status(evr_election_id, voting_date);

CREATE TABLE IF NOT EXISTS ev_roster_activity_cache (
  evr_election_id INTEGER NOT NULL,
  voting_date TEXT NOT NULL,
  county_name TEXT NOT NULL,
  method_code TEXT NOT NULL,
  voter_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (evr_election_id, voting_date, county_name, method_code)
);
CREATE INDEX IF NOT EXISTS idx_ev_roster_activity_cache_lookup ON ev_roster_activity_cache(evr_election_id, voting_date);

CREATE TABLE IF NOT EXISTS ev_roster_registered_cache (
  evr_election_id INTEGER NOT NULL,
  county_name TEXT NOT NULL,
  county_id INTEGER,
  registered_voters BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (evr_election_id, county_name)
);

-- Seed rows (match SQLite defaults)
INSERT INTO data_sources (id, kind, display_name, notes) VALUES
  ('manual-default', 'manual_json', 'Manual JSON upload', 'Rows in manual_elections'),
  ('sos-civix', 'sos', 'Texas SOS Civix ENR', 'Live SOS results from Civix ENR'),
  ('county-harrisvotes', 'county', 'Harris Votes', 'County-level JSON feed'),
  ('county-galveston-clarity', 'county', 'Galveston Clarity', 'summary.zip'),
  ('county-jefferson-clarity', 'county', 'Jefferson Clarity', 'summary.zip'),
  ('county-chambers', 'county', 'Chambers County', 'County table provisioned'),
  ('county-montgomery', 'county', 'Montgomery County', 'County table provisioned')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_settings (setting_key, value_json) VALUES
  ('disable_auto_ingest', 'false'),
  ('auto_refresh_enabled', 'false'),
  ('auto_refresh_interval_sec', '60'),
  ('display_time_zone', 'America/Chicago'),
  ('sos_countyinfo_url', ''),
  ('harris_source_url', ''),
  ('galveston_source_url', ''),
  ('jefferson_source_url', ''),
  ('montgomery_source_url', ''),
  ('chambers_source_url', '')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO election_source_configs
  (election_id, label, is_enabled, auto_refresh_enabled, sos_countyinfo_url, harris_source_url, galveston_source_url, jefferson_source_url, montgomery_source_url, chambers_source_url)
VALUES
  ('56181', 'May 2, 2026 Special Election', 1, 1, '', '', '', '', '', '')
ON CONFLICT (election_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ballot_lookup_chunks (
  chunk_no INTEGER PRIMARY KEY,
  bytes BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS county_roster_documents (
  doc_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  payload_text TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS county_roster_raw_files (
  county_key TEXT NOT NULL,
  pulled_stamp TEXT NOT NULL,
  file_name TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  body BYTEA NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  PRIMARY KEY (county_key, pulled_stamp, file_name)
);

INSERT INTO ev_roster_configs (evr_election_id, party, election_name, election_date, notes) VALUES
  (58315, 'REP', '2026 REPUBLICAN PRIMARY RUNOFF ELECTION', '05/26/2026', 'Civix EVR'),
  (58314, 'DEM', '2026 DEMOCRATIC PRIMARY RUNOFF ELECTION', '05/26/2026', 'Civix EVR')
ON CONFLICT (evr_election_id) DO NOTHING;
