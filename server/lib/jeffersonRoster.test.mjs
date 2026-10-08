import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { jeffersonRosterLinks, jeffersonRosterRows, parseJeffersonRosterXls } from "./jeffersonRoster.mjs";

const page = `
<h2>November 3rd - General Election for State and County Officers</h2>
<p>Received mail ballots for the 2026 November General Election received as of:</p>
<p><a href="https://www.jeffcotxvotes.gov/wp-content/uploads/2026/10/JeffersonCountyNov2026MailBallotsReceived01012026to10072026.xls">Wednesday, October 7, 2026</a></p>
<p>Early Voting In Person:</p>
<p><a href="/wp-content/uploads/2026/10/JeffersonCountyEarlyVotingInPerson10192026.xls">Monday, October 19, 2026</a></p>
<p><a href="/wp-content/uploads/2026/10/JeffersonCountyEarlyVotingInPerson10202026.xls">Tuesday, October 20, 2026</a></p>
<h2>June Runoff</h2>
<p><a href="/wp-content/uploads/2026/06/JeffersonCountyPortArthurRunoffMailBallotsReceived01012026to06152026.xls">June 16, 2026</a></p>
`;

test("reads the November mail file and each early-voting file", () => {
  const links = jeffersonRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.voteDate, link.votingMethod, link.href.endsWith("10072026.xls"), link.href.endsWith("10192026.xls")]),
    [
      ["2026-10-07", "AB", true, false],
      ["2026-10-19", "EV", false, true],
      ["2026-10-20", "EV", false, false],
    ],
  );
});

test("dates a new VUID from the file name and leaves a stored VUID alone", () => {
  const known = new Set(["1121838124"]);
  const parsed = jeffersonRosterRows(
    [
      ["Selected - Election", "VUID", "Name"],
      ["2026 NOVEMBER GENERAL ELECTION", "1121838124", "ALREADY STORED"],
      ["2026 NOVEMBER GENERAL ELECTION", "1122807611", "ALFRED,JOAN"],
      ["2026 NOVEMBER GENERAL ELECTION", "", "NO ID"],
      ["2024 MARCH PRIMARY", "1200332170", "OTHER"],
    ],
    "2026-10-07",
    "AB",
    known,
  );
  assert.deepEqual(parsed.rows, [{ vuid: "1122807611", activityDate: "2026-10-07", votingMethod: "AB" }]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-10-07", missingVuid: 1 }]);
  assert.equal(known.has("1122807611"), true);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Selected - Election", "VUID", "Name"],
      ["2026 NOVEMBER GENERAL ELECTION", "2133122999", "BIBBINS,JAMES CURTIS"],
    ]),
    "roster",
  );
  const fromFile = parseJeffersonRosterXls(
    XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
    "JeffersonCountyNov2026MailBallotsReceived01012026to10072026.xls",
    "AB",
    known,
  );
  assert.deepEqual(fromFile.rows, [{ vuid: "2133122999", activityDate: "2026-10-07", votingMethod: "AB" }]);
});
