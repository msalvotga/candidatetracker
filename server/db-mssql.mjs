import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { resolveVoterActivityDate } from "./lib/evRosterVoterDates.mjs";
import {
  EV_ROSTER_SUMMARY_CACHE_DDL_MSSQL,
  loadSummaryRollupsFromCache,
  rebuildEvRosterSummaryCache,
} from "./lib/evRosterSummaryCache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_MANIFEST = path.join(__dirname, "data", "manual-manifest.json");
const LEGACY_MANUAL_DIR = path.join(__dirname, "data", "manual");

/** @type {import('mssql').ConnectionPool | null} */
let _pool = null;
/** @type {Promise<import('mssql').ConnectionPool> | null} */
let _init = null;

function buildConfig() {
  const server = process.env.MSSQL_SERVER?.trim();
  if (!server) throw new Error("MSSQL_SERVER is required for SQL Server mode");
  const database = process.env.MSSQL_DATABASE?.trim() || "electionnighttracker";
  const user = process.env.MSSQL_USER?.trim();
  const password = process.env.MSSQL_PASSWORD ?? "";
  const encrypt = process.env.MSSQL_ENCRYPT !== "false";
  const trustServerCertificate = process.env.MSSQL_TRUST_CERT !== "false";

  /** @type {import('mssql').config} */
  const config = {
    server,
    database,
    options: {
      encrypt,
      trustServerCertificate,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };

  if (!user) {
    throw new Error(
      "MSSQL_USER is required. The default Node driver (tedious) does not support Windows integrated auth; " +
        "create a SQL login in SSMS (Security → Logins) and set MSSQL_USER / MSSQL_PASSWORD, or use the " +
        "mssql/msnodesqlv8 driver with trustedConnection (not wired in this project yet).",
    );
  }
  config.user = user;
  config.password = password;

  return { config };
}

const SCHEMA_SQL = `
IF OBJECT_ID(N'dbo.data_sources', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.data_sources (
    id NVARCHAR(128) NOT NULL CONSTRAINT PK_data_sources PRIMARY KEY,
    kind NVARCHAR(64) NOT NULL,
    display_name NVARCHAR(256) NOT NULL,
    notes NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_data_sources_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_data_sources_updated DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.manual_elections', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.manual_elections (
    id NVARCHAR(128) NOT NULL CONSTRAINT PK_manual_elections PRIMARY KEY,
    label NVARCHAR(512) NOT NULL,
    data_json NVARCHAR(MAX) NOT NULL,
    source_id NVARCHAR(128) NOT NULL CONSTRAINT DF_manual_elections_source DEFAULT (N'manual-default'),
    created_at DATETIME2 NOT NULL CONSTRAINT DF_manual_elections_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_manual_elections_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_manual_elections_data_sources FOREIGN KEY (source_id) REFERENCES dbo.data_sources (id)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_manual_elections_updated' AND object_id = OBJECT_ID(N'dbo.manual_elections'))
  CREATE INDEX idx_manual_elections_updated ON dbo.manual_elections (updated_at);

IF OBJECT_ID(N'dbo.election_snapshots', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.election_snapshots (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_election_snapshots PRIMARY KEY,
    provider NVARCHAR(64) NOT NULL,
    external_id NVARCHAR(256) NOT NULL,
    label NVARCHAR(512) NULL,
    payload_json NVARCHAR(MAX) NOT NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_election_snapshots_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_snapshots_provider_ext' AND object_id = OBJECT_ID(N'dbo.election_snapshots'))
  CREATE INDEX idx_snapshots_provider_ext ON dbo.election_snapshots (provider, external_id);

IF OBJECT_ID(N'dbo.sos_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sos_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_sos_results PRIMARY KEY,
    provider NVARCHAR(64) NOT NULL CONSTRAINT DF_sos_results_provider DEFAULT (N'sos-civix'),
    election_id NVARCHAR(128) NOT NULL,
    election_label NVARCHAR(512) NULL,
    payload_json NVARCHAR(MAX) NOT NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_sos_results_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_sos_results_election' AND object_id = OBJECT_ID(N'dbo.sos_results'))
  CREATE INDEX idx_sos_results_election ON dbo.sos_results (election_id, fetched_at DESC);

IF OBJECT_ID(N'dbo.sos_candidate_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sos_candidate_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_sos_candidate_results PRIMARY KEY,
    election_id NVARCHAR(128) NOT NULL,
    election_label NVARCHAR(512) NULL,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_sos_candidate_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_sos_candidate_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_sos_candidate_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    precinct_total INT NOT NULL CONSTRAINT DF_sos_candidate_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_sos_candidate_pr DEFAULT (0),
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_sos_candidate_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_sos_candidate_results_fetch' AND object_id = OBJECT_ID(N'dbo.sos_candidate_results'))
  CREATE INDEX idx_sos_candidate_results_fetch ON dbo.sos_candidate_results (election_id, fetched_at DESC);

IF OBJECT_ID(N'dbo.sos_county_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sos_county_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_sos_county_results PRIMARY KEY,
    election_id NVARCHAR(128) NOT NULL,
    election_label NVARCHAR(512) NULL,
    county_name NVARCHAR(128) NOT NULL,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_sos_county_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_sos_county_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_sos_county_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    precinct_total INT NOT NULL CONSTRAINT DF_sos_county_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_sos_county_pr DEFAULT (0),
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_sos_county_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_sos_county_results_fetch' AND object_id = OBJECT_ID(N'dbo.sos_county_results'))
  CREATE INDEX idx_sos_county_results_fetch ON dbo.sos_county_results (election_id, county_name, fetched_at DESC);

IF OBJECT_ID(N'dbo.county_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_county_results PRIMARY KEY,
    election_id NVARCHAR(128) NOT NULL CONSTRAINT DF_county_results_election DEFAULT (N'56181'),
    county_id NVARCHAR(64) NOT NULL,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_county_results_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_county_results_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_county_results_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_county_results_rv DEFAULT (0),
    ballots_cast BIGINT NOT NULL CONSTRAINT DF_county_results_bc DEFAULT (0),
    precinct_total INT NOT NULL CONSTRAINT DF_county_results_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_county_results_pr DEFAULT (0),
    over_votes BIGINT NOT NULL CONSTRAINT DF_county_results_ov DEFAULT (0),
    under_votes BIGINT NOT NULL CONSTRAINT DF_county_results_uv DEFAULT (0),
    line_number INT NULL,
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_county_results_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF COL_LENGTH(N'dbo.county_results', N'election_id') IS NULL
BEGIN
  ALTER TABLE dbo.county_results ADD election_id NVARCHAR(128) NOT NULL CONSTRAINT DF_county_results_election_late DEFAULT (N'56181');
END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.county_results') AND name = N'curr_in')
BEGIN
  -- no-op: legacy column removed
END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.county_results') AND name = N'old_in')
BEGIN
  -- no-op: legacy column removed
END;

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.county_results') AND name = N'curr_in')
BEGIN
  DECLARE @df_curr NVARCHAR(128);
  SELECT @df_curr = dc.name
  FROM sys.default_constraints dc
  JOIN sys.columns c ON c.default_object_id = dc.object_id
  WHERE dc.parent_object_id = OBJECT_ID(N'dbo.county_results') AND c.name = N'curr_in';
  IF @df_curr IS NOT NULL EXEC(N'ALTER TABLE dbo.county_results DROP CONSTRAINT ' + QUOTENAME(@df_curr) + N';');
  ALTER TABLE dbo.county_results DROP COLUMN curr_in;
END;

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.county_results') AND name = N'old_in')
BEGIN
  DECLARE @df_old NVARCHAR(128);
  SELECT @df_old = dc.name
  FROM sys.default_constraints dc
  JOIN sys.columns c ON c.default_object_id = dc.object_id
  WHERE dc.parent_object_id = OBJECT_ID(N'dbo.county_results') AND c.name = N'old_in';
  IF @df_old IS NOT NULL EXEC(N'ALTER TABLE dbo.county_results DROP CONSTRAINT ' + QUOTENAME(@df_old) + N';');
  ALTER TABLE dbo.county_results DROP COLUMN old_in;
END;

IF OBJECT_ID(N'dbo.county_harris_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_harris_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_county_harris_results PRIMARY KEY,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_county_harris_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_county_harris_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_county_harris_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_county_harris_rv DEFAULT (0),
    ballots_cast BIGINT NOT NULL CONSTRAINT DF_county_harris_bc DEFAULT (0),
    precinct_total INT NOT NULL CONSTRAINT DF_county_harris_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_county_harris_pr DEFAULT (0),
    over_votes BIGINT NOT NULL CONSTRAINT DF_county_harris_ov DEFAULT (0),
    under_votes BIGINT NOT NULL CONSTRAINT DF_county_harris_uv DEFAULT (0),
    line_number INT NULL,
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_county_harris_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.county_galveston_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_galveston_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_county_galveston_results PRIMARY KEY,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_county_galveston_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_county_galveston_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_county_galveston_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_county_galveston_rv DEFAULT (0),
    ballots_cast BIGINT NOT NULL CONSTRAINT DF_county_galveston_bc DEFAULT (0),
    precinct_total INT NOT NULL CONSTRAINT DF_county_galveston_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_county_galveston_pr DEFAULT (0),
    over_votes BIGINT NOT NULL CONSTRAINT DF_county_galveston_ov DEFAULT (0),
    under_votes BIGINT NOT NULL CONSTRAINT DF_county_galveston_uv DEFAULT (0),
    line_number INT NULL,
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_county_galveston_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.county_jefferson_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_jefferson_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_county_jefferson_results PRIMARY KEY,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_county_jefferson_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_county_jefferson_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_county_jefferson_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_county_jefferson_rv DEFAULT (0),
    ballots_cast BIGINT NOT NULL CONSTRAINT DF_county_jefferson_bc DEFAULT (0),
    precinct_total INT NOT NULL CONSTRAINT DF_county_jefferson_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_county_jefferson_pr DEFAULT (0),
    over_votes BIGINT NOT NULL CONSTRAINT DF_county_jefferson_ov DEFAULT (0),
    under_votes BIGINT NOT NULL CONSTRAINT DF_county_jefferson_uv DEFAULT (0),
    line_number INT NULL,
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_county_jefferson_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.county_chambers_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_chambers_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_county_chambers_results PRIMARY KEY,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_county_chambers_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_county_chambers_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_county_chambers_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_county_chambers_rv DEFAULT (0),
    ballots_cast BIGINT NOT NULL CONSTRAINT DF_county_chambers_bc DEFAULT (0),
    precinct_total INT NOT NULL CONSTRAINT DF_county_chambers_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_county_chambers_pr DEFAULT (0),
    over_votes BIGINT NOT NULL CONSTRAINT DF_county_chambers_ov DEFAULT (0),
    under_votes BIGINT NOT NULL CONSTRAINT DF_county_chambers_uv DEFAULT (0),
    line_number INT NULL,
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_county_chambers_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.county_montgomery_results', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_montgomery_results (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_county_montgomery_results PRIMARY KEY,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_county_montgomery_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_county_montgomery_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_county_montgomery_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_county_montgomery_rv DEFAULT (0),
    ballots_cast BIGINT NOT NULL CONSTRAINT DF_county_montgomery_bc DEFAULT (0),
    precinct_total INT NOT NULL CONSTRAINT DF_county_montgomery_pt DEFAULT (0),
    precinct_reporting INT NOT NULL CONSTRAINT DF_county_montgomery_pr DEFAULT (0),
    over_votes BIGINT NOT NULL CONSTRAINT DF_county_montgomery_ov DEFAULT (0),
    under_votes BIGINT NOT NULL CONSTRAINT DF_county_montgomery_uv DEFAULT (0),
    line_number INT NULL,
    source_url NVARCHAR(1024) NULL,
    payload_json NVARCHAR(MAX) NULL,
    fetched_at DATETIME2 NOT NULL CONSTRAINT DF_county_montgomery_fetched DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.app_settings', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_settings (
    setting_key NVARCHAR(128) NOT NULL CONSTRAINT PK_app_settings PRIMARY KEY,
    value_json NVARCHAR(MAX) NOT NULL,
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_app_settings_updated DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.source_import_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.source_import_log (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_source_import_log PRIMARY KEY,
    source_key NVARCHAR(64) NOT NULL,
    ok BIT NOT NULL,
    message NVARCHAR(MAX) NOT NULL,
    occurred_at DATETIME2 NOT NULL CONSTRAINT DF_source_import_log_occurred DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.election_source_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.election_source_configs (
    election_id NVARCHAR(128) NOT NULL CONSTRAINT PK_election_source_configs PRIMARY KEY,
    label NVARCHAR(256) NOT NULL,
    is_enabled BIT NOT NULL CONSTRAINT DF_election_source_enabled DEFAULT (1),
    auto_refresh_enabled BIT NOT NULL CONSTRAINT DF_election_source_auto DEFAULT (1),
    sos_countyinfo_url NVARCHAR(2048) NULL,
    harris_source_url NVARCHAR(2048) NULL,
    galveston_source_url NVARCHAR(2048) NULL,
    jefferson_source_url NVARCHAR(2048) NULL,
    montgomery_source_url NVARCHAR(2048) NULL,
    chambers_source_url NVARCHAR(2048) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_election_source_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_election_source_updated DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.ingest_vendors', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ingest_vendors (
    id NVARCHAR(64) NOT NULL CONSTRAINT PK_ingest_vendors PRIMARY KEY,
    display_name NVARCHAR(256) NOT NULL,
    vendor_tier NVARCHAR(32) NOT NULL CONSTRAINT DF_ingest_vendors_tier DEFAULT (N'other'),
    handler_key NVARCHAR(64) NOT NULL,
    notes NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_ingest_vendors_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_ingest_vendors_updated DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.election_feed_sources', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.election_feed_sources (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_election_feed_sources PRIMARY KEY,
    election_id NVARCHAR(128) NOT NULL,
    scope NVARCHAR(32) NOT NULL CONSTRAINT DF_election_feed_scope DEFAULT (N'county'),
    county_key NVARCHAR(64) NOT NULL CONSTRAINT DF_election_feed_county DEFAULT (N''),
    civix_county_name NVARCHAR(128) NULL,
    vendor_id NVARCHAR(64) NOT NULL,
    source_url NVARCHAR(2048) NOT NULL CONSTRAINT DF_election_feed_url DEFAULT (N''),
    hub_page_url NVARCHAR(2048) NOT NULL CONSTRAINT DF_election_feed_hub DEFAULT (N''),
    is_enabled BIT NOT NULL CONSTRAINT DF_election_feed_enabled DEFAULT (1),
    sort_order INT NOT NULL CONSTRAINT DF_election_feed_sort DEFAULT (0),
    created_at DATETIME2 NOT NULL CONSTRAINT DF_election_feed_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_election_feed_updated DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX idx_election_feed_sources_election ON dbo.election_feed_sources (election_id);
END;

IF COL_LENGTH(N'dbo.election_feed_sources', N'hub_page_url') IS NULL
BEGIN
  ALTER TABLE dbo.election_feed_sources ADD hub_page_url NVARCHAR(2048) NOT NULL CONSTRAINT DF_election_feed_hub_mig DEFAULT (N'');
END;

IF COL_LENGTH(N'dbo.election_feed_sources', N'prefer_over_sos') IS NULL
BEGIN
  ALTER TABLE dbo.election_feed_sources ADD prefer_over_sos BIT NOT NULL CONSTRAINT DF_election_feed_prefer_sos DEFAULT (0);
END;

IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'civix-sos')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (N'civix-sos', N'Texas SOS / Civix ENR', N'enr', N'civix_sos', N'Civix applies only to statewide SOS (election + countyInfo). County feeds use county vendors.');
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'harris-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (N'harris-pdf', N'Harris Votes (PDF cumulative)', N'enr', N'harris_pdf', N'');
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'clarity-enr-summary-zip')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (N'clarity-enr-summary-zip', N'Clarity ENR (summary.zip)', N'enr', N'clarity_enr_summary_zip', N'ElectionSystems Clarity: summary.zip for any county URL. Imports all contests; align races when combining totals.');
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'montgomery-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (N'montgomery-pdf', N'Montgomery-style results PDF', N'other', N'montgomery_pdf', N'');
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'montgomery-eresults-html')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (
    N'montgomery-eresults-html',
    N'Montgomery County eResults (live HTML)',
    N'enr',
    N'montgomery_eresults_html',
    N'Live ASP.NET eResults page. Paste the browser results URL — not the cumulative PDF.'
  );
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'chambers-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (N'chambers-pdf', N'Chambers-style results PDF', N'other', N'chambers_pdf', N'');
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'dallas-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (
    N'dallas-pdf',
    N'Dallas County (Electionware summary PDF)',
    N'enr',
    N'dallas_pdf',
    N'Dallas County Votes: Electionware Summary Results Report PDF. Imports all contests; layout differs from Harris / Montgomery / Chambers.'
  );
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'collin-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (
    N'collin-pdf',
    N'Collin County (Electionware EV summary PDF)',
    N'enr',
    N'collin_electionware_pdf',
    N'Collin County Electionware early-voting summary PDF (Mail + Early Voting). Imports all contests in the file.'
  );
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'cameron-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (
    N'cameron-pdf',
    N'Cameron County (results / reconciliation PDF)',
    N'enr',
    N'cameron_pdf',
    N'Cameron County: Electionware summary PDFs (all contests) or SOS preliminary reconciliation P26 PDFs (turnout only).'
  );
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'hays-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (
    N'hays-pdf',
    N'Hays County (eGovlink cumulative PDF)',
    N'enr',
    N'hays_egovlink_cumulative_pdf',
    N'Hays County official cumulative results PDF on egovlink.com (Absentee + Early + Election Day). Imports all contests in the file.'
  );
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'mclennan-pdf')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (
    N'mclennan-pdf',
    N'McLennan County (CivicPlus cumulative PDF)',
    N'enr',
    N'mclennan_civicplus_cumulative_pdf',
    N'McLennan County official cumulative PDF on CivicPlus (Absentee + Early + Election Day). Imports all contests in the file.'
  );
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'ellis-enr-html')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (
    N'ellis-enr-html',
    N'Ellis County (livevoterturnout ENR HTML)',
    N'enr',
    N'ellis_livevoterturnout_html',
    N'Ellis County ENR on livevoterturnout.com — Index HTML URL; sums precinct results to county-wide contest totals.'
  );
IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'other-vendor')
  INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
  VALUES (N'other-vendor', N'Other / custom (no ingest yet)', N'other', N'unimplemented', N'');

IF OBJECT_ID(N'dbo.county_sos_race_links', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_sos_race_links (
    election_id NVARCHAR(128) NOT NULL,
    county_key NVARCHAR(64) NOT NULL,
    county_contest_name NVARCHAR(512) NOT NULL,
    sos_race_id NVARCHAR(64) NOT NULL,
    sos_race_name NVARCHAR(512) NULL,
    link_type NVARCHAR(32) NOT NULL CONSTRAINT DF_county_sos_race_links_type DEFAULT (N'manual'),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_county_sos_race_links_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_county_sos_race_links PRIMARY KEY (election_id, county_key, county_contest_name)
  );
END;
IF OBJECT_ID(N'dbo.county_sos_manual_votes', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_sos_manual_votes (
    election_id NVARCHAR(128) NOT NULL,
    county_key NVARCHAR(64) NOT NULL,
    sos_race_id NVARCHAR(64) NOT NULL,
    sos_candidate_id NVARCHAR(64) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_county_sos_manual_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_county_sos_manual_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_county_sos_manual_total DEFAULT (0),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_county_sos_manual_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_county_sos_manual_votes PRIMARY KEY (election_id, county_key, sos_race_id, sos_candidate_id)
  );
END;
IF OBJECT_ID(N'dbo.county_sos_race_vote_source', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.county_sos_race_vote_source (
    election_id NVARCHAR(128) NOT NULL,
    county_key NVARCHAR(64) NOT NULL,
    sos_race_id NVARCHAR(64) NOT NULL,
    vote_source NVARCHAR(32) NOT NULL CONSTRAINT DF_county_sos_race_vote_source DEFAULT (N'sos'),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_county_sos_race_vote_source_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_county_sos_race_vote_source PRIMARY KEY (election_id, county_key, sos_race_id)
  );
END;

IF OBJECT_ID(N'dbo.vote_update_history', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.vote_update_history (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_vote_update_history PRIMARY KEY,
    election_id NVARCHAR(128) NOT NULL,
    source_key NVARCHAR(128) NOT NULL,
    contest_name NVARCHAR(512) NOT NULL,
    choice_name NVARCHAR(512) NOT NULL,
    party_name NVARCHAR(64) NULL,
    early_votes BIGINT NOT NULL CONSTRAINT DF_vote_update_history_early DEFAULT (0),
    election_day_votes BIGINT NOT NULL CONSTRAINT DF_vote_update_history_ed DEFAULT (0),
    total_votes BIGINT NOT NULL CONSTRAINT DF_vote_update_history_total DEFAULT (0),
    percent_of_votes NVARCHAR(64) NULL,
    captured_at DATETIME2 NOT NULL CONSTRAINT DF_vote_update_history_captured DEFAULT (SYSUTCDATETIME())
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_vote_update_history_lookup' AND object_id = OBJECT_ID(N'dbo.vote_update_history'))
  CREATE INDEX idx_vote_update_history_lookup ON dbo.vote_update_history (election_id, source_key, contest_name, choice_name, party_name, captured_at DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_source_import_log_key_occurred' AND object_id = OBJECT_ID(N'dbo.source_import_log'))
  CREATE INDEX idx_source_import_log_key_occurred ON dbo.source_import_log (source_key, occurred_at DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_county_harris_results_fetch' AND object_id = OBJECT_ID(N'dbo.county_harris_results'))
  CREATE INDEX idx_county_harris_results_fetch ON dbo.county_harris_results (fetched_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_county_galveston_results_fetch' AND object_id = OBJECT_ID(N'dbo.county_galveston_results'))
  CREATE INDEX idx_county_galveston_results_fetch ON dbo.county_galveston_results (fetched_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_county_jefferson_results_fetch' AND object_id = OBJECT_ID(N'dbo.county_jefferson_results'))
  CREATE INDEX idx_county_jefferson_results_fetch ON dbo.county_jefferson_results (fetched_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_county_chambers_results_fetch' AND object_id = OBJECT_ID(N'dbo.county_chambers_results'))
  CREATE INDEX idx_county_chambers_results_fetch ON dbo.county_chambers_results (fetched_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_county_montgomery_results_fetch' AND object_id = OBJECT_ID(N'dbo.county_montgomery_results'))
  CREATE INDEX idx_county_montgomery_results_fetch ON dbo.county_montgomery_results (fetched_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_county_results_fetch' AND object_id = OBJECT_ID(N'dbo.county_results'))
  CREATE INDEX idx_county_results_fetch ON dbo.county_results (county_id, fetched_at DESC);

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'manual-default')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'manual-default', N'manual_json', N'Manual JSON upload', N'Rows in manual_elections');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'sos-civix')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'sos-civix', N'sos', N'Texas SOS Civix ENR', N'Live SOS results from Civix ENR');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'county-harrisvotes')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'county-harrisvotes', N'county', N'Harris Votes', N'County-level JSON feed from app.harrisvotes.com/appfiles.harrisvotes.com');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'county-galveston-clarity')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'county-galveston-clarity', N'county', N'Galveston Clarity', N'summary.zip -> summary.csv parsed for county race results');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'county-jefferson-clarity')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'county-jefferson-clarity', N'county', N'Jefferson Clarity', N'summary.zip -> summary.csv parsed for county race results');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'county-chambers')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'county-chambers', N'county', N'Chambers County', N'County table provisioned; pull logic pending');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'county-montgomery')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'county-montgomery', N'county', N'Montgomery County', N'County table provisioned; pull logic pending');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'disable_auto_ingest')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'disable_auto_ingest', N'false');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'auto_refresh_enabled')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'auto_refresh_enabled', N'false');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'auto_refresh_interval_sec')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'auto_refresh_interval_sec', N'60');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'display_time_zone')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'display_time_zone', N'America/Chicago');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'sos_countyinfo_url')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'sos_countyinfo_url', N'');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'harris_source_url')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'harris_source_url', N'');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'galveston_source_url')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'galveston_source_url', N'');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'jefferson_source_url')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'jefferson_source_url', N'');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'montgomery_source_url')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'montgomery_source_url', N'');
END;
IF NOT EXISTS (SELECT 1 FROM dbo.app_settings WHERE setting_key = N'chambers_source_url')
BEGIN
  INSERT INTO dbo.app_settings (setting_key, value_json) VALUES (N'chambers_source_url', N'');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.election_source_configs WHERE election_id = N'56181')
BEGIN
  INSERT INTO dbo.election_source_configs
    (election_id, label, is_enabled, auto_refresh_enabled, sos_countyinfo_url, harris_source_url, galveston_source_url, jefferson_source_url, montgomery_source_url, chambers_source_url)
  VALUES
    (N'56181', N'May 2, 2026 Special Election', 1, 1, N'', N'', N'', N'', N'', N'');
END;

IF COL_LENGTH(N'dbo.election_source_configs', N'uses_civix_sos') IS NULL
BEGIN
  ALTER TABLE dbo.election_source_configs ADD uses_civix_sos BIT NOT NULL CONSTRAINT DF_election_source_uses_sos DEFAULT (1);
END;

IF COL_LENGTH(N'dbo.election_source_configs', N'show_in_catalog') IS NULL
BEGIN
  ALTER TABLE dbo.election_source_configs ADD show_in_catalog BIT NOT NULL CONSTRAINT DF_election_source_show_catalog DEFAULT (1);
END;

IF COL_LENGTH(N'dbo.election_source_configs', N'is_default_catalog') IS NULL
BEGIN
  ALTER TABLE dbo.election_source_configs ADD is_default_catalog BIT NOT NULL CONSTRAINT DF_election_source_default_catalog DEFAULT (0);
  UPDATE dbo.election_source_configs SET is_default_catalog = 1 WHERE election_id = N'56181';
  IF @@ROWCOUNT = 0
    UPDATE t SET is_default_catalog = 1
    FROM (
      SELECT TOP (1) election_id FROM dbo.election_source_configs ORDER BY election_id
    ) x
    INNER JOIN dbo.election_source_configs t ON t.election_id = x.election_id;
END;

IF COL_LENGTH(N'dbo.election_source_configs', N'county_prefer_over_sos_json') IS NULL
BEGIN
  ALTER TABLE dbo.election_source_configs ADD county_prefer_over_sos_json NVARCHAR(MAX) NOT NULL CONSTRAINT DF_election_source_prefer_county DEFAULT (N'[]');
END;

IF OBJECT_ID(N'dbo.ev_roster_configs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_configs (
    evr_election_id INT NOT NULL CONSTRAINT PK_ev_roster_configs PRIMARY KEY,
    party NVARCHAR(16) NOT NULL,
    election_name NVARCHAR(512) NOT NULL,
    election_date NVARCHAR(32) NOT NULL,
    is_enabled BIT NOT NULL CONSTRAINT DF_ev_roster_enabled DEFAULT (1),
    notes NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_ev_roster_cfg_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_ev_roster_cfg_updated DEFAULT (SYSUTCDATETIME())
  );
END;

IF OBJECT_ID(N'dbo.ev_roster_pulls', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_pulls (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_ev_roster_pulls PRIMARY KEY,
    evr_election_id INT NOT NULL,
    voting_date NVARCHAR(16) NOT NULL,
    hub_page_url NVARCHAR(2048) NULL,
    sos_turnout_url NVARCHAR(2048) NULL,
    sos_roster_url NVARCHAR(2048) NULL,
    statewide_voter_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_pull_voters DEFAULT (0),
    pulled_at DATETIME2 NOT NULL CONSTRAINT DF_ev_roster_pull_at DEFAULT (SYSUTCDATETIME()),
    ok BIT NOT NULL CONSTRAINT DF_ev_roster_pull_ok DEFAULT (1),
    message NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ev_roster_pull_msg DEFAULT (N''),
    CONSTRAINT UQ_ev_roster_pull UNIQUE (evr_election_id, voting_date)
  );
  CREATE INDEX idx_ev_roster_pulls_election ON dbo.ev_roster_pulls (evr_election_id, voting_date DESC);
END;

IF OBJECT_ID(N'dbo.ev_roster_county_summary', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_county_summary (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_ev_roster_county_summary PRIMARY KEY,
    pull_id INT NOT NULL,
    county_name NVARCHAR(128) NOT NULL,
    county_id INT NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_ev_roster_reg DEFAULT (0),
    in_person_votes_on_date BIGINT NOT NULL CONSTRAINT DF_ev_roster_ip_day DEFAULT (0),
    total_in_person_votes_for_election BIGINT NOT NULL CONSTRAINT DF_ev_roster_ip_cum DEFAULT (0),
    total_mail_votes_for_election BIGINT NOT NULL CONSTRAINT DF_ev_roster_mail DEFAULT (0),
    cumulative_total BIGINT NOT NULL CONSTRAINT DF_ev_roster_cum DEFAULT (0),
    sos_voter_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_sos_v DEFAULT (0),
    county_voter_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_cty_v DEFAULT (0),
    chosen_source NVARCHAR(32) NOT NULL CONSTRAINT DF_ev_roster_chosen DEFAULT (N'sos'),
    chosen_voter_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_chosen_v DEFAULT (0),
    CONSTRAINT FK_ev_roster_county_pull FOREIGN KEY (pull_id) REFERENCES dbo.ev_roster_pulls (id) ON DELETE CASCADE
  );
  CREATE INDEX idx_ev_roster_county_pull ON dbo.ev_roster_county_summary (pull_id, county_name);
END;

IF OBJECT_ID(N'dbo.ev_roster_voters', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_voters (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_ev_roster_voters PRIMARY KEY,
    evr_election_id INT NOT NULL,
    voting_date NVARCHAR(16) NOT NULL,
    county_name NVARCHAR(128) NOT NULL,
    vuid NVARCHAR(32) NOT NULL,
    voter_name NVARCHAR(256) NULL,
    voting_method NVARCHAR(64) NULL,
    precinct NVARCHAR(64) NULL,
    source NVARCHAR(32) NOT NULL CONSTRAINT DF_ev_roster_voter_src DEFAULT (N'sos'),
    CONSTRAINT UQ_ev_roster_voter UNIQUE (evr_election_id, voting_date, vuid)
  );
  CREATE INDEX idx_ev_roster_voters_lookup ON dbo.ev_roster_voters (evr_election_id, voting_date, county_name);
END;

IF NOT EXISTS (SELECT 1 FROM dbo.ev_roster_configs WHERE evr_election_id = 58315)
  INSERT INTO dbo.ev_roster_configs (evr_election_id, party, election_name, election_date, notes)
  VALUES (58315, N'REP', N'2026 REPUBLICAN PRIMARY RUNOFF ELECTION', N'05/26/2026', N'Civix EVR — statewide roster + county totals');
IF NOT EXISTS (SELECT 1 FROM dbo.ev_roster_configs WHERE evr_election_id = 58314)
  INSERT INTO dbo.ev_roster_configs (evr_election_id, party, election_name, election_date, notes)
  VALUES (58314, N'DEM', N'2026 DEMOCRATIC PRIMARY RUNOFF ELECTION', N'05/26/2026', N'Civix EVR — statewide roster + county totals');

IF OBJECT_ID(N'dbo.ev_roster_county_sources', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_county_sources (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_ev_roster_county_sources PRIMARY KEY,
    evr_election_id INT NOT NULL,
    county_key NVARCHAR(64) NOT NULL,
    variant_key NVARCHAR(64) NOT NULL CONSTRAINT DF_ev_roster_variant DEFAULT (N'sos-default'),
    source_label NVARCHAR(256) NOT NULL CONSTRAINT DF_ev_roster_src_label DEFAULT (N'SOS default'),
    civix_county_name NVARCHAR(128) NOT NULL,
    civix_county_id INT NULL,
    handler_key NVARCHAR(64) NOT NULL CONSTRAINT DF_ev_roster_handler DEFAULT (N'civix_sos_county_slice'),
    hub_page_url NVARCHAR(2048) NOT NULL CONSTRAINT DF_ev_roster_hub DEFAULT (N''),
    roster_url NVARCHAR(2048) NOT NULL CONSTRAINT DF_ev_roster_roster_url DEFAULT (N''),
    voting_method_scope NVARCHAR(16) NOT NULL CONSTRAINT DF_ev_roster_method_scope DEFAULT (N'ALL'),
    date_scope NVARCHAR(32) NOT NULL CONSTRAINT DF_ev_roster_date_scope DEFAULT (N'SINGLE_DAY'),
    file_format NVARCHAR(16) NOT NULL CONSTRAINT DF_ev_roster_file_fmt DEFAULT (N'auto'),
    discovery_profile_key NVARCHAR(64) NULL,
    training_notes NVARCHAR(MAX) NULL,
    is_enabled BIT NOT NULL CONSTRAINT DF_ev_roster_county_enabled DEFAULT (1),
    last_pull_ok BIT NULL,
    last_pull_message NVARCHAR(MAX) NULL,
    last_pull_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_ev_roster_cty_created DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_ev_roster_cty_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_ev_roster_county_variant UNIQUE (evr_election_id, county_key, variant_key)
  );
END;

IF OBJECT_ID(N'dbo.ev_roster_county_pull_log', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_county_pull_log (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_ev_roster_county_pull_log PRIMARY KEY,
    pull_id INT NOT NULL,
    county_key NVARCHAR(64) NOT NULL,
    county_name NVARCHAR(128) NOT NULL,
    handler_key NVARCHAR(64) NOT NULL,
    ok BIT NOT NULL,
    voter_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_log_v DEFAULT (0),
    source_url NVARCHAR(2048) NULL,
    message NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ev_roster_log_msg DEFAULT (N''),
    CONSTRAINT FK_ev_roster_log_pull FOREIGN KEY (pull_id) REFERENCES dbo.ev_roster_pulls (id) ON DELETE CASCADE
  );
END;

IF COL_LENGTH(N'dbo.ev_roster_voters', N'party') IS NULL
  ALTER TABLE dbo.ev_roster_voters ADD party NVARCHAR(16) NULL;
IF COL_LENGTH(N'dbo.ev_roster_voters', N'method_code') IS NULL
  ALTER TABLE dbo.ev_roster_voters ADD method_code NVARCHAR(8) NULL;
IF COL_LENGTH(N'dbo.ev_roster_voters', N'reporting_date') IS NULL
BEGIN
  ALTER TABLE dbo.ev_roster_voters ADD reporting_date NVARCHAR(16) NULL;
  UPDATE dbo.ev_roster_voters SET reporting_date = voting_date WHERE reporting_date IS NULL;
END;
IF COL_LENGTH(N'dbo.ev_roster_pulls', N'raw_record_count') IS NULL
  ALTER TABLE dbo.ev_roster_pulls ADD raw_record_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_raw DEFAULT (0);
IF COL_LENGTH(N'dbo.ev_roster_pulls', N'deduped_voter_count') IS NULL
  ALTER TABLE dbo.ev_roster_pulls ADD deduped_voter_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_dedup DEFAULT (0);

IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'variant_key') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD variant_key NVARCHAR(64) NOT NULL CONSTRAINT DF_ev_roster_variant DEFAULT (N'sos-default');
IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'source_label') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD source_label NVARCHAR(256) NOT NULL CONSTRAINT DF_ev_roster_src_label DEFAULT (N'SOS default');
IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'voting_method_scope') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD voting_method_scope NVARCHAR(16) NOT NULL CONSTRAINT DF_ev_roster_method_scope DEFAULT (N'ALL');
IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'date_scope') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD date_scope NVARCHAR(32) NOT NULL CONSTRAINT DF_ev_roster_date_scope DEFAULT (N'SINGLE_DAY');
IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'file_format') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD file_format NVARCHAR(16) NOT NULL CONSTRAINT DF_ev_roster_file_fmt DEFAULT (N'auto');
IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'roster_party_scope') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD roster_party_scope NVARCHAR(16) NOT NULL CONSTRAINT DF_ev_roster_party_scope DEFAULT (N'COMBINED');
IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'discovery_profile_key') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD discovery_profile_key NVARCHAR(64) NULL;
IF COL_LENGTH(N'dbo.ev_roster_county_sources', N'training_notes') IS NULL
  ALTER TABLE dbo.ev_roster_county_sources ADD training_notes NVARCHAR(MAX) NULL;

IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_ev_roster_voter' AND parent_object_id = OBJECT_ID(N'dbo.ev_roster_voters'))
  ALTER TABLE dbo.ev_roster_voters DROP CONSTRAINT UQ_ev_roster_voter;
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_ev_roster_voter' AND parent_object_id = OBJECT_ID(N'dbo.ev_roster_voters'))
  ALTER TABLE dbo.ev_roster_voters ADD CONSTRAINT UQ_ev_roster_voter UNIQUE (evr_election_id, voting_date, county_name, vuid);

IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_ev_roster_county' AND parent_object_id = OBJECT_ID(N'dbo.ev_roster_county_sources'))
  ALTER TABLE dbo.ev_roster_county_sources DROP CONSTRAINT UQ_ev_roster_county;
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_ev_roster_county_variant' AND parent_object_id = OBJECT_ID(N'dbo.ev_roster_county_sources'))
  ALTER TABLE dbo.ev_roster_county_sources ADD CONSTRAINT UQ_ev_roster_county_variant UNIQUE (evr_election_id, county_key, variant_key);

IF OBJECT_ID(N'dbo.ev_roster_county_pull_status', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_county_pull_status (
    id INT NOT NULL IDENTITY(1, 1) CONSTRAINT PK_ev_roster_county_pull_status PRIMARY KEY,
    evr_election_id INT NOT NULL,
    voting_date NVARCHAR(16) NOT NULL,
    county_name NVARCHAR(128) NOT NULL,
    county_key NVARCHAR(64) NULL,
    last_pull_ok BIT NULL,
    last_pull_at DATETIME2 NULL,
    last_pull_message NVARCHAR(MAX) NULL,
    voter_count BIGINT NOT NULL CONSTRAINT DF_ev_roster_status_voters DEFAULT (0),
    confirmed_at DATETIME2 NULL,
    CONSTRAINT UQ_ev_roster_county_pull_status UNIQUE (evr_election_id, voting_date, county_name)
  );
  CREATE INDEX idx_ev_roster_county_pull_status ON dbo.ev_roster_county_pull_status (evr_election_id, voting_date);
END;
${EV_ROSTER_SUMMARY_CACHE_DDL_MSSQL}
`;

async function migrateLegacyJsonIfNeeded(pool) {
  const countR = await pool.request().query(`SELECT COUNT(*) AS c FROM dbo.manual_elections`);
  const count = Number(countR.recordset[0]?.c ?? 0);
  if (count > 0) return;
  if (!fs.existsSync(LEGACY_MANIFEST)) return;

  const manifest = JSON.parse(fs.readFileSync(LEGACY_MANIFEST, "utf8"));
  for (const e of manifest.elections || []) {
    const fp = path.join(LEGACY_MANUAL_DIR, e.filename);
    if (!fs.existsSync(fp)) continue;
    const dataJson = fs.readFileSync(fp, "utf8");
    const updatedAt = e.updatedAt || new Date().toISOString();
    await pool
      .request()
      .input("id", sql.NVarChar(128), e.id)
      .input("label", sql.NVarChar(512), e.label)
      .input("data_json", sql.NVarChar(sql.MAX), dataJson)
      .input("created_at", sql.DateTime2, new Date(updatedAt))
      .input("updated_at", sql.DateTime2, new Date(updatedAt))
      .query(
        `INSERT INTO dbo.manual_elections (id, label, data_json, source_id, created_at, updated_at)
         VALUES (@id, @label, @data_json, N'manual-default', @created_at, @updated_at)`,
      );
  }

  try {
    fs.renameSync(LEGACY_MANIFEST, `${LEGACY_MANIFEST}.migrated`);
  } catch {
    /* ignore */
  }
}

async function syncIngestVendorMetadataMssql(pool) {
  await pool.request().query(`
    UPDATE dbo.election_feed_sources
    SET vendor_id = N'clarity-enr-summary-zip', updated_at = SYSUTCDATETIME()
    WHERE vendor_id IN (N'clarity-galveston-sd4', N'clarity-jefferson-sd4')
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.ingest_vendors WHERE id = N'clarity-enr-summary-zip')
    INSERT INTO dbo.ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
    VALUES (
      N'clarity-enr-summary-zip',
      N'Clarity ENR (summary.zip)',
      N'enr',
      N'clarity_enr_summary_zip',
      N'ElectionSystems Clarity: summary.zip → summary.csv for any county URL. Imports all contests; align comparable races when combining totals across counties.'
    )
  `);
  await pool.request().query(`
    DELETE FROM dbo.ingest_vendors WHERE id IN (N'clarity-galveston-sd4', N'clarity-jefferson-sd4')
  `);

  const rows = [
    {
      id: "clarity-enr-summary-zip",
      display_name: "Clarity ENR (summary.zip)",
      vendor_tier: "enr",
      notes:
        "ElectionSystems Clarity: summary.zip → summary.csv for any county URL. Imports all contests; align comparable races when combining totals across counties.",
    },
    {
      id: "montgomery-pdf",
      display_name: "Montgomery cumulative PDF (SD4)",
      vendor_tier: "enr",
      notes: "Official cumulative results PDF from the county (not the live eResults web page).",
    },
    {
      id: "montgomery-eresults-html",
      display_name: "Montgomery County eResults (live HTML)",
      vendor_tier: "enr",
      notes:
        "Live ASP.NET eResults page (elections.mctx.org). Paste the browser URL for the results page — parses SD4 from HTML tables.",
    },
    {
      id: "chambers-pdf",
      display_name: "Chambers cumulative PDF (SD4)",
      vendor_tier: "enr",
      notes:
        "Cumulative PDF SD4 parser. Related to Montgomery (both PDF text → SD4) but line formats differ — not the same code path.",
    },
    {
      id: "harris-pdf",
      display_name: "Harris Votes (PDF cumulative)",
      vendor_tier: "enr",
      notes: "Harris cumulative PDF layout (distinct line format from Montgomery/Chambers).",
    },
    {
      id: "dallas-pdf",
      display_name: "Dallas County (Electionware summary PDF)",
      vendor_tier: "enr",
      notes:
        "Dallas County Votes: Electionware Summary Results Report PDF. Imports all contests; layout differs from Harris / Montgomery / Chambers.",
    },
    {
      id: "collin-pdf",
      display_name: "Collin County (Electionware EV summary PDF)",
      vendor_tier: "enr",
      notes:
        "Collin County Electionware early-voting summary PDF (Mail + Early Voting). Imports all contests in the file.",
    },
    {
      id: "cameron-pdf",
      display_name: "Cameron County (results / reconciliation PDF)",
      vendor_tier: "enr",
      notes:
        "Cameron County: Electionware summary PDFs (all contests) or SOS preliminary reconciliation P26 PDFs (turnout only).",
    },
    {
      id: "hays-pdf",
      display_name: "Hays County (eGovlink cumulative PDF)",
      vendor_tier: "enr",
      notes:
        "Hays egovlink.com cumulative results PDF (official). Imports all contests; separate DEM/REP PDFs per party.",
    },
    {
      id: "mclennan-pdf",
      display_name: "McLennan County (CivicPlus cumulative PDF)",
      vendor_tier: "enr",
      notes:
        "McLennan CivicPlus cumulative PDF (official). Imports all contests; separate DEM/REP PDFs per party.",
    },
    {
      id: "ellis-enr-html",
      display_name: "Ellis County (livevoterturnout ENR HTML)",
      vendor_tier: "enr",
      notes:
        "Ellis livevoterturnout.com ENR Index page — imports all contests (precinct tables summed to county).",
    },
  ];
  for (const r of rows) {
    await pool
      .request()
      .input("id", sql.NVarChar(64), r.id)
      .input("display_name", sql.NVarChar(256), r.display_name)
      .input("vendor_tier", sql.NVarChar(32), r.vendor_tier)
      .input("notes", sql.NVarChar(sql.MAX), r.notes)
      .query(
        `UPDATE dbo.ingest_vendors
         SET display_name = @display_name, vendor_tier = @vendor_tier, notes = @notes, updated_at = SYSUTCDATETIME()
         WHERE id = @id`,
      );
  }
}

export function isDatabaseLoaded() {
  return !!_pool?.connected;
}

export async function ensureDb() {
  if (_pool?.connected) return _pool;
  if (_init) return _init;

  _init = (async () => {
    const { config } = buildConfig();
    _pool = new sql.ConnectionPool(config);
    await _pool.connect();
    await _pool.batch(SCHEMA_SQL);
    await syncIngestVendorMetadataMssql(_pool);
    await migrateLegacyJsonIfNeeded(_pool);
    return _pool;
  })();

  return _init;
}

export function getDbInfo() {
  const server = process.env.MSSQL_SERVER?.trim() || "";
  const database = process.env.MSSQL_DATABASE?.trim() || "electionnighttracker";
  return {
    engine: "mssql",
    server,
    database,
    driver: "mssql (tedious)",
    ssms: true,
    hint: "Connect SSMS to the same server and database; tables are under dbo.",
  };
}

export async function listManualElectionsMeta() {
  const pool = await ensureDb();
  const r = await pool.request().query(
    `SELECT id, label, updated_at AS updatedAt FROM dbo.manual_elections ORDER BY updated_at DESC`,
  );
  return r.recordset.map((row) => ({
    id: row.id,
    label: row.label,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  }));
}

export async function getManualElectionJsonById(id) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("id", sql.NVarChar(128), id)
    .query(`SELECT data_json FROM dbo.manual_elections WHERE id = @id`);
  return r.recordset[0]?.data_json ?? null;
}

