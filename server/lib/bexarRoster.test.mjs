import assert from "node:assert/strict";
import test from "node:test";
import { bexarRosterDocuments, bexarRosterFilesToPull, parseBexarRosterPages } from "./bexarRoster.mjs";

test("uses the date in the file name and skips days that already have voters", () => {
  const files = bexarRosterDocuments([
    {
      DisplayName: "Received Mail Ballots - 2026-09-28 - November 3, 2026 General Election",
      FileType: "pdf",
      URL: "/DocumentCenter/View/1901/Received-Mail-Ballots---2026-09-28---November-3-2026-General-Election",
      LastModifiedDateString: "Oct 1, 2026",
    },
    {
      DisplayName: "Received Mail Ballots - 2026-09-29 - November 3, 2026 General Election",
      FileType: "pdf",
      URL: "/DocumentCenter/View/1902/Received-Mail-Ballots---2026-09-29",
      LastModifiedDateString: "Sep 29, 2026",
    },
    {
      DisplayName: "Received Mail Ballots - 2026-09-30 - November 3, 2026 General Election",
      FileType: "pdf",
      URL: "/DocumentCenter/View/1905/Received-Mail-Ballots---2026-09-30",
      LastModifiedDateString: "Sep 30, 2026",
    },
    {
      DisplayName: "Early Voting Roster - 2026-10-19 - November 3, 2026 General Election",
      FileType: "pdf",
      URL: "/DocumentCenter/View/2100/Early-Voting",
      LastModifiedDateString: "Sep 1, 2026",
    },
    {
      DisplayName: "Instructions",
      FileType: "pdf",
      URL: "/DocumentCenter/View/1/Instructions",
      LastModifiedDateString: "Oct 2, 2026",
    },
  ]);
  const selected = bexarRosterFilesToPull(files, ["2026-09-28", "2026-09-29"]);
  assert.deepEqual(
    selected.map((file) => [file.voteDate, file.votingMethod]),
    [
      ["2026-09-30", "AB"],
      ["2026-10-19", "EV"],
    ],
  );
  assert.equal(selected[0].href, "https://elections.bexar.gov/DocumentCenter/View/1905/Received-Mail-Ballots---2026-09-30");
  const mailOnly = bexarRosterFilesToPull(
    files.filter((file) => file.votingMethod === "AB"),
    ["2026-09-28"],
  );
  assert.deepEqual(
    mailOnly.map((file) => file.voteDate),
    ["2026-09-29", "2026-09-30"],
  );
});

test("reads the VUID from column 1 and the received date from column 6", () => {
  const headers = [
    { str: "VUID", x: 53, y: 66 },
    { str: "Last Name", x: 115, y: 66 },
    { str: "Suffix", x: 198, y: 66 },
    { str: "First Name", x: 230, y: 66 },
    { str: "Middle Name", x: 312, y: 66 },
    { str: "Ballot Received Date", x: 395, y: 66 },
    { str: "Precinct", x: 503, y: 66 },
  ];
  const parsed = parseBexarRosterPages([
    [
      ...headers,
      { str: "2166120393", x: 55, y: 81 },
      { str: "ALEMAN REYES", x: 115, y: 81 },
      { str: "DAVID", x: 230, y: 81 },
      { str: "MANUEL", x: 312, y: 81 },
      { str: "9/28/2026", x: 452, y: 81 },
      { str: "S 3072.01", x: 503, y: 81 },
      { str: "2213375952", x: 55, y: 96 },
      { str: "ARNOLD", x: 115, y: 96 },
      { str: "TERRENCE", x: 230, y: 96 },
      { str: "9/28/2026", x: 452, y: 96 },
      { str: "P 4168", x: 503, y: 96 },
    ],
  ]);
  assert.deepEqual(parsed.rows, [
    { vuid: "2166120393", activityDate: "2026-09-28", votingMethod: "AB" },
    { vuid: "2213375952", activityDate: "2026-09-28", votingMethod: "AB" },
  ]);
});

test("reads the shorter VUID, name, and received-date layout", () => {
  const parsed = parseBexarRosterPages(
    [
      [
        { str: "VUID", x: 53, y: 66 },
        { str: "Name", x: 115, y: 66 },
        { str: "Received Date", x: 294, y: 66 },
        { str: "Precinct", x: 380, y: 66 },
        { str: "2221391468", x: 55, y: 81 },
        { str: "BLAND,GLENDA DAWN", x: 115, y: 81 },
        { str: "9/30/2026", x: 302, y: 81 },
        { str: "P 3007", x: 380, y: 81 },
      ],
    ],
    { votingMethod: "AB", fallbackDate: "2026-09-30" },
  );
  assert.deepEqual(parsed.rows, [{ vuid: "2221391468", activityDate: "2026-09-30", votingMethod: "AB" }]);
});
