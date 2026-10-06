import assert from "node:assert/strict";
import test from "node:test";
import { bowieMailRosterLinks, bowieReceivedDate, bowieRosterFilesToPull, parseBowieRosterPages } from "./bowieRoster.mjs";

const page = `
<a aria-controls="tab-primary"><span data-tabname="March Primary">March Primary</span></a>
<div class="tabbedWidget cpTabPanel" id="tab-primary">
  <a href="/DocumentCenter/View/1/BBM-RECD-21026">BBM RECD 2.10.26</a>
  <a href="/DocumentCenter/View/2/BBM-Received-122026">BBM Received 1.2.2026</a>
</div>
<a aria-controls="tab-nov"><span data-tabname="November 3, 2026 General Election">November 3, 2026 General Election</span></a>
<div class="tabbedWidget cpTabPanel" id="tab-nov">
  <a href="/DocumentCenter/View/1907/sample">11.3.2026 COMBINED-SAMPLE BALLOT</a>
  <a href="/DocumentCenter/View/1910/BBM-Received-9222026">BBM Received 9.22.2026</a>
  <a href="/DocumentCenter/View/1947/BBM-Received-1012026">BBM Received 10.1.2026</a>
  <a href="/DocumentCenter/View/1958/BBM-Received-1022026">BBM Received 10.2.2026</a>
</div>
<div class="tabbedWidget cpTabPanel" id="tab-past"></div>
`;

test("reads BBM Received dates from the November 3 general election tab", () => {
  assert.equal(bowieReceivedDate("BBM Received 9.22.2026"), "2026-09-22");
  assert.equal(bowieReceivedDate("10.1.2026"), "2026-10-01");
  assert.equal(bowieReceivedDate("9/23/2026"), "2026-09-23");
  const links = bowieMailRosterLinks(page);
  assert.deepEqual(
    links.map((link) => link.voteDate),
    ["2026-09-22", "2026-10-01", "2026-10-02"],
  );
  assert.equal(links[0].href, "https://www.bowiecounty.org/DocumentCenter/View/1910/BBM-Received-9222026");
  assert.equal(links[0].votingMethod, "AB");
});

test("pulls the newest day and any earlier day that has no stored voters", () => {
  const files = bowieMailRosterLinks(page);
  assert.deepEqual(
    bowieRosterFilesToPull(files, ["2026-09-22"]).map((file) => file.voteDate),
    ["2026-10-01", "2026-10-02"],
  );
  assert.deepEqual(
    bowieRosterFilesToPull(files, ["2026-09-22", "2026-10-01", "2026-10-02"]).map((file) => file.voteDate),
    ["2026-10-02"],
  );
});

test("reads VUID and Date Rec'd from each PDF row", () => {
  const pages = [
    [
      { str: "VUID", x: 166, y: 101 },
      { str: "Voter", x: 239, y: 101 },
      { str: "Date Rec'd", x: 384, y: 101 },
      { str: "1000000001", x: 166, y: 116 },
      { str: "A", x: 239, y: 116 },
      { str: "9/22/2026", x: 385, y: 116 },
      { str: "1000000001", x: 166, y: 130 },
      { str: "A", x: 239, y: 130 },
      { str: "9/22/2026", x: 385, y: 130 },
      { str: "nope", x: 166, y: 145 },
      { str: "B", x: 239, y: 145 },
      { str: "9/22/2026", x: 385, y: 145 },
    ],
  ];
  const parsed = parseBowieRosterPages(pages, { fallbackDate: "2026-09-22" });
  assert.deepEqual(parsed.rows, [{ vuid: "1000000001", activityDate: "2026-09-22", votingMethod: "AB" }]);
  assert.equal(parsed.skippedMissingVuid, 1);

  const missingDate = parseBowieRosterPages([
    [
      { str: "Daily Received Ballots by Mail", x: 200, y: 40 },
      { str: "1000000008", x: 166, y: 116 },
      { str: "A", x: 239, y: 116 },
    ],
  ], { fallbackDate: "2026-10-02" });
  assert.deepEqual(missingDate.rows, [{ vuid: "1000000008", activityDate: "2026-10-02", votingMethod: "AB" }]);
  assert.equal(missingDate.skippedMissingVuid, 0);
});
