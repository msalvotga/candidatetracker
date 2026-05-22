/**
 * Pre-aggregated EV roster stats (rebuilt after each pull / dedupe).
 * Summary page reads from these tables instead of scanning ev_roster_voters.
 */

/** No-op: cache tables are created in server/schema/postgres.sql */
export const EV_ROSTER_SUMMARY_CACHE_DDL_POSTGRES = `SELECT 1`;

/**
 * @param {number} evrElectionId
 * @param {{ pool: import("./pgPool.mjs").ReturnType<import("./pgPool.mjs").createCompatPool> }} ctx
 */
export async function rebuildEvRosterSummaryCache(evrElectionId, ctx) {
  const eid = Number(evrElectionId);
  if (!eid) return { activityRows: 0, registeredRows: 0 };
  if (!ctx.pool) throw new Error("rebuildEvRosterSummaryCache requires pool");
  return rebuildEvRosterSummaryCachePg(eid, ctx.pool);
}

/**
 * @param {number} eid
 * @param {ReturnType<import("./pgPool.mjs").createCompatPool>} pool
 */
async function rebuildEvRosterSummaryCachePg(eid, pool) {
  await pool.request().input("evr_election_id", eid).query(`
    DELETE FROM ev_roster_activity_cache WHERE evr_election_id = @evr_election_id;
    DELETE FROM ev_roster_registered_cache WHERE evr_election_id = @evr_election_id;
  `);

  await pool.request().input("evr_election_id", eid).query(`
    INSERT INTO ev_roster_activity_cache (evr_election_id, voting_date, county_name, method_code, voter_count, updated_at)
    SELECT evr_election_id, voting_date, county_name, UPPER(COALESCE(method_code, 'EV')), COUNT(DISTINCT vuid), (NOW() AT TIME ZONE 'UTC')
    FROM ev_roster_voters
    WHERE evr_election_id = @evr_election_id
    GROUP BY evr_election_id, voting_date, county_name, UPPER(COALESCE(method_code, 'EV'));
  `);

  await pool.request().input("evr_election_id", eid).query(`
    INSERT INTO ev_roster_registered_cache (evr_election_id, county_name, county_id, registered_voters, updated_at)
    SELECT p.evr_election_id, s.county_name, MAX(s.county_id), MAX(s.registered_voters), (NOW() AT TIME ZONE 'UTC')
    FROM ev_roster_county_summary s
    INNER JOIN ev_roster_pulls p ON p.id = s.pull_id
    WHERE p.evr_election_id = @evr_election_id
    GROUP BY s.county_name;
  `);

  const countR = await pool.request().input("evr_election_id", eid).query(`
    SELECT
      (SELECT COUNT(*)::int FROM ev_roster_activity_cache WHERE evr_election_id = @evr_election_id) AS "activityRows",
      (SELECT COUNT(*)::int FROM ev_roster_registered_cache WHERE evr_election_id = @evr_election_id) AS "registeredRows"
  `);
  const row = countR.recordset?.[0] ?? {};
  return {
    activityRows: Number(row.activityRows ?? 0),
    registeredRows: Number(row.registeredRows ?? 0),
  };
}

/**
 * @param {number[]} evrElectionIds
 * @param {string} dateFrom
 * @param {string} dateTo
 * @param {{ pool: ReturnType<import("./pgPool.mjs").createCompatPool> }} ctx
 */
export async function loadSummaryRollupsFromCache(evrElectionIds, dateFrom, dateTo, ctx) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  const from = String(dateFrom ?? "").trim();
  const to = String(dateTo ?? "").trim();
  if (!ids.length || !from || !to) return emptyRollups();
  if (!ctx.pool) throw new Error("loadSummaryRollupsFromCache requires pool");
  return loadSummaryRollupsFromCachePg(ids, from, to, ctx.pool);
}

function emptyRollups() {
  return {
    rosterByCounty: new Map(),
    methodByCounty: new Map(),
    evInPersonDayByCounty: new Map(),
    registeredByCounty: new Map(),
    statewideDistinct: { ev: 0, ab: 0, ed: 0 },
    storedVoterCount: 0,
  };
}

/**
 * @param {number[]} ids
 * @param {string} from
 * @param {string} to
 * @param {ReturnType<import("./pgPool.mjs").createCompatPool>} pool
 */
