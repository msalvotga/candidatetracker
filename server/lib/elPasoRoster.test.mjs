import assert from "node:assert/strict";
import test from "node:test";
import { elPasoRosterLinks, parseElPasoRosterCsv } from "./elPasoRoster.mjs";

const page = `
<h3>November 2026 General &amp; Special Election</h3>
<p><a href="https://example.com/locations.pdf">Early Voting Locations</a></p>
<h2 id="early-voting-rosters">Early Voting Rosters</h2>
<p><strong>November 2026 General &amp; Special Election</strong></p>
<p><a href="https://example.com/Received_Ballots_Voter_List_20261006.csv?1">Ballot By Mail 10/06/2026</a></p>
<p><a href="https://example.com/early-1019.csv">Early Voting 10/19/2026</a></p>
<div id="collapseElection">
<p><a href="https://example.com/other.csv">Ballot By Mail 11/03/2024</a></p>
</div>
`;

test("reads each November 2026 roster CSV", () => {
  const links = elPasoRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.votingMethod, link.text]),
    [
      ["AB", "Ballot By Mail 10/06/2026"],
      ["EV", "Early Voting 10/19/2026"],
    ],
  );
});

test("uses Received Date and leaves Mail Date alone", () => {
  const parsed = parseElPasoRosterCsv(
    [
      "VUID,LastName,Precinct,MailDate,ReceivedDate",
      "1093525238,SPADY,075.1,9/28/2026,10/5/2026",
      ",NOID,075.1,9/18/2026,10/6/2026",
    ].join("\n"),
    "AB",
  );
  assert.deepEqual(parsed.rows, [{ vuid: "1093525238", activityDate: "2026-10-05", votingMethod: "AB" }]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-10-06", missingVuid: 1 }]);
});