export async function insertManualElection(id, label, electionFileObj) {
  const pool = await ensureDb();
  const now = new Date();
  const dataJson = JSON.stringify(electionFileObj);
  await pool
    .request()
    .input("id", sql.NVarChar(128), id)
    .input("label", sql.NVarChar(512), label)
    .input("data_json", sql.NVarChar(sql.MAX), dataJson)
    .input("created_at", sql.DateTime2, now)
    .input("updated_at", sql.DateTime2, now)
    .query(
      `INSERT INTO dbo.manual_elections (id, label, data_json, source_id, created_at, updated_at)
       VALUES (@id, @label, @data_json, N'manual-default', @created_at, @updated_at)`,
    );
}

export async function deleteManualElection(id) {
  const pool = await ensureDb();
  const r = await pool.request().input("id", sql.NVarChar(128), id).query(`DELETE FROM dbo.manual_elections WHERE id = @id`);
  return (r.rowsAffected[0] ?? 0) > 0;
}

export async function manualElectionExists(id) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("id", sql.NVarChar(128), id)
    .query(`SELECT 1 AS x FROM dbo.manual_elections WHERE id = @id`);
  return r.recordset.length > 0;
}

export async function updateManualElection(id, label, electionFileObj) {
  const pool = await ensureDb();
  const now = new Date();
  const dataJson = JSON.stringify(electionFileObj);
  const r = await pool
    .request()
    .input("id", sql.NVarChar(128), id)
    .input("label", sql.NVarChar(512), label)
    .input("data_json", sql.NVarChar(sql.MAX), dataJson)
    .input("updated_at", sql.DateTime2, now)
    .query(`UPDATE dbo.manual_elections SET label = @label, data_json = @data_json, updated_at = @updated_at WHERE id = @id`);
  return (r.rowsAffected[0] ?? 0) > 0;
}

