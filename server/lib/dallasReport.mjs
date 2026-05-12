import { PDFParse } from "pdf-parse";

const DALLAS_SAMPLE_PDF_URL =
  "https://www.dallascountyvotes.org/wp-content/uploads/2025/05/Final-Election-Night-1.pdf";

function asNum(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isFooterOrBannerLine(line) {
  const s = String(line ?? "").trim();
  if (!s) return true;
  if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(s)) return true;
  if (/\bPage\s+\d+\s+of\b/i.test(s)) return true;
  if (/^Summary Results Report$/i.test(s)) return true;
  if (/^Joint and Special Election$/i.test(s)) return true;
  if (/^Final Election Night$/i.test(s)) return true;
  if (/^Electionware County$/i.test(s)) return true;
  if (/^STATISTICS$/i.test(s)) return true;
  if (/^Registered Voters\b/i.test(s)) return true;
  if (/^Ballots Cast\b/i.test(s)) return true;
  if (/^Election Summary\b/i.test(s)) return true;
  if (/^\d+\s+Page\s+\d+\s+of\b/i.test(s)) return true;
  return false;
}

/**
 * Dallas County (Electionware) summary PDFs: five vote columns + trailing %.
 * Columns: EV-In Person, EV-Mail, EV-ED, Provisional, Election Day (see PDF headers).
 */
function parseElectionwareCandidateLine(line) {
  const m = String(line ?? "").match(
    /^(.+?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+(\d+\.\d+)%\s*$/,
  );
  if (!m) return null;
  const choiceName = String(m[1] ?? "").trim();
  if (!choiceName) return null;
  const c1 = asNum(m[2]);
  const c2 = asNum(m[3]);
  const c3 = asNum(m[4]);
  const c4 = asNum(m[5]);
  const c5 = asNum(m[6]);
  const pct = String(m[7] ?? "0.00");
  return { choiceName, c1, c2, c3, c4, c5, pct };
}

async function fetchDallasPdfBuffer(pdfUrl) {
  const url = String(pdfUrl ?? "").trim();
  if (!url) throw new Error("Dallas Electionware PDF URL is required");

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/pdf, application/octet-stream;q=0.9, */*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
      },
    });
    if (!res.ok) throw new Error(`Dallas Electionware PDF HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 1000) return buf;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw new Error("Dallas Electionware PDF empty or too small after retries");
}

/**
 * Full county summary: every contest block after "Vote For N" in the Electionware layout.
 * Same spirit as Clarity summary.zip (all contests); SD4 appears only when it is on the ballot.
 *
 * @param {string} [pdfUrl]
 */
export async function fetchDallasElectionwarePdfAllContests(pdfUrl = DALLAS_SAMPLE_PDF_URL) {
  const buf = await fetchDallasPdfBuffer(pdfUrl);
  const parser = new PDFParse({ data: buf });
  const pdfText = await parser.getText();
  await parser.destroy();
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
    while (j < lines.length && !/^VOTE %$/i.test(lines[j])) {
      j++;
    }
    if (j >= lines.length) continue;
    j++;

    while (j < lines.length) {
      const line = lines[j];
      if (/^Total Votes Cast\b/i.test(line)) break;
      if (/^Overvotes\b/i.test(line)) break;
      if (/^Undervotes\b/i.test(line)) break;
      if (/^Write-In Totals\b/i.test(line)) {
        j++;
        continue;
      }

      const parsed = parseElectionwareCandidateLine(line);
      if (parsed) {
        const { choiceName, c1, c2, c3, c4, c5, pct } = parsed;
        if (/^Not Assigned$/i.test(choiceName) && c1 + c2 + c3 + c4 + c5 === 0) {
          j++;
          continue;
        }
        const earlyVotes = c1 + c2 + c3 + c4;
        const electionDayVotes = c5;
        const totalVotes = c1 + c2 + c3 + c4 + c5;
        lineNumber += 1;
        rows.push({
          lineNumber,
          contestName,
          choiceName,
          partyName: "",
          earlyVotes,
          electionDayVotes,
          totalVotes,
          percentOfVotes: totalVotes > 0 ? pct : "0.00",
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

  if (!rows.length) throw new Error("No Dallas Electionware candidate rows parsed from PDF");

  return {
    source: {
      id: "county-dallas",
      type: "county",
      county: "Dallas",
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
