/*
  Run in SSMS against an existing database (e.g. CREATE DATABASE electionnighttracker; USE electionnighttracker;).
  The Node API runs the same logic on startup when MSSQL_SERVER is set.
*/

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
GO

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
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_manual_elections_updated' AND object_id = OBJECT_ID(N'dbo.manual_elections'))
  CREATE INDEX idx_manual_elections_updated ON dbo.manual_elections (updated_at);
GO

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
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_snapshots_provider_ext' AND object_id = OBJECT_ID(N'dbo.election_snapshots'))
  CREATE INDEX idx_snapshots_provider_ext ON dbo.election_snapshots (provider, external_id);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.data_sources WHERE id = N'manual-default')
BEGIN
  INSERT INTO dbo.data_sources (id, kind, display_name, notes)
  VALUES (N'manual-default', N'manual_json', N'Manual JSON upload', N'Rows in manual_elections');
END;
GO
