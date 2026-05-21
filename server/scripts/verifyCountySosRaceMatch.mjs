import {
  extractContestParty,
  inferElectionPartyFromConfig,
  normalizeOfficeName,
  partiesCompatible,
  suggestSosRaceForCountyContest,
} from "../lib/countySosRaceMatch.mjs";

const SOS = [
  { id: 1, N: "ATTORNEY GENERAL", Candidates: [{ P: "REP" }, { P: "REP" }] },
  { id: 2, N: "GOVERNOR", Candidates: [{ P: "REP" }] },
  { id: 3, N: "STATE SENATOR, DISTRICT 19", Candidates: [{ P: "REP" }, { P: "REP" }] },
  { id: 4, N: "ATTORNEY GENERAL", Candidates: [{ P: "DEM" }, { P: "DEM" }] },
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const repAg = suggestSosRaceForCountyContest(SOS, "REP Attorney General (Vote For 1)", {
  electionParty: "REP",
});
assert(repAg?.race?.id === 1, `REP AG should match REP SOS AG, got id ${repAg?.race?.id}`);

const civic = suggestSosRaceForCountyContest(SOS, "Attorney General - Republican Party", {
  electionParty: "REP",
});
assert(civic?.race?.id === 1, `CivicPlus AG suffix should match REP SOS AG`);

const demOnRepBallot = suggestSosRaceForCountyContest(SOS, "DEM Attorney General (Vote For 1)", {
  electionParty: "REP",
});
assert(demOnRepBallot == null, "DEM county contest should not match DEM-only SOS race on REP election");

const sd19 = suggestSosRaceForCountyContest(SOS, "REP State Senator, District 19 (Vote For 1)", {
  electionParty: "REP",
});
assert(sd19?.race?.id === 3, `SD19 should match, got ${sd19?.race?.id}`);

assert(extractContestParty("REP Attorney General") === "REP", "REP prefix");
assert(extractContestParty("United States Senator - Republican Party") === "REP", "Republican Party suffix");
assert(normalizeOfficeName("REP Attorney General (Vote For 1)") === "ATTORNEY GENERAL", "office strip");

assert(inferElectionPartyFromConfig({ electionId: "58315", label: "2026 Republican Primary Runoff" }) === "REP");
assert(partiesCompatible("REP", null, "REP"), "unlabeled SOS race ok on REP election");
assert(!partiesCompatible("REP", "DEM", "REP"), "labeled DEM SOS race rejected for REP county");

console.log("verifyCountySosRaceMatch: all checks passed");
