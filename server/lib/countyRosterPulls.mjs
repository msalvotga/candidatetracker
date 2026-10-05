import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import JSZip from "jszip";
import { datasetPath } from "./ballotScoreEv.mjs";
import { bexarRosterDocuments, bexarRosterFilesToPull, BEXAR_FOLDER_ID, BEXAR_ROSTER_PAGE, parseBexarAbbmPdf } from "./bexarRoster.mjs";
import { harrisBbmRosterLink, harrisRosterFrame, HARRIS_ROSTER_PAGE, parseHarrisBbmCsv } from "./harrisRoster.mjs";
import { parsePotterRosterPdf, potterRosterLinks, POTTER_ROSTER_PAGE } from "./potterRoster.mjs";
import { parseTarrantRosterZip, tarrantRosterLinks, TARRANT_ROSTER_PAGE } from "./tarrantRoster.mjs";
import { parseWiseRosterPdf, wiseMailRosterLink, WISE_ROSTER_PAGE } from "./wiseRoster.mjs";
import {
  GALVESTON_FETCH_HEADERS,
  GALVESTON_ROSTER_PAGE,
  galvestonMailRosterLinks,
  galvestonRosterFilesToPull,
  parseGalvestonMailCsv,
} from "./galvestonRoster.mjs";
import { parseTravisRosterZip } from "./travisEvRosterParse.mjs";
import { readRosterDocument, writeRosterDocument } from "./countyRosterDocuments.mjs";
import { openRosterRawArchive, rosterRawFileName } from "./rosterRawArchive.mjs";
import { openLookupCsvStream } from "./ballotLookupStore.mjs";
import { ELLIS_ROSTER_PAGE, ellisMailRosterLink, parseEllisRosterZip } from "./ellisRoster.mjs";
import {
  MONTGOMERY_ROSTER_PAGE,
  montgomeryFetch,
  montgomeryRosterFilesToPull,
  montgomeryRosterLinks,
  parseMontgomeryRosterZip,
} from "./montgomeryRoster.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "../data/county-rosters");
const STATUS_PATH = path.join(DATA_DIR, "status.json");
const VOTERS_PATH = path.join(DATA_DIR, "voters.json");

const TRAVIS_HUB = "https://votetravis.gov/current-election-information/current-election/";
const TRAVIS_G26_ROSTER_ZIP_URL = "https://votetravis.gov/wp-content/uploads/G26-Voter-Rosters.zip";

export const COUNTY_ROSTER_PROFILES = {
  travis: {
    key: "travis",
    label: "Travis County",
    trained: true,
    fileKinds: "General-election ZIP",
    notes:
      "One Excel file per day a ballot was received. The vote date comes from the file name. Each row has a VUID, name, and precinct. The table starts on row 4.",
    sourcePage: TRAVIS_HUB,
  },
  harris: {
    key: "harris",
    label: "Harris County",
    trained: true,
    fileKinds: "Cumulative ZIP",
    notes:
      "Each pull reads the election rosters page and takes the November 3, 2026 Unofficial BBM Roster. The link changes daily. The ZIP holds one cumulative CSV. Column E is the state VUID and column H is the vote date. A row with no state VUID is skipped until a later file includes it.",
    sourcePage: HARRIS_ROSTER_PAGE,
  },
  bexar: {
    key: "bexar",
    label: "Bexar County",
    trained: true,
    fileKinds: "Daily roster PDFs",
    notes:
      "Each file in the November 3, 2026 document folder is one day of voting or one day of incoming mail. The date is in the file name. A pull reads the newest file, plus any earlier day that does not already have voters. The VUID is the first column. The date column is labeled Ballot Received Date or Received Date.",
    sourcePage: BEXAR_ROSTER_PAGE,
  },
  potter: {
    key: "potter",
    label: "Potter County",
    trained: true,
    fileKinds: "Roster PDFs",
    notes:
      "Each pull reads the voting rosters page and takes the Mail Ballot Roster PDF. The file address changes. The VUID and the Ballot Status Date are on each row. When the early voting roster link is posted, that PDF is read the same way.",
    sourcePage: POTTER_ROSTER_PAGE,
  },
  tarrant: {
    key: "tarrant",
    label: "Tarrant County",
    trained: true,
    fileKinds: "Tab-delimited ZIP",
    notes:
      "Each pull reads the November 3, 2026 results page and takes the Ballot by Mail and In Person during Early Voting zip files. The text file inside is tab-separated. SOS Voter ID is the VUID and Return Date is the vote date. The early-voting file is skipped until that roster is posted.",
    sourcePage: TARRANT_ROSTER_PAGE,
  },
  wise: {
    key: "wise",
    label: "Wise County",
    trained: true,
    fileKinds: "Mail roster PDF",
    notes:
      "Each pull reads the Elections page and takes the newest Roster of Early Voting By Mail for the November 3, 2026 election. The link says received as of a date, and that date changes. The PDF has a VUID Number column and a Date column.",
    sourcePage: WISE_ROSTER_PAGE,
  },
  galveston: {
    key: "galveston",
    label: "Galveston County",
    trained: true,
    fileKinds: "Daily mail CSVs",
    notes:
      "Each pull reads the current elections page and takes the CSV files under Mail Ballot Rosters. The date beside each link is the day of ballots. A pull reads the newest day, plus any earlier day that does not already have voters. VUID and Ballot Received Date are the voter id and the vote date.",
    sourcePage: GALVESTON_ROSTER_PAGE,
  },
  montgomery: {
    key: "montgomery",
    label: "Montgomery County",
    trained: true,
    fileKinds: "Daily roster ZIPs",
    notes:
      "Each pull reads the early voting roster page for the November 3, 2026 joint election. Early voting and mail are in the same daily zip. The CSV has a VUID, and the vote date is in the file name. A person is listed once per race, so each VUID is kept once per day. A pull reads the newest day, plus any earlier day that does not already have voters.",
    sourcePage: MONTGOMERY_ROSTER_PAGE,
  },
  ellis: {
    key: "ellis",
    label: "Ellis County",
    trained: true,
    fileKinds: "Cumulative mail ZIP",
    notes:
      "Each pull reads the Upcoming Elections page and takes the Returned Ballots by Mail Roster Report. The link changes when the file is replaced. The zip holds one cumulative Excel file. Rows have a VUID and no vote date. The first time a VUID appears, it is stored with the date in cell C2. A VUID already stored for Ellis is left as it is.",
    sourcePage: ELLIS_ROSTER_PAGE,
  },
};

const ROSTER_PULL_GATE = "__enrRosterPullGate";

function rosterGate() {
  if (!globalThis[ROSTER_PULL_GATE]) {
    globalThis[ROSTER_PULL_GATE] = { active: null, queue: [], lock: false };
  }
  return globalThis[ROSTER_PULL_GATE];
}