export async function listDbTablesWithCounts() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT t.name, CAST(SUM(p.row_count) AS BIGINT) AS row_count
    FROM sys.tables t
    JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    GROUP BY t.name
    ORDER BY t.name
  `);
  return r.recordset.map((row) => ({
    name: String(row.name),
    rowCount: Number(row.row_count ?? 0),
  }));
}

export async function getDbTablePreview(tableName, limit = 20) {
  const pool = await ensureDb();
  const allowed = new Map([
    ["data_sources", "dbo.data_sources"],
    ["sos_county_results", "dbo.sos_county_results"],
  ]);
  const key = String(tableName ?? "").trim().toLowerCase();
  const fullName = allowed.get(key);
  if (!fullName) throw new Error(`Preview not allowed for table: ${tableName}`);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const r = await pool.request().query(`SELECT TOP (${safeLimit}) * FROM ${fullName} ORDER BY id DESC`);
  const rows = r.recordset.map((x) => ({ ...x }));
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { table: key, columns, rows };
}

export async function insertSosResultSnapshot({ electionId, electionLabel, payload }) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId))
    .input("election_label", sql.NVarChar(512), electionLabel ?? null)
    .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(payload))
    .query(`INSERT INTO dbo.sos_results (election_id, election_label, payload_json) VALUES (@election_id, @election_label, @payload_json)`);
}

function normalizeCountyCandidateName(value) {
  const raw = String(value ?? "").toUpperCase();
  const stripped = raw
    .replace(/\((DEM|REP|LIB|GRN|IND)\)/g, " ")
    .replace(/\b(DEM|REP|LIB|GRN|IND)\b/g, " ")
    .replace(/[^A-Z\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = stripped
    .split(" ")
    .filter(Boolean)
    .filter((t) => !["MR", "MRS", "MS", "DR", "JR", "SR", "II", "III", "IV", "V"].includes(t))
    .filter((t) => t.length > 1);
  if (!tokens.length) return String(value ?? "").trim();
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const toTitle = (s) => s.charAt(0) + s.slice(1).toLowerCase();
  return first === last ? toTitle(first) : `${toTitle(first)} ${toTitle(last)}`;
}

export async function commitCountyResultsBatch({ electionId, batchAt, segments }) {
  const pool = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const batchAtDt =
    batchAt != null ? (typeof batchAt === "string" ? new Date(batchAt) : batchAt) : new Date();
  const segs = segments ?? [];

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    // Replace county rows atomically: delete then insert before commit.
    await new sql.Request(transaction)
      .input("election_id", sql.NVarChar(128), electionKey)
      .query(`DELETE FROM dbo.county_results WHERE election_id = @election_id`);

    for (const seg of segs) {
      for (const row of seg.rows ?? []) {
        const normalizedChoice = normalizeCountyCandidateName(row.choiceName);
        await new sql.Request(transaction)
          .input("county_id", sql.NVarChar(64), seg.countyId)
          .input("election_id", sql.NVarChar(128), electionKey)
          .input("contest_name", sql.NVarChar(512), row.contestName ?? "")
          .input("choice_name", sql.NVarChar(512), normalizedChoice)
          .input("party_name", sql.NVarChar(64), row.partyName ?? null)
          .input("early_votes", sql.BigInt, Number(row.earlyVotes ?? 0))
          .input("election_day_votes", sql.BigInt, Number(row.electionDayVotes ?? 0))
          .input("total_votes", sql.BigInt, Number(row.totalVotes ?? 0))
          .input("percent_of_votes", sql.NVarChar(64), row.percentOfVotes ?? null)
          .input("registered_voters", sql.BigInt, Number(row.registeredVoters ?? 0))
          .input("ballots_cast", sql.BigInt, Number(row.ballotsCast ?? 0))
          .input("precinct_total", sql.Int, Number(row.precinctTotal ?? 0))
          .input("precinct_reporting", sql.Int, Number(row.precinctReporting ?? 0))
          .input("over_votes", sql.BigInt, Number(row.overVotes ?? 0))
          .input("under_votes", sql.BigInt, Number(row.underVotes ?? 0))
          .input("line_number", sql.Int, row.lineNumber == null ? null : Number(row.lineNumber))
          .input("source_url", sql.NVarChar(1024), seg.sourceUrl ?? null)
          .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(row))
          .input("fetched_at", sql.DateTime2, batchAtDt)
          .query(
            `INSERT INTO dbo.county_results
              (election_id, county_id, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes, registered_voters, ballots_cast,
               precinct_total, precinct_reporting, over_votes, under_votes, line_number, source_url, payload_json, fetched_at)
             VALUES
              (@election_id, @county_id, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes, @registered_voters, @ballots_cast,
               @precinct_total, @precinct_reporting, @over_votes, @under_votes, @line_number, @source_url, @payload_json, @fetched_at)`,
          );
      }
    }

    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

export async function insertCountyResultRows({ electionId, countyId, sourceUrl, rows, fetchedAt }) {
  await commitCountyResultsBatch({
    electionId: String(electionId ?? "56181"),
    batchAt: fetchedAt ?? new Date(),
    segments: [{ countyId, sourceUrl, rows }],
  });
}

export async function insertSosCandidateRows({ electionId, electionLabel, sourceUrl, rows }) {
  const pool = await ensureDb();
  for (const row of rows ?? []) {
    await pool
      .request()
      .input("election_id", sql.NVarChar(128), String(electionId))
      .input("election_label", sql.NVarChar(512), electionLabel ?? null)
      .input("contest_name", sql.NVarChar(512), row.contestName ?? "")
      .input("choice_name", sql.NVarChar(512), row.choiceName ?? "")
      .input("party_name", sql.NVarChar(64), row.partyName ?? null)
      .input("early_votes", sql.BigInt, Number(row.earlyVotes ?? 0))
      .input("election_day_votes", sql.BigInt, Number(row.electionDayVotes ?? 0))
      .input("total_votes", sql.BigInt, Number(row.totalVotes ?? 0))
      .input("percent_of_votes", sql.NVarChar(64), row.percentOfVotes ?? null)
      .input("precinct_total", sql.Int, Number(row.precinctTotal ?? 0))
      .input("precinct_reporting", sql.Int, Number(row.precinctReporting ?? 0))
      .input("source_url", sql.NVarChar(1024), sourceUrl ?? null)
      .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(row))
      .query(
        `INSERT INTO dbo.sos_candidate_results
          (election_id, election_label, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes,
           precinct_total, precinct_reporting, source_url, payload_json)
         VALUES
          (@election_id, @election_label, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes,
           @precinct_total, @precinct_reporting, @source_url, @payload_json)`,
      );
  }
}

export async function insertSosCountyRows({ electionId, electionLabel, sourceUrl, rows }) {
  const pool = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    // Atomic replace so readers don't see a partial clear/insert sequence.
    await new sql.Request(transaction)
      .input("election_id", sql.NVarChar(128), electionKey)
      .query(`DELETE FROM dbo.sos_county_results WHERE election_id = @election_id`);
    for (const row of rows ?? []) {
      await new sql.Request(transaction)
        .input("election_id", sql.NVarChar(128), String(electionId))
        .input("election_label", sql.NVarChar(512), electionLabel ?? null)
        .input("county_name", sql.NVarChar(128), row.countyName ?? "")
        .input("contest_name", sql.NVarChar(512), row.contestName ?? "")
        .input("choice_name", sql.NVarChar(512), row.choiceName ?? "")
        .input("party_name", sql.NVarChar(64), row.partyName ?? null)
        .input("early_votes", sql.BigInt, Number(row.earlyVotes ?? 0))
        .input("election_day_votes", sql.BigInt, Number(row.electionDayVotes ?? 0))
        .input("total_votes", sql.BigInt, Number(row.totalVotes ?? 0))
        .input("percent_of_votes", sql.NVarChar(64), row.percentOfVotes ?? null)
        .input("precinct_total", sql.Int, Number(row.precinctTotal ?? 0))
        .input("precinct_reporting", sql.Int, Number(row.precinctReporting ?? 0))
        .input("source_url", sql.NVarChar(1024), sourceUrl ?? null)
        .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(row))
        .query(
          `INSERT INTO dbo.sos_county_results
            (election_id, election_label, county_name, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes,
             precinct_total, precinct_reporting, source_url, payload_json)
           VALUES
            (@election_id, @election_label, @county_name, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes,
             @precinct_total, @precinct_reporting, @source_url, @payload_json)`,
        );
    }
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

export async function getLatestSosCountyRows(electionId) {
  const pool = await ensureDb();
  const latest = await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId))
    .query(`
      SELECT county_name AS countyName, MAX(fetched_at) AS fetchedAt
      FROM dbo.sos_county_results
      WHERE election_id = @election_id
      GROUP BY county_name
    `);
  const out = [];
  for (const row of latest.recordset) {
    const r = await pool
      .request()
      .input("election_id", sql.NVarChar(128), String(electionId))
      .input("county_name", sql.NVarChar(128), String(row.countyName))
      .input("fetched_at", sql.DateTime2, row.fetchedAt)
      .query(`
        SELECT county_name AS countyName, contest_name AS contestName, choice_name AS choiceName, party_name AS partyName,
               early_votes AS earlyVotes, election_day_votes AS electionDayVotes, total_votes AS totalVotes, percent_of_votes AS percentOfVotes,
               precinct_total AS precinctTotal, precinct_reporting AS precinctReporting, fetched_at AS fetchedAt
        FROM dbo.sos_county_results
        WHERE election_id = @election_id AND county_name = @county_name AND fetched_at = @fetched_at
        ORDER BY id
      `);
    out.push(
      ...r.recordset.map((x) => ({
        ...x,
        fetchedAt: x.fetchedAt instanceof Date ? x.fetchedAt.toISOString() : String(x.fetchedAt),
      })),
    );
  }
  return out;
}

async function latestRowsForCounty(pool, countyId, electionId) {
  if (!countyId) return [];
  const r = await pool
    .request()
    .input("countyId", sql.NVarChar(64), countyId)
    .input("electionId", sql.NVarChar(128), String(electionId ?? "56181"))
    .query(`
      SELECT
        MAX(line_number) AS lineNumber,
        contest_name AS contestName,
        choice_name AS choiceName,
        MAX(party_name) AS partyName,
        MAX(early_votes) AS earlyVotes,
        MAX(election_day_votes) AS electionDayVotes,
        MAX(total_votes) AS totalVotes,
        CAST(NULL AS NVARCHAR(64)) AS percentOfVotes,
        MAX(registered_voters) AS registeredVoters,
        MAX(ballots_cast) AS ballotsCast,
        MAX(precinct_total) AS precinctTotal,
        MAX(precinct_reporting) AS precinctReporting,
        MAX(over_votes) AS overVotes,
        MAX(under_votes) AS underVotes,
        MAX(fetched_at) AS fetchedAt,
        CAST(NULL AS NVARCHAR(1024)) AS sourceUrl
      FROM dbo.county_results
      WHERE county_id = @countyId AND election_id = @electionId
      GROUP BY contest_name, choice_name, ISNULL(party_name, N'')
      ORDER BY contest_name, choice_name
    `);
  return r.recordset.map((x) => ({
    ...x,
    fetchedAt: x.fetchedAt instanceof Date ? x.fetchedAt.toISOString() : String(x.fetchedAt),
  }));
}

async function civixCountyLabelForSlugMssql(pool, electionId, slug) {
  const r = await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId))
    .input("county_key", sql.NVarChar(64), String(slug))
    .query(
      `SELECT TOP 1 civix_county_name AS civixCountyName FROM dbo.election_feed_sources WHERE election_id = @election_id AND county_key = @county_key`,
    );
  const civix = r.recordset?.[0]?.civixCountyName;
  if (civix != null && String(civix).trim()) return String(civix).trim().toUpperCase();
  return String(slug).replace(/-/g, " ").toUpperCase();
}

export async function getLatestCountyRows(electionId = "56181") {
  const pool = await ensureDb();
  const dist = await pool.request().input("election_id", sql.NVarChar(128), String(electionId)).query(`
    SELECT DISTINCT county_id AS countyId FROM dbo.county_results WHERE election_id = @election_id
  `);
  const byCivixName = {};
  for (const row of dist.recordset ?? []) {
    const slug = String(row.countyId ?? "");
    if (!slug) continue;
    const civix = await civixCountyLabelForSlugMssql(pool, electionId, slug);
    byCivixName[civix] = await latestRowsForCounty(pool, slug, electionId);
  }
  return byCivixName;
}

/** @see db-sqlite.mjs — Civix labels for feeds with prefer_over_sos (SD4 merge). */
export async function getSd4MergePreferCountyFeedNameSet(electionId = "56181") {
  const pool = await ensureDb();
  await migrateCountyPreferJsonToFeedsMssql(pool);
  const r = await pool.request().input("election_id", sql.NVarChar(128), String(electionId)).query(`
    SELECT county_key AS countyKey FROM dbo.election_feed_sources
    WHERE election_id = @election_id AND prefer_over_sos = 1 AND is_enabled = 1
  `);
  const set = new Set();
  for (const row of r.recordset ?? []) {
    const slug = String(row.countyKey ?? "")
      .trim()
      .toLowerCase();
    if (!slug) continue;
    set.add(await civixCountyLabelForSlugMssql(pool, electionId, slug));
  }
  return set;
}

export async function listCountySosRaceLinks(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", sql.NVarChar(128), String(electionId)).query(`
    SELECT county_key AS countyKey, county_contest_name AS countyContestName, sos_race_id AS sosRaceId,
           sos_race_name AS sosRaceName, link_type AS linkType, updated_at AS updatedAt
    FROM dbo.county_sos_race_links WHERE election_id = @election_id
    ORDER BY county_key, county_contest_name
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    countyContestName: String(row.countyContestName ?? ""),
    sosRaceId: String(row.sosRaceId ?? ""),
    sosRaceName: String(row.sosRaceName ?? ""),
    linkType: String(row.linkType ?? "manual"),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function upsertCountySosRaceLink(electionId, link) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId))
    .input("county_key", sql.NVarChar(64), String(link.countyKey ?? "").toLowerCase().trim())
    .input("county_contest_name", sql.NVarChar(512), String(link.countyContestName ?? "").trim())
    .input("sos_race_id", sql.NVarChar(64), String(link.sosRaceId ?? "").trim())
    .input("sos_race_name", sql.NVarChar(512), String(link.sosRaceName ?? "").trim())
    .input("link_type", sql.NVarChar(32), String(link.linkType ?? "manual"))
    .query(`
      MERGE dbo.county_sos_race_links AS t
      USING (SELECT @election_id AS election_id, @county_key AS county_key, @county_contest_name AS county_contest_name) AS s
      ON t.election_id = s.election_id AND t.county_key = s.county_key AND t.county_contest_name = s.county_contest_name
      WHEN MATCHED THEN UPDATE SET sos_race_id = @sos_race_id, sos_race_name = @sos_race_name, link_type = @link_type, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (election_id, county_key, county_contest_name, sos_race_id, sos_race_name, link_type)
        VALUES (@election_id, @county_key, @county_contest_name, @sos_race_id, @sos_race_name, @link_type);
    `);
}

