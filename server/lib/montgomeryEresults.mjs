/**
 * Montgomery County live eResults (elections.mctx.org → election.mctx.org ASP.NET HTML tables).
 *
 * DNS: many networks resolve elections.mctx.org but not election.mctx.org (redirect target). undici Agent
 * resolves election.mctx.org using elections.mctx.org’s A/AAAA records while TLS SNI stays election.mctx.org.
 * Set MONTGOMERY_DISABLE_ELECTION_DNS_ALIAS=1 to use default DNS only.
 */

import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

/** County portal (often 200); live race pages move — see {@link MONTGOMERY_FALLBACK_URLS}. */
const DEFAULT_PAGE_URL = "https://elections.mctx.org/index.asp";

/**
 * If the primary URL returns 404 (retired path), try these in order. User’s saved Feed URL is always tried first.
 */
const MONTGOMERY_FALLBACK_URLS = [
  "https://elections.mctx.org/index.asp",
  "https://elections.mctx.org/electioninfo/eResultsMain.aspx",
  "https://elections.mctx.org/electioninfo/eResults.aspx",
  "https://elections.mctx.org/",
  "https://election.mctx.org/",
];

const USE_ELECTION_IP_ALIAS = process.env.MONTGOMERY_DISABLE_ELECTION_DNS_ALIAS !== "1";

/** Connect to elections.* IP when hostname is election.* (same edge; fixes ENOTFOUND on election subdomain). */
const MCTX_ALIAS_AGENT = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (hostname === "election.mctx.org") {
        dns.lookup("elections.mctx.org", options, callback);
        return;
      }
      dns.lookup(hostname, options, callback);
    },
  },
});

/** Undici often surfaces only `fetch failed`; walk `.cause` for ENOTFOUND / TLS / timeout. */
function unwrapFetchError(err) {
  const bits = [];
  let cur = err;
  const seen = new Set();
  for (let i = 0; i < 10 && cur; i++) {
    const code = cur.code != null ? String(cur.code) : "";
    const msg = String(cur.message ?? cur).trim();
    const sig = `${code}:${msg}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      if (code) bits.push(code);
      if (msg && msg !== "fetch failed") bits.push(msg);
    }
    cur = cur.cause;
  }
  return bits.length ? bits.join(" → ") : "fetch failed (no underlying detail)";
}

function uniqueMontgomeryUrlChain(primary) {
  const p = String(primary ?? "").trim() || DEFAULT_PAGE_URL;
  const out = [];
  const seen = new Set();
  for (const u of [p, ...MONTGOMERY_FALLBACK_URLS]) {
    const x = String(u).trim();
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * @param {string} pageUrl
 * @returns {Promise<{ res: Response, buf: Buffer, pageUrl: string }>}
 */
async function fetchMontgomeryHttpOnce(pageUrl) {
  let origin = "https://elections.mctx.org";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    throw new Error(`Montgomery eResults: invalid URL (${pageUrl})`);
  }
  const fetchFn = USE_ELECTION_IP_ALIAS ? undiciFetch : globalThis.fetch;
  const res = await fetchFn(pageUrl, {
    ...(USE_ELECTION_IP_ALIAS ? { dispatcher: MCTX_ALIAS_AGENT } : {}),
    redirect: "follow",
    signal: AbortSignal.timeout(90_000),
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${origin}/`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
    },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, pageUrl };
}

