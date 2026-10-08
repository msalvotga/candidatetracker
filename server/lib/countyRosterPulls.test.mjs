import assert from "node:assert/strict";
import test from "node:test";
import {
  countiesDueForRosterPull,
  outdatedRosterKeys,
  dropAutomaticRosterQueue,
  latestRosterVoteDate,
  rosterCaughtUp,
  rosterCountyCounts,
  applyRosterLookupBatch,
  applyRosterProfileRefresh,
  applyRosterLookupHits,
  chooseRosterDocument,
  mergeRosterRecords,
  unmatchedRosterVuids,
  rosterMethodCode,
  registrationDateFromProfile,
  rosterVotersToCsv,
  rosterVotesToCsv,
  rosterSuppressionToCsv,
  sortRosterVoters,
  summarizeRosterRows,
  tieVoteToCounty,
  voterProfileFromLookup,
} from "./countyRosterPulls.mjs";

test("a failed database write keeps the newer local roster", () => {
  const file = [{ vuid: "1", voteDate: "2026-10-05" }, { vuid: "2", voteDate: "2026-10-02" }];
  const database = [{ vuid: "1", voteDate: "2026-10-01" }];
  assert.equal(chooseRosterDocument(true, database, file, Array.isArray), file);
  assert.equal(chooseRosterDocument(false, database, file, Array.isArray), database);
  assert.deepEqual(chooseRosterDocument(false, undefined, file, Array.isArray), file);
});

test("voter-file matches apply without dropping roster rows", () => {
  const voters = [
    { vuid: "20", voteDate: "2026-10-05", matched: 0, sourceCounty: "brazos" },
    { vuid: "21", voteDate: "2026-10-05", matched: 1, sourceCounty: "brazos", county: "BRAZOS" },
    { vuid: "", voteDate: "2026-10-05", matched: 0, sourceCounty: "brazos" },
  ];
  assert.deepEqual([...unmatchedRosterVuids(voters)], ["20"]);
  const applied = applyRosterLookupHits(voters, new Map([
    ["20", { county: "BRAZOS", txHouse: "14", txSenate: "5", usHouse: "10", score2022: 0.2, score2026: 0.8, registrationDate: "2020-01-02", profile: [] }],
  ]));
  assert.equal(applied, 1);
  assert.equal(voters[0].matched, 1);
  assert.equal(voters[0].score2026, 0.8);
  assert.equal(voters[1].matched, 1);
  assert.equal(voters[2].matched, 0);
  assert.equal(voters.length, 3);
});

test("an updated voter file replaces stored profile fields on voters already matched", () => {
  const voters = [
    {
      vuid: "20",
      voteDate: "2026-10-05",
      sourceCounty: "bexar",
      votingMethod: "AB",
      matched: 1,
      county: "BEXAR",
      profile: [{ label: "FirstName", value: "JANE" }, { label: "LastName", value: "DOE" }],
    },
  ];
  const updated = applyRosterProfileRefresh(voters, new Map([
    ["20", {
      county: "BEXAR",
      txHouse: "14",
      txSenate: "5",
      usHouse: "10",
      score2022: 0.2,
      score2026: 0.8,
      registrationDate: "2020-01-02",
      profile: [
        { label: "FirstName", value: "JANE" },
        { label: "MiddleName", value: "Q" },
        { label: "LastName", value: "DOE" },
        { label: "DateOfBirth", value: "03/05/1980" },
        { label: "Sex", value: "F" },
        { label: "Cell", value: "5125550100" },
      ],
    }],
  ]));
  assert.equal(updated, 1);
  assert.equal(voters[0].voteDate, "2026-10-05");
  assert.equal(voters[0].votingMethod, "AB");
  assert.equal(voters[0].sourceCounty, "bexar");
  assert.equal(voters[0].profile.find((field) => field.label === "DateOfBirth").value, "03/05/1980");
  assert.equal(voters[0].profile.find((field) => field.label === "Sex").value, "F");
  assert.equal(voters[0].profile.find((field) => field.label === "Cell").value, "5125550100");
});

