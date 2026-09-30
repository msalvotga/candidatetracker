import assert from "node:assert/strict";
import test from "node:test";
import { parseIsoDate, votingDayFromDate } from "./ballotScoreCalendar.mjs";

test("2022 dates fold onto voting days", () => {
  assert.equal(votingDayFromDate("2022-10-01", 2022), 1);
  assert.equal(votingDayFromDate("2022-10-24", 2022), 1);
  assert.equal(votingDayFromDate("2022-10-29", 2022), 6);
  assert.equal(votingDayFromDate("2022-10-30", 2022), 7);
  assert.equal(votingDayFromDate("2022-10-31", 2022), 7);
  assert.equal(votingDayFromDate("2022-11-04", 2022), 11);
  assert.equal(votingDayFromDate("2022-11-05", 2022), 12);
  assert.equal(votingDayFromDate("2022-11-08", 2022), 12);
  assert.equal(votingDayFromDate("2022-11-09", 2022), 12);
});

test("2026 dates fold onto voting days", () => {
  assert.equal(votingDayFromDate("2026-09-22", 2026), 1);
  assert.equal(votingDayFromDate("2026-10-18", 2026), 1);
  assert.equal(votingDayFromDate("2026-10-19", 2026), 1);
  assert.equal(votingDayFromDate("2026-10-24", 2026), 6);
  assert.equal(votingDayFromDate("2026-10-25", 2026), 7);
  assert.equal(votingDayFromDate("2026-10-26", 2026), 7);
  assert.equal(votingDayFromDate("2026-10-30", 2026), 11);
  assert.equal(votingDayFromDate("2026-10-31", 2026), 12);
  assert.equal(votingDayFromDate("2026-11-03", 2026), 12);
});

test("parseIsoDate accepts ISO and US dates", () => {
  assert.equal(parseIsoDate("2026-10-19"), "2026-10-19");
  assert.equal(parseIsoDate("10/19/2026"), "2026-10-19");
  assert.equal(parseIsoDate("NULL"), null);
  assert.equal(parseIsoDate(""), null);
});
