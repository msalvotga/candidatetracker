import assert from "node:assert/strict";
import test from "node:test";
import { galvestonMailRosterLinks, galvestonRosterFilesToPull, parseGalvestonMailCsv } from "./galvestonRoster.mjs";

const page = `
<div class="al-accordion"><button>Election Day Roster</button><div class="al-accordion-content">
<p>9/30/2026 <a href="https://galvestonvotes.org/wp-content/uploads/2026/11/election-day.csv">CSV</a></p>
</div></div>
<div class="al-accordion"><button>Mail Ballot Rosters</button><div class="al-accordion-content">
<p>9/25/2026 <a href="https://galvestonvotes.org/wp-content/uploads/2026/09/Nov-3rd-2026-Ballots-received-9.25.25.csv">CSV</a>/<a href="https://galvestonvotes.org/day.pdf">PDF</a></p>
<p>9/30/2026 <a href="https://galvestonvotes.org/wp-content/uploads/2026/09/nov-3rd-2026-Ballots-recevied-9.30.26.csv">CSV</a></p>
</div></div>
`;

test("reads mail roster CSVs by the date beside the link", () => {
  const links = galvestonMailRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.voteDate, link.href.endsWith("9.25.25.csv"), link.href.endsWith("9.30.26.csv")]),
    [
      ["2026-09-25", true, false],
      ["2026-09-30", false, true],
    ],
  );
});

test("keeps the newest day and skips days that already have voters", () => {
  const files = galvestonMailRosterLinks(page);
  const selected = galvestonRosterFilesToPull(files, ["2026-09-25"]);
  assert.deepEqual(selected.map((file) => file.voteDate), ["2026-09-30"]);
});

test("reads VUID and Ballot Received Date", () => {
  const parsed = parseGalvestonMailCsv(
    `Selected - Election,Precinct,VUID,Name,Ballot Received Date,Status
2026 NOVEMBER GENERAL ELECTION,215,3383140211,"PALACIOS,ALBERTO ALFONSO",9/21/2026,Ballot Received
2026 NOVEMBER GENERAL ELECTION,218,,TIMOTHY,9/24/2026,Ballot Received
`,
  );
  assert.deepEqual(parsed.rows, [{ vuid: "3383140211", activityDate: "2026-09-21", votingMethod: "AB" }]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-09-24", missingVuid: 1 }]);
});
