import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LOOKUP_DETAIL_COLUMNS, aggregateBallotFiles, applyLiveRosterToModel, includeStaticMailInCumulative, missingColumns } from "./ballotScoreAggregate.mjs";

const lookup = `VUID,CountyName,USHouse,TXSenate,TXHouse,Score2022,Score2026
1,HARRIS,18,15,134,40,60
2,HARRIS,18,15,134,50,70
3,LOVING,23,31,74,,80
4,LOVING,23,31,74,10,
`;

const static2022 = `GeographyType,Geography,VotingDay,VotingDate,VotingDayLabel,DailyVoters,DailyVotersWith2022Score,Daily2022Average,DailyVotersWith2026Score,Daily2026Average,CumulativeVoters,CumulativeVotersWith2022Score,Cumulative2022Average,CumulativeVotersWith2026Score,Cumulative2026Average
Statewide,Texas,0,MAIL-IN,Mail-In,1000,800,0.4,900,50,NULL,NULL,NULL,NULL,NULL
Statewide,Texas,1,2022-10-24,Day 1,100,80,41.25,90,61.5,100,80,41.25,90,61.5
Statewide,Texas,7,2022-10-31,Day 7,10,8,10,9,12,999,800,55.5,400,64.4
County,Hays,1,2022-10-24,Day 1,20,15,40,12,48.2,20,15,40,12,48.2
Texas House District,45,12,2022-11-08,Election Day,5,5,50,5,51,30,28,52,27,53
Texas Senate District,25,12,2022-11-08,Election Day,5,5,50,5,51,30,28,52,27,53
Congressional District,21,12,2022-11-08,Election Day,5,5,50,5,51,30,28,52,27,53
Nope,Nowhere,1,2022-10-24,Day 1,1,1,1,1,1,1,1,1,1,1
`;

const roster = `VUID,VoteDate
1,2026-10-18
3,10/25/2026
9,2026-10-19
1,2026-10-20
`;

async function writeSet(dir) {
  await writeFile(path.join(dir, "lookup.csv"), lookup);
  await writeFile(path.join(dir, "static2022.csv"), static2022);
  await writeFile(path.join(dir, "roster2026.csv"), roster);
}

function day(model, scope, id) {
  return scope.byDay[String(id)];
}

