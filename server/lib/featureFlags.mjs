/**
 * Early voting rosters load a large SQLite snapshot and are heavy on RAM.
 * Off by default; set EV_ROSTER_ENABLED=1 to turn back on.
 */
export function isEvRosterEnabled() {
  return process.env.EV_ROSTER_ENABLED === "1";
}
