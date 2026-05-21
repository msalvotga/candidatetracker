import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { entryMatchesVotingDate, rowMatchesVotingDate, toIsoDateKey } from "./evRosterDateMatch.mjs";
import { partyTagForRosterRow, rosterRowPassesPartyFilter } from "./evRosterNormalize.mjs";
import { isTravisRosterZip, parseTravisRosterZip } from "./travisEvRosterParse.mjs";

/**
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, contentType: string, fileName: string }>}
 */
const ROSTER_FETCH_HEADERS = {
  Accept: "*/*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export async function fetchRosterFile(url) {
  const res = await fetch(url, {
    headers: ROSTER_FETCH_HEADERS,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get("content-type") ?? "").toLowerCase();
  let fileName = "";
  try {
    const u = new URL(url);
    fileName = u.pathname.split("/").pop() ?? "";
  } catch {
    fileName = "";
  }
  return { buffer, contentType, fileName };
}

/**
 * @param {{ buffer: Buffer, contentType?: string, fileName?: string, fileFormat?: string }} input
 */
export function resolveFileFormat(input) {
  const explicit = String(input.fileFormat ?? "auto").toLowerCase();
  if (explicit && explicit !== "auto") return explicit;
  const name = String(input.fileName ?? "").toLowerCase();
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".xlsx")) return "xlsx";
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".txt") || name.endsWith(".tsv")) return "txt";
  const ct = String(input.contentType ?? "").toLowerCase();
  if (ct.includes("zip")) return "zip";
  if (ct.includes("spreadsheet") || ct.includes("excel")) return "xlsx";
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("csv")) return "csv";
  if (ct.includes("text/plain")) return "txt";
  return "csv";
}

/**
 * @param {{ buffer: Buffer, contentType?: string, fileName?: string, fileFormat?: string }} input
 * @returns {Promise<string>} text for CSV/TXT parsers (single file only)
 */
export async function rosterBufferToText(input) {
  const format = resolveFileFormat(input);
  if (format === "zip") {
    const zip = await JSZip.loadAsync(input.buffer);
    const csvEntry =
      Object.keys(zip.files)
        .filter((n) => !zip.files[n].dir && /\.(csv|txt|tsv)$/i.test(n))
        .sort()[0] ?? null;
    if (!csvEntry) throw new Error("ZIP contains no .csv/.txt roster file");
    return zip.file(csvEntry).async("string");
  }
  const text = input.buffer.toString("utf8");
  if (!text.trim() && input.buffer.length > 0) {
    throw new Error("File is not UTF-8 text; set file format to ZIP or convert to CSV");
  }
  return text;
}

/**
 * @typedef {object} RosterParseOptions
 * @property {string} defaultCounty
 * @property {string} [votingDate] YYYY-MM-DD pull date
 * @property {string} [dateScope] SINGLE_DAY | CUMULATIVE
 * @property {string} [pullParty] REP | DEM — filter combined-party files
 * @property {string} [filePartyScope] COMBINED | REP_ONLY | DEM_ONLY
 * @property {string} [votingMethodScope] ALL | EV | AB | ED — used when file has no method column
 * @property {string} [archiveFileName] outer ZIP/download name for method hints (EV, BBM, etc.)
 */

/**
 * Parse a roster file (CSV/TXT or ZIP of daily files).
 * @param {{ buffer: Buffer, contentType?: string, fileName?: string, fileFormat?: string }} fileInput
 * @param {RosterParseOptions} parseOpts
 */
function effectiveXlsxDateScope(parseOpts, fileName) {
  const scope = String(parseOpts.dateScope ?? "SINGLE_DAY").toUpperCase();
  const name = String(fileName ?? "").toLowerCase();
  if (scope !== "SINGLE_DAY") return scope;
  if (/\bmail[- ]?ballot\b.*\breturn/i.test(name) || /\bballots?\s+returned\b/i.test(name)) {
    return "CUMULATIVE";
  }
  // Dallas posts a dated filename but the workbook lists all in-person voters through that date (DATE VOTED column).
  if (/in-person[- ]?early|early[- ]?voting[- ]?turnout[- ]?details/i.test(name)) {
    return "CUMULATIVE";
  }
  return scope;
}

