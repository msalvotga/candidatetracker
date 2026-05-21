/**
 * Discover a county results file URL from an election "hub" HTML page by matching
 * link text in preference order (county-specific profiles).
 */

/** @typedef {{ id: string, label: string, test: (text: string) => boolean }} DiscoveryStage */

/** Dallas County Votes — historical results page lists time-stamped PDF links. */
const DALLAS_STAGES = /** @type {DiscoveryStage[]} */ ([
  {
    id: "final_unofficial",
    label: "Final Unofficial Results Report",
    test: (t) => /\bfinal\b.*\bunofficial\b.*\bresults?\b.*\breport\b/i.test(t),
  },
  {
    id: "nine_pm_unofficial",
    label: "9:00 pm – Unofficial Results Report",
    test: (t) =>
      /\b9\s*:?\s*00\s*p\.?\s*m\.?\s*[–—\-]\s*unofficial\s+results?\s+report/i.test(t),
  },
  {
    id: "seven_pm_early",
    label: "7:00 pm – Early Voting Unofficial Results Report",
    test: (t) =>
      /\b7\s*:?\s*00\s*p\.?\s*m\.?\s*[–—\-]\s*early\s+voting\s+unofficial/i.test(t),
  },
]);

/** Harris County — Live Results hub lists the cumulative PDF (e.g. appfiles.harrisvotes.com …/cumulative.pdf). */
const HARRIS_STAGES = /** @type {DiscoveryStage[]} */ ([
  {
    id: "election_cumulative_report",
    label: "Election Cumulative Report",
    test: (t) => /\belection\s+cumulative\s+report\b/i.test(t),
  },
]);

export function normalizeLinkText(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map Texas county_key slug → ordered stages (extend per county). */
const PROFILES = /** @type {Record<string, DiscoveryStage[]>} */ ({
  dallas: DALLAS_STAGES,
  harris: HARRIS_STAGES,
});

/** True when ingest/UI should run hub-page link discovery for this county slug. */
export function countyHasHubDiscoveryProfile(countyKey) {
  const k = String(countyKey ?? "")
    .trim()
    .toLowerCase();
  return !!(k && PROFILES[k]?.length);
}

function normalizeFetchUrl(hubUrl) {
  const u = new URL(hubUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) hub URLs are allowed");
  u.hash = "";
  return u.toString();
}

/** Block obvious SSRF targets when the server fetches the hub (skipped when only pasted `html` is used). */
export function validateHubUrlForDiscoveryFetch(urlString) {
  const u = new URL(urlString);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) hub URLs are allowed");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") {
    throw new Error("That host is not allowed for hub fetch.");
  }
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  if (ipv4) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error("Private/reserved IP addresses are not allowed for hub fetch.");
    }
    if (a === 0) throw new Error("That IP is not allowed for hub fetch.");
  }
}

/**
 * Extract anchor href + visible text from HTML (no DOM dependency).
 * @returns {{ href: string, text: string }[]}
 */
export function extractAnchorsFromHtml(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attr = m[1] ?? "";
    const inner = m[2] ?? "";
    const hm = attr.match(/\bhref\s*=\s*(["'])([^"']*)\1/i) ?? attr.match(/\bhref\s*=\s*([^\s>]+)/i);
    if (!hm) continue;
    const rawHref = String(hm[2] ?? hm[1] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) continue;
    let abs;
    try {
      abs = new URL(rawHref, base).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    const text = normalizeLinkText(inner.replace(/<[^>]+>/g, " "));
    out.push({ href: abs, text });
  }
  return out;
}

export async function fetchHubPageHtml(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });
  const text = String(await res.text());
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/pdf")) {
    throw new Error("Hub URL points directly to a PDF; use the election results page URL instead.");
  }
  if (!res.ok) throw new Error(`Hub page HTTP ${res.status}`);
  if (!text.trim()) {
    const waf = /challenge|waf|forbidden/i.test(String(res.headers.get("x-amzn-waf-action") || ""));
    throw new Error(
      waf
        ? "Hub page returned no HTML (likely AWS WAF / bot check). Open the hub in a browser, use View Page Source, copy the HTML, and call discover with that HTML body, or paste the direct results file URL."
        : "Hub page returned an empty body; try again later or paste saved page HTML.",
    );
  }
  return text;
}

/**
 * Match extracted links against county stages (no fetch).
 * @param {{ href: string, text: string }[]} links
 * @param {{ countyKey?: string, stages?: DiscoveryStage[] }} options
 */
export function discoverCountyFeedUrlFromLinks(links, options = {}) {
  const countyKey = String(options.countyKey ?? "")
    .trim()
    .toLowerCase();
  const stages = options.stages?.length ? options.stages : PROFILES[countyKey];
  if (!stages?.length) {
    return {
      url: null,
      message: `No discovery profile for county "${countyKey || "(none)"}". Extend PROFILES in server/lib/countyHubDiscovery.mjs.`,
    };
  }
  if (!links.length) return { url: null, message: "No links found on the hub page." };

  for (const stage of stages) {
    for (const link of links) {
      const t = normalizeLinkText(link.text);
      if (!stage.test(t)) continue;
      return {
        url: link.href,
        matchedStage: stage.id,
        matchedLabel: stage.label,
        linkText: t.slice(0, 300),
      };
    }
  }

  const hint =
    countyKey === "dallas"
      ? " (expected Final / 9pm / 7pm-style links)"
      : countyKey === "harris"
        ? " (expected “Election Cumulative Report” on the Live Results hub)"
        : "";
  return { url: null, message: `No preferred results link matched for this county${hint}.` };
}

/**
 * @param {string} hubUrl Base URL for resolving relative links (hash stripped for fetch when HTML not supplied).
 * @param {{ countyKey?: string, stages?: DiscoveryStage[], html?: string }} options
 *   If `html` is non-empty, it is parsed instead of fetching `hubUrl` (for WAF-blocked pages).
 * @returns {Promise<{ url: string | null, matchedStage?: string, matchedLabel?: string, linkText?: string, message?: string }>}
 */
export async function discoverCountyFeedUrlFromHub(hubUrl, options = {}) {
  const trimmed = String(hubUrl ?? "").trim();
  const pasted = String(options.html ?? "").trim();
  const countyKey = String(options.countyKey ?? "")
    .trim()
    .toLowerCase();
  const stages = options.stages?.length ? options.stages : PROFILES[countyKey];
  if (!stages?.length) {
    return {
      url: null,
      message: `No discovery profile for county "${countyKey || "(none)"}". Extend PROFILES in server/lib/countyHubDiscovery.mjs.`,
    };
  }

  if (!trimmed && !pasted) return { url: null, message: "hubUrl is required (or pass html with hubUrl as base for resolving links)." };

  const fetchUrl = trimmed ? normalizeFetchUrl(trimmed) : "https://invalid.invalid/";
  let html;
  if (pasted) {
    if (!trimmed) {
      return { url: null, message: "When using pasted HTML, hubUrl must still be set so relative links can be resolved." };
    }
    html = pasted;
  } else {
    validateHubUrlForDiscoveryFetch(trimmed);
    html = await fetchHubPageHtml(fetchUrl);
  }

  const links = extractAnchorsFromHtml(html, fetchUrl);
  return discoverCountyFeedUrlFromLinks(links, options);
}

export { PROFILES, DALLAS_STAGES, HARRIS_STAGES };
