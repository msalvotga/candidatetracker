import assert from "node:assert/strict";
import test from "node:test";
import {
  montgomeryRosterFilesToPull,
  montgomeryRosterLinks,
  montgomeryVoteDateFromName,
  parseMontgomeryRosterCsv,
} from "./montgomeryRoster.mjs";

const page = `
<script>myDays.push('GEN110326_09.23.2026.zip');</script>
<script>myDays.push('GEN110326_09.30.2026.zip');</script>
<a href="pdf/rosterfileinstructions.pdf">Roster File Information</a>
`;

test("takes the vote date from the zip name", () => {
  assert.equal(montgomeryVoteDateFromName("GEN110326_09.30.2026.zip"), "2026-09-30");
  assert.equal(montgomeryVoteDateFromName("notes.pdf"), null);
});

test("lists the daily zip files on the roster page", () => {
  const links = montgomeryRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.voteDate, link.href]),
    [
      ["2026-09-23", "https://elections.mctx.org/EVHistoryFiles/GEN110326_09.23.2026.zip"],
      ["2026-09-30", "https://elections.mctx.org/EVHistoryFiles/GEN110326_09.30.2026.zip"],
    ],
  );
});

test("keeps the newest day and skips days that already have voters", () => {
  const selected = montgomeryRosterFilesToPull(montgomeryRosterLinks(page), ["2026-09-23"]);
  assert.deepEqual(selected.map((file) => file.voteDate), ["2026-09-30"]);
});

test("keeps one row per VUID and uses the file date instead of DateVoted", () => {
  const parsed = parseMontgomeryRosterCsv(
    `"LastName","FirstName","MiddleName","VUID","Voting_Precinct","Voted_Party","DateVoted","VoteType"
"LONEY","JULIE","KATHLEEN","2223452977","91"," ","BBM Recvd Sep 30 2026  7:03PM","A"
"LONEY","JULIE","KATHLEEN","2223452977","91"," ","BBM Recvd Sep 30 2026  7:03PM","A"
"SMITH","ANN","","","91"," ","BBM Recvd Sep 30 2026  1:00PM","A"
"SMITH","ANN","","","91"," ","BBM Recvd Sep 30 2026  1:00PM","A"
"EARLY","JO","","1205455586","88"," ","Early Sep 30 2026","E"
`,
    "GEN110326_09.30.2026.zip",
  );
  assert.deepEqual(parsed.rows, [
    { vuid: "2223452977", activityDate: "2026-09-30", votingMethod: "AB" },
    { vuid: "1205455586", activityDate: "2026-09-30", votingMethod: "EV" },
  ]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-09-30", missingVuid: 1 }]);
});
