/** Public Texas Civix ENR (same host the SOS night reporting site uses). */
export const TX_CIVIX_ORIGIN = "https://goelect.txelections.civixapps.com";

/**
 * In dev, use a relative base so Vite proxies `/api-ivis-system/*` to Civix (see `vite.config.ts`).
 * In production builds, call Civix directly unless you add your own reverse proxy.
 */
export const TX_CIVIX_API = import.meta.env.DEV
  ? "/api-ivis-system/api"
  : `${TX_CIVIX_ORIGIN}/api-ivis-system/api`;

/**
 * County JSON on Civix — only the trailing election id (often five digits) changes per election.
 * Matches `server/lib/civixServer.mjs` default county bundle URL.
 */
export const TX_CIVIX_DEFAULT_COUNTYINFO_PREFIX = `${TX_CIVIX_ORIGIN}/api-ivis-system/api/s3/enr/election/countyInfo/`;

export function civixDefaultCountyInfoUrl(electionId: string): string | null {
  const n = Number(electionId);
  if (!Number.isFinite(n)) return null;
  return `${TX_CIVIX_DEFAULT_COUNTYINFO_PREFIX}${n}`;
}