export async function deleteCountySosRaceLink(electionId, countyKey, countyContestName) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId))
    .input("county_key", sql.NVarChar(64), String(countyKey).toLowerCase().trim())
    .input("county_contest_name", sql.NVarChar(512), String(countyContestName).trim())
    .query(`
      DELETE FROM dbo.county_sos_race_links
      WHERE election_id = @election_id AND county_key = @county_key AND county_contest_name = @county_contest_name
    `);
}

export async function listCountySosManualVotes(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", sql.NVarChar(128), String(electionId)).query(`
    SELECT county_key AS countyKey, sos_race_id AS sosRaceId, sos_candidate_id AS sosCandidateId,
           choice_name AS choiceName, party_name AS partyName, early_votes AS earlyVotes,
           election_day_votes AS electionDayVotes, total_votes AS totalVotes, updated_at AS updatedAt
    FROM dbo.county_sos_manual_votes WHERE election_id = @election_id
    ORDER BY county_key, sos_race_id, sos_candidate_id
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    sosRaceId: String(row.sosRaceId ?? ""),
    sosCandidateId: String(row.sosCandidateId ?? ""),
    choiceName: String(row.choiceName ?? ""),
    partyName: String(row.partyName ?? ""),
    earlyVotes: Number(row.earlyVotes ?? 0),
    electionDayVotes: Number(row.electionDayVotes ?? 0),
    totalVotes: Number(row.totalVotes ?? 0),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function upsertCountySosManualVote(electionId, row) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId))
    .input("county_key", sql.NVarChar(64), String(row.countyKey ?? "").toLowerCase().trim())
    .input("sos_race_id", sql.NVarChar(64), String(row.sosRaceId ?? "").trim())
    .input("sos_candidate_id", sql.NVarChar(64), String(row.sosCandidateId ?? "").trim())
    .input("choice_name", sql.NVarChar(512), String(row.choiceName ?? "").trim())
    .input("party_name", sql.NVarChar(64), String(row.partyName ?? "").trim())
    .input("early_votes", sql.BigInt, Number(row.earlyVotes ?? 0))
    .input("election_day_votes", sql.BigInt, Number(row.electionDayVotes ?? 0))
    .input("total_votes", sql.BigInt, Number(row.totalVotes ?? 0))
    .query(`
      MERGE dbo.county_sos_manual_votes AS t
      USING (SELECT @election_id AS election_id, @county_key AS county_key, @sos_race_id AS sos_race_id, @sos_candidate_id AS sos_candidate_id) AS s
      ON t.election_id = s.election_id AND t.county_key = s.county_key AND t.sos_race_id = s.sos_race_id AND t.sos_candidate_id = s.sos_candidate_id
      WHEN MATCHED THEN UPDATE SET choice_name = @choice_name, party_name = @party_name, early_votes = @early_votes,
        election_day_votes = @election_day_votes, total_votes = @total_votes, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (election_id, county_key, sos_race_id, sos_candidate_id, choice_name, party_name, early_votes, election_day_votes, total_votes)
        VALUES (@election_id, @county_key, @sos_race_id, @sos_candidate_id, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes);
    `);
}

export async function listCountySosRaceVoteSources(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", sql.NVarChar(128), String(electionId)).query(`
    SELECT county_key AS countyKey, sos_race_id AS sosRaceId, vote_source AS voteSource, updated_at AS updatedAt
    FROM dbo.county_sos_race_vote_source WHERE election_id = @election_id
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    sosRaceId: String(row.sosRaceId ?? ""),
    voteSource: String(row.voteSource ?? "sos"),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function upsertCountySosRaceVoteSource(electionId, row) {
  const src = String(row.voteSource ?? "sos").toLowerCase();
  if (!["sos", "county_feed", "manual"].includes(src)) {
    throw new Error("voteSource must be sos, county_feed, or manual");
  }
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId))
    .input("county_key", sql.NVarChar(64), String(row.countyKey ?? "").toLowerCase().trim())
    .input("sos_race_id", sql.NVarChar(64), String(row.sosRaceId ?? "").trim())
    .input("vote_source", sql.NVarChar(32), src)
    .query(`
      MERGE dbo.county_sos_race_vote_source AS t
      USING (SELECT @election_id AS election_id, @county_key AS county_key, @sos_race_id AS sos_race_id) AS s
      ON t.election_id = s.election_id AND t.county_key = s.county_key AND t.sos_race_id = s.sos_race_id
      WHEN MATCHED THEN UPDATE SET vote_source = @vote_source, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (election_id, county_key, sos_race_id, vote_source)
        VALUES (@election_id, @county_key, @sos_race_id, @vote_source);
    `);
}

export async function buildCivixNameToCountyKeyMap(electionId) {
  const pool = await ensureDb();
  const feeds = await listElectionFeedSources(electionId);
  const map = {};
  for (const f of feeds) {
    const slug = String(f.countyKey ?? "").trim().toLowerCase();
    if (!slug) continue;
    map[await civixCountyLabelForSlugMssql(pool, electionId, slug)] = slug;
  }
  return map;
}

async function migrateCountyPreferJsonToFeedsMssql(pool) {
  try {
    const cfgRows = await pool.request().query(`
      SELECT election_id AS electionId, county_prefer_over_sos_json AS jsonRaw
      FROM dbo.election_source_configs
    `);
    for (const row of cfgRows.recordset ?? []) {
      const eid = String(row.electionId ?? "");
      const raw = String(row.jsonRaw ?? "[]").trim();
      if (!raw || raw === "[]") continue;
      let keys = [];
      try {
        keys = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(keys) || !keys.length) continue;
      for (const k of keys) {
        const slug = String(k ?? "")
          .trim()
          .toLowerCase();
        if (!slug) continue;
        await pool
          .request()
          .input("election_id", sql.NVarChar(128), eid)
          .input("county_key", sql.NVarChar(64), slug)
          .query(`
            UPDATE dbo.election_feed_sources
            SET prefer_over_sos = 1
            WHERE election_id = @election_id AND LOWER(county_key) = LOWER(@county_key)
          `);
      }
      await pool
        .request()
        .input("election_id", sql.NVarChar(128), eid)
        .query(`
          UPDATE dbo.election_source_configs
          SET county_prefer_over_sos_json = N'[]'
          WHERE election_id = @election_id
        `);
    }
  } catch {
    /* ignore */
  }
}

