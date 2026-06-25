import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { recomputeOfficeMetric } from "./contestMetrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const CAPITOL_RETURNS_URL =
  "https://data.capitol.texas.gov/dataset/35b16aee-0bb0-4866-b1ec-859f1f044241/resource/b9ebdbdb-3e31-4c98-b158-0e2993b05efc/download/2022-general-vtds-election-data.zip";
const OE_GENERAL_URL =
  "https://raw.githubusercontent.com/openelections/openelections-data-tx/master/2022/20221108__tx__general__precinct.csv";

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function padDistrict(n, width) {
  return String(n).padStart(width, "0");
}

export function officeCodeFromCapitolOffice(office) {
  const text = String(office ?? "").trim();
  let match = text.match(/^State Rep (\d+)$/i);
  if (match) return `HD-${padDistrict(Number(match[1]), 3)}`;
  match = text.match(/^State Sen (\d+)$/i);
  if (match) return `SD-${padDistrict(Number(match[1]), 2)}`;
  match = text.match(/^U\.S\. Rep (\d+)$/i);
  if (match) return `TX-${Number(match[1])}`;
  return null;
}

export function officeCodeFromOpenElectionsOffice(office, district) {
  const text = String(office ?? "").trim();
  const dist = String(district ?? "").trim();
  if (!dist || dist === "NA") return null;
  const n = Number(dist);
  if (!Number.isFinite(n)) return null;
  if (/^State House$/i.test(text)) return `HD-${padDistrict(n, 3)}`;
  if (/^State Senate$/i.test(text)) return `SD-${padDistrict(n, 2)}`;
  if (/^US House$/i.test(text)) return `TX-${n}`;
  if (/State Board of Education/i.test(text)) return `SBOE-${padDistrict(n, 2)}`;
  return null;
}

function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function partyFromOpenElections(party) {
  const p = String(party ?? "").trim().toUpperCase();
  if (p === "REP" || p === "R") return "R";
  if (p === "DEM" || p === "D") return "D";
  if (p === "LIB" || p === "L") return "L";
  if (p === "IND" || p === "I") return "I";
  if (p === "GRN" || p === "G") return "G";
  return p.slice(0, 1) || "O";
}

function aggregateKey(officeCode, party, candidateName) {
  return `${officeCode}|${party}|${normalizeName(candidateName)}`;
}

function addVotes(map, officeCode, party, candidateName, votes) {
  if (!officeCode || !candidateName || !Number.isFinite(votes) || votes <= 0) return;
  const key = aggregateKey(officeCode, party, candidateName);
  map.set(key, (map.get(key) ?? 0) + Math.round(votes));
}

export async function aggregateCapitolReturnsVotes(csvPath) {
  const map = new Map();
  const reader = createInterface({ input: createReadStream(csvPath) });
  let lineNo = 0;
  for await (const line of reader) {
    lineNo++;
    if (lineNo === 1) continue;
    const row = parseCsvLine(line);
    const officeCode = officeCodeFromCapitolOffice(row[5]);
    if (!officeCode) continue;
    const party = String(row[7] ?? "").trim().toUpperCase();
    const name = String(row[6] ?? "").trim();
    const votes = Number(row[9] ?? 0);
    addVotes(map, officeCode, party, name, votes);
  }
  return map;
}

export async function aggregateOpenElectionsVotes(csvPath) {
  const map = new Map();
  const reader = createInterface({ input: createReadStream(csvPath) });
  let lineNo = 0;
  for await (const line of reader) {
    lineNo++;
    if (lineNo === 1) continue;
    const row = parseCsvLine(line);
    const officeCode = officeCodeFromOpenElectionsOffice(row[2], row[3]);
    if (!officeCode) continue;
    const party = partyFromOpenElections(row[4]);
    const name = String(row[5] ?? "").trim();
    const votes = Number(row[6] ?? 0);
    addVotes(map, officeCode, party, name, votes);
  }
  return map;
}

function mergeVoteMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, votes] of map) {
      merged.set(key, Math.max(merged.get(key) ?? 0, votes));
    }
  }
  return merged;
}