function asNum(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function decodeBasicEntities(html) {
  return String(html ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html) {
  return decodeBasicEntities(String(html ?? ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCell(html) {
  return stripTags(html).trim();
}

/** True when HTML is the iframe body (`electioninfo/eResults.aspx`) with ASP.NET repeater markup. */
function hasRptCandidatesMarkup(html) {
  return /rptCandidates_txtCandName2_/i.test(String(html ?? ""));
}

/**
 * Portal pages (`index.asp`, frameset wrapper) embed `ElectionId` in query strings, hidden inputs, or JS.
 * @param {string} html
 * @param {string} pageUrl
 * @returns {string}
 */
export function extractElectionIdFromMontgomeryPage(html, pageUrl) {
  try {
    const u = new URL(pageUrl);
    const q = u.searchParams.get("ElectionId") || u.searchParams.get("txtElectionId");
    if (q?.trim()) return q.trim();
  } catch {
    // ignore
  }

  const h = String(html ?? "");
  const mJs = h.match(/var\s+strElectionId\s*=\s*['"]([^'"]+)['"]/i);
  if (mJs?.[1]?.trim()) return mJs[1].trim();

  const mFrame =
    h.match(/eResults\.aspx\?[^"'<>]*ElectionId=([^&"'<>]+)/i) ||
    h.match(/eResultsMain\.aspx\?[^"'<>]*ElectionId=([^&"'<>]+)/i);
  if (mFrame?.[1]?.trim()) {
    try {
      return decodeURIComponent(mFrame[1].trim());
    } catch {
      return mFrame[1].trim();
    }
  }

  const mHi =
    h.match(/name\s*=\s*['"]txtElectionId['"][^>]*value\s*=\s*['"]([^'"]+)['"]/i) ||
    h.match(/value\s*=\s*['"]([^'"]+)['"][^>]*name\s*=\s*['"]txtElectionId['"]/i);
  if (mHi?.[1]?.trim()) return mHi[1].trim();

  return "";
}

/**
 * @param {string} pageUrl
 * @param {string} electionId
 */
function montgomeryEResultsFrameUrl(pageUrl, electionId) {
  const origin = new URL(pageUrl).origin;
  return `${origin}/electioninfo/eResults.aspx?ElectionId=${encodeURIComponent(electionId)}`;
}

/**
 * Parse Montgomery live frame HTML: one `<table id="rptCandidates_maindata_*">` per candidate row;
 * contest titles use `rptCandidates_ContestTitle2_*`.
 * @param {string} html
 * @param {string} pageUrl
 */
function parseMontgomeryRptCandidatesHtml(html, pageUrl) {
  const h = String(html ?? "");

  const contestRe = /id\s*=\s*['"]rptCandidates_ContestTitle2_(\d+)['"][^>]*>([\s\S]*?)<\/td>/gi;
  /** @type {Map<number, string>} */
  const contests = new Map();
  let cm;
  while ((cm = contestRe.exec(h)) !== null) {
    contests.set(Number(cm[1]), normalizeCell(cm[2]));
  }

  const nameRe = /id\s*=\s*['"]rptCandidates_txtCandName2_(\d+)['"][^>]*>([\s\S]*?)<\/td>/gi;
  /** @type {Map<number, string>} */
  const names = new Map();
  while ((cm = nameRe.exec(h)) !== null) {
    names.set(Number(cm[1]), normalizeCell(cm[2]));
  }

  function fillMap(re) {
    /** @type {Map<number, string>} */
    const mm = new Map();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(h)) !== null) {
      mm.set(Number(m[1]), normalizeCell(m[2]));
    }
    return mm;
  }

  const abs = fillMap(/id\s*=\s*['"]rptCandidates_txtABSVotes_(\d+)['"][^>]*>([\s\S]*?)<\/td>/gi);
  const ev = fillMap(/id\s*=\s*['"]rptCandidates_txtEVVotes2_(\d+)['"][^>]*>([\s\S]*?)<\/td>/gi);
  const ed = fillMap(/id\s*=\s*['"]rptCandidates_txtEDVotes2_(\d+)['"][^>]*>([\s\S]*?)<\/td>/gi);
  const tot = fillMap(/id\s*=\s*['"]rptCandidates_txtTotalVotes2_(\d+)['"][^>]*>([\s\S]*?)<\/td>/gi);

  const contestKeys = [...contests.keys()].sort((a, b) => a - b);
  /**
   * @param {number} candIdx
   */
  function contestTitleFor(candIdx) {
    let best = -1;
    for (const k of contestKeys) {
      if (k <= candIdx && k > best) best = k;
    }
    return best >= 0 ? contests.get(best) ?? "" : "";
  }

  const candIndices = [...names.keys()].sort((a, b) => a - b);
  /** @type {Array<{ choiceName: string; partyName: string; earlyVotes: number; electionDayVotes: number; totalVotes: number }>} */
  const bodyRows = [];
  let contestName = "";

  for (const idx of candIndices) {
    const title = contestTitleFor(idx);
    if (!looksLikeSd4ContestJoin(title)) continue;
    if (!contestName) contestName = title.trim();

    const nameCell = names.get(idx) ?? "";
    let choiceName = nameCell;
    let partyName = "";
    const par = nameCell.match(/^(.+?)\s*\(([A-Z]{2,4})\)\s*$/i);
    if (par) {
      choiceName = par[1].trim();
      partyName = String(par[2] ?? "").toUpperCase();
    }

    const absentee = asNum(abs.get(idx));
    const early = asNum(ev.get(idx));
    const electionDay = asNum(ed.get(idx));
    const total = tot.has(idx) ? asNum(tot.get(idx)) : absentee + early + electionDay;

    bodyRows.push({
      choiceName,
      partyName,
      earlyVotes: absentee + early,
      electionDayVotes: electionDay,
      totalVotes: total,
    });
  }

  if (!bodyRows.length || !contestName) {
    throw new Error(
      `Montgomery eResults: found candidate tables but no State Senate District 4 contest in this election (${pageUrl}). ` +
        `Confirm the feed URL targets the election that includes SD4 (or paste a URL whose query string includes ElectionId= for that election).`,
    );
  }

  const plainOneLine = stripTags(h);
  let precinctReporting = 0;
  let precinctTotal = 0;
  const pr = plainOneLine.match(/(\d+)\s+of\s+(\d+)\s+(?:Election\s+Day\s+)?Precincts?\s+Reporting/i);
  if (pr) {
    precinctReporting = asNum(pr[1]);
    precinctTotal = asNum(pr[2]);
  }

  const voteSum = bodyRows.reduce((s, x) => s + x.totalVotes, 0);
  const outRows = bodyRows.map((rec, idx) => ({
    lineNumber: idx + 1,
    contestName,
    choiceName: rec.choiceName,
    partyName: rec.partyName,
    earlyVotes: rec.earlyVotes,
    electionDayVotes: rec.electionDayVotes,
    totalVotes: rec.totalVotes,
    percentOfVotes: rec.totalVotes > 0 && voteSum > 0 ? ((rec.totalVotes / voteSum) * 100).toFixed(2) : "0.00",
    registeredVoters: 0,
    ballotsCast: 0,
    precinctTotal,
    precinctReporting,
    overVotes: 0,
    underVotes: 0,
  }));

  return {
    source: {
      id: "county-montgomery",
      type: "county",
      county: "Montgomery",
      contest: contestName,
      pageUrl,
    },
    rows: outRows,
    totals: {
      candidateVotes: outRows.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal,
      precinctReporting,
    },
    rowCount: outRows.length,
  };
}

/** Match SD4 contest headers as rendered on MCTX eResults (wording varies). */
function looksLikeSd4ContestJoin(joined) {
  const j = joined.replace(/\s+/g, " ");
  if (!/district\s*(?:no\.?\s*)?\s*[#]?\s*4\b/i.test(j)) return false;
  if (/state\s+senat(?:or|e)/i.test(j)) return true;
  if (/senate\s*,?\s*district\s*(?:no\.?\s*)?\s*4/i.test(j)) return true;
  if (/district\s*(?:no\.?\s*)?\s*4[^.]{0,80}(?:unexpired|remainder|special)/i.test(j)) return true;
  return false;
}

function contestTitleFromMatrixRow(row) {
  const parts = row.filter(Boolean);
  const hit = parts.find((c) => looksLikeSd4ContestJoin(c));
  return hit?.trim() ?? parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Pull <tr> → cell text matrix.
 * @param {string} html
 * @returns {string[][]}
 */
function extractTableMatrices(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const inner = m[1];
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tm;
    while ((tm = tdRe.exec(inner)) !== null) {
      cells.push(normalizeCell(tm[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * From right: optional Percent, Total, Election day, Early, Absentee — then candidate name cells.
 * @param {string[]} cells
 */
function parseCandidateNumericTail(cells) {
  if (cells.length < 5) return null;
  const rowTextJoin = cells.join(" ");
  if (!/[a-z]/i.test(rowTextJoin)) return null;

  let i = cells.length - 1;
  const last = String(cells[i] ?? "").trim();
  if (/^\d+\.\d+%$/.test(last) || /^\d+%$/.test(last)) i -= 1;

  const nums = [];
  while (i >= 0 && nums.length < 4) {
    const c = String(cells[i] ?? "").trim().replace(/,/g, "");
    if (!/^(\d+)$/.test(c)) break;
    nums.unshift(Number(c));
    i -= 1;
  }
  if (nums.length < 4) return null;

  const total = nums[nums.length - 1];
  const electionDay = nums[nums.length - 2];
  const early = nums[nums.length - 3];
  const absentee = nums[nums.length - 4];
  const nameParts = cells.slice(0, i + 1).filter(Boolean);
  const nameCell = nameParts.join(" ").trim();
  if (!nameCell || !/[a-z]/i.test(nameCell)) return null;

  let choiceName = nameCell;
  let partyName = "";
  const par = nameCell.match(/^(.+?)\s*\(([A-Z]{2,4})\)\s*$/i);
  if (par) {
    choiceName = par[1].trim();
    partyName = String(par[2] ?? "").toUpperCase();
  }

  return {
    choiceName,
    partyName,
    earlyVotes: absentee + early,
    electionDayVotes: electionDay,
    totalVotes: total,
  };
}

function looksLikeNextRaceTitleRow(cells) {
  if (cells.length !== 1) return false;
  const t = cells[0];
  if (!t || t.length < 25) return false;
  if (/\d/.test(t)) return false;
  return /senate|representative|district|ISD|proposition|bond|amendment|justice|judge|commissioner/i.test(t);
}

/**
 * Sliding-window scan: contest title may span multiple <tr> rows.
 * @param {string[][]} matrices
 */
function findSd4ContestLocation(matrices) {
  for (let i = 0; i < matrices.length; i++) {
    const one = matrices[i].join(" ");
    if (looksLikeSd4ContestJoin(one)) {
      return { contestIdx: i, contestLine: contestTitleFromMatrixRow(matrices[i]) };
    }
    if (i + 1 < matrices.length) {
      const two = `${matrices[i].join(" ")} ${matrices[i + 1].join(" ")}`;
      if (looksLikeSd4ContestJoin(two)) {
        return {
          contestIdx: i + 1,
          contestLine: contestTitleFromMatrixRow(matrices[i].concat(matrices[i + 1])),
        };
      }
    }
    if (i + 2 < matrices.length) {
      const three = `${matrices[i].join(" ")} ${matrices[i + 1].join(" ")} ${matrices[i + 2].join(" ")}`;
      if (looksLikeSd4ContestJoin(three)) {
        return {
          contestIdx: i + 2,
          contestLine: [matrices[i], matrices[i + 1], matrices[i + 2]].flat().join(" ").replace(/\s+/g, " ").trim(),
        };
      }
    }
  }
  return { contestIdx: -1, contestLine: "" };
}

/**
 * @param {string} html
 * @param {string} pageUrl
 */
export function parseMontgomeryEresultsHtml(html, pageUrl) {
  const plainOneLine = stripTags(html);

  if (/ddlElection|please\s+select\s+an\s+election|select\s+election/i.test(html + plainOneLine)) {
    throw new Error(
      `Montgomery eResults URL appears to be the election menu, not the results page (${pageUrl}). ` +
        `In your browser, open the election until SD4 results are visible, then copy the **full address bar URL** (may include ElectionID= or similar) into Feed URL.`,
    );
  }

  if (hasRptCandidatesMarkup(html)) {
    return parseMontgomeryRptCandidatesHtml(html, pageUrl);
  }

  const matrices = extractTableMatrices(html);
  let { contestIdx, contestLine } = findSd4ContestLocation(matrices);

  const bodyRows = [];
  if (contestIdx >= 0) {
    for (let j = contestIdx + 1; j < matrices.length; j++) {
      const r = matrices[j];
      const joined = r.join(" ");
      if (/^candidate\b/i.test(joined) && /absentee|early|election|total/i.test(joined)) continue;
      if (looksLikeNextRaceTitleRow(r)) break;

      const parsed = parseCandidateNumericTail(r);
      if (parsed) {
        bodyRows.push(parsed);
        continue;
      }
      if (r.length >= 2 && !/\d/.test(joined)) {
        if (looksLikeNextRaceTitleRow(r)) break;
      }
    }
  }

  let finalRows = bodyRows;
  let finalContestLine = contestLine;
  if (!finalRows.length) {
    const plain = parseSd4RowsFromPlainText(plainOneLine);
    finalRows = plain.rows;
    if (plain.contestLine) finalContestLine = plain.contestLine;
  }

  if (!finalRows.length || !finalContestLine) {
    const looksMenuOrPortal =
      /formresults|Click\s+for\s+Results|electioninfo\/eResultsMain/i.test(html) &&
      !hasRptCandidatesMarkup(html);
    const hint =
      plainOneLine.length < 400
        ? " Response was very short — check network / redirect."
        : looksMenuOrPortal
          ? " This page is the county portal, not the results iframe — the app should have followed ElectionId to eResults.aspx; if you still see this, try saving a feed URL that includes ?ElectionId= in the address bar after results open."
        : looksLikeSd4ContestJoin(plainOneLine) && /href\s*=\s*['"][^'"]*\.pdf/i.test(html)
          ? " Found SD4-related text in a notice or PDF link, not in live result tables — use the results screen or a URL with ElectionId= so the live table can load."
          : looksLikeSd4ContestJoin(plainOneLine)
            ? " Found contest wording in text but could not parse candidate rows (older table layout)."
            : " No State Senate / Senator District 4 contest text found.";
    throw new Error(
      `Montgomery eResults: could not parse SD4 candidate rows (${pageUrl}).${hint} ` +
        `Use “Montgomery County eResults (live HTML)” with the county portal URL (e.g. index.asp) or the address bar URL after “Click for Results” loads.`,
    );
  }

  let precinctReporting = 0;
  let precinctTotal = 0;
  const pr = plainOneLine.match(/(\d+)\s+of\s+(\d+)\s+(?:Election\s+Day\s+)?Precincts?\s+Reporting/i);
  if (pr) {
    precinctReporting = asNum(pr[1]);
    precinctTotal = asNum(pr[2]);
  }

  const contestName = finalContestLine;

  const voteSum = finalRows.reduce((s, x) => s + x.totalVotes, 0);
  const outRows = finalRows.map((rec, idx) => ({
    lineNumber: idx + 1,
    contestName,
    choiceName: rec.choiceName,
    partyName: rec.partyName,
    earlyVotes: rec.earlyVotes,
    electionDayVotes: rec.electionDayVotes,
    totalVotes: rec.totalVotes,
    percentOfVotes: rec.totalVotes > 0 && voteSum > 0 ? ((rec.totalVotes / voteSum) * 100).toFixed(2) : "0.00",
    registeredVoters: 0,
    ballotsCast: 0,
    precinctTotal,
    precinctReporting,
    overVotes: 0,
    underVotes: 0,
  }));

  return {
    source: {
      id: "county-montgomery",
      type: "county",
      county: "Montgomery",
      contest: contestName,
      pageUrl,
    },
    rows: outRows,
    totals: {
      candidateVotes: outRows.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal,
      precinctReporting,
    },
    rowCount: outRows.length,
  };
}

/**
 * Fallback: linear text search + candidate patterns (spacing varies).
 * @param {string} plain one long line
 */
function parseSd4RowsFromPlainText(plain) {
  let bestIdx = -1;
  const patterns = [
    /state\s+senator[^.]{0,160}district\s*(?:no\.?\s*)?\s*4/gi,
    /state\s+senate[^.]{0,160}district\s*(?:no\.?\s*)?\s*4/gi,
    /senate[^.]{0,120}district\s*(?:no\.?\s*)?\s*4[^.]{0,120}unexpired/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(plain);
    if (m && m.index != null && (bestIdx === -1 || m.index < bestIdx)) bestIdx = m.index;
  }
  if (bestIdx < 0) {
    const loose = plain.search(/district\s*(?:no\.?\s*)?\s*4.{0,200}(?:senat|unexpired)/i);
    if (loose >= 0) bestIdx = loose;
  }
  if (bestIdx < 0) return { rows: [], contestLine: "" };

  const slice = plain.slice(bestIdx, bestIdx + 14000);
  const contestLine = slice.split(/\s{2,}/)[0]?.slice(0, 220).trim() ?? "";

  const rows = [];
  const patternsCand = [
    /([A-Za-z][^(]{1,120}?)\s*\(([A-Z]{2,4})\)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+\d+\.\d+%/g,
    /([A-Za-z][^(]{1,120}?)\s*\(([A-Z]{2,4})\)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s*(?:\d+\.\d+%)?/g,
  ];
  for (const candRe of patternsCand) {
    candRe.lastIndex = 0;
    let m;
    while ((m = candRe.exec(slice)) !== null) {
      const absentee = asNum(m[3]);
      const early = asNum(m[4]);
      const ed = asNum(m[5]);
      const total = asNum(m[6]);
      rows.push({
        choiceName: m[1].trim(),
        partyName: String(m[2] ?? "").toUpperCase(),
        earlyVotes: absentee + early,
        electionDayVotes: ed,
        totalVotes: total,
      });
    }
    if (rows.length) break;
  }
  return { rows, contestLine: contestLine || "" };
}

/** @param {string} pageUrl */
export async function fetchMontgomeryEresultsSd4Summary(pageUrl = DEFAULT_PAGE_URL) {
  const chain = uniqueMontgomeryUrlChain(pageUrl);
  const tried404 = [];

  for (const url of chain) {
    let attempt;
    try {
      attempt = await fetchMontgomeryHttpOnce(url);
    } catch (e) {
      const detail = unwrapFetchError(e);
      throw new Error(
        `Montgomery eResults cannot fetch ${url}: ${detail}. ` +
          `If TLS fails after DNS alias, try MONTGOMERY_DISABLE_ELECTION_DNS_ALIAS=1 or fix DNS/firewall for election.mctx.org.`,
      );
    }

    const { res, buf } = attempt;
    const finalUrl = res.url || url;

    if (res.ok) {
      const head = buf.slice(0, 5).toString("ascii");
      if (head.startsWith("%PDF")) {
        throw new Error(
          "That URL returned a file download, not the live eResults HTML page. Paste the address-bar URL from the results screen while SD4 totals are visible.",
        );
      }
      let html = buf.toString("utf8");
      if (html.charCodeAt(0) === 0xfeff) html = html.slice(1);

      if (!hasRptCandidatesMarkup(html)) {
        const electionId = extractElectionIdFromMontgomeryPage(html, finalUrl);
        if (electionId) {
          try {
            const frameUrl = montgomeryEResultsFrameUrl(finalUrl, electionId);
            const inner = await fetchMontgomeryHttpOnce(frameUrl);
            if (inner.res.ok) {
              const innerHead = inner.buf.slice(0, 5).toString("ascii");
              if (!innerHead.startsWith("%PDF")) {
                let innerHtml = inner.buf.toString("utf8");
                if (innerHtml.charCodeAt(0) === 0xfeff) innerHtml = innerHtml.slice(1);
                if (hasRptCandidatesMarkup(innerHtml)) {
                  const innerFinal = inner.res.url || frameUrl;
                  return parseMontgomeryEresultsHtml(innerHtml, innerFinal);
                }
              }
            }
          } catch {
            // Parse outer HTML below (legacy path / clearer error).
          }
        }
      }

      return parseMontgomeryEresultsHtml(html, finalUrl);
    }

    if (res.status === 404) {
      tried404.push(url);
      continue;
    }

    throw new Error(`Montgomery eResults HTTP ${res.status} (${url})`);
  }

  throw new Error(
    `Montgomery eResults: HTTP 404 for ${tried404.length ? tried404.join(", ") : "all fallback URLs"}. ` +
      `The county often moves paths between elections — open results in your browser, copy the **full address bar URL** after SD4 loads, and save it as the Montgomery feed URL.`,
  );
}