test("aggregates voter-level daily and cumulative scores", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ballot-ev-"));
  try {
    await writeSet(dir);
    const { datasets, model } = await aggregateBallotFiles({
      files: {
        lookup: path.join(dir, "lookup.csv"),
        static2022: path.join(dir, "static2022.csv"),
        roster2026: path.join(dir, "roster2026.csv"),
      },
      uploads: {},
    });

    assert.equal(datasets.lookup.uniqueVuids, 4);
    assert.equal(datasets.lookup.withScore2026, 3);
    assert.equal(datasets.lookup.withScore2022, 3);
    assert.equal(datasets.roster2026.uniqueVuids, 3);
    assert.equal(datasets.roster2026.duplicatesMerged, 1);
    assert.equal(datasets.roster2026.withScore2026, 2);
    assert.equal(model.rosterJoin.unmatched, 1);
    assert.equal(model.rosterMode, "replace");

    assert.equal(model.statewide.allCurrent.voters, 4);
    assert.equal(model.statewide.allCurrent.score2026.avg, 70);
    assert.equal(model.statewide.allCurrent.score2026.n, 3);
    assert.equal(model.statewide.allCurrent.score2022.n, 3);

    assert.equal(datasets.static2022.rows, 7);
    assert.equal(datasets.static2022.rejected, 1);
    assert.equal(datasets.static2022.geographies, 5);
    assert.equal(datasets.static2022.votingDays, 4);
    assert.equal(datasets.static2022.statewideRows, 3);
    assert.equal(datasets.static2022.countyRows, 1);
    assert.equal(datasets.static2022.houseRows, 1);
    assert.equal(datasets.static2022.senateRows, 1);
    assert.equal(datasets.static2022.congressRows, 1);

    const y2022Day1 = day(model, model.statewide, 1).y2022;
    assert.equal(y2022Day1.daily.voters, 100);
    assert.equal(y2022Day1.daily.score2026.avg, 61.5);
    assert.equal(y2022Day1.daily.score2026.n, 90);
    assert.equal(y2022Day1.cumulative.score2022.avg, 41.25);
    assert.equal(y2022Day1.cumulative.score2022.n, 80);

    const y2022Day7 = day(model, model.statewide, 7).y2022;
    assert.equal(y2022Day7.daily.voters, 10);
    assert.equal(y2022Day7.cumulative.voters, 999);
    assert.equal(y2022Day7.cumulative.score2022.avg, 55.5);
    assert.equal(y2022Day7.cumulative.score2026.avg, 64.4);
    assert.equal(y2022Day7.cumulative.score2026.n, 400);
    assert.equal(day(model, model.statewide, 6).y2022.daily.voters, 0);

    const hays = model.groups.county.find((row) => row.key === "HAYS");
    assert.equal(day(model, hays, 1).y2022.cumulative.score2026.avg, 48.2);
    assert.equal(day(model, hays, 1).y2022.cumulative.score2026.n, 12);
    assert.equal(day(model, model.groups.house.find((row) => row.key === "45"), 12).y2022.cumulative.score2026.avg, 53);
    assert.equal(day(model, model.groups.senate.find((row) => row.key === "25"), 12).y2022.cumulative.score2022.n, 28);
    assert.equal(day(model, model.groups.congress.find((row) => row.key === "21"), 12).y2022.cumulative.voters, 30);

    const y2022Mail = model.statewide.byDay["0"].y2022;
    assert.equal(y2022Mail.daily.voters, 1000);
    assert.equal(y2022Mail.daily.score2026.avg, 50);
    assert.equal(y2022Mail.cumulative.voters, 1000);
    assert.equal(y2022Mail.cumulative.score2026.avg, 50);

    const y2026Mail = model.statewide.byDay["0"].y2026;
    assert.equal(y2026Mail.daily.voters, 1);
    assert.equal(y2026Mail.daily.score2026.avg, 60);
    assert.equal(y2026Mail.cumulative.score2022.avg, 40);

    const y2026Day1 = day(model, model.statewide, 1).y2026;
    assert.equal(y2026Day1.daily.voters, 1);
    assert.equal(y2026Day1.cumulative.voters, 2);
    assert.equal(y2026Day1.cumulative.score2026.avg, 60);
    assert.equal(y2026Day1.cumulative.score2022.avg, 40);

    const y2026Day7 = day(model, model.statewide, 7).y2026.cumulative;
    assert.equal(y2026Day7.voters, 3);
    assert.equal(y2026Day7.score2026.avg, 70);
    assert.equal(y2026Day7.score2026.n, 2);
    assert.equal(y2026Day7.score2022.avg, 40);

    const harris = model.groups.county.find((row) => row.key === "HARRIS");
    assert.equal(harris.allCurrent.score2026.avg, 65);
    assert.equal(harris.byDay["0"].y2026.cumulative.score2026.avg, 60);
    assert.equal(day(model, harris, 1).y2026.daily.voters, 0);
    assert.equal(day(model, harris, 1).y2026.cumulative.voters, 1);
    assert.equal(day(model, harris, 7).y2026.cumulative.score2026.avg, 60);
    const loving = model.groups.county.find((row) => row.key === "LOVING");
    assert.equal(day(model, loving, 7).y2026.cumulative.score2026.avg, 80);
    assert.equal(model.groups.house.find((row) => row.key === "134").allCurrent.score2026.n, 2);

    includeStaticMailInCumulative(model);
    const withMail = day(model, model.statewide, 1).y2022;
    assert.equal(withMail.daily.voters, 100);
    assert.equal(withMail.cumulative.voters, 1100);
    assert.equal(withMail.cumulative.score2026.n, 990);
    assert.equal(withMail.cumulative.score2026.avg, 51.0455);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mail ballots count together as voting day 0", () => {
  const model = {
    statewide: {
      key: "TX",
      label: "Texas",
      allCurrent: { voters: 4, score2022: { n: 1, sum: 1, avg: 1 }, score2026: { n: 1, sum: 50, avg: 50 } },
      byDay: {
        1: {
          y2022: { daily: { voters: 100, score2022: { n: 80, sum: 0, avg: 0.4 }, score2026: { n: 90, sum: 0, avg: 61.5 } }, cumulative: { voters: 100, score2022: { n: 80, sum: 0, avg: 0.4 }, score2026: { n: 90, sum: 0, avg: 61.5 } } },
          y2026: { daily: { voters: 9, score2022: { n: 9, sum: 0, avg: 1 }, score2026: { n: 9, sum: 0, avg: 9 } }, cumulative: { voters: 9, score2022: { n: 9, sum: 0, avg: 1 }, score2026: { n: 9, sum: 0, avg: 9 } } },
        },
      },
    },
    groups: {
      county: [{ key: "TRAVIS", label: "Travis", allCurrent: { voters: 0, score2022: { n: 0, sum: 0, avg: null }, score2026: { n: 0, sum: 0, avg: null } }, byDay: {} }],
      house: [],
      senate: [],
      congress: [],
    },
  };
  applyLiveRosterToModel(model, [
    { vuid: "10", voteDate: "2026-09-22", matched: 1, county: "TRAVIS", usHouse: "10", txSenate: "25", txHouse: "19", score2022: 0.5, score2026: 80 },
    { vuid: "10", voteDate: "2026-10-20", matched: 1, county: "TRAVIS", usHouse: "10", txSenate: "25", txHouse: "19", score2022: 0.5, score2026: 80 },
    { vuid: "11", voteDate: "2026-09-28", matched: 1, county: "TRAVIS", usHouse: "37", txSenate: "14", txHouse: "49", score2022: null, score2026: 60 },
    { vuid: "12", voteDate: "2026-09-23", matched: 0 },
    { vuid: "13", voteDate: "2026-10-20", votingMethod: "AB", matched: 1, county: "TRAVIS", usHouse: "10", txSenate: "25", txHouse: "19", score2022: 0.2, score2026: 40 },
    { vuid: "14", voteDate: "2026-10-20", votingMethod: "EV", matched: 1, county: "TRAVIS", usHouse: "10", txSenate: "25", txHouse: "19", score2022: 0.4, score2026: 50 },
  ]);
  const mail = model.statewide.byDay["0"].y2026;
  assert.equal(mail.daily.voters, 4);
  assert.equal(mail.daily.score2026.n, 3);
  assert.equal(mail.daily.score2026.avg, 60);
  assert.equal(mail.daily.score2022.n, 2);
  assert.equal(mail.daily.score2022.avg, 0.35);
  assert.equal(mail.cumulative.voters, 4);
  assert.equal(mail.cumulative.score2026.avg, 60);
  const day1 = model.statewide.byDay["1"].y2026;
  assert.equal(day1.daily.voters, 0);
  assert.equal(day1.cumulative.voters, 3);
  assert.equal(day1.cumulative.score2026.n, 2);
  assert.equal(day1.cumulative.score2026.avg, 70);
  const day2 = model.statewide.byDay["2"].y2026;
  assert.equal(day2.daily.voters, 1);
  assert.equal(day2.daily.score2026.avg, 50);
  assert.equal(day2.cumulative.voters, 5);
  assert.equal(day2.cumulative.score2026.avg, 57.5);
  assert.equal(model.statewide.byDay["1"].y2022.daily.voters, 100);
  assert.equal(model.statewide.byDay["1"].y2022.daily.score2026.avg, 61.5);
  const travis = model.groups.county.find((row) => row.key === "TRAVIS");
  assert.equal(travis.byDay["0"].y2026.cumulative.voters, 3);
  assert.equal(travis.byDay["0"].y2026.cumulative.score2026.avg, 60);
  assert.equal(travis.byDay["1"].y2026.cumulative.voters, 2);
  assert.equal(travis.byDay["2"].y2026.cumulative.voters, 4);
  assert.equal(model.groups.house.find((row) => row.key === "19").byDay["0"].y2026.daily.voters, 2);
  assert.equal(model.rosterJoin.unmatched, 1);
});