export async function listIngestVendors() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT id, display_name AS displayName, vendor_tier AS vendorTier, handler_key AS handlerKey, notes
    FROM dbo.ingest_vendors ORDER BY vendor_tier DESC, display_name
  `);
  return (r.recordset ?? []).map((x) => ({
    id: String(x.id),
    displayName: String(x.displayName ?? ""),
    vendorTier: String(x.vendorTier ?? "other"),
    handlerKey: String(x.handlerKey ?? ""),
    notes: x.notes == null ? "" : String(x.notes),
  }));
}

async function ensureElectionFeedsSeededFromLegacyMssql(pool, electionId) {
  const c = await pool.request().input("election_id", sql.NVarChar(128), electionId).query(`
    SELECT COUNT(*) AS n FROM dbo.election_feed_sources WHERE election_id = @election_id
  `);
  if (Number(c.recordset?.[0]?.n ?? 0) > 0) return;

  const cfgR = await pool.request().input("election_id", sql.NVarChar(128), electionId).query(`
    SELECT harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl, jefferson_source_url AS jeffersonSourceUrl,
           montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl
    FROM dbo.election_source_configs WHERE election_id = @election_id
  `);
  const cfg = cfgR.recordset?.[0];
  if (!cfg) return;

  const feeds = [];
  let ord = 0;
  const push = (countyKey, vendorId, url) => {
    const u = String(url ?? "").trim();
    if (!u) return;
    feeds.push({ countyKey, vendorId, url: u, sortOrder: ord++ });
  };
  push("harris", "harris-pdf", cfg.harrisSourceUrl);
  push("galveston", "clarity-enr-summary-zip", cfg.galvestonSourceUrl);
  push("jefferson", "clarity-enr-summary-zip", cfg.jeffersonSourceUrl);
  push("montgomery", "montgomery-eresults-html", cfg.montgomerySourceUrl);
  push("chambers", "chambers-pdf", cfg.chambersSourceUrl);
  if (!feeds.length) return;

  for (const f of feeds) {
    await pool
      .request()
      .input("election_id", sql.NVarChar(128), electionId)
      .input("county_key", sql.NVarChar(64), f.countyKey)
      .input("vendor_id", sql.NVarChar(64), f.vendorId)
      .input("source_url", sql.NVarChar(2048), f.url)
      .input("sort_order", sql.Int, f.sortOrder)
      .query(`
        INSERT INTO dbo.election_feed_sources (election_id, scope, county_key, vendor_id, source_url, hub_page_url, is_enabled, sort_order, updated_at)
        VALUES (@election_id, N'county', @county_key, @vendor_id, @source_url, N'', 1, @sort_order, SYSUTCDATETIME())
      `);
  }
}

export async function listElectionFeedSources(electionId) {
  const pool = await ensureDb();
  await migrateCountyPreferJsonToFeedsMssql(pool);
  await ensureElectionFeedsSeededFromLegacyMssql(pool, String(electionId));
  const r = await pool.request().input("election_id", sql.NVarChar(128), String(electionId)).query(`
    SELECT id, election_id AS electionId, scope, county_key AS countyKey, civix_county_name AS civixCountyName,
           vendor_id AS vendorId, source_url AS sourceUrl, hub_page_url AS hubPageUrl,
           is_enabled AS isEnabled, prefer_over_sos AS preferOverSos, sort_order AS sortOrder, updated_at AS updatedAt
    FROM dbo.election_feed_sources WHERE election_id = @election_id ORDER BY sort_order, id
  `);
  return (r.recordset ?? []).map((row) => ({
    id: Number(row.id),
    electionId: String(row.electionId ?? ""),
    scope: String(row.scope ?? "county"),
    countyKey: String(row.countyKey ?? ""),
    civixCountyName: row.civixCountyName == null ? "" : String(row.civixCountyName),
    vendorId: String(row.vendorId ?? ""),
    sourceUrl: String(row.sourceUrl ?? ""),
    hubPageUrl: String(row.hubPageUrl ?? ""),
    isEnabled: !!row.isEnabled,
    preferOverSos: !!row.preferOverSos,
    sortOrder: Number(row.sortOrder ?? 0),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function replaceElectionFeedSourcesForElection(electionId, sources) {
  const pool = await ensureDb();
  const eid = String(electionId ?? "").trim();
  if (!eid) throw new Error("electionId is required");

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction).input("election_id", sql.NVarChar(128), eid).query(`
      DELETE FROM dbo.election_feed_sources WHERE election_id = @election_id
    `);
    let ord = 0;
    for (const s of sources ?? []) {
      const countyKey = String(s.countyKey ?? "").trim().toLowerCase();
      if (!countyKey) continue;
      const civix =
        s.civixCountyName != null && String(s.civixCountyName).trim() ? String(s.civixCountyName).trim() : null;
      await new sql.Request(transaction)
        .input("election_id", sql.NVarChar(128), eid)
        .input("county_key", sql.NVarChar(64), countyKey)
        .input("civix_county_name", sql.NVarChar(128), civix)
        .input("vendor_id", sql.NVarChar(64), String(s.vendorId ?? "").trim() || "other-vendor")
        .input("source_url", sql.NVarChar(2048), String(s.sourceUrl ?? ""))
        .input("hub_page_url", sql.NVarChar(2048), String(s.hubPageUrl ?? ""))
        .input("is_enabled", sql.Bit, s.isEnabled === false ? 0 : 1)
        .input("prefer_over_sos", sql.Bit, s.preferOverSos === true ? 1 : 0)
        .input("sort_order", sql.Int, ord++)
        .query(`
          INSERT INTO dbo.election_feed_sources
            (election_id, scope, county_key, civix_county_name, vendor_id, source_url, hub_page_url, is_enabled, prefer_over_sos, sort_order, updated_at)
          VALUES (@election_id, N'county', @county_key, @civix_county_name, @vendor_id, @source_url, @hub_page_url, @is_enabled, @prefer_over_sos, @sort_order, SYSUTCDATETIME())
        `);
    }
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
  return listElectionFeedSources(eid);
}

export async function updateElectionFeedSourceUrl(electionId, feedId, sourceUrl) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), String(electionId ?? "").trim())
    .input("id", sql.Int, Number(feedId))
    .input("source_url", sql.NVarChar(2048), String(sourceUrl ?? ""))
    .query(`
      UPDATE dbo.election_feed_sources
      SET source_url = @source_url, updated_at = SYSUTCDATETIME()
      WHERE election_id = @election_id AND id = @id
    `);
}

export async function ensureElectionFeedsSeededFromLegacyForElection(electionId) {
  const pool = await ensureDb();
  await ensureElectionFeedsSeededFromLegacyMssql(pool, String(electionId));
}

export async function getAppSettings() {
  const pool = await ensureDb();
  const r = await pool.request().query(
    `SELECT setting_key AS settingKey, value_json AS valueJson
     FROM dbo.app_settings
     WHERE setting_key IN (
       N'disable_auto_ingest', N'auto_refresh_enabled', N'auto_refresh_interval_sec', N'sos_countyinfo_url',
       N'harris_source_url', N'galveston_source_url', N'jefferson_source_url', N'montgomery_source_url', N'chambers_source_url',
       N'display_time_zone'
     )`,
  );
  const map = new Map(r.recordset.map((x) => [String(x.settingKey), String(x.valueJson)]));
  return {
    disableAutoIngest: (map.get("disable_auto_ingest") ?? "false").toLowerCase() === "true",
    autoRefreshEnabled: (map.get("auto_refresh_enabled") ?? "false").toLowerCase() === "true",
    autoRefreshIntervalSec: Math.max(15, Number(map.get("auto_refresh_interval_sec") ?? "60") || 60),
    sosCountyInfoUrl: map.get("sos_countyinfo_url") ?? "",
    harrisSourceUrl: map.get("harris_source_url") ?? "",
    galvestonSourceUrl: map.get("galveston_source_url") ?? "",
    jeffersonSourceUrl: map.get("jefferson_source_url") ?? "",
    montgomerySourceUrl: map.get("montgomery_source_url") ?? "",
    chambersSourceUrl: map.get("chambers_source_url") ?? "",
    displayTimeZone: map.get("display_time_zone") ?? "America/Chicago",
  };
}

export async function updateAppSettings({
  disableAutoIngest,
  autoRefreshEnabled,
  autoRefreshIntervalSec,
  sosCountyInfoUrl,
  harrisSourceUrl,
  galvestonSourceUrl,
  jeffersonSourceUrl,
  montgomerySourceUrl,
  chambersSourceUrl,
  displayTimeZone,
}) {
  const pool = await ensureDb();
  const upsert = async (key, value) => {
    await pool
      .request()
      .input("setting_key", sql.NVarChar(128), key)
      .input("value_json", sql.NVarChar(sql.MAX), String(value))
      .query(`
        MERGE dbo.app_settings AS target
        USING (SELECT @setting_key AS setting_key, @value_json AS value_json) AS source
        ON target.setting_key = source.setting_key
        WHEN MATCHED THEN UPDATE SET value_json = source.value_json, updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (setting_key, value_json) VALUES (source.setting_key, source.value_json);
      `);
  };
  await upsert("disable_auto_ingest", disableAutoIngest ? "true" : "false");
  if (typeof autoRefreshEnabled === "boolean") await upsert("auto_refresh_enabled", autoRefreshEnabled ? "true" : "false");
  if (autoRefreshIntervalSec != null) await upsert("auto_refresh_interval_sec", Math.max(15, Number(autoRefreshIntervalSec) || 60));
  if (sosCountyInfoUrl != null) await upsert("sos_countyinfo_url", String(sosCountyInfoUrl));
  if (harrisSourceUrl != null) await upsert("harris_source_url", String(harrisSourceUrl));
  if (galvestonSourceUrl != null) await upsert("galveston_source_url", String(galvestonSourceUrl));
  if (jeffersonSourceUrl != null) await upsert("jefferson_source_url", String(jeffersonSourceUrl));
  if (montgomerySourceUrl != null) await upsert("montgomery_source_url", String(montgomerySourceUrl));
  if (chambersSourceUrl != null) await upsert("chambers_source_url", String(chambersSourceUrl));
  if (displayTimeZone != null) await upsert("display_time_zone", String(displayTimeZone || "America/Chicago"));
  return getAppSettings();
}

export async function clearLiveResultTables() {
  const pool = await ensureDb();
  await pool.request().batch(`
    DELETE FROM dbo.sos_results;
    DELETE FROM dbo.sos_candidate_results;
    DELETE FROM dbo.sos_county_results;
    DELETE FROM dbo.county_results;
    DELETE FROM dbo.county_harris_results;
    DELETE FROM dbo.county_galveston_results;
    DELETE FROM dbo.county_jefferson_results;
    DELETE FROM dbo.county_chambers_results;
    DELETE FROM dbo.county_montgomery_results;
  `);
}

export async function pruneLiveResultHistory(keepSosBatches = 2) {
  const pool = await ensureDb();
  const keep = Math.max(1, Number(keepSosBatches) || 2);
  await pool.request().input("keep", sql.Int, keep).batch(`
    ;WITH ranked AS (
      SELECT id,
             DENSE_RANK() OVER (PARTITION BY election_id ORDER BY fetched_at DESC) AS dr
      FROM dbo.sos_results
    )
    DELETE FROM dbo.sos_results WHERE id IN (SELECT id FROM ranked WHERE dr > @keep);

    ;WITH ranked AS (
      SELECT id,
             DENSE_RANK() OVER (PARTITION BY election_id ORDER BY fetched_at DESC) AS dr
      FROM dbo.sos_candidate_results
    )
    DELETE FROM dbo.sos_candidate_results WHERE id IN (SELECT id FROM ranked WHERE dr > @keep);

    ;WITH ranked AS (
      SELECT id,
             DENSE_RANK() OVER (PARTITION BY election_id, county_name ORDER BY fetched_at DESC) AS dr
      FROM dbo.sos_county_results
    )
    DELETE FROM dbo.sos_county_results WHERE id IN (SELECT id FROM ranked WHERE dr > @keep);
  `);
}

export async function listElectionSourceConfigs() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT election_id AS electionId, label, is_enabled AS isEnabled, auto_refresh_enabled AS autoRefreshEnabled,
           uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog, is_default_catalog AS isDefaultCatalog,
           sos_countyinfo_url AS sosCountyInfoUrl, harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl,
           jefferson_source_url AS jeffersonSourceUrl, montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl,
           updated_at AS updatedAt
    FROM dbo.election_source_configs
    ORDER BY is_default_catalog DESC, election_id
  `);
  return (r.recordset ?? []).map((row) => ({
    electionId: String(row.electionId ?? ""),
    label: String(row.label ?? ""),
    isEnabled: !!row.isEnabled,
    autoRefreshEnabled: !!row.autoRefreshEnabled,
    usesCivixSos: row.usesCivixSos == null ? true : !!row.usesCivixSos,
    showInCatalog: row.showInCatalog == null ? true : !!row.showInCatalog,
    isDefaultCatalog: !!row.isDefaultCatalog,
    sosCountyInfoUrl: String(row.sosCountyInfoUrl ?? ""),
    harrisSourceUrl: String(row.harrisSourceUrl ?? ""),
    galvestonSourceUrl: String(row.galvestonSourceUrl ?? ""),
    jeffersonSourceUrl: String(row.jeffersonSourceUrl ?? ""),
    montgomerySourceUrl: String(row.montgomerySourceUrl ?? ""),
    chambersSourceUrl: String(row.chambersSourceUrl ?? ""),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function getElectionSourceConfig(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", sql.NVarChar(128), String(electionId)).query(`
    SELECT election_id AS electionId, label, is_enabled AS isEnabled, auto_refresh_enabled AS autoRefreshEnabled,
           uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog, is_default_catalog AS isDefaultCatalog,
           sos_countyinfo_url AS sosCountyInfoUrl, harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl,
           jefferson_source_url AS jeffersonSourceUrl, montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl
    FROM dbo.election_source_configs WHERE election_id = @election_id
  `);
  const row = r.recordset?.[0];
  if (!row) return null;
  return {
    electionId: String(row.electionId ?? ""),
    label: String(row.label ?? ""),
    isEnabled: !!row.isEnabled,
    autoRefreshEnabled: !!row.autoRefreshEnabled,
    usesCivixSos: row.usesCivixSos == null ? true : !!row.usesCivixSos,
    showInCatalog: row.showInCatalog == null ? true : !!row.showInCatalog,
    isDefaultCatalog: !!row.isDefaultCatalog,
    sosCountyInfoUrl: String(row.sosCountyInfoUrl ?? ""),
    harrisSourceUrl: String(row.harrisSourceUrl ?? ""),
    galvestonSourceUrl: String(row.galvestonSourceUrl ?? ""),
    jeffersonSourceUrl: String(row.jeffersonSourceUrl ?? ""),
    montgomerySourceUrl: String(row.montgomerySourceUrl ?? ""),
    chambersSourceUrl: String(row.chambersSourceUrl ?? ""),
  };
}

export async function setDefaultElectionCatalog(electionId) {
  const pool = await ensureDb();
  const id = String(electionId ?? "").trim();
  if (!id) throw new Error("electionId is required");
  const check = await pool.request().input("election_id", sql.NVarChar(128), id).query(`
    SELECT 1 AS ok FROM dbo.election_source_configs WHERE election_id = @election_id
  `);
  if (!check.recordset?.length) throw new Error(`Election ${id} not found`);
  await pool.request().query(`UPDATE dbo.election_source_configs SET is_default_catalog = 0`);
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), id)
    .query(`
      UPDATE dbo.election_source_configs
      SET is_default_catalog = 1, updated_at = SYSUTCDATETIME()
      WHERE election_id = @election_id
    `);
  return getElectionSourceConfig(id);
}

export async function upsertElectionSourceConfig(payload) {
  const pool = await ensureDb();
  const electionId = String(payload?.electionId ?? "").trim();
  if (!electionId) throw new Error("electionId is required");
  const usesSos = payload?.usesCivixSos === false ? 0 : 1;
  const showCat = payload?.showInCatalog === false ? 0 : 1;
  await pool
    .request()
    .input("election_id", sql.NVarChar(128), electionId)
    .input("label", sql.NVarChar(256), String(payload?.label ?? electionId))
    .input("is_enabled", sql.Bit, !!payload?.isEnabled)
    .input("auto_refresh_enabled", sql.Bit, !!payload?.autoRefreshEnabled)
    .input("uses_civix_sos", sql.Bit, usesSos)
    .input("show_in_catalog", sql.Bit, showCat)
    .input("sos_countyinfo_url", sql.NVarChar(2048), String(payload?.sosCountyInfoUrl ?? ""))
    .input("harris_source_url", sql.NVarChar(2048), String(payload?.harrisSourceUrl ?? ""))
    .input("galveston_source_url", sql.NVarChar(2048), String(payload?.galvestonSourceUrl ?? ""))
    .input("jefferson_source_url", sql.NVarChar(2048), String(payload?.jeffersonSourceUrl ?? ""))
    .input("montgomery_source_url", sql.NVarChar(2048), String(payload?.montgomerySourceUrl ?? ""))
    .input("chambers_source_url", sql.NVarChar(2048), String(payload?.chambersSourceUrl ?? ""))
    .query(`
      MERGE dbo.election_source_configs AS target
      USING (SELECT @election_id AS election_id) AS source
      ON target.election_id = source.election_id
      WHEN MATCHED THEN UPDATE SET
        label = @label,
        is_enabled = @is_enabled,
        auto_refresh_enabled = @auto_refresh_enabled,
        uses_civix_sos = @uses_civix_sos,
        show_in_catalog = @show_in_catalog,
        sos_countyinfo_url = @sos_countyinfo_url,
        harris_source_url = @harris_source_url,
        galveston_source_url = @galveston_source_url,
        jefferson_source_url = @jefferson_source_url,
        montgomery_source_url = @montgomery_source_url,
        chambers_source_url = @chambers_source_url,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (election_id, label, is_enabled, auto_refresh_enabled, uses_civix_sos, show_in_catalog, sos_countyinfo_url, harris_source_url, galveston_source_url, jefferson_source_url, montgomery_source_url, chambers_source_url)
      VALUES
        (@election_id, @label, @is_enabled, @auto_refresh_enabled, @uses_civix_sos, @show_in_catalog, @sos_countyinfo_url, @harris_source_url, @galveston_source_url, @jefferson_source_url, @montgomery_source_url, @chambers_source_url);
    `);
  return getElectionSourceConfig(electionId);
}

export async function appendVoteHistoryIfChanged({ electionId, sourceKey, capturedAt, rows }) {
  const pool = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const source = String(sourceKey ?? "unknown");
  const captured = capturedAt != null ? new Date(capturedAt) : new Date();
  for (const row of rows ?? []) {
    const contestName = String(row.contestName ?? "");
    const choiceName = String(row.choiceName ?? "");
    const partyName = row.partyName == null ? null : String(row.partyName);
    const earlyVotes = Number(row.earlyVotes ?? 0);
    const electionDayVotes = Number(row.electionDayVotes ?? 0);
    const totalVotes = Number(row.totalVotes ?? 0);
    const percentOfVotes = row.percentOfVotes == null ? null : String(row.percentOfVotes);
    const prev = await pool
      .request()
      .input("election_id", sql.NVarChar(128), electionKey)
      .input("source_key", sql.NVarChar(128), source)
      .input("contest_name", sql.NVarChar(512), contestName)
      .input("choice_name", sql.NVarChar(512), choiceName)
      .input("party_name", sql.NVarChar(64), partyName)
      .query(`
        SELECT TOP 1 early_votes AS earlyVotes, election_day_votes AS electionDayVotes, total_votes AS totalVotes, percent_of_votes AS percentOfVotes
        FROM dbo.vote_update_history
        WHERE election_id = @election_id AND source_key = @source_key AND contest_name = @contest_name AND choice_name = @choice_name
          AND ISNULL(party_name, N'') = ISNULL(@party_name, N'')
        ORDER BY id DESC
      `);
    const p = prev.recordset?.[0];
    const changed =
      !p ||
      Number(p.earlyVotes ?? 0) !== earlyVotes ||
      Number(p.electionDayVotes ?? 0) !== electionDayVotes ||
      Number(p.totalVotes ?? 0) !== totalVotes ||
      String(p.percentOfVotes ?? "") !== String(percentOfVotes ?? "");
    if (!changed) continue;
    await pool
      .request()
      .input("election_id", sql.NVarChar(128), electionKey)
      .input("source_key", sql.NVarChar(128), source)
      .input("contest_name", sql.NVarChar(512), contestName)
      .input("choice_name", sql.NVarChar(512), choiceName)
      .input("party_name", sql.NVarChar(64), partyName)
      .input("early_votes", sql.BigInt, earlyVotes)
      .input("election_day_votes", sql.BigInt, electionDayVotes)
      .input("total_votes", sql.BigInt, totalVotes)
      .input("percent_of_votes", sql.NVarChar(64), percentOfVotes)
      .input("captured_at", sql.DateTime2, captured)
      .query(`
        INSERT INTO dbo.vote_update_history
          (election_id, source_key, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes, captured_at)
        VALUES
          (@election_id, @source_key, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes, @captured_at)
      `);
  }
}

const SOURCE_IMPORT_LOG_CAP = 500;

export async function appendSourceImportLog({ sourceKey, ok, message }) {
  try {
    const pool = await ensureDb();
    const key = String(sourceKey ?? "").trim().slice(0, 64) || "unknown";
    const msg = String(message ?? "").slice(0, 400000);
    await pool
      .request()
      .input("source_key", sql.NVarChar(64), key)
      .input("ok", sql.Bit, !!ok)
      .input("message", sql.NVarChar(sql.MAX), msg)
      .query(`INSERT INTO dbo.source_import_log (source_key, ok, message) VALUES (@source_key, @ok, @message)`);
    await pool.request().input("cap", sql.Int, SOURCE_IMPORT_LOG_CAP).query(`
      ;WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn
        FROM dbo.source_import_log
      )
      DELETE FROM dbo.source_import_log WHERE id IN (SELECT id FROM ranked WHERE rn > @cap);
    `);
  } catch (e) {
    console.error("appendSourceImportLog", e);
  }
}

export async function getSourceImportLogPayload({ recentLimit = 200 } = {}) {
  const pool = await ensureDb();
  const limit = Math.max(1, Math.min(500, Number(recentLimit) || 200));
  const recentR = await pool.request().input("lim", sql.Int, limit).query(`
    SELECT TOP (@lim) id, source_key AS sourceKey, ok, message, occurred_at AS occurredAt
    FROM dbo.source_import_log ORDER BY id DESC
  `);
  const entries = (recentR.recordset ?? []).map((row) => ({
    id: Number(row.id),
    sourceKey: String(row.sourceKey ?? ""),
    ok: !!row.ok,
    message: String(row.message ?? ""),
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt ?? ""),
  }));

  const latestR = await pool.request().query(`
    SELECT s.id, s.source_key AS sourceKey, s.ok, s.message, s.occurred_at AS occurredAt
    FROM dbo.source_import_log s
    INNER JOIN (
      SELECT source_key, MAX(id) AS mid FROM dbo.source_import_log GROUP BY source_key
    ) t ON s.source_key = t.source_key AND s.id = t.mid
  `);
  const latestBySource = {};
  for (const row of latestR.recordset ?? []) {
    const at = row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt ?? "");
    latestBySource[String(row.sourceKey ?? "")] = {
      ok: !!row.ok,
      message: String(row.message ?? ""),
      occurredAt: at,
    };
  }
  return { entries, latestBySource };
}

export async function listEvRosterConfigs() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT evr_election_id AS evrElectionId, party, election_name AS electionName, election_date AS electionDate,
           is_enabled AS isEnabled, notes, updated_at AS updatedAt
    FROM dbo.ev_roster_configs ORDER BY party, evr_election_id
  `);
  return (r.recordset ?? []).map((row) => ({
    evrElectionId: Number(row.evrElectionId),
    party: String(row.party ?? ""),
    electionName: String(row.electionName ?? ""),
    electionDate: String(row.electionDate ?? ""),
    isEnabled: !!row.isEnabled,
    notes: row.notes != null ? String(row.notes) : null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function upsertEvRosterConfig({ evrElectionId, party, electionName, electionDate, isEnabled, notes }) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("evr_election_id", sql.Int, Number(evrElectionId))
    .input("party", sql.NVarChar(16), String(party ?? ""))
    .input("election_name", sql.NVarChar(512), String(electionName ?? ""))
    .input("election_date", sql.NVarChar(32), String(electionDate ?? ""))
    .input("is_enabled", sql.Bit, isEnabled === false ? 0 : 1)
    .input("notes", sql.NVarChar(sql.MAX), notes != null ? String(notes) : null)
    .query(`
      MERGE dbo.ev_roster_configs AS target
      USING (SELECT @evr_election_id AS evr_election_id) AS source
      ON target.evr_election_id = source.evr_election_id
      WHEN MATCHED THEN UPDATE SET
        party = @party, election_name = @election_name, election_date = @election_date,
        is_enabled = @is_enabled, notes = @notes, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (evr_election_id, party, election_name, election_date, is_enabled, notes)
        VALUES (@evr_election_id, @party, @election_name, @election_date, @is_enabled, @notes);
    `);
  return listEvRosterConfigs();
}

/** @returns {Promise<Set<string>>} uppercased county names confirmed for this date */
export async function getConfirmedEvRosterCountyNames(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("evr_election_id", sql.Int, Number(evrElectionId))
    .input("voting_date", sql.NVarChar(16), String(votingDate ?? "").trim())
    .query(`
      SELECT county_name AS countyName
      FROM dbo.ev_roster_county_pull_status
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date AND confirmed_at IS NOT NULL
    `);
  return new Set((r.recordset ?? []).map((row) => String(row.countyName ?? "").toUpperCase()).filter(Boolean));
}

export async function listEvRosterCountyPullStatuses(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("evr_election_id", sql.Int, Number(evrElectionId))
    .input("voting_date", sql.NVarChar(16), String(votingDate ?? "").trim())
    .query(`
      SELECT county_name AS countyName, county_key AS countyKey, last_pull_ok AS lastPullOk,
             last_pull_at AS lastPullAt, last_pull_message AS lastPullMessage, voter_count AS voterCount,
             confirmed_at AS confirmedAt
      FROM dbo.ev_roster_county_pull_status
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date
    `);
  return (r.recordset ?? []).map((row) => ({
    countyName: String(row.countyName ?? ""),
    countyKey: row.countyKey != null ? String(row.countyKey) : null,
    lastPullOk: row.lastPullOk == null ? null : !!row.lastPullOk,
    lastPullAt: row.lastPullAt instanceof Date ? row.lastPullAt.toISOString() : row.lastPullAt ? String(row.lastPullAt) : null,
    lastPullMessage: row.lastPullMessage != null ? String(row.lastPullMessage) : null,
    voterCount: Number(row.voterCount ?? 0),
    confirmedAt: row.confirmedAt instanceof Date ? row.confirmedAt.toISOString() : row.confirmedAt ? String(row.confirmedAt) : null,
  }));
}

/**
 * @param {number} evrElectionId
 * @param {string} votingDate
 * @param {Array<{ countyName?: string, countyKey?: string, ok?: boolean, voterCount?: number, message?: string }>} countyPullLog
 */
export async function recordEvRosterCountyPullResults(evrElectionId, votingDate, countyPullLog) {
  const { aggregateCountyPullResults } = await import("./lib/evRosterCountyStatus.mjs");
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const now = new Date();
  for (const row of aggregateCountyPullResults(countyPullLog)) {
    await pool
      .request()
      .input("evr_election_id", sql.Int, eid)
      .input("voting_date", sql.NVarChar(16), vDate)
      .input("county_name", sql.NVarChar(128), row.countyName)
      .input("county_key", sql.NVarChar(64), row.countyKey || null)
      .input("last_pull_ok", sql.Bit, row.lastPullOk ? 1 : 0)
      .input("last_pull_at", sql.DateTime2, now)
      .input("last_pull_message", sql.NVarChar(sql.MAX), row.messages.join(" | ").slice(0, 4000) || null)
      .input("voter_count", sql.BigInt, Number(row.voterCount ?? 0))
      .query(`
        MERGE dbo.ev_roster_county_pull_status AS target
        USING (SELECT @evr_election_id AS evr_election_id, @voting_date AS voting_date, @county_name AS county_name) AS source
        ON target.evr_election_id = source.evr_election_id AND target.voting_date = source.voting_date
          AND target.county_name = source.county_name
        WHEN MATCHED THEN UPDATE SET
          county_key = COALESCE(@county_key, target.county_key),
          last_pull_ok = @last_pull_ok, last_pull_at = @last_pull_at, last_pull_message = @last_pull_message,
          voter_count = @voter_count
        WHEN NOT MATCHED THEN INSERT
          (evr_election_id, voting_date, county_name, county_key, last_pull_ok, last_pull_at, last_pull_message, voter_count)
        VALUES (@evr_election_id, @voting_date, @county_name, @county_key, @last_pull_ok, @last_pull_at, @last_pull_message, @voter_count);
      `);
  }
}

export async function confirmEvRosterCountyPull(evrElectionId, votingDate, countyName) {
  const pool = await ensureDb();
  const name = String(countyName ?? "").toUpperCase();
  const check = await pool
    .request()
    .input("evr_election_id", sql.Int, Number(evrElectionId))
    .input("voting_date", sql.NVarChar(16), String(votingDate ?? "").trim())
    .input("county_name", sql.NVarChar(128), name)
    .query(`
      SELECT last_pull_ok AS lastPullOk FROM dbo.ev_roster_county_pull_status
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date AND county_name = @county_name
    `);
  if (!check.recordset?.length) {
    throw new Error(`No county pull recorded for ${name} on this date — pull the county first.`);
  }
  if (!check.recordset[0].lastPullOk) {
    throw new Error(`Latest pull for ${name} did not succeed — fix sources and pull again before confirming.`);
  }
  await pool
    .request()
    .input("evr_election_id", sql.Int, Number(evrElectionId))
    .input("voting_date", sql.NVarChar(16), String(votingDate ?? "").trim())
    .input("county_name", sql.NVarChar(128), name)
    .query(`
      UPDATE dbo.ev_roster_county_pull_status SET confirmed_at = SYSUTCDATETIME()
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date AND county_name = @county_name
    `);
  return listEvRosterCountyPullStatuses(evrElectionId, votingDate);
}

/** Remove all stored pulls, voters, summaries, and per-county pull status (keeps configs & county sources). */
export async function clearEvRosterPullData() {
  const pool = await ensureDb();
  const count = async (table) => {
    const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(r.recordset?.[0]?.n ?? 0);
  };
  const before = {
    voters: await count("dbo.ev_roster_voters"),
    pulls: await count("dbo.ev_roster_pulls"),
  };
  const tables = [
    "dbo.ev_roster_county_pull_log",
    "dbo.ev_roster_county_summary",
    "dbo.ev_roster_county_pull_status",
    "dbo.ev_roster_voters",
    "dbo.ev_roster_pulls",
    "dbo.ev_roster_activity_cache",
    "dbo.ev_roster_registered_cache",
  ];
  for (const t of tables) {
    await pool.request().query(`DELETE FROM ${t}`);
  }
  return { cleared: before, remaining: { voters: 0, pulls: 0 } };
}

export async function saveEvRosterPull(payload, options = {}) {
  if (options?.merge) return mergeEvRosterPull(payload);
  const {
    evrElectionId,
    votingDate,
    hubPageUrl,
    sosTurnoutUrl,
    sosRosterUrl,
    statewideVoterCount,
    rawRecordCount,
    dedupedVoterCount,
    ok,
    message,
    countySummaries,
    voters,
    countyPullLog,
  } = payload;
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const locked = await getConfirmedEvRosterCountyNames(eid, vDate);
  const { filterSummariesForLocked, filterVotersForLocked } = await import("./lib/evRosterCountyStatus.mjs");
  let preservedSummaries = [];
  if (locked.size) {
    const existing = await getEvRosterPullPayload(eid, vDate);
    preservedSummaries = (existing?.counties ?? []).filter((c) =>
      locked.has(String(c.countyName ?? "").toUpperCase()),
    );
  }
  const summariesToWrite = [
    ...filterSummariesForLocked(countySummaries, locked),
    ...preservedSummaries,
  ];
  const votersToWrite = filterVotersForLocked(voters, locked);
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const req = () => new sql.Request(transaction);
    await req()
      .input("evr_election_id", sql.Int, eid)
      .input("voting_date", sql.NVarChar(16), vDate)
      .query(`DELETE FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
    const ins = await req()
      .input("evr_election_id", sql.Int, eid)
      .input("voting_date", sql.NVarChar(16), vDate)
      .input("hub_page_url", sql.NVarChar(2048), hubPageUrl ?? null)
      .input("sos_turnout_url", sql.NVarChar(2048), sosTurnoutUrl ?? null)
      .input("sos_roster_url", sql.NVarChar(2048), sosRosterUrl ?? null)
      .input("statewide_voter_count", sql.BigInt, Number(statewideVoterCount ?? 0))
      .input("raw_record_count", sql.BigInt, Number(rawRecordCount ?? 0))
      .input("deduped_voter_count", sql.BigInt, Number(dedupedVoterCount ?? 0))
      .input("ok", sql.Bit, ok === false ? 0 : 1)
      .input("message", sql.NVarChar(sql.MAX), String(message ?? "").slice(0, 4000))
      .query(`
        INSERT INTO dbo.ev_roster_pulls
          (evr_election_id, voting_date, hub_page_url, sos_turnout_url, sos_roster_url, statewide_voter_count,
           raw_record_count, deduped_voter_count, ok, message)
        OUTPUT INSERTED.id AS id
        VALUES (@evr_election_id, @voting_date, @hub_page_url, @sos_turnout_url, @sos_roster_url, @statewide_voter_count,
                @raw_record_count, @deduped_voter_count, @ok, @message)
      `);
    const pullId = Number(ins.recordset?.[0]?.id);
    for (const c of summariesToWrite) {
      await req()
        .input("pull_id", sql.Int, pullId)
        .input("county_name", sql.NVarChar(128), String(c.countyName ?? ""))
        .input("county_id", sql.Int, c.countyId != null ? Number(c.countyId) : null)
        .input("registered_voters", sql.BigInt, Number(c.registeredVoters ?? 0))
        .input("in_person_votes_on_date", sql.BigInt, Number(c.inPersonVotesOnDate ?? 0))
        .input("total_in_person_votes_for_election", sql.BigInt, Number(c.totalInPersonVotesForElection ?? 0))
        .input("total_mail_votes_for_election", sql.BigInt, Number(c.totalMailVotesForElection ?? 0))
        .input("cumulative_total", sql.BigInt, Number(c.cumulativeTotal ?? 0))
        .input("sos_voter_count", sql.BigInt, Number(c.sosVoterCount ?? 0))
        .input("county_voter_count", sql.BigInt, Number(c.countyVoterCount ?? 0))
        .input("chosen_source", sql.NVarChar(32), String(c.chosenSource ?? "sos"))
        .input("chosen_voter_count", sql.BigInt, Number(c.chosenVoterCount ?? 0))
        .query(`
          INSERT INTO dbo.ev_roster_county_summary
            (pull_id, county_name, county_id, registered_voters, in_person_votes_on_date, total_in_person_votes_for_election,
             total_mail_votes_for_election, cumulative_total, sos_voter_count, county_voter_count, chosen_source, chosen_voter_count)
          VALUES (@pull_id, @county_name, @county_id, @registered_voters, @in_person_votes_on_date, @total_in_person_votes_for_election,
                  @total_mail_votes_for_election, @cumulative_total, @sos_voter_count, @county_voter_count, @chosen_source, @chosen_voter_count)
        `);
    }
    if (locked.size) {
      const names = [...locked];
      const placeholders = names.map((_, i) => `@lock_${i}`).join(", ");
      const delReq = req()
        .input("evr_election_id", sql.Int, eid)
        .input("voting_date", sql.NVarChar(16), vDate);
      names.forEach((n, i) => delReq.input(`lock_${i}`, sql.NVarChar(128), n));
      await delReq.query(`
        DELETE FROM dbo.ev_roster_voters
        WHERE evr_election_id = @evr_election_id
          AND COALESCE(reporting_date, voting_date) = @voting_date
          AND county_name NOT IN (${placeholders})
      `);
    } else {
      await req()
        .input("evr_election_id", sql.Int, eid)
        .input("voting_date", sql.NVarChar(16), vDate)
        .query(`
          DELETE FROM dbo.ev_roster_voters
          WHERE evr_election_id = @evr_election_id
            AND COALESCE(reporting_date, voting_date) = @voting_date
        `);
    }
    for (const v of votersToWrite) {
      const activityDate = resolveVoterActivityDate(v, vDate);
      await req()
        .input("evr_election_id", sql.Int, eid)
        .input("voting_date", sql.NVarChar(16), activityDate)
        .input("reporting_date", sql.NVarChar(16), vDate)
        .input("county_name", sql.NVarChar(128), String(v.countyName ?? v.county ?? ""))
        .input("vuid", sql.NVarChar(32), String(v.vuid ?? ""))
        .input("voter_name", sql.NVarChar(256), v.voterName != null ? String(v.voterName) : null)
        .input("voting_method", sql.NVarChar(64), v.votingMethod != null ? String(v.votingMethod) : null)
        .input("method_code", sql.NVarChar(8), v.methodCode != null ? String(v.methodCode) : null)
        .input("party", sql.NVarChar(16), v.party != null ? String(v.party) : null)
        .input("precinct", sql.NVarChar(64), v.precinct != null ? String(v.precinct) : null)
        .input("source", sql.NVarChar(32), String(v.sourceKey ?? v.source ?? "sos"))
        .query(`
          MERGE dbo.ev_roster_voters AS target
          USING (SELECT @evr_election_id AS evr_election_id, @voting_date AS voting_date, @vuid AS vuid) AS source
          ON target.evr_election_id = source.evr_election_id AND target.voting_date = source.voting_date
            AND target.county_name = @county_name AND target.vuid = source.vuid
          WHEN MATCHED THEN UPDATE SET
            voter_name = @voter_name, voting_method = @voting_method,
            method_code = @method_code, party = @party, precinct = @precinct, source = @source,
            reporting_date = @reporting_date
          WHEN NOT MATCHED THEN INSERT
            (evr_election_id, voting_date, reporting_date, county_name, vuid, voter_name, voting_method, method_code, party, precinct, source)
          VALUES (@evr_election_id, @voting_date, @reporting_date, @county_name, @vuid, @voter_name, @voting_method, @method_code, @party, @precinct, @source);
        `);
    }
    for (const log of countyPullLog ?? []) {
      await req()
        .input("pull_id", sql.Int, pullId)
        .input("county_key", sql.NVarChar(64), String(log.countyKey ?? ""))
        .input("county_name", sql.NVarChar(128), String(log.countyName ?? ""))
        .input("handler_key", sql.NVarChar(64), String(log.handlerKey ?? ""))
        .input("ok", sql.Bit, log.ok === false ? 0 : 1)
        .input("voter_count", sql.BigInt, Number(log.voterCount ?? 0))
        .input("source_url", sql.NVarChar(2048), log.sourceUrl ?? null)
        .input("message", sql.NVarChar(sql.MAX), String(log.message ?? "").slice(0, 2000))
        .query(`
          INSERT INTO dbo.ev_roster_county_pull_log
            (pull_id, county_key, county_name, handler_key, ok, voter_count, source_url, message)
          VALUES (@pull_id, @county_key, @county_name, @handler_key, @ok, @voter_count, @source_url, @message)
        `);
    }
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
  await rebuildEvRosterSummaryCache(eid, { pool });
  return getEvRosterPullPayload(eid, vDate);
}

/**
 * One row per VUID per runoff election — keep earliest voting_date (then lowest id).
 * @returns {Promise<{ removed: number, distinctVuids: number }>}
 */
export async function dedupeEvRosterVotersKeepOldestDate(evrElectionId) {
  const pool = await ensureDb();
  const eid = Number(evrElectionId);

  const beforeR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id`);
  const before = Number(beforeR.recordset?.[0]?.n ?? 0);

  await pool.request().input("evr_election_id", sql.Int, eid).query(`
    DELETE FROM dbo.ev_roster_voters
    WHERE evr_election_id = @evr_election_id
    AND id NOT IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY vuid ORDER BY voting_date ASC, id ASC) AS rn
        FROM dbo.ev_roster_voters
        WHERE evr_election_id = @evr_election_id
      ) ranked WHERE rn = 1
    )
  `);

  const afterR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id`);
  const after = Number(afterR.recordset?.[0]?.n ?? 0);

  const distinctR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .query(`SELECT COUNT(DISTINCT vuid) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id`);
  const distinctVuids = Number(distinctR.recordset?.[0]?.n ?? 0);

  await pool.request().input("evr_election_id", sql.Int, eid).query(`
    UPDATE p SET deduped_voter_count = c.n
    FROM dbo.ev_roster_pulls p
    INNER JOIN (
      SELECT evr_election_id, voting_date, COUNT(*) AS n
      FROM dbo.ev_roster_voters
      WHERE evr_election_id = @evr_election_id
      GROUP BY evr_election_id, voting_date
    ) c ON c.evr_election_id = p.evr_election_id AND c.voting_date = p.voting_date
    WHERE p.evr_election_id = @evr_election_id
  `);

  await rebuildEvRosterSummaryCache(eid, { pool });
  return { removed: Math.max(0, before - after), distinctVuids };
}

export async function rebuildEvRosterSummaryCacheForElection(evrElectionId) {
  const pool = await ensureDb();
  return rebuildEvRosterSummaryCache(Number(evrElectionId), { pool });
}

export async function mergeEvRosterPull({
  evrElectionId,
  votingDate,
  hubPageUrl,
  sosTurnoutUrl,
  sosRosterUrl,
  statewideVoterCount,
  rawRecordCount,
  dedupedVoterCount,
  ok,
  message,
  countySummaries,
  voters,
  countyPullLog,
}) {
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const locked = await getConfirmedEvRosterCountyNames(eid, vDate);
  const { filterSummariesForLocked, filterVotersForLocked } = await import("./lib/evRosterCountyStatus.mjs");
  const countySummariesWritable = filterSummariesForLocked(countySummaries, locked);
  const votersWritable = filterVotersForLocked(voters, locked);
  const findR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .input("voting_date", sql.NVarChar(16), vDate)
    .query(`SELECT TOP 1 id FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
  let pullId = findR.recordset?.[0]?.id != null ? Number(findR.recordset[0].id) : null;
  if (pullId == null) {
    const ins = await pool
      .request()
      .input("evr_election_id", sql.Int, eid)
      .input("voting_date", sql.NVarChar(16), vDate)
      .input("hub_page_url", sql.NVarChar(2048), hubPageUrl ?? null)
      .input("sos_turnout_url", sql.NVarChar(2048), sosTurnoutUrl ?? null)
      .input("sos_roster_url", sql.NVarChar(2048), sosRosterUrl ?? null)
      .input("statewide_voter_count", sql.BigInt, Number(statewideVoterCount ?? 0))
      .input("message", sql.NVarChar(sql.MAX), String(message ?? "Merged county pull").slice(0, 4000))
      .query(`
        INSERT INTO dbo.ev_roster_pulls
          (evr_election_id, voting_date, hub_page_url, sos_turnout_url, sos_roster_url, statewide_voter_count, raw_record_count, deduped_voter_count, ok, message)
        OUTPUT INSERTED.id AS id
        VALUES (@evr_election_id, @voting_date, @hub_page_url, @sos_turnout_url, @sos_roster_url, @statewide_voter_count, 0, 0, 1, @message)
      `);
    pullId = Number(ins.recordset?.[0]?.id);
  }
  const voterCountyNames = [
    ...new Set(
      (votersWritable ?? []).map((v) => String(v.countyName ?? v.county ?? "").toUpperCase()).filter(Boolean),
    ),
  ];
  for (const name of voterCountyNames) {
    await pool
      .request()
      .input("evr_election_id", sql.Int, eid)
      .input("voting_date", sql.NVarChar(16), vDate)
      .input("county_name", sql.NVarChar(128), name)
      .query(`
        DELETE FROM dbo.ev_roster_voters
        WHERE evr_election_id = @evr_election_id
          AND COALESCE(reporting_date, voting_date) = @voting_date
          AND county_name = @county_name
      `);
  }
  const summaryCountyNames = [
    ...new Set(
      (countySummariesWritable ?? []).map((c) => String(c.countyName ?? "").toUpperCase()).filter(Boolean),
    ),
  ];
  for (const name of summaryCountyNames) {
    await pool
      .request()
      .input("pull_id", sql.Int, pullId)
      .input("county_name", sql.NVarChar(128), name)
      .query(`DELETE FROM dbo.ev_roster_county_summary WHERE pull_id = @pull_id AND county_name = @county_name`);
  }
  for (const c of countySummariesWritable) {
    await pool
      .request()
      .input("pull_id", sql.Int, pullId)
      .input("county_name", sql.NVarChar(128), String(c.countyName ?? ""))
      .input("county_id", sql.Int, c.countyId != null ? Number(c.countyId) : null)
      .input("registered_voters", sql.BigInt, Number(c.registeredVoters ?? 0))
      .input("in_person_votes_on_date", sql.BigInt, Number(c.inPersonVotesOnDate ?? 0))
      .input("total_in_person_votes_for_election", sql.BigInt, Number(c.totalInPersonVotesForElection ?? 0))
      .input("total_mail_votes_for_election", sql.BigInt, Number(c.totalMailVotesForElection ?? 0))
      .input("cumulative_total", sql.BigInt, Number(c.cumulativeTotal ?? 0))
      .input("sos_voter_count", sql.BigInt, Number(c.sosVoterCount ?? 0))
      .input("county_voter_count", sql.BigInt, Number(c.countyVoterCount ?? 0))
      .input("chosen_source", sql.NVarChar(32), String(c.chosenSource ?? "county"))
      .input("chosen_voter_count", sql.BigInt, Number(c.chosenVoterCount ?? 0))
      .query(`
        INSERT INTO dbo.ev_roster_county_summary
          (pull_id, county_name, county_id, registered_voters, in_person_votes_on_date, total_in_person_votes_for_election,
           total_mail_votes_for_election, cumulative_total, sos_voter_count, county_voter_count, chosen_source, chosen_voter_count)
        VALUES (@pull_id, @county_name, @county_id, @registered_voters, @in_person_votes_on_date, @total_in_person_votes_for_election,
                @total_mail_votes_for_election, @cumulative_total, @sos_voter_count, @county_voter_count, @chosen_source, @chosen_voter_count)
      `);
  }
  for (const v of votersWritable) {
    const activityDate = resolveVoterActivityDate(v, vDate);
    await pool
      .request()
      .input("evr_election_id", sql.Int, eid)
      .input("voting_date", sql.NVarChar(16), activityDate)
      .input("reporting_date", sql.NVarChar(16), vDate)
      .input("county_name", sql.NVarChar(128), String(v.countyName ?? v.county ?? ""))
      .input("vuid", sql.NVarChar(32), String(v.vuid ?? ""))
      .input("voter_name", sql.NVarChar(256), v.voterName != null ? String(v.voterName) : null)
      .input("voting_method", sql.NVarChar(64), v.votingMethod != null ? String(v.votingMethod) : null)
      .input("method_code", sql.NVarChar(8), v.methodCode != null ? String(v.methodCode) : null)
      .input("party", sql.NVarChar(16), v.party != null ? String(v.party) : null)
      .input("precinct", sql.NVarChar(64), v.precinct != null ? String(v.precinct) : null)
      .input("source", sql.NVarChar(64), String(v.sourceKey ?? v.source ?? "county"))
      .query(`
        MERGE dbo.ev_roster_voters AS target
        USING (SELECT @evr_election_id AS evr_election_id, @voting_date AS voting_date, @vuid AS vuid) AS source
        ON target.evr_election_id = source.evr_election_id AND target.voting_date = source.voting_date
          AND target.county_name = @county_name AND target.vuid = source.vuid
        WHEN MATCHED THEN UPDATE SET
          voter_name = @voter_name, voting_method = @voting_method,
          method_code = @method_code, party = @party, precinct = @precinct, source = @source,
          reporting_date = @reporting_date
        WHEN NOT MATCHED THEN INSERT
          (evr_election_id, voting_date, reporting_date, county_name, vuid, voter_name, voting_method, method_code, party, precinct, source)
        VALUES (@evr_election_id, @voting_date, @reporting_date, @county_name, @vuid, @voter_name, @voting_method, @method_code, @party, @precinct, @source);
      `);
  }
  for (const log of countyPullLog ?? []) {
    await pool
      .request()
      .input("pull_id", sql.Int, pullId)
      .input("county_key", sql.NVarChar(64), String(log.countyKey ?? ""))
      .input("county_name", sql.NVarChar(128), String(log.countyName ?? ""))
      .input("handler_key", sql.NVarChar(64), String(log.handlerKey ?? ""))
      .input("ok", sql.Bit, log.ok === false ? 0 : 1)
      .input("voter_count", sql.BigInt, Number(log.voterCount ?? 0))
      .input("source_url", sql.NVarChar(2048), log.sourceUrl ?? null)
      .input("message", sql.NVarChar(sql.MAX), String(log.message ?? "").slice(0, 2000))
      .query(`
        INSERT INTO dbo.ev_roster_county_pull_log
          (pull_id, county_key, county_name, handler_key, ok, voter_count, source_url, message)
        VALUES (@pull_id, @county_key, @county_name, @handler_key, @ok, @voter_count, @source_url, @message)
      `);
  }
  await dedupeEvRosterVotersKeepOldestDate(eid);

  const countR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .input("voting_date", sql.NVarChar(16), vDate)
    .query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
  const totalVoters = Number(countR.recordset?.[0]?.n ?? 0);
  await pool
    .request()
    .input("id", sql.Int, pullId)
    .input("raw_record_count", sql.BigInt, Number(rawRecordCount ?? 0))
    .input("deduped_voter_count", sql.BigInt, totalVoters)
    .input("message", sql.NVarChar(sql.MAX), String(message ?? "").slice(0, 4000))
    .input("ok", sql.Bit, ok === false ? 0 : 1)
    .query(`
      UPDATE dbo.ev_roster_pulls SET
        raw_record_count = COALESCE(raw_record_count, 0) + @raw_record_count,
        deduped_voter_count = @deduped_voter_count,
        message = @message,
        pulled_at = SYSUTCDATETIME(),
        ok = @ok
      WHERE id = @id
    `);
  return getEvRosterPullPayload(eid, vDate);
}

export async function listEvRosterVoters(evrElectionId, votingDate, options = {}) {
  const { normalizeVoterCountyFilter } = await import("./lib/evRosterVoters.mjs");
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 5000);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const countyList = normalizeVoterCountyFilter(options.counties, options.county);
  const q = options.q ? String(options.q).trim() : "";

  let where = `WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`;
  const req = pool.request().input("evr_election_id", sql.Int, eid).input("voting_date", sql.NVarChar(16), vDate);
  countyList.forEach((name, i) => {
    req.input(`county_${i}`, sql.NVarChar(128), name);
  });
  if (countyList.length) {
    where += ` AND county_name IN (${countyList.map((_, i) => `@county_${i}`).join(", ")})`;
  }
  if (q) {
    where += ` AND (vuid LIKE @q OR county_name LIKE @q OR party LIKE @q)`;
    req.input("q", sql.NVarChar(128), `%${q}%`);
  }
  const countR = await req.query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters ${where}`);
  const total = Number(countR.recordset?.[0]?.n ?? 0);
  const dataReq = pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .input("voting_date", sql.NVarChar(16), vDate)
    .input("limit", sql.Int, limit)
    .input("offset", sql.Int, offset);
  countyList.forEach((name, i) => {
    dataReq.input(`county_${i}`, sql.NVarChar(128), name);
  });
  if (q) dataReq.input("q", sql.NVarChar(128), `%${q}%`);
  const dataR = await dataReq.query(`
      SELECT vuid, party, voting_date AS votingDate, county_name AS countyName,
             COALESCE(method_code, N'EV') AS methodCode
      FROM dbo.ev_roster_voters
      ${where}
      ORDER BY county_name, vuid
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);
  return {
    total,
    limit,
    offset,
    rows: (dataR.recordset ?? []).map((row) => ({
      vuid: String(row.vuid ?? ""),
      party: String(row.party ?? ""),
      votingDate: String(row.votingDate ?? ""),
      countyName: String(row.countyName ?? ""),
      methodCode: String(row.methodCode ?? "EV"),
    })),
  };
}

export async function listEvRosterPullDates(evrElectionId) {
  return listEvRosterPullDatesForElections([Number(evrElectionId)]);
}

export async function listEvRosterPullDatesForElections(evrElectionIds) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT voting_date AS votingDate, MAX(pulled_at) AS pulledAt,
           SUM(statewide_voter_count) AS statewideVoterCount, MIN(CAST(ok AS INT)) AS okMin,
           MAX(message) AS message
    FROM dbo.ev_roster_pulls
    WHERE evr_election_id IN (${ids.join(", ")})
    GROUP BY voting_date ORDER BY voting_date DESC
  `);
  return (r.recordset ?? []).map((row) => ({
    votingDate: String(row.votingDate ?? ""),
    pulledAt: row.pulledAt instanceof Date ? row.pulledAt.toISOString() : String(row.pulledAt ?? ""),
    statewideVoterCount: Number(row.statewideVoterCount ?? 0),
    ok: row.okMin == null ? true : !!row.okMin,
    message: String(row.message ?? ""),
  }));
}

export async function listEvRosterVoterDatesForElections(evrElectionIds) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT voting_date AS votingDate, COUNT(DISTINCT vuid) AS voterCount
    FROM dbo.ev_roster_voters
    WHERE evr_election_id IN (${ids.join(", ")})
    GROUP BY voting_date ORDER BY voting_date DESC
  `);
  return (r.recordset ?? []).map((row) => ({
    votingDate: String(row.votingDate ?? ""),
    pulledAt: "",
    statewideVoterCount: Number(row.voterCount ?? 0),
    ok: true,
    message: "",
  }));
}

