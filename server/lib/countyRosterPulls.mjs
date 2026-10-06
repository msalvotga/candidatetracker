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
import { kendallReturnedRosterLink, parseKendallRosterPdf, KENDALL_ROSTER_PAGE } from "./kendallRoster.mjs";
import { BOWIE_ROSTER_PAGE, bowieMailRosterLinks, bowieRosterFilesToPull, parseBowieRosterPdf } from "./bowieRoster.mjs";
import { BRAZOS_ROSTER_PAGE, brazosRosterFilesToPull, brazosRosterLinks, parseBrazosRosterPdf } from "./brazosRoster.mjs";
import { COMAL_ROSTER_PAGE, comalMailRosterLinks, comalRosterFilesToPull, parseComalRosterPdf } from "./comalRoster.mjs";
import { BASTROP_FETCH_HEADERS, BASTROP_ROSTER_PAGE, bastropRosterLinks, parseBastropRosterCsv } from "./bastropRoster.mjs";
import {
  HIDALGO_ROSTER_PAGE,
  hidalgoDownloadName,
  hidalgoMailRosterLink,
  parseHidalgoRosterFile,
} from "./hidalgoRoster.mjs";
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
  fetchWilliamsonRoster,
  parseWilliamsonRosterXlsx,
  WILLIAMSON_ROSTER_PAGE,
} from "./williamsonRoster.mjs";
import { parseRandallRosterPdf, randallMailRosterLink, RANDALL_ROSTER_PAGE } from "./randallRoster.mjs";
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
  kendall: {
    key: "kendall",
    label: "Kendall County",
    trained: true,
    fileKinds: "Returned ballots PDF",
    notes:
      "Each pull reads the current election page and takes the Returned Ballots Roster for the November 3rd General. The link says as of a date, and that date changes. The PDF is mail ballots. VUID is the voter id and Date Ballot Received is the vote date.",
    sourcePage: KENDALL_ROSTER_PAGE,
  },
  bowie: {
    key: "bowie",
    label: "Bowie County",
    trained: true,
    fileKinds: "Daily mail PDFs",
    notes:
      "Each pull reads the Elections page and takes the BBM Received PDFs under the November 3, 2026 General Election tab. The link is labeled with the day, such as BBM Received 9.22.2026, and new days are added there. The PDF has a VUID and Date Rec'd, which is the vote date. A pull reads the newest day, plus any earlier day that does not already have voters.",
    sourcePage: BOWIE_ROSTER_PAGE,
  },
  brazos: {
    key: "brazos",
    label: "Brazos County",
    trained: true,
    fileKinds: "Daily roster PDFs",
    notes:
      "Each pull reads the roster page and takes the PDFs under 2026 General/Special Election. Those are the November 2026 general election rosters. A file has a VUID and no vote date on the row. The date is the day in the file name, or the first line of the PDF when that line states the day. Mail files are AB and in-person files are EV. A pull reads the newest day, plus any earlier day that does not already have voters.",
    sourcePage: BRAZOS_ROSTER_PAGE,
  },
  comal: {
    key: "comal",
    label: "Comal County",
    trained: true,
    fileKinds: "Daily mail PDFs",
    notes:
      "Each pull reads the archived data page and takes the General Election BBM Retd PDFs. The link is labeled with the day, such as 10-02-2026, General Election BBM Retd, and new days are added there. The PDF has a VUID and a Ballot Returned Date, which is the vote date. A pull reads the newest day, plus any earlier day that does not already have voters.",
    sourcePage: COMAL_ROSTER_PAGE,
  },
  bastrop: {
    key: "bastrop",
    label: "Bastrop County",
    trained: true,
    fileKinds: "Mail and in-person CSVs",
    notes:
      "Each pull reads the upcoming elections page and takes the Mail Ballots CSV under Daily Voter Lists. The file address changes when the county replaces it. The CSV has a VUID and a Ballot Status Date, which is the vote date. In-person voter links in that same list are read the same way when the county posts them. Mail is AB and in-person is EV.",
    sourcePage: BASTROP_ROSTER_PAGE,
  },
  hidalgo: {
    key: "hidalgo",
    label: "Hidalgo County",
    trained: true,
    fileKinds: "Mail in ballots",
    notes:
      "Each pull reads the unofficial early voting page and takes the Mail in Ballots file for the November 3, 2026 election. The file is cumulative and has a VUID column with no vote date. The date is the YYYYMMDD stamp after the underscore in the downloaded file name. A VUID already stored for Hidalgo keeps its vote date. A VUID that is new gets the date from the file just downloaded.",
    sourcePage: HIDALGO_ROSTER_PAGE,
  },
  ellis: {
    key: "ellis",
    label: "Ellis County",
    trained: true,
    fileKinds: "Cumulative mail ZIP",
    notes:
      "Each pull reads the Upcoming Elections page and takes the Returned Ballots by Mail Roster Report. The link changes when the file is replaced. The zip holds one cumulative Excel file. Rows have a VUID and no vote date. The first time a VUID appears, it is stored with the MMDDYY date at the end of that Excel file name. A VUID already stored for Ellis is left as it is.",
    sourcePage: ELLIS_ROSTER_PAGE,
  },
  williamson: {
    key: "williamson",
    label: "Williamson County",
    trained: true,
    fileKinds: "Turnout workbook",
    notes:
      "Each pull reads the elections page and takes the Daily Voting Roster for the November 3, 2026 election. The workbook has a VUID and a Ballot Date, which is the vote date. AV is mail and EV is in-person. The same voter on two days is kept once for each day.",
    sourcePage: WILLIAMSON_ROSTER_PAGE,
  },
  randall: {
    key: "randall",
    label: "Randall County",
    trained: true,
    fileKinds: "Mail ballot PDF",
    notes:
      "Each pull reads the election administration page and takes the Mail Ballot Roster. The document address changes when the county replaces the file. The PDF has a VUID at the start of the name and a Ballot Received Date, which is the vote date. Mail is AB.",
    sourcePage: RANDALL_ROSTER_PAGE,
  },
};