export async function parseRosterFromFile(fileInput, parseOpts) {
  const format = resolveFileFormat(fileInput);
  if (format === "zip") {
    return parseRosterZip(fileInput.buffer, parseOpts);
  }
  if (format === "xlsx") {
    const dateScope = effectiveXlsxDateScope(parseOpts, fileInput.fileName ?? "");
    const xlsxOpts =
      dateScope !== String(parseOpts.dateScope ?? "").toUpperCase() ? { ...parseOpts, dateScope } : parseOpts;
    const methodHint =
      inferMethodHintFromNames(fileInput.fileName ?? "", xlsxOpts.archiveFileName ?? "") ||
      String(xlsxOpts.votingMethodScope ?? "").toUpperCase();
    return filterRosterRows(
      parseRosterXlsx(fileInput.buffer, xlsxOpts.defaultCounty, rosterTextParseOpts(xlsxOpts, methodHint)),
      xlsxOpts,
    );
  }
  if (format === "pdf") {
    const { extractPdfText } = await import("./fortBendEvRosterParse.mjs");
    const {
      isBexarRosterPdfText,
      isBexarBbmRosterPdfText,
      parseBexarBbmRosterPdfText,
      parseBexarEvRosterPdfText,
    } = await import("./bexarEvRosterParse.mjs");
    const { parseFortBendRosterPdfText, isFortBendRosterPdfText } = await import(
      "./fortBendEvRosterParse.mjs",
    );
    const text = await extractPdfText(fileInput.buffer);
    const methodHint =
      inferMethodHintFromNames(fileInput.fileName ?? "", parseOpts.archiveFileName ?? "") ||
      String(parseOpts.votingMethodScope ?? "AB").toUpperCase();

    if (isBexarRosterPdfText(text)) {
      const parseFn = isBexarBbmRosterPdfText(text)
        ? parseBexarBbmRosterPdfText
        : parseBexarEvRosterPdfText;
      const hint = isBexarBbmRosterPdfText(text) ? "AB" : "EV";
      const rows = parseFn(text, {
        defaultCounty: parseOpts.defaultCounty,
        methodHint: methodHint === "ALL" ? hint : methodHint,
        filePartyScope: parseOpts.filePartyScope ?? "COMBINED",
        pullParty: parseOpts.pullParty ?? "",
        votingDate: parseOpts.votingDate ?? "",
      });
      return filterRosterRows(rows, parseOpts);
    }

    if (!isFortBendRosterPdfText(text)) {
      throw new Error(
        "Unsupported roster PDF layout. Bexar and Fort Bend county roster PDFs are supported.",
      );
    }
    const rows = parseFortBendRosterPdfText(text, {
      defaultCounty: parseOpts.defaultCounty,
      methodHint: methodHint === "ALL" ? "AB" : methodHint,
      filePartyScope: parseOpts.filePartyScope ?? "COMBINED",
      pullParty: parseOpts.pullParty ?? "",
    });
    return filterRosterRows(rows, parseOpts);
  }
  const text = await rosterBufferToText(fileInput);
  const methodHint =
    inferMethodHintFromNames(fileInput.fileName ?? "", parseOpts.archiveFileName ?? "") ||
    String(parseOpts.votingMethodScope ?? "").toUpperCase();
  return filterRosterRows(
    parseRosterText(text, parseOpts.defaultCounty, rosterTextParseOpts(parseOpts, methodHint)),
    parseOpts,
  );
}

function rosterTextParseOpts(parseOpts, methodHint) {
  return {
    methodHint,
    filePartyScope: parseOpts.filePartyScope ?? "COMBINED",
    pullParty: parseOpts.pullParty ?? "",
  };
}

/**
 * @param {Buffer} buffer
 * @param {RosterParseOptions} parseOpts
 */
function inferMethodHintFromNames(...names) {
  const blob = names
    .map((n) => String(n ?? ""))
    .join(" ")
    .toUpperCase();
  if (!blob.trim()) return "";
  if (/\b(BBM|BALLOT\s*BY\s*MAIL)\b/.test(blob)) return "AB";
  if (/\b(CUMULATIVE_)?EV\b|\bEARLY\s*VOT/.test(blob)) return "EV";
  if (/\bELECTION\s*DAY\b|\b_?ED_?\b/.test(blob)) return "ED";
  return "";
}

