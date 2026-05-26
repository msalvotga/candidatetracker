import { TX_CIVIX_API, TX_CIVIX_ORIGIN, civixApiUrl } from "./urls";
import { decodeBase64Json, decodeUploadPayload } from "./decode";

export interface CivixElectionListItem {
  civixElectionId: number;
  catalogId: string;
  catalogLabel: string;
  year: string;
  category: string;
}

export interface CivixElectionConstantsInner {
  electionInfo: Record<string, Record<string, Record<string, { ID: number; N: string }>>>;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    method: init?.method ?? "GET",
    credentials: init?.credentials ?? "omit",
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function proxyCountyInfoPath(override: string | undefined, civixElectionId: number): string {
  const trimmed = String(override ?? "").trim();
  if (!trimmed) return `/s3/enr/election/countyInfo/${civixElectionId}`;
  const idx = trimmed.indexOf("/api-ivis-system");
  if (idx >= 0) {
    const rest = trimmed.slice(idx + "/api-ivis-system".length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return `/s3/enr/election/countyInfo/${civixElectionId}`;
}

/** Same-origin Civix proxy on the app host (uses saved CIVIX_COOKIE on the API). */
async function fetchCivixBundleViaAppProxy(
  civixElectionId: number,
  countyInfoUrlOverride?: string,
): Promise<{ election: Record<string, unknown>; county: Record<string, unknown> }> {
  const election = (await fetchJson(civixApiUrl(`/s3/enr/election/${civixElectionId}`))) as Record<
    string,
    unknown
  >;
  const countyPath = proxyCountyInfoPath(countyInfoUrlOverride, civixElectionId);
  const defaultPath = `/s3/enr/election/countyInfo/${civixElectionId}`;
  let county: Record<string, unknown>;
  try {
    county = (await fetchJson(civixApiUrl(countyPath))) as Record<string, unknown>;
  } catch {
    if (countyPath !== defaultPath) {
      county = (await fetchJson(civixApiUrl(defaultPath))) as Record<string, unknown>;
    } else {
      throw new Error(`Could not load Civix countyInfo for election ${civixElectionId}`);
    }
  }
  return { election, county };
}

export async function listCivixElections(): Promise<CivixElectionListItem[]> {
  const raw = await fetchJson(civixApiUrl("/s3/enr/electionConstants"));
  const inner = decodeUploadPayload<CivixElectionConstantsInner>(raw);
  const ei = inner.electionInfo;
  const out: CivixElectionListItem[] = [];
  for (const year of Object.keys(ei).sort().reverse()) {
    for (const category of Object.keys(ei[year])) {
      for (const idStr of Object.keys(ei[year][category])) {
        const row = ei[year][category][idStr];
        const id = row.ID ?? Number(idStr);
        out.push({
          civixElectionId: id,
          catalogId: String(id),
          catalogLabel: `${row.N} (${year})`,
          year,
          category,
        });
      }
    }
  }
  return out;
}

/** Direct Civix host (user's IP). Works when CORS allows; used before API proxy on force update. */
export async function fetchCivixElectionPayloadDirect(civixElectionId: number): Promise<{
  election: Record<string, unknown>;
  county: Record<string, unknown>;
}> {
  const base = `${TX_CIVIX_ORIGIN}${TX_CIVIX_API}/s3/enr`;
  const [election, county] = await Promise.all([
    fetchJson(`${base}/election/${civixElectionId}`),
    fetchJson(`${base}/election/countyInfo/${civixElectionId}`),
  ]);
  return { election: election as Record<string, unknown>, county: county as Record<string, unknown> };
}

/** Via app API Civix proxy (uses CIVIX_COOKIE / Settings cookie on server). */
export async function fetchCivixElectionPayload(civixElectionId: number): Promise<{
  election: Record<string, unknown>;
  county: Record<string, unknown>;
}> {
  const [election, county] = await Promise.all([
    fetchJson(civixApiUrl(`/s3/enr/election/${civixElectionId}`)),
    fetchJson(civixApiUrl(`/s3/enr/election/countyInfo/${civixElectionId}`)),
  ]);
  return { election: election as Record<string, unknown>, county: county as Record<string, unknown> };
}

/**
 * For force update: fetch Civix JSON via same-origin /api-ivis-system proxy only.
 * Direct cross-origin calls to goelect add an Origin header and Civix returns HTTP 500/503.
 */
export async function fetchCivixBundleFromBrowser(
  civixElectionId: number,
  countyInfoUrlOverride?: string,
): Promise<{
  election: Record<string, unknown>;
  county: Record<string, unknown>;
}> {
  return fetchCivixBundleViaAppProxy(civixElectionId, countyInfoUrlOverride);
}

/**
 * For force update: try browser → Civix (user IP). API proxy is server IP and usually fails on Render.
 */
export async function fetchCivixBundleForIngest(
  civixElectionId: number,
  countyInfoUrlOverride?: string,
): Promise<{
  election: Record<string, unknown>;
  county: Record<string, unknown>;
} | null> {
  try {
    return await fetchCivixBundleFromBrowser(civixElectionId, countyInfoUrlOverride);
  } catch {
    return null;
  }
}

export function decodeCountyIndex(countyDoc: Record<string, unknown>): Record<string, CivixCountyBlock> {
  const inner = decodeUploadPayload<Record<string, CivixCountyBlock>>(countyDoc);
  return inner;
}

/** One county worth of ENR data from `countyInfo` upload payload. */
export interface CivixCountyBlock {
  N: string;
  TV: number;
  C: string;
  Summary: {
    PRR: number;
    PRP: number;
    SRC?: string;
    PLR?: number;
    PLP?: number;
  };
  Races: Record<
    string,
    {
      OID: number;
      N: string;
      T: number;
      C: Record<
        string,
        {
          id: number;
          N: string;
          P: string | null;
          V: number;
          EV: number;
          ED?: number;
        }
      >;
    }
  >;
}

export function decodeElectionSection<T>(electionPayload: Record<string, unknown>, key: string): T | null {
  const b64 = electionPayload[key];
  if (typeof b64 !== "string") return null;
  return decodeBase64Json<T>(b64);
}
