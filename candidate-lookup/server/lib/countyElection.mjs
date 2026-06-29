import { TEXAS_COUNTIES } from "../data/texas-counties.mjs";

const COUNTY_BY_COMPACT = new Map();

for (const name of TEXAS_COUNTIES) {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  COUNTY_BY_COMPACT.set(compact, { name, key });
}

export function canonicalCountyKey(rawName) {
  const compact = String(rawName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const match = COUNTY_BY_COMPACT.get(compact);
  if (match) return match.key;

  return String(rawName ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function canonicalCountyName(rawName) {
  const compact = String(rawName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return COUNTY_BY_COMPACT.get(compact)?.name ?? String(rawName ?? "").trim();
}

export function normalizeCountyShare(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (Math.abs(num) > 1) return num / 100;
  return num;
}

export function normalizeCountyMargin(margin, gopPct, demPct) {
  if (margin != null && margin !== "") {
    const num = Number(margin);
    if (Number.isFinite(num)) {
      return Math.abs(num) > 1 ? num / 100 : num;
    }
  }

  const gop = normalizeCountyShare(gopPct);
  const dem = normalizeCountyShare(demPct);
  if (gop != null && dem != null) return gop - dem;
  if (gop != null) return gop - 0.5;
  return null;
}

export function normalizeCountyResultRow(row) {
  const county_name = canonicalCountyName(row.county_name ?? row.county_key);
  const county_key = canonicalCountyKey(county_name);
  const gop_pct = normalizeCountyShare(row.gop_pct);
  const dem_pct = normalizeCountyShare(row.dem_pct);
  const margin = normalizeCountyMargin(row.margin, gop_pct, dem_pct);

  return {
    county_name,
    county_key,
    margin,
    gop_pct,
    dem_pct,
    gop_votes: row.gop_votes ?? null,
    dem_votes: row.dem_votes ?? null,
  };
}

/** @deprecated use canonicalCountyKey */
export function normalizeCountyKey(name) {
  return canonicalCountyKey(name);
}
