/**
 * Early voting rosters are heavy on RAM (large voter tables in PostgreSQL).
 * Off by default; set EV_ROSTER_ENABLED=1 to turn back on.
 */
export function isEvRosterEnabled() {
  return process.env.EV_ROSTER_ENABLED === "1";
}
