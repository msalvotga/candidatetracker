import assert from "node:assert/strict";
import test from "node:test";
import { brazosDateFromText, brazosRosterFilesToPull, brazosRosterLinks, parseBrazosRosterPages } from "./brazosRoster.mjs";

const page = `
<h3 class="wp-block-heading">2026 General/Special Election</h3>
<ul>
  <li><a href="https://elections.brazoscountytx.gov/wp-content/uploads/2026/10/mail-09-30-2026-accessible.pdf">10/02/2026 Roster (mail)</a></li>
  <li><a href="https://elections.brazoscountytx.gov/wp-content/uploads/2026/10/mail-10-01-2026-accessible.pdf">10/01/2026 Roster (mail)</a></li>
  <li><a href="https://elections.brazoscountytx.gov/wp-content/uploads/2026/10/mail-09-30-2026-accessible.pdf">9/30/2026 Roster (mail)</a></li>
  <li><a href="https://elections.brazoscountytx.gov/wp-content/uploads/2026/10/in-person-10-13-2026-accessible.pdf">10/13/2026 Roster (in person)</a></li>
</ul>
<h3 class="wp-block-heading">2026 Primary Runoff Election</h3>
<ul>
  <li><a href="https://elections.brazoscountytx.gov/wp-content/uploads/2026/05/DEM-mail-05-26-2026-accessible.pdf">5/26/2026 DEM Roster (mail)</a></li>
</ul>
`;

test("keeps November 2026 general files and dates them from the file name", () => {
  assert.equal(brazosDateFromText("mail-09-30-2026-accessible.pdf"), "2026-09-30");
  assert.equal(brazosDateFromText("Mailed ballots received 10/01/2026"), "2026-10-01");
  const links = brazosRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.voteDate, link.votingMethod]),
    [
      ["2026-09-30", "AB"],
      ["2026-10-01", "AB"],
      ["2026-10-13", "EV"],
    ],
  );
  assert.equal(links.filter((link) => link.voteDate === "2026-09-30").length, 1);
});

test("pulls the newest day and any earlier file that is not already stored", () => {
  const files = brazosRosterLinks(page);
  const selected = brazosRosterFilesToPull(files, ["2026-09-30|AB"]);
  assert.deepEqual(
    selected.map((file) => `${file.voteDate}|${file.votingMethod}`),
    ["2026-10-01|AB", "2026-10-13|EV"],
  );
});

test("dates every VUID from the first line, and from the file name when that line has no day", () => {
  const pages = [
    [
      { str: "Mailed ballots received 09/30/2026", x: 53, y: 66 },
      { str: "SELECTED ELECTION", x: 53, y: 81 },
      { str: "VUID", x: 279, y: 81 },
      { str: "2026 GENERAL/SPECIAL", x: 53, y: 96 },
      { str: "76", x: 264, y: 96 },
      { str: "1000000001", x: 312, y: 96 },
      { str: "A", x: 372, y: 96 },
      { str: "1000000001", x: 312, y: 112 },
      { str: "A", x: 372, y: 112 },
    ],
  ];
  const parsed = parseBrazosRosterPages(pages, { fallbackDate: "2026-10-02", votingMethod: "AB" });
  assert.equal(parsed.voteDate, "2026-09-30");
  assert.deepEqual(parsed.rows, [{ vuid: "1000000001", activityDate: "2026-09-30", votingMethod: "AB" }]);

  const fromName = parseBrazosRosterPages(
    [[{ str: "1000000008", x: 312, y: 96 }]],
    { fallbackDate: "mail-10-01-2026-accessible.pdf", votingMethod: "AB" },
  );
  assert.deepEqual(fromName.rows, [{ vuid: "1000000008", activityDate: "2026-10-01", votingMethod: "AB" }]);
});
