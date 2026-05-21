import sql from "mssql";

/**
 * Pre-aggregated EV roster stats (rebuilt after each pull / dedupe).
 * Summary page reads from these tables instead of scanning ev_roster_voters.
 */

/**
 * @param {import("sql.js").Database} db
 */
export function ensureEvRosterSummaryCacheSchemaSqlite(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS ev_roster_activity_cache (
      evr_election_id INTEGER NOT NULL,
      voting_date TEXT NOT NULL,
      county_name TEXT NOT NULL,
      method_code TEXT NOT NULL,
      voter_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (evr_election_id, voting_date, county_name, method_code)
    );
    CREATE INDEX IF NOT EXISTS idx_ev_roster_activity_cache_lookup
      ON ev_roster_activity_cache(evr_election_id, voting_date);
    CREATE TABLE IF NOT EXISTS ev_roster_registered_cache (
      evr_election_id INTEGER NOT NULL,
      county_name TEXT NOT NULL,
      county_id INTEGER,
      registered_voters INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (evr_election_id, county_name)
    );
  `);
}

export const EV_ROSTER_SUMMARY_CACHE_DDL_MSSQL = `
IF OBJECT_ID(N'dbo.ev_roster_activity_cache', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_activity_cache (
    evr_election_id INT NOT NULL,
    voting_date NVARCHAR(16) NOT NULL,
    county_name NVARCHAR(128) NOT NULL,
    method_code NVARCHAR(8) NOT NULL,
    voter_count BIGINT NOT NULL CONSTRAINT DF_ev_activity_cache_v DEFAULT (0),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_ev_activity_cache_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_ev_roster_activity_cache PRIMARY KEY (evr_election_id, voting_date, county_name, method_code)
  );
  CREATE INDEX idx_ev_roster_activity_cache_lookup ON dbo.ev_roster_activity_cache (evr_election_id, voting_date);
END;

IF OBJECT_ID(N'dbo.ev_roster_registered_cache', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ev_roster_registered_cache (
    evr_election_id INT NOT NULL,
    county_name NVARCHAR(128) NOT NULL,
    county_id INT NULL,
    registered_voters BIGINT NOT NULL CONSTRAINT DF_ev_reg_cache_v DEFAULT (0),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_ev_reg_cache_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_ev_roster_registered_cache PRIMARY KEY (evr_election_id, county_name)
  );
END;
`;

/**
 * Rebuild cache for one runoff election from ev_roster_voters + county_summary pulls.
 * @param {number} evrElectionId
 * @param {{ db?: import("sql.js").Database, pool?: import("mssql").ConnectionPool }} ctx
 */
export async function rebuildEvRosterSummaryCache(evrElectionId, ctx) {
  const eid = Number(evrElectionId);
  if (!eid) return { activityRows: 0, registeredRows: 0 };

  if (ctx.db) {
    return rebuildEvRosterSummaryCacheSqlite(eid, ctx.db);
  }
  if (ctx.pool) {
    return rebuildEvRosterSummaryCacheMssql(eid, ctx.pool);
  }
  throw new Error("rebuildEvRosterSummaryCache requires db or pool");
}

/**
 * @param {number} eid
 * @param {import("sql.js").Database} db
 */
function rebuildEvRosterSummaryCacheSqlite(eid, db) {
  ensureEvRosterSummaryCacheSchemaSqlite(db);
  db.run(`DELETE FROM ev_roster_activity_cache WHERE evr_election_id = ?`, [eid]);
  db.run(`DELETE FROM ev_roster_registered_cache WHERE evr_election_id = ?`, [eid]);

  db.run(
    `INSERT INTO ev_roster_activity_cache (evr_election_id, voting_date, county_name, method_code, voter_count, updated_at)
     SELECT evr_election_id, voting_date, county_name, UPPER(COALESCE(method_code, 'EV')), COUNT(DISTINCT vuid), datetime('now')
     FROM ev_roster_voters
     WHERE evr_election_id = ?
     GROUP BY evr_election_id, voting_date, county_name, UPPER(COALESCE(method_code, 'EV'))`,
    [eid],
  );

  db.run(
    `INSERT INTO ev_roster_registered_cache (evr_election_id, county_name, county_id, registered_voters, updated_at)
     SELECT p.evr_election_id, s.county_name, MAX(s.county_id), MAX(s.registered_voters), datetime('now')
     FROM ev_roster_county_summary s
     INNER JOIN ev_roster_pulls p ON p.id = s.pull_id
     WHERE p.evr_election_id = ?
     GROUP BY s.county_name`,
    [eid],
  );

  const actStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ev_roster_activity_cache WHERE evr_election_id = ?`,
  );
  actStmt.bind([eid]);
  actStmt.step();
  const activityRows = Number(actStmt.getAsObject().n ?? 0);
  actStmt.free();

  const regStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ev_roster_registered_cache WHERE evr_election_id = ?`,
  );
  regStmt.bind([eid]);
  regStmt.step();
  const registeredRows = Number(regStmt.getAsObject().n ?? 0);
  regStmt.free();
  return { activityRows, registeredRows };
}

/**
 * @param {number} eid
 * @param {import("mssql").ConnectionPool} pool
 */
async function rebuildEvRosterSummaryCacheMssql(eid, pool) {
  await pool.request().input("evr_election_id", sql.Int, eid).query(`
    DELETE FROM dbo.ev_roster_activity_cache WHERE evr_election_id = @evr_election_id;
    DELETE FROM dbo.ev_roster_registered_cache WHERE evr_election_id = @evr_election_id;
  `);

  await pool.request().input("evr_election_id", sql.Int, eid).query(`
    INSERT INTO dbo.ev_roster_activity_cache (evr_election_id, voting_date, county_name, method_code, voter_count, updated_at)
    SELECT evr_election_id, voting_date, county_name, UPPER(COALESCE(method_code, N'EV')), COUNT(DISTINCT vuid), SYSUTCDATETIME()
    FROM dbo.ev_roster_voters
    WHERE evr_election_id = @evr_election_id
    GROUP BY evr_election_id, voting_date, county_name, UPPER(COALESCE(method_code, N'EV'));
  `);

  await pool.request().input("evr_election_id", sql.Int, eid).query(`
    INSERT INTO dbo.ev_roster_registered_cache (evr_election_id, county_name, county_id, registered_voters, updated_at)
    SELECT p.evr_election_id, s.county_name, MAX(s.county_id), MAX(s.registered_voters), SYSUTCDATETIME()
    FROM dbo.ev_roster_county_summary s
    INNER JOIN dbo.ev_roster_pulls p ON p.id = s.pull_id
    WHERE p.evr_election_id = @evr_election_id
    GROUP BY s.county_name;
  `);

  const countR = await pool
    .request()
    .input("evr_election_id", sql.Int, eid)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.ev_roster_activity_cache WHERE evr_election_id = @evr_election_id) AS activityRows,
        (SELECT COUNT(*) FROM dbo.ev_roster_registered_cache WHERE evr_election_id = @evr_election_id) AS registeredRows
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
 * @param {{ db?: import("sql.js").Database, pool?: import("mssql").ConnectionPool }} ctx
 */
export async function loadSummaryRollupsFromCache(evrElectionIds, dateFrom, dateTo, ctx) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  const from = String(dateFrom ?? "").trim();
  const to = String(dateTo ?? "").trim();
  if (!ids.length || !from || !to) {
    return emptyRollups();
  }

  if (ctx.db) {
    return loadSummaryRollupsFromCacheSqlite(ids, from, to, ctx.db);
  }
  if (ctx.pool) {
    return loadSummaryRollupsFromCacheMssql(ids, from, to, ctx.pool);
  }
  throw new Error("loadSummaryRollupsFromCache requires db or pool");
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
 * @param {import("sql.js").Database} db
 */
async function loadSummaryRollupsFromCacheSqlite(ids, from, to, db) {
  ensureEvRosterSummaryCacheSchemaSqlite(db);
  for (const eid of ids) {
    const chk = db.prepare(
      `SELECT 1 AS ok FROM ev_roster_activity_cache WHERE evr_election_id = ? LIMIT 1`,
    );
    chk.bind([eid]);
    const has = chk.step();
    chk.free();
    if (!has) await rebuildEvRosterSummaryCache(eid, { db });
  }

  const ph = ids.map(() => "?").join(", ");
  const bind = [...ids, from, to];

  const rosterStmt = db.prepare(
    `SELECT county_name AS countyName, SUM(voter_count) AS n
     FROM ev_roster_activity_cache
     WHERE evr_election_id IN (${ph}) AND voting_date >= ? AND voting_date <= ?
     GROUP BY county_name`,
  );
  rosterStmt.bind(bind);
  const rosterByCounty = new Map();
  while (rosterStmt.step()) {
    const r = rosterStmt.getAsObject();
    const county = String(r.countyName ?? "").toUpperCase();
    rosterByCounty.set(county, (rosterByCounty.get(county) ?? 0) + Number(r.n ?? 0));
  }
  rosterStmt.free();

  const methodStmt = db.prepare(
    `SELECT county_name AS countyName, method_code AS methodCode, SUM(voter_count) AS n
     FROM ev_roster_activity_cache
     WHERE evr_election_id IN (${ph}) AND voting_date >= ? AND voting_date <= ?
     GROUP BY county_name, method_code`,
  );
  methodStmt.bind(bind);
  const methodByCounty = new Map();
  while (methodStmt.step()) {
    const r = methodStmt.getAsObject();
    const county = String(r.countyName ?? "").toUpperCase();
    const method = String(r.methodCode ?? "EV").toUpperCase();
    const cur = methodByCounty.get(county) ?? { ev: 0, ab: 0, ed: 0 };
    const n = Number(r.n ?? 0);
    if (method === "AB") cur.ab += n;
    else if (method === "ED") cur.ed += n;
    else cur.ev += n;
    methodByCounty.set(county, cur);
  }
  methodStmt.free();

  const evDayStmt = db.prepare(
    `SELECT county_name AS countyName, SUM(voter_count) AS n
     FROM ev_roster_activity_cache
     WHERE evr_election_id IN (${ph}) AND voting_date >= ? AND voting_date <= ? AND method_code = 'EV'
     GROUP BY county_name`,
  );
  evDayStmt.bind(bind);
  const evInPersonDayByCounty = new Map();
  while (evDayStmt.step()) {
    const r = evDayStmt.getAsObject();
    const county = String(r.countyName ?? "").toUpperCase();
    evInPersonDayByCounty.set(county, (evInPersonDayByCounty.get(county) ?? 0) + Number(r.n ?? 0));
  }
  evDayStmt.free();

  const regStmt = db.prepare(
    `SELECT county_name AS countyName, MAX(registered_voters) AS registeredVoters, MAX(county_id) AS countyId
     FROM ev_roster_registered_cache
     WHERE evr_election_id IN (${ph})
     GROUP BY county_name`,
  );
  regStmt.bind(ids);
  const registeredByCounty = new Map();
  while (regStmt.step()) {
    const r = regStmt.getAsObject();
    const county = String(r.countyName ?? "").toUpperCase();
    const prev = registeredByCounty.get(county);
    const reg = Number(r.registeredVoters ?? 0);
    const countyId = r.countyId != null ? Number(r.countyId) : null;
    if (!prev || reg > prev.registeredVoters) {
      registeredByCounty.set(county, { registeredVoters: reg, countyId });
    }
  }
  regStmt.free();

  const methodStateStmt = db.prepare(
    `SELECT method_code AS methodCode, SUM(voter_count) AS n
     FROM ev_roster_activity_cache
     WHERE evr_election_id IN (${ph}) AND voting_date >= ? AND voting_date <= ?
     GROUP BY method_code`,
  );
  methodStateStmt.bind(bind);
  const statewideDistinct = { ev: 0, ab: 0, ed: 0 };
  while (methodStateStmt.step()) {
    const r = methodStateStmt.getAsObject();
    const method = String(r.methodCode ?? "EV").toUpperCase();
    const n = Number(r.n ?? 0);
    if (method === "AB") statewideDistinct.ab = n;
    else if (method === "ED") statewideDistinct.ed = n;
    else statewideDistinct.ev = n;
  }
  methodStateStmt.free();

  const countStmt = db.prepare(
    `SELECT SUM(voter_count) AS n FROM ev_roster_activity_cache
     WHERE evr_election_id IN (${ph}) AND voting_date >= ? AND voting_date <= ?`,
  );
  countStmt.bind(bind);
  countStmt.step();
  const storedVoterCount = Number(countStmt.getAsObject().n ?? 0);
  countStmt.free();

  return {
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statewideDistinct,
    storedVoterCount,
  };
}

/**
 * @param {number[]} ids
 * @param {string} from
 * @param {string} to
 * @param {import("mssql").ConnectionPool} pool
 */
async function loadSummaryRollupsFromCacheMssql(ids, from, to, pool) {
  const idList = ids.join(", ");
  for (const eid of ids) {
    const chk = await pool
      .request()
      .input("evr_election_id", sql.Int, eid)
      .query(
        `SELECT TOP 1 1 AS ok FROM dbo.ev_roster_activity_cache WHERE evr_election_id = @evr_election_id`,
      );
    if (!chk.recordset?.length) await rebuildEvRosterSummaryCache(eid, { pool });
  }

  const rosterR = await pool
    .request()
    .input("date_from", from)
    .input("date_to", to)
    .query(`
      SELECT county_name AS countyName, SUM(voter_count) AS n
      FROM dbo.ev_roster_activity_cache
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
      SELECT county_name AS countyName, method_code AS methodCode, SUM(voter_count) AS n
      FROM dbo.ev_roster_activity_cache
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
      SELECT county_name AS countyName, SUM(voter_count) AS n
      FROM dbo.ev_roster_activity_cache
      WHERE evr_election_id IN (${idList}) AND voting_date >= @date_from AND voting_date <= @date_to
        AND method_code = N'EV'
      GROUP BY county_name
    `);
  const evInPersonDayByCounty = new Map();
  for (const r of evDayR.recordset ?? []) {
    const county = String(r.countyName ?? "").toUpperCase();
    evInPersonDayByCounty.set(county, (evInPersonDayByCounty.get(county) ?? 0) + Number(r.n ?? 0));
  }

  const regR = await pool.request().query(`
    SELECT county_name AS countyName, MAX(registered_voters) AS registeredVoters, MAX(county_id) AS countyId
    FROM dbo.ev_roster_registered_cache
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
      SELECT method_code AS methodCode, SUM(voter_count) AS n
      FROM dbo.ev_roster_activity_cache
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
      SELECT SUM(voter_count) AS n FROM dbo.ev_roster_activity_cache
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
