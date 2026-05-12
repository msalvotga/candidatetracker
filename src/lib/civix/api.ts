import { TX_CIVIX_API } from "./urls";
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
  const raw = await fetchJson(`${TX_CIVIX_API}/s3/enr/electionConstants`);
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

export async function fetchCivixElectionPayload(civixElectionId: number): Promise<{
  election: Record<string, unknown>;
  county: Record<string, unknown>;
}> {
  const [election, county] = await Promise.all([
    fetchJson(`${TX_CIVIX_API}/s3/enr/election/${civixElectionId}`),
    fetchJson(`${TX_CIVIX_API}/s3/enr/election/countyInfo/${civixElectionId}`),
  ]);
  return { election: election as Record<string, unknown>, county: county as Record<string, unknown> };
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