test("a finished lookup batch drops hits and misses from the voters still to match", () => {
  const voters = [
    { vuid: "20", voteDate: "2026-10-05", matched: 0, sourceCounty: "brazos" },
    { vuid: "20", voteDate: "2026-10-06", matched: 0, sourceCounty: "brazos" },
    { vuid: "30", voteDate: "2026-10-05", matched: 0, sourceCounty: "brazos" },
    { vuid: "40", voteDate: "2026-10-05", matched: 0, sourceCounty: "brazos" },
    { vuid: "21", voteDate: "2026-10-05", matched: 1, lookupChecked: 1, sourceCounty: "brazos" },
  ];
  const result = applyRosterLookupBatch(voters, ["20", "30"], new Map([
    ["20", { county: "BRAZOS", txHouse: "14", txSenate: "5", usHouse: "10", score2022: 0.2, score2026: 0.8 }],
  ]));
  assert.equal(result.applied, 2);
  assert.equal(result.checked, 1);
  assert.equal(voters[0].matched, 1);
  assert.equal(voters[1].matched, 1);
  assert.equal(voters[2].lookupChecked, 1);
  assert.equal(voters[2].matched, 0);
  assert.equal(voters[3].lookupChecked, undefined);
  assert.deepEqual([...unmatchedRosterVuids(voters)], ["40"]);
});

test("a voter already missing from the file is not looked up again", () => {
  const existing = [
    { vuid: "30", voteDate: "2026-10-01", sourceCounty: "randall", matched: 0, lookupChecked: 1 },
  ];
  const merged = mergeRosterRecords(
    existing,
    [
      { vuid: "30", activityDate: "2026-10-02", votingMethod: "AB" },
      { vuid: "40", activityDate: "2026-10-02", votingMethod: "AB" },
    ],
    "randall",
  );
  const nextDay = merged.voters.find((row) => row.vuid === "30" && row.voteDate === "2026-10-02");
  assert.equal(nextDay.lookupChecked, 1);
  assert.equal(nextDay.matched, 0);
  assert.deepEqual(merged.unmatchedVuids, ["40"]);
});

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
  assert.equal(rosterMethodCode("AB"), "AB");
  assert.equal(rosterMethodCode("EV"), "EV");
  assert.equal(rosterMethodCode("ED"), "ED");
  assert.equal(rosterMethodCode("election day"), "ED");
  assert.equal(rosterMethodCode(""), "");
});