test("keeps name, registration date, and address columns on the voter model lookup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ballot-ev-wide-"));
  const header = ["VUID", "CountyName", "USHouse", "TXSenate", "TXHouse", ...LOOKUP_DETAIL_COLUMNS, "Score2022", "Score2026"];
  const lookup = [
    header.join(","),
    '1000000045,LUBBOCK,19,28,83,JANE,DOE,2012-01-15 00:00:00.000,"100 MAIN ST, APT 2",,100,,N,MAIN,ST,,APT,2,LUBBOCK,TX,79401,0.710397,65.000000',
  ].join("\n");
  try {
    await writeFile(path.join(dir, "lookup.csv"), lookup);
    const probe = Object.fromEntries(header.map((name) => [name, ""]));
    assert.deepEqual(missingColumns(probe, "lookup"), []);
    const { datasets, model } = await aggregateBallotFiles({
      files: { lookup: path.join(dir, "lookup.csv"), static2022: null, roster2026: null },
      uploads: {},
    });
    assert.equal(datasets.lookup.validation, "valid");
    assert.equal(datasets.lookup.rows, 1);
    assert.equal(datasets.lookup.rejected, 0);
    assert.equal(datasets.lookup.withScore2022, 1);
    assert.equal(datasets.lookup.withScore2026, 1);
    assert.deepEqual(datasets.lookup.detailColumns, LOOKUP_DETAIL_COLUMNS);
    assert.equal(model.statewide.allCurrent.voters, 1);
    assert.equal(model.statewide.allCurrent.score2026.avg, 65);
    assert.equal(model.groups.county[0].key, "LUBBOCK");
    assert.equal(model.groups.house[0].key, "83");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
