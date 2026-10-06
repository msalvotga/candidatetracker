import assert from "node:assert/strict";
import test from "node:test";
import { kendallReturnedRosterLink, parseKendallRosterPages } from "./kendallRoster.mjs";

const page = `
<a href="/DocumentCenter/View/3706">Returned Vote by Mail - Roster</a>
<a href="/DocumentCenter/View/3970">Returned Ballots Roster - November 3rd General (as of 9/28/2026)</a>
<a href="/DocumentCenter/View/3980">Returned Ballots Roster - November 3rd General (as of 10/01/2026)</a>
<a href="/DocumentCenter/View/3959">Generic Sample Ballot</a>
`;

test("uses the newest November 3 returned-ballots roster", () => {
  const link = kendallReturnedRosterLink(page);
  assert.equal(link.votingMethod, "AB");
  assert.equal(link.asOf, "2026-10-01");
  assert.equal(link.href, "https://www.kendallcountytx.gov/DocumentCenter/View/3980");
});

test("reads the VUID and the ballot received date from one row", () => {
  const parsed = parseKendallRosterPages([
    [
      { str: "VUID", x: 143, y: 104 },
      { str: "DATE BALLOT", x: 460, y: 96 },
      { str: "RECEIVED", x: 471, y: 111 },
      { str: "3383323869", x: 108, y: 130 },
      { str: "CARTER,CAROLINE L", x: 210, y: 130 },
      { str: "1", x: 78, y: 133 },
      { str: "10/1/2026", x: 450, y: 133 },
    ],
  ]);
  assert.deepEqual(parsed.rows, [{ vuid: "3383323869", activityDate: "2026-10-01", votingMethod: "AB" }]);
});
