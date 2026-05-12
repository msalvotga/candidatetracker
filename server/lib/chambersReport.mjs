import { PDFParse } from "pdf-parse";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

const CHAMBERS_CUMULATIVE_PDF_URL =
  "https://www.chamberscountytx.gov/DocumentCenter/View/6746/ED-Cumulative-Results-Unofficial---Republican-WM-PDF";
const SD4_REGEX = /state\s+senator,?\s*district\s*(?:no\.?\s*)?\s*4/i;

function asNum(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function fetchChambersSd4Summary(pdfUrl = CHAMBERS_CUMULATIVE_PDF_URL) {
  const res = await fetch(pdfUrl, {
    headers: {
      Accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
    },
  });
  if (!res.ok) throw new Error(`Chambers cumulative PDF HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  assertLikelyPdf(buf, {
    url: pdfUrl,
    contentType: res.headers.get("content-type"),
  });

  const parser = new PDFParse({ data: buf });
  let pdfText;
  try {
    pdfText = await parser.getText();
  } catch (e) {
    const msg = String(e?.message ?? e);
    throw new Error(
      `Chambers cumulative PDF could not be parsed (${pdfUrl}): ${msg}. Confirm the URL points at a valid PDF.`,
    );
  } finally {
    await parser.destroy();
  }
  const text = String(pdfText?.text ?? "");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const contestLine = lines.find((l) => SD4_REGEX.test(l));
  if (!contestLine) throw new Error("Chambers SD4 contest not found in cumulative PDF");

  let precinctReporting = 0;
  let precinctTotal = 0;
  const prIdx = lines.findIndex((l) => /^Precincts Reporting$/i.test(l));
  if (prIdx >= 0) {
    const m = String(lines[prIdx + 1] ?? "").match(/(\d+)\s+of\s+(\d+)/i);
    if (m) {
      precinctReporting = asNum(m[1]);
      precinctTotal = asNum(m[2]);
    }
  }

  /** Absentee | Early | Election Day | Total; counts may include commas. */
  const candidateLineNoPartyRegex =
    /^(.+?)\s+([\d,]+)\s+\d+\.\d+%\s+([\d,]+)\s+\d+\.\d+%\s+([\d,]+)\s+\d+\.\d+%\s+([\d,]+)\s+\d+\.\d+%$/i;
  const contestParty = /REPUBLICAN/i.test(contestLine) ? "REP" : /DEMOCRAT/i.test(contestLine) ? "DEM" : "";
  const contestIdx = lines.indexOf(contestLine);
  const rows = [];
  for (let i = contestIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^Cast Votes:/i.test(line) || /^\*{3}\s*End of report/i.test(line)) break;
    if (/^Choice\s+Party/i.test(line)) continue;
    const m = line.match(candidateLineNoPartyRegex);
    if (!m) continue;
    const name = String(m[1] ?? "").trim();
    const absentee = asNum(m[2]);
    const early = asNum(m[3]);
    const electionDay = asNum(m[4]);
    const total = asNum(m[5]);
    rows.push({
      lineNumber: rows.length + 1,
      contestName: contestLine,
      choiceName: name,
      partyName: contestParty,
      earlyVotes: absentee + early,
      electionDayVotes: electionDay,
      totalVotes: total,
      percentOfVotes: "0.00",
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal,
      precinctReporting,
      overVotes: 0,
      underVotes: 0,
    });
  }
  if (!rows.length) throw new Error("No Chambers candidate rows parsed from cumulative PDF");

  return {
    source: {
      id: "county-chambers",
      type: "county",
      county: "Chambers",
      contest: contestLine,
      pdfUrl,
    },
    rows,
    totals: {
      candidateVotes: rows.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal,
      precinctReporting,
    },
    rowCount: rows.length,
  };
}