test("drops CD, SD, and HD when the ballot county differs from the voter file", () => {
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

  const home = tieVoteToCounty({
    sourceCounty: "tom_green",
    county: "TOM GREEN",
    matched: 1,
    txHouse: "72",
    txSenate: "28",
    usHouse: "11",
  });
  assert.equal(home.county, "TOM GREEN");
  assert.equal(home.txHouse, "72");
  assert.equal(home.txSenate, "28");
  assert.equal(home.usHouse, "11");
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
  const born = voterProfileFromLookup({
    VUID: "11",
    FirstName: "Ada",
    MiddleName: "Augusta",
    NameSuffix: "Jr",
    Sex: "F",
    BirthYear: "1980",
    BirthMonth: "3",
    BirthDay: "15",
    DateofBirth: "19800315",
    Cell: "5125550100",
    Landline: "5125550199",
  });
  assert.equal(born.find((field) => field.label === "MiddleName").value, "Augusta");
  assert.equal(born.find((field) => field.label === "NameSuffix").value, "Jr");
  assert.equal(born.find((field) => field.label === "DateofBirth").value, "03/15/1980");
  assert.equal(voterProfileFromLookup({ DateofBirth: "1980-03-05 00:00:00.000" })[0].value, "03/05/1980");
  assert.equal(voterProfileFromLookup({ DateofBirth: "3/5/1980" })[0].value, "03/05/1980");
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

test("a ballot dated after today is not counted until that day", () => {
  const now = new Date("2026-10-05T18:00:00.000Z");
  const voters = [
    { sourceCounty: "bastrop", vuid: "1", voteDate: "2026-10-05" },
    { sourceCounty: "bastrop", vuid: "1", voteDate: "2026-11-12" },
    { sourceCounty: "bastrop", vuid: "2", voteDate: "2026-10-06" },
  ];
  const counts = rosterCountyCounts(voters, now);
  assert.equal(counts.bastrop.rows, 1);
  assert.equal(counts.bastrop.uniqueVuids, 1);
  assert.deepEqual(counts.bastrop.days.map((day) => day.date), ["2026-10-05"]);
  assert.equal(latestRosterVoteDate(voters, "bastrop", now), "2026-10-05");
});

test("a vote date of yesterday, or the day before today's pull, is current", () => {
  const now = new Date("2026-10-01T14:00:00.000Z");
  assert.equal(rosterCaughtUp("2026-09-30", null, now), true);
  assert.equal(rosterCaughtUp("2026-09-28", "2026-10-01T14:10:00.000Z", now), false);
  assert.equal(rosterCaughtUp("2026-09-30", "2026-10-01T14:10:00.000Z", now), true);
  assert.equal(rosterCaughtUp("2026-09-30", "2026-09-28T14:10:00.000Z", new Date("2026-10-02T14:00:00.000Z")), false);
});

test("outdated roster keys are trained counties that still need a pull", () => {
  const now = new Date("2026-10-01T14:00:00.000Z");
  const voters = [
    { sourceCounty: "bexar", voteDate: "2026-09-30" },
    { sourceCounty: "harris", voteDate: "2026-09-28" },
  ];
  const keys = outdatedRosterKeys({}, voters, now);
  assert.equal(keys.includes("bexar"), false);
  assert.equal(keys.includes("harris"), true);
  assert.equal(keys.includes("travis"), true);
  assert.equal(keys.includes("dallas"), false);
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

test("turning automatic pulls off drops the lineup and leaves a manual pull-all alone", () => {
  const automatic = { automatic: true, queue: ["harris", "travis"] };
  assert.equal(dropAutomaticRosterQueue(automatic, false), true);
  assert.deepEqual(automatic.queue, []);
  assert.equal(automatic.automatic, false);
  const manual = { automatic: false, queue: ["harris", "travis"] };
  assert.equal(dropAutomaticRosterQueue(manual, false), false);
  assert.deepEqual(manual.queue, ["harris", "travis"]);
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
    "2026-10-01,AB,100,2020-01-02,46.6,0.512,HARRIS,134,7,38,1,Ada Lovelace,\"100 MAIN ST, Houston, TX 77002\",REP",
  );
  assert.equal(lines[2], '2026-10-02,EV,"200, ""quoted""",,,,,,,,0,,,');
});

test("vote export is VUID, method, date, and the county where the ballot was cast", () => {
  const csv = rosterVotesToCsv([
    {
      vuid: "100",
      voteDate: "2026-10-01",
      votingMethod: "mail",
      sourceCounty: "bexar",
      county: "HARRIS",
      registeredCounty: "HARRIS",
      profile: [{ label: "CountyName", value: "HARRIS" }],
    },
    {
      vuid: '200, "quoted"',
      voteDate: "2026-10-02",
      votingMethod: "EV",
      sourceCounty: "tom_green",
      county: "TOM GREEN",
    },
    {
      vuid: "300",
      voteDate: "2026-10-03",
      votingMethod: "election day",
      county: "TRAVIS",
    },
  ]);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(lines[0], "VUID,Method,Date,County");
  assert.equal(lines[1], "100,AB,2026-10-01,Bexar");
  assert.equal(lines[2], '"200, ""quoted""",EV,2026-10-02,Tom Green');
  assert.equal(lines[3], "300,ED,2026-10-03,");
});

test("digital suppression export keeps each address column and the roster vote date", () => {
  const csv = rosterSuppressionToCsv([
    {
      vuid: "100",
      voteDate: "2026-10-01",
      profile: [
        { label: "FirstName", value: "Ada" },
        { label: "MiddleName", value: "Augusta" },
        { label: "LastName", value: "Lovelace" },
        { label: "NameSuffix", value: "Jr" },
        { label: "Sex", value: "F" },
        { label: "BirthYear", value: "1980" },
        { label: "BirthMonth", value: "03" },
        { label: "BirthDay", value: "15" },
        { label: "DateofBirth", value: "03/15/1980" },
        { label: "Cell", value: "5125550100" },
        { label: "Landline", value: "5125550199" },
        { label: "RegistrationAddr1", value: "100 MAIN ST" },
        { label: "RegHouseNum", value: "100" },
        { label: "RegStPrefix", value: "N" },
        { label: "RegStName", value: "MAIN" },
        { label: "RegStType", value: "ST" },
        { label: "RegCity", value: "Houston" },
        { label: "RegSta", value: "TX" },
        { label: "RegZip5", value: "77002" },
      ],
    },
    {
      vuid: '200, "quoted"',
      voteDate: "2026-10-02",
      profile: null,
    },
  ]);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(
    lines[0],
    "VUID,First name,Middle name,Last name,Suffix,RegistrationAddr1,RegistrationAddr2,RegHouseNum,RegHouseSfx,RegStPrefix,RegStName,RegStType,RegStPost,RegUnitType,RegUnitNumber,RegCity,RegSta,RegZip5,Date of birth,Birth day,Birth month,Birth year,Sex,Voting date,Cell,Landline",
  );
  assert.equal(
    lines[1],
    "100,Ada,Augusta,Lovelace,Jr,100 MAIN ST,,100,,N,MAIN,ST,,,,Houston,TX,77002,03/15/1980,15,03,1980,F,2026-10-01,5125550100,5125550199",
  );
  assert.equal(lines[2], '"200, ""quoted""",,,,,,,,,,,,,,,,,,,,,,,2026-10-02,,');
});
