import { PDFParse } from "pdf-parse";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

const COLLIN_SAMPLE_PDF_URL =
  "https://www.collincountytx.gov/docs/default-source/elections/election-results/may-2-2026-joint-election-early-voting-summary-report.pdf?sfvrsn=d034db08_4";

function asNum(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isFooterOrBannerLine(line) {
  const s = String(line ?? "").trim();
  if (!s) return true;
  if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(s)) return true;
  if (/^\d+\s+of\s+\d+$/i.test(s)) return true;
  if (/^Summary Results Report$/i.test(s)) return true;
  if (/^Joint General and Special Election$/i.test(s)) return true;
  if (/^UNOFFICIAL RESULTS$/i.test(s)) return true;
  if (/^EV and Mail$/i.test(s)) return true;
  if (/^Collin County$/i.test(s) && s.length < 24) return true;
  if (/^Statistics TOTAL/i.test(s)) return true;
  if (/^Report generated with Electionware/i.test(s)) return true;
  if (/^Election Summary -/i.test(s)) return true;
  if (/^Registered Voters\b/i.test(s)) return true;
  if (/^Ballots Cast\b/i.test(s)) return true;
  if (/^Voter Turnout\b/i.test(s)) return true;
  if (/^Watermark Seal/i.test(s)) return true;
  if (/^Collin County (Seal|Government)/i.test(s)) return true;
  return false;
}

/**
 * Collin Electionware early-voting summary: TOTAL, %, Mail, Early Voting columns.
 * @param {string} line
 */
function parseCollinElectionwareCandidateLine(line) {
  const m = String(line ?? "").match(/^(.+?)\s+([\d,]+)\s+(\d+\.\d+)%\s+([\d,]+)\s+([\d,]+)\s*$/);
  if (!m) return null;
  const choiceName = String(m[1] ?? "").trim();
  if (!choiceName || /^Total Votes Cast$/i.test(choiceName)) return null;
  if (/^Overvotes?$/i.test(choiceName) || /^Undervotes?$/i.test(choiceName)) return null;
  if (/^Contest Totals$/i.test(choiceName)) return null;
  const mail = asNum(m[4]);
  const early = asNum(m[5]);
  const total = asNum(m[2]);
  const pct = String(m[3] ?? "0.00");
  return { choiceName, mail, early, total, pct };
}

async function fetchCollinPdfBuffer(pdfUrl) {
  const url = String(pdfUrl ?? "").trim();
  if (!url) throw new Error("Collin Electionware PDF URL is required");

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
      },
    });
    if (!res.ok) throw new Error(`Collin Electionware PDF HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assertLikelyPdf(buf, { url, contentType: res.headers.get("content-type") });
    if (buf.length > 1000) return buf;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw new Error("Collin Electionware PDF empty or too small after retries");
}

/**
 * Collin County Electionware summary PDF (early voting / mail ballot report).
 * Imports all contests in the file (same spirit as Dallas Electionware PDF).
 *
 * @param {string} [pdfUrl]
 */
export async function fetchCollinElectionwarePdfAllContests(pdfUrl = COLLIN_SAMPLE_PDF_URL) {
  const buf = await fetchCollinPdfBuffer(pdfUrl);
  const parser = new PDFParse({ data: buf });
  let pdfText;
  try {
    pdfText = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const lines = String(pdfText?.text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];
  let lineNumber = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^Vote For \d+$/i.test(lines[i])) continue;

    let t = i - 1;
    while (t >= 0 && isFooterOrBannerLine(lines[t])) t--;
    const contestName = t >= 0 ? String(lines[t] ?? "").trim() : "";
    if (!contestName) continue;

    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (/^Total Votes Cast\b/i.test(line)) {
        j++;
        continue;
      }
      if (/^Contest Totals\b/i.test(line)) break;
      if (/^Vote For \d+$/i.test(line)) break;
      if (isFooterOrBannerLine(line)) {
        j++;
        continue;
      }

      const parsed = parseCollinElectionwareCandidateLine(line);
      if (parsed) {
        const { choiceName, mail, early, total, pct } = parsed;
        const earlyVotes = mail + early;
        lineNumber += 1;
        rows.push({
          lineNumber,
          contestName,
          choiceName,
          partyName: "",
          earlyVotes,
          electionDayVotes: 0,
          totalVotes: total > 0 ? total : earlyVotes,
          percentOfVotes: pct,
          registeredVoters: 0,
          ballotsCast: 0,
          precinctTotal: 0,
          precinctReporting: 0,
          overVotes: 0,
          underVotes: 0,
        });
      }
      j++;
    }
  }

  if (!rows.length) throw new Error("No Collin Electionware candidate rows parsed from PDF");

  return {
    source: {
      id: "county-collin",
      type: "county",
      county: "Collin",
      pdfUrl: String(pdfUrl ?? "").trim(),
    },
    rows,
    totals: {
      candidateVotes: rows.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal: 0,
      precinctReporting: 0,
    },
    rowCount: rows.length,
  };
}
