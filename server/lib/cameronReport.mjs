import { PDFParse } from "pdf-parse";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";
import { fetchCollinElectionwarePdfAllContests } from "./collinReport.mjs";
import { fetchDallasElectionwarePdfAllContests } from "./dallasReport.mjs";

const CAMERON_SAMPLE_RECON_PDF_URL =
  "https://www.cameroncountytx.gov/elections/wp-content/uploads/2026/03/P26-preliminary-reconciliation-REP.pdf";

/**
 * @param {string} line
 */
function repairOcrDigits(line) {
  return String(line ?? "")
    .replace(/[sS]/g, "5")
    .replace(/[oO]/g, "0")
    .replace(/[tT]/g, "1")
    .replace(/[lI|]/g, "1");
}

function parseGarbledCount(line) {
  const s = String(line ?? "").trim();
  if (!s) return null;

  const repaired = repairOcrDigits(s);
  const repairedDigits = repaired.replace(/\D/g, "");
  if (repairedDigits.length >= 3 && repairedDigits.length <= 7) {
    const n = Number(repairedDigits);
    if (n >= 100) return n;
  }

  const letterOcr = s.match(/^(\d{1,3})\s*,\s*(\d)\D+(\d{1,2})\s*$/);
  if (letterOcr) {
    const tail = `${letterOcr[2]}${letterOcr[3].padStart(2, "0")}`;
    return Number(`${letterOcr[1]}${tail.padStart(3, "0")}`);
  }

  const sDigit = s.match(/^(\d)\s*s\s*(\d{2,3})\s*$/i);
  if (sDigit) return Number(`${sDigit[1]}${sDigit[2]}`);

  const commaIdx = s.indexOf(",");
  if (commaIdx >= 0) {
    const before = s.slice(0, commaIdx).replace(/\D/g, "");
    const after = s.slice(commaIdx + 1).replace(/\D/g, "");
    if (before && after.length >= 2) {
      return Number(before + after.padEnd(3, "0").slice(0, 3));
    }
  }

  const digits = s.replace(/\D/g, "");
  if (digits.length >= 2 && digits.length <= 7) return Number(digits);
  return null;
}

/**
 * @param {string[]} lines
 * @param {RegExp} sectionStart
 * @param {RegExp} countLabel
 */
function readCountAfterSection(lines, sectionStart, countLabel) {
  const start = lines.findIndex((l) => sectionStart.test(l));
  if (start < 0) return null;
  for (let i = start; i < Math.min(start + 10, lines.length); i++) {
    if (!countLabel.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const n = parseGarbledCount(lines[j]);
      if (n != null && n >= 10) return n;
    }
  }
  return null;
}

/** @param {string} url */
function partyFromCameronUrl(url) {
  const u = String(url ?? "").toLowerCase();
  if (/\brep\b|republican|-rep\b|_rep\b/i.test(u)) return "REP";
  if (/\bdem\b|democrat|-dem\b|_dem\b/i.test(u)) return "DEM";
  return "";
}

/** @param {string} url */
function electionLabelFromCameronUrl(url) {
  const party = partyFromCameronUrl(url);
  const partyLabel = party === "REP" ? "Republican" : party === "DEM" ? "Democratic" : "";
  if (/reconciliation/i.test(url)) {
    return partyLabel
      ? `Cameron County — ${partyLabel} preliminary reconciliation`
      : "Cameron County — preliminary reconciliation";
  }
  return partyLabel ? `Cameron County — ${partyLabel} results` : "Cameron County results";
}

