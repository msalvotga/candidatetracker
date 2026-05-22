import { PDFParse } from "pdf-parse";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

const HARRIS_CUMULATIVE_PDF_URL = "https://appfiles.harrisvotes.com/harrisvotes/prd/Data/5226/cumulative.pdf";
const HARRIS_CONTEST_REGEX = /state senate,\s*district\s*4(?:\s*-\s*unexpired term)?/i;

function asNum(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function fetchHarrisSd4Summary(pdfUrl = HARRIS_CUMULATIVE_PDF_URL) {
  const res = await fetch(pdfUrl, {
    headers: {
      Accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
    },
  });
  if (!res.ok) throw new Error(`Harris cumulative PDF HTTP ${res.status}`);

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
      `Harris cumulative PDF could not be parsed (${pdfUrl}): ${msg}. If the URL returns HTML in a browser tab, update the election Data/<id>/cumulative.pdf path in settings.`,
    );
  } finally {
    await parser.destroy();
  }
  const text = String(pdfText?.text ?? "");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const contestLine = lines.find((l) => HARRIS_CONTEST_REGEX.test(l));
  if (!contestLine) throw new Error("Harris SD4 contest not found in cumulative.pdf");

  const precinctLine = lines.find((l) => /^Precincts Reporting$/i.test(l));
  let precinctReporting = 0;
  let precinctTotal = 0;
  if (precinctLine) {
    const idx = lines.indexOf(precinctLine);
    const next = lines[idx + 1] ?? "";
    const m = next.match(/(\d+)\s+of\s+(\d+)/i);
    if (m) {
      precinctReporting = asNum(m[1]);
      precinctTotal = asNum(m[2]);
    }
  }

  const ballotsCastLine = lines.find((l) => /^Ballots Cast$/i.test(l));
  let ballotsCast = 0;
  if (ballotsCastLine) {
    const idx = lines.indexOf(ballotsCastLine);
    ballotsCast = asNum(lines[idx + 1] ?? 0);
  }

  const contestIdx = lines.indexOf(contestLine);
  const rows = [];
  for (let i = contestIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^Cast Votes:/i.test(line) || /^\*{3}\s*End of report/i.test(line)) break;
    if (/^Choice\s+Party/i.test(line)) continue;
    const m = line.match(/^(.+?)\s+(REP|DEM|LIB|GRN|IND)\s+(.*)$/i);
    if (!m) continue;
    const name = String(m[1] ?? "").trim();
    const party = String(m[2] ?? "").trim().toUpperCase();
    const tail = String(m[3] ?? "");
    const nums = [...tail.matchAll(/([\d,]+)\s+\d+(?:\.\d+)?%/g)].map((x) => asNum(x[1]));
    if (nums.length < 2) continue;
    const total = nums[nums.length - 1];
    const cols = nums.slice(0, -1);
    const mail = cols[0] ?? 0;
    const earlyInPerson = cols[1] ?? 0;
    const electionDay = cols[2] ?? 0;
    const evProvisional = cols[3] ?? 0;
    const edProvisional = cols[4] ?? 0;
    const earlyVotes = mail + earlyInPerson + evProvisional;
    const electionDayVotes = electionDay + edProvisional;
    const percent = total > 0 ? ((total / Math.max(ballotsCast, total)) * 100).toFixed(2) : "0.00";
    rows.push({
      lineNumber: rows.length + 1,
      contestName: contestLine,
      choiceName: name,
      partyName: party,
      earlyVotes,
      electionDayVotes,
      totalVotes: total,
      percentOfVotes: percent,
      registeredVoters: 0,
      ballotsCast,
      precinctTotal,
      precinctReporting,
      overVotes: 0,
      underVotes: 0,
    });
  }

  if (!rows.length) throw new Error("No Harris candidate rows parsed from cumulative.pdf");

  return {
    source: {
      id: "county-harrisvotes",
      type: "county",
      county: "Harris",
      contest: contestLine,
      pdfUrl,
    },
    rows,
    totals: {
      candidateVotes: rows.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: 0,
      ballotsCast,
      precinctTotal,
      precinctReporting,
    },
    rowCount: rows.length,
  };
}
