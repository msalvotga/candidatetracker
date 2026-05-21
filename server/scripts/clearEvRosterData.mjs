/**
 * Clear all EV roster pulls and voter rows (keeps configs and county source training).
 * Usage: node server/scripts/clearEvRosterData.mjs
 */
import { clearEvRosterPullData, getDbInfo } from "../db.mjs";

console.log("Backend:", getDbInfo());
const result = await clearEvRosterPullData();
console.log("Cleared:", result.cleared);
console.log("Remaining:", result.remaining);
console.log("Done — EV roster data cleared (configs and county sources kept).");
