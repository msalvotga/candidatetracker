import { decodeUploadPayload } from "./b64.mjs";
import { buildCivixFetchHeaders } from "./civixCredentials.mjs";

const CIVIX_API =
  process.env.CIVIX_API_BASE?.trim() ||
  "https://goelect.txelections.civixapps.com/api-ivis-system/api";

const CIVIX_FETCH_MS = 12_000;

/** @param {AbortSignal} [signal] */
function civixFetchSignal(signal) {
  const timeout = AbortSignal.timeout(CIVIX_FETCH_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Civix answers unknown or not-yet-published elections with `{"Version":""}` and no Home or race sections.
 * @param {Record<string, unknown> | null | undefined} election
 */
export function civixElectionUnpublished(election) {
  if (!election || typeof election !== "object") return true;
  return !(election.Home || election.Federal || election.StateWide || election.Districted || election.StateWideQ);
}

/** @param {string} url @param {string} [requestCookie] @param {AbortSignal} [signal] */
async function fetchJson(url, requestCookie, signal) {
  const res = await fetch(url, {
    headers: await buildCivixFetchHeaders(requestCookie),
    signal: civixFetchSignal(signal),
  });
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
/** @param {string} url @param {string} [requestCookie] @param {AbortSignal} [signal] */
async function tryFetchCountyJson(url, requestCookie, signal) {
  const res = await fetch(url, {
    headers: await buildCivixFetchHeaders(requestCookie),
    signal: civixFetchSignal(signal),
  });
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
  const requestCookie = overrides?.requestCookie;

  const election = await fetchJson(electionUrl, requestCookie);
  if (civixElectionUnpublished(election)) {
    return {
      election,
      county: {},
      sosCountyInfoUrlConfigured,
      sosCountyInfoUrlUsed: "",
    };
  }

  /** @type {{ used: string }} */
  const countyFetch = { used: defaultCountyUrl };
  let county;
  if (!override) {
    county = await fetchJson(defaultCountyUrl, requestCookie);
  } else {
    const attempt = await tryFetchCountyJson(override, requestCookie);
    if (attempt.ok) {
      countyFetch.used = override;
      county = attempt.data;
    } else {
      console.warn("countyInfoUrl override is not valid Civix JSON; using default county bundle", {
        civixElectionId,
        override,
        detail: attempt.error,
      });
      countyFetch.used = defaultCountyUrl;
      county = await fetchJson(defaultCountyUrl, requestCookie);
    }
  }

  return {
    election,
    county,
    sosCountyInfoUrlConfigured,
    sosCountyInfoUrlUsed: countyFetch.used,
  };
}
