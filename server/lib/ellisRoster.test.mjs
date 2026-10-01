import assert from "node:assert/strict";
import test from "node:test";
import { ellisCellDate, ellisMailRosterLink, ellisRosterRows } from "./ellisRoster.mjs";

const page = `
<a href="/DocumentCenter/View/23936">Generic Sample Ballot</a>
<a href="/DocumentCenter/View/24178/1126Nov-Election_EVReports_Mail">Returned Ballots by Mail Roster Report &nbsp;(zipped file)</a>
`;

test("finds the returned-ballots zip by its label", () => {
  const link = ellisMailRosterLink(page);
  assert.equal(
    link.href,
    "https://www.elliscountytx.gov/DocumentCenter/View/24178/1126Nov-Election_EVReports_Mail",
  );
});

test("reads the published date from cell C2", () => {
  assert.equal(ellisCellDate({ t: "d", v: new Date("2026-09-30T05:00:00.000Z"), w: "9/30/26" }), "2026-09-30");
});

test("first pull dates every new VUID with C2 and a later pull only adds new VUIDs", () => {
  const matrix = [
    ["November 3, 2026 General and Special Elections", "", "Subject to changes"],
    ["Early Voting Roster by Mail - Returned. Published on", "", "9/30/26"],
    ["Full Name", "Precinct", "VUID"],
    ["AHLFINGER, CANDACE ANN", "1046", "1029790121"],
    ["AHLFINGER, CANDACE ANN", "1046", "1029790121"],
    ["", "", ""],
    ["NO ID", "1000", ""],
  ];
  const first = ellisRosterRows(matrix, "2026-09-30", []);
  assert.deepEqual(first.rows, [{ vuid: "1029790121", activityDate: "2026-09-30", votingMethod: "AB" }]);
  assert.equal(first.skippedMissingVuid, 1);

  const later = [
    ...matrix,
    ["NEW, VOTER", "1046", "2159982322"],
  ];
  const second = ellisRosterRows(later, "2026-10-01", ["1029790121"]);
  assert.deepEqual(second.rows, [{ vuid: "2159982322", activityDate: "2026-10-01", votingMethod: "AB" }]);
});
