import { extractPdfText } from "./fortBendEvRosterParse.mjs";
import { toIsoDateKey } from "./evRosterDateMatch.mjs";
import { partyTagForRosterRow } from "./evRosterNormalize.mjs";

const VUID_10 = /^\d{10}$/;
const BBM_ROW_RE =
  /^(\d{10})\s+(.+?)\s+(REPUBLICAN|DEMOCRATIC|REP|DEM)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+Received\s+(.+)$/i;
const EV_ROW_RE = /^(.+?)\s+(\d{10})\s+(\S+(?:\s+\S+)*?)\s+(REP|DEM)\s*$/i;

export function isBexarBbmRosterPdfText(text) {
  const t = String(text ?? "");
  return /\bBallot\s+Received\s+Date\b/i.test(t) && /\bVUID\b/i.test(t) && /\bBallot\s+Status\b/i.test(t);
}

export function isBexarEvRosterPdfText(text) {
  const t = String(text ?? "");
  return (
    /\bName\b/i.test(t) &&
    /\bVUID\b/i.test(t) &&
    /\bPrecinct\b/i.test(t) &&
    /\bParty\b/i.test(t) &&
    !/\bBallot\s+Received\s+Date\b/i.test(t)
  );
}

export function isBexarRosterPdfText(text) {
  return isBexarBbmRosterPdfText(text) || isBexarEvRosterPdfText(text);
}

/**
 * @param {string} text
 * @param {{ defaultCounty?: string, methodHint?: string, filePartyScope?: string, pullParty?: string, votingDate?: string }} [opts]
 */
export function parseBexarBbmRosterPdfText(text, opts = {}) {
  const defaultCounty = String(opts.defaultCounty ?? "BEXAR").toUpperCase();
  const methodHint = String(opts.methodHint ?? "AB").toUpperCase() || "AB";
  const filePartyScope = opts.filePartyScope ?? "COMBINED";
  const pullParty = opts.pullParty ?? "";

  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^--\s*\d+\s+of\s+\d+\s*--$/i.test(line)) continue;
    if (/^VUID\b/i.test(line)) continue;
    const m = line.match(BBM_ROW_RE);
    if (!m) continue;
    const party = normalizeBexarParty(m[3]);
    rows.push({
      vuid: m[1],
      voterName: m[2].trim(),
      party,
      precinct: m[5].trim(),
      activityDate: toIsoDateKey(m[4]) || m[4],
      county: defaultCounty,
      votingMethod: methodHint,
    });
  }

  return rows.map((r) =>
    mapBexarRow(r, defaultCounty, methodHint, filePartyScope, pullParty),
  );
}

/**
 * @param {string} text
 * @param {{ defaultCounty?: string, methodHint?: string, filePartyScope?: string, pullParty?: string, votingDate?: string }} [opts]
 */
export function parseBexarEvRosterPdfText(text, opts = {}) {
  const defaultCounty = String(opts.defaultCounty ?? "BEXAR").toUpperCase();
  const methodHint = String(opts.methodHint ?? "EV").toUpperCase() || "EV";
  const filePartyScope = opts.filePartyScope ?? "COMBINED";
  const pullParty = opts.pullParty ?? "";
  const activityDate = toIsoDateKey(opts.votingDate ?? "");

  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^--\s*\d+\s+of\s+\d+\s*--$/i.test(line)) continue;
    if (/^Name\b/i.test(line) && /\bVUID\b/i.test(line)) continue;

    const m = line.match(EV_ROW_RE);
    if (!m || !VUID_10.test(m[2])) continue;
    const party = normalizeBexarParty(m[4]);
    rows.push({
      vuid: m[2],
      voterName: m[1].trim(),
      precinct: m[3].trim(),
      party,
      activityDate,
      county: defaultCounty,
      votingMethod: methodHint,
    });
  }

  return rows.map((r) =>
    mapBexarRow(r, defaultCounty, methodHint, filePartyScope, pullParty),
  );
}

/**
 * @param {Buffer} buffer
 * @param {Parameters<typeof parseBexarBbmRosterPdfText>[1]} [opts]
 */
export async function parseBexarRosterPdf(buffer, opts = {}) {
  const text = await extractPdfText(buffer);
  if (isBexarBbmRosterPdfText(text)) {
    return parseBexarBbmRosterPdfText(text, { ...opts, methodHint: opts.methodHint ?? "AB" });
  }
  if (isBexarEvRosterPdfText(text)) {
    return parseBexarEvRosterPdfText(text, { ...opts, methodHint: opts.methodHint ?? "EV" });
  }
  throw new Error("PDF does not match Bexar BBM or early-voting roster layout.");
}

function normalizeBexarParty(raw) {
  const p = String(raw ?? "").trim().toUpperCase();
  if (p.startsWith("REP")) return "REP";
  if (p.startsWith("DEM")) return "DEM";
  return p;
}

function mapBexarRow(row, defaultCounty, methodHint, filePartyScope, pullParty) {
  const party = partyTagForRosterRow(row, filePartyScope, pullParty) || row.party;
  return {
    vuid: String(row.vuid ?? ""),
    county: String(row.county ?? defaultCounty).toUpperCase(),
    voterName: row.voterName ?? null,
    party,
    precinct: row.precinct ?? null,
    activityDate: row.activityDate ?? null,
    votingMethod: methodHint,
  };
}

export { extractPdfText };
