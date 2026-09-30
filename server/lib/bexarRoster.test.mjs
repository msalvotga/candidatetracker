import assert from "node:assert/strict";
import test from "node:test";
import { bexarMailRosterDocument, parseBexarRosterPages } from "./bexarRoster.mjs";

test("picks the received-mail PDF and leaves early voting alone", () => {
  const link = bexarMailRosterDocument([
    {
      DisplayName: "Unofficial Early Voting Roster",
      FileType: "pdf",
      URL: "/DocumentCenter/View/1/early",
      LastModifiedDateString: "Sep 29, 2026",
    },
    {
      DisplayName: "Received Mail Ballots - 2026-28-09 - November 3, 2026 General Election",
      FileType: "pdf",
      URL: "/DocumentCenter/View/1901/Received-Mail-Ballots",
      LastModifiedDateString: "Sep 28, 2026",
    },
    {
      DisplayName: "ABBM Roster November 3, 2026",
      FileType: "pdf",
      URL: "/DocumentCenter/View/2000/ABBM",
      LastModifiedDateString: "Sep 29, 2026",
    },
  ]);
  assert.equal(link.href, "https://elections.bexar.gov/DocumentCenter/View/2000/ABBM");
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
