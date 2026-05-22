/** Public Texas Civix ENR (same host the SOS night reporting site uses). */
export const TX_CIVIX_ORIGIN = "https://goelect.txelections.civixapps.com";

/**
 * Always use a same-origin path so Vite (dev) or the API / static rewrites (production) can proxy to Civix.
 * Do not call goelect.txelections.civixapps.com from the browser — it blocks cross-origin requests.
 */
export const TX_CIVIX_API = "/api-ivis-system/api";

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
