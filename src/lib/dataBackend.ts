import type { CivixElectionListItem } from "./civix/api";
import type { ElectionFile, LoadedElection } from "../types/election";
import { mapCivixPayloadToElectionFile } from "./civix/mapCivixElection";

/** One row in the election dropdown (Civix or manual). */
export interface ElectionOption {
  catalogId: string;
  catalogLabel: string;
  provider: "civix" | "manual";
  civixElectionId?: number;
}

export async function probeBackend(): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

export async function fetchCatalogFromBackend(): Promise<ElectionOption[]> {
  const r = await fetch("/api/catalog", { cache: "no-store" });
  if (!r.ok) throw new Error(`Catalog HTTP ${r.status}`);
  const j = (await r.json()) as {
    entries: Array<{
      catalogId: string;
      catalogLabel: string;
      provider: "civix" | "manual";
      civixElectionId?: number;
    }>;
  };
  return j.entries.map((e) => ({
    catalogId: e.catalogId,
    catalogLabel: e.catalogLabel,
    provider: e.provider,
    civixElectionId: e.civixElectionId,
  }));
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
  const r = await fetch("/api/election?" + new URLSearchParams({ id: catalogId }), { cache: "no-store" });
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
  sosCountyInfoUrl: string;
  harrisSourceUrl: string;
  galvestonSourceUrl: string;
  jeffersonSourceUrl: string;
  montgomerySourceUrl: string;
  chambersSourceUrl: string;
  updatedAt?: string;
}

export async function fetchSources(): Promise<SourceRegistry> {
  const r = await fetch("/api/sources", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<SourceRegistry>;
}

export async function fetchDbOverview(): Promise<DbOverview> {
  const r = await fetch("/api/db/overview", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<DbOverview>;
}

export async function fetchDbTablePreview(table: "data_sources" | "sos_county_results", limit = 20): Promise<DbTablePreview> {
  const r = await fetch("/api/db/preview?" + new URLSearchParams({ table, limit: String(limit) }), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<DbTablePreview>;
}

export async function fetchAppSettings(): Promise<AppSettings> {
  const r = await fetch("/api/settings", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<AppSettings>;
}

export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  const r = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<AppSettings>;
}

export async function fetchElectionSourceConfigs(): Promise<{ elections: ElectionSourceConfig[] }> {
  const r = await fetch("/api/election-source-configs", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<{ elections: ElectionSourceConfig[] }>;
}

export async function updateElectionSourceConfig(
  electionId: string,
  patch: Partial<ElectionSourceConfig>,
): Promise<ElectionSourceConfig> {
  const r = await fetch(`/api/election-source-configs/${encodeURIComponent(electionId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ElectionSourceConfig>;
}

export interface ForceRefreshResult {
  ok: boolean;
  electionId: number;
  sos: { inserted: number };
  /** County slug (e.g. harris) → row counts from latest ingest */
  counties: Record<string, { inserted: number }>;
  errors: string[];
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
  const r = await fetch("/api/ingest-vendors", { cache: "no-store" });
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
  const r = await fetch("/api/historical/sd4-ge-county-totals", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<Sd4HistoricalGeCountyTotalsPayload>;
}

export async function fetchElectionFeedSources(electionId: string): Promise<{ sources: ElectionFeedSourceRow[] }> {
  const r = await fetch(`/api/election-feed-sources/${encodeURIComponent(electionId)}`, { cache: "no-store" });
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
): Promise<{ sources: ElectionFeedSourceRow[] }> {
  const r = await fetch(`/api/election-feed-sources/${encodeURIComponent(electionId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<{ sources: ElectionFeedSourceRow[] }>;
}

export interface DiscoverCountyFeedUrlResult {
  url: string | null;
  matchedStage?: string;
  matchedLabel?: string;
  linkText?: string;
  message?: string;
}

/** Match preferred results links on a county election hub page (server fetch or optional pasted HTML for WAF-blocked sites). */
export async function discoverCountyFeedUrl(body: {
  hubUrl: string;
  countyKey: string;
  html?: string;
}): Promise<DiscoverCountyFeedUrlResult> {
  const r = await fetch("/api/county-feed/discover-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as DiscoverCountyFeedUrlResult & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function createElectionSourceConfig(body: {
  electionId: string;
  label?: string;
  usesCivixSos?: boolean;
  showInCatalog?: boolean;
}): Promise<ElectionSourceConfig> {
  const r = await fetch("/api/election-source-configs", {
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

export interface IngestStatus {
  autoRefreshEnabled: boolean;
  autoRefreshIntervalSec: number;
  lastRunEndTime: number | null;
  nextRunAt: number | null;
  running: boolean;
  lastResult: unknown;
}

export async function fetchIngestStatus(): Promise<IngestStatus> {
  const r = await fetch("/api/ingest/status", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<IngestStatus>;
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
  const r = await fetch("/api/import-log?" + new URLSearchParams({ limit: String(limit) }), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<ImportLogPayload>;
}

export async function forceRefreshAllSources(electionId: string | number = 56181): Promise<ForceRefreshResult> {
  const id =
    typeof electionId === "number" && Number.isFinite(electionId)
      ? String(electionId)
      : String(electionId ?? "").trim();
  if (!id) throw new Error("electionId required");
  const r = await fetch("/api/ingest/refresh-once", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ electionId: id }),
  });
  if (!r.ok && r.status !== 207) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as ForceRefreshResult;
}

export async function saveManualElection(body: {
  id?: string;
  label: string;
  electionFile: ElectionFile;
}): Promise<void> {
  const r = await fetch("/api/manual-elections", {
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
  const r = await fetch(`/api/manual-elections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function updateManualElection(body: {
  id: string;
  label: string;
  electionFile: ElectionFile;
}): Promise<void> {
  const r = await fetch(`/api/manual-elections/${encodeURIComponent(body.id)}`, {
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
