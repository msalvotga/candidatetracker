import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  hidalgoDownloadName,
  hidalgoMailRosterLink,
  hidalgoRosterRows,
  hidalgoVoteDateFromFileName,
  parseHidalgoRosterFile,
} from "./hidalgoRoster.mjs";

const page = `
<a href="/DocumentCenter/View/73301/ABBM-LIST-November-3-2026-Cumulative">Mail in Ballots</a>
<a href="/3222/Application-for-Ballot-by-Mail">Application for Ballot by Mail</a>
<a href="/3522/Sample-Ballots-2026-General-Election">Sample Ballots 2026 General Election</a>
`;

const fileName = "ABBM LIST November 3, 2026 (Cumulative)_202610050918429804.xlsx";

test("finds the mail-in ballots file for the November 3 election", () => {
  const link = hidalgoMailRosterLink(page);
  assert.equal(
    link.href,
    "https://www.hidalgocounty.us/DocumentCenter/View/73301/ABBM-LIST-November-3-2026-Cumulative",
  );
  assert.equal(link.votingMethod, "AB");
});

test("reads the YYYYMMDD stamp after the underscore, including the download header", () => {
  assert.equal(hidalgoVoteDateFromFileName(fileName), "2026-10-05");
  assert.equal(hidalgoVoteDateFromFileName("mail_20261001.csv"), "2026-10-01");
  assert.equal(hidalgoVoteDateFromFileName("mail_20261340.csv"), null);
  const header = "inline;filename=ABBM%20LIST%20November%203%2C%202026%20%28Cumulative%29_202610050918429804.xlsx";
  assert.equal(hidalgoDownloadName(header), fileName);
  assert.equal(hidalgoVoteDateFromFileName(hidalgoDownloadName(header)), "2026-10-05");
});

test("first pull dates every new VUID from the file name and a later pull only adds new VUIDs", () => {
  const matrix = [
    ["Certificate", "VUID", "LastName", "FirstName", "Precinct"],
    ["78", "1000000001", "A", "One", "1"],
    ["79", "1000000001", "A", "One", "1"],
    ["80", "", "B", "Two", "2"],
    ["81", "1000000002", "C", "Three", "3"],
  ];
  const first = hidalgoRosterRows(matrix, "2026-10-05", []);
  assert.deepEqual(first.rows, [
    { vuid: "1000000001", activityDate: "2026-10-05", votingMethod: "AB" },
    { vuid: "1000000002", activityDate: "2026-10-05", votingMethod: "AB" },
  ]);
  assert.equal(first.skippedMissingVuid, 1);
  assert.equal(first.alreadyStored, 0);

  const later = [...matrix, ["82", "1000000003", "D", "Four", "4"]];
  const second = hidalgoRosterRows(later, "2026-10-06", ["1000000001", "1000000002"]);
  assert.deepEqual(second.rows, [{ vuid: "1000000003", activityDate: "2026-10-06", votingMethod: "AB" }]);
  assert.equal(second.alreadyStored, 2);
});

test("parses the workbook and a csv the same way", () => {
  const rows = [
    ["VUID"],
    ["1000000001"],
    ["1000000009"],
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Received");
  const workbook = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  const fromWorkbook = parseHidalgoRosterFile(workbook, fileName, ["1000000001"]);
  assert.deepEqual(fromWorkbook.rows, [{ vuid: "1000000009", activityDate: "2026-10-05", votingMethod: "AB" }]);

  const fromCsv = parseHidalgoRosterFile("VUID\n1000000001\n1000000004\n", "mail_20261002.csv", ["1000000001"]);
  assert.deepEqual(fromCsv.rows, [{ vuid: "1000000004", activityDate: "2026-10-02", votingMethod: "AB" }]);
});
