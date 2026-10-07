import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parkerRosterFilesToPull, parkerRosterLinks, parseParkerRosterXlsx } from "./parkerRoster.mjs";

const page = `
<div class="fr-view">
<p>Ballot by Mail - <a href="/DocumentCenter/View/14266" target="_blank">October 1, 2026</a> &nbsp;<a href="/DocumentCenter/View/14267">pdf </a></p>
<p>Early Voting - <a href="/DocumentCenter/View/15001">October 19, 2026</a> <a href="/DocumentCenter/View/15002">pdf</a></p>
</div>
`;

test("reads each date link as an Excel file and skips the pdf", () => {
  const links = parkerRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.asOf, link.votingMethod, link.href.endsWith("/14266"), link.href.endsWith("/15001")]),
    [
      ["2026-10-01", "AB", true, false],
      ["2026-10-19", "EV", false, true],
    ],
  );
});

test("keeps the newest posted day and skips days that already have voters", () => {
  const files = parkerRosterLinks(page);
  const selected = parkerRosterFilesToPull(files, ["2026-10-01"]);
  assert.deepEqual(selected.map((file) => file.asOf), ["2026-10-19"]);
});

test("reads VUID and Ballot Received Date from the workbook", () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Selected - Election", "VUID", "Name", "Ballot Received Date"],
    ["2026 NOVEMBER GENERAL ELECTION", "2135563455", "KLEINMAN,BRYCE IAN", "9/25/26"],
    ["2026 NOVEMBER GENERAL ELECTION", "", "NO ID", "9/28/26"],
    ["2024 MARCH PRIMARY", "1200332170", "OTHER", "3/1/24"],
  ]);
  XLSX.utils.book_append_sheet(book, sheet, "roster");
  const parsed = parseParkerRosterXlsx(XLSX.write(book, { type: "buffer", bookType: "xlsx" }), "AB");
  assert.deepEqual(parsed.rows, [{ vuid: "2135563455", activityDate: "2026-09-25", votingMethod: "AB" }]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-09-28", missingVuid: 1 }]);
});
