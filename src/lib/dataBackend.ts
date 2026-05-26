import type { CivixElectionListItem } from "./civix/api";
import type { ElectionFile, LoadedElection } from "../types/election";
import { apiFetch } from "./apiBase";
import { mapCivixPayloadToElectionFile } from "./civix/mapCivixElection";

/** One row in the election dropdown (Civix or manual). */
export interface ElectionOption {
  catalogId: string;
  catalogLabel: string;
  provider: "civix" | "manual";
  civixElectionId?: number;
}

export async function probeBackend(): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      const r = await apiFetch("/api/health", { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) {
        await sleep(1500);
        continue;
      }
      try {
        const body = (await r.json()) as { databaseReady?: boolean };
        if (body.databaseReady !== false) return true;
      } catch {
        return true;
      }
    } catch {
      /* retry */
    }
    await sleep(1500);
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchCatalogFromBackend(): Promise<{
  options: ElectionOption[];
  defaultCatalogId: string | null;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const r = await apiFetch("/api/catalog", { cache: "no-store", signal: ctrl.signal });
  clearTimeout(timer);
  if (!r.ok) throw new Error(`Catalog HTTP ${r.status}`);
  const j = (await r.json()) as {
    defaultCatalogId?: string | null;
    entries: Array<{
      catalogId: string;
      catalogLabel: string;
      provider: "civix" | "manual";
      civixElectionId?: number;
    }>;
  };
  return {
    defaultCatalogId: j.defaultCatalogId ?? null,
    options: j.entries.map((e) => ({
      catalogId: e.catalogId,
      catalogLabel: e.catalogLabel,
      provider: e.provider,
      civixElectionId: e.civixElectionId,
    })),
  };
}

