import assert from "node:assert/strict";
import test from "node:test";
import { parsePotterRosterPages, potterRosterLinks } from "./potterRoster.mjs";

const page = `
<a href="https://www.pottercountytexasvotes.gov/_files/ugd/abcbbe_street.pdf">Street Index</a>
<a href="/_files/ugd/3d1a20_old.pdf">Mail Ballot Roster</a>
<a href="/_files/ugd/3d1a20_new.pdf"><span>Early Voting Roster</span></a>
<a href="https://www.pottercountytexasvotes.gov/voting-rosters">In-Person &amp; Mail Ballot Rosters</a>
`;

test("follows the roster label and ignores other PDFs on the page", () => {
  const links = potterRosterLinks(page);
  assert.deepEqual(
    links.map((link) => [link.votingMethod, link.href]),
    [
      ["AB", "https://www.pottercountytexasvotes.gov/_files/ugd/3d1a20_old.pdf"],
      ["EV", "https://www.pottercountytexasvotes.gov/_files/ugd/3d1a20_new.pdf"],
    ],
  );
});

test("reads the VUID and ballot status date without gluing on the row number", () => {
  const parsed = parsePotterRosterPages(
    [
      [
        { str: "Mail Ballots Received", x: 225, y: 28 },
        { str: "VUID", x: 80, y: 44 },
        { str: "Name", x: 179, y: 44 },
        { str: "Precinct", x: 433, y: 44 },
        { str: "Ballot Status Date", x: 482, y: 44 },
        { str: "1", x: 70, y: 60 },
        { str: "1018508867", x: 80, y: 60 },
        { str: "ALCALA,FRANKIE ROBERT", x: 179, y: 60 },
        { str: "224", x: 433, y: 60 },
        { str: "9/28/2026", x: 482, y: 60 },
        { str: "45", x: 65, y: 80 },
        { str: "1025905168", x: 80, y: 80 },
        { str: "DIPPEL,LARRY", x: 179, y: 80 },
        { str: "325", x: 433, y: 80 },
        { str: "9/30/2026", x: 482, y: 80 },
      ],
    ],
    { votingMethod: "AB" },
  );
  assert.deepEqual(parsed.rows, [
    { vuid: "1018508867", activityDate: "2026-09-28", votingMethod: "AB" },
    { vuid: "1025905168", activityDate: "2026-09-30", votingMethod: "AB" },
  ]);
});
