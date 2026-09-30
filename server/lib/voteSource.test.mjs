import assert from "node:assert/strict";
import test from "node:test";
import { resolveVoteSource, sumVoteRows } from "./voteSource.mjs";

test("auto uses manual only when it is strictly higher", () => {
  assert.equal(resolveVoteSource("auto", 100, 80, 101, true), "manual");
  assert.equal(resolveVoteSource("auto", 100, 120, 120, true), "sos");
  assert.equal(resolveVoteSource("auto", 150, 120, 150, true), "county_feed");
  assert.equal(resolveVoteSource("auto", 0, 40, 0, false), "sos");
});

test("forced manual wins even when lower", () => {
  assert.equal(resolveVoteSource("manual", 500, 400, 10, true), "manual");
  assert.equal(resolveVoteSource("manual", 500, 400, 0, true), "manual");
  assert.equal(resolveVoteSource("manual", 500, 0, 0, false), "county_feed");
});

test("pinned sos and county site stay pinned", () => {
  assert.equal(resolveVoteSource("sos", 900, 10, 5000, true), "sos");
  assert.equal(resolveVoteSource("county_feed", 20, 800, 5000, true), "county_feed");
});

test("sumVoteRows counts mail inside the total", () => {
  assert.equal(
    sumVoteRows([
      { earlyVotes: 2, electionDayVotes: 3, mailVotes: 4, totalVotes: 9 },
      { earlyVotes: 1, electionDayVotes: 1, mailVotes: 1, totalVotes: 0 },
    ]),
    12,
  );
});
