import { rowMatchesVotingDate, toYyyymmddKey } from "./evRosterDateMatch.mjs";

/** @typedef {'EV' | 'AB' | 'ED'} MethodCode */

/**
 * Normalize SOS / county voting method text to EV, AB, or ED.
 * @param {string} raw
 * @param {{ defaultMethod?: MethodCode }} [opts]
 * @returns {MethodCode}
 */
export function normalizeVotingMethod(raw, opts = {}) {
  const t = String(raw ?? "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return opts.defaultMethod ?? "EV";
  if (/\b(BBM|BALLOT\s*BY\s*MAIL|MAIL|ABSENTEE|AB)\b/.test(t)) return "AB";
  if (/\b(ELECTION\s*DAY|ED)\b/.test(t)) return "ED";
  if (/\b(IN[- ]?PERSON|EARLY|EV)\b/.test(t)) return "EV";
  return opts.defaultMethod ?? "EV";
}

export function normalizeVuid(vuid) {
  return String(vuid ?? "")
    .replace(/\D/g, "")
    .trim();
}

/**
 * @param {string} rowMethod raw method from file
 * @param {string} votingMethodScope ALL | EV | AB | ED
 */
export function methodCodeFromScope(rowMethod, votingMethodScope) {
  const scope = String(votingMethodScope ?? "ALL").toUpperCase();
  if (scope === "ALL") return normalizeVotingMethod(rowMethod);
  if (scope === "EV") return "EV";
  if (scope === "AB" || scope === "BBM") return "AB";
  if (scope === "ED") return "ED";
  return normalizeVotingMethod(rowMethod, { defaultMethod: /** @type {MethodCode} */ (scope) });
}

export function normalizeParty(party) {
  const p = String(party ?? "")
    .toUpperCase()
    .trim();
  if (p === "R" || p === "REP" || p === "REPUBLICAN" || p === "GOP") return "REP";
  if (p === "D" || p === "DEM" || p === "DEMOCRAT" || p === "DEMOCRATIC") return "DEM";
  return p.slice(0, 16) || "";
}

/**
 * Party from a county roster row when the file lists both major parties (e.g. Harris ZIPs).
 * @param {Record<string, unknown>} row
 * @returns {string} REP, DEM, or "" if unknown
 */
export function rowPartyFromRecord(row) {
  if (!row || typeof row !== "object") return "";
  if (row.party != null && String(row.party).trim() !== "") {
    return normalizeParty(row.party);
  }
  const raw = String(
    row.PARTY ??
      row.Party ??
      row.party ??
      row["Ballot Party"] ??
      row.BALLOT_PARTY ??
      row.PARTY_CD ??
      row.PartyCode ??
      row.POLITICAL_PARTY ??
      row.PoliticalParty ??
      row.PolAff ??
      row.PRIMARY_PARTY ??
      row.PrimaryParty ??
      row.VOTER_PARTY ??
      row.VoterParty ??
      "",
  ).trim();
  return normalizeParty(raw);
}

/**
 * When the file includes party, keep only rows for the election being pulled (58314 DEM / 58315 REP).
 * Rows without party are kept and tagged with the pull party later.
 * @param {Record<string, unknown>} row
 * @param {string} pullParty
 */
export function rowMatchesElectionParty(row, pullParty) {
  const rowParty = rowPartyFromRecord(row);
  const want = normalizeParty(pullParty);
  if (!rowParty || !want) return true;
  return rowParty === want;
}

/** @returns {'COMBINED' | 'REP_ONLY' | 'DEM_ONLY'} */
export function normalizeRosterPartyScope(scope) {
  const s = String(scope ?? "COMBINED")
    .toUpperCase()
    .trim();
  if (s === "REP" || s === "REP_ONLY" || s === "R" || s === "REPUBLICAN") return "REP_ONLY";
  if (s === "DEM" || s === "DEM_ONLY" || s === "D" || s === "DEMOCRAT" || s === "DEMOCRATIC") {
    return "DEM_ONLY";
  }
  return "COMBINED";
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} filePartyScope COMBINED | REP_ONLY | DEM_ONLY
 * @param {string} pullParty election party (REP / DEM)
 */
export function rosterRowPassesPartyFilter(row, filePartyScope, pullParty) {
  const scope = normalizeRosterPartyScope(filePartyScope);
  if (scope === "REP_ONLY" || scope === "DEM_ONLY") {
    return true;
  }
  return rowMatchesElectionParty(row, pullParty);
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} filePartyScope
 * @param {string} pullParty
 */
export function partyTagForRosterRow(row, filePartyScope, pullParty) {
  const scope = normalizeRosterPartyScope(filePartyScope);
  if (scope === "REP_ONLY") return "REP";
  if (scope === "DEM_ONLY") return "DEM";
  const fromRow = rowPartyFromRecord(row);
  return fromRow || normalizeParty(pullParty);
}

/**
 * @typedef {object} RosterVoterInput
 * @property {string} vuid
 * @property {string} countyName
 * @property {string} [party]
 * @property {MethodCode} [methodCode]
 * @property {string} [votingMethod]
 * @property {string} [voterName]
 * @property {string} [precinct]
 * @property {string} sourceKey
 */

/**
 * Dedupe by VUID; prefer county source over SOS.
 * @param {RosterVoterInput[]} records
 */
/**
 * When county ZIP/CSV rosters are used, Civix turnout often shows 0 in-person for that county.
 * Fill summary turnout columns from ingested roster rows (EV = in-person early vote, AB = mail).
 * @param {Map<string, object>} summaryByCounty
 * @param {Array<{ countyName?: string, county?: string, methodCode?: string, sourceKey?: string }>} records
 */
/**
 * @param {Map<string, object>} summaryByCounty
 * @param {Array<{ countyName?: string, county?: string, methodCode?: string, sourceKey?: string, vuid?: string, activityDate?: string }>} records
 * @param {{ votingDate?: string }} [options]
 */
export function applyCountyRosterTurnoutFromRecords(summaryByCounty, records, options = {}) {
  const votingDate = String(options.votingDate ?? "").trim();
  /** @type {Map<string, { ev: Set<string>, ab: Set<string>, ed: Set<string>, evOnDate: Set<string> }>} */
  const byCounty = new Map();
  for (const r of records ?? []) {
    const sk = String(r.sourceKey ?? "");
    if (!sk.startsWith("county:")) continue;
    const name = String(r.countyName ?? r.county ?? "").toUpperCase();
    if (!name) continue;
    const vuid = normalizeVuid(r.vuid);
    if (!vuid) continue;
    const cur = byCounty.get(name) ?? {
      ev: new Set(),
      ab: new Set(),
      ed: new Set(),
      evOnDate: new Set(),
    };
    const m = String(r.methodCode ?? normalizeVotingMethod(r.votingMethod)).toUpperCase();
    if (m === "AB") cur.ab.add(vuid);
    else if (m === "ED") cur.ed.add(vuid);
    else {
      cur.ev.add(vuid);
      if (votingDate && rowMatchesVotingDate(r, votingDate)) cur.evOnDate.add(vuid);
    }
    byCounty.set(name, cur);
  }
  for (const [countyName, counts] of byCounty) {
    const sum = summaryByCounty.get(countyName);
    if (!sum) continue;
    const ev = counts.ev.size;
    const ab = counts.ab.size;
    const ed = counts.ed.size;
    sum.inPersonVotesOnDate = votingDate ? counts.evOnDate.size : ev;
    sum.totalInPersonVotesForElection = ev;
    sum.totalMailVotesForElection = ab;
    sum.cumulativeTotal = ev + ab + ed;
  }
}

export function dedupeVotersByVuid(records) {
  const rank = (sourceKey) => {
    const k = String(sourceKey ?? "");
    if (k.startsWith("county:")) return 3;
    if (k.startsWith("civix-county")) return 2;
    if (k === "sos" || k.startsWith("sos:")) return 1;
    return 0;
  };

  /** @type {Map<string, RosterVoterInput & { _rank: number }>} */
  const byVuid = new Map();
  for (const r of records) {
    const vuid = normalizeVuid(r.vuid);
    if (!vuid) continue;
    const row = {
      ...r,
      vuid,
      countyName: String(r.countyName ?? r.county ?? "").toUpperCase(),
      methodCode: r.methodCode ?? normalizeVotingMethod(r.votingMethod),
      party: normalizeParty(r.party),
      _rank: rank(r.sourceKey),
    };
    const prev = byVuid.get(vuid);
    if (!prev || row._rank > prev._rank) byVuid.set(vuid, row);
  }
  return [...byVuid.values()].map(({ _rank, ...rest }) => rest);
}

/**
 * @param {Array<{ vuid: string, party?: string, votingDate: string, countyName: string, methodCode: string }>} rows
 */
export function rosterRowsToCsv(rows) {
  const header = "VUID,County,Party,Date,Method";
  const lines = [header];
  for (const r of rows) {
    const cols = [
      r.vuid,
      r.countyName,
      r.party ?? "",
      toYyyymmddKey(r.votingDate),
      r.methodCode,
    ].map((c) => {
      const s = String(c ?? "");
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    });
    lines.push(cols.join(","));
  }
  return lines.join("\r\n");
}