function emptyCountyStatus(key) {
  return {
    countyKey: key,
    status: "idle",
    pulledAt: null,
    sourceUrl: null,
    rows: 0,
    uniqueVuids: 0,
    fileCount: 0,
    days: [],
    earlyInPerson: 0,
    mail: 0,
    other: 0,
    skippedMissingVuid: 0,
    skippedMissingVuidDays: [],
    error: null,
    autoCheckedAt: null,
  };
}

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJsonFile(filePath, value) {
  await ensureDir();
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await copyFile(tmp, filePath);
  await rm(tmp, { force: true });
}

async function readStore() {
  const saved = await readRosterDocument("status");
  if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
  const file = await readJsonFile(STATUS_PATH);
  if (file && typeof file === "object") {
    await writeRosterDocument("status", file);
    return file;
  }
  return { updatedAt: null, counties: {} };
}

async function writeStore(store) {
  await writeRosterDocument("status", store);
  await writeJsonFile(STATUS_PATH, store);
}

export function summarizeRosterRows(rows) {
  const vuids = new Set();
  const byDay = new Map();
  let earlyInPerson = 0;
  let mail = 0;
  let other = 0;
  for (const row of rows) {
    const vuid = String(row.vuid ?? "").trim();
    if (vuid) vuids.add(vuid);
    const method = String(row.votingMethod ?? "").toUpperCase();
    if (method === "EV") earlyInPerson += 1;
    else if (method === "AB") mail += 1;
    else other += 1;
    const date = String(row.activityDate ?? "").trim() || "Unknown";
    const day = byDay.get(date) ?? { date, voters: 0, earlyInPerson: 0, mail: 0 };
    day.voters += 1;
    if (method === "EV") day.earlyInPerson += 1;
    if (method === "AB") day.mail += 1;
    byDay.set(date, day);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    rows: rows.length,
    uniqueVuids: vuids.size,
    days,
    earlyInPerson,
    mail,
    other,
  };
}

function voterKey(vuid, voteDate) {
  return `${vuid}|${voteDate}`;
}

/** CSV method: abb mail/absentee, ev early in person, ed election day. */
export function rosterMethodCode(raw) {
  const text = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ");
  if (!text || text === "OTHER") return "";
  if (text === "AB" || text === "ABB" || text === "BBM" || text === "MAIL" || text === "ABSENTEE" || text === "BALLOT BY MAIL") return "abb";
  if (text === "ED" || text === "ELECTION DAY") return "ed";
  if (text === "EV" || text === "EARLY" || text === "EARLY VOTING" || text === "IN PERSON") return "ev";
  return "";
}

function storedVotingMethod(raw) {
  const code = rosterMethodCode(raw);
  if (code === "abb") return "AB";
  if (code === "ev") return "EV";
  if (code === "ed") return "ED";
  return "";
}

const MAIL_ONLY_ROSTER_COUNTIES = new Set(["harris", "ellis", "galveston", "wise"]);

function blankVoter(vuid, voteDate, sourceCounty) {
  return {
    vuid,
    voteDate,
    sourceCounty,
    votingMethod: null,
    matched: 0,
    county: null,
    txHouse: null,
    txSenate: null,
    usHouse: null,
    score2022: null,
    score2026: null,
    registrationDate: null,
    profile: null,
  };
}

const LOOKUP_MODEL_KEYS = new Set(["vuid", "countyname", "ushouse", "txsenate", "txhouse", "score2022", "score2026"]);
const REGISTRATION_ALIASES = new Set([
  "registrationdate",
  "registrationdateofvoter",
  "regdate",
  "dateofregistration",
  "effectivedateofregistration",
  "voterregistrationdate",
]);