export async function getEvRosterAggregatedSummary(evrElectionIds, dateFrom, dateTo) {
  const { countiesFromVoterActivityInRange, computeSummaryTotals } = await import(
    "./lib/evRosterAggregateSummary.mjs"
  );
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  const from = String(dateFrom ?? "").trim();
  const to = String(dateTo ?? "").trim();
  if (!ids.length || !from || !to) {
    return { pull: null, counties: [], dateFrom: from, dateTo: to, countyPullLog: [] };
  }

  const pool = await ensureDb();
  const idList = ids.join(", ");

  const {
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statewideDistinct,
    storedVoterCount,
  } = await loadSummaryRollupsFromCache(ids, from, to, { pool });

  const statusR = await pool.request().query(`
    SELECT county_name AS countyName, voting_date AS votingDate, last_pull_ok AS lastPullOk,
           last_pull_at AS lastPullAt, last_pull_message AS lastPullMessage, voter_count AS voterCount,
           confirmed_at AS confirmedAt
    FROM dbo.ev_roster_county_pull_status
    WHERE evr_election_id IN (${idList})
  `);
  const statusByCounty = new Map();
  for (const s of statusR.recordset ?? []) {
    const county = String(s.countyName ?? "").toUpperCase();
    const vDate = String(s.votingDate ?? "");
    const prev = statusByCounty.get(county);
    if (!prev || vDate >= String(prev.votingDate ?? "")) {
      statusByCounty.set(county, {
        votingDate: vDate,
        lastPullOk: s.lastPullOk == null ? null : !!s.lastPullOk,
        lastPullAt: s.lastPullAt instanceof Date ? s.lastPullAt.toISOString() : s.lastPullAt ? String(s.lastPullAt) : null,
        lastPullMessage: s.lastPullMessage != null ? String(s.lastPullMessage) : null,
        voterCount: Number(s.voterCount ?? 0),
        confirmedAt: s.confirmedAt instanceof Date ? s.confirmedAt.toISOString() : s.confirmedAt ? String(s.confirmedAt) : null,
      });
    }
  }

  const counties = countiesFromVoterActivityInRange({
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statusByCounty,
  });

  const summaryTotals = computeSummaryTotals(
    { registeredByCounty, evInPersonDayByCounty },
    0,
    statewideDistinct,
  );
  summaryTotals.cumulativeTotal = storedVoterCount || summaryTotals.cumulativeTotal;
  summaryTotals.chosenVoterCount = storedVoterCount;

  const pullAggR = await pool.request().query(`
    SELECT MAX(pulled_at) AS pulledAt, MIN(CAST(ok AS INT)) AS okMin FROM dbo.ev_roster_pulls WHERE evr_election_id IN (${idList})
  `);
  const pullAgg = pullAggR.recordset?.[0] ?? {};

  return {
    dateFrom: from,
    dateTo: to,
    pull: {
      evrElectionIds: ids,
      votingDate: `${from}..${to}`,
      pulledAt: pullAgg.pulledAt instanceof Date ? pullAgg.pulledAt.toISOString() : String(pullAgg.pulledAt ?? ""),
      ok: pullAgg.okMin == null ? true : !!pullAgg.okMin,
      storedVoterCount,
      dedupedVoterCount: storedVoterCount,
      message: `Voter activity ${from} through ${to}`,
    },
    counties,
    countyPullLog: [],
    summaryTotals,
  };
}

