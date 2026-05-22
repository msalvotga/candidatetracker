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

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    credentials: "omit",
    headers: {
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
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
 * For force update: try browser → Civix (home IP), then API proxy (cookie on server).
 * Returns null when both fail (server will use DB snapshot).
 */
export async function fetchCivixBundleForIngest(civixElectionId: number): Promise<{
  election: Record<string, unknown>;
  county: Record<string, unknown>;
} | null> {
  try {
    return await fetchCivixElectionPayloadDirect(civixElectionId);
  } catch {
    /* CORS or network — try API proxy */
  }
  try {
    return await fetchCivixElectionPayload(civixElectionId);
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
