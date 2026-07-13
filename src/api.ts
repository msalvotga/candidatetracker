import type {
  AppUser,
  AuthMeResponse,
  CountiesResponse,
  CountyElection,
  CountyResult,
  Consultant,
  FilingPeriodDef,
  FinanceReportEntry,
  MetricContest,
  OfficeCategory,
  RacesResponse,
  StafferMapResponse,
  TargetingOrganization,
} from "./types";

function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, credentials: "include" });
}

export async function fetchRaces(category: OfficeCategory, year: number): Promise<RacesResponse> {
  const params = new URLSearchParams({ category, year: String(year) });
  const res = await apiFetch(`/api/races?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load races (${res.status})`);
  }
  return res.json();
}

export async function createTargetingOrganization(org_key: string, name: string) {
  const res = await apiFetch("/api/targeting/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org_key, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to create organization");
  }
  return res.json() as Promise<TargetingOrganization>;
}

export async function createConsultant(consultant_key: string, name: string) {
  const res = await apiFetch("/api/consultants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consultant_key, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to create consultant");
  }
  return res.json() as Promise<Consultant>;
}

export async function fetchFilingPeriods(): Promise<FilingPeriodDef[]> {
  const res = await apiFetch("/api/filing-periods");
  if (!res.ok) return [];
  const body = await res.json();
  return body.periods ?? [];
}

export async function fetchCycles(): Promise<number[]> {
  const res = await apiFetch("/api/cycles");
  if (!res.ok) return [new Date().getFullYear()];
  const body = await res.json();
  return body.years ?? [new Date().getFullYear()];
}

export async function fetchCounties(election: CountyElection): Promise<CountiesResponse> {
  const params = new URLSearchParams({ election });
  const res = await apiFetch(`/api/counties?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load counties (${res.status})`);
  }
  return res.json();
}

export async function fetchStafferMap(): Promise<StafferMapResponse> {
  const res = await apiFetch("/api/tga-staffers/map");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load staffer map (${res.status})`);
  }
  return res.json();
}

export async function saveCountyStafferAssignments(
  countyName: string,
  stafferIds: number[]
): Promise<StafferMapResponse> {
  const res = await apiFetch("/api/tga-staffers/county-assignments", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ county_name: countyName, staffer_ids: stafferIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to save county assignments (${res.status})`);
  }
  return res.json();
}

export async function createStaffer(fields: {
  name: string;
  map_color?: string | null;
}): Promise<StafferMapResponse> {
  const res = await apiFetch("/api/tga-staffers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to create staffer (${res.status})`);
  }
  return res.json();
}

export async function updateStaffer(
  stafferId: number,
  fields: { name?: string; map_color?: string | null }
): Promise<StafferMapResponse> {
  const res = await apiFetch(`/api/tga-staffers/${stafferId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to update staffer (${res.status})`);
  }
  return res.json();
}

export async function saveOfficeMetric(officeId: number, key: string, value: number | null) {
  const res = await apiFetch(`/api/offices/${officeId}/metrics`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to save metric (${res.status})`);
  }
  return res.json();
}

export async function addFinanceReport(options: {
  candidateId?: number;
  officeId: number;
  cycleYear: number;
  candidateName: string;
  party: string;
  isIncumbent: boolean;
  period_key?: string;
  period_label?: string;
  report_period_end?: string | null;
  contributions?: number | null;
  expenditures?: number | null;
  cash_on_hand?: number | null;
}) {
  const res = await apiFetch("/api/races/finance-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidate_id: options.candidateId,
      office_id: options.officeId,
      cycle_year: options.cycleYear,
      candidate_name: options.candidateName,
      party: options.party,
      is_incumbent: options.isIncumbent,
      period_key: options.period_key,
      period_label: options.period_label,
      report_period_end: options.report_period_end ?? null,
      contributions: options.contributions,
      expenditures: options.expenditures,
      cash_on_hand: options.cash_on_hand,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to add finance report (${res.status})`);
  }
  return res.json() as Promise<{ entry: FinanceReportEntry }>;
}

function adminApiError(res: Response, fallback: string) {
  if (res.status === 404) {
    return "API server is out of date or not running. Stop any old server and run `npm run dev` from candidate-lookup.";
  }
  return fallback;
}

export async function fetchAdminTables() {
  const res = await apiFetch("/api/admin/tables");
  if (!res.ok) throw new Error(adminApiError(res, "Failed to load admin tables"));
  const body = await res.json();
  return body.tables as {
    id: string;
    label: string;
    editableColumns: string[];
    multiSelectColumns?: Record<string, string>;
    selectColumns?: Record<string, string>;
    selectValueKind?: Record<string, string>;
    insertableColumns?: string[];
    deletable?: boolean;
  }[];
}

export async function fetchMultiSelectOptions(
  refTable: string,
  options: { cycleYear?: number; category?: string } = {}
) {
  const params = new URLSearchParams();
  if (options.cycleYear) params.set("cycle_year", String(options.cycleYear));
  if (options.category) params.set("category", options.category);
  const res = await apiFetch(`/api/admin/multi-select/${encodeURIComponent(refTable)}?${params}`);
  if (!res.ok) return [];
  const body = await res.json();
  return (body.options ?? []) as { value: string; label: string; count?: number }[];
}

export async function saveAdminTableRows(
  tableName: string,
  updates: { id: number | string; fields: Record<string, unknown> }[],
  cycleYear?: number
) {
  const res = await apiFetch(`/api/admin/tables/${encodeURIComponent(tableName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates, cycle_year: cycleYear }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? adminApiError(res, `Failed to save ${tableName}`));
  }
  return res.json() as Promise<{ updated: number }>;
}

export async function insertAdminTableRow(tableName: string, fields: Record<string, unknown>) {
  const res = await apiFetch(`/api/admin/tables/${encodeURIComponent(tableName)}/rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? adminApiError(res, `Failed to add row to ${tableName}`));
  }
  return res.json() as Promise<{ row: Record<string, unknown> }>;
}

