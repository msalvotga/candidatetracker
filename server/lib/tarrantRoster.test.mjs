import assert from "node:assert/strict";
import test from "node:test";
import { parseTarrantRosterText, tarrantRosterLinks } from "./tarrantRoster.mjs";

const page = `
<a href="/content/dam/main/elections/2026/1126/ev_reports/absentee_returned_voter_report.zip">Ballot by Mail</a>
<a href="/content/dam/main/elections/2026/1126/ev_reports/Early_voting_in_person_report.zip">In Person during Early Voting</a>
<a href="https://goelect.txelections.civixapps.com/ivis-oab-ui/#/login">Ballot by Mail Tracker</a>
<a href="/content/dam/main/elections/2026/absentee_returned_voter_report_layout.pdf">By Mail Roster file layout</a>
<a href="/content/dam/main/elections/2026/1126/reports/TC_Voters_1126.zip">Full History</a>
`;

test("takes the mail and early-voting zips from their link labels", () => {
  const links = tarrantRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.votingMethod, link.text]),
    [
      ["AB", "Ballot by Mail"],
      ["EV", "In Person during Early Voting"],
    ],
  );
  assert.equal(
    links[0].href,
    "https://www.tarrantcountytx.gov/content/dam/main/elections/2026/1126/ev_reports/absentee_returned_voter_report.zip",
  );
});

test("reads SOS Voter ID and Return Date from a tab file, and counts a blank VUID", () => {
  const text = [
    "Voter_Name\tSOS Voter ID\tReturn Date",
    "--Redacted--\t\t2026-09-25",
    "PHILLIPS, RANDY C\t3382807872\t2026-09-28",
  ].join("\n");
  const parsed = parseTarrantRosterText(text, { votingMethod: "AB" });
  assert.equal(parsed.posted, true);
  assert.equal(parsed.skippedMissingVuid, 1);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-09-25", missingVuid: 1 }]);
  assert.deepEqual(parsed.rows, [{ vuid: "3382807872", activityDate: "2026-09-28", votingMethod: "AB" }]);
});

test("treats the not-yet-posted early voting notice as unpublished", () => {
  const parsed = parseTarrantRosterText(
    "Early Voting by Personal Appearance Roster of Voters for this election will be posted as soon as it becomes available.",
    { votingMethod: "EV" },
  );
  assert.equal(parsed.posted, false);
  assert.deepEqual(parsed.rows, []);
});
