import { listEvrElections, toIsoDateKey } from "./civixEvr.mjs";

/** @param {string} electionDate MM/DD/YYYY or YYYY-MM-DD */
export function parseElectionCalendarDate(electionDate) {
  const s = String(electionDate ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const civix = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (civix) return new Date(Number(civix[3]), Number(civix[1]) - 1, Number(civix[2]));
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) throw new Error(`Invalid election date: ${electionDate}`);
  return dt;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Inclusive YYYY-MM-DD dates from early voting start through today (or day before election). */
export function earlyVotingDatesThroughToday(electionDate, through = new Date()) {
  const election = startOfLocalDay(parseElectionCalendarDate(electionDate));
  const today = startOfLocalDay(through);
  const lastEvDay = addDays(election, -1);
  const end = today.getTime() < lastEvDay.getTime() ? today : lastEvDay;
  const start = addDays(election, -17);
  const out = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    out.push(toIsoDateKey(d));
  }
  return out;
}

/**
 * Early voting days from Civix election list (preferred), else calendar estimate.
 * @param {number} evrElectionId
 * @param {string} runoffElectionDate election day from config (MM/DD/YYYY)
 * @param {Date} [through]
 */
export async function earlyVotingDatesForRunoff(evrElectionId, runoffElectionDate, through = new Date()) {
  try {
    const { elections } = await listEvrElections();
    const match = elections.find((e) => Number(e.evrElectionId) === Number(evrElectionId));
    if (match?.earlyVotingDates?.length) {
      const election = startOfLocalDay(parseElectionCalendarDate(runoffElectionDate));
      const today = startOfLocalDay(through);
      const lastEvDay = addDays(election, -1);
      const end = today.getTime() < lastEvDay.getTime() ? today : lastEvDay;
      const dates = match.earlyVotingDates
        .map((d) => toIsoDateKey(d.date))
        .filter((iso) => {
          if (!iso) return false;
          const day = startOfLocalDay(parseElectionCalendarDate(iso));
          return day.getTime() <= end.getTime();
        })
        .sort();
      if (dates.length) return [...new Set(dates)];
    }
  } catch (e) {
    console.warn("Civix early voting date list failed, using calendar range:", e?.message ?? e);
  }
  return earlyVotingDatesThroughToday(runoffElectionDate, through);
}

/**
 * Group configs that share the same election day (DEM + REP runoff).
 * @param {Array<{ evrElectionId: number, party?: string, electionName?: string, electionDate?: string }>} configs
 */
export function groupConfigsIntoRunoffs(configs) {
  /** @type {Map<string, object>} */
  const byDate = new Map();
  for (const c of configs ?? []) {
    const electionDate = String(c.electionDate ?? "").trim();
    if (!electionDate) continue;
    const key = toIsoDateKey(electionDate);
    const cur =
      byDate.get(key) ??
      {
        runoffKey: key,
        electionDate,
        label: "",
        evrElectionIds: [],
        parties: [],
        configs: [],
      };
    cur.configs.push(c);
    cur.evrElectionIds.push(Number(c.evrElectionId));
    if (c.party) cur.parties.push(String(c.party).toUpperCase());
    byDate.set(key, cur);
  }
  for (const g of byDate.values()) {
    g.evrElectionIds = [...new Set(g.evrElectionIds)].sort((a, b) => a - b);
    g.parties = [...new Set(g.parties)].sort();
    const names = [...new Set(g.configs.map((c) => String(c.electionName ?? "").trim()).filter(Boolean))];
    g.label =
      names.length === 1
        ? names[0]
        : `Runoff ${g.electionDate}${g.parties.length ? ` (${g.parties.join(" + ")})` : ""}`;
    g.primaryEvrElectionId = g.evrElectionIds[0] ?? null;
  }
  return [...byDate.values()].sort((a, b) => String(b.electionDate).localeCompare(String(a.electionDate)));
}

/**
 * @param {Array<object>} configs
 * @param {number} evrElectionId
 */
export function runoffConfigsForElection(configs, evrElectionId) {
  const groups = groupConfigsIntoRunoffs(configs);
  const g = groups.find((r) => r.evrElectionIds.includes(Number(evrElectionId)));
  return g?.configs ?? configs.filter((c) => Number(c.evrElectionId) === Number(evrElectionId));
}

/**
 * @param {string} partyFilter ALL | REP | DEM
 * @param {Array<{ evrElectionId: number, party?: string }>} configs
 */
export function configsForPartyFilter(configs, partyFilter) {
  const want = String(partyFilter ?? "ALL").toUpperCase();
  if (want === "ALL") return configs;
  return configs.filter((c) => String(c.party ?? "").toUpperCase() === want);
}

/** Local calendar today as YYYY-MM-DD. */
export function todayIsoDateKey(d = new Date()) {
  return toIsoDateKey(d);
}

/** County summary filter range: earliest stored date through today. */
export function summaryDateRangeFromPullDates(pullDates) {
  const stored = [...new Set((pullDates ?? []).map((d) => String(d).trim()).filter(Boolean))].sort();
  if (!stored.length) return { dateFrom: "", dateTo: "" };
  return { dateFrom: stored[0], dateTo: todayIsoDateKey() };
}

/** @alias summaryDateRangeFromPullDates — dates come from voter row activity dates. */
export function summaryDateRangeFromVoterDates(voterDates) {
  return summaryDateRangeFromPullDates(voterDates);
}
