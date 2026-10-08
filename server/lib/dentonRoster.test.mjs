import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { dentonRosterLinks, parseDentonRosterXlsx } from "./dentonRoster.mjs";

const page = `
<p><strong>Daily In-Person Early Voting Roster (Coming Soon)</strong></p>
<p><strong>Returned Mail Ballot Roster<a href="/wp-content/uploads/2026/10/1126_10-08_Returned_Mail_Roster.xlsx">(Excel)</a> <a href="/wp-content/uploads/2026/10/1126_10-08_Returned_Mail_Roster.pdf">(PDF)</a></strong></p>
<p><strong><a href="/wp-content/uploads/2026/10/1126_10-08_Returned_by_day_District.pdf">Returned Mail Ballot Totals</a></strong></p>
`;

test("reads the Excel link beside Returned Mail Ballot Roster", () => {
  const links = dentonRosterLinks(page);
  assert.equal(links.length, 1);
  assert.equal(links[0].votingMethod, "AB");
  assert.equal(links[0].href.endsWith("1126_10-08_Returned_Mail_Roster.xlsx"), true);
});

test("reads SOS_Vuid and Return Date from the workbook", () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Last_Name", "First_Name", "SOS_Vuid", "Return Date"],
    ["ROBERTS", "TERRI", "2204135440", " 10/07/2026"],
    ["NOID", "PERSON", "", " 10/06/2026"],
  ]);
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
  const parsed = parseDentonRosterXlsx(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  assert.deepEqual(parsed.rows, [{ vuid: "2204135440", activityDate: "2026-10-07", votingMethod: "AB" }]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-10-06", missingVuid: 1 }]);
});
