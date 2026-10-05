import assert from "node:assert/strict";
import test from "node:test";
import { rosterPullStamp, rosterRawFileName } from "./rosterRawArchive.mjs";

test("pull folders use Central Time down to the minute", () => {
  assert.equal(rosterPullStamp(new Date("2026-10-05T16:09:00Z")), "20261005_1109");
});

test("raw file names stay attached to the downloaded file", () => {
  assert.equal(
    rosterRawFileName("https://elections.example.gov/files/Mail%20Ballot.zip"),
    "Mail Ballot.zip",
  );
  assert.equal(rosterRawFileName("harris/bbm.csv"), "bbm.csv");
});
