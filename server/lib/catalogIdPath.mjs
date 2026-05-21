/**
 * Path-safe catalog ids (civix:56181, election:56181, manual:foo).
 * Colons must not appear raw in URL paths — proxies treat them as host:port.
 */

/** @param {string} catalogId */
export function encodeCatalogIdForPath(catalogId) {
  return Buffer.from(String(catalogId), "utf8").toString("base64url");
}

/** @param {string} token */
export function decodeCatalogIdFromPath(token) {
  return Buffer.from(String(token), "base64url").toString("utf8");
}
