/**
 * Loads `server/data/historical/SD4_precinct_wide_by_election.csv` — wide precinct file with columns:
 *   county, precinct,
 *   GE{Year}_{LastName}_{Party}__{early_vote|election_day|mail|absentee|votes_reported}
 *
 * Aggregates to county totals, picks the latest general-election year per county that has vote data,
 * and exposes party totals for joining to live results by candidate party.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.join(__dirname, "../data/historical/SD4_precinct_wide_by_election.csv");

const VOTE_COMPONENTS = new Set(["early_vote", "election_day", "mail", "absentee"]);
const REPORTED_FALLBACK = "votes_reported";

/** @typedef {{ year: number, lastSlug: string, party: string, metric: string }} ColMeta */

/** Parse one data column name into metadata, or null for county/precinct / unknown. */
export function parseHistoricalColumnName(col) {
  const s = String(col ?? "").trim();
  const m = s.match(/^GE(\d{4})_([^_]+)_([A-Z]{2,5})__(.+)$/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    lastSlug: String(m[2]),
    party: String(m[3]).toUpperCase(),
    metric: String(m[4]).trim(),
  };
}

function num(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function emptyCache() {
  return {
    /** @type {Map<string, Map<number, Map<string, { ev: number; ed: number; mail: number; abs: number; total: number }>>> | null} */
    byCountyYearPartyDetail: null,
    /** @type {Map<string, number> | null} */
    latestYearByCounty: null,
    loadedPath: null,
  };
}

const cache = emptyCache();

function emptyPartyBuckets() {
  return { ev: 0, ed: 0, mail: 0, abs: 0, total: 0 };
}

/**
 * @returns {{
 *   sourcePath: string,
 *   latestYearByCounty: Map<string, number>,
 *   byCountyYearPartyDetail: Map<string, Map<number, Map<string, { ev: number; ed: number; mail: number; abs: number; total: number }>>>,
 * }}
 */
export function loadSd4HistoricalAggregates(csvPath = DEFAULT_CSV) {
  if (cache.byCountyYearPartyDetail && cache.loadedPath === csvPath) {
    return {
      sourcePath: csvPath,
      latestYearByCounty: cache.latestYearByCounty,
      byCountyYearPartyDetail: cache.byCountyYearPartyDetail,
    };
  }

  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    cache.byCountyYearPartyDetail = new Map();
    cache.latestYearByCounty = new Map();
    cache.loadedPath = csvPath;
    return {
      sourcePath: abs,
      latestYearByCounty: cache.latestYearByCounty,
      byCountyYearPartyDetail: cache.byCountyYearPartyDetail,
    };
  }

  const raw = fs.readFileSync(abs, "utf8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  if (!rows.length) {
    cache.byCountyYearPartyDetail = new Map();
    cache.latestYearByCounty = new Map();
    cache.loadedPath = csvPath;
    return {
      sourcePath: abs,
      latestYearByCounty: cache.latestYearByCounty,
      byCountyYearPartyDetail: cache.byCountyYearPartyDetail,
    };
  }

  const headers = Object.keys(rows[0]);
  /** @type {Map<string, ColMeta[]>} key `${year}|${lastSlug}|${party}` -> list of column metas (for grouping metrics) */
  const groups = new Map();
  for (const h of headers) {
    const meta = parseHistoricalColumnName(h);
    if (!meta) continue;
    const gk = `${meta.year}|${meta.lastSlug}|${meta.party}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push({ ...meta, header: h });
  }

  /** countyLower -> year -> party -> buckets */
  const triple = new Map();

  function ensureCounty(c) {
    if (!triple.has(c)) triple.set(c, new Map());
    return triple.get(c);
  }

  function ensureYear(m, y) {
    if (!m.has(y)) m.set(y, new Map());
    return m.get(y);
  }

  for (const row of rows) {
    const countyRaw = String(row.county ?? "").trim();
    if (!countyRaw) continue;
    const countyKey = countyRaw.toLowerCase();

    for (const [, metas] of groups) {
      const byMetric = Object.fromEntries(metas.map((m) => [m.metric, m]));
      const sample = metas[0];
      if (!sample) continue;
      const { year, party } = sample;

      let ev = 0;
      let ed = 0;
      let mail = 0;
      let absVotes = 0;
      const evCol = metas.find((m) => m.metric === "early_vote");
      const edCol = metas.find((m) => m.metric === "election_day");
      const mailCol = metas.find((m) => m.metric === "mail");
      const absCol = metas.find((m) => m.metric === "absentee");
      if (evCol) ev = num(row[evCol.header]);
      if (edCol) ed = num(row[edCol.header]);
      if (mailCol) mail = num(row[mailCol.header]);
      if (absCol) absVotes = num(row[absCol.header]);

      const compSum = ev + ed + mail + absVotes;
      let totalAdd = compSum;
      if (compSum <= 0 && byMetric[REPORTED_FALLBACK]) {
        totalAdd = num(row[byMetric[REPORTED_FALLBACK].header]);
      }
      if (totalAdd <= 0) continue;

      const cm = ensureCounty(countyKey);
      const ym = ensureYear(cm, year);
      const cur = ym.get(party) ?? emptyPartyBuckets();
      cur.ev += ev;
      cur.ed += ed;
      cur.mail += mail;
      cur.abs += absVotes;
      cur.total += totalAdd;
      ym.set(party, cur);
    }
  }

  /** @type {Map<string, number>} */
  const latestYearByCounty = new Map();
  for (const [countyKey, yearMap] of triple) {
    const years = [...yearMap.keys()].sort((a, b) => b - a);
    for (const y of years) {
      const parties = yearMap.get(y);
      let sumT = 0;
      for (const b of parties.values()) sumT += b.total;
      if (sumT > 0) {
        latestYearByCounty.set(countyKey, y);
        break;
      }
    }
  }

  cache.byCountyYearPartyDetail = triple;
  cache.latestYearByCounty = latestYearByCounty;
  cache.loadedPath = csvPath;

  return { sourcePath: abs, latestYearByCounty, byCountyYearPartyDetail: triple };
}

/**
 * @returns {Record<string, { year: number, byParty: Record<string, number>, byPartyDetail: Record<string, { earlyVote: number, electionDay: number, total: number }> }>}
 */
export function getSd4HistoricalPayloadForApi() {
  const { latestYearByCounty, byCountyYearPartyDetail } = loadSd4HistoricalAggregates();
  /** @type {Record<string, { year: number, byParty: Record<string, number>, byPartyDetail: Record<string, { earlyVote: number, electionDay: number, total: number }> }>} */
  const counties = {};
  for (const [countyKey, yLatest] of latestYearByCounty) {
    const yearMap = byCountyYearPartyDetail.get(countyKey);
    const parties = yearMap?.get(yLatest);
    if (!parties) continue;
    /** @type {Record<string, { earlyVote: number, electionDay: number, total: number }>} */
    const byPartyDetail = {};
    /** @type {Record<string, number>} */
    const byParty = {};
    for (const [party, b] of parties.entries()) {
      byPartyDetail[party] = {
        earlyVote: b.ev,
        electionDay: b.ed,
        total: b.total,
      };
      byParty[party] = b.total;
    }
    counties[countyKey] = {
      year: yLatest,
      byParty,
      byPartyDetail,
    };
  }
  return counties;
}

/** Normalize Civix / UI county label to CSV-style lookup key. */
export function normalizeCountyLookupKey(displayName) {
  return String(displayName ?? "")
    .trim()
    .replace(/\s+county\s*$/i, "")
    .trim()
    .toLowerCase();
}

export function clearSd4HistoricalCache() {
  cache.byCountyYearPartyDetail = null;
  cache.latestYearByCounty = null;
  cache.loadedPath = null;
}