function compactHeader(label) {
  return String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function voterProfileFromLookup(row) {
  const fields = [];
  for (const [key, value] of Object.entries(row)) {
    const label = String(key).trim();
    if (!label || LOOKUP_MODEL_KEYS.has(compactHeader(label))) continue;
    const text = String(value ?? "").trim();
    if (!text || /^null$/i.test(text)) continue;
    fields.push({ label, value: text });
  }
  return fields;
}

export function registrationDateFromProfile(fields) {
  const hit = (fields ?? []).find((field) => REGISTRATION_ALIASES.has(compactHeader(field.label)));
  return hit ? normalizeRosterDate(hit.value) : null;
}

function normalizeRosterDate(raw) {
  const text = String(raw ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return text || null;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const CSV_NAME_ALIASES = ["name", "fullname", "votername"];
const CSV_IDENTITY_ALIASES = new Set([
  ...CSV_NAME_ALIASES,
  "firstname",
  "first",
  "middlename",
  "middle",
  "lastname",
  "last",
  "suffix",
  "residenceaddress",
  "residentialaddress",
  "address",
  "streetaddress",
  "voteraddress",
  "residencecity",
  "city",
  "votercity",
  "residencestate",
  "state",
  "residencezip",
  "zip",
  "zipcode",
  "voterzip",
  "registrationdate",
  "registrationdateofvoter",
  "regdate",
  "dateofregistration",
  "effectivedateofregistration",
  "voterregistrationdate",
  "registrationaddr1",
  "registrationaddr2",
  "reghousenum",
  "reghousesfx",
  "regstprefix",
  "regstname",
  "regsttype",
  "regstpost",
  "regunittype",
  "regunitnumber",
  "regcity",
  "regsta",
  "regzip5",
]);

function profileField(fields, aliases) {
  return fields.find((field) => aliases.includes(compactHeader(field.label)))?.value ?? "";
}

function csvVoterName(fields) {
  const full = profileField(fields, CSV_NAME_ALIASES);
  if (full) return full;
  return [
    profileField(fields, ["firstname", "first"]),
    profileField(fields, ["middlename", "middle"]),
    profileField(fields, ["lastname", "last"]),
    profileField(fields, ["suffix"]),
  ]
    .filter(Boolean)
    .join(" ");
}

function csvVoterAddress(fields) {
  const line1 = profileField(fields, [
    "registrationaddr1",
    "residenceaddress",
    "residentialaddress",
    "address",
    "streetaddress",
    "voteraddress",
  ]);
  const line2 = profileField(fields, ["registrationaddr2"]);
  const unit = [profileField(fields, ["regunittype"]), profileField(fields, ["regunitnumber"])].filter(Boolean).join(" ");
  const composed = [
    profileField(fields, ["reghousenum"]),
    profileField(fields, ["reghousesfx"]),
    profileField(fields, ["regstprefix"]),
    profileField(fields, ["regstname"]),
    profileField(fields, ["regsttype"]),
    profileField(fields, ["regstpost"]),
    unit,
  ]
    .filter(Boolean)
    .join(" ");
  const street = line1 ? [line1, line2].filter(Boolean) : [composed, line2].filter(Boolean);
  const city = profileField(fields, ["regcity", "residencecity", "city", "votercity"]);
  const state = profileField(fields, ["regsta", "residencestate", "state"]);
  const zip = profileField(fields, ["regzip5", "residencezip", "zip", "zipcode", "voterzip"]);
  const cityLine = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [...street, cityLine].filter(Boolean).join(", ");
}

function csvScore(value) {
  return value == null || !Number.isFinite(Number(value)) ? "" : String(value);
}

/** Columns match the Voted table, then name, address, and any other voter-file fields. */
export function rosterVotersToCsv(voters) {
  const extraLabels = [];
  const seen = new Set();
  for (const row of voters ?? []) {
    for (const field of row.profile ?? []) {
      const label = String(field.label ?? "").trim();
      if (!label || CSV_IDENTITY_ALIASES.has(compactHeader(label)) || seen.has(label)) continue;
      seen.add(label);
      extraLabels.push(label);
    }
  }
  extraLabels.sort((a, b) => a.localeCompare(b, "en"));
  const header = [
    "Vote date",
    "Method",
    "VUID",
    "Registration date",
    "2026 model",
    "2022 model",
    "County",
    "State House",
    "State Senate",
    "Congress",
    "Matched",
    "Name",
    "Address",
    ...extraLabels,
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of voters ?? []) {
    const fields = Array.isArray(row.profile) ? row.profile : [];
    const extras = new Map(fields.map((field) => [String(field.label ?? "").trim(), field.value]));
    const cells = [
      row.voteDate ?? "",
      rosterMethodCode(row.votingMethod),
      row.vuid ?? "",
      row.registrationDate ?? "",
      csvScore(row.score2026),
      csvScore(row.score2022),
      row.county ?? "",
      row.txHouse ?? "",
      row.txSenate ?? "",
      row.usHouse ?? "",
      row.matched === 1 ? "1" : "0",
      csvVoterName(fields),
      csvVoterAddress(fields),
      ...extraLabels.map((label) => extras.get(label) ?? ""),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

export async function rosterVotersCsv({ sort = "voteDate", dir = "asc" } = {}) {
  const voters = sortRosterVoters(await readVoters(), sort === "registrationDate" ? "registrationDate" : "voteDate", dir);
  return rosterVotersToCsv(voters);
}

export function sortRosterVoters(voters, sort = "voteDate", dir = "asc") {
  const sign = dir === "desc" ? -1 : 1;
  const tie = (a, b) => a.voteDate.localeCompare(b.voteDate) || a.vuid.localeCompare(b.vuid, undefined, { numeric: true });
  return [...voters].sort((a, b) => {
    if (sort === "registrationDate") {
      const av = a.registrationDate || null;
      const bv = b.registrationDate || null;
      if (!av && !bv) return tie(a, b);
      if (!av) return 1;
      if (!bv) return -1;
      if (av !== bv) return av.localeCompare(bv) * sign;
      return tie(a, b);
    }
    const date = a.voteDate.localeCompare(b.voteDate);
    if (date) return date * sign;
    return a.vuid.localeCompare(b.vuid, undefined, { numeric: true });
  });
}

function countyToken(raw) {
  const text = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return text || null;
}

/** The ballot county is the roster county. Districts stay only when the voter roll county matches. */
export function tieVoteToCounty(row) {
  const voted = countyToken(row.sourceCounty);
  if (!row.registeredCounty && row.county) row.registeredCounty = String(row.county).trim();
  const registered = countyToken(row.registeredCounty);
  const same = Boolean(voted && registered && voted === registered);
  if (voted) row.county = same && row.registeredCounty ? String(row.registeredCounty).trim().toUpperCase() : voted;
  if (row.matched === 1 && registered && !same) {
    row.txHouse = null;
    row.txSenate = null;
    row.usHouse = null;
  }
  return row;
}

function copyMatch(target, source) {
  target.matched = 1;
  target.registeredCounty = source.registeredCounty ?? source.county ?? null;
  target.txHouse = source.txHouse ?? null;
  target.txSenate = source.txSenate ?? null;
  target.usHouse = source.usHouse ?? null;
  target.score2022 = source.score2022 ?? null;
  target.score2026 = source.score2026 ?? null;
  target.registrationDate = source.registrationDate ?? null;
  target.profile = source.profile ?? null;
  tieVoteToCounty(target);
}

export function mergeRosterRecords(existing, incoming, sourceCounty) {
  const byKey = new Map(existing.map((row) => [voterKey(row.vuid, row.voteDate), row]));
  const known = new Map();
  for (const row of existing) {
    if (row.matched === 1) known.set(row.vuid, row);
  }
  let added = 0;
  for (const raw of incoming) {
    const vuid = String(raw.vuid ?? "").trim();
    const voteDate = String(raw.activityDate ?? raw.voteDate ?? "").trim();
    if (!vuid || !voteDate) continue;
    const key = voterKey(vuid, voteDate);
    const method = storedVotingMethod(raw.votingMethod);
    if (byKey.has(key)) {
      const existing = byKey.get(key);
      if (method && !existing.votingMethod) existing.votingMethod = method;
      continue;
    }
    const row = blankVoter(vuid, voteDate, sourceCounty);
    if (method) row.votingMethod = method;
    const prior = known.get(vuid);
    if (prior) copyMatch(row, prior);
    byKey.set(key, row);
    added += 1;
  }
  const voters = [...byKey.values()];
  const unmatchedVuids = [...new Set(voters.filter((row) => row.matched !== 1).map((row) => row.vuid))];
  return { voters, added, unmatchedVuids };
}

function lookupField(row, name) {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (String(key).trim().toLowerCase() === want) return value;
  }
  return "";
}

function normDistrict(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return null;
  const n = Number(text.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.trunc(n));
}

function parseModelScore(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function vuidId(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return "";
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

async function matchLookupVuids(need) {
  const hits = new Map();
  if (!need.size) return hits;
  let input;
  try {
    input = await openLookupCsvStream();
  } catch {
    return hits;
  }
  const wanted = new Set([...need].map(vuidId));
  await new Promise((resolve, reject) => {
    const parser = input.pipe(
      parse({ columns: true, bom: true, relax_quotes: true, relax_column_count: true }),
    );
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    parser.on("data", (row) => {
      const vuid = vuidId(lookupField(row, "VUID"));
      if (!vuid || !wanted.has(vuid) || hits.has(vuid)) return;
      const profile = voterProfileFromLookup(row);
      hits.set(vuid, {
        county: String(lookupField(row, "CountyName") ?? "").trim() || null,
        usHouse: normDistrict(lookupField(row, "USHouse")),
        txSenate: normDistrict(lookupField(row, "TXSenate")),
        txHouse: normDistrict(lookupField(row, "TXHouse")),
        score2022: parseModelScore(lookupField(row, "Score2022")),
        score2026: parseModelScore(lookupField(row, "Score2026")),
        registrationDate: registrationDateFromProfile(profile),
        profile,
      });
      if (hits.size === wanted.size) parser.destroy();
    });
    parser.on("end", finish);
    parser.on("close", finish);
    parser.on("error", (error) => {
      if (hits.size === wanted.size || error?.code === "ERR_STREAM_PREMATURE_CLOSE") finish();
      else if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
  return hits;
}

export async function readRosterVoterRows() {
  return readVoters();
}

async function readVoters() {
  const saved = await readRosterDocument("voters");
  const rows = Array.isArray(saved) ? saved : await readJsonFile(VOTERS_PATH);
  if (!Array.isArray(rows)) return [];
  if (!Array.isArray(saved)) await writeRosterDocument("voters", rows);
  let changed = false;
  for (const row of rows) {
    const before = JSON.stringify(row);
    tieVoteToCounty(row);
    if (!row.votingMethod && MAIL_ONLY_ROSTER_COUNTIES.has(String(row.sourceCounty ?? "").toLowerCase())) {
      row.votingMethod = "AB";
    }
    if (JSON.stringify(row) !== before) changed = true;
  }
  if (changed) await writeVoters(rows);
  return rows;
}

function countyDatesWithMethod(voters, countyKey) {
  const key = String(countyKey).toLowerCase();
  const complete = new Set();
  const incomplete = new Set();
  for (const row of voters ?? []) {
    if (String(row.sourceCounty ?? "").toLowerCase() !== key) continue;
    const date = String(row.voteDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (row.votingMethod) complete.add(date);
    else incomplete.add(date);
  }
  for (const date of incomplete) complete.delete(date);
  return complete;
}

async function writeVoters(voters) {
  await writeRosterDocument("voters", voters);
  await writeJsonFile(VOTERS_PATH, voters);
}

async function saveRosterRows(incoming, sourceCounty) {
  const existing = await readVoters();
  const merged = mergeRosterRecords(existing, incoming, sourceCounty);
  const started = Date.now();
  if (merged.unmatchedVuids.length) {
    console.log(`Matching ${merged.unmatchedVuids.length} roster VUIDs against the voter file`);
  } else {
    console.log("Roster VUIDs are already matched; skipping the voter file");
  }
  const hits = await matchLookupVuids(new Set(merged.unmatchedVuids));
  if (merged.unmatchedVuids.length) {
    console.log(`Voter file match finished in ${Date.now() - started}ms (${hits.size} found)`);
  }
  for (const row of merged.voters) {
    if (row.matched === 1) continue;
    const hit = hits.get(vuidId(row.vuid));
    if (!hit) continue;
    copyMatch(row, hit);
  }
  await writeVoters(merged.voters);
  const matched = merged.voters.filter((row) => row.matched === 1).length;
  return {
    matched,
    unmatched: merged.voters.length - matched,
    added: merged.added,
    lookupChecked: merged.unmatchedVuids.length,
  };
}

export function rosterCountyCounts(voters) {
  const by = new Map();
  for (const row of voters ?? []) {
    const key = String(row.sourceCounty ?? "").trim().toLowerCase();
    if (!key) continue;
    let bucket = by.get(key);
    if (!bucket) {
      bucket = { rows: 0, vuids: new Set(), missingVuid: 0, days: new Map() };
      by.set(key, bucket);
    }
    bucket.rows += 1;
    const vuid = String(row.vuid ?? "").trim();
    if (vuid) bucket.vuids.add(vuid);
    const date = String(row.voteDate ?? "").trim() || "Unknown";
    let day = bucket.days.get(date);
    if (!day) {
      day = { date, voters: 0, missingVuid: 0 };
      bucket.days.set(date, day);
    }
    day.voters += 1;
    if (!vuid) {
      day.missingVuid += 1;
      bucket.missingVuid += 1;
    }
  }
  const counts = {};
  for (const [key, bucket] of by) {
    counts[key] = {
      rows: bucket.rows,
      uniqueVuids: bucket.vuids.size,
      missingVuid: bucket.missingVuid,
      days: [...bucket.days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
  return counts;
}

function rosterTotals(voters) {
  const vuids = new Set(voters.map((row) => row.vuid));
  const matched = voters.filter((row) => row.matched === 1).length;
  return {
    total: voters.length,
    uniqueVuids: vuids.size,
    matched,
    unmatched: voters.length - matched,
  };
}

const PROFILE_STAMP_PATH = path.join(DATA_DIR, "lookup-profile.json");
let profileEnriching = false;

function lookupHeaderNames(headerLine) {
  return String(headerLine ?? "")
    .replace(/^\uFEFF/, "")
    .split(",")
    .map((name) => compactHeader(name.replace(/^"|"$/g, "")));
}

async function readLookupHeader(filePath) {
  let stamp = "database";
  try {
    const file = await stat(filePath);
    stamp = `${file.mtimeMs}:${file.size}`;
  } catch {
    stamp = "database";
  }
  const stream = await openLookupCsvStream();
  const header = await new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    stream.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl));
    });
    stream.on("end", () => finish(buf));
    stream.on("error", (error) => {
      if (settled || error?.code === "ERR_STREAM_PREMATURE_CLOSE") return;
      settled = true;
      reject(error);
    });
  });
  return { stamp, header };
}

async function readProfileStamp() {
  const saved = await readRosterDocument("lookup-profile");
  if (saved && typeof saved === "object" && saved.stamp) return String(saved.stamp);
  const file = await readJsonFile(PROFILE_STAMP_PATH);
  if (file?.stamp) {
    await writeRosterDocument("lookup-profile", { stamp: file.stamp });
    return String(file.stamp);
  }
  return "";
}

async function writeProfileStamp(stamp) {
  const payload = { stamp };
  await writeRosterDocument("lookup-profile", payload);
  await writeJsonFile(PROFILE_STAMP_PATH, payload);
}

async function enrichMatchedRosterProfiles() {
  const gate = rosterGate();
  if (gate.active || gate.lock || gate.queue.length) return;
  const filePath = datasetPath("lookup");
  let lookup;
  try {
    lookup = await readLookupHeader(filePath);
  } catch {
    return;
  }
  if ((await readProfileStamp()) === lookup.stamp) return;
  const names = lookupHeaderNames(lookup.header);
  if (!names.some((name) => name && !LOOKUP_MODEL_KEYS.has(name))) {
    await writeProfileStamp(lookup.stamp);
    return;
  }
  const voters = await readVoters();
  const need = new Set(voters.filter((row) => row.matched === 1).map((row) => vuidId(row.vuid)));
  const hits = await matchLookupVuids(need);
  if (rosterGate().active || rosterGate().lock) return;
  for (const row of voters) {
    if (row.matched !== 1) continue;
    const hit = hits.get(vuidId(row.vuid));
    if (!hit) continue;
    row.registrationDate = hit.registrationDate;
    row.profile = hit.profile;
  }
  await writeVoters(voters);
  await writeProfileStamp(lookup.stamp);
}

function scheduleRosterProfileEnrich() {
  if (profileEnriching) return;
  profileEnriching = true;
  void enrichMatchedRosterProfiles()
    .catch((error) => console.error("Roster profile enrich", error))
    .finally(() => {
      profileEnriching = false;
    });
}

export async function listRosterVoters({ offset = 0, limit = 100, sort = "voteDate", dir = "asc" } = {}) {
  const voters = sortRosterVoters(await readVoters(), sort === "registrationDate" ? "registrationDate" : "voteDate", dir);
  const start = Math.max(0, Number(offset) || 0);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 100));
  scheduleRosterProfileEnrich();
  return {
    ...rosterTotals(voters),
    offset: start,
    limit: pageSize,
    sort: sort === "registrationDate" ? "registrationDate" : "voteDate",
    dir: dir === "desc" ? "desc" : "asc",
    rows: voters.slice(start, start + pageSize),
  };
}

async function keepRosterDownload(archive, fileName, response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  await archive.save(rosterRawFileName(fileName), bytes);
  return bytes;
}

async function pullTravis() {
  const sourceUrl = TRAVIS_G26_ROSTER_ZIP_URL;
  const archive = openRosterRawArchive("travis");
  const response = await fetch(sourceUrl, { headers: { "user-agent": "electionnighttracker" } });
  if (!response.ok) {
    throw new Error(`Travis roster file was not available (${response.status}). ${sourceUrl}`);
  }
  const zip = await JSZip.loadAsync(await keepRosterDownload(archive, sourceUrl, response));
  const fileCount = Object.keys(zip.files).filter((name) => !zip.files[name].dir && /\.xlsx$/i.test(name)).length;
  const rows = await parseTravisRosterZip(zip, {
    dateScope: "CUMULATIVE",
    votingMethodScope: "ALL",
    defaultCounty: "TRAVIS",
    filePartyScope: "COMBINED",
  });
  const saved = await saveRosterRows(rows, "travis");
  return { sourceUrl, fileCount, ...summarizeRosterRows(rows), ...saved };
}

async function harrisRosterHtml() {
  const response = await fetch(HARRIS_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!response.ok) {
    throw new Error(`Harris roster page was not available (${response.status}). ${HARRIS_ROSTER_PAGE}`);
  }
  const html = await response.text();
  if (harrisBbmRosterLink(html)) return html;
  const frame = harrisRosterFrame(html);
  if (!frame) return html;
  const frameUrl = new URL(frame, HARRIS_ROSTER_PAGE).href;
  const inner = await fetch(frameUrl, { headers: { "user-agent": "electionnighttracker" } });
  if (!inner.ok) {
    throw new Error(`Harris roster list was not available (${inner.status}). ${frameUrl}`);
  }
  return inner.text();
}

async function pullHarris() {
  const html = await harrisRosterHtml();
  const link = harrisBbmRosterLink(html);
  if (!link) {
    throw new Error("The November 3, 2026 Unofficial BBM Roster link was not on the Harris roster page.");
  }
  const archive = openRosterRawArchive("harris");
  const response = await fetch(link.href, { headers: { "user-agent": "electionnighttracker" } });
  if (!response.ok) {
    throw new Error(`Harris roster file was not available (${response.status}). ${link.href}`);
  }
  const zip = await JSZip.loadAsync(await keepRosterDownload(archive, link.href, response));
  const csvNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir && /\.csv$/i.test(name));
  if (!csvNames.length) throw new Error("Harris roster ZIP did not contain a CSV file.");
  const parsed = { rows: [], skippedMissingVuid: 0, skippedMissingDate: 0, missingVuidDays: new Map() };
  for (const name of csvNames) {
    const text = await zip.files[name].async("string");
    const next = parseHarrisBbmCsv(text);
    parsed.rows.push(...next.rows);
    parsed.skippedMissingVuid += next.skippedMissingVuid;
    parsed.skippedMissingDate += next.skippedMissingDate;
    for (const day of next.missingVuidDays ?? []) {
      parsed.missingVuidDays.set(day.date, (parsed.missingVuidDays.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  const saved = await saveRosterRows(parsed.rows, "harris");
  return {
    sourceUrl: link.href,
    fileCount: csvNames.length,
    skippedMissingVuid: parsed.skippedMissingVuid,
    skippedMissingVuidDays: [...parsed.missingVuidDays.entries()]
      .map(([date, missingVuid]) => ({ date, missingVuid }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    ...summarizeRosterRows(parsed.rows),
    ...saved,
  };
}

function cookieHeader(response) {
  return (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";")[0]).join("; ");
}

async function pullBexar() {
  const page = await fetch(BEXAR_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Bexar roster page was not available (${page.status}). ${BEXAR_ROSTER_PAGE}`);
  }
  const cookies = cookieHeader(page);
  const body = {
    folderId: BEXAR_FOLDER_ID,
    getDocuments: 1,
    imageRepo: false,
    renderMode: 0,
    loadSource: 7,
    requestingModuleID: 75,
    searchString: "",
    pageNumber: 1,
    rowsPerPage: 100,
    sortColumn: "Name",
    sortOrder: 0,
  };
  const list = await fetch(
    "https://elections.bexar.gov/Admin/DocumentCenter/Home/Document_AjaxBinding?renderMode=0&loadSource=7",
    {
      method: "POST",
      headers: {
        "user-agent": "electionnighttracker",
        "content-type": "application/json",
        accept: "application/json",
        cookie: cookies,
        referer: BEXAR_ROSTER_PAGE,
      },
      body: JSON.stringify(body),
    },
  );
  const payload = await list.json().catch(() => null);
  const documents = payload?.Documents;
  if (!list.ok || !Array.isArray(documents)) {
    throw new Error("Bexar document list was not available.");
  }
  const files = bexarRosterDocuments(documents);
  const have = countyDatesWithMethod(await readVoters(), "bexar");
  const selected = bexarRosterFilesToPull(files, have);
  if (!selected.length) {
    throw new Error("No dated Bexar roster PDF was in the November 3, 2026 document folder.");
  }
  const archive = openRosterRawArchive("bexar");
  const rows = [];
  let skippedMissingDate = 0;
  for (const link of selected) {
    const file = await fetch(link.href, {
      headers: { "user-agent": "electionnighttracker", cookie: cookies, referer: BEXAR_ROSTER_PAGE },
    });
    if (!file.ok) {
      throw new Error(`Bexar roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = await parseBexarAbbmPdf(await keepRosterDownload(archive, link.fileName || link.href, file), {
      votingMethod: link.votingMethod,
      fallbackDate: link.voteDate,
    });
    rows.push(...parsed.rows);
    skippedMissingDate += parsed.skippedMissingDate;
  }
  const saved = await saveRosterRows(rows, "bexar");
  const latest = selected[selected.length - 1];
  return {
    sourceUrl: latest.href,
    fileCount: selected.length,
    skippedMissingDate,
    ...summarizeRosterRows(rows),
    ...saved,
  };
}

async function pullPotter() {
  const page = await fetch(POTTER_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Potter roster page was not available (${page.status}). ${POTTER_ROSTER_PAGE}`);
  }
  const links = potterRosterLinks(await page.text());
  if (!links.length) {
    throw new Error("The Mail Ballot Roster PDF was not on the Potter County voting rosters page.");
  }
  const archive = openRosterRawArchive("potter");
  const rows = [];
  let skippedMissingVuid = 0;
  for (const link of links) {
    const file = await fetch(link.href, {
      headers: { "user-agent": "electionnighttracker", referer: POTTER_ROSTER_PAGE },
    });
    if (!file.ok) {
      throw new Error(`Potter roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = await parsePotterRosterPdf(await keepRosterDownload(archive, link.fileName || link.href, file), {
      votingMethod: link.votingMethod,
    });
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
  }
  const saved = await saveRosterRows(rows, "potter");
  const mail = links.find((link) => link.votingMethod === "AB") ?? links[0];
  return {
    sourceUrl: mail.href,
    fileCount: links.length,
    skippedMissingVuid,
    ...summarizeRosterRows(rows),
    ...saved,
  };
}

async function pullTarrant() {
  const page = await fetch(TARRANT_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Tarrant roster page was not available (${page.status}). ${TARRANT_ROSTER_PAGE}`);
  }
  const links = tarrantRosterLinks(await page.text());
  const mail = links.find((link) => link.votingMethod === "AB");
  if (!mail) {
    throw new Error("The Ballot by Mail zip was not on the Tarrant County November 3, 2026 results page.");
  }
  const archive = openRosterRawArchive("tarrant");
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  let posted = 0;
  for (const link of links) {
    const file = await fetch(link.href, {
      headers: { "user-agent": "electionnighttracker", referer: TARRANT_ROSTER_PAGE },
    });
    if (!file.ok) {
      throw new Error(`Tarrant roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = await parseTarrantRosterZip(await keepRosterDownload(archive, link.fileName || link.href, file), {
      votingMethod: link.votingMethod,
    });
    if (!parsed.posted) continue;
    posted += 1;
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
    for (const day of parsed.missingVuidDays) {
      missingByDate.set(day.date, (missingByDate.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  if (!posted) {
    throw new Error("The Tarrant Ballot by Mail file did not include an SOS Voter ID and Return Date.");
  }
  const saved = await saveRosterRows(rows, "tarrant");
  return {
    sourceUrl: mail.href,
    fileCount: posted,
    skippedMissingVuid,
    skippedMissingVuidDays: [...missingByDate.entries()]
      .map(([date, missingVuid]) => ({ date, missingVuid }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    ...summarizeRosterRows(rows),
    ...saved,
  };
}

async function pullWise() {
  const page = await fetch(WISE_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Wise roster page was not available (${page.status}). ${WISE_ROSTER_PAGE}`);
  }
  const link = wiseMailRosterLink(await page.text());
  if (!link) {
    throw new Error("The early-voting-by-mail roster PDF was not on the Wise County Elections page.");
  }
  const archive = openRosterRawArchive("wise");
  const file = await fetch(link.href, {
    headers: { "user-agent": "electionnighttracker", referer: WISE_ROSTER_PAGE },
  });
  if (!file.ok) {
    throw new Error(`Wise roster file was not available (${file.status}). ${link.href}`);
  }
  const parsed = await parseWiseRosterPdf(await keepRosterDownload(archive, link.fileName || link.href, file));
  const saved = await saveRosterRows(parsed.rows, "wise");
  return {
    sourceUrl: link.href,
    fileCount: 1,
    skippedMissingVuid: parsed.skippedMissingVuid,
    skippedMissingVuidDays: parsed.missingVuidDays,
    ...summarizeRosterRows(parsed.rows),
    ...saved,
  };
}

async function pullGalveston() {
  const page = await fetch(GALVESTON_ROSTER_PAGE, { headers: GALVESTON_FETCH_HEADERS });
  if (page.status !== 200) {
    throw new Error(`Galveston roster page was not available (${page.status}). ${GALVESTON_ROSTER_PAGE}`);
  }
  const files = galvestonMailRosterLinks(await page.text());
  const have = countyDatesWithMethod(await readVoters(), "galveston");
  const selected = galvestonRosterFilesToPull(files, have);
  if (!selected.length) {
    throw new Error("No mail ballot roster CSV was under Mail Ballot Rosters on the Galveston elections page.");
  }
  const archive = openRosterRawArchive("galveston");
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const link of selected) {
    const file = await fetch(link.href, { headers: { ...GALVESTON_FETCH_HEADERS, referer: GALVESTON_ROSTER_PAGE } });
    if (file.status !== 200) {
      throw new Error(`Galveston roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = parseGalvestonMailCsv(
      (await keepRosterDownload(archive, link.fileName || link.href, file)).toString("utf8"),
    );
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
    for (const day of parsed.missingVuidDays) {
      missingByDate.set(day.date, (missingByDate.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  const saved = await saveRosterRows(rows, "galveston");
  const latest = selected[selected.length - 1];
  return {
    sourceUrl: latest.href,
    fileCount: selected.length,
    skippedMissingVuid,
    skippedMissingVuidDays: [...missingByDate.entries()]
      .map(([date, missingVuid]) => ({ date, missingVuid }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    ...summarizeRosterRows(rows),
    ...saved,
  };
}

async function pullMontgomery() {
  const page = await montgomeryFetch(MONTGOMERY_ROSTER_PAGE);
  if (page.status !== 200) {
    throw new Error(`Montgomery roster page was not available (${page.status}). ${MONTGOMERY_ROSTER_PAGE}`);
  }
  const files = montgomeryRosterLinks(await page.text());
  const have = countyDatesWithMethod(await readVoters(), "montgomery");
  const selected = montgomeryRosterFilesToPull(files, have);
  if (!selected.length) {
    throw new Error("No dated roster zip was on the Montgomery early voting roster page.");
  }
  const archive = openRosterRawArchive("montgomery");
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const link of selected) {
    const file = await montgomeryFetch(link.href);
    if (file.status !== 200) {
      throw new Error(`Montgomery roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = await parseMontgomeryRosterZip(
      await keepRosterDownload(archive, link.fileName || link.href, file),
      link.fileName,
    );
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
    for (const day of parsed.missingVuidDays) {
      missingByDate.set(day.date, (missingByDate.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  const saved = await saveRosterRows(rows, "montgomery");
  const latest = selected[selected.length - 1];
  return {
    sourceUrl: latest.href,
    fileCount: selected.length,
    skippedMissingVuid,
    skippedMissingVuidDays: [...missingByDate.entries()]
      .map(([date, missingVuid]) => ({ date, missingVuid }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    ...summarizeRosterRows(rows),
    ...saved,
  };
}

async function pullEllis() {
  const page = await fetch(ELLIS_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Ellis roster page was not available (${page.status}). ${ELLIS_ROSTER_PAGE}`);
  }
  const link = ellisMailRosterLink(await page.text());
  if (!link) {
    throw new Error("The Returned Ballots by Mail Roster Report was not on the Ellis Upcoming Elections page.");
  }
  const archive = openRosterRawArchive("ellis");
  const file = await fetch(link.href, {
    headers: { "user-agent": "electionnighttracker", referer: ELLIS_ROSTER_PAGE },
  });
  if (!file.ok) {
    throw new Error(`Ellis roster file was not available (${file.status}). ${link.href}`);
  }
  const ellisBytes = await keepRosterDownload(archive, link.fileName || link.href, file);
  const known = new Set();
  for (const row of await readVoters()) {
    if (String(row.sourceCounty ?? "").toLowerCase() !== "ellis") continue;
    const vuid = String(row.vuid ?? "").trim();
    if (vuid) known.add(vuid);
  }
  const parsed = await parseEllisRosterZip(ellisBytes, known);
  const saved = await saveRosterRows(parsed.rows, "ellis");
  return {
    sourceUrl: link.href,
    fileCount: 1,
    skippedMissingVuid: parsed.skippedMissingVuid,
    skippedMissingVuidDays: parsed.missingVuidDays,
    ...summarizeRosterRows(parsed.rows),
    ...saved,
  };
}

const PULLS = {
  travis: pullTravis,
  harris: pullHarris,
  bexar: pullBexar,
  potter: pullPotter,
  tarrant: pullTarrant,
  wise: pullWise,
  galveston: pullGalveston,
  montgomery: pullMontgomery,
  ellis: pullEllis,
};

const SCHEDULE_PATH = path.join(DATA_DIR, "schedule.json");

export const DEFAULT_ROSTER_SCHEDULE = {
  enabled: true,
  intervalMinutes: 60,
  startHour: 9,
  endHour: 12,
  timeZone: "America/Chicago",
};

const AUTO_PULL_HOURS = new Set([9, 10, 11, 12]);

let scheduleTimer = null;

function trainedRosterKeys() {
  return Object.values(COUNTY_ROSTER_PROFILES)
    .filter((profile) => profile.trained && PULLS[profile.key])
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((profile) => profile.key);
}

function normalizeRosterSchedule(raw) {
  const interval = Math.round(Number(raw?.intervalMinutes));
  const startHour = Math.round(Number(raw?.startHour));
  const endHour = Math.round(Number(raw?.endHour));
  return {
    enabled: raw?.enabled !== false,
    intervalMinutes: Number.isFinite(interval) ? Math.min(24 * 60, Math.max(15, interval)) : DEFAULT_ROSTER_SCHEDULE.intervalMinutes,
    startHour: Number.isFinite(startHour) ? Math.min(23, Math.max(0, startHour)) : DEFAULT_ROSTER_SCHEDULE.startHour,
    endHour: Number.isFinite(endHour) ? Math.min(23, Math.max(0, endHour)) : DEFAULT_ROSTER_SCHEDULE.endHour,
    timeZone: "America/Chicago",
  };
}

export function zonedClock(date, timeZone = "America/Chicago") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(value("hour"));
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return { year, month, day, hour, weekday: value("weekday"), isoDate: `${year}-${month}-${day}` };
}

export function zonedHour(date, timeZone = "America/Chicago") {
  return zonedClock(date, timeZone).hour;
}

export function previousIsoDate(isoDate) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

function samePullSlot(iso, now, timeZone) {
  const parsed = Date.parse(iso ?? "");
  if (!Number.isFinite(parsed)) return false;
  const then = zonedClock(new Date(parsed), timeZone);
  const current = zonedClock(now, timeZone);
  return then.isoDate === current.isoDate && then.hour === current.hour;
}

export function countyHasVoteDate(voters, countyKey, isoDate) {
  const key = String(countyKey ?? "").toLowerCase();
  return (voters ?? []).some(
    (row) => String(row.sourceCounty ?? "").toLowerCase() === key && String(row.voteDate ?? "") === isoDate,
  );
}

export function latestRosterVoteDate(voters, countyKey) {
  const key = String(countyKey ?? "").toLowerCase();
  let latest = "";
  for (const row of voters ?? []) {
    if (String(row.sourceCounty ?? "").toLowerCase() !== key) continue;
    const date = String(row.voteDate ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date > latest) latest = date;
  }
  return latest || null;
}

/** Current when the newest vote date is yesterday, or the day before a pull that already ran today. */
export function rosterCaughtUp(latest, pulledAt, now = new Date(), timeZone = "America/Chicago") {
  if (!latest) return false;
  const today = zonedClock(now, timeZone).isoDate;
  if (latest >= previousIsoDate(today)) return true;
  const pulled = Date.parse(pulledAt ?? "");
  if (!Number.isFinite(pulled)) return false;
  const pullDay = zonedClock(new Date(pulled), timeZone).isoDate;
  if (pullDay !== today) return false;
  return latest >= previousIsoDate(pullDay);
}

export function countiesDueForRosterPull(counties, schedule, now = new Date(), voters = []) {
  const rules = normalizeRosterSchedule(schedule);
  if (!rules.enabled) return [];
  const clock = zonedClock(now, rules.timeZone);
  if (clock.weekday === "Sun" || !AUTO_PULL_HOURS.has(clock.hour)) return [];
  return trainedRosterKeys().filter((key) => {
    if (rosterCaughtUp(latestRosterVoteDate(voters, key), counties?.[key]?.pulledAt, now, rules.timeZone)) return false;
    const county = counties?.[key];
    if (samePullSlot(county?.autoCheckedAt, now, rules.timeZone)) return false;
    if (samePullSlot(county?.pulledAt, now, rules.timeZone)) return false;
    return true;
  });
}

export async function readRosterSchedule() {
  const saved = await readRosterDocument("schedule");
  if (saved && typeof saved === "object") return normalizeRosterSchedule(saved);
  const file = await readJsonFile(SCHEDULE_PATH);
  if (file && typeof file === "object") {
    const schedule = normalizeRosterSchedule(file);
    await writeRosterDocument("schedule", schedule);
    return schedule;
  }
  return { ...DEFAULT_ROSTER_SCHEDULE };
}

export async function updateRosterSchedule(patch) {
  const next = normalizeRosterSchedule({ ...(await readRosterSchedule()), ...patch });
  if (next.endHour < next.startHour) {
    const error = new Error("The last pull hour has to be the same as or later than the first pull hour.");
    error.statusCode = 400;
    throw error;
  }
  await writeRosterDocument("schedule", next);
  await writeJsonFile(SCHEDULE_PATH, next);
  return next;
}

export async function readCountyRosterBoard() {
  const store = await readStore();
  const gate = rosterGate();
  let changed = false;
  if (!gate.lock && !gate.active) {
    for (const profile of Object.values(COUNTY_ROSTER_PROFILES)) {
      const county = store.counties[profile.key];
      if (county?.status === "running") {
        county.status = county.pulledAt ? "ready" : "idle";
        changed = true;
      }
    }
  }
  if (changed) await writeStore(store);
  const liveCounts = rosterCountyCounts(await readVoters());
  const counties = {};
  for (const profile of Object.values(COUNTY_ROSTER_PROFILES)) {
    const live = liveCounts[profile.key];
    counties[profile.key] = {
      ...profile,
      ...(store.counties[profile.key] ?? emptyCountyStatus(profile.key)),
      rows: live?.rows ?? 0,
      uniqueVuids: live?.uniqueVuids ?? 0,
      missingVuid: live?.missingVuid ?? 0,
      days: live?.days ?? [],
      running: gate.active?.countyKey === profile.key,
    };
  }
  const pullingProfile = gate.active ? COUNTY_ROSTER_PROFILES[gate.active.countyKey] : null;
  return {
    updatedAt: store.updatedAt,
    counties,
    schedule: await readRosterSchedule(),
    pulling: pullingProfile ? { key: pullingProfile.key, label: pullingProfile.label.replace(/ County$/, "") } : null,
    pullQueue: gate.queue
      .map((key) => COUNTY_ROSTER_PROFILES[key]?.label.replace(/ County$/, ""))
      .filter(Boolean),
  };
}

async function continueRosterQueue() {
  const next = rosterGate().queue.shift();
  if (!next) return;
  try {
    await startCountyRosterPull(next);
  } catch (error) {
    rosterGate().queue = [];
    console.error("County roster queue", error);
  }
}

export async function startCountyRosterPull(countyKey) {
  const key = String(countyKey ?? "").trim().toLowerCase();
  const profile = COUNTY_ROSTER_PROFILES[key];
  if (!profile?.trained || !PULLS[key]) {
    const error = new Error(`${profile?.label ?? "This county"} does not have a trained roster pull yet.`);
    error.statusCode = 400;
    throw error;
  }
  if (rosterGate().active || rosterGate().lock) {
    const error = new Error(`A roster pull is already running for ${rosterGate().active?.countyKey ?? "another county"}.`);
    error.statusCode = 409;
    throw error;
  }
  rosterGate().lock = true;

  try {
    const store = await readStore();
    store.updatedAt = new Date().toISOString();
    store.counties[key] = {
      ...emptyCountyStatus(key),
      ...(store.counties[key] ?? {}),
      status: "running",
      error: null,
    };
    await writeStore(store);

    rosterGate().active = { countyKey: key };
    void (async () => {
      try {
        const result = await PULLS[key]();
        const next = await readStore();
        next.updatedAt = new Date().toISOString();
        const previous = next.counties[key] ?? emptyCountyStatus(key);
        next.counties[key] = {
          ...emptyCountyStatus(key),
          status: "ready",
          pulledAt: next.updatedAt,
          autoCheckedAt: previous.autoCheckedAt ?? null,
          sourceUrl: result.sourceUrl,
          rows: result.rows,
          uniqueVuids: result.uniqueVuids,
          fileCount: result.fileCount,
          days: result.days,
          earlyInPerson: result.earlyInPerson,
          mail: result.mail,
          other: result.other,
          skippedMissingVuid: result.skippedMissingVuid ?? 0,
          skippedMissingVuidDays: result.skippedMissingVuidDays ?? [],
          error: null,
        };
        await writeStore(next);
      } catch (error) {
        const next = await readStore();
        next.updatedAt = new Date().toISOString();
        const previous = next.counties[key] ?? emptyCountyStatus(key);
        next.counties[key] = {
          ...previous,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          autoCheckedAt: previous.autoCheckedAt ?? null,
        };
        await writeStore(next);
      } finally {
        rosterGate().active = null;
        void continueRosterQueue();
      }
    })();

    return readCountyRosterBoard();
  } finally {
    rosterGate().lock = false;
  }
}

export async function startAllCountyRosterPulls() {
  if (rosterGate().active || rosterGate().lock || rosterGate().queue.length) {
    const error = new Error("A roster pull is already running.");
    error.statusCode = 409;
    throw error;
  }
  const keys = trainedRosterKeys();
  if (!keys.length) {
    const error = new Error("No trained county roster pulls yet.");
    error.statusCode = 400;
    throw error;
  }
  rosterGate().queue = keys.slice(1);
  try {
    return await startCountyRosterPull(keys[0]);
  } catch (error) {
    rosterGate().queue = [];
    throw error;
  }
}

export async function runDueRosterPulls(now = new Date()) {
  if (rosterGate().active || rosterGate().lock || rosterGate().queue.length) return { started: false, reason: "busy" };
  const schedule = await readRosterSchedule();
  const store = await readStore();
  const voters = await readVoters();
  const due = countiesDueForRosterPull(store.counties ?? {}, schedule, now, voters);
  if (!due.length) return { started: false, reason: "idle" };
  const checkedAt = now.toISOString();
  for (const key of due) {
    store.counties[key] = {
      ...emptyCountyStatus(key),
      ...(store.counties[key] ?? {}),
      autoCheckedAt: checkedAt,
    };
  }
  store.updatedAt = checkedAt;
  await writeStore(store);
  if (rosterGate().active || rosterGate().lock || rosterGate().queue.length) return { started: false, reason: "busy" };
  rosterGate().queue = due.slice(1);
  try {
    await startCountyRosterPull(due[0]);
    return { started: true, counties: due };
  } catch (error) {
    rosterGate().queue = [];
    if (error?.statusCode === 409) return { started: false, reason: "busy" };
    throw error;
  }
}

const SCHEDULE_GLOBAL = "__enrRosterPullSchedule";

export function startRosterPullSchedule() {
  if (scheduleTimer) return;
  const gate = rosterGate();
  gate.active = null;
  gate.queue = [];
  gate.lock = false;
  const existing = globalThis[SCHEDULE_GLOBAL];
  if (existing?.timer) clearInterval(existing.timer);
  if (existing?.boot) clearTimeout(existing.boot);
  const tick = () => {
    void runDueRosterPulls().catch((error) => {
      console.error("County roster schedule", error);
    });
  };
  const boot = setTimeout(() => {
    const timer = setInterval(tick, 30_000);
    scheduleTimer = timer;
    const current = globalThis[SCHEDULE_GLOBAL];
    if (current) current.timer = timer;
    tick();
  }, 4 * 60 * 1000);
  scheduleTimer = boot;
  globalThis[SCHEDULE_GLOBAL] = { timer: null, boot };
}