export async function getEvRosterPullPayload(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const pullR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .input("voting_date", sql.NVarChar(16), vDate)
    .query(`
      SELECT TOP 1 id, evr_election_id AS evrElectionId, voting_date AS votingDate, hub_page_url AS hubPageUrl,
             sos_turnout_url AS sosTurnoutUrl, sos_roster_url AS sosRosterUrl, statewide_voter_count AS statewideVoterCount,
             raw_record_count AS rawRecordCount, deduped_voter_count AS dedupedVoterCount,
             pulled_at AS pulledAt, ok, message
      FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date
    `);
  const pullRow = pullR.recordset?.[0];
  if (!pullRow) return null;
  const pullId = Number(pullRow.id);
  const countyR = await pool.request().input("pull_id", sql.Int, pullId).query(`
    SELECT county_name AS countyName, county_id AS countyId, registered_voters AS registeredVoters,
           in_person_votes_on_date AS inPersonVotesOnDate, total_in_person_votes_for_election AS totalInPersonVotesForElection,
           total_mail_votes_for_election AS totalMailVotesForElection, cumulative_total AS cumulativeTotal,
           sos_voter_count AS sosVoterCount, county_voter_count AS countyVoterCount,
           chosen_source AS chosenSource, chosen_voter_count AS chosenVoterCount
    FROM dbo.ev_roster_county_summary WHERE pull_id = @pull_id ORDER BY county_name
  `);
  const countR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .input("voting_date", sql.NVarChar(16), vDate)
    .query(
      `SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`,
    );
  const storedVoterCount = Number(countR.recordset?.[0]?.n ?? 0);
  const pullStatuses = await listEvRosterCountyPullStatuses(eid, vDate);
  const statusByCounty = new Map(pullStatuses.map((s) => [String(s.countyName).toUpperCase(), s]));
  return {
    pull: {
      evrElectionId: eid,
      votingDate: String(pullRow.votingDate ?? ""),
      hubPageUrl: pullRow.hubPageUrl ? String(pullRow.hubPageUrl) : null,
      sosTurnoutUrl: pullRow.sosTurnoutUrl ? String(pullRow.sosTurnoutUrl) : null,
      sosRosterUrl: pullRow.sosRosterUrl ? String(pullRow.sosRosterUrl) : null,
      statewideVoterCount: Number(pullRow.statewideVoterCount ?? 0),
      rawRecordCount: Number(pullRow.rawRecordCount ?? 0),
      dedupedVoterCount: Number(pullRow.dedupedVoterCount ?? 0),
      pulledAt: pullRow.pulledAt instanceof Date ? pullRow.pulledAt.toISOString() : String(pullRow.pulledAt ?? ""),
      ok: !!pullRow.ok,
      message: String(pullRow.message ?? ""),
      storedVoterCount,
    },
    counties: (countyR.recordset ?? []).map((r) => {
      const countyName = String(r.countyName ?? "");
      const st = statusByCounty.get(countyName.toUpperCase());
      return {
        countyName,
        countyId: r.countyId != null ? Number(r.countyId) : null,
        registeredVoters: Number(r.registeredVoters ?? 0),
        inPersonVotesOnDate: Number(r.inPersonVotesOnDate ?? 0),
        totalInPersonVotesForElection: Number(r.totalInPersonVotesForElection ?? 0),
        totalMailVotesForElection: Number(r.totalMailVotesForElection ?? 0),
        cumulativeTotal: Number(r.cumulativeTotal ?? 0),
        sosVoterCount: Number(r.sosVoterCount ?? 0),
        countyVoterCount: Number(r.countyVoterCount ?? 0),
        chosenSource: String(r.chosenSource ?? "sos"),
        chosenVoterCount: Number(r.chosenVoterCount ?? 0),
        pullStatus: st
          ? {
              lastPullOk: st.lastPullOk,
              lastPullAt: st.lastPullAt,
              lastPullMessage: st.lastPullMessage,
              voterCount: st.voterCount,
              confirmedAt: st.confirmedAt,
            }
          : null,
      };
    }),
    countyPullLog: await getEvRosterCountyPullLog(eid, vDate),
  };
}