export async function deleteAdminTableRow(tableName: string, id: string | number) {
  const params = new URLSearchParams({ id: String(id) });
  const res = await apiFetch(
    `/api/admin/tables/${encodeURIComponent(tableName)}/rows?${params}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? adminApiError(res, `Failed to delete row from ${tableName}`));
  }
  return res.json() as Promise<{ deleted: number }>;
}

export async function fetchAdminTable(
  tableName: string,
  options: {
    cycleYear?: number;
    category?: OfficeCategory;
    limit?: number;
    offset?: number;
    singleCandidateRaces?: boolean;
  }
) {
  const params = new URLSearchParams();
  if (options.cycleYear) params.set("cycle_year", String(options.cycleYear));
  if (options.category) params.set("category", options.category);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  if (options.singleCandidateRaces) params.set("single_candidate_races", "1");
  const res = await apiFetch(`/api/admin/tables/${encodeURIComponent(tableName)}?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? adminApiError(res, `Failed to load ${tableName}`));
  }
  return res.json() as Promise<{ rows: Record<string, unknown>[]; total: number }>;
}

export function exportAdminTableCsv(
  tableName: string,
  options: { cycleYear?: number; category?: OfficeCategory }
) {
  const params = new URLSearchParams();
  if (options.cycleYear) params.set("cycle_year", String(options.cycleYear));
  if (options.category) params.set("category", options.category);
  return `/api/admin/export/${encodeURIComponent(tableName)}.csv?${params}`;
}

export function exportBallotSummaryXlsx(cycleYear: number) {
  return `/api/export/ballot?year=${cycleYear}`;
}

export async function bulkImportFinance(rows: Record<string, string>[]) {
  const res = await apiFetch("/api/admin/finance/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Bulk import failed");
  }
  return res.json() as Promise<{ imported: number; errors: { row: number; error: string }[] }>;
}

export async function bulkImportElectionResults(rows: Record<string, string>[]) {
  const res = await apiFetch("/api/admin/election-results/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Bulk import failed");
  }
  return res.json() as Promise<{
    processed: number;
    imported: number;
    inserted: number;
    updated: number;
    unchanged: number;
    errors: { row: number; error: string }[];
  }>;
}

export async function bulkImportElectionResultsCsv(csvText: string) {
  const res = await apiFetch("/api/admin/election-results/bulk-csv", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: csvText,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Bulk import failed");
  }
  return res.json() as Promise<{
    processed: number;
    imported: number;
    inserted: number;
    updated: number;
    unchanged: number;
    errors: { row: number; error: string }[];
  }>;
}

export async function saveCandidateConsultants(candidateId: number, consultant_keys: string[]) {
  const res = await apiFetch(`/api/candidates/${candidateId}/consultants`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consultant_keys }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to save consultants");
  }
  return res.json() as Promise<{
    consultant_keys: string[];
    consultants: { consultant_key: string; name: string }[];
    consultant: string | null;
  }>;
}

export async function updateCandidateVuid(candidateId: number, vuid: string | null) {
  const res = await apiFetch(`/api/admin/candidates/${candidateId}/vuid`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vuid }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to update VUID");
  }
  return res.json() as Promise<{ id: number; vuid: string | null }>;
}

export async function saveCountyResult(
  election: CountyElection,
  countyKey: string,
  patch: Partial<Pick<CountyResult, "margin" | "gop_pct" | "dem_pct" | "gop_votes" | "dem_votes">>
) {
  const res = await apiFetch(`/api/counties/${encodeURIComponent(countyKey)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ election, ...patch }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to save county (${res.status})`);
  }
  const body = await res.json();
  return body.county as CountyResult;
}

export async function fetchMetricContest(officeId: number, metricKey: string): Promise<MetricContest> {
  const res = await apiFetch(`/api/offices/${officeId}/metrics/${encodeURIComponent(metricKey)}/contest`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load contest (${res.status})`);
  }
  return res.json();
}

export async function fetchAuthMe(): Promise<AuthMeResponse> {
  const res = await apiFetch("/api/auth/me");
  if (!res.ok) {
    throw new Error("Failed to load auth status");
  }
  return res.json();
}

export async function fetchAdminUsers() {
  const res = await apiFetch("/api/admin/users");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to load users");
  }
  const body = await res.json();
  return body.users as AppUser[];
}

export async function createAdminUser(fields: {
  username: string;
  display_name?: string;
  role: AppUser["role"];
  password: string;
  active?: boolean;
}) {
  const res = await apiFetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to create user");
  }
  const body = await res.json();
  return body.user as AppUser;
}

export async function updateAdminUser(
  userId: number,
  fields: Partial<Pick<AppUser, "display_name" | "role" | "active">> & { password?: string }
) {
  const res = await apiFetch(`/api/admin/users/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to update user");
  }
  const body = await res.json();
  return body.user as AppUser;
}

export async function deleteAdminUser(userId: number) {
  const res = await apiFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to delete user");
  }
  return res.json() as Promise<{ deleted: number }>;
}

export async function loginUser(email: string, password: string, rememberMe: boolean) {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, remember_me: rememberMe }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Login failed");
  }
  return res.json() as Promise<AuthMeResponse & { remember_me?: boolean; expires_at?: string }>;
}

export async function logoutUser() {
  const res = await apiFetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Logout failed");
  }
  return res.json() as Promise<{ ok: boolean }>;
}
