/**
 * Ellis County — livevoterturnout.com ENR (Election Night Results) HTML.
 * Example: https://www.livevoterturnout.com/ENR/ellistxenr/9/en/Index_9.html
 */

const DEFAULT_PAGE_URL =
  "https://www.livevoterturnout.com/ENR/ellistxenr/9/en/Index_9.html";

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

function partyFromContestName(contestName) {
  const c = String(contestName ?? "").trim();
  if (/^REP\b/i.test(c)) return "REP";
  if (/^DEM\b/i.test(c)) return "DEM";
  if (/^LIB\b/i.test(c)) return "LIB";
  return "";
}

/** @param {string} pageUrl */
export function parseEllisEnrElectionIdFromUrl(pageUrl) {
  const m = String(pageUrl ?? "").match(/\/ENR\/[^/]+\/(\d+)\/en\/Index_\d+\.html/i);
  return m ? String(m[1]) : "";
}

/**
 * @param {string} html
 */
function parseEllisRaceNameMap(html) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const m of String(html).matchAll(/data-race="(\d+)"[^>]*\/>\s*([^<\r\n]+)/gi)) {
    const name = decodeBasicEntities(m[2]).trim();
    if (name) map[m[1]] = name;
  }
  return map;
}

function contestNameFromBlock(blockHtml, raceNames) {
  const raceId = blockHtml.match(/id="pRL_\d+_(\d+)"/i)?.[1];
  if (raceId && raceNames[raceId]) return raceNames[raceId];

  const aria = blockHtml.match(/aria-label="[^"]*Contest:\s*([^"]+)"/i)?.[1];
  if (aria) return decodeBasicEntities(aria).trim();

  const title = blockHtml.match(/class="race-title"[^>]*>([^<]+)/i)?.[1];
  if (title) {
    const t = decodeBasicEntities(title).trim();
    const dash = t.lastIndexOf(" - ");
    return dash >= 0 ? t.slice(dash + 3).trim() : t;
  }
  return "";
}

/**
 * Parse per-precinct tables and sum to county-wide contest/candidate totals.
 * @param {string} html
 * @param {string} pageUrl
 */
export function parseEllisLiveVoterTurnoutHtml(html, pageUrl) {
  const h = String(html ?? "");
  if (!/ellis|livevoterturnout\.com\/ENR\/ellistxenr/i.test(h)) {
    throw new Error("Page does not look like Ellis County livevoterturnout ENR HTML");
  }

  const raceNames = parseEllisRaceNameMap(h);
  const precinctTotal = asNum(h.match(/Total Precincts[\s\S]{0,120}?(\d[\d,]*)/i)?.[1]);
  const precinctReporting = asNum(
    h.match(/Fully Reporting[\s\S]{0,120}?(\d[\d,]*)/i)?.[1],
  );

  /** @type {Map<string, { contestName: string, choiceName: string, partyName: string, totalVotes: number, percentOfVotes: string }>} */
  const agg = new Map();

  const blocks = h.split(/(?=<div\s+id="pRL_\d+_\d+"[^>]*class="list-item-precinct-race")/i).filter((b) => /id="pRL_/i.test(b));
  if (!blocks.length) {
    throw new Error("No precinct race blocks found in Ellis ENR HTML");
  }

  const rowRe =
    /<tr\s+class="content-row">[\s\S]*?aria-hidden="true">([^<]+)<[\s\S]*?dv="true"[^>]*>([\d,]+)<[\s\S]*?dpe="true"[^>]*>([\d.]+)%/gi;

  for (const block of blocks) {
    const contestName = contestNameFromBlock(block, raceNames);
    if (!contestName) continue;
    const partyName = partyFromContestName(contestName);

    for (const m of block.matchAll(rowRe)) {
      const choiceName = decodeBasicEntities(m[1]).trim();
      if (!choiceName || /^total/i.test(choiceName)) continue;
      const votes = asNum(m[2]);
      const pct = String(m[3] ?? "0");
      const key = `${contestName}\u0000${choiceName}\u0000${partyName}`;
      const prev = agg.get(key) ?? {
        contestName,
        choiceName,
        partyName,
        totalVotes: 0,
        percentOfVotes: "0.00",
      };
      prev.totalVotes += votes;
      agg.set(key, prev);
    }
  }

  const rows = [];
  let lineNumber = 0;
  for (const entry of agg.values()) {
    lineNumber += 1;
    rows.push({
      lineNumber,
      contestName: entry.contestName,
      choiceName: entry.choiceName,
      partyName: entry.partyName,
      earlyVotes: 0,
      electionDayVotes: 0,
      totalVotes: entry.totalVotes,
      percentOfVotes: entry.percentOfVotes,
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal,
      precinctReporting,
      overVotes: 0,
      underVotes: 0,
    });
  }

  if (!rows.length) {
    throw new Error("No Ellis ENR candidate rows parsed from HTML");
  }

  const contestTotals = new Map();
  for (const r of rows) {
    contestTotals.set(r.contestName, (contestTotals.get(r.contestName) ?? 0) + r.totalVotes);
  }
  for (const r of rows) {
    const t = contestTotals.get(r.contestName) ?? 0;
    if (t > 0) {
      r.percentOfVotes = ((r.totalVotes / t) * 100).toFixed(2);
    }
  }

  return {
    source: {
      id: "county-ellis",
      type: "county",
      county: "Ellis",
      documentType: "livevoterturnout_enr_html",
      pageUrl: String(pageUrl ?? "").trim(),
      electionId: parseEllisEnrElectionIdFromUrl(pageUrl),
    },
    rows,
    rowCount: rows.length,
  };
}

async function fetchEllisEnrHttp(pageUrl) {
  const url = String(pageUrl ?? "").trim();
  if (!url) throw new Error("Ellis ENR page URL is required");
  if (!/livevoterturnout\.com\/ENR\/ellistxenr/i.test(url)) {
    throw new Error("URL must be an Ellis County livevoterturnout.com ENR page (ellistxenr)");
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(90_000),
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.livevoterturnout.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
      },
    });
    if (!res.ok) throw new Error(`Ellis ENR HTTP ${res.status}`);
    const html = await res.text();
    if (html.length > 2000) return { html, finalUrl: res.url || url };
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw new Error("Ellis ENR page empty or too small after retries");
}

/**
 * @param {string} [pageUrl]
 */
export async function fetchEllisLiveVoterTurnoutAllContests(pageUrl = DEFAULT_PAGE_URL) {
  const { html, finalUrl } = await fetchEllisEnrHttp(pageUrl);
  const parsed = parseEllisLiveVoterTurnoutHtml(html, finalUrl);
  return {
    ...parsed,
    totals: {
      candidateVotes: parsed.rows.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal: parsed.rows[0]?.precinctTotal ?? 0,
      precinctReporting: parsed.rows[0]?.precinctReporting ?? 0,
    },
  };
}
