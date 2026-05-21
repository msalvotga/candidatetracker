import { PDFParse } from "pdf-parse";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";
import { toIsoDateKey } from "./evRosterDateMatch.mjs";
import { partyTagForRosterRow } from "./evRosterNormalize.mjs";

const VUID_LINE_RE = /^(\d{10})\s/;
const DATE_PARTY_LINE_RE = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(REP|DEM)\b/i;
const REPORT_DATE_RE = /\b([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/;

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfText(buffer) {
  assertLikelyPdf(buffer, {});
  const parser = new PDFParse({ data: buffer });
  try {
    const pdfText = await parser.getText();
    return String(pdfText?.text ?? "");
  } finally {
    await parser.destroy();
  }
}

/**
 * Fort Bend BBM PDFs list VUIDs first, then a parallel "Return Date / Party" block.
 * @param {string} text
 * @param {{ defaultCounty?: string, methodHint?: string, filePartyScope?: string, pullParty?: string }} [opts]
 */
export function parseFortBendRosterPdfText(text, opts = {}) {
  const defaultCounty = String(opts.defaultCounty ?? "FORT BEND").toUpperCase();
  const methodHint = String(opts.methodHint ?? "AB").toUpperCase() || "AB";
  const filePartyScope = opts.filePartyScope ?? "COMBINED";
  const pullParty = opts.pullParty ?? "";

  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^--\s*\d+\s+of\s+\d+\s*--$/i.test(l));

  const returnHeaderIdx = lines.findIndex((l) => /^Return Date\s+Ballot\s+Party/i.test(l));
  const mailLines = returnHeaderIdx >= 0 ? lines.slice(0, returnHeaderIdx) : lines;
  const returnLines = returnHeaderIdx >= 0 ? lines.slice(returnHeaderIdx + 1) : [];

  /** @type {string[]} */
  const vuids = [];
  for (const line of mailLines) {
    if (/^VUID\b/i.test(line)) continue;
    const m = line.match(VUID_LINE_RE);
    if (m) vuids.push(m[1]);
  }

  /** @type {Array<{ activityDate: string, party: string }>} */
  const returns = [];
  for (const line of returnLines) {
    const m = line.match(DATE_PARTY_LINE_RE);
    if (!m) continue;
    returns.push({
      activityDate: toIsoDateKey(m[1]) || m[1],
      party: m[2].toUpperCase(),
    });
  }

  const reportDate = extractReportDateFromText(text);

  if (vuids.length && returns.length === vuids.length) {
    return vuids.map((vuid, i) =>
      mapFortBendRow(
        {
          vuid,
          activityDate: returns[i].activityDate,
          party: returns[i].party,
        },
        defaultCounty,
        methodHint,
        filePartyScope,
        pullParty,
      ),
    );
  }

  return vuids.map((vuid) =>
    mapFortBendRow(
      {
        vuid,
        activityDate: reportDate ?? "",
        party: "",
      },
      defaultCounty,
      methodHint,
      filePartyScope,
      pullParty,
    ),
  );
}

function extractReportDateFromText(text) {
  const m = REPORT_DATE_RE.exec(String(text ?? ""));
  if (!m) return "";
  const month = m[1];
  const day = m[2];
  const year = m[3];
  const parsed = new Date(`${month} ${day}, ${year}`);
  if (Number.isNaN(parsed.getTime())) return "";
  return toIsoDateKey(parsed.toISOString().slice(0, 10));
}

function mapFortBendRow(fields, defaultCounty, methodHint, filePartyScope, pullParty) {
  const party = partyTagForRosterRow(
    { Party: fields.party, PARTY: fields.party },
    filePartyScope,
    pullParty,
  );
  return {
    vuid: fields.vuid,
    county: defaultCounty,
    voterName: "",
    votingMethod: methodHint,
    precinct: "",
    party,
    activityDate: fields.activityDate ?? "",
  };
}

/**
 * @param {Buffer} buffer
 * @param {import("./evRosterFileParse.mjs").RosterParseOptions} parseOpts
 */
export async function parseFortBendRosterPdf(buffer, parseOpts) {
  const text = await extractPdfText(buffer);
  if (!/Return Date\s+Ballot\s+Party/i.test(text) || !/\bVUID\b/i.test(text)) {
    throw new Error(
      "PDF does not look like a Fort Bend BBM roster (expected VUID block and Return Date / Party section).",
    );
  }
  const methodHint =
    String(parseOpts.votingMethodScope ?? "").toUpperCase() === "ALL"
      ? "AB"
      : String(parseOpts.votingMethodScope ?? "AB").toUpperCase();
  return parseFortBendRosterPdfText(text, {
    defaultCounty: parseOpts.defaultCounty,
    methodHint,
    filePartyScope: parseOpts.filePartyScope ?? "COMBINED",
    pullParty: parseOpts.pullParty ?? "",
  });
}

/**
 * @param {string} text
 */
export function isFortBendRosterPdfText(text) {
  return /\bVUID\b/i.test(text) && /Return Date\s+Ballot\s+Party/i.test(text);
}