export async function listEvRosterCountySources(evrElectionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("evr_election_id", sql.Int, Number(evrElectionId)).query(`
    SELECT id, evr_election_id AS evrElectionId, county_key AS countyKey, variant_key AS variantKey,
           source_label AS sourceLabel, civix_county_name AS civixCountyName, civix_county_id AS civixCountyId,
           handler_key AS handlerKey, hub_page_url AS hubPageUrl, roster_url AS rosterUrl,
           voting_method_scope AS votingMethodScope, date_scope AS dateScope, file_format AS fileFormat,
           roster_party_scope AS rosterPartyScope,
           discovery_profile_key AS discoveryProfileKey, training_notes AS trainingNotes, is_enabled AS isEnabled,
           last_pull_ok AS lastPullOk, last_pull_message AS lastPullMessage, last_pull_at AS lastPullAt
    FROM dbo.ev_roster_county_sources WHERE evr_election_id = @evr_election_id ORDER BY civix_county_name, variant_key
  `);
  return (r.recordset ?? []).map((row) => ({
    id: Number(row.id),
    evrElectionId: Number(row.evrElectionId),
    countyKey: String(row.countyKey ?? ""),
    variantKey: String(row.variantKey ?? "sos-default"),
    sourceLabel: String(row.sourceLabel ?? ""),
    civixCountyName: String(row.civixCountyName ?? ""),
    civixCountyId: row.civixCountyId != null ? Number(row.civixCountyId) : null,
    handlerKey: String(row.handlerKey ?? "civix_sos_county_slice"),
    hubPageUrl: String(row.hubPageUrl ?? ""),
    rosterUrl: String(row.rosterUrl ?? ""),
    votingMethodScope: String(row.votingMethodScope ?? "ALL"),
    dateScope: String(row.dateScope ?? "SINGLE_DAY"),
    fileFormat: String(row.fileFormat ?? "auto"),
    rosterPartyScope: String(row.rosterPartyScope ?? "COMBINED"),
    discoveryProfileKey: row.discoveryProfileKey != null ? String(row.discoveryProfileKey) : null,
    trainingNotes: row.trainingNotes != null ? String(row.trainingNotes) : null,
    isEnabled: !!row.isEnabled,
    lastPullOk: row.lastPullOk == null ? null : !!row.lastPullOk,
    lastPullMessage: row.lastPullMessage != null ? String(row.lastPullMessage) : null,
    lastPullAt: row.lastPullAt instanceof Date ? row.lastPullAt.toISOString() : row.lastPullAt ? String(row.lastPullAt) : null,
  }));
}

export async function upsertEvRosterCountySource(row) {
  const pool = await ensureDb();
  const variantKey = String(row.variantKey ?? "custom").slice(0, 64);
  if (row.id != null) {
    await pool
      .request()
      .input("id", sql.Int, Number(row.id))
      .input("source_label", sql.NVarChar(256), String(row.sourceLabel ?? ""))
      .input("civix_county_name", sql.NVarChar(128), String(row.civixCountyName ?? ""))
      .input("civix_county_id", sql.Int, row.civixCountyId != null ? Number(row.civixCountyId) : null)
      .input("handler_key", sql.NVarChar(64), String(row.handlerKey ?? "generic_file_url"))
      .input("hub_page_url", sql.NVarChar(2048), String(row.hubPageUrl ?? ""))
      .input("roster_url", sql.NVarChar(2048), String(row.rosterUrl ?? ""))
      .input("voting_method_scope", sql.NVarChar(16), String(row.votingMethodScope ?? "ALL"))
      .input("date_scope", sql.NVarChar(32), String(row.dateScope ?? "SINGLE_DAY"))
      .input("file_format", sql.NVarChar(16), String(row.fileFormat ?? "auto"))
      .input("roster_party_scope", sql.NVarChar(16), String(row.rosterPartyScope ?? "COMBINED"))
      .input("discovery_profile_key", sql.NVarChar(64), row.discoveryProfileKey != null ? String(row.discoveryProfileKey) : null)
      .input("training_notes", sql.NVarChar(sql.MAX), row.trainingNotes != null ? String(row.trainingNotes) : null)
      .input("is_enabled", sql.Bit, row.isEnabled === false ? 0 : 1)
      .query(`
        UPDATE dbo.ev_roster_county_sources SET
          source_label = @source_label, civix_county_name = @civix_county_name,
          civix_county_id = COALESCE(@civix_county_id, civix_county_id),
          handler_key = @handler_key, hub_page_url = @hub_page_url, roster_url = @roster_url,
          voting_method_scope = @voting_method_scope, date_scope = @date_scope, file_format = @file_format,
          roster_party_scope = @roster_party_scope,
          discovery_profile_key = @discovery_profile_key, training_notes = @training_notes, is_enabled = @is_enabled,
          updated_at = SYSUTCDATETIME()
        WHERE id = @id
      `);
    return;
  }
  await pool
    .request()
    .input("evr_election_id", sql.Int, Number(row.evrElectionId))
    .input("county_key", sql.NVarChar(64), String(row.countyKey ?? ""))
    .input("variant_key", sql.NVarChar(64), variantKey)
    .input("source_label", sql.NVarChar(256), String(row.sourceLabel ?? ""))
    .input("civix_county_name", sql.NVarChar(128), String(row.civixCountyName ?? ""))
    .input("civix_county_id", sql.Int, row.civixCountyId != null ? Number(row.civixCountyId) : null)
    .input("handler_key", sql.NVarChar(64), String(row.handlerKey ?? "generic_file_url"))
    .input("hub_page_url", sql.NVarChar(2048), String(row.hubPageUrl ?? ""))
    .input("roster_url", sql.NVarChar(2048), String(row.rosterUrl ?? ""))
    .input("voting_method_scope", sql.NVarChar(16), String(row.votingMethodScope ?? "ALL"))
    .input("date_scope", sql.NVarChar(32), String(row.dateScope ?? "SINGLE_DAY"))
    .input("file_format", sql.NVarChar(16), String(row.fileFormat ?? "auto"))
    .input("roster_party_scope", sql.NVarChar(16), String(row.rosterPartyScope ?? "COMBINED"))
    .input("discovery_profile_key", sql.NVarChar(64), row.discoveryProfileKey != null ? String(row.discoveryProfileKey) : null)
    .input("training_notes", sql.NVarChar(sql.MAX), row.trainingNotes != null ? String(row.trainingNotes) : null)
    .input("is_enabled", sql.Bit, row.isEnabled === false ? 0 : 1)
    .query(`
      MERGE dbo.ev_roster_county_sources AS target
      USING (SELECT @evr_election_id AS evr_election_id, @county_key AS county_key, @variant_key AS variant_key) AS source
      ON target.evr_election_id = source.evr_election_id AND target.county_key = source.county_key
        AND target.variant_key = source.variant_key
      WHEN MATCHED THEN UPDATE SET
        source_label = @source_label, civix_county_name = @civix_county_name,
        civix_county_id = COALESCE(@civix_county_id, target.civix_county_id),
        handler_key = @handler_key, hub_page_url = @hub_page_url, roster_url = @roster_url,
        voting_method_scope = @voting_method_scope, date_scope = @date_scope, file_format = @file_format,
        roster_party_scope = @roster_party_scope,
        discovery_profile_key = @discovery_profile_key, training_notes = @training_notes, is_enabled = @is_enabled,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (evr_election_id, county_key, variant_key, source_label, civix_county_name, civix_county_id, handler_key,
         hub_page_url, roster_url, voting_method_scope, date_scope, file_format, roster_party_scope,
         discovery_profile_key, training_notes, is_enabled)
      VALUES (@evr_election_id, @county_key, @variant_key, @source_label, @civix_county_name, @civix_county_id, @handler_key,
              @hub_page_url, @roster_url, @voting_method_scope, @date_scope, @file_format, @roster_party_scope,
              @discovery_profile_key, @training_notes, @is_enabled);
    `);
}

export async function syncEvRosterCountySourcesFromTurnout(evrElectionId, counties) {
  const { civixCountyNameToKey } = await import("./lib/texasCountyKeys.mjs");
  for (const c of counties ?? []) {
    const name = String(c.name ?? c.countyName ?? "").toUpperCase();
    if (!name || name === "TOTAL") continue;
    await upsertEvRosterCountySource({
      evrElectionId,
      countyKey: civixCountyNameToKey(name),
      variantKey: "sos-default",
      sourceLabel: "SOS default",
      civixCountyName: name,
      civixCountyId: c.id ?? c.countyId ?? null,
      handlerKey: "civix_sos_county_slice",
      hubPageUrl: "",
      rosterUrl: "",
      votingMethodScope: "ALL",
      dateScope: "SINGLE_DAY",
      fileFormat: "auto",
      isEnabled: true,
    });
  }
  return listEvRosterCountySources(evrElectionId);
}

export async function getEvRosterExportRows(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("evr_election_id", sql.Int, Number(evrElectionId))
    .input("voting_date", sql.NVarChar(16), String(votingDate ?? "").trim())
    .query(`
      SELECT vuid, party, voting_date AS votingDate, county_name AS countyName, COALESCE(method_code, N'EV') AS methodCode
      FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date
      ORDER BY county_name, vuid
    `);
  return (r.recordset ?? []).map((row) => ({
    vuid: String(row.vuid ?? ""),
    party: String(row.party ?? ""),
    votingDate: String(row.votingDate ?? ""),
    countyName: String(row.countyName ?? ""),
    methodCode: String(row.methodCode ?? "EV"),
  }));
}

export async function getEvRosterCountyPullLog(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const pullR = await pool
    .request()
    .input("evr_election_id", sql.Int, Number(evrElectionId))
    .input("voting_date", sql.NVarChar(16), String(votingDate ?? "").trim())
    .query(`SELECT TOP 1 id FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
  const pullId = pullR.recordset?.[0]?.id;
  if (pullId == null) return [];
  const r = await pool.request().input("pull_id", sql.Int, Number(pullId)).query(`
    SELECT county_key AS countyKey, county_name AS countyName, handler_key AS handlerKey, ok,
           voter_count AS voterCount, source_url AS sourceUrl, message
    FROM dbo.ev_roster_county_pull_log WHERE pull_id = @pull_id ORDER BY county_name
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    countyName: String(row.countyName ?? ""),
    handlerKey: String(row.handlerKey ?? ""),
    ok: !!row.ok,
    voterCount: Number(row.voterCount ?? 0),
    sourceUrl: row.sourceUrl != null ? String(row.sourceUrl) : null,
    message: String(row.message ?? ""),
  }));
}
