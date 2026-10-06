/** Production API host when frontend is on a different origin (e.g. Render static site). */
const API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/** Hold automatic polls after Render answers 429, 502, or 503. */
let quietUntil = 0;

export function apiQuietMs() {
  return Math.max(0, quietUntil - Date.now());
}

function noteBusyStatus(status: number) {
  if (status !== 429 && status !== 502 && status !== 503) return;
  const hold = status === 429 ? 90_000 : 45_000;
  quietUntil = Math.max(quietUntil, Date.now() + hold);
}

/** Prefix `/api/...` paths with VITE_API_BASE_URL when set. */
export function apiUrl(path: string): string {
  if (!API_BASE) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init).then((response) => {
    noteBusyStatus(response.status);
    return response;
  });
}
