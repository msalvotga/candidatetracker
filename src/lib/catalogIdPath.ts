/** URL-path token for catalog ids (avoids raw `:` in paths). */
export function encodeCatalogIdForPath(catalogId: string): string {
  const bytes = new TextEncoder().encode(catalogId);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
