import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { ellisMailRosterLink, ellisRosterRows, ellisVoteDateFromFileName, parseEllisRosterZip } from "./ellisRoster.mjs";

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

test("reads the vote date from the MMDDYY stamp on the Excel file name", () => {
  assert.equal(ellisVoteDateFromFileName("1126Nov Election_EVReports_Mail_100526.xlsx"), "2026-10-05");
  assert.equal(ellisVoteDateFromFileName("1126Nov Election_EVReports_Mail_100126.xlsx"), "2026-10-01");
  assert.equal(ellisVoteDateFromFileName("1126Nov-Election_EVReports_Mail"), null);
});

test("first pull dates every new VUID from the file name and a later pull only adds new VUIDs", () => {
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

test("a new VUID takes the file-name date even when cell C2 is an older day", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["November 3, 2026 General and Special Elections", "", "Subject to changes"],
    ["Early Voting Roster by Mail - Returned. Published on", "", "9/29/26"],
    ["Full Name", "Precinct", "VUID"],
    ["ALREADY, STORED", "1046", "1029790121"],
    ["NEW, VOTER", "1046", "2159982322"],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
  const xlsx = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  const zip = new JSZip();
  zip.file("1126Nov Election_EVReports_Mail_100526.xlsx", xlsx);
  const parsed = await parseEllisRosterZip(await zip.generateAsync({ type: "nodebuffer" }), ["1029790121"]);
  assert.equal(parsed.voteDate, "2026-10-05");
  assert.deepEqual(parsed.rows, [{ vuid: "2159982322", activityDate: "2026-10-05", votingMethod: "AB" }]);
});