function effectiveZipDateScope(parseOpts) {
  const scope = String(parseOpts.dateScope ?? "SINGLE_DAY").toUpperCase();
  const archive = String(parseOpts.archiveFileName ?? "").toLowerCase();
  if (scope === "SINGLE_DAY" && /cumulative_(ev|bbm)/i.test(archive)) {
    return "CUMULATIVE";
  }
  return scope;
}

async function parseRosterZip(buffer, parseOpts) {
  const zip = await JSZip.loadAsync(buffer);
  const zipEntryNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (isTravisRosterZip(zipEntryNames)) {
    const rows = await parseTravisRosterZip(zip, parseOpts);
    return filterRosterRows(rows, parseOpts, { skipDateFilter: true });
  }

  const dateScope = effectiveZipDateScope(parseOpts);
  const zipParseOpts = dateScope !== String(parseOpts.dateScope ?? "").toUpperCase()
    ? { ...parseOpts, dateScope }
    : parseOpts;
  const votingDate = toIsoDateKey(zipParseOpts.votingDate ?? "");
  const methodHint =
    inferMethodHintFromNames(zipParseOpts.archiveFileName ?? "") ||
    String(zipParseOpts.votingMethodScope ?? "").toUpperCase();
  const csvEntries = zipEntryNames
    .filter((n) => !zip.files[n].dir && /\.csv$/i.test(n))
    .sort();

  if (!csvEntries.length) throw new Error("ZIP contains no .csv roster files");

  let targets = csvEntries;
  let rowLevelDateFilter = dateScope === "SINGLE_DAY" && !!votingDate;

  if (dateScope === "SINGLE_DAY" && votingDate) {
    const byFilename = csvEntries.filter((n) => entryMatchesVotingDate(n, votingDate));
    if (byFilename.length) {
      targets = byFilename;
      rowLevelDateFilter = false;
    }
  }

  /** @type {ReturnType<typeof mapLooseRow>[]} */
  const all = [];

  for (const name of targets) {
    const text = await zip.file(name).async("string");
    const rows = filterRosterRows(
      parseRosterText(text, zipParseOpts.defaultCounty, rosterTextParseOpts(zipParseOpts, methodHint)),
      zipParseOpts,
      { skipDateFilter: !rowLevelDateFilter },
    );
    all.push(...rows);
  }

  if (dateScope === "SINGLE_DAY" && votingDate && !all.length) {
    throw new Error(
      `No roster rows matched early voting date ${votingDate}. Try Cumulative date scope or check ActivityDate / filenames.`,
    );
  }

  return all;
}

/**
 * @param {ReturnType<typeof mapLooseRow>[]} rows
 * @param {RosterParseOptions} parseOpts
 * @param {{ skipDateFilter?: boolean }} [opts]
 */
function filterRosterRows(rows, parseOpts, opts = {}) {
  const dateScope = String(parseOpts.dateScope ?? "SINGLE_DAY").toUpperCase();
  const votingDate = toIsoDateKey(parseOpts.votingDate ?? "");
  const pullParty = parseOpts.pullParty ?? "";
  const filePartyScope = parseOpts.filePartyScope ?? "COMBINED";

  return rows.filter((row) => {
    if (!row) return false;
    if (!rosterRowPassesPartyFilter(row, filePartyScope, pullParty)) return false;
    if (opts.skipDateFilter || dateScope !== "SINGLE_DAY" || !votingDate) return true;
    return rowMatchesVotingDate(row, votingDate);
  });
}

/**
 * Parse roster text into raw rows (before method tagging).
 * @param {string} text
 * @param {string} defaultCounty
 */
/**
 * @param {Buffer} buffer
 * @param {string} defaultCounty
 * @param {ReturnType<typeof rosterTextParseOpts>} opts
 */