const ROSTER_PULL_GATE = "__enrRosterPullGate";

function rosterGate() {
  if (!globalThis[ROSTER_PULL_GATE]) {
    globalThis[ROSTER_PULL_GATE] = { active: null, queue: [], lock: false, automatic: false };
  }
  return globalThis[ROSTER_PULL_GATE];
}

/** Drop a schedule lineup when automatic pulls are off. A manual Pull all keeps its queue. */
export function dropAutomaticRosterQueue(gate, scheduleEnabled) {
  if (!gate?.automatic || scheduleEnabled) return false;
  gate.queue = [];
  gate.automatic = false;
  return true;
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

function localAheadPath(filePath) {
  return `${filePath}.local-ahead`;
}

async function isLocalAhead(filePath) {
  try {
    await access(localAheadPath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function markLocalAhead(filePath) {
  await writeFile(localAheadPath(filePath), "");
}

async function clearLocalAhead(filePath) {
  await rm(localAheadPath(filePath), { force: true });
}

/** Keep the local file when a database write failed and the database still has the older copy. */
export function chooseRosterDocument(localAhead, databaseValue, fileValue, isUsable) {
  if (localAhead && isUsable(fileValue)) return fileValue;
  if (isUsable(databaseValue)) return databaseValue;
  if (isUsable(fileValue)) return fileValue;
  return undefined;
}

async function readRosterSnapshot(filePath, docKey, isUsable) {
  const ahead = await isLocalAhead(filePath);
  const saved = ahead ? undefined : await readRosterDocument(docKey);
  const file = ahead || !isUsable(saved) ? await readJsonFile(filePath) : undefined;
  let chosen = chooseRosterDocument(ahead, saved, file, isUsable);
  if (ahead && !isUsable(chosen)) {
    const databaseValue = await readRosterDocument(docKey);
    chosen = chooseRosterDocument(false, databaseValue, file, isUsable);
    if (!isUsable(databaseValue) && isUsable(chosen)) await writeRosterDocument(docKey, chosen);
    return chosen;
  }
  if (ahead && isUsable(chosen) && (await writeRosterDocument(docKey, chosen))) await clearLocalAhead(filePath);
  if (!ahead && !isUsable(saved) && isUsable(chosen)) await writeRosterDocument(docKey, chosen);
  return chosen;
}

async function writeRosterSnapshot(filePath, docKey, payload) {
  await writeJsonFile(filePath, payload);
  await markLocalAhead(filePath);
  if (await writeRosterDocument(docKey, payload)) await clearLocalAhead(filePath);
}

const jsonWrites = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonFileOnce(filePath, body) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tmp, body);
    await copyFile(tmp, filePath);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function writeJsonFile(filePath, value) {
  await ensureDir();
  const body = JSON.stringify(value);
  const previous = jsonWrites.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await writeJsonFileOnce(filePath, body);
        return;
      } catch (error) {
        lastError = error;
        const code = error?.code;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
        await sleep(50 * (attempt + 1));
      }
    }
    throw lastError;
  });
  const tracked = run.finally(() => {
    if (jsonWrites.get(filePath) === tracked) jsonWrites.delete(filePath);
  });
  jsonWrites.set(filePath, tracked);
  return run;
}

