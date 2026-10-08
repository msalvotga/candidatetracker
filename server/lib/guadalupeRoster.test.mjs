import assert from "node:assert/strict";
import test from "node:test";
import { guadalupeRosterLinks, parseGuadalupeRosterPages } from "./guadalupeRoster.mjs";

const page = `
<div class="eztext_area">
<h2>Returned Ballots Log - November 3, 2026 General &amp; Special Elections</h2>
<table><tr><td><a href="/upload/page/0349/docs/110326/Returned Ballots Log for Posting General 11-3-2026.pdf">10-7-26 Returned Mail Ballots</a></td></tr></table>
</div></div>
<div class="eztext_area">
<h2>Early Voting Rosters</h2>
<a href="/upload/page/0349/docs/110326/early.pdf">10-19-26 Early Voting</a>
</div></div>
`;

test("reads the Returned Ballots Log PDF", () => {
  const links = guadalupeRosterLinks(page);
  assert.equal(links.length, 1);
  assert.equal(links[0].votingMethod, "AB");
  assert.equal(links[0].href.includes("Returned%20Ballots%20Log"), true);
});

test("reads VUID and the received date, including a shorter VUID", () => {
  const parsed = parseGuadalupeRosterPages([
    [
      { str: "VUID", x: 53, y: 66 },
      { str: "DATE RC'D", x: 312, y: 66 },
      { str: "1101542286", x: 53, y: 83 },
      { str: "HOWARTON, ANGELA", x: 144, y: 83 },
      { str: "9/24/2026", x: 313, y: 83 },
      { str: "1036246", x: 53, y: 129 },
      { str: "ROBERTS, LESLIE", x: 144, y: 129 },
      { str: "9/29/2026", x: 313, y: 129 },
      { str: "10/6/2026", x: 313, y: 160 },
    ],
  ]);
  assert.deepEqual(parsed.rows, [
    { vuid: "1101542286", activityDate: "2026-09-24", votingMethod: "AB" },
    { vuid: "1036246", activityDate: "2026-09-29", votingMethod: "AB" },
  ]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-10-06", missingVuid: 1 }]);
});
