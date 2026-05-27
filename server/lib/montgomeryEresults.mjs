/**
 * Montgomery County live eResults (elections.mctx.org ASP.NET HTML tables).
 * Redirects to election.mctx.org are rewritten to elections.mctx.org to avoid TLS hostname mismatches.
 */

import { fetch as undiciFetch } from "undici";

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
];

/** election.mctx.org often redirects with a cert/host mismatch; always fetch elections.mctx.org. */
export function canonicalMontgomeryUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return DEFAULT_PAGE_URL;
  try {
    const u = new URL(raw);
    if (u.hostname.toLowerCase() === "election.mctx.org") {
      u.hostname = "elections.mctx.org";
      return u.href;
    }
    return u.href;
  } catch {
    return raw;
  }
}

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
  const p = canonicalMontgomeryUrl(String(primary ?? "").trim() || DEFAULT_PAGE_URL);
  const out = [];
  const seen = new Set();
  for (const u of [p, ...MONTGOMERY_FALLBACK_URLS]) {
    const x = canonicalMontgomeryUrl(String(u).trim());
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
  let current = canonicalMontgomeryUrl(pageUrl);
  let origin = "https://elections.mctx.org";
  try {
    origin = new URL(current).origin;
  } catch {
    throw new Error(`Montgomery eResults: invalid URL (${pageUrl})`);
  }

  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${origin}/`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
  };

  let res;
  for (let hop = 0; hop < 12; hop++) {
    res = await undiciFetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
      headers,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      const next = canonicalMontgomeryUrl(new URL(location, current).href);
      current = next;
      continue;
    }
    break;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const finalUrl = canonicalMontgomeryUrl(current);
  return { res, buf, pageUrl: finalUrl };
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
  const origin = new URL(canonicalMontgomeryUrl(pageUrl)).origin;
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
  /** @type {Array<{ contestName: string; choiceName: string; partyName: string; earlyVotes: number; electionDayVotes: number; totalVotes: number }>} */
  const bodyRows = [];

  for (const idx of candIndices) {
    const title = contestTitleFor(idx).trim();
    if (!title) continue;

    const nameCell = names.get(idx) ?? "";
    let choiceName = nameCell;
    let partyName = "";
    const par = nameCell.match(/^(.+?)\s*\(([A-Z]{2,4})\)\s*$/i);
    if (par) {
      choiceName = par[1].trim();
      partyName = String(par[2] ?? "").toUpperCase();
    }
    if (!choiceName) continue;

    const absentee = asNum(abs.get(idx));
    const early = asNum(ev.get(idx));
    const electionDay = asNum(ed.get(idx));
    const total = tot.has(idx) ? asNum(tot.get(idx)) : absentee + early + electionDay;

    bodyRows.push({
      contestName: title,
      choiceName,
      partyName,
      earlyVotes: absentee + early,
      electionDayVotes: electionDay,
      totalVotes: total,
    });
  }

  if (!bodyRows.length) {
    throw new Error(
      `Montgomery eResults: found candidate tables but no parsed rows (${pageUrl}). ` +
        `Confirm the feed URL targets the correct election (include ElectionId= in the URL if needed).`,
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

  const outRows = bodyRows.map((rec, idx) => {
    const contestPeers = bodyRows.filter((r) => r.contestName === rec.contestName);
    const voteSum = contestPeers.reduce((s, x) => s + x.totalVotes, 0);
    return {
      lineNumber: idx + 1,
      contestName: rec.contestName,
      choiceName: rec.choiceName,
      partyName: rec.partyName,
      earlyVotes: rec.earlyVotes,
      electionDayVotes: rec.electionDayVotes,
      totalVotes: rec.totalVotes,
      percentOfVotes:
        rec.totalVotes > 0 && voteSum > 0 ? ((rec.totalVotes / voteSum) * 100).toFixed(2) : "0.00",
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal,
      precinctReporting,
      overVotes: 0,
      underVotes: 0,
    };
  });

  return {
    source: {
      id: "county-montgomery",
      type: "county",
      county: "Montgomery",
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

function contestTitleFromMatrixRow(row) {
  return row.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
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
 * Legacy table layout: one block per race title row.
 * @param {string[][]} matrices
 */
function parseAllContestBlocksFromMatrices(matrices) {
  /** @type {Array<{ contestName: string; rows: Array<{ choiceName: string; partyName: string; earlyVotes: number; electionDayVotes: number; totalVotes: number }> }>} */
  const blocks = [];

  for (let i = 0; i < matrices.length; i++) {
    if (!looksLikeNextRaceTitleRow(matrices[i])) continue;
    const contestName =
      contestTitleFromMatrixRow(matrices[i]) || matrices[i].join(" ").replace(/\s+/g, " ").trim();
    if (!contestName) continue;

    /** @type {Array<{ choiceName: string; partyName: string; earlyVotes: number; electionDayVotes: number; totalVotes: number }>} */
    const rows = [];
    for (let j = i + 1; j < matrices.length; j++) {
      const r = matrices[j];
      const joined = r.join(" ");
      if (looksLikeNextRaceTitleRow(r)) break;
      if (/^candidate\b/i.test(joined) && /absentee|early|election|total/i.test(joined)) continue;

      const parsed = parseCandidateNumericTail(r);
      if (parsed) {
        rows.push(parsed);
        continue;
      }
      if (r.length >= 2 && !/\d/.test(joined) && looksLikeNextRaceTitleRow(r)) break;
    }
    if (rows.length) blocks.push({ contestName, rows });
  }
  return blocks;
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
        `In your browser, open the election results, then copy the **full address bar URL** (may include ElectionID= or similar) into Feed URL.`,
    );
  }

  if (hasRptCandidatesMarkup(html)) {
    return parseMontgomeryRptCandidatesHtml(html, pageUrl);
  }

  const matrices = extractTableMatrices(html);
  const blocks = parseAllContestBlocksFromMatrices(matrices);

  let precinctReporting = 0;
  let precinctTotal = 0;
  const pr = plainOneLine.match(/(\d+)\s+of\s+(\d+)\s+(?:Election\s+Day\s+)?Precincts?\s+Reporting/i);
  if (pr) {
    precinctReporting = asNum(pr[1]);
    precinctTotal = asNum(pr[2]);
  }

  /** @type {typeof blocks[0]["rows"] & { contestName: string }[]} */
  const flat = [];
  for (const block of blocks) {
    for (const rec of block.rows) {
      flat.push({ contestName: block.contestName, ...rec });
    }
  }

  if (!flat.length) {
    const looksMenuOrPortal =
      /formresults|Click\s+for\s+Results|electioninfo\/eResultsMain/i.test(html) &&
      !hasRptCandidatesMarkup(html);
    const hint =
      plainOneLine.length < 400
        ? " Response was very short — check network / redirect."
        : looksMenuOrPortal
          ? " This page is the county portal, not the results iframe — the app should have followed ElectionId to eResults.aspx; if you still see this, try saving a feed URL that includes ?ElectionId= in the address bar after results open."
          : " No contest tables found in HTML.";
    throw new Error(
      `Montgomery eResults: could not parse candidate rows (${pageUrl}).${hint} ` +
        `Use “Montgomery County eResults (live HTML)” with the county portal URL (e.g. index.asp) or the address bar URL after “Click for Results” loads.`,
    );
  }

  const outRows = flat.map((rec, idx) => {
    const voteSum = flat
      .filter((r) => r.contestName === rec.contestName)
      .reduce((s, x) => s + x.totalVotes, 0);
    return {
      lineNumber: idx + 1,
      contestName: rec.contestName,
      choiceName: rec.choiceName,
      partyName: rec.partyName,
      earlyVotes: rec.earlyVotes,
      electionDayVotes: rec.electionDayVotes,
      totalVotes: rec.totalVotes,
      percentOfVotes:
        rec.totalVotes > 0 && voteSum > 0 ? ((rec.totalVotes / voteSum) * 100).toFixed(2) : "0.00",
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal,
      precinctReporting,
      overVotes: 0,
      underVotes: 0,
    };
  });

  return {
    source: {
      id: "county-montgomery",
      type: "county",
      county: "Montgomery",
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

/** @param {string} pageUrl */
export async function fetchMontgomeryEresultsAllContests(pageUrl = DEFAULT_PAGE_URL) {
  const chain = uniqueMontgomeryUrlChain(pageUrl);
  const tried404 = [];

  for (const url of chain) {
    let attempt;
    try {
      attempt = await fetchMontgomeryHttpOnce(url);
    } catch (e) {
      const detail = unwrapFetchError(e);
      throw new Error(`Montgomery eResults cannot fetch ${url}: ${detail}.`);
    }

    const { res, buf } = attempt;
    const finalUrl = res.url || url;

    if (res.ok) {
      const head = buf.slice(0, 5).toString("ascii");
      if (head.startsWith("%PDF")) {
        throw new Error(
          "That URL returned a file download, not the live eResults HTML page. Paste the address-bar URL from the live results screen.",
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
      `The county often moves paths between elections — open results in your browser, copy the **full address bar URL**, and save it as the Montgomery feed URL.`,
  );
}

/** @deprecated Use fetchMontgomeryEresultsAllContests */
export const fetchMontgomeryEresultsSd4Summary = fetchMontgomeryEresultsAllContests;
