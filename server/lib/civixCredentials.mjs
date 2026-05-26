/**
 * Civix session cookie: env CIVIX_COOKIE, then dbo.app_settings civix_cookie, optional per-request X-Civix-Cookie.
 * @param {string} [requestCookie]
 */
export async function resolveCivixCookie(requestCookie) {
  const fromReq = String(requestCookie ?? "").trim();
  if (fromReq) return fromReq;
  if (process.env.CIVIX_COOKIE?.trim()) return process.env.CIVIX_COOKIE.trim();
  const { getAppSettings } = await import("../db.mjs");
  const s = await getAppSettings();
  return String(s.civixCookie ?? "").trim();
}

/** @param {string} [requestCookie] */
export async function buildCivixFetchHeaders(requestCookie) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      process.env.CIVIX_USER_AGENT?.trim() ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer:
      process.env.CIVIX_REFERER?.trim() || "https://goelect.txelections.civixapps.com/ivis-enr-ui/",
  };
  // Do NOT send Origin — Civix returns HTTP 500/503 when Origin is present on these JSON endpoints.
  const cookie = await resolveCivixCookie(requestCookie);
  if (cookie) headers.Cookie = cookie;
  return headers;
}