function isRosterStore(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readStore() {
  const saved = await readRosterSnapshot(STATUS_PATH, "status", isRosterStore);
  if (isRosterStore(saved)) return saved;
  return { updatedAt: null, counties: {} };
}

async function writeStore(store) {
  await writeRosterSnapshot(STATUS_PATH, "status", store);
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

/** CSV method: AB mail/absentee, EV early voting, ED election day. */
export function rosterMethodCode(raw) {
  const text = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ");
  if (!text || text === "OTHER") return "";
  if (text === "AB" || text === "ABB" || text === "BBM" || text === "MAIL" || text === "ABSENTEE" || text === "BALLOT BY MAIL") return "AB";
  if (text === "ED" || text === "ELECTION DAY") return "ED";
  if (text === "EV" || text === "EARLY" || text === "EARLY VOTING" || text === "IN PERSON") return "EV";
  return "";
}

function storedVotingMethod(raw) {
  return rosterMethodCode(raw);
}

const MAIL_ONLY_ROSTER_COUNTIES = new Set(["harris", "ellis", "galveston", "wise", "kendall", "hidalgo", "bowie", "comal"]);

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
  const voters = sortRosterVoters(countableRosterVoters(await readVoters()), sort === "registrationDate" ? "registrationDate" : "voteDate", dir);
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
  target.lookupChecked = 0;
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

function awaitingLookup(row) {
  if (row?.matched === 1 || row?.lookupChecked === 1) return false;
  return Boolean(vuidId(row?.vuid));
}

export function unmatchedRosterVuids(voters) {
  const need = new Set();
  for (const row of voters ?? []) {
    if (!awaitingLookup(row)) continue;
    need.add(vuidId(row.vuid));
  }
  return need;
}

/** Copy voter-file hits onto rows that are still unmatched. Other rows stay as they are. */
export function applyRosterLookupHits(voters, hits) {
  let applied = 0;
  for (const row of voters ?? []) {
    if (row.matched === 1) continue;
    const hit = hits?.get(vuidId(row.vuid));
    if (!hit) continue;
    copyMatch(row, hit);
    applied += 1;
  }
  return applied;
}

const ROSTER_MATCH_BATCH = 200;

/**
 * Finish a batch of VUIDs. A hit is copied onto every row for that VUID.
 * A VUID with no hit is marked looked up so it leaves the matching count.
 */
export function applyRosterLookupBatch(voters, batchIds, hits) {
  const batch = new Set([...batchIds].map(vuidId));
  let applied = 0;
  let checked = 0;
  for (const row of voters ?? []) {
    const id = vuidId(row.vuid);
    if (!id || !batch.has(id) || row.matched === 1) continue;
    const hit = hits?.get(id);
    if (hit) {
      copyMatch(row, hit);
      applied += 1;
    } else if (row.lookupChecked !== 1) {
      row.lookupChecked = 1;
      checked += 1;
    }
  }
  return { applied, checked };
}

export function mergeRosterRecords(existing, incoming, sourceCounty) {
  const byKey = new Map(existing.map((row) => [voterKey(row.vuid, row.voteDate), row]));
  const known = new Map();
  const checkedMiss = new Set();
  for (const row of existing) {
    if (row.matched === 1) known.set(row.vuid, row);
    else if (row.lookupChecked === 1) checkedMiss.add(row.vuid);
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
    else if (checkedMiss.has(vuid)) row.lookupChecked = 1;
    byKey.set(key, row);
    added += 1;
  }
  const voters = [...byKey.values()];
  const unmatchedVuids = [...unmatchedRosterVuids(voters)];
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

async function matchLookupVuids(need, onHit) {
  const hits = new Map();
  if (!need.size) return { hits, complete: true };
  let input;
  try {
    input = await openLookupCsvStream();
  } catch {
    return { hits, complete: false };
  }
  const wanted = new Set([...need].map(vuidId));
  let complete = false;
  await new Promise((resolve, reject) => {
    const parser = input.pipe(
      parse({ columns: true, bom: true, relax_quotes: true, relax_column_count: true }),
    );
    let settled = false;
    let tail = Promise.resolve();
    const finish = () => {
      if (settled) return;
      settled = true;
      tail.then(
        () => {
          complete = true;
          resolve();
        },
        (error) => reject(error),
      );
    };
    parser.on("data", (row) => {
      const vuid = vuidId(lookupField(row, "VUID"));
      if (!vuid || !wanted.has(vuid) || hits.has(vuid)) return;
      const profile = voterProfileFromLookup(row);
      const hit = {
        county: String(lookupField(row, "CountyName") ?? "").trim() || null,
        usHouse: normDistrict(lookupField(row, "USHouse")),
        txSenate: normDistrict(lookupField(row, "TXSenate")),
        txHouse: normDistrict(lookupField(row, "TXHouse")),
        score2022: parseModelScore(lookupField(row, "Score2022")),
        score2026: parseModelScore(lookupField(row, "Score2026")),
        registrationDate: registrationDateFromProfile(profile),
        profile,
      };
      hits.set(vuid, hit);
      const pending = onHit?.(vuid, hit);
      if (pending && typeof pending.then === "function") {
        parser.pause();
        tail = tail.then(() => pending).then(
          () => {
            if (!parser.destroyed) parser.resume();
          },
          (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
            parser.destroy();
          },
        );
      }
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
  return { hits, complete };
}

export async function readRosterVoterRows() {
  return countableRosterVoters(await readVoters());
}

async function readVoters() {
  const saved = await readRosterSnapshot(VOTERS_PATH, "voters", Array.isArray);
  if (!Array.isArray(saved)) return [];
  const rows = saved;
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
  await writeRosterSnapshot(VOTERS_PATH, "voters", voters);
}

const ROSTER_MATCH_GATE = "__enrRosterMatchGate";

function rosterMatchGate() {
  if (!globalThis[ROSTER_MATCH_GATE]) {
    globalThis[ROSTER_MATCH_GATE] = {
      running: false,
      pending: 0,
      found: 0,
      scheduled: false,
      loop: null,
      voterWrite: Promise.resolve(),
    };
  }
  return globalThis[ROSTER_MATCH_GATE];
}

function withVoterStore(work) {
  const gate = rosterMatchGate();
  const run = gate.voterWrite.catch(() => {}).then(work);
  gate.voterWrite = run;
  return run;
}

/** Null when no voter-file match is waiting or running. */
export function rosterMatchStatus() {
  const gate = rosterMatchGate();
  if (!gate.running) return null;
  return { pending: gate.pending, found: gate.found };
}

function scheduleRosterVoterMatch() {
  const gate = rosterMatchGate();
  gate.scheduled = true;
  if (gate.loop) return;
  gate.loop = runRosterVoterMatch()
    .catch((error) => console.error("Roster voter match", error))
    .finally(() => {
      const current = rosterMatchGate();
      current.loop = null;
      if (current.scheduled) scheduleRosterVoterMatch();
    });
}

function chunkList(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function persistRosterLookup(batchIds, hits) {
  return withVoterStore(async () => {
    const current = await readVoters();
    const result = applyRosterLookupBatch(current, batchIds, hits);
    if (result.applied || result.checked) await writeVoters(current);
    return result;
  });
}

async function runRosterVoterMatch() {
  const gate = rosterMatchGate();
  try {
    while (gate.scheduled) {
      gate.scheduled = false;
      const need = [...unmatchedRosterVuids(await readVoters())];
      if (!need.length) {
        gate.pending = 0;
        continue;
      }
      gate.running = true;
      gate.pending = need.length;
      const started = Date.now();
      console.log(`Matching ${need.length} roster VUIDs against the voter file`);
      const hits = new Map();
      let sinceFlush = [];
      let resolved = 0;
      const publishPending = () => {
        gate.pending = Math.max(0, need.length - resolved);
        console.log(`Roster match: ${gate.pending} voters still to match`);
      };
      let scan;
      try {
        scan = await matchLookupVuids(new Set(need), (vuid, hit) => {
          hits.set(vuid, hit);
          sinceFlush.push(vuid);
          resolved += 1;
          gate.pending = Math.max(0, need.length - resolved);
          if (sinceFlush.length < ROSTER_MATCH_BATCH) return undefined;
          const batch = sinceFlush;
          sinceFlush = [];
          return persistRosterLookup(batch, hits).then((result) => {
            gate.found += result.applied;
            publishPending();
          });
        });
      } catch (error) {
        console.error("Roster voter match", error);
        gate.scheduled = true;
        await sleep(5000);
        break;
      }
      if (!scan.complete) {
        console.error("Roster voter match could not read the voter file");
        gate.scheduled = true;
        await sleep(5000);
        break;
      }
      console.log(`Voter file match finished in ${Date.now() - started}ms (${hits.size} found)`);
      try {
        if (sinceFlush.length) {
          const result = await persistRosterLookup(sinceFlush, hits);
          gate.found += result.applied;
          sinceFlush = [];
          publishPending();
        }
        const missed = need.filter((id) => !hits.has(id));
        for (const batch of chunkList(missed, ROSTER_MATCH_BATCH)) {
          resolved += batch.length;
          publishPending();
          const result = await persistRosterLookup(batch, hits);
          gate.found += result.applied;
        }
      } catch (error) {
        console.error("Roster voter match", error);
        gate.scheduled = true;
        await sleep(5000);
        break;
      }
    }
  } finally {
    gate.running = false;
    if (!gate.scheduled) gate.pending = 0;
  }
}

async function saveRosterRows(incoming, sourceCounty) {
  const saved = await withVoterStore(async () => {
    const existing = await readVoters();
    const merged = mergeRosterRecords(existing, incoming, sourceCounty);
    await writeVoters(merged.voters);
    const matched = merged.voters.filter((row) => row.matched === 1).length;
    return {
      matched,
      unmatched: merged.voters.length - matched,
      added: merged.added,
      lookupChecked: merged.unmatchedVuids.length,
    };
  });
  if (saved.lookupChecked) scheduleRosterVoterMatch();
  return saved;
}

export function rosterCountyCounts(voters, now = new Date()) {
  const today = zonedClock(now, "America/Chicago").isoDate;
  const by = new Map();
  for (const row of voters ?? []) {
    const voteDate = String(row.voteDate ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(voteDate) && voteDate > today) continue;
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
    unmatched: voters.filter((row) => awaitingLookup(row)).length,
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
  const match = rosterMatchGate();
  if (gate.active || gate.lock || gate.queue.length || match.running || match.scheduled || match.loop) return;
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
  if (rosterGate().active || rosterGate().lock || rosterMatchGate().running || rosterMatchGate().scheduled) return;
  await withVoterStore(async () => {
    const current = await readVoters();
    for (const row of current) {
      if (row.matched !== 1) continue;
      const hit = hits.get(vuidId(row.vuid));
      if (!hit) continue;
      row.registrationDate = hit.registrationDate;
      row.profile = hit.profile;
    }
    await writeVoters(current);
  });
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
  const voters = sortRosterVoters(countableRosterVoters(await readVoters()), sort === "registrationDate" ? "registrationDate" : "voteDate", dir);
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

async function pullKendall() {
  const page = await fetch(KENDALL_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Kendall roster page was not available (${page.status}). ${KENDALL_ROSTER_PAGE}`);
  }
  const link = kendallReturnedRosterLink(await page.text());
  if (!link) {
    throw new Error("The November 3rd General returned ballots roster was not on the Kendall current election page.");
  }
  const archive = openRosterRawArchive("kendall");
  const file = await fetch(link.href, {
    headers: { "user-agent": "electionnighttracker", referer: KENDALL_ROSTER_PAGE },
  });
  if (!file.ok) {
    throw new Error(`Kendall roster file was not available (${file.status}). ${link.href}`);
  }
  const parsed = await parseKendallRosterPdf(await keepRosterDownload(archive, link.href, file));
  const saved = await saveRosterRows(parsed.rows, "kendall");
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

async function pullHidalgo() {
  const page = await fetch(HIDALGO_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Hidalgo roster page was not available (${page.status}). ${HIDALGO_ROSTER_PAGE}`);
  }
  const link = hidalgoMailRosterLink(await page.text());
  if (!link) {
    throw new Error("The Mail in Ballots file was not on the Hidalgo early voting rosters page.");
  }
  const archive = openRosterRawArchive("hidalgo");
  const file = await fetch(link.href, {
    headers: { "user-agent": "electionnighttracker", referer: HIDALGO_ROSTER_PAGE },
  });
  if (!file.ok) {
    throw new Error(`Hidalgo roster file was not available (${file.status}). ${link.href}`);
  }
  const fileName = hidalgoDownloadName(file.headers.get("content-disposition"), link.href);
  const hidalgoBytes = await keepRosterDownload(archive, fileName || link.href, file);
  const known = new Set();
  for (const row of await readVoters()) {
    if (String(row.sourceCounty ?? "").toLowerCase() !== "hidalgo") continue;
    const vuid = String(row.vuid ?? "").trim();
    if (vuid) known.add(vuid);
  }
  const parsed = parseHidalgoRosterFile(hidalgoBytes, fileName, known);
  const saved = await saveRosterRows(parsed.rows, "hidalgo");
  return {
    sourceUrl: link.href,
    fileCount: 1,
    skippedMissingVuid: parsed.skippedMissingVuid,
    skippedMissingVuidDays: parsed.missingVuidDays,
    ...summarizeRosterRows(parsed.rows),
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

async function pullBowie() {
  const page = await fetch(BOWIE_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Bowie roster page was not available (${page.status}). ${BOWIE_ROSTER_PAGE}`);
  }
  const files = bowieMailRosterLinks(await page.text());
  const have = countyDatesWithMethod(await readVoters(), "bowie");
  const selected = bowieRosterFilesToPull(files, have);
  if (!selected.length) {
    throw new Error("No BBM Received PDF was under the November 3, 2026 General Election on the Bowie elections page.");
  }
  const archive = openRosterRawArchive("bowie");
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const link of selected) {
    const file = await fetch(link.href, {
      headers: { "user-agent": "electionnighttracker", referer: BOWIE_ROSTER_PAGE },
    });
    if (!file.ok) {
      throw new Error(`Bowie roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = await parseBowieRosterPdf(await keepRosterDownload(archive, link.text || link.href, file), {
      fallbackDate: link.voteDate,
    });
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
    for (const day of parsed.missingVuidDays) {
      missingByDate.set(day.date, (missingByDate.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  const saved = await saveRosterRows(rows, "bowie");
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

async function pullBrazos() {
  const page = await fetch(BRAZOS_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Brazos roster page was not available (${page.status}). ${BRAZOS_ROSTER_PAGE}`);
  }
  const files = brazosRosterLinks(await page.text());
  const have = new Set();
  for (const row of await readVoters()) {
    if (String(row.sourceCounty ?? "").toLowerCase() !== "brazos") continue;
    const date = String(row.voteDate ?? "").trim();
    const method = String(row.votingMethod ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && method) have.add(`${date}|${method}`);
  }
  const selected = brazosRosterFilesToPull(files, have);
  if (!selected.length) {
    throw new Error("No November 2026 roster PDF was under 2026 General/Special Election on the Brazos roster page.");
  }
  const archive = openRosterRawArchive("brazos");
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const link of selected) {
    const file = await fetch(link.href, {
      headers: { "user-agent": "electionnighttracker", referer: BRAZOS_ROSTER_PAGE },
    });
    if (!file.ok) {
      throw new Error(`Brazos roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = await parseBrazosRosterPdf(await keepRosterDownload(archive, link.href, file), {
      fallbackDate: link.voteDate,
      votingMethod: link.votingMethod,
    });
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
    for (const day of parsed.missingVuidDays) {
      missingByDate.set(day.date, (missingByDate.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  const saved = await saveRosterRows(rows, "brazos");
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

async function pullComal() {
  const page = await fetch(COMAL_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Comal roster page was not available (${page.status}). ${COMAL_ROSTER_PAGE}`);
  }
  const files = comalMailRosterLinks(await page.text());
  const have = countyDatesWithMethod(await readVoters(), "comal");
  const selected = comalRosterFilesToPull(files, have);
  if (!selected.length) {
    throw new Error("No General Election BBM Retd PDF was on the Comal archived data page.");
  }
  const archive = openRosterRawArchive("comal");
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const link of selected) {
    const file = await fetch(link.href, {
      headers: { "user-agent": "electionnighttracker", referer: COMAL_ROSTER_PAGE },
    });
    if (!file.ok) {
      throw new Error(`Comal roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = await parseComalRosterPdf(await keepRosterDownload(archive, link.text || link.href, file), {
      fallbackDate: link.voteDate,
    });
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
    for (const day of parsed.missingVuidDays) {
      missingByDate.set(day.date, (missingByDate.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  const saved = await saveRosterRows(rows, "comal");
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

async function pullBastrop() {
  const page = await fetch(BASTROP_ROSTER_PAGE, { headers: BASTROP_FETCH_HEADERS });
  if (!page.ok) {
    throw new Error(`Bastrop roster page was not available (${page.status}). ${BASTROP_ROSTER_PAGE}`);
  }
  const html = await page.text();
  if (/challenge-container|awsWaf/i.test(html) && !/Mail Ballots/i.test(html)) {
    throw new Error(`Bastrop roster page asked for a browser check. ${BASTROP_ROSTER_PAGE}`);
  }
  const files = bastropRosterLinks(html);
  if (!files.length) {
    throw new Error("The Mail Ballots CSV was not under Daily Voter Lists on the Bastrop upcoming elections page.");
  }
  const archive = openRosterRawArchive("bastrop");
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const link of files) {
    const file = await fetch(link.href, { headers: { ...BASTROP_FETCH_HEADERS, referer: BASTROP_ROSTER_PAGE } });
    if (!file.ok) {
      throw new Error(`Bastrop roster file was not available (${file.status}). ${link.href}`);
    }
    const parsed = parseBastropRosterCsv(
      (await keepRosterDownload(archive, link.href, file)).toString("utf8"),
      link.votingMethod,
    );
    rows.push(...parsed.rows);
    skippedMissingVuid += parsed.skippedMissingVuid;
    for (const day of parsed.missingVuidDays) {
      missingByDate.set(day.date, (missingByDate.get(day.date) ?? 0) + day.missingVuid);
    }
  }
  const saved = await saveRosterRows(rows, "bastrop");
  const mail = files.find((link) => link.votingMethod === "AB") ?? files[files.length - 1];
  return {
    sourceUrl: mail.href,
    fileCount: files.length,
    skippedMissingVuid,
    skippedMissingVuidDays: [...missingByDate.entries()]
      .map(([date, missingVuid]) => ({ date, missingVuid }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    ...summarizeRosterRows(rows),
    ...saved,
  };
}

async function pullRandall() {
  const page = await fetch(RANDALL_ROSTER_PAGE, { headers: { "user-agent": "electionnighttracker" } });
  if (!page.ok) {
    throw new Error(`Randall roster page was not available (${page.status}). ${RANDALL_ROSTER_PAGE}`);
  }
  const link = randallMailRosterLink(await page.text());
  if (!link) {
    throw new Error("The Mail Ballot Roster was not on the Randall election administration page.");
  }
  const file = await fetch(link.href, {
    headers: { "user-agent": "electionnighttracker", referer: RANDALL_ROSTER_PAGE },
  });
  if (!file.ok) {
    throw new Error(`Randall roster file was not available (${file.status}). ${link.href}`);
  }
  const archive = openRosterRawArchive("randall");
  const parsed = await parseRandallRosterPdf(await keepRosterDownload(archive, link.href, file));
  const saved = await saveRosterRows(parsed.rows, "randall");
  return {
    sourceUrl: link.href,
    fileCount: 1,
    skippedMissingVuid: parsed.skippedMissingVuid,
    skippedMissingVuidDays: parsed.missingVuidDays,
    ...summarizeRosterRows(parsed.rows),
    ...saved,
  };
}

async function pullWilliamson() {
  const { link, bytes } = await fetchWilliamsonRoster();
  const archive = openRosterRawArchive("williamson");
  await archive.save(link.href, bytes);
  const parsed = parseWilliamsonRosterXlsx(bytes);
  const saved = await saveRosterRows(parsed.rows, "williamson");
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
  kendall: pullKendall,
  hidalgo: pullHidalgo,
  bowie: pullBowie,
  brazos: pullBrazos,
  comal: pullComal,
  bastrop: pullBastrop,
  galveston: pullGalveston,
  montgomery: pullMontgomery,
  ellis: pullEllis,
  williamson: pullWilliamson,
  randall: pullRandall,
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

/** A dated ballot counts on its vote day and after. A later date waits until that day. */
export function rosterDateHasArrived(voteDate, today) {
  const date = String(voteDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  return date <= today;
}

export function countableRosterVoters(voters, now = new Date()) {
  const today = zonedClock(now, "America/Chicago").isoDate;
  return (voters ?? []).filter((row) => rosterDateHasArrived(row.voteDate ?? row.activityDate, today));
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

export function latestRosterVoteDate(voters, countyKey, now = new Date()) {
  const key = String(countyKey ?? "").toLowerCase();
  const today = zonedClock(now, "America/Chicago").isoDate;
  let latest = "";
  for (const row of voters ?? []) {
    if (String(row.sourceCounty ?? "").toLowerCase() !== key) continue;
    const date = String(row.voteDate ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today && date > latest) latest = date;
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
    if (rosterCaughtUp(latestRosterVoteDate(voters, key, now), counties?.[key]?.pulledAt, now, rules.timeZone)) return false;
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
  dropAutomaticRosterQueue(rosterGate(), next.enabled);
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
    matching: rosterMatchStatus(),
    pullQueue: gate.queue
      .map((key) => COUNTY_ROSTER_PROFILES[key]?.label.replace(/ County$/, ""))
      .filter(Boolean),
  };
}

async function continueRosterQueue() {
  const gate = rosterGate();
  let scheduleEnabled = false;
  try {
    scheduleEnabled = (await readRosterSchedule()).enabled;
  } catch (error) {
    console.error("County roster queue", error);
  }
  if (gate.automatic && dropAutomaticRosterQueue(gate, scheduleEnabled)) return;
  const next = gate.queue.shift();
  if (!next) {
    gate.automatic = false;
    return;
  }
  try {
    await startCountyRosterPull(next);
  } catch (error) {
    const failed = rosterGate();
    failed.queue = [];
    failed.automatic = false;
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
        console.error("County roster pull", error);
        try {
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
        } catch (writeError) {
          console.error("County roster pull status", writeError);
        }
      } finally {
        rosterGate().active = null;
        void continueRosterQueue().catch((queueError) => console.error("County roster queue", queueError));
      }
    })().catch((error) => console.error("County roster pull", error));

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
  const gate = rosterGate();
  gate.automatic = true;
  gate.queue = due.slice(1);
  try {
    await startCountyRosterPull(due[0]);
    return { started: true, counties: due };
  } catch (error) {
    gate.queue = [];
    gate.automatic = false;
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
  gate.automatic = false;
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
