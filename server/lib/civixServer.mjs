import { decodeUploadPayload } from "./b64.mjs";

const CIVIX_API =
  process.env.CIVIX_API_BASE?.trim() ||
  "https://goelect.txelections.civixapps.com/api-ivis-system/api";

function civixFetchHeaders() {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      process.env.CIVIX_USER_AGENT?.trim() ||
      "Mozilla/5.0 (compatible; electionnighttracker/1.0; +https://github.com/)",
    Referer:
      process.env.CIVIX_REFERER?.trim() || "https://goelect.txelections.civixapps.com/ivis-enr-ui/",
    Origin: process.env.CIVIX_ORIGIN?.trim() || "https://goelect.txelections.civixapps.com",
  };
  const cookie = process.env.CIVIX_COOKIE?.trim();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: civixFetchHeaders() });
  if (!res.ok) {
    const hint =
      res.status === 403
        ? " (Civix often returns 403 from cloud/datacenter IPs — use county feeds, run ingest from a network that can reach Civix, or set CIVIX_COOKIE from a browser session)"
        : "";
    throw new Error(`HTTP ${res.status} for ${url}${hint}`);
  }
  return res.json();
}

/**
 * County override URLs must return Civix-style JSON. Users sometimes paste a PDF/ZIP/HTML link —
 * detect that and fail softly so callers can fall back to the default countyInfo endpoint.
 * @returns {{ ok: true, data: unknown } | { ok: false, error: string }}
 */
async function tryFetchCountyJson(url) {
  const res = await fetch(url, { headers: civixFetchHeaders() });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("pdf")) return { ok: false, error: "content-type is PDF" };
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8.length >= 4) {
    const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (sig === "%PDF") return { ok: false, error: "body is PDF" };
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return { ok: false, error: "body is not JSON" };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: "JSON parse failed" };
  }
}

export async function listCivixElectionSummaries() {
  const raw = await fetchJson(`${CIVIX_API}/s3/enr/electionConstants`);
  const inner = decodeUploadPayload(raw);
  const ei = inner.electionInfo;
  const out = [];
  for (const year of Object.keys(ei).sort().reverse()) {
    for (const category of Object.keys(ei[year])) {
      for (const idStr of Object.keys(ei[year][category])) {
        const row = ei[year][category][idStr];
        const id = row.ID ?? Number(idStr);
        out.push({
          civixElectionId: id,
          catalogLabel: `${row.N} (${year})`,
          year,
          category,
        });
      }
    }
  }
  return out;
}

export async function fetchCivixElectionBundle(civixElectionId) {
  return fetchCivixElectionBundleWithOverrides(civixElectionId, {});
}

export async function fetchCivixElectionBundleWithOverrides(civixElectionId, overrides) {
  const electionUrl = `${CIVIX_API}/s3/enr/election/${civixElectionId}`;
  const defaultCountyUrl = `${CIVIX_API}/s3/enr/election/countyInfo/${civixElectionId}`;
  const override = overrides?.countyInfoUrl?.trim();
  const sosCountyInfoUrlConfigured = override || "";

  const electionP = fetchJson(electionUrl);
  /** @type {{ used: string }} */
  const countyFetch = { used: defaultCountyUrl };
  const countyP = (async () => {
    if (!override) {
      countyFetch.used = defaultCountyUrl;
      return fetchJson(defaultCountyUrl);
    }
    const attempt = await tryFetchCountyJson(override);
    if (attempt.ok) {
      countyFetch.used = override;
      return attempt.data;
    }
    console.warn("countyInfoUrl override is not valid Civix JSON; using default county bundle", {
      civixElectionId,
      override,
      detail: attempt.error,
    });
    countyFetch.used = defaultCountyUrl;
    return fetchJson(defaultCountyUrl);
  })();

  const [election, county] = await Promise.all([electionP, countyP]);
  return {
    election,
    county,
    sosCountyInfoUrlConfigured,
    sosCountyInfoUrlUsed: countyFetch.used,
  };
}
