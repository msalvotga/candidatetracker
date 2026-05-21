import { parse } from "csv-parse/sync";

const CIVIX_ORIGIN = "https://goelect.txelections.civixapps.com";
const CIVIX_API = `${CIVIX_ORIGIN}/api-ivis-system/api`;
const EVR_UI = `${CIVIX_ORIGIN}/ivis-evr-ui`;

export const EVR_FILE_TYPES = {
  ELECTION_LIST: "EVR_ELECTION",
  EARLY_VOTING_BY_COUNTY: "EVR_EARLYVOTING",
  STATEWIDE_ROSTER: "EVR_STATEWIDE",
};

async function fetchJson(url, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  if (!text.trim()) {
    if (allowEmpty) return null;
    throw new Error(`Empty response from Civix for ${url}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Civix for ${url}`);
  }
}

function decodeUploadPayload(raw) {
  if (raw == null) return null;
  const upload = raw?.upload;
  if (typeof upload !== "string" || !upload.trim()) {
    return null;
  }
  const text = Buffer.from(upload, "base64").toString("utf8").trim();
  if (upload.startsWith("{") || upload.startsWith("[")) {
    try {
      return JSON.parse(upload);
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** MM/DD/YYYY for Civix query params. */
export function formatCivixDate(d) {
  const s = String(d ?? "").trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  // HTML <input type="date"> and DB keys use YYYY-MM-DD — parse as calendar date (no TZ shift).
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) throw new Error(`Invalid date: ${d}`);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/** YYYY-MM-DD for DB keys. */
export function toIsoDateKey(d) {
  const s = String(d ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const civix = formatCivixDate(d);
  const [mm, dd, yyyy] = civix.split("/");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Browser URL for the SOS early-voting turnout page (date changes daily during EV).
 * @see https://goelect.txelections.civixapps.com/ivis-evr-ui/official-early-voting-turnout
 */
export function buildOfficialEarlyVotingTurnoutPageUrl({
  type = "EV",
  date,
  electionId,
  electionDate,
  electionName,
  isCertified = false,
}) {
  const params = new URLSearchParams({
    type: String(type),
    date: formatCivixDate(date),
    electionId: String(electionId),
    electionDate: formatCivixDate(electionDate),
    electionName: String(electionName),
    isCertified: isCertified ? "true" : "false",
  });
  return `${EVR_UI}/official-early-voting-turnout?${params.toString()}`;
}

function getFileUrl(type, electionId, electionDate) {
  const q = new URLSearchParams({ type: String(type) });
  if (electionId != null && String(electionId).trim() !== "") {
    q.set("electionId", String(electionId));
  }
  if (electionDate != null && String(electionDate).trim() !== "") {
    q.set("electionDate", formatCivixDate(electionDate));
  }
  return `${CIVIX_API}/v1/getFile?${q.toString()}`;
}

/** @returns {Promise<object|string|null>} null when Civix has no file for this date yet */
async function fetchEvrGetFile(type, electionId, fileDate) {
  const url = getFileUrl(type, electionId, fileDate);
  const raw = await fetchJson(url, { allowEmpty: true });
  if (raw == null) return null;
  try {
    return decodeUploadPayload(raw);
  } catch {
    return null;
  }
}

/** All elections available in the EVR portal (includes runoff IDs 58314/58315). */
export async function listEvrElections() {
  const raw = await fetchJson(getFileUrl(EVR_FILE_TYPES.ELECTION_LIST));
  const data = decodeUploadPayload(raw);
  if (!data) throw new Error("Civix EVR election list missing upload payload");
  const elections = Array.isArray(data?.elections) ? data.elections : [];
  return {
    dateUpdated: data?.date_updated ?? null,
    elections: elections.map((e) => ({
      evrElectionId: Number(e.id),
      type: String(e.type ?? "EV"),
      electionDate: String(e.election_date ?? ""),
      electionName: String(e.election_name ?? ""),
      certified: !!e.certified,
      earlyVotingDates: (e.early_voting_dates ?? []).map((d) => ({
        date: String(d.date ?? ""),
        dateTurnoutId: d.date_turnout_id ?? null,
      })),
    })),
  };
}

/**
 * County-level cumulative early voting totals for one early-voting day.
 * Note: Civix names the query param `electionDate` but expects the **early voting date**.
 */
export async function fetchEarlyVotingTurnoutByCounty(evrElectionId, votingDate) {
  const url = getFileUrl(EVR_FILE_TYPES.EARLY_VOTING_BY_COUNTY, evrElectionId, votingDate);
  const data = await fetchEvrGetFile(EVR_FILE_TYPES.EARLY_VOTING_BY_COUNTY, evrElectionId, votingDate);
  if (data == null) {
    return {
      dateUpdated: null,
      evrElectionId: Number(evrElectionId),
      electionType: null,
      earlyVotingDate: toIsoDateKey(votingDate),
      counties: [],
      sourceUrl: url,
      noData: true,
    };
  }
  const counties = Array.isArray(data?.turnout_by_county) ? data.turnout_by_county : [];
  return {
    dateUpdated: data?.date_updated ?? null,
    evrElectionId: Number(data?.election_id ?? evrElectionId),
    electionType: data?.election_type ?? null,
    earlyVotingDate: data?.early_voting_date ?? toIsoDateKey(votingDate),
    counties: counties.map((c) => ({
      name: String(c.name ?? "").toUpperCase(),
      countyId: c.id != null ? Number(c.id) : null,
      registeredVoters: Number(c.registered_voters ?? 0),
      inPersonVotesOnDate: Number(c.in_person_votes_on_date ?? 0),
      totalInPersonVotesForElection: Number(c.total_in_person_votes_for_election ?? 0),
      totalMailVotesForElection: Number(c.total_mail_votes_for_election ?? 0),
      voterDetailsReport: c.voter_details_report ?? null,
    })),
    sourceUrl: url,
  };
}

/**
 * Statewide CSV roster: COUNTY, VOTER_NAME, ID_VOTER, VOTING_METHOD, PRECINCT.
 */
export async function fetchStatewideEarlyVotingRosterCsv(evrElectionId, votingDate) {
  const url = getFileUrl(EVR_FILE_TYPES.STATEWIDE_ROSTER, evrElectionId, votingDate);
  const decoded = await fetchEvrGetFile(EVR_FILE_TYPES.STATEWIDE_ROSTER, evrElectionId, votingDate);
  const csvText = decoded == null ? "" : typeof decoded === "string" ? decoded : String(decoded ?? "");
  const rows = parseStatewideRosterCsv(csvText);
  return {
    rows,
    sourceUrl: url,
    voterCount: rows.length,
    noData: decoded == null,
  };
}

export function parseStatewideRosterCsv(csvText) {
  const trimmed = String(csvText ?? "").trim();
  if (!trimmed) return [];
  const records = parse(trimmed, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  return records
    .map((r) => {
      const vuid = String(r.ID_VOTER ?? r.id_voter ?? r.VUID ?? "").trim();
      if (!vuid) return null;
      return {
        county: String(r.COUNTY ?? r.county ?? "").toUpperCase(),
        voterName: String(r.VOTER_NAME ?? r.voter_name ?? "").trim(),
        vuid,
        votingMethod: String(r.VOTING_METHOD ?? r.voting_method ?? "").trim(),
        precinct: String(r.PRECINCT ?? r.precinct ?? "").trim(),
      };
    })
    .filter(Boolean);
}

/**
 * Per-county voter CSV from Civix (may be empty for some counties — use statewide slice as fallback).
 */
export async function fetchCountyEarlyVotingRosterCsv(evrElectionId, votingDate, countyName, countyId) {
  const q = new URLSearchParams({
    type: EVR_FILE_TYPES.EARLY_VOTING_BY_COUNTY,
    electionId: String(evrElectionId),
    electionDate: formatCivixDate(votingDate),
    county: String(countyName),
    countyId: String(countyId),
    format: "csv",
  });
  const url = `${CIVIX_API}/v1/getFileByFormat?${q.toString()}`;
  try {
    const raw = await fetchJson(url);
    const upload = raw?.upload;
    if (typeof upload !== "string" || !upload.trim()) {
      return { rows: [], sourceUrl: url, voterCount: 0 };
    }
    const decoded = decodeUploadPayload(raw);
    const csvText = typeof decoded === "string" ? decoded : String(decoded ?? "");
    const rows = parseStatewideRosterCsv(csvText);
    return { rows, sourceUrl: url, voterCount: rows.length };
  } catch {
    return { rows: [], sourceUrl: url, voterCount: 0 };
  }
}

export function countVotersByCounty(rows) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const r of rows) {
    const key = String(r.county ?? "").toUpperCase();
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}
