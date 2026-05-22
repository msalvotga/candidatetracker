import { apiFetch } from "./apiBase";

async function readEvRosterJson<T extends { error?: string }>(
  r: Response,
  label: string,
): Promise<T> {
  const text = await r.text();
  if (!text.trim()) {
    if (!r.ok) throw new Error(`HTTP ${r.status} (${label})`);
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      r.ok ? `Invalid JSON (${label})` : `HTTP ${r.status} (${label}): ${text.slice(0, 220)}`,
    );
  }
}

export interface EvRosterConfig {
  evrElectionId: number;
  party: string;
  electionName: string;
  electionDate: string;
  isEnabled: boolean;
  notes: string | null;
  updatedAt: string;
}

export interface EvRosterCountyPullStatus {
  lastPullOk: boolean | null;
  lastPullAt: string | null;
  lastPullMessage: string | null;
  voterCount: number;
  confirmedAt: string | null;
  /** Present on aggregated summary rows — date to use for confirm API */
  votingDate?: string;
}

export interface EvRosterRunoff {
  runoffKey: string;
  electionDate: string;
  label: string;
  evrElectionIds: number[];
  parties: string[];
  primaryEvrElectionId: number | null;
  configs: EvRosterConfig[];
}

export interface EvRosterCountySummary {
  countyName: string;
  countyId: number | null;
  registeredVoters: number;
  inPersonVotesOnDate: number;
  totalInPersonVotesForElection: number;
  totalMailVotesForElection: number;
  cumulativeTotal: number;
  sosVoterCount: number;
  countyVoterCount: number;
  chosenSource: string;
  chosenVoterCount: number;
  pullStatus?: EvRosterCountyPullStatus | null;
}

export interface EvRosterPullMeta {
  evrElectionId: number;
  votingDate: string;
  hubPageUrl: string | null;
  sosTurnoutUrl: string | null;
  sosRosterUrl: string | null;
  statewideVoterCount: number;
  rawRecordCount?: number;
  dedupedVoterCount?: number;
  pulledAt: string;
  ok: boolean;
  message: string;
  storedVoterCount: number;
}

export interface EvRosterCountyPullLogEntry {
  countyKey: string;
  countyName: string;
  variantKey?: string;
  sourceLabel?: string;
  handlerKey: string;
  ok: boolean;
  voterCount: number;
  sourceUrl: string | null;
  message: string;
}

export interface EvRosterSourceOption {
  id: string;
  label: string;
}

export interface EvRosterSourceOptionsPayload {
  votingMethodScopes: EvRosterSourceOption[];
  dateScopes: EvRosterSourceOption[];
  fileFormats: EvRosterSourceOption[];
  rosterPartyScopes: EvRosterSourceOption[];
}

/** True when this row is a trained county file/hub source (not the auto SOS slice only). */
export function isCustomCountySource(source: EvRosterCountySource): boolean {
  if (source.variantKey !== "sos-default") return true;
  if (source.hubPageUrl?.trim() || source.rosterUrl?.trim()) return true;
  return (
    source.handlerKey !== "civix_sos_county_slice" &&
    source.handlerKey !== "unimplemented"
  );
}

