import assert from "node:assert/strict";
import test from "node:test";
import {
  countiesDueForRosterPull,
  mergeRosterRecords,
  registrationDateFromProfile,
  sortRosterVoters,
  summarizeRosterRows,
  tieVoteToCounty,
  voterProfileFromLookup,
} from "./countyRosterPulls.mjs";

test("summarizes roster rows by voter, day, and vote type", () => {
  const summary = summarizeRosterRows([
    { vuid: "1", activityDate: "2026-10-19", votingMethod: "EV" },
    { vuid: "1", activityDate: "2026-10-19", votingMethod: "EV" },
    { vuid: "2", activityDate: "2026-10-19", votingMethod: "AB" },
    { vuid: "3", activityDate: "2026-10-20", votingMethod: "EV" },
    { vuid: "4", activityDate: "", votingMethod: "" },
  ]);
  assert.equal(summary.rows, 5);
  assert.equal(summary.uniqueVuids, 4);
  assert.equal(summary.earlyInPerson, 3);
  assert.equal(summary.mail, 1);
  assert.equal(summary.other, 1);
  assert.equal(summary.days[0].date, "2026-10-19");
  assert.equal(summary.days[0].voters, 3);
  assert.equal(summary.days[0].mail, 1);
  assert.equal(summary.days[1].date, "2026-10-20");
  assert.equal(summary.days.at(-1).date, "Unknown");
});

test("keeps a matched voter and does not look that VUID up again", () => {
  const existing = [
    {
      vuid: "10",
      voteDate: "2026-09-22",
      sourceCounty: "travis",
      matched: 1,
      county: "TRAVIS",
      txHouse: "49",
      txSenate: "14",
      usHouse: "37",
      score2022: 0.42,
      score2026: 55.1,
    },
  ];
  const incoming = [
    { vuid: "10", activityDate: "2026-09-22" },
    { vuid: "10", activityDate: "2026-09-28" },
    { vuid: "20", activityDate: "2026-09-23" },
  ];
  const merged = mergeRosterRecords(existing, incoming, "travis");
  assert.equal(merged.added, 2);
  assert.deepEqual(merged.unmatchedVuids, ["20"]);
  const secondDay = merged.voters.find((row) => row.vuid === "10" && row.voteDate === "2026-09-28");
  assert.equal(secondDay.matched, 1);
  assert.equal(secondDay.county, "TRAVIS");
  assert.equal(secondDay.txHouse, "49");
  assert.equal(secondDay.score2026, 55.1);
});

test("uses the county where the ballot was cast and clears districts when the roll county differs", () => {
  const row = tieVoteToCounty({
    vuid: "10",
    voteDate: "2026-09-28",
    sourceCounty: "bexar",
    matched: 1,
    county: "HARRIS",
    txHouse: "134",
    txSenate: "15",
    usHouse: "18",
    score2022: 0.4,
    score2026: 60,
  });
  assert.equal(row.county, "BEXAR");
  assert.equal(row.registeredCounty, "HARRIS");
  assert.equal(row.txHouse, null);
  assert.equal(row.txSenate, null);
  assert.equal(row.usHouse, null);
  assert.equal(row.score2026, 60);

  const again = tieVoteToCounty(row);
  assert.equal(again.county, "BEXAR");
  assert.equal(again.registeredCounty, "HARRIS");
  assert.equal(again.txHouse, null);
});

const HOURLY = { enabled: true, intervalMinutes: 60, startHour: 9, endHour: 13, timeZone: "America/Chicago" };

test("keeps name, address, and registration date from extra voter-file columns", () => {
  const profile = voterProfileFromLookup({
    VUID: "10",
    CountyName: "TRAVIS",
    USHouse: "37",
    TXSenate: "14",
    TXHouse: "49",
    Score2022: "0.42",
    Score2026: "55.1",
    FirstName: "Ada",
    LastName: "Lovelace",
    RegistrationDate: "2012-01-15 00:00:00.000",
    RegistrationAddr1: "100 MAIN ST",
    RegistrationAddr2: "APT 2",
    RegCity: "LUBBOCK",
    RegSta: "TX",
    RegZip5: "79401",
  });
  assert.equal(registrationDateFromProfile(profile), "2012-01-15");
  assert.equal(profile.find((field) => field.label === "FirstName").value, "Ada");
  assert.equal(profile.find((field) => field.label === "RegistrationAddr1").value, "100 MAIN ST");
  assert.equal(profile.find((field) => field.label === "RegZip5").value, "79401");
  assert.equal(profile.some((field) => field.label === "Score2026"), false);
});

test("sorts registration date and leaves blank dates last", () => {
  const rows = [
    { vuid: "2", voteDate: "2026-09-22", registrationDate: "2020-01-01" },
    { vuid: "1", voteDate: "2026-09-28", registrationDate: null },
    { vuid: "3", voteDate: "2026-09-24", registrationDate: "2012-01-15" },
  ];
  assert.deepEqual(
    sortRosterVoters(rows, "registrationDate", "asc").map((row) => row.vuid),
    ["3", "2", "1"],
  );
  assert.deepEqual(
    sortRosterVoters(rows, "registrationDate", "desc").map((row) => row.vuid),
    ["2", "3", "1"],
  );
});

test("pulls trained counties once an hour from 9am through 1pm Central", () => {
  const counties = {
    bexar: { pulledAt: "2026-09-29T14:00:00.000Z" },
    harris: { pulledAt: "2026-09-29T14:00:00.000Z" },
    travis: { pulledAt: "2026-09-29T14:00:00.000Z" },
  };
  assert.deepEqual(countiesDueForRosterPull(counties, HOURLY, new Date("2026-09-29T13:59:00.000Z")), []);
  assert.deepEqual(countiesDueForRosterPull({}, HOURLY, new Date("2026-09-29T14:00:00.000Z")), ["bexar", "harris", "travis"]);
  assert.deepEqual(countiesDueForRosterPull(counties, HOURLY, new Date("2026-09-29T14:30:00.000Z")), []);
  assert.deepEqual(countiesDueForRosterPull(counties, HOURLY, new Date("2026-09-29T15:00:00.000Z")), ["bexar", "harris", "travis"]);
  assert.deepEqual(countiesDueForRosterPull(counties, HOURLY, new Date("2026-09-29T18:30:00.000Z")), ["bexar", "harris", "travis"]);
  assert.deepEqual(countiesDueForRosterPull(counties, HOURLY, new Date("2026-09-29T19:00:00.000Z")), []);
  assert.deepEqual(countiesDueForRosterPull({}, { ...HOURLY, enabled: false }, new Date("2026-09-29T15:00:00.000Z")), []);
  assert.deepEqual(
    countiesDueForRosterPull(
      { bexar: { pulledAt: "2026-09-29T14:50:00.000Z" }, harris: { pulledAt: "2026-09-29T14:00:00.000Z" } },
      HOURLY,
      new Date("2026-09-29T15:00:00.000Z"),
    ),
    ["harris", "travis"],
  );
});