export async function setDefaultElectionCatalog(electionId: string): Promise<ElectionSourceConfig> {
  const r = await apiFetch(`/api/election-source-configs/${encodeURIComponent(electionId)}/set-default`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ElectionSourceConfig>;
}

export function civixListToOptions(items: CivixElectionListItem[]): ElectionOption[] {
  return items.map((i) => ({
    catalogId: String(i.civixElectionId),
    catalogLabel: i.catalogLabel,
    provider: "civix" as const,
    civixElectionId: i.civixElectionId,
  }));
}

export async function loadElectionFromBackend(catalogId: string, catalogLabel: string): Promise<LoadedElection> {
  const r = await apiFetch("/api/election-data?" + new URLSearchParams({ catalogId }), {
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${catalogId}`);
  const body = (await r.json()) as
    | { provider: "manual"; electionFile: ElectionFile }
    | {
        provider: "civix";
        civixElectionId: number;
        sosCountyInfoUrlConfigured?: string;
        sosCountyInfoUrlUsed?: string;
        election: Record<string, unknown>;
        county: Record<string, unknown>;
      };

  if (body.provider === "manual") {
    return { catalogId, catalogLabel, file: body.electionFile };
  }
  if (body.provider === "civix") {
    const file = mapCivixPayloadToElectionFile(body.civixElectionId, catalogLabel, body.election, body.county);
    return {
      catalogId,
      catalogLabel,
      file,
      civixMeta: {
        sosCountyInfoUrlConfigured: body.sosCountyInfoUrlConfigured ?? "",
        sosCountyInfoUrlUsed: body.sosCountyInfoUrlUsed ?? "",
      },
    };
  }
  throw new Error("Unexpected election response");
}

export interface SourceRegistry {
  civix: { id: string; name: string; type: string; baseUrl: string };
  counties: Array<{ id: string; name: string; type: string; baseUrl: string }>;
  manual: Array<{ id: string; label: string; type: string; updatedAt: string | null }>;
}

export interface DbOverview {
  database: {
    engine: string;
    path?: string;
    server?: string;
    database?: string;
    driver: string;
    ssms?: boolean;
    hint?: string;
  };
  tables: Array<{ name: string; rowCount: number }>;
}

export interface DbTablePreview {
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface AppSettings {
  disableAutoIngest: boolean;
  autoRefreshEnabled?: boolean;
  autoRefreshIntervalSec?: number;
  displayTimeZone?: string;
  sosCountyInfoUrl?: string;
  harrisSourceUrl?: string;
  galvestonSourceUrl?: string;
  jeffersonSourceUrl?: string;
  montgomerySourceUrl?: string;
  chambersSourceUrl?: string;
  /** Paste Cookie header from DevTools on goelect (saved server-side, not echoed back). */
  civixCookie?: string;
  civixCookieConfigured?: boolean;
}

export interface ElectionSourceConfig {
  electionId: string;
  label: string;
  isEnabled: boolean;
  autoRefreshEnabled: boolean;
  /** When false, ingest skips Texas SOS / Civix bundle (county feeds only). */
  usesCivixSos: boolean;
  /** When false, election is hidden from the main page dropdown (Settings → Elections). Default true when omitted. */
  showInCatalog?: boolean;
  /** When true, this election is pre-selected on the home page and in Settings ingest controls. */
  isDefaultCatalog?: boolean;
  sosCountyInfoUrl: string;
  harrisSourceUrl: string;
  galvestonSourceUrl: string;
  jeffersonSourceUrl: string;
  montgomerySourceUrl: string;
  chambersSourceUrl: string;
  updatedAt?: string;
}

export async function fetchSources(): Promise<SourceRegistry> {
  const r = await apiFetch("/api/sources", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<SourceRegistry>;
}

export async function fetchDbOverview(): Promise<DbOverview> {
  const r = await apiFetch("/api/db/overview", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<DbOverview>;
}

export async function fetchDbTablePreview(table: "data_sources" | "sos_county_results", limit = 20): Promise<DbTablePreview> {
  const r = await apiFetch("/api/db/preview?" + new URLSearchParams({ table, limit: String(limit) }), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<DbTablePreview>;
}

export async function fetchAppSettings(): Promise<AppSettings> {
  const r = await apiFetch("/api/settings", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<AppSettings>;
}

export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  const r = await apiFetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<AppSettings>;
}

export async function fetchElectionSourceConfigs(): Promise<{ elections: ElectionSourceConfig[] }> {
  const r = await apiFetch("/api/election-source-configs", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<{ elections: ElectionSourceConfig[] }>;
}

export async function updateElectionSourceConfig(
  electionId: string,
  patch: Partial<ElectionSourceConfig>,
): Promise<ElectionSourceConfig> {
  const r = await apiFetch(`/api/election-source-configs/${encodeURIComponent(electionId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ElectionSourceConfig>;
}

export interface IngestStepTiming {
  phase: string;
  label: string;
  countyKey?: string;
  durationMs: number;
  status: string;
  detail?: string;
}

export interface ForceRefreshResult {
  ok: boolean;
  electionId: number | string;
  sos: { inserted: number; durationMs?: number };
  /** County slug (e.g. harris) → row counts from latest ingest */
  counties: Record<string, { inserted: number; durationMs?: number }>;
  errors: string[];
  /** Non-fatal notes (e.g. Civix 403 on Render with cached SOS) */
  warnings?: string[];
  stepTimings?: IngestStepTiming[];
  totalDurationMs?: number;
}

/** One ingest process (stored as `ingest_vendors` — same process id for every county that shares the URL/steps). */
export interface IngestVendor {
  id: string;
  displayName: string;
  vendorTier: string;
  handlerKey: string;
  notes: string;
}

/** Alias — UI calls these “processes”; API field remains `vendors`. */
export type IngestProcess = IngestVendor;

export async function fetchIngestVendors(): Promise<{ vendors: IngestVendor[] }> {
  const r = await apiFetch("/api/ingest-vendors", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<{ vendors: IngestVendor[] }>;
}

export interface ElectionFeedSourceRow {
  id: number;
  electionId: string;
  scope: string;
  countyKey: string;
  civixCountyName: string;
  vendorId: string;
  sourceUrl: string;
  /** Election results listing page used before ingest to resolve the feed URL (counties with a discovery profile). */
  hubPageUrl: string;
  isEnabled: boolean;
  /** When true with Texas SOS enabled, SD4 merge uses only this feed for the county (not Civix countyInfo). */
  preferOverSos: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface Sd4HistoricalPartyDetail {
  earlyVote: number;
  electionDay: number;
  total: number;
}

export interface Sd4HistoricalGeCountyTotalsPayload {
  description?: string;
  counties: Record<
    string,
    {
      year: number;
      byParty: Record<string, number>;
      byPartyDetail: Record<string, Sd4HistoricalPartyDetail>;
    }
  >;
}

export async function fetchSd4HistoricalGeCountyTotals(): Promise<Sd4HistoricalGeCountyTotalsPayload> {
  const r = await apiFetch("/api/historical/sd4-ge-county-totals", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<Sd4HistoricalGeCountyTotalsPayload>;
}

export async function fetchElectionFeedSources(electionId: string): Promise<{ sources: ElectionFeedSourceRow[] }> {
  const r = await apiFetch(`/api/election-feed-sources/${encodeURIComponent(electionId)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<{ sources: ElectionFeedSourceRow[] }>;
}

export async function saveElectionFeedSources(
  electionId: string,
  sources: Array<
    Pick<
      ElectionFeedSourceRow,
      "countyKey" | "vendorId" | "sourceUrl" | "hubPageUrl" | "isEnabled" | "civixCountyName" | "preferOverSos"
    >
  >,
): Promise<{ sources: ElectionFeedSourceRow[]; persistedToDisk?: boolean; warning?: string }> {
  const r = await apiFetch(`/api/election-feed-sources/${encodeURIComponent(electionId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    sources?: ElectionFeedSourceRow[];
    error?: string;
    warning?: string;
    persistedToDisk?: boolean;
  };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return {
    sources: j.sources ?? [],
    persistedToDisk: j.persistedToDisk,
    warning: j.warning,
  };
}

export interface DiscoverCountyFeedUrlResult {
  url: string | null;
  matchedStage?: string;
  matchedLabel?: string;
  linkText?: string;
  message?: string;
}

export interface DiscoverCountyFeedUrlBulkItemResult extends DiscoverCountyFeedUrlResult {
  countyKey: string;
  vendorId?: string;
  ok: boolean;
  error?: string;
}

export async function fetchHubDiscoveryCountyKeys(): Promise<{ countyKeys: string[] }> {
  const r = await apiFetch("/api/county-feed/hub-discovery-counties", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<{ countyKeys: string[] }>;
}

export async function discoverCountyFeedUrlsBulk(body: {
  items: Array<{ hubUrl: string; countyKey: string; vendorId?: string; html?: string }>;
}): Promise<{ results: DiscoverCountyFeedUrlBulkItemResult[]; okCount: number; total: number }> {
  const r = await apiFetch("/api/county-feed/discover-urls-bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as {
    results?: DiscoverCountyFeedUrlBulkItemResult[];
    okCount?: number;
    total?: number;
    error?: string;
  };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return {
    results: j.results ?? [],
    okCount: j.okCount ?? 0,
    total: j.total ?? j.results?.length ?? 0,
  };
}

/** Match preferred results links on a county election hub page (server fetch or optional pasted HTML for WAF-blocked sites). */
export type CountyVoteSource = "auto" | "sos" | "county_feed" | "manual";

export interface CountyRaceMappingPayload {
  electionId?: string;
  /** REP/DEM when inferred from election label/id (e.g. 58315 Republican runoff). */
  electionParty?: string | null;
  sosRaces: Array<{
    id: string;
    name: string;
    /** Civix section: Federal, StateWide, Districted, StateWideQ */
    section?: string;
    candidateCount: number;
    candidates: Array<{ id: string; name: string; party: string }>;
  }>;
  links: Array<{
    countyKey: string;
    countyContestName: string;
    sosRaceId: string;
    sosRaceName: string;
    linkType: string;
    updatedAt: string;
  }>;
  manualVotes: Array<{
    countyKey: string;
    sosRaceId: string;
    sosCandidateId: string;
    choiceName: string;
    partyName: string;
    earlyVotes: number;
    electionDayVotes: number;
    totalVotes: number;
    updatedAt: string;
  }>;
  voteSources: Array<{
    countyKey: string;
    sosRaceId: string;
    voteSource: CountyVoteSource;
    updatedAt: string;
  }>;
  unlinked: Array<{
    countyKey: string;
    civixCountyName: string;
    contestName: string;
    choiceName: string;
    partyName: string;
    earlyVotes: number;
    electionDayVotes: number;
    totalVotes: number;
    percentOfVotes: string;
    suggestedSosRaceId: string;
    suggestedSosRaceName: string;
    suggestedScore: number;
  }>;
  linkedCountyRows: unknown[];
  note?: string;
}

export async function fetchCountyRaceMapping(electionId: string): Promise<CountyRaceMappingPayload> {
  const r = await apiFetch(`/api/elections/${encodeURIComponent(electionId)}/county-race-mapping`, { cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as CountyRaceMappingPayload & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function saveCountyRaceLink(
  electionId: string,
  link: {
    countyKey: string;
    countyContestName: string;
    sosRaceId: string;
    sosRaceName: string;
    linkType?: string;
  },
): Promise<void> {
  const r = await apiFetch(`/api/elections/${encodeURIComponent(electionId)}/county-race-mapping/link`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ link }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

export async function deleteCountyRaceLink(
  electionId: string,
  countyKey: string,
  countyContestName: string,
): Promise<void> {
  const r = await apiFetch(`/api/elections/${encodeURIComponent(electionId)}/county-race-mapping/link`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ countyKey, countyContestName }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

export async function saveCountyRaceManualVote(
  electionId: string,
  row: {
    countyKey: string;
    sosRaceId: string;
    sosCandidateId: string;
    choiceName: string;
    partyName: string;
    earlyVotes: number;
    electionDayVotes: number;
    totalVotes: number;
  },
): Promise<void> {
  const r = await apiFetch(`/api/elections/${encodeURIComponent(electionId)}/county-race-mapping/manual-vote`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

export async function deleteCountyRaceManualVote(
  electionId: string,
  body: { countyKey: string; sosRaceId: string; sosCandidateId?: string },
): Promise<void> {
  const r = await apiFetch(`/api/elections/${encodeURIComponent(electionId)}/county-race-mapping/manual-vote`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

export async function saveCountyRaceVoteSource(
  electionId: string,
  row: { countyKey: string; sosRaceId: string; voteSource: CountyVoteSource },
): Promise<void> {
  const r = await apiFetch(`/api/elections/${encodeURIComponent(electionId)}/county-race-mapping/vote-source`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

export async function discoverCountyFeedUrl(body: {
  hubUrl: string;
  countyKey: string;
  html?: string;
}): Promise<DiscoverCountyFeedUrlResult> {
  const r = await apiFetch("/api/county-feed/discover-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as DiscoverCountyFeedUrlResult & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function deleteElectionSourceConfig(electionId: string): Promise<void> {
  const path = `/api/election-source-configs/${encodeURIComponent(electionId)}`;
  let r = await apiFetch(`${path}/delete`, { method: "POST" });
  if (r.status === 404) {
    r = await apiFetch(path, { method: "DELETE" });
  }
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string; hint?: string };
    const hint =
      r.status === 404 && String(err.error ?? "").includes("No API route")
        ? " Restart the API server (npm run dev:all) or redeploy Render so DELETE/POST delete routes are loaded."
        : err.hint
          ? ` ${err.hint}`
          : "";
    throw new Error((err.error ?? `HTTP ${r.status}`) + hint);
  }
}

export async function createElectionSourceConfig(body: {
  electionId: string;
  label?: string;
  usesCivixSos?: boolean;
  showInCatalog?: boolean;
}): Promise<ElectionSourceConfig> {
  const r = await apiFetch("/api/election-source-configs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json() as Promise<ElectionSourceConfig>;
}

export interface IngestProgress {
  electionId?: string;
  phase?: string;
  detail?: string;
  step?: number;
  totalSteps?: number;
  countyKey?: string;
  updatedAt?: number;
  runStartedAt?: number;
  stepTimings?: IngestStepTiming[];
}

export interface IngestStatus {
  autoRefreshEnabled: boolean;
  autoRefreshIntervalSec: number;
  lastRunEndTime: number | null;
  nextRunAt: number | null;
  running: boolean;
  progress: IngestProgress | null;
  lastResult: unknown;
}

export async function fetchIngestStatus(): Promise<IngestStatus> {
  const r = await apiFetch("/api/ingest/status", { cache: "no-store" });
  if (!r.ok) throw new Error(await readApiErrorMessage(r));
  return r.json() as Promise<IngestStatus>;
}

async function readApiErrorMessage(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* not JSON */
  }
  return `HTTP ${r.status}`;
}

/** Wait until a force refresh started after `startedAfterMs` finishes (polls /api/ingest/status). */
async function waitForForceRefreshResult(
  electionId: string,
  startedAfterMs: number,
  timeoutMs = 10 * 60 * 1000,
): Promise<ForceRefreshResult> {
  const deadline = Date.now() + timeoutMs;
  let sawThisElectionRun = false;
  while (Date.now() < deadline) {
    const st = await fetchIngestStatus();
    if (st.running && String(st.progress?.electionId ?? "") === electionId) {
      sawThisElectionRun = true;
    }
    if (
      sawThisElectionRun &&
      !st.running &&
      st.lastRunEndTime != null &&
      st.lastRunEndTime >= startedAfterMs &&
      st.lastResult
    ) {
      const lr = st.lastResult as ForceRefreshResult & { elections?: ForceRefreshResult[] };
      if (lr.elections?.length) {
        const hit = lr.elections.find((e) => String(e.electionId) === electionId);
        if (hit) return hit;
      }
      if (String(lr.electionId) === electionId) return lr;
      if (Array.isArray(lr.errors) && lr.errors.length && !lr.elections) {
        throw new Error(lr.errors.join("; "));
      }
    }
    await sleep(500);
  }
  throw new Error(`Force update timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
}

/** Poll ingest status while a refresh is running (e.g. during force one-time update). */
export function startIngestStatusPoll(onStatus: (status: IngestStatus) => void, intervalMs = 400): () => void {
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    try {
      onStatus(await fetchIngestStatus());
    } catch {
      /* ignore transient poll errors */
    }
    if (alive) window.setTimeout(tick, intervalMs);
  };
  void tick();
  return () => {
    alive = false;
  };
}

export interface ImportLogEntry {
  id: number;
  sourceKey: string;
  ok: boolean;
  message: string;
  occurredAt: string;
}

export interface SourceImportLatest {
  ok: boolean;
  message: string;
  occurredAt: string;
}

export interface ImportLogPayload {
  entries: ImportLogEntry[];
  latestBySource: Record<string, SourceImportLatest>;
}

export async function fetchImportLog(limit = 200): Promise<ImportLogPayload> {
  const r = await apiFetch("/api/import-log?" + new URLSearchParams({ limit: String(limit) }), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ImportLogPayload>;
}

export interface CivixConnectPrepare {
  token: string;
  expiresAt: string;
  apiBase: string;
  bookmarklet: string;
  steps: string[];
}

/** One-time Civix link (bookmarklet on goelect site). After this, force update uses the saved session automatically. */
export async function prepareCivixConnect(): Promise<CivixConnectPrepare> {
  const r = await apiFetch("/api/settings/civix-connect-prepare", { method: "POST" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<CivixConnectPrepare>;
}

export async function clearCivixConnect(): Promise<void> {
  const r = await apiFetch("/api/settings/civix-cookie", { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export type CivixIngestBundle = {
  election: Record<string, unknown>;
  county: Record<string, unknown>;
};

export async function forceRefreshAllSources(
  electionId: string | number = 56181,
  options?: { civixBundle?: CivixIngestBundle },
): Promise<ForceRefreshResult> {
  const id =
    typeof electionId === "number" && Number.isFinite(electionId)
      ? String(electionId)
      : String(electionId ?? "").trim();
  if (!id) throw new Error("electionId required");

  const startedAt = Date.now();
  const r = await apiFetch("/api/ingest/refresh-once", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      electionId: id,
      ...(options?.civixBundle ? { civixBundle: options.civixBundle } : {}),
    }),
  });

  if (r.status === 202) {
    const accepted = (await r.json()) as { accepted?: boolean; electionId?: string; startedAt?: number };
    if (!accepted?.accepted) throw new Error("Server did not accept force refresh");
    return waitForForceRefreshResult(id, accepted.startedAt ?? startedAt);
  }

  if (!r.ok && r.status !== 207) throw new Error(await readApiErrorMessage(r));
  return (await r.json()) as ForceRefreshResult;
}

/** Pull Civix JSON in the browser, then POST to the API so Render never calls Civix directly. */
export async function forceRefreshWithBrowserCivix(
  electionId: string | number,
  options?: { countyInfoUrl?: string; onProgress?: (detail: string) => void },
): Promise<ForceRefreshResult> {
  const id =
    typeof electionId === "number" && Number.isFinite(electionId)
      ? String(electionId)
      : String(electionId ?? "").trim();
  if (!id) throw new Error("electionId required");

  let civixBundle: CivixIngestBundle | undefined;
  let civixLive = false;
  if (/^\d+$/.test(id)) {
    options?.onProgress?.("Fetching Texas SOS / Civix JSON…");
    const bundleRes = await apiFetch(
      `/api/civix/fetch-bundle?${new URLSearchParams({ electionId: id })}`,
      { cache: "no-store" },
    );
    if (bundleRes.ok) {
      const j = (await bundleRes.json()) as {
        live?: boolean;
        election: Record<string, unknown>;
        county: Record<string, unknown>;
        note?: string;
      };
      civixBundle = { election: j.election, county: j.county };
      civixLive = j.live === true;
      if (!civixLive && j.note) {
        options?.onProgress?.(j.note);
      }
    } else {
      try {
        const { fetchCivixBundleFromBrowser } = await import("./civix/fetchForIngest");
        civixBundle = await fetchCivixBundleFromBrowser(Number(id), options?.countyInfoUrl);
        civixLive = true;
      } catch (e) {
        options?.onProgress?.(
          `Civix fetch failed (${e instanceof Error ? e.message : String(e)}). Trying last stored snapshot on server…`,
        );
      }
    }
    if (civixBundle) {
      options?.onProgress?.("Civix loaded — running ingest on the server…");
    }
  }

  const result = await forceRefreshAllSources(id, { civixBundle });
  if (civixBundle) {
    const filtered = (result.warnings ?? []).filter(
      (w) =>
        !/Live Civix API unavailable|skipped on cloud host|stored SOS snapshot|SOS loaded from browser/i.test(w),
    );
    result.warnings = civixLive
      ? ["Live Civix JSON loaded for statewide SOS.", ...filtered]
      : filtered.length
        ? filtered
        : ["SOS used stored snapshot (Civix live fetch was unavailable)."];
  }
  return result;
}

export async function saveManualElection(body: {
  id?: string;
  label: string;
  electionFile: ElectionFile;
}): Promise<void> {
  const r = await apiFetch("/api/manual-elections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      const t = await r.text();
      if (t) msg = t.slice(0, 400);
    }
    throw new Error(msg);
  }
}

export async function deleteManualElection(id: string): Promise<void> {
  const r = await apiFetch(`/api/manual-elections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function updateManualElection(body: {
  id: string;
  label: string;
  electionFile: ElectionFile;
}): Promise<void> {
  const r = await apiFetch(`/api/manual-elections/${encodeURIComponent(body.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: body.label, electionFile: body.electionFile }),
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
}