async function loadSummaryRollupsFromCachePg(ids, from, to, pool) {
  const idList = ids.join(", ");
  for (const eid of ids) {
    const chk = await pool
      .request()
      .input("evr_election_id", eid)
      .query(`SELECT 1 AS ok FROM ev_roster_activity_cache WHERE evr_election_id = @evr_election_id LIMIT 1`);
    if (!chk.recordset?.length) await rebuildEvRosterSummaryCache(eid, { pool });
  }

  const rosterR = await pool
    .request()
    .input("date_from", from)
    .input("date_to", to)
    .query(`
      SELECT county_name AS "countyName", SUM(voter_count) AS n
      FROM ev_roster_activity_cache
      WHERE evr_election_id IN (${idList}) AND voting_date >= @date_from AND voting_date <= @date_to
      GROUP BY county_name
    `);
  const rosterByCounty = new Map();
  for (const r of rosterR.recordset ?? []) {
    const county = String(r.countyName ?? "").toUpperCase();
    rosterByCounty.set(county, (rosterByCounty.get(county) ?? 0) + Number(r.n ?? 0));
  }

  const methodR = await pool
    .request()
    .input("date_from", from)
    .input("date_to", to)
    .query(`
      SELECT county_name AS "countyName", method_code AS "methodCode", SUM(voter_count) AS n
      FROM ev_roster_activity_cache
      WHERE evr_election_id IN (${idList}) AND voting_date >= @date_from AND voting_date <= @date_to
      GROUP BY county_name, method_code
    `);
  const methodByCounty = new Map();
  for (const r of methodR.recordset ?? []) {
    const county = String(r.countyName ?? "").toUpperCase();
    const method = String(r.methodCode ?? "EV").toUpperCase();
    const cur = methodByCounty.get(county) ?? { ev: 0, ab: 0, ed: 0 };
    const n = Number(r.n ?? 0);
    if (method === "AB") cur.ab += n;
    else if (method === "ED") cur.ed += n;
    else cur.ev += n;
    methodByCounty.set(county, cur);
  }

  const evDayR = await pool
    .request()
    .input("date_from", from)
    .input("date_to", to)
    .query(`
      SELECT county_name AS "countyName", SUM(voter_count) AS n
      FROM ev_roster_activity_cache
      WHERE evr_election_id IN (${idList}) AND voting_date >= @date_from AND voting_date <= @date_to
        AND method_code = 'EV'
      GROUP BY county_name
    `);
  const evInPersonDayByCounty = new Map();
  for (const r of evDayR.recordset ?? []) {
    const county = String(r.countyName ?? "").toUpperCase();
    evInPersonDayByCounty.set(county, (evInPersonDayByCounty.get(county) ?? 0) + Number(r.n ?? 0));
  }

  const regR = await pool.request().query(`
    SELECT county_name AS "countyName", MAX(registered_voters) AS "registeredVoters", MAX(county_id) AS "countyId"
    FROM ev_roster_registered_cache
    WHERE evr_election_id IN (${idList})
    GROUP BY county_name
  `);
  const registeredByCounty = new Map();
  for (const r of regR.recordset ?? []) {
    const county = String(r.countyName ?? "").toUpperCase();
    const prev = registeredByCounty.get(county);
    const reg = Number(r.registeredVoters ?? 0);
    const countyId = r.countyId != null ? Number(r.countyId) : null;
    if (!prev || reg > prev.registeredVoters) {
      registeredByCounty.set(county, { registeredVoters: reg, countyId });
    }
  }

  const methodStateR = await pool
    .request()
    .input("date_from", from)
    .input("date_to", to)
    .query(`
      SELECT method_code AS "methodCode", SUM(voter_count) AS n
      FROM ev_roster_activity_cache
      WHERE evr_election_id IN (${idList}) AND voting_date >= @date_from AND voting_date <= @date_to
      GROUP BY method_code
    `);
  const statewideDistinct = { ev: 0, ab: 0, ed: 0 };
  for (const r of methodStateR.recordset ?? []) {
    const method = String(r.methodCode ?? "EV").toUpperCase();
    const n = Number(r.n ?? 0);
    if (method === "AB") statewideDistinct.ab = n;
    else if (method === "ED") statewideDistinct.ed = n;
    else statewideDistinct.ev = n;
  }

  const countR = await pool
    .request()
    .input("date_from", from)
    .input("date_to", to)
    .query(`
      SELECT SUM(voter_count) AS n FROM ev_roster_activity_cache
      WHERE evr_election_id IN (${idList}) AND voting_date >= @date_from AND voting_date <= @date_to
    `);
  const storedVoterCount = Number(countR.recordset?.[0]?.n ?? 0);

  return {
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statewideDistinct,
    storedVoterCount,
  };
}
