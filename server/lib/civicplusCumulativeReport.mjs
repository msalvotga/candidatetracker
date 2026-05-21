import { PDFParse } from "pdf-parse";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

function asNum(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isCivicplusBannerLine(line) {
  const s = String(line ?? "").trim();
  if (!s) return true;
  if (/^Cumulative Results\s*-/i.test(s)) return true;
  if (/^(Democratic|Republican)\s+Party\s*-\s*Cumulative/i.test(s)) return true;
  if (/^(Democratic|Republican)\s+Party$/i.test(s)) return true;
  if (/^Results$/i.test(s)) return true;
  if (/^Official\d*$/i.test(s)) return true;
  if (/^March \d/i.test(s)) return true;
  if (/^Run Time$/i.test(s)) return true;
  if (/^Run Date$/i.test(s)) return true;
  if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(s)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return true;
  if (/County$/i.test(s) && s.length < 40 && !/\s-\s+/.test(s)) return true;
  if (/^Primary Election$/i.test(s)) return true;
  if (/^Joint Primary Election$/i.test(s)) return true;
  if (/^Page \d+$/i.test(s)) return true;
  if (/^Official Results$/i.test(s)) return true;
  if (/^Registered Voters$/i.test(s)) return true;
  if (/^Precincts Reporting$/i.test(s)) return true;
  if (/^\d[\d,]*\s+of\s+[\d,]+\s*=/.test(s)) return true;
  if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(s)) return true;
  if (/^Choice Party Absentee/i.test(s)) return true;
  if (/^Cast Votes:/i.test(s)) return true;
  if (/^Undervotes:/i.test(s)) return true;
  if (/^Overvotes:/i.test(s)) return true;
  return false;
}

function isCivicplusContestHeader(line) {
  return /\s-\s+(Democratic|Republican)\s+Party$/i.test(String(line ?? "").trim());
}

/**
 * @param {string} line
 */
function parseCivicplusCumulativeCandidateLine(line) {
  const m = String(line ?? "").match(
    /^(.+?)\s+(DEM|REP|LIB|IND|GRN)\s+([\d,]+)\s+(\d+\.\d+)%\s+([\d,]+)\s+(\d+\.\d+)%\s+([\d,]+)\s+(\d+\.\d+)%\s+([\d,]+)\s+(\d+\.\d+)%\s*$/,
  );
  if (!m) return null;
  const choiceName = String(m[1] ?? "").trim();
  if (!choiceName) return null;
  const absentee = asNum(m[3]);
  const early = asNum(m[5]);
  const electionDay = asNum(m[7]);
  const total = asNum(m[9]);
  const pct = String(m[10] ?? "0.00");
  return {
    choiceName,
    partyName: String(m[2] ?? "").trim(),
    absentee,
    early,
    electionDay,
    total,
    pct,
  };
}

async function fetchCivicplusPdfBuffer(pdfUrl, label) {
  const url = String(pdfUrl ?? "").trim();
  if (!url) throw new Error(`${label} cumulative PDF URL is required`);

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
      },
    });
    if (!res.ok) throw new Error(`${label} cumulative PDF HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assertLikelyPdf(buf, { url, contentType: res.headers.get("content-type") });
    if (buf.length > 1000) return buf;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw new Error(`${label} cumulative PDF empty or too small after retries`);
}

/**
 * CivicPlus / eGovlink "Cumulative Results" PDF (Hays, McLennan, etc.).
 * @param {string} pdfUrl
 * @param {{ countyLabel: string, countyId: string, countyNamePattern?: RegExp }} meta
 */
export async function fetchCivicplusCumulativePdfAllContests(pdfUrl, meta) {
  const countyLabel = String(meta?.countyLabel ?? "County").trim();
  const countyId = String(meta?.countyId ?? countyLabel.toLowerCase().replace(/\s+/g, "-"));
  const nameCheck = meta?.countyNamePattern ?? new RegExp(`${countyLabel}|Cumulative Results`, "i");

  const buf = await fetchCivicplusPdfBuffer(pdfUrl, countyLabel);
  const parser = new PDFParse({ data: buf });
  let pdfText;
  try {
    pdfText = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const text = String(pdfText?.text ?? "");
  if (!nameCheck.test(text)) {
    throw new Error(`PDF does not look like a ${countyLabel} cumulative results report`);
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];
  let lineNumber = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!isCivicplusContestHeader(lines[i])) continue;
    const contestName = String(lines[i] ?? "").trim();
    if (!contestName) continue;

    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (isCivicplusContestHeader(line)) break;
      if (isCivicplusBannerLine(line)) {
        j++;
        continue;
      }

      const parsed = parseCivicplusCumulativeCandidateLine(line);
      if (parsed) {
        const { choiceName, partyName, absentee, early, electionDay, total, pct } = parsed;
        const earlyVotes = absentee + early;
        lineNumber += 1;
        rows.push({
          lineNumber,
          contestName,
          choiceName,
          partyName,
          earlyVotes,
          electionDayVotes: electionDay,
          totalVotes: total > 0 ? total : earlyVotes + electionDay,
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

  if (!rows.length) {
    throw new Error(`No ${countyLabel} cumulative candidate rows parsed from PDF`);
  }

  return {
    source: {
      id: `county-${countyId}`,
      type: "county",
      county: countyLabel,
      documentType: "civicplus_cumulative",
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
