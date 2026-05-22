/** Production API host when frontend is on a different origin (e.g. Render static site). */
const API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/** Prefix `/api/...` paths with VITE_API_BASE_URL when set. */
export function apiUrl(path: string): string {
  if (!API_BASE) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