function excelCellToDateString(value) {
  const iso = toIsoDateKey(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return String(value ?? "").trim();
}

export function parseRosterXlsx(buffer, defaultCounty, opts = {}) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "", raw: true });
  const headerRowIdx = matrix.findIndex((row) =>
    (row ?? []).some((cell) => {
      const u = String(cell ?? "").toUpperCase().trim();
      return (
        u === "IDNUMBER" ||
        u === "ID_NUMBER" ||
        u === "VUID" ||
        u === "CERTIFICATENUMBER" ||
        u === "STATEVOTERID" ||
        u === "SOS VOTERID" ||
        u === "COUNTY VOTER ID" ||
        u === "STATE VOTER ID"
      );
    }),
  );
  if (headerRowIdx < 0) return [];
  const headers = (matrix[headerRowIdx] ?? []).map((h) => String(h ?? "").trim());
  /** @type {ReturnType<typeof mapLooseRow>[]} */
  const out = [];
  for (let i = headerRowIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row?.length || row.every((c) => c === "" || c == null)) continue;
    /** @type {Record<string, unknown>} */
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      let val = row[c];
      const keyU = key.toUpperCase();
      if (keyU === "DATE VOTED" || keyU === "VOTEDATE" || keyU.includes("DATE")) {
        val = excelCellToDateString(val);
      }
      obj[key] = val;
    }
    const mapped = mapLooseRow(obj, defaultCounty, opts);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function parseRosterText(text, defaultCounty, opts = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const j = JSON.parse(trimmed);
      const arr = Array.isArray(j) ? j : (j.rows ?? j.voters ?? []);
      return arr.map((r) => mapLooseRow(r, defaultCounty, opts)).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  const firstLine = trimmed.split(/\r?\n/)[0] ?? "";
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes("|") ? "|" : ",";
  const records = parse(trimmed, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    delimiter: delimiter === "|" ? "|" : delimiter === "\t" ? "\t" : ",",
  });
  return records.map((r) => mapLooseRow(r, defaultCounty, opts)).filter(Boolean);
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} names
 */
function pickField(row, names) {
  if (!row || typeof row !== "object") return "";
  for (const n of names) {
    const v = row[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  const keys = Object.keys(row);
  for (const want of names) {
    const wl = want.toLowerCase();
    const k = keys.find((key) => key.replace(/^\uFEFF/, "").toLowerCase() === wl);
    if (k == null) continue;
    const v = row[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function mapLooseRow(r, defaultCounty, opts = {}) {
  if (!r || typeof r !== "object") return null;
  const vuid = pickField(r, [
    "VUID",
    "vuid",
    "StateVoterID",
    "StateVoterId",
    "STATEVOTERID",
    "State Voter ID",
    "STATE VOTER ID",
    "SOS VOTERID",
    "SOS VoterID",
    "County Voter ID",
    "COUNTY VOTER ID",
    "IDNumber",
    "IdNumber",
    "IDNUMBER",
    "ID_NUMBER",
    "ID_VOTER",
    "id_voter",
    "VoterUID",
    "VoterId",
    "Voter ID",
    "CertificateNumber",
    "Certificate Number",
    "CERTIFICATENUMBER",
  ]);
  if (!vuid) return null;
  const filePartyScope = opts.filePartyScope ?? "COMBINED";
  const pullParty = opts.pullParty ?? "";
  const party = partyTagForRosterRow(r, filePartyScope, pullParty);
  const methodHint = String(opts.methodHint ?? "").trim();
  return {
    vuid,
    county: pickField(r, ["COUNTY", "County", "county"]) || String(defaultCounty).toUpperCase(),
    voterName:
      [
        pickField(r, ["First Name", "FIRST NAME", "FIRSTNAME", "FirstName"]),
        pickField(r, ["MIDDLENAME", "MiddleName"]),
        pickField(r, ["Last Name", "LAST NAME", "LASTNAME", "LastName"]),
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || pickField(r, ["VOTER_NAME", "VoterName", "Name", "NAME", "name"]),
    votingMethod:
      pickField(r, ["VOTING_METHOD", "Method", "method", "VoteMethod", "TYPE", "Type"]) || methodHint,
    precinct: pickField(r, ["PRECINCT", "Precinct", "precinct", "PCT"]),
    party,
    activityDate:
      pickField(r, [
        "ActivityDate",
        "Activity Date",
        "DATE VOTED",
        "Date Voted",
        "Return Date",
        "RETURN DATE",
        "Date Returned",
        "DATE",
        "Date",
        "date",
        "VOTING_DATE",
        "VotingDate",
        "VOTE_DATE",
        "EARLY_VOTING_DATE",
        "VoteDate",
        "VOTEDATE",
      ]) ||
      pickField(r, ["Date Printed", "DATE PRINTED"]),
  };
}
