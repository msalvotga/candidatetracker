export type OfficeType =
  | "FEDERAL OFFICES"
  | "STATEWIDE OFFICES"
  | "DISTRICT OFFICES"
  | "STATEWIDE PROPOSITIONS"
  | "LOCAL"
  | string;

export type DataSourceType = "sos" | "county" | string;

export interface DataSource {
  id: string;
  label: string;
  type: DataSourceType;
}

export interface CandidateInput {
  id: string;
  name: string;
  party: string;
  incumbent?: boolean;
  earlyVotes: number;
  totalVotes: number;
}

export interface CountyCandidateVotes {
  earlyVotes: number;
  electionDayVotes: number;
  totalVotes: number;
}

export interface CountyRowInput {
  id: string;
  name: string;
  /** Data lineage marker for county row values. */
  sourceTag?: "CNTY" | "SOS" | "MIX" | string;
  precinctsReporting: string;
  /** Numeric precinct counts when available (ribbon / gauges). */
  precinctReportingCount?: number;
  precinctTotalCount?: number;
  /** When true, row is pinned at top (state aggregate). */
  isTotalRow?: boolean;
  candidates: Record<string, CountyCandidateVotes>;
}

export interface RaceInput {
  id: string;
  officeType: OfficeType;
  title: string;
  candidates: CandidateInput[];
  counties?: CountyRowInput[];
}

export interface ReportingSnapshot {
  counties: { reported: number; total: number };
  pollingLocations: { reported: number; total: number };
  /** Machine-readable timestamp when known (ISO). */
  lastUpdated: string;
  /** When set, shown instead of formatting `lastUpdated` (for vendor-provided strings). */
  lastUpdatedDisplay?: string;
  /** Shown in header ribbon, e.g. OFFICIAL RESULTS */
  resultStatus?: string;
  /** Optional label next to refresh/timer area */
  nextUpdateNote?: string;
}

export interface ElectionFile {
  schemaVersion: number;
  source: DataSource;
  election: {
    id: string;
    label: string;
    /** Short line for nav bar, e.g. 2026 REPUBLICAN PRIMARY */
    navTitle?: string;
  };
  reporting: ReportingSnapshot;
  races: RaceInput[];
}

export interface CandidateRowView {
  id: string;
  name: string;
  party: string;
  incumbent?: boolean;
  earlyVotes: number;
  electionDayVotes: number;
  totalVotes: number;
  percent: number;
}

/** Civix-only: which SOS / countyInfo URL was configured vs actually fetched. */
export interface CivixLoadMeta {
  sosCountyInfoUrlConfigured: string;
  sosCountyInfoUrlUsed: string;
}

export interface LoadedElection {
  catalogId: string;
  catalogLabel: string;
  file: ElectionFile;
  civixMeta?: CivixLoadMeta;
}