function findVotesForCandidate(voteMap, officeCode, party, candidateName) {
  const target = normalizeName(candidateName);
  if (!target) return null;

  let best = null;
  for (const [key, votes] of voteMap) {
    const [code, rowParty, rowName] = key.split("|");
    if (code !== officeCode || rowParty !== party) continue;
    if (rowName === target || rowName.includes(target) || target.includes(rowName)) {
      if (best == null || votes > best) best = votes;
    }
  }
  return best;
}

function ensureCapitolReturnsCsv() {
  const returnsPath = path.join(DATA_DIR, "2022_General_Election_Returns.csv");
  if (fs.existsSync(returnsPath)) return returnsPath;

  const zipPath = path.join(DATA_DIR, "2022-general-vtds.zip");
  if (!fs.existsSync(zipPath)) {
    console.log("Downloading 2022 Capitol general election zip…");
    execSync(`curl.exe -L -o "${zipPath}" "${CAPITOL_RETURNS_URL}"`, { stdio: "inherit" });
  }

  console.log("Extracting 2022_General_Election_Returns.csv…");
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/\\/g, "\\\\")}'); $e=$z.GetEntry('2022_General_Election_Returns.csv'); [IO.Compression.ZipFileExtensions]::ExtractToFile($e,'${returnsPath.replace(/\\/g, "\\\\")}', $true); $z.Dispose()"`,
    { stdio: "inherit" }
  );
  return returnsPath;
}

function ensureOpenElectionsCsv() {
  const oePath = path.join(DATA_DIR, "oe-2022-general.csv");
  if (fs.existsSync(oePath)) return oePath;
  console.log("Downloading OpenElections 2022 general precinct file…");
  execSync(`curl.exe -L -o "${oePath}" "${OE_GENERAL_URL}"`, { stdio: "inherit" });
  return oePath;
}

export async function buildLegVoteLookup() {
  const capitolPath = ensureCapitolReturnsCsv();
  const oePath = ensureOpenElectionsCsv();
  const capitol = await aggregateCapitolReturnsVotes(capitolPath);
  const oe = await aggregateOpenElectionsVotes(oePath);
  return mergeVoteMaps(capitol, oe);
}

export async function backfillLegContestVotes(db, { metricKeys = ["leg_2022", "leg_2024"] } = {}) {
  const voteMap = await buildLegVoteLookup();
  const contests = await db
    .prepare(
      `SELECT c.id, c.office_id, c.metric_key, c.candidate_name, c.party, c.votes,
              o.office_code
       FROM metric_contest_candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE c.metric_key IN (${metricKeys.map(() => "?").join(", ")})
         AND (c.votes IS NULL OR c.votes = 0)
       ORDER BY o.office_code, c.metric_key, c.sort_order`
    )
    .all(...metricKeys);

  const update = db.prepare(`UPDATE metric_contest_candidates SET votes = @votes WHERE id = @id`);
  let updatedRows = 0;
  const touched = new Set();

  for (const row of contests) {
    const votes = findVotesForCandidate(voteMap, row.office_code, row.party, row.candidate_name);
    if (votes == null || votes <= 0) continue;
    await update.run({ id: row.id, votes });
    updatedRows += 1;
    touched.add(`${row.office_id}|${row.metric_key}`);
  }

  for (const key of touched) {
    const [officeId, metricKey] = key.split("|");
    await recomputeOfficeMetric(db, Number(officeId), metricKey);
  }

  return { updatedRows, contests: touched.size, lookupKeys: voteMap.size };
}

/** Fill null-vote TED contests from aggregated Capitol / OpenElections data. */
export function enrichContestVotesFromLookup(contest, officeCode, voteMap) {
  if (!contest || !voteMap?.size) return contest;
  let total = 0;
  for (const candidate of contest.candidates) {
    if (candidate.votes != null && candidate.votes > 0) {
      total += candidate.votes;
      continue;
    }
    const votes = findVotesForCandidate(voteMap, officeCode, candidate.party, candidate.name);
    if (votes != null && votes > 0) {
      candidate.votes = votes;
      total += votes;
    }
  }
  if (total > 0) {
    for (const candidate of contest.candidates) {
      if (candidate.votes != null && candidate.votes > 0) {
        candidate.vote_pct = candidate.votes / total;
      }
    }
  }
  return contest;
}
