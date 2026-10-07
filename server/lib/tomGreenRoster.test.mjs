import assert from "node:assert/strict";
import test from "node:test";
import { parseTomGreenRosterPages, tomGreenRosterLinks } from "./tomGreenRoster.mjs";

const page = `
<div class="eztext_area">
<p>11/3/2026 General Election</p>
<p>Early Voting - <a href="/upload/page/0153/docs/2026/110326Election/100626Roster.pdf" title="Early Voters">10/6/26 (PDF)</a></p>
<p>___________________________________________________________________________________________________________________</p>
<p>05/26/2026 Primary Runoff Election</p>
<p><a href="/upload/page/0153/docs/2026/052626Election/052226EV_Voters.pdf">Early Voting - 5/27/26 (PDF)</a></p>
<p><a href="/upload/page/0153/docs/2026/052626Election/060126BallotsByMail.pdf">Absentee Ballots Returned - 6/1/26 (PDF)</a></p>
</div>
`;

test("reads only the November 3, 2026 general election PDFs", () => {
  const links = tomGreenRosterLinks(page);
  assert.equal(links.length, 1);
  assert.equal(links[0].votingMethod, "EV");
  assert.equal(links[0].href.endsWith("100626Roster.pdf"), true);
});

test("reads VUID and the ballot returned date", () => {
  const parsed = parseTomGreenRosterPages(
    [
      [
        { str: "VUID", x: 53, y: 66 },
        { str: "ballot returned", x: 391, y: 66 },
        { str: "1129533079", x: 55, y: 81 },
        { str: "Abbott", x: 115, y: 81 },
        { str: "10/5/26", x: 432, y: 81 },
        { str: "10/1/26", x: 432, y: 96 },
      ],
    ],
    "EV",
  );
  assert.deepEqual(parsed.rows, [{ vuid: "1129533079", activityDate: "2026-10-05", votingMethod: "EV" }]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-10-01", missingVuid: 1 }]);
});
