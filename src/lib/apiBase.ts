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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a JSON API body. An empty 502/503 from a Render restart is retried before the page shows an error. */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await apiFetch(path, init);
    const text = await response.text();
    let body: { error?: string } | null = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as { error?: string };
      } catch {
        body = null;
      }
    }
    if (response.ok && body && typeof body === "object") return body as T;
    const restarting = response.status === 502 || response.status === 503;
    const message =
      (body && typeof body.error === "string" && body.error) ||
      (restarting
        ? "The live API is restarting. The page will try again."
        : `The server returned ${response.status || "an empty response"}.`);
    lastError = new Error(message);
    if (!restarting || attempt === 2) throw lastError;
    await wait(attempt === 0 ? 5000 : 15000);
  }
  throw lastError ?? new Error("The live API did not answer.");
}
