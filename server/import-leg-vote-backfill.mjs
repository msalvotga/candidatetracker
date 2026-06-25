import { getDb, closeDb, initDb } from "./db.mjs";
import { backfillLegContestVotes } from "./lib/legVoteBackfill.mjs";

await initDb();
const db = getDb();

console.log("Backfilling leg contest vote totals from Capitol returns + OpenElections…");
const result = await backfillLegContestVotes(db, { metricKeys: ["leg_2022"] });
console.log(
  `Updated ${result.updatedRows} candidate rows across ${result.contests} contests (${result.lookupKeys} vote lookup keys).`
);

await closeDb();
