-- Organizations targeting specific offices in a cycle (letter IDs)

CREATE TABLE IF NOT EXISTS targeting_organizations (
  org_key TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS office_targets (
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  cycle_year INTEGER NOT NULL,
  org_key TEXT NOT NULL REFERENCES targeting_organizations(org_key) ON DELETE CASCADE,
  PRIMARY KEY (office_id, cycle_year, org_key)
);

CREATE INDEX IF NOT EXISTS idx_office_targets_office_cycle ON office_targets(office_id, cycle_year);
CREATE INDEX IF NOT EXISTS idx_office_targets_org ON office_targets(org_key);
