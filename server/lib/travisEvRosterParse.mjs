import * as XLSX from "xlsx";
import { entryMatchesVotingDate, toIsoDateKey } from "./evRosterDateMatch.mjs";
import { normalizeParty } from "./evRosterNormalize.mjs";

/** Travis daily roster files: `5.18.2026 Early Vote.xlsx` */
export const TRAVIS_ROSTER_ENTRY_RE = /^\d{1,2}\.\d{1,2}\.\d{4}\s+.+\.xlsx$/i;

/**
 * @param {string[]} entryNames
 */
export function isTravisRosterZip(entryNames) {
  const files = entryNames.filter((n) => TRAVIS_ROSTER_ENTRY_RE.test(String(n ?? "").trim()));
  return files.length > 0 && files.length >= entryNames.filter((n) => /\.xlsx$/i.test(n)).length * 0.5;
}

/**
 * @param {string} entryName
 */
export function parseIsoDateFromTravisFilename(entryName) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(entryName ?? "").trim());
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/**
 * @param {string} entryName
 * @returns {'EV' | 'AB' | 'ED' | ''}
 */
export function travisMethodFromEntryName(entryName) {
  const n = String(entryName ?? "").toLowerCase();
  if (/\bballot\s*by\s*mail\b|\bbbm\b/.test(n)) return "AB";
  if (/\belection\s*day\b/.test(n)) return "ED";
  if (/\bearly\s*vote\b/.test(n)) return "EV";
  return "";
}

/**
 * @param {string} sheetName
 */
export function travisPartyFromSheetName(sheetName) {
  const party = normalizeParty(sheetName);
  return party === "REP" || party === "DEM" ? party : "";
}

/**
 * @param {string} method EV | AB
 * @param {string} scope ALL | EV | AB | ED
 */
export function travisEntryMatchesMethodScope(entryName, scope) {
  const want = String(scope ?? "ALL").toUpperCase();
  if (want === "ALL") return true;
  const method = travisMethodFromEntryName(entryName);
  if (!method) return false;
  return method === want;
}

/**
 * One file per calendar day + method; prefer `*_UPDATED.xlsx` when both exist.
 * @param {string[]} entryNames
 */
export function dedupeTravisEntriesByDate(entryNames) {
  /** @type {Map<string, string>} */
  const byDayMethod = new Map();
  const sorted = [...entryNames].sort((a, b) => a.localeCompare(b));
  for (const name of sorted) {
    const iso = parseIsoDateFromTravisFilename(name);
    const method = travisMethodFromEntryName(name);
    if (!iso || !method) continue;
    const key = `${iso}|${method}`;
    const prev = byDayMethod.get(key);
    if (!prev) {
      byDayMethod.set(key, name);
      continue;
    }
    if (/_UPDATED/i.test(name) && !/_UPDATED/i.test(prev)) {
      byDayMethod.set(key, name);
    }
  }
  return [...byDayMethod.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {Buffer} buffer
 * @param {string} entryName
 * @param {string} defaultCounty
 * @param {{ methodHint?: string, activityDate?: string, filePartyScope?: string, pullParty?: string }} opts
 */
export function parseTravisRosterXlsx(buffer, entryName, defaultCounty, opts = {}) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const activityDate = opts.activityDate || parseIsoDateFromTravisFilename(entryName);
  const methodHint = opts.methodHint || travisMethodFromEntryName(entryName) || "";
  const filePartyScope = opts.filePartyScope ?? "COMBINED";
  const pullParty = opts.pullParty ?? "";

  /** @type {Array<Record<string, unknown>>} */
  const out = [];

  for (const sheetName of wb.SheetNames ?? []) {
    const sheetParty = travisPartyFromSheetName(sheetName) || "";

    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "", raw: false });
    const headerRowIdx = matrix.findIndex((row) =>
      (row ?? []).some((cell) => String(cell ?? "").toUpperCase().trim() === "VUID"),
    );
    if (headerRowIdx < 0) continue;

    const headers = (matrix[headerRowIdx] ?? []).map((h) => String(h ?? "").trim());
    for (let i = headerRowIdx + 1; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row?.length || row.every((c) => c === "" || c == null)) continue;
      /** @type {Record<string, unknown>} */
      const obj = { PARTY: sheetParty, activityDate };
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c];
        if (!key) continue;
        obj[key] = row[c];
      }
      const vuid = String(obj.VUID ?? "").trim();
      if (!vuid || !/^\d+$/.test(vuid)) continue;

      const party =
        filePartyScope === "REP_ONLY"
          ? "REP"
          : filePartyScope === "DEM_ONLY"
            ? "DEM"
            : sheetParty;

      if (pullParty && normalizeParty(pullParty) && party !== normalizeParty(pullParty)) continue;

      out.push({
        vuid,
        county: String(defaultCounty).toUpperCase(),
        voterName: [obj["First Name"], obj["Last Name"]].filter(Boolean).join(" ").trim(),
        votingMethod: methodHint,
        precinct: String(obj.PCT ?? obj.Precinct ?? "").trim(),
        party,
        activityDate,
      });
    }
  }

  return out;
}

/**
 * @param {import('jszip')} zip
 * @param {import('./evRosterFileParse.mjs').RosterParseOptions} parseOpts
 */
export async function parseTravisRosterZip(zip, parseOpts) {
  const dateScope = String(parseOpts.dateScope ?? "SINGLE_DAY").toUpperCase();
  const votingDate = toIsoDateKey(parseOpts.votingDate ?? "");
  const methodScope = String(parseOpts.votingMethodScope ?? "ALL").toUpperCase();
  const defaultCounty = String(parseOpts.defaultCounty ?? "TRAVIS").toUpperCase();
  const filePartyScope = parseOpts.filePartyScope ?? "COMBINED";
  const pullParty = parseOpts.pullParty ?? "";

  let entries = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir && TRAVIS_ROSTER_ENTRY_RE.test(n))
    .sort();

  if (!entries.length) throw new Error("ZIP contains no Travis-style daily roster .xlsx files");

  if (dateScope === "SINGLE_DAY" && votingDate) {
    const byDate = entries.filter((n) => entryMatchesVotingDate(n, votingDate));
    if (byDate.length) entries = byDate;
  }

  entries = entries.filter((n) => travisEntryMatchesMethodScope(n, methodScope));
  entries = dedupeTravisEntriesByDate(entries);

  if (!entries.length) {
    throw new Error(
      `No Travis roster files matched date ${votingDate || "(any)"} and method scope ${methodScope}.`,
    );
  }

  /** @type {Array<Record<string, unknown>>} */
  const all = [];
  for (const name of entries) {
    const buf = await zip.file(name).async("nodebuffer");
    const activityDate = parseIsoDateFromTravisFilename(name);
    const rows = parseTravisRosterXlsx(buf, name, defaultCounty, {
      activityDate,
      methodHint: travisMethodFromEntryName(name),
      filePartyScope,
      pullParty,
    });
    all.push(...rows);
  }

  if (dateScope === "SINGLE_DAY" && votingDate && !all.length) {
    throw new Error(`No Travis roster voters for ${votingDate} (${methodScope}).`);
  }

  return all;
}
