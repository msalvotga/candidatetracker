/**
 * App version: 1.{daysSinceMay3}.{HHMM}
 * - daysSinceMay3: whole days since 2026-05-03 (election epoch)
 * - HHMM: 24-hour time of the release/update (no colon)
 *
 * Bump on every user-facing change: `npm run version:bump`
 */
export const APP_VERSION = "1.19.1523";

/** Midnight local on 3 May 2026 — day 0 for the middle version segment. */
export const VERSION_EPOCH = new Date(2026, 4, 3);

/** @param {Date} [at] Defaults to now. */
export function formatAppVersion(at = new Date()): string {
  const ms = at.getTime() - VERSION_EPOCH.getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `1.${days}.${hh}${mm}`;
}
