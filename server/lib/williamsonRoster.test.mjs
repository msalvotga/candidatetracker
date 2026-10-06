import assert from "node:assert/strict";
import test from "node:test";
import { williamsonRosterLink, williamsonRosterRows } from "./williamsonRoster.mjs";

const page = `
<a href="/DocumentCenter/View/22018/Sample-Ballot">Composite Sample Ballot</a>
<a href="/DocumentCenter/View/22273/Voter-Turnout--November-3-2026-JGSE">Daily Voting Roster</a>
`;

test("finds the daily voting roster on the elections page", () => {
  const link = williamsonRosterLink(page);
  assert.equal(
    link.href,
    "https://www.wilcotx.gov/DocumentCenter/View/22273/Voter-Turnout--November-3-2026-JGSE",
  );
});

test("reads VUID, ballot date, and mail from AV", () => {
  const matrix = [
    ["VUID", "Name", "Precinct", "Election Name", "Voting Method", "Ballot Date"],
    ["3383131477", "AUSTIN,JAMES", "146", "2026 NOVEMBER 3 JOINT GENERAL AND SPECIAL ELECTION", "AV", "10/1/26"],
    ["3383131477", "AUSTIN,JAMES", "146", "2026 NOVEMBER 3 JOINT GENERAL AND SPECIAL ELECTION", "AV", "10/1/26"],
    ["1202075855", "BAKER,CONOR JOSEPH", "359", "2026 NOVEMBER 3 JOINT GENERAL AND SPECIAL ELECTION", "EV", "10/2/26"],
    ["", "NO ID", "100", "2026 NOVEMBER 3 JOINT GENERAL AND SPECIAL ELECTION", "AV", "9/24/26"],
    ["2152125208", "OTHER", "1", "2024 MARCH PRIMARY", "AV", "3/1/24"],
  ];
  const parsed = williamsonRosterRows(matrix);
  assert.deepEqual(parsed.rows, [
    { vuid: "3383131477", activityDate: "2026-10-01", votingMethod: "AB" },
    { vuid: "1202075855", activityDate: "2026-10-02", votingMethod: "EV" },
  ]);
  assert.equal(parsed.skippedMissingVuid, 1);
});