export function civixCountyNameToSourceKey(countyName: string): string {
  return countyName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

export interface EvRosterCountySource {
  id: number;
  evrElectionId: number;
  countyKey: string;
  variantKey: string;
  sourceLabel: string;
  civixCountyName: string;
  civixCountyId: number | null;
  handlerKey: string;
  hubPageUrl: string;
  rosterUrl: string;
  votingMethodScope: string;
  dateScope: string;
  fileFormat: string;
  rosterPartyScope: string;
  discoveryProfileKey: string | null;
  trainingNotes: string | null;
  isEnabled: boolean;
  lastPullOk?: boolean | null;
  lastPullMessage?: string | null;
  lastPullAt?: string | null;
}

export interface EvRosterSummaryTotals {
  registeredVoters: number;
  inPersonVotesOnDate: number;
  totalInPersonVotesForElection: number;
  totalMailVotesForElection: number;
  cumulativeTotal: number;
  chosenVoterCount: number;
}

export interface EvRosterSummaryPayload {
  pull: EvRosterPullMeta | null;
  counties: EvRosterCountySummary[];
  countyPullLog?: EvRosterCountyPullLogEntry[];
  dateFrom?: string;
  dateTo?: string;
  party?: string;
  /** Distinct statewide counts for the footer row (not a sum of visible counties). */
  summaryTotals?: EvRosterSummaryTotals;
  /** Live Civix SOS data when no stored pull exists for this runoff + date yet. */
  sosPreview?: boolean;
  message?: string;
}

export interface EvRosterHandler {
  id: string;
  displayName: string;
  notes: string;
}

export async function fetchEvRosterVoters(
  evrElectionId: number,
  votingDate: string,
  options?: { limit?: number; offset?: number; counties?: string[]; q?: string },
) {
  const q = new URLSearchParams({
    evrElectionId: String(evrElectionId),
    votingDate,
  });
  if (options?.limit != null) q.set("limit", String(options.limit));
  if (options?.offset != null) q.set("offset", String(options.offset));
  if (options?.counties?.length) {
    for (const county of options.counties) q.append("county", county);
  }
  if (options?.q) q.set("q", options.q);
  const r = await apiFetch(`/api/ev-roster/voters?${q}`, { cache: "no-store" });
  const body = await readEvRosterJson<{
    evrElectionId?: number;
    votingDate?: string;
    total?: number;
    limit?: number;
    offset?: number;
    rows?: EvRosterVoterRow[];
    error?: string;
  }>(r, "voters");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as {
    evrElectionId: number;
    votingDate: string;
    total: number;
    limit: number;
    offset: number;
    rows: EvRosterVoterRow[];
  };
}

export async function fetchEvRosterConfigs(): Promise<{
  configs: EvRosterConfig[];
  runoffs: EvRosterRunoff[];
}> {
  const r = await apiFetch("/api/ev-roster/configs", { cache: "no-store" });
  const body = await readEvRosterJson<{
    configs?: EvRosterConfig[];
    runoffs?: EvRosterRunoff[];
    error?: string;
  }>(r, "configs");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return { configs: body.configs ?? [], runoffs: body.runoffs ?? [] };
}

export async function fetchEvRosterPullDates(evrElectionId: number) {
  const r = await apiFetch(`/api/ev-roster/pulls?evrElectionId=${evrElectionId}`, { cache: "no-store" });
  const body = await readEvRosterJson<{
    evrElectionId?: number;
    pulls?: Array<{
      votingDate: string;
      pulledAt: string;
      statewideVoterCount: number;
      ok: boolean;
      message: string;
    }>;
    error?: string;
  }>(r, "pulls");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as {
    evrElectionId: number;
    pulls: Array<{
      votingDate: string;
      pulledAt: string;
      statewideVoterCount: number;
      ok: boolean;
      message: string;
    }>;
  };
}

/** Earliest / latest voter activity dates through today (county summary filters). */
export function summaryDateRangeFromPullDates(pullDates: string[]) {
  const stored = [...new Set(pullDates.map((d) => d.trim()).filter(Boolean))].sort();
  if (!stored.length) return { dateFrom: "", dateTo: "" };
  const today = new Date().toISOString().slice(0, 10);
  return { dateFrom: stored[0], dateTo: today };
}

export async function fetchEvRosterSummary(
  evrElectionId: number,
  options: { dateFrom?: string; dateTo?: string; party?: string; votingDate?: string } = {},
): Promise<EvRosterSummaryPayload | null> {
  const q = new URLSearchParams({ evrElectionId: String(evrElectionId) });
  if (options.dateFrom) q.set("dateFrom", options.dateFrom);
  if (options.dateTo) q.set("dateTo", options.dateTo);
  q.set("party", options.party ?? "ALL");
  if (options.votingDate) q.set("votingDate", options.votingDate);
  const r = await apiFetch(`/api/ev-roster/summary?${q}`, { cache: "no-store" });
  if (r.status === 404) return null;
  const body = await readEvRosterJson<
    EvRosterSummaryPayload & { pull?: EvRosterSummaryPayload["pull"] | null; error?: string }
  >(r, "summary");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  if (options.dateFrom && options.dateTo) {
    return {
      counties: body.counties ?? [],
      pull: body.pull ?? null,
      countyPullLog: body.countyPullLog ?? [],
      dateFrom: body.dateFrom ?? options.dateFrom,
      dateTo: body.dateTo ?? options.dateTo,
      party: body.party,
      sosPreview: body.sosPreview,
      message: body.message,
    } as EvRosterSummaryPayload;
  }
  if (!body.pull && !body.sosPreview && !(body.counties?.length ?? 0)) return null;
  return body as EvRosterSummaryPayload;
}

export type EvRosterPullScope = "all" | "counties" | "sos" | "county";

export interface EvRosterPullProgress {
  active: boolean;
  jobId?: string;
  phase?: string;
  message?: string;
  votingDate?: string;
  party?: string;
  countyName?: string;
  countyKey?: string;
  sourceLabel?: string;
  handlerKey?: string;
  pullScope?: string;
  step?: number;
  totalSteps?: number;
  batchStep?: number;
  batchTotal?: number;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  result?: {
    daysPulled?: number;
    electionsPulled?: number;
    rawRecordCount?: number;
    dedupedVoterCount?: number;
    countyPullCount?: number;
    skipped?: Array<{ votingDate?: string; party?: string; message?: string }>;
  };
}

export async function fetchEvRosterPullProgress(jobId: string): Promise<EvRosterPullProgress> {
  const q = new URLSearchParams({ jobId });
  const r = await apiFetch(`/api/ev-roster/pull/progress?${q}`, { cache: "no-store" });
  const body = await readEvRosterJson<EvRosterPullProgress & { error?: string }>(r, "pull-progress");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export interface EvRosterVoterRow {
  vuid: string;
  countyName: string;
  party: string;
  votingDate: string;
  methodCode: string;
}

/** Display/export date as YYYYMMDD. */
export function formatEvRosterDateYyyymmdd(votingDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(votingDate ?? "").trim());
  return m ? `${m[1]}${m[2]}${m[3]}` : String(votingDate ?? "").replace(/\D/g, "").slice(0, 8);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runEvRosterPull(
  evrElectionId: number,
  options?: {
    pullScope?: EvRosterPullScope;
    countyKey?: string;
    votingDate?: string;
    pullThroughToday?: boolean;
    jobId?: string;
    onProgress?: (p: EvRosterPullProgress) => void;
  },
) {
  const jobId = options?.jobId ?? crypto.randomUUID();
  const r = await apiFetch("/api/ev-roster/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evrElectionId, pullThroughToday: true, jobId, ...options }),
  });
  const text = await r.text();
  let body: {
    ok?: boolean;
    started?: boolean;
    jobId?: string;
    error?: string;
  } = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(r.ok ? "Invalid response from server" : `HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
  }
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);

  const pollId = body.jobId ?? jobId;
  for (let i = 0; i < 7200; i++) {
    const p = await fetchEvRosterPullProgress(pollId);
    options?.onProgress?.(p);
    if (!p.active) {
      if (p.phase === "error" || p.error) {
        throw new Error(p.message ?? p.error ?? "Pull failed");
      }
      if (p.result) return { ok: true, jobId: pollId, ...p.result };
      return { ok: true, jobId: pollId };
    }
    await sleep(500);
  }
  throw new Error("Pull timed out — check server logs");
}

export async function confirmEvRosterCountyPull(
  evrElectionId: number,
  votingDate: string,
  countyName: string,
): Promise<EvRosterSummaryPayload | null> {
  const r = await apiFetch("/api/ev-roster/county-confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evrElectionId, votingDate, countyName }),
  });
  const body = await readEvRosterJson<
    { ok?: boolean; summary?: EvRosterSummaryPayload | null; error?: string }
  >(r, "county-confirm");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.summary ?? null;
}

export function evRosterExportCsvUrl(evrElectionId: number, votingDate: string) {
  const q = new URLSearchParams({ evrElectionId: String(evrElectionId), votingDate });
  return `/api/ev-roster/export.csv?${q}`;
}

export async function fetchEvRosterCountySources(evrElectionId: number): Promise<EvRosterCountySource[]> {
  const r = await apiFetch(`/api/ev-roster/county-sources?evrElectionId=${evrElectionId}`, { cache: "no-store" });
  const body = await readEvRosterJson<{ sources?: EvRosterCountySource[]; error?: string }>(r, "county-sources");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.sources ?? [];
}

export async function fetchEvRosterHandlers(): Promise<EvRosterHandler[]> {
  const r = await apiFetch("/api/ev-roster/handlers", { cache: "no-store" });
  const body = await readEvRosterJson<{ handlers?: EvRosterHandler[]; error?: string }>(r, "handlers");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.handlers ?? [];
}

export async function fetchEvRosterSourceOptions(): Promise<EvRosterSourceOptionsPayload> {
  const r = await apiFetch("/api/ev-roster/source-options", { cache: "no-store" });
  const body = await readEvRosterJson<EvRosterSourceOptionsPayload & { error?: string }>(r, "source-options");
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function saveEvRosterCountySource(payload: {
  id?: number | null;
  evrElectionId: number;
  countyKey: string;
  variantKey?: string;
  sourceLabel?: string;
  civixCountyName: string;
  civixCountyId?: number | null;
  handlerKey?: string;
  hubPageUrl?: string;
  rosterUrl?: string;
  votingMethodScope?: string;
  dateScope?: string;
  fileFormat?: string;
  rosterPartyScope?: string;
  trainingNotes?: string | null;
  isEnabled?: boolean;
}): Promise<EvRosterCountySource[]> {
  const r = await apiFetch("/api/ev-roster/county-sources", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body: { sources?: EvRosterCountySource[]; error?: string } = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(r.ok ? "Invalid response from server" : `HTTP ${r.status}`);
    }
  }
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body.sources ?? [];
}

export interface EvRosterDiscoverMatch {
  url: string;
  matchedStage: string;
  matchedLabel: string;
  linkText?: string;
  suggestedVariantKey?: string;
  suggestedLabel?: string;
  suggestedMethodScope?: string;
  suggestedDateScope?: string;
  suggestedFileFormat?: string;
  suggestedRosterPartyScope?: string;
}

export async function discoverEvRosterCountyUrl(
  hubPageUrl: string,
  countyKey: string,
  methodScope?: string,
) {
  const r = await apiFetch("/api/ev-roster/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hubPageUrl, countyKey, methodScope }),
  });
  const body = await readEvRosterJson<
    EvRosterDiscoverMatch & { url?: string | null; message?: string; error?: string }
  >(r, "discover");
  if (!r.ok) throw new Error(body.error ?? body.message ?? `HTTP ${r.status}`);
  return body;
}

export async function discoverEvRosterCountyUrls(
  hubPageUrl: string,
  countyKey: string,
  options?: { evrElectionId?: number; electionDate?: string },
) {
  const r = await apiFetch("/api/ev-roster/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hubPageUrl,
      countyKey,
      discoverAll: true,
      evrElectionId: options?.evrElectionId,
      electionDate: options?.electionDate,
    }),
  });
  const body = await readEvRosterJson<{
    matches?: EvRosterDiscoverMatch[];
    message?: string;
    error?: string;
  }>(r, "discover-all");
  if (!r.ok) throw new Error(body.error ?? body.message ?? `HTTP ${r.status}`);
  return body;
}

/** Convert YYYY-MM-DD to MM/DD/YYYY for Civix page links. */
export function isoToCivixDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}