async function fetchCameronPdfBuffer(pdfUrl) {
  const url = String(pdfUrl ?? "").trim();
  if (!url) throw new Error("Cameron County PDF URL is required");

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
      },
    });
    if (!res.ok) throw new Error(`Cameron County PDF HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assertLikelyPdf(buf, { url, contentType: res.headers.get("content-type") });
    if (buf.length > 500) return buf;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw new Error("Cameron County PDF empty or too small after retries");
}

/**
 * Texas SOS Form 12-1 / §127.131(f) preliminary reconciliation (Cameron posts as P26-*-reconciliation-*.pdf).
 * @param {string} pdfUrl
 */
export async function fetchCameronPreliminaryReconciliationPdf(pdfUrl = CAMERON_SAMPLE_RECON_PDF_URL) {
  const buf = await fetchCameronPdfBuffer(pdfUrl);
  const parser = new PDFParse({ data: buf });
  let pdfText;
  try {
    pdfText = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const text = String(pdfText?.text ?? "");
  if (!/127\.131|Preliminary Election Reconciliation/i.test(text)) {
    throw new Error("PDF is not a Cameron/SOS preliminary reconciliation form");
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const inPersonBallotsCounted = readCountAfterSection(
    lines,
    /^G\.\s*/i,
    /ballots counted/i,
  );
  const mailBallotsCounted = readCountAfterSection(lines, /^H\.\s*Mail/i, /ballots counted/i);
  const totalBallotsCounted = readCountAfterSection(lines, /^l\.\s*Total|^I\.\s*Total/i, /ballots counted/i);

  const inPerson =
    inPersonBallotsCounted ??
    parseGarbledCount(lines.find((l, i) => i > 0 && /^G\./i.test(lines[i - 1]) && /counted/i.test(l)) ?? "");
  const mail = mailBallotsCounted ?? null;
  const total =
    totalBallotsCounted ??
    (inPerson != null && mail != null ? inPerson + mail : null);

  if (inPerson == null && mail == null && total == null) {
    throw new Error("Could not parse ballot counts from Cameron preliminary reconciliation PDF");
  }

  const label = electionLabelFromCameronUrl(pdfUrl);
  const party = partyFromCameronUrl(pdfUrl);
  const early = (inPerson ?? 0) + (mail ?? 0);
  const totalVotes = total ?? early;

  const rows = [
    {
      lineNumber: 1,
      contestName: label,
      choiceName: "In-person ballots counted",
      partyName: party,
      earlyVotes: inPerson ?? 0,
      electionDayVotes: 0,
      totalVotes: inPerson ?? 0,
      percentOfVotes: "0.00",
      registeredVoters: 0,
      ballotsCast: totalVotes,
      precinctTotal: 0,
      precinctReporting: 0,
      overVotes: 0,
      underVotes: 0,
    },
    {
      lineNumber: 2,
      contestName: label,
      choiceName: "Mail ballots counted",
      partyName: party,
      earlyVotes: mail ?? 0,
      electionDayVotes: 0,
      totalVotes: mail ?? 0,
      percentOfVotes: "0.00",
      registeredVoters: 0,
      ballotsCast: totalVotes,
      precinctTotal: 0,
      precinctReporting: 0,
      overVotes: 0,
      underVotes: 0,
    },
  ];

  return {
    source: {
      id: "county-cameron",
      type: "county",
      county: "Cameron",
      documentType: "preliminary_reconciliation",
      pdfUrl: String(pdfUrl ?? "").trim(),
      inPersonBallotsCounted: inPerson,
      mailBallotsCounted: mail,
      totalBallotsCounted: totalVotes,
    },
    rows,
    reconciliationOnly: true,
    rowCount: rows.length,
  };
}

/**
 * Cameron County PDF: Electionware summary (if posted) or SOS preliminary reconciliation PDF.
 * @param {string} [pdfUrl]
 */
export async function fetchCameronCountyResultsPdf(pdfUrl = CAMERON_SAMPLE_RECON_PDF_URL) {
  const url = String(pdfUrl ?? "").trim();

  try {
    const coll = await fetchCollinElectionwarePdfAllContests(url);
    return { ...coll, source: { ...coll.source, county: "Cameron", documentType: "electionware_summary" } };
  } catch {
    /* not Collin-style Electionware */
  }

  try {
    const dal = await fetchDallasElectionwarePdfAllContests(url);
    return { ...dal, source: { ...dal.source, county: "Cameron", documentType: "electionware_summary" } };
  } catch {
    /* not Dallas-style Electionware */
  }

  return fetchCameronPreliminaryReconciliationPdf(url);
}
