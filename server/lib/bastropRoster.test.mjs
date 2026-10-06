import assert from "node:assert/strict";
import test from "node:test";
import { bastropRosterLinks, parseBastropRosterCsv } from "./bastropRoster.mjs";

const page = `
<a href="https://goelect.txelections.civixapps.com/ivis-evr-ui/evr">Daily Voter Lists Provided by the Texas Secretary of State</a>
<li><strong>Daily Voter Lists</strong>
<ul>
<li><a href="https://www.bastropvotes.org/wp-content/uploads/2026/10/Mail-Ballots-3.csv"><span>Mail Ballots</span></a></li>
<li><span>In-Person Voters</span>
<ul>
<li><span>Monday, October 19</span></li>
<li><a href="https://www.bastropvotes.org/wp-content/uploads/2026/10/In-Person-10-20.csv"><span>Tuesday, October 20</span></a></li>
</ul>
</li>
</ul>
</li>
`;

test("takes the mail CSV and only in-person days that have a file", () => {
  const links = bastropRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.votingMethod, link.href.split("/").pop()]),
    [
      ["AB", "Mail-Ballots-3.csv"],
      ["EV", "In-Person-10-20.csv"],
    ],
  );
});

test("reads VUID and Ballot Status Date", () => {
  const csv = [
    "VUID,Name,Ballot Status Date,Precinct",
    "1000000001,A,9/28/2026,1",
    "1000000001,A,9/28/2026,1",
    "1000000002,B,9/25/2026,2",
    "1000000003,C,,3",
    ",D,9/28/2026,4",
  ].join("\n");
  const parsed = parseBastropRosterCsv(csv, "AB");
  assert.deepEqual(parsed.rows, [
    { vuid: "1000000001", activityDate: "2026-09-28", votingMethod: "AB" },
    { vuid: "1000000002", activityDate: "2026-09-25", votingMethod: "AB" },
  ]);
  assert.equal(parsed.skippedMissingDate, 1);
  assert.equal(parsed.skippedMissingVuid, 1);
});
