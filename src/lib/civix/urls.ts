import { apiUrl } from "../apiBase";

/** Public Texas Civix ENR (same host the SOS night reporting site uses). */
export const TX_CIVIX_ORIGIN = "https://goelect.txelections.civixapps.com";

/** Same-origin path proxied to Civix (Vite dev, API service, or static rewrite). */
export const TX_CIVIX_API = "/api-ivis-system/api";

/** Civix API path via app API host when VITE_API_BASE_URL is set (split Render frontend + API). */
export function civixApiUrl(subpath: string): string {
  const p = subpath.startsWith("/") ? subpath : `/${subpath}`;
  return apiUrl(`${TX_CIVIX_API}${p}`);
}

/**
 * County JSON on Civix — only the trailing election id (often five digits) changes per election.
 * Matches `server/lib/civixServer.mjs` default county bundle URL.
 */
export const TX_CIVIX_DEFAULT_COUNTYINFO_PREFIX = "/api-ivis-system/api/s3/enr/election/countyInfo/";

export function civixDefaultCountyInfoUrl(electionId: string): string | null {
  const n = Number(electionId);
  if (!Number.isFinite(n)) return null;
  return `${TX_CIVIX_DEFAULT_COUNTYINFO_PREFIX}${n}`;
}
