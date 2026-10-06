import assert from "node:assert/strict";
import test from "node:test";
import { comalLinkDate, comalMailRosterLinks, comalRosterFilesToPull, parseComalRosterPages } from "./comalRoster.mjs";

const page = `
<h2>Early Voting Data</h2>
<ul><li>Ballot By Mail<ul>
  <li><a href="/DocumentCenter/View/8704">10-02-2026, GENERAL ELECTION BBM RETD</a></li>
  <li><a href="/DocumentCenter/View/8703">10-02-2026, COMAL ISD BBM RETD</a></li>
  <li><a href="/DocumentCenter/View/8698">10-01-2026, GENERAL ELECTION BBM RETD</a></li>
  <li><a href="/DocumentCenter/View/8621">09-29-2026, SCHERTZ BBM RETD</a></li>
  <li><a href="/DocumentCenter/View/8606">09-28-2026, GENERAL ELECTION BBM RETD</a></li>
</ul></li></ul>
<a href="/DocumentCenter/View/6321/03-03-26-REPUBLICAN-BBM-RETD-PDF">03-03-26 REPUBLICAN BBM RETD (PDF)</a>
`;

test("keeps general-election mail PDFs and dates them from the link", () => {
  assert.equal(comalLinkDate("10-02-2026, GENERAL ELECTION BBM RETD"), "2026-10-02");
  const links = comalMailRosterLinks(page);
  assert.deepEqual(
    links.map((link) => link.voteDate),
    ["2026-09-28", "2026-10-01", "2026-10-02"],
  );
  assert.equal(links[0].href, "https://www.comalcounty.gov/DocumentCenter/View/8606");
  assert.equal(links[0].votingMethod, "AB");
});

test("pulls the newest day and any earlier day that has no stored voters", () => {
  const files = comalMailRosterLinks(page);
  assert.deepEqual(
    comalRosterFilesToPull(files, ["2026-09-28"]).map((file) => file.voteDate),
    ["2026-10-01", "2026-10-02"],
  );
});

test("reads VUID and Ballot Returned Date from each PDF row", () => {
  const pages = [
    [
      { str: "GENERAL ELECTION", x: 261, y: 33 },
      { str: "09.28.26", x: 286, y: 63 },
      { str: "Vuid", x: 53, y: 84 },
      { str: "Ballot Returned Date", x: 356, y: 84 },
      { str: "1000000001", x: 55, y: 99 },
      { str: "A", x: 115, y: 99 },
      { str: "307-FED", x: 297, y: 99 },
      { str: "9/28/2026", x: 414, y: 99 },
      { str: "1000000001", x: 55, y: 114 },
      { str: "A", x: 115, y: 114 },
      { str: "9/28/2026", x: 414, y: 114 },
    ],
  ];
  const parsed = parseComalRosterPages(pages, { fallbackDate: "2026-09-28" });
  assert.deepEqual(parsed.rows, [{ vuid: "1000000001", activityDate: "2026-09-28", votingMethod: "AB" }]);
  assert.equal(parsed.skippedMissingVuid, 0);
});
