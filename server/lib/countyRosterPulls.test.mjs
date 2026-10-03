import assert from "node:assert/strict";
import test from "node:test";
import {
  countiesDueForRosterPull,
  rosterCaughtUp,
  rosterCountyCounts,
  mergeRosterRecords,
  rosterMethodCode,
  registrationDateFromProfile,
  rosterVotersToCsv,
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
  assert.equal(secondDay.votingMethod, null);
});

test("keeps a voting method and fills it when the same ballot is pulled again", () => {
  const first = mergeRosterRecords(
    [],
    [{ vuid: "1", activityDate: "2026-10-01", votingMethod: "AB" }],
    "harris",
  );
  assert.equal(first.voters[0].votingMethod, "AB");
  const same = mergeRosterRecords(
    first.voters,
    [{ vuid: "1", activityDate: "2026-10-01", votingMethod: "EV" }],
    "harris",
  );
  assert.equal(same.added, 0);
  assert.equal(same.voters[0].votingMethod, "AB");
  const filled = mergeRosterRecords(
    [{ vuid: "1", voteDate: "2026-10-01", sourceCounty: "montgomery", matched: 0, votingMethod: null }],
    [{ vuid: "1", activityDate: "2026-10-01", votingMethod: "EV" }],
    "montgomery",
  );
  assert.equal(filled.added, 0);
  assert.equal(filled.voters[0].votingMethod, "EV");
  assert.equal(rosterMethodCode("AB"), "abb");
  assert.equal(rosterMethodCode("EV"), "ev");
  assert.equal(rosterMethodCode("ED"), "ed");
  assert.equal(rosterMethodCode("election day"), "ed");
  assert.equal(rosterMethodCode(""), "");
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

test("counts stored voters for the county that pulled them", () => {
  const counts = rosterCountyCounts([
    { sourceCounty: "bexar", vuid: "1", voteDate: "2026-09-28" },
    { sourceCounty: "bexar", vuid: "1", voteDate: "2026-09-30" },
    { sourceCounty: "BEXAR", vuid: "2", voteDate: "2026-09-30" },
    { sourceCounty: "travis", vuid: "3", voteDate: "2026-09-22" },
    { sourceCounty: "harris", vuid: "", voteDate: "2026-09-24" },
  ]);
  assert.equal(counts.bexar.rows, 3);
  assert.equal(counts.bexar.uniqueVuids, 2);
  assert.equal(counts.bexar.days.length, 2);
  assert.equal(counts.bexar.days.find((day) => day.date === "2026-09-30").voters, 2);
  assert.equal(counts.travis.uniqueVuids, 1);
  assert.equal(counts.harris.uniqueVuids, 0);
  assert.equal(counts.harris.rows, 1);
  assert.equal(counts.harris.missingVuid, 1);
  assert.equal(counts.harris.days[0].missingVuid, 1);
});

test("a vote date of yesterday, or the day before today's pull, is current", () => {
  const now = new Date("2026-10-01T14:00:00.000Z");
  assert.equal(rosterCaughtUp("2026-09-30", null, now), true);
  assert.equal(rosterCaughtUp("2026-09-28", "2026-10-01T14:10:00.000Z", now), false);
  assert.equal(rosterCaughtUp("2026-09-30", "2026-10-01T14:10:00.000Z", now), true);
  assert.equal(rosterCaughtUp("2026-09-30", "2026-09-28T14:10:00.000Z", new Date("2026-10-02T14:00:00.000Z")), false);
});

test("auto-pulls at 9, 10, 11, and noon Central, Monday through Saturday, until yesterday's ballots are in", () => {
  const nine = new Date("2026-10-01T14:00:00.000Z");
  const voters = [
    { sourceCounty: "bexar", voteDate: "2026-09-30" },
    { sourceCounty: "harris", voteDate: "2026-09-28" },
  ];
  assert.deepEqual(countiesDueForRosterPull({}, HOURLY, new Date("2026-10-01T13:59:00.000Z"), voters), []);
  assert.deepEqual(countiesDueForRosterPull({}, HOURLY, nine, voters), ["harris", "travis"]);
  assert.deepEqual(countiesDueForRosterPull({}, HOURLY, new Date("2026-10-01T16:30:00.000Z"), voters), ["harris", "travis"]);
  assert.deepEqual(countiesDueForRosterPull({}, HOURLY, new Date("2026-10-01T17:00:00.000Z"), voters), ["harris", "travis"]);
  assert.deepEqual(countiesDueForRosterPull({}, HOURLY, new Date("2026-10-01T18:00:00.000Z"), voters), []);
  assert.deepEqual(countiesDueForRosterPull({}, HOURLY, new Date("2026-10-04T14:00:00.000Z"), []), []);
  assert.deepEqual(
    countiesDueForRosterPull({ harris: { pulledAt: "2026-10-01T14:10:00.000Z" } }, HOURLY, new Date("2026-10-01T14:40:00.000Z"), voters),
    ["travis"],
  );
  assert.deepEqual(
    countiesDueForRosterPull({ harris: { pulledAt: "2026-10-01T14:10:00.000Z" } }, HOURLY, new Date("2026-10-01T15:00:00.000Z"), voters),
    ["harris", "travis"],
  );
  assert.deepEqual(countiesDueForRosterPull({}, { ...HOURLY, enabled: false }, nine, voters), []);
});

test("exports the voted roster columns, name, address, and other voter-file fields", () => {
  const csv = rosterVotersToCsv([
    {
      vuid: "100",
      voteDate: "2026-10-01",
      registrationDate: "2020-01-02",
      score2026: 46.6,
      score2022: 0.512,
      county: "HARRIS",
      txHouse: "134",
      txSenate: "7",
      usHouse: "38",
      votingMethod: "AB",
      matched: 1,
      profile: [
        { label: "FirstName", value: "Ada" },
        { label: "LastName", value: "Lovelace" },
        { label: "RegistrationAddr1", value: "100 MAIN ST" },
        { label: "RegCity", value: "Houston" },
        { label: "RegSta", value: "TX" },
        { label: "RegZip5", value: "77002" },
        { label: "Party", value: "REP" },
      ],
    },
    {
      vuid: '200, "quoted"',
      voteDate: "2026-10-02",
      votingMethod: "EV",
      matched: 0,
      profile: null,
    },
  ]);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(
    lines[0],
    "Vote date,Method,VUID,Registration date,2026 model,2022 model,County,State House,State Senate,Congress,Matched,Name,Address,Party",
  );
  assert.equal(
    lines[1],
    "2026-10-01,abb,100,2020-01-02,46.6,0.512,HARRIS,134,7,38,1,Ada Lovelace,\"100 MAIN ST, Houston, TX 77002\",REP",
  );
  assert.equal(lines[2], '2026-10-02,ev,"200, ""quoted""",,,,,,,,0,,,');
});
