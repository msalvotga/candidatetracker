export type OfficeCategory = "house" | "senate" | "sboe" | "statewide" | "congressional";
export type AppTab = "races" | "counties" | "staffers" | "data" | "admin";
export type UserRole = "admin" | "viewer";

export interface AppUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AppPermissions {
  isAdmin: boolean;
  canAccessData: boolean;
  canEdit: boolean;
  canManageUsers: boolean;
}

export interface AuthMeResponse {
  user: AppUser | null;
  permissions: AppPermissions;
  authenticated: boolean;
  guestAccess?: boolean;
}
export type CountyElection = "pres_2024" | "cruz_2024" | "abbott_2022";

export interface FinanceReportEntry {
  id: number | string;
  period_key?: string | null;
  period_label: string;
  report_period_end: string | null;
  contributions: number | null;
  expenditures: number | null;
  cash_on_hand: number | null;
  sort_order?: number | null;
  read_only?: boolean;
}

export interface PendingFinanceEntry {
  localId: string;
  candidateKey: string;
  candidate_id?: number;
  period_key: string;
  period_label: string;
  report_period_end: string | null;
  contributions: number | null;
  expenditures: number | null;
  cash_on_hand: number | null;
}

/** @deprecated use FinanceReportEntry */
export type CohHistoryEntry = FinanceReportEntry;

/** @deprecated use PendingFinanceEntry */
export type PendingCohEntry = PendingFinanceEntry;

export interface ConsultantRef {
  consultant_key: string;
  name: string;
}

export interface RaceCandidate {
  candidate_id?: number;
  vuid?: string | null;
  name: string;
  party: string;
  is_incumbent: boolean;
  filed?: boolean;
  tec_filer_id?: string | null;
  consultants?: ConsultantRef[];
  consultant_keys?: string[];
  /** Joined display names from consultants table */
  consultant?: string | null;
  endorsements?: string | null;
  notes?: string | null;
  website?: string | null;
  social_media?: string | null;
  running_for_reelection?: string | null;
  race_category?: string | null;
  finance_history?: FinanceReportEntry[];
  /** @deprecated use finance_history */
  coh_history?: FinanceReportEntry[];
}

export interface RaceMetric {
  key: string;
  label: string;
  value: number | null;
  uncontested?: boolean;
  winning_party?: string | null;
}

export interface Race {
  office_id: number;
  office_code: string;
  office_name: string;
  district: number | null;
  /** Set when races from multiple categories are loaded together. */
  category?: OfficeCategory;
  metrics: RaceMetric[];
  candidates: RaceCandidate[];
  seat_holder?: SeatHolder | null;
  /** Incumbent is not on the November ballot for this race. */
  is_open?: boolean;
  /** Office is on the ballot this cycle (senate, SBOE, statewide only). */
  up_for_reelection?: boolean;
  targeting_organizations?: TargetingOrganizationRef[];
  targeting_organization_keys?: string[];
  /** Abbott/TGA staff assigned to this office or its counties. */
  tga_staffer_names?: string[];
}

export interface SeatHolder {
  name: string;
  party: string | null;
  source?: "office" | "incumbent" | "sheet" | "leg_2024";
}

export interface TargetingOrganizationRef {
  org_key: string;
  name: string;
}

export interface TargetingOrganization {
  org_key: string;
  name: string;
}

export interface Consultant {
  consultant_key: string;
  name: string;
  candidate_count?: number;
}

export interface RacesResponse {
  category: OfficeCategory;
  cycleYear: number;
  races: Race[];
  filing_periods?: FilingPeriodDef[];
  targeting_organizations?: TargetingOrganization[];
  consultants?: Consultant[];
}

export interface FilingPeriodDef {
  period_key: string;
  label: string;
  sort_order: number;
  default_report_period_end: string | null;
}

export interface CountyResult {
  county_name: string;
  county_key: string;
  margin: number | null;
  gop_pct: number | null;
  dem_pct: number | null;
  gop_votes: number | null;
  dem_votes: number | null;
}

export interface CountiesResponse {
  election: CountyElection;
  counties: CountyResult[];
}

export interface MetricContestCandidate {
  candidate_name: string;
  party: string;
  votes: number | null;
  vote_pct: number | null;
  unopposed: boolean;
}

export interface MetricContest {
  office_id: number;
  office_code: string;
  office_name: string;
  metric_key: string;
  label: string;
  contest_name: string;
  gop_share: number | null;
  total_votes?: number | null;
  uncontested?: boolean;
  winning_party?: string | null;
  derived?: boolean;
  note?: string;
  source?: string;
  candidates: MetricContestCandidate[];
}

export interface StafferMapEntry {
  id: number;
  name: string;
  counties: string[];
}

export interface StafferDistrictEntry {
  id: number;
  name: string;
  districts: number[];
}

export interface StafferMapResponse {
  staffers: StafferMapEntry[];
  districtStaffers: StafferDistrictEntry[];
}
