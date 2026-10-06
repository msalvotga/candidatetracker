import assert from "node:assert/strict";
import test from "node:test";
import { parseRandallRosterPages, randallMailRosterLink } from "./randallRoster.mjs";

const page = `
<a href="/DocumentCenter/View/4639">Notice of General Election</a>
<a href="/DocumentCenter/View/4827">Mail Ballot Roster</a>
`;

test("finds the mail ballot roster on the election administration page", () => {
  const link = randallMailRosterLink(page);
  assert.equal(link.href, "https://www.randallcounty.gov/DocumentCenter/View/4827");
  assert.equal(link.votingMethod, "AB");
});

test("reads a VUID glued to the name and the ballot received date", () => {
  const parsed = parseRandallRosterPages([
    [
      { str: "VUID", x: 17, y: 40 },
      { str: "Name", x: 78, y: 40 },
      { str: "Ballot Received Date", x: 270, y: 40 },
      { str: "1025754531 SMITH,RONALD EARL", x: 19, y: 55 },
      { str: "9/24/2026", x: 316, y: 55 },
      { str: "1025754531 SMITH,RONALD EARL", x: 19, y: 70 },
      { str: "9/24/2026", x: 316, y: 70 },
      { str: "1039059554", x: 19, y: 85 },
      { str: "GADHIA-SMITH,ANITA LALIT", x: 80, y: 85 },
      { str: "10/5/2026", x: 316, y: 85 },
      { str: "NO ID", x: 19, y: 100 },
      { str: "9/25/2026", x: 316, y: 100 },
    ],
  ]);
  assert.deepEqual(parsed.rows, [
    { vuid: "1025754531", activityDate: "2026-09-24", votingMethod: "AB" },
    { vuid: "1039059554", activityDate: "2026-10-05", votingMethod: "AB" },
  ]);
  assert.equal(parsed.skippedMissingVuid, 1);
});
