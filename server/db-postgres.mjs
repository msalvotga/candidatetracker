import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCompatPool, getDatabaseUrl, runSchemaSql, sql } from "./lib/pgPool.mjs";
import {
  readElectionFeedBackupByElection,
  writeElectionFeedBackupForElection,
  removeElectionFeedBackupForElection,
} from "./lib/electionFeedConfigBackup.mjs";
import { resolveVoterActivityDate } from "./lib/evRosterVoterDates.mjs";
import {
  EV_ROSTER_SUMMARY_CACHE_DDL_POSTGRES,
  loadSummaryRollupsFromCache,
  rebuildEvRosterSummaryCache,
} from "./lib/evRosterSummaryCache.mjs";
import {
  buildCountyHistoricalResultsPayload,
  normalizeCountyHistoricalKey,
} from "./lib/countyHistoricalResults.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "data");
const LEGACY_MANIFEST = path.join(DATA_DIR, "manual-manifest.json");
const LEGACY_MANUAL_DIR = path.join(DATA_DIR, "manual");

/** @type {ReturnType<typeof createCompatPool> | null} */
let _pool = null;
/** @type {Promise<ReturnType<typeof createCompatPool>> | null} */
let _init = null;

async function migrateLegacyJsonIfNeeded(pool) {
  const countR = await pool.request().query(`SELECT COUNT(*) AS c FROM dbo.manual_elections`);
  const count = Number(countR.recordset[0]?.c ?? 0);
  if (count > 0) return;
  if (!fs.existsSync(LEGACY_MANIFEST)) return;

  const manifest = JSON.parse(fs.readFileSync(LEGACY_MANIFEST, "utf8"));
  for (const e of manifest.elections || []) {
    const fp = path.join(LEGACY_MANUAL_DIR, e.filename);
    if (!fs.existsSync(fp)) continue;
    const dataJson = fs.readFileSync(fp, "utf8");
    const updatedAt = e.updatedAt || new Date().toISOString();
    await pool
      .request()
      .input("id", e.id)
      .input("label", e.label)
      .input("data_json", dataJson)
      .input("created_at", new Date(updatedAt))
      .input("updated_at", new Date(updatedAt))
      .query(
        `INSERT INTO dbo.manual_elections (id, label, data_json, source_id, created_at, updated_at)
         VALUES (@id, @label, @data_json, N'manual-default', @created_at, @updated_at)`,
      );
  }

  try {
    fs.renameSync(LEGACY_MANIFEST, `${LEGACY_MANIFEST}.migrated`);
  } catch {
    /* ignore */
  }
}

async function syncIngestVendorMetadataMssql(pool) {
  await pool.request().query(`
    UPDATE dbo.election_feed_sources
    SET vendor_id = N'clarity-enr-summary-zip', updated_at = SYSUTCDATETIME()
    WHERE vendor_id IN (N'clarity-galveston-sd4', N'clarity-jefferson-sd4')
  `);
  await pool.request().query(`
    INSERT INTO ingest_vendors (id, display_name, vendor_tier, handler_key, notes)
    VALUES (
      'clarity-enr-summary-zip',
      'Clarity ENR (summary.zip)',
      'enr',
      'clarity_enr_summary_zip',
      'ElectionSystems Clarity: summary.zip → summary.csv for any county URL. Imports all contests; align comparable races when combining totals across counties.'
    )
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.request().query(`
    DELETE FROM dbo.ingest_vendors WHERE id IN (N'clarity-galveston-sd4', N'clarity-jefferson-sd4')
  `);

  const rows = [
    {
      id: "clarity-enr-summary-zip",
      display_name: "Clarity ENR (summary.zip)",
      vendor_tier: "enr",
      notes:
        "ElectionSystems Clarity: summary.zip → summary.csv for any county URL. Imports all contests; align comparable races when combining totals across counties.",
    },
    {
      id: "montgomery-pdf",
      display_name: "Montgomery cumulative PDF (SD4)",
      vendor_tier: "enr",
      notes: "Official cumulative results PDF from the county (not the live eResults web page).",
    },
    {
      id: "montgomery-eresults-html",
      display_name: "Montgomery County eResults (live HTML)",
      vendor_tier: "enr",
      notes:
        "Live ASP.NET eResults page (elections.mctx.org). Paste the browser URL for the results page — parses SD4 from HTML tables.",
    },
    {
      id: "chambers-pdf",
      display_name: "Chambers cumulative PDF (SD4)",
      vendor_tier: "enr",
      notes:
        "Cumulative PDF SD4 parser. Related to Montgomery (both PDF text → SD4) but line formats differ — not the same code path.",
    },
    {
      id: "harris-pdf",
      display_name: "Harris Votes (PDF cumulative)",
      vendor_tier: "enr",
      notes: "Harris cumulative PDF layout (distinct line format from Montgomery/Chambers).",
    },
    {
      id: "dallas-pdf",
      display_name: "Dallas County (Electionware summary PDF)",
      vendor_tier: "enr",
      notes:
        "Dallas County Votes: Electionware Summary Results Report PDF. Imports all contests; layout differs from Harris / Montgomery / Chambers.",
    },
    {
      id: "collin-pdf",
      display_name: "Collin County (Electionware EV summary PDF)",
      vendor_tier: "enr",
      notes:
        "Collin County Electionware early-voting summary PDF (Mail + Early Voting). Imports all contests in the file.",
    },
    {
      id: "cameron-pdf",
      display_name: "Cameron County (results / reconciliation PDF)",
      vendor_tier: "enr",
      notes:
        "Cameron County: Electionware summary PDFs (all contests) or SOS preliminary reconciliation P26 PDFs (turnout only).",
    },
    {
      id: "hays-pdf",
      display_name: "Hays County (eGovlink cumulative PDF)",
      vendor_tier: "enr",
      notes:
        "Hays egovlink.com cumulative results PDF (official). Imports all contests; separate DEM/REP PDFs per party.",
    },
    {
      id: "mclennan-pdf",
      display_name: "McLennan County (CivicPlus cumulative PDF)",
      vendor_tier: "enr",
      notes:
        "McLennan CivicPlus cumulative PDF (official). Imports all contests; separate DEM/REP PDFs per party.",
    },
    {
      id: "ellis-enr-html",
      display_name: "Ellis County (livevoterturnout ENR HTML)",
      vendor_tier: "enr",
      notes:
        "Ellis livevoterturnout.com ENR Index page — imports all contests (precinct tables summed to county).",
    },
  ];
  for (const r of rows) {
    await pool
      .request()
      .input("id", r.id)
      .input("display_name", r.display_name)
      .input("vendor_tier", r.vendor_tier)
      .input("notes", r.notes)
      .query(
        `UPDATE dbo.ingest_vendors
         SET display_name = @display_name, vendor_tier = @vendor_tier, notes = @notes, updated_at = SYSUTCDATETIME()
         WHERE id = @id`,
      );
  }
}

export async function flushPendingDatabasePersist() {
  return true;
}

export function isDatabaseLoaded() {
  return !!_pool?.connected;
}

export async function ensureDb() {
  if (_pool?.connected) return _pool;
  if (_init) return _init;

  _init = (async () => {
    _pool = createCompatPool(getDatabaseUrl());
    await runSchemaSql(_pool);
    await _pool.query(EV_ROSTER_SUMMARY_CACHE_DDL_POSTGRES);
    await syncIngestVendorMetadataMssql(_pool);
    await migrateLegacyJsonIfNeeded(_pool);
    const restoredFeeds = await restoreElectionFeedsFromBackup();
    if (restoredFeeds > 0) {
      console.warn(`Restored ${restoredFeeds} county feed row(s) from election-feed-configs.json`);
    }
    return _pool;
  })();

  return _init;
}

export function getDbInfo() {
  const url = getDatabaseUrl();
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "(invalid DATABASE_URL)";
  }
  return {
    engine: "postgres",
    host,
    driver: "pg",
    ssms: false,
    hint: "Set DATABASE_URL to your PostgreSQL connection string.",
  };
}

export async function listManualElectionsMeta() {
  const pool = await ensureDb();
  const r = await pool.request().query(
    `SELECT id, label, updated_at AS updatedAt FROM dbo.manual_elections ORDER BY updated_at DESC`,
  );
  return r.recordset.map((row) => ({
    id: row.id,
    label: row.label,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  }));
}

export async function getManualElectionJsonById(id) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("id", id)
    .query(`SELECT data_json FROM dbo.manual_elections WHERE id = @id`);
  return r.recordset[0]?.data_json ?? null;
}

export async function insertManualElection(id, label, electionFileObj) {
  const pool = await ensureDb();
  const now = new Date();
  const dataJson = JSON.stringify(electionFileObj);
  await pool
    .request()
    .input("id", id)
    .input("label", label)
    .input("data_json", dataJson)
    .input("created_at", now)
    .input("updated_at", now)
    .query(
      `INSERT INTO dbo.manual_elections (id, label, data_json, source_id, created_at, updated_at)
       VALUES (@id, @label, @data_json, N'manual-default', @created_at, @updated_at)`,
    );
}

export async function deleteManualElection(id) {
  const pool = await ensureDb();
  const r = await pool.request().input("id", id).query(`DELETE FROM dbo.manual_elections WHERE id = @id`);
  return (r.rowsAffected[0] ?? 0) > 0;
}

export async function manualElectionExists(id) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("id", id)
    .query(`SELECT 1 AS x FROM dbo.manual_elections WHERE id = @id`);
  return r.recordset.length > 0;
}

export async function updateManualElection(id, label, electionFileObj) {
  const pool = await ensureDb();
  const now = new Date();
  const dataJson = JSON.stringify(electionFileObj);
  const r = await pool
    .request()
    .input("id", id)
    .input("label", label)
    .input("data_json", dataJson)
    .input("updated_at", now)
    .query(`UPDATE dbo.manual_elections SET label = @label, data_json = @data_json, updated_at = @updated_at WHERE id = @id`);
  return (r.rowsAffected[0] ?? 0) > 0;
}

export async function listDbTablesWithCounts() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT relname AS name, COALESCE(n_live_tup, 0)::bigint AS row_count
    FROM pg_stat_user_tables
    ORDER BY relname
  `);
  return r.recordset.map((row) => ({
    name: String(row.name ?? ""),
    rowCount: Number(row.row_count ?? row.rowCount ?? 0),
  }));
}

export async function getDbTablePreview(tableName, limit = 20) {
  const pool = await ensureDb();
  const allowed = new Map([
    ["data_sources", "dbo.data_sources"],
    ["sos_county_results", "dbo.sos_county_results"],
  ]);
  const key = String(tableName ?? "").trim().toLowerCase();
  const fullName = allowed.get(key);
  if (!fullName) throw new Error(`Preview not allowed for table: ${tableName}`);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const r = await pool.request().query(`SELECT TOP (${safeLimit}) * FROM ${fullName} ORDER BY id DESC`);
  const rows = r.recordset.map((x) => ({ ...x }));
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { table: key, columns, rows };
}

export async function insertSosResultSnapshot({ electionId, electionLabel, payload }) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("election_label", electionLabel ?? null)
    .input("payload_json", JSON.stringify(payload))
    .query(`INSERT INTO dbo.sos_results (election_id, election_label, payload_json) VALUES (@election_id, @election_label, @payload_json)`);
}

/** Last stored Civix election + countyInfo JSON (from a prior successful ingest). */
export async function getLatestSosCivixSnapshot(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", String(electionId)).query(`
    SELECT TOP 1 payload_json AS payloadJson, fetched_at AS fetchedAt
    FROM dbo.sos_results WHERE election_id = @election_id
    ORDER BY fetched_at DESC
  `);
  const row = r.recordset?.[0];
  if (!row) return null;
  try {
    const payload = JSON.parse(String(row.payloadJson ?? "{}"));
    const election = payload?.election;
    const county = payload?.county;
    if (!election || !county) return null;
    const fetchedAt =
      row.fetchedAt instanceof Date ? row.fetchedAt.toISOString() : String(row.fetchedAt ?? "");
    return {
      election,
      county,
      fetchedAt,
      sosCountyInfoUrlUsed: String(payload?.sosCountyInfoUrlUsed ?? ""),
    };
  } catch {
    return null;
  }
}

/** Latest time this election's SOS snapshot or county feed rows were written (DB clock). */
export async function getElectionLastRefreshAt(electionId) {
  const pool = await ensureDb();
  const key = String(electionId ?? "").trim();
  if (!key) return null;
  const r = await pool.request().input("election_id", key).query(`
    SELECT MAX(last_at) AS lastAt FROM (
      SELECT MAX(fetched_at) AS last_at FROM dbo.sos_results WHERE election_id = @election_id
      UNION ALL
      SELECT MAX(fetched_at) AS last_at FROM dbo.county_results WHERE election_id = @election_id
    ) combined
  `);
  const raw = r.recordset?.[0]?.lastAt;
  if (raw == null) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function normalizeCountyCandidateName(value) {
  const raw = String(value ?? "").toUpperCase();
  const stripped = raw
    .replace(/\((DEM|REP|LIB|GRN|IND)\)/g, " ")
    .replace(/\b(DEM|REP|LIB|GRN|IND)\b/g, " ")
    .replace(/[^A-Z\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = stripped
    .split(" ")
    .filter(Boolean)
    .filter((t) => !["MR", "MRS", "MS", "DR", "JR", "SR", "II", "III", "IV", "V"].includes(t))
    .filter((t) => t.length > 1);
  if (!tokens.length) return String(value ?? "").trim();
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const toTitle = (s) => s.charAt(0) + s.slice(1).toLowerCase();
  return first === last ? toTitle(first) : `${toTitle(first)} ${toTitle(last)}`;
}

export async function commitCountyResultsBatch({ electionId, batchAt, segments }) {
  const pool = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const batchAtDt =
    batchAt != null ? (typeof batchAt === "string" ? new Date(batchAt) : batchAt) : new Date();
  const segs = segments ?? [];

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    // Replace county rows atomically: delete then insert before commit.
    await new sql.Request(transaction)
      .input("election_id", electionKey)
      .query(`DELETE FROM dbo.county_results WHERE election_id = @election_id`);

    for (const seg of segs) {
      for (const row of seg.rows ?? []) {
        const normalizedChoice = normalizeCountyCandidateName(row.choiceName);
        await new sql.Request(transaction)
          .input("county_id", seg.countyId)
          .input("election_id", electionKey)
          .input("contest_name", row.contestName ?? "")
          .input("choice_name", normalizedChoice)
          .input("party_name", row.partyName ?? null)
          .input("early_votes", Number(row.earlyVotes ?? 0))
          .input("election_day_votes", Number(row.electionDayVotes ?? 0))
          .input("total_votes", Number(row.totalVotes ?? 0))
          .input("percent_of_votes", row.percentOfVotes ?? null)
          .input("registered_voters", Number(row.registeredVoters ?? 0))
          .input("ballots_cast", Number(row.ballotsCast ?? 0))
          .input("precinct_total", Number(row.precinctTotal ?? 0))
          .input("precinct_reporting", Number(row.precinctReporting ?? 0))
          .input("over_votes", Number(row.overVotes ?? 0))
          .input("under_votes", Number(row.underVotes ?? 0))
          .input("line_number", row.lineNumber == null ? null : Number(row.lineNumber))
          .input("source_url", seg.sourceUrl ?? null)
          .input("payload_json", JSON.stringify(row))
          .input("fetched_at", batchAtDt)
          .query(
            `INSERT INTO dbo.county_results
              (election_id, county_id, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes, registered_voters, ballots_cast,
               precinct_total, precinct_reporting, over_votes, under_votes, line_number, source_url, payload_json, fetched_at)
             VALUES
              (@election_id, @county_id, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes, @registered_voters, @ballots_cast,
               @precinct_total, @precinct_reporting, @over_votes, @under_votes, @line_number, @source_url, @payload_json, @fetched_at)`,
          );
      }
    }

    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

export async function insertCountyResultRows({ electionId, countyId, sourceUrl, rows, fetchedAt }) {
  await commitCountyResultsBatch({
    electionId: String(electionId ?? "56181"),
    batchAt: fetchedAt ?? new Date(),
    segments: [{ countyId, sourceUrl, rows }],
  });
}

export async function insertSosCandidateRows({ electionId, electionLabel, sourceUrl, rows }) {
  const pool = await ensureDb();
  for (const row of rows ?? []) {
    await pool
      .request()
      .input("election_id", String(electionId))
      .input("election_label", electionLabel ?? null)
      .input("contest_name", row.contestName ?? "")
      .input("choice_name", row.choiceName ?? "")
      .input("party_name", row.partyName ?? null)
      .input("early_votes", Number(row.earlyVotes ?? 0))
      .input("election_day_votes", Number(row.electionDayVotes ?? 0))
      .input("total_votes", Number(row.totalVotes ?? 0))
      .input("percent_of_votes", row.percentOfVotes ?? null)
      .input("precinct_total", Number(row.precinctTotal ?? 0))
      .input("precinct_reporting", Number(row.precinctReporting ?? 0))
      .input("source_url", sourceUrl ?? null)
      .input("payload_json", JSON.stringify(row))
      .query(
        `INSERT INTO dbo.sos_candidate_results
          (election_id, election_label, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes,
           precinct_total, precinct_reporting, source_url, payload_json)
         VALUES
          (@election_id, @election_label, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes,
           @precinct_total, @precinct_reporting, @source_url, @payload_json)`,
      );
  }
}

export async function insertSosCountyRows({ electionId, electionLabel, sourceUrl, rows }) {
  const pool = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    // Atomic replace so readers don't see a partial clear/insert sequence.
    await new sql.Request(transaction)
      .input("election_id", electionKey)
      .query(`DELETE FROM dbo.sos_county_results WHERE election_id = @election_id`);
    for (const row of rows ?? []) {
      await new sql.Request(transaction)
        .input("election_id", String(electionId))
        .input("election_label", electionLabel ?? null)
        .input("county_name", row.countyName ?? "")
        .input("contest_name", row.contestName ?? "")
        .input("choice_name", row.choiceName ?? "")
        .input("party_name", row.partyName ?? null)
        .input("early_votes", Number(row.earlyVotes ?? 0))
        .input("election_day_votes", Number(row.electionDayVotes ?? 0))
        .input("total_votes", Number(row.totalVotes ?? 0))
        .input("percent_of_votes", row.percentOfVotes ?? null)
        .input("precinct_total", Number(row.precinctTotal ?? 0))
        .input("precinct_reporting", Number(row.precinctReporting ?? 0))
        .input("source_url", sourceUrl ?? null)
        .input("payload_json", JSON.stringify(row))
        .query(
          `INSERT INTO dbo.sos_county_results
            (election_id, election_label, county_name, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes,
             precinct_total, precinct_reporting, source_url, payload_json)
           VALUES
            (@election_id, @election_label, @county_name, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes,
             @precinct_total, @precinct_reporting, @source_url, @payload_json)`,
        );
    }
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

export async function getLatestSosCountyRows(electionId) {
  const pool = await ensureDb();
  const latest = await pool
    .request()
    .input("election_id", String(electionId))
    .query(`
      SELECT county_name AS countyName, MAX(fetched_at) AS fetchedAt
      FROM dbo.sos_county_results
      WHERE election_id = @election_id
      GROUP BY county_name
    `);
  const out = [];
  for (const row of latest.recordset) {
    const r = await pool
      .request()
      .input("election_id", String(electionId))
      .input("county_name", String(row.countyName))
      .input("fetched_at", row.fetchedAt)
      .query(`
        SELECT county_name AS countyName, contest_name AS contestName, choice_name AS choiceName, party_name AS partyName,
               early_votes AS earlyVotes, election_day_votes AS electionDayVotes, total_votes AS totalVotes, percent_of_votes AS percentOfVotes,
               precinct_total AS precinctTotal, precinct_reporting AS precinctReporting, fetched_at AS fetchedAt
        FROM dbo.sos_county_results
        WHERE election_id = @election_id AND county_name = @county_name AND fetched_at = @fetched_at
        ORDER BY id
      `);
    out.push(
      ...r.recordset.map((x) => ({
        ...x,
        fetchedAt: x.fetchedAt instanceof Date ? x.fetchedAt.toISOString() : String(x.fetchedAt),
      })),
    );
  }
  return out;
}

async function latestRowsForCounty(pool, countyId, electionId) {
  if (!countyId) return [];
  const r = await pool
    .request()
    .input("countyId", countyId)
    .input("electionId", String(electionId ?? "56181"))
    .query(`
      SELECT
        MAX(line_number) AS lineNumber,
        contest_name AS contestName,
        choice_name AS choiceName,
        MAX(party_name) AS partyName,
        MAX(early_votes) AS earlyVotes,
        MAX(election_day_votes) AS electionDayVotes,
        MAX(total_votes) AS totalVotes,
        NULL::TEXT AS percentOfVotes,
        MAX(registered_voters) AS registeredVoters,
        MAX(ballots_cast) AS ballotsCast,
        MAX(precinct_total) AS precinctTotal,
        MAX(precinct_reporting) AS precinctReporting,
        MAX(over_votes) AS overVotes,
        MAX(under_votes) AS underVotes,
        MAX(fetched_at) AS fetchedAt,
        NULL::TEXT AS sourceUrl
      FROM dbo.county_results
      WHERE county_id = @countyId AND election_id = @electionId
      GROUP BY contest_name, choice_name, COALESCE(party_name, '')
      ORDER BY contest_name, choice_name
    `);
  return r.recordset.map((x) => ({
    ...x,
    fetchedAt: x.fetchedAt instanceof Date ? x.fetchedAt.toISOString() : String(x.fetchedAt),
  }));
}

async function civixCountyLabelForSlugMssql(pool, electionId, slug) {
  const r = await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(slug))
    .query(
      `SELECT TOP 1 civix_county_name AS civixCountyName FROM dbo.election_feed_sources WHERE election_id = @election_id AND county_key = @county_key`,
    );
  const civix = r.recordset?.[0]?.civixCountyName;
  if (civix != null && String(civix).trim()) return String(civix).trim().toUpperCase();
  return String(slug).replace(/-/g, " ").toUpperCase();
}

export async function getLatestCountyRows(electionId = "56181") {
  const pool = await ensureDb();
  const dist = await pool.request().input("election_id", String(electionId)).query(`
    SELECT DISTINCT county_id AS countyId FROM dbo.county_results WHERE election_id = @election_id
  `);
  const byCivixName = {};
  for (const row of dist.recordset ?? []) {
    const slug = String(row.countyId ?? "");
    if (!slug) continue;
    const civix = await civixCountyLabelForSlugMssql(pool, electionId, slug);
    byCivixName[civix] = await latestRowsForCounty(pool, slug, electionId);
  }
  return byCivixName;
}

export async function getCountyHistoricalResults(countyName) {
  const name = String(countyName ?? "").trim();
  if (!name) return buildCountyHistoricalResultsPayload("", []);

  const pool = await ensureDb();
  const countyKey = normalizeCountyHistoricalKey(name);
  const r = await pool.request().input("county_key", countyKey).query(`
    SELECT county_name AS countyName, year, office_name AS officeName, election_type AS electionType,
           candidate_name AS candidateName, party_name AS partyName, votes, sort_order AS sortOrder
    FROM dbo.county_historical_results
    WHERE county_key = @county_key
    ORDER BY year DESC, sort_order ASC, office_name, candidate_name
  `);
  const firstCountyName = String(r.recordset?.[0]?.countyName ?? name);
  return buildCountyHistoricalResultsPayload(firstCountyName, r.recordset ?? []);
}

/** @see db-sqlite.mjs — Civix labels for feeds with prefer_over_sos (SD4 merge). */
export async function getSd4MergePreferCountyFeedNameSet(electionId = "56181") {
  const pool = await ensureDb();
  await migrateCountyPreferJsonToFeedsMssql(pool);
  const r = await pool.request().input("election_id", String(electionId)).query(`
    SELECT county_key AS countyKey FROM dbo.election_feed_sources
    WHERE election_id = @election_id AND prefer_over_sos = 1 AND is_enabled = 1
  `);
  const set = new Set();
  for (const row of r.recordset ?? []) {
    const slug = String(row.countyKey ?? "")
      .trim()
      .toLowerCase();
    if (!slug) continue;
    set.add(await civixCountyLabelForSlugMssql(pool, electionId, slug));
  }
  return set;
}

export async function listCountySosRaceLinks(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", String(electionId)).query(`
    SELECT county_key AS countyKey, county_contest_name AS countyContestName, sos_race_id AS sosRaceId,
           sos_race_name AS sosRaceName, link_type AS linkType, updated_at AS updatedAt
    FROM dbo.county_sos_race_links WHERE election_id = @election_id
    ORDER BY county_key, county_contest_name
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    countyContestName: String(row.countyContestName ?? ""),
    sosRaceId: String(row.sosRaceId ?? ""),
    sosRaceName: String(row.sosRaceName ?? ""),
    linkType: String(row.linkType ?? "manual"),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function upsertCountySosRaceLink(electionId, link) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(link.countyKey ?? "").toLowerCase().trim())
    .input("county_contest_name", String(link.countyContestName ?? "").trim())
    .input("sos_race_id", String(link.sosRaceId ?? "").trim())
    .input("sos_race_name", String(link.sosRaceName ?? "").trim())
    .input("link_type", String(link.linkType ?? "manual"))
    .query(`
      MERGE dbo.county_sos_race_links AS t
      USING (SELECT @election_id AS election_id, @county_key AS county_key, @county_contest_name AS county_contest_name) AS s
      ON t.election_id = s.election_id AND t.county_key = s.county_key AND t.county_contest_name = s.county_contest_name
      WHEN MATCHED THEN UPDATE SET sos_race_id = @sos_race_id, sos_race_name = @sos_race_name, link_type = @link_type, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (election_id, county_key, county_contest_name, sos_race_id, sos_race_name, link_type)
        VALUES (@election_id, @county_key, @county_contest_name, @sos_race_id, @sos_race_name, @link_type);
    `);
}

export async function deleteCountySosRaceLink(electionId, countyKey, countyContestName) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(countyKey).toLowerCase().trim())
    .input("county_contest_name", String(countyContestName).trim())
    .query(`
      DELETE FROM dbo.county_sos_race_links
      WHERE election_id = @election_id AND county_key = @county_key AND county_contest_name = @county_contest_name
    `);
}

export async function listCountySosManualVotes(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", String(electionId)).query(`
    SELECT county_key AS countyKey, sos_race_id AS sosRaceId, sos_candidate_id AS sosCandidateId,
           choice_name AS choiceName, party_name AS partyName, early_votes AS earlyVotes,
           election_day_votes AS electionDayVotes, total_votes AS totalVotes, updated_at AS updatedAt
    FROM dbo.county_sos_manual_votes WHERE election_id = @election_id
    ORDER BY county_key, sos_race_id, sos_candidate_id
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    sosRaceId: String(row.sosRaceId ?? ""),
    sosCandidateId: String(row.sosCandidateId ?? ""),
    choiceName: String(row.choiceName ?? ""),
    partyName: String(row.partyName ?? ""),
    earlyVotes: Number(row.earlyVotes ?? 0),
    electionDayVotes: Number(row.electionDayVotes ?? 0),
    totalVotes: Number(row.totalVotes ?? 0),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function deleteCountySosManualVote(electionId, countyKey, sosRaceId, sosCandidateId) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(countyKey).toLowerCase().trim())
    .input("sos_race_id", String(sosRaceId).trim())
    .input("sos_candidate_id", String(sosCandidateId).trim())
    .query(`
      DELETE FROM dbo.county_sos_manual_votes
      WHERE election_id = @election_id AND county_key = @county_key AND sos_race_id = @sos_race_id
        AND sos_candidate_id = @sos_candidate_id
    `);
}

export async function deleteCountySosManualVotesForCountyRace(electionId, countyKey, sosRaceId) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(countyKey).toLowerCase().trim())
    .input("sos_race_id", String(sosRaceId).trim())
    .query(`
      DELETE FROM dbo.county_sos_manual_votes
      WHERE election_id = @election_id AND county_key = @county_key AND sos_race_id = @sos_race_id
    `);
}

export async function upsertCountySosManualVote(electionId, row) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(row.countyKey ?? "").toLowerCase().trim())
    .input("sos_race_id", String(row.sosRaceId ?? "").trim())
    .input("sos_candidate_id", String(row.sosCandidateId ?? "").trim())
    .input("choice_name", String(row.choiceName ?? "").trim())
    .input("party_name", String(row.partyName ?? "").trim())
    .input("early_votes", Number(row.earlyVotes ?? 0))
    .input("election_day_votes", Number(row.electionDayVotes ?? 0))
    .input("total_votes", Number(row.totalVotes ?? 0))
    .query(`
      MERGE dbo.county_sos_manual_votes AS t
      USING (SELECT @election_id AS election_id, @county_key AS county_key, @sos_race_id AS sos_race_id, @sos_candidate_id AS sos_candidate_id) AS s
      ON t.election_id = s.election_id AND t.county_key = s.county_key AND t.sos_race_id = s.sos_race_id AND t.sos_candidate_id = s.sos_candidate_id
      WHEN MATCHED THEN UPDATE SET choice_name = @choice_name, party_name = @party_name, early_votes = @early_votes,
        election_day_votes = @election_day_votes, total_votes = @total_votes, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (election_id, county_key, sos_race_id, sos_candidate_id, choice_name, party_name, early_votes, election_day_votes, total_votes)
        VALUES (@election_id, @county_key, @sos_race_id, @sos_candidate_id, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes);
    `);
}

export async function listCountySosRaceVoteSources(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", String(electionId)).query(`
    SELECT county_key AS countyKey, sos_race_id AS sosRaceId, vote_source AS voteSource, updated_at AS updatedAt
    FROM dbo.county_sos_race_vote_source WHERE election_id = @election_id
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    sosRaceId: String(row.sosRaceId ?? ""),
    voteSource: String(row.voteSource ?? "sos"),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function deleteCountySosRaceVoteSource(electionId, countyKey, sosRaceId) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(countyKey).toLowerCase().trim())
    .input("sos_race_id", String(sosRaceId).trim())
    .query(`
      DELETE FROM dbo.county_sos_race_vote_source
      WHERE election_id = @election_id AND county_key = @county_key AND sos_race_id = @sos_race_id
    `);
}

export async function upsertCountySosRaceVoteSource(electionId, row) {
  const src = String(row.voteSource ?? "sos").toLowerCase();
  if (!["sos", "county_feed", "manual", "auto"].includes(src)) {
    throw new Error("voteSource must be sos, county_feed, manual, or auto");
  }
  if (src === "auto") {
    await deleteCountySosRaceVoteSource(electionId, row.countyKey, row.sosRaceId);
    return;
  }
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId))
    .input("county_key", String(row.countyKey ?? "").toLowerCase().trim())
    .input("sos_race_id", String(row.sosRaceId ?? "").trim())
    .input("vote_source", src)
    .query(`
      MERGE dbo.county_sos_race_vote_source AS t
      USING (SELECT @election_id AS election_id, @county_key AS county_key, @sos_race_id AS sos_race_id) AS s
      ON t.election_id = s.election_id AND t.county_key = s.county_key AND t.sos_race_id = s.sos_race_id
      WHEN MATCHED THEN UPDATE SET vote_source = @vote_source, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (election_id, county_key, sos_race_id, vote_source)
        VALUES (@election_id, @county_key, @sos_race_id, @vote_source);
    `);
}

export async function buildCivixNameToCountyKeyMap(electionId) {
  const pool = await ensureDb();
  const feeds = await listElectionFeedSources(electionId);
  const map = {};
  for (const f of feeds) {
    const slug = String(f.countyKey ?? "").trim().toLowerCase();
    if (!slug) continue;
    map[await civixCountyLabelForSlugMssql(pool, electionId, slug)] = slug;
  }
  return map;
}

async function migrateCountyPreferJsonToFeedsMssql(pool) {
  try {
    const cfgRows = await pool.request().query(`
      SELECT election_id AS electionId, county_prefer_over_sos_json AS jsonRaw
      FROM dbo.election_source_configs
    `);
    for (const row of cfgRows.recordset ?? []) {
      const eid = String(row.electionId ?? "");
      const raw = String(row.jsonRaw ?? "[]").trim();
      if (!raw || raw === "[]") continue;
      let keys = [];
      try {
        keys = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(keys) || !keys.length) continue;
      for (const k of keys) {
        const slug = String(k ?? "")
          .trim()
          .toLowerCase();
        if (!slug) continue;
        await pool
          .request()
          .input("election_id", eid)
          .input("county_key", slug)
          .query(`
            UPDATE dbo.election_feed_sources
            SET prefer_over_sos = 1
            WHERE election_id = @election_id AND LOWER(county_key) = LOWER(@county_key)
          `);
      }
      await pool
        .request()
        .input("election_id", eid)
        .query(`
          UPDATE dbo.election_source_configs
          SET county_prefer_over_sos_json = N'[]'
          WHERE election_id = @election_id
        `);
    }
  } catch {
    /* ignore */
  }
}

export async function listIngestVendors() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT id, display_name AS displayName, vendor_tier AS vendorTier, handler_key AS handlerKey, notes
    FROM dbo.ingest_vendors ORDER BY vendor_tier DESC, display_name
  `);
  return (r.recordset ?? []).map((x) => ({
    id: String(x.id),
    displayName: String(x.displayName ?? ""),
    vendorTier: String(x.vendorTier ?? "other"),
    handlerKey: String(x.handlerKey ?? ""),
    notes: x.notes == null ? "" : String(x.notes),
  }));
}

async function ensureElectionFeedsSeededFromLegacyMssql(pool, electionId) {
  const c = await pool.request().input("election_id", electionId).query(`
    SELECT COUNT(*) AS n FROM dbo.election_feed_sources WHERE election_id = @election_id
  `);
  if (Number(c.recordset?.[0]?.n ?? 0) > 0) return;

  const cfgR = await pool.request().input("election_id", electionId).query(`
    SELECT harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl, jefferson_source_url AS jeffersonSourceUrl,
           montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl
    FROM dbo.election_source_configs WHERE election_id = @election_id
  `);
  const cfg = cfgR.recordset?.[0];
  if (!cfg) return;

  const feeds = [];
  let ord = 0;
  const push = (countyKey, vendorId, url) => {
    const u = String(url ?? "").trim();
    if (!u) return;
    feeds.push({ countyKey, vendorId, url: u, sortOrder: ord++ });
  };
  push("harris", "harris-pdf", cfg.harrisSourceUrl);
  push("galveston", "clarity-enr-summary-zip", cfg.galvestonSourceUrl);
  push("jefferson", "clarity-enr-summary-zip", cfg.jeffersonSourceUrl);
  push("montgomery", "montgomery-eresults-html", cfg.montgomerySourceUrl);
  push("chambers", "chambers-pdf", cfg.chambersSourceUrl);
  if (!feeds.length) return;

  for (const f of feeds) {
    await pool
      .request()
      .input("election_id", electionId)
      .input("county_key", f.countyKey)
      .input("vendor_id", f.vendorId)
      .input("source_url", f.url)
      .input("sort_order", f.sortOrder)
      .query(`
        INSERT INTO dbo.election_feed_sources (election_id, scope, county_key, vendor_id, source_url, hub_page_url, is_enabled, sort_order, updated_at)
        VALUES (@election_id, N'county', @county_key, @vendor_id, @source_url, N'', 1, @sort_order, SYSUTCDATETIME())
      `);
  }
}

export async function listElectionFeedSources(electionId) {
  const pool = await ensureDb();
  await migrateCountyPreferJsonToFeedsMssql(pool);
  await ensureElectionFeedsSeededFromLegacyMssql(pool, String(electionId));
  const r = await pool.request().input("election_id", String(electionId)).query(`
    SELECT id, election_id AS electionId, scope, county_key AS countyKey, civix_county_name AS civixCountyName,
           vendor_id AS vendorId, source_url AS sourceUrl, hub_page_url AS hubPageUrl,
           is_enabled AS isEnabled, prefer_over_sos AS preferOverSos, sort_order AS sortOrder, updated_at AS updatedAt
    FROM dbo.election_feed_sources WHERE election_id = @election_id ORDER BY sort_order, id
  `);
  return (r.recordset ?? []).map((row) => ({
    id: Number(row.id),
    electionId: String(row.electionId ?? ""),
    scope: String(row.scope ?? "county"),
    countyKey: String(row.countyKey ?? ""),
    civixCountyName: row.civixCountyName == null ? "" : String(row.civixCountyName),
    vendorId: String(row.vendorId ?? ""),
    sourceUrl: String(row.sourceUrl ?? ""),
    hubPageUrl: String(row.hubPageUrl ?? ""),
    isEnabled: !!row.isEnabled,
    preferOverSos: !!row.preferOverSos,
    sortOrder: Number(row.sortOrder ?? 0),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function replaceElectionFeedSourcesForElection(electionId, sources) {
  const pool = await ensureDb();
  const eid = String(electionId ?? "").trim();
  if (!eid) throw new Error("electionId is required");

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction).input("election_id", eid).query(`
      DELETE FROM dbo.election_feed_sources WHERE election_id = @election_id
    `);
    let ord = 0;
    for (const s of sources ?? []) {
      const countyKey = String(s.countyKey ?? "").trim().toLowerCase();
      if (!countyKey) continue;
      const civix =
        s.civixCountyName != null && String(s.civixCountyName).trim() ? String(s.civixCountyName).trim() : null;
      await new sql.Request(transaction)
        .input("election_id", eid)
        .input("county_key", countyKey)
        .input("civix_county_name", civix)
        .input("vendor_id", String(s.vendorId ?? "").trim() || "other-vendor")
        .input("source_url", String(s.sourceUrl ?? ""))
        .input("hub_page_url", String(s.hubPageUrl ?? ""))
        .input("is_enabled", s.isEnabled === false ? 0 : 1)
        .input("prefer_over_sos", s.preferOverSos === true ? 1 : 0)
        .input("sort_order", ord++)
        .query(`
          INSERT INTO dbo.election_feed_sources
            (election_id, scope, county_key, civix_county_name, vendor_id, source_url, hub_page_url, is_enabled, prefer_over_sos, sort_order, updated_at)
          VALUES (@election_id, N'county', @county_key, @civix_county_name, @vendor_id, @source_url, @hub_page_url, @is_enabled, @prefer_over_sos, @sort_order, SYSUTCDATETIME())
        `);
    }
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
  try {
    writeElectionFeedBackupForElection(eid, sources);
  } catch (e) {
    console.warn("election feed backup write failed:", e?.message ?? e);
  }
  return listElectionFeedSources(eid);
}

/** Restore county feeds from JSON sidecar when backup is newer or DB rows are missing. */
async function restoreElectionFeedsFromBackup() {
  const byElection = readElectionFeedBackupByElection();
  let restoredRows = 0;

  for (const [eid, block] of Object.entries(byElection)) {
    const sources = Array.isArray(block?.sources) ? block.sources : [];
    if (!sources.length) continue;

    const pool = await ensureDb();
    const countR = await pool.request().input("election_id", eid).query(`
      SELECT COUNT(*)::bigint AS n, MAX(updated_at) AS maxAt
      FROM dbo.election_feed_sources WHERE election_id = @election_id
    `);
    const row = countR.recordset?.[0] ?? {};
    const dbCount = Number(row.n ?? 0);
    const dbMax = row.maxAt instanceof Date ? row.maxAt.toISOString() : String(row.maxAt ?? "");
    const backupAt = String(block.updatedAt ?? "");

    const shouldRestore =
      dbCount === 0 ||
      (backupAt && (!dbMax || backupAt > dbMax)) ||
      (sources.length > dbCount && backupAt >= dbMax);

    if (!shouldRestore) continue;

    await replaceElectionFeedSourcesForElection(eid, sources);
    restoredRows += sources.length;
  }

  return restoredRows;
}

export async function updateElectionFeedSourceUrl(electionId, feedId, sourceUrl) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("election_id", String(electionId ?? "").trim())
    .input("id", Number(feedId))
    .input("source_url", String(sourceUrl ?? ""))
    .query(`
      UPDATE dbo.election_feed_sources
      SET source_url = @source_url, updated_at = SYSUTCDATETIME()
      WHERE election_id = @election_id AND id = @id
    `);
}

export async function ensureElectionFeedsSeededFromLegacyForElection(electionId) {
  const pool = await ensureDb();
  await ensureElectionFeedsSeededFromLegacyMssql(pool, String(electionId));
}

export async function getAppSettings() {
  const pool = await ensureDb();
  const r = await pool.request().query(
    `SELECT setting_key AS settingKey, value_json AS valueJson
     FROM dbo.app_settings
     WHERE setting_key IN (
       N'disable_auto_ingest', N'auto_refresh_enabled', N'auto_refresh_interval_sec', N'sos_countyinfo_url',
       N'harris_source_url', N'galveston_source_url', N'jefferson_source_url', N'montgomery_source_url', N'chambers_source_url',
       N'display_time_zone', N'civix_cookie', N'civix_connect_token'
     )`,
  );
  const map = new Map(r.recordset.map((x) => [String(x.settingKey), String(x.valueJson)]));
  return {
    disableAutoIngest: (map.get("disable_auto_ingest") ?? "false").toLowerCase() === "true",
    autoRefreshEnabled: (map.get("auto_refresh_enabled") ?? "false").toLowerCase() === "true",
    autoRefreshIntervalSec: Math.max(15, Number(map.get("auto_refresh_interval_sec") ?? "60") || 60),
    sosCountyInfoUrl: map.get("sos_countyinfo_url") ?? "",
    harrisSourceUrl: map.get("harris_source_url") ?? "",
    galvestonSourceUrl: map.get("galveston_source_url") ?? "",
    jeffersonSourceUrl: map.get("jefferson_source_url") ?? "",
    montgomerySourceUrl: map.get("montgomery_source_url") ?? "",
    chambersSourceUrl: map.get("chambers_source_url") ?? "",
    displayTimeZone: map.get("display_time_zone") ?? "America/Chicago",
    /** Stored session cookie for Civix (not returned to clients). */
    civixCookie: map.get("civix_cookie") ?? "",
    civixCookieConfigured: Boolean(String(map.get("civix_cookie") ?? "").trim()),
    civixConnectTokenJson: map.get("civix_connect_token") ?? "",
  };
}

/** @param {string} key @param {string} value */
export async function upsertAppSetting(key, value) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("setting_key", key)
    .input("value_json", String(value))
    .query(`
      MERGE dbo.app_settings AS target
      USING (SELECT @setting_key AS setting_key, @value_json AS value_json) AS source
      ON target.setting_key = source.setting_key
      WHEN MATCHED THEN UPDATE SET value_json = source.value_json, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (setting_key, value_json) VALUES (source.setting_key, source.value_json);
    `);
}

export async function updateAppSettings({
  disableAutoIngest,
  autoRefreshEnabled,
  autoRefreshIntervalSec,
  sosCountyInfoUrl,
  harrisSourceUrl,
  galvestonSourceUrl,
  jeffersonSourceUrl,
  montgomerySourceUrl,
  chambersSourceUrl,
  displayTimeZone,
  civixCookie,
}) {
  const pool = await ensureDb();
  const upsert = async (key, value) => {
    await pool
      .request()
      .input("setting_key", key)
      .input("value_json", String(value))
      .query(`
        MERGE dbo.app_settings AS target
        USING (SELECT @setting_key AS setting_key, @value_json AS value_json) AS source
        ON target.setting_key = source.setting_key
        WHEN MATCHED THEN UPDATE SET value_json = source.value_json, updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (setting_key, value_json) VALUES (source.setting_key, source.value_json);
      `);
  };
  await upsert("disable_auto_ingest", disableAutoIngest ? "true" : "false");
  if (typeof autoRefreshEnabled === "boolean") await upsert("auto_refresh_enabled", autoRefreshEnabled ? "true" : "false");
  if (autoRefreshIntervalSec != null) await upsert("auto_refresh_interval_sec", Math.max(15, Number(autoRefreshIntervalSec) || 60));
  if (sosCountyInfoUrl != null) await upsert("sos_countyinfo_url", String(sosCountyInfoUrl));
  if (harrisSourceUrl != null) await upsert("harris_source_url", String(harrisSourceUrl));
  if (galvestonSourceUrl != null) await upsert("galveston_source_url", String(galvestonSourceUrl));
  if (jeffersonSourceUrl != null) await upsert("jefferson_source_url", String(jeffersonSourceUrl));
  if (montgomerySourceUrl != null) await upsert("montgomery_source_url", String(montgomerySourceUrl));
  if (chambersSourceUrl != null) await upsert("chambers_source_url", String(chambersSourceUrl));
  if (displayTimeZone != null) await upsert("display_time_zone", String(displayTimeZone || "America/Chicago"));
  if (civixCookie != null) await upsert("civix_cookie", String(civixCookie));
  const settings = await getAppSettings();
  return {
    disableAutoIngest: settings.disableAutoIngest,
    autoRefreshEnabled: settings.autoRefreshEnabled,
    autoRefreshIntervalSec: settings.autoRefreshIntervalSec,
    sosCountyInfoUrl: settings.sosCountyInfoUrl,
    harrisSourceUrl: settings.harrisSourceUrl,
    galvestonSourceUrl: settings.galvestonSourceUrl,
    jeffersonSourceUrl: settings.jeffersonSourceUrl,
    montgomerySourceUrl: settings.montgomerySourceUrl,
    chambersSourceUrl: settings.chambersSourceUrl,
    displayTimeZone: settings.displayTimeZone,
    civixCookieConfigured: settings.civixCookieConfigured,
  };
}

export async function clearLiveResultTables() {
  const pool = await ensureDb();
  await pool.request().batch(`
    DELETE FROM dbo.sos_results;
    DELETE FROM dbo.sos_candidate_results;
    DELETE FROM dbo.sos_county_results;
    DELETE FROM dbo.county_results;
    DELETE FROM dbo.county_harris_results;
    DELETE FROM dbo.county_galveston_results;
    DELETE FROM dbo.county_jefferson_results;
    DELETE FROM dbo.county_chambers_results;
    DELETE FROM dbo.county_montgomery_results;
  `);
}

export async function pruneLiveResultHistory(keepSosBatches = 2) {
  const pool = await ensureDb();
  const keep = Math.max(1, Number(keepSosBatches) || 2);
  await pool.request().input("keep", keep).batch(`
    ;WITH ranked AS (
      SELECT id,
             DENSE_RANK() OVER (PARTITION BY election_id ORDER BY fetched_at DESC) AS dr
      FROM dbo.sos_results
    )
    DELETE FROM dbo.sos_results WHERE id IN (SELECT id FROM ranked WHERE dr > @keep);

    ;WITH ranked AS (
      SELECT id,
             DENSE_RANK() OVER (PARTITION BY election_id ORDER BY fetched_at DESC) AS dr
      FROM dbo.sos_candidate_results
    )
    DELETE FROM dbo.sos_candidate_results WHERE id IN (SELECT id FROM ranked WHERE dr > @keep);

    ;WITH ranked AS (
      SELECT id,
             DENSE_RANK() OVER (PARTITION BY election_id, county_name ORDER BY fetched_at DESC) AS dr
      FROM dbo.sos_county_results
    )
    DELETE FROM dbo.sos_county_results WHERE id IN (SELECT id FROM ranked WHERE dr > @keep);
  `);
}

export async function listElectionSourceConfigs() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT election_id AS electionId, label, is_enabled AS isEnabled, auto_refresh_enabled AS autoRefreshEnabled,
           uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog, is_default_catalog AS isDefaultCatalog,
           sos_countyinfo_url AS sosCountyInfoUrl, harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl,
           jefferson_source_url AS jeffersonSourceUrl, montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl,
           updated_at AS updatedAt
    FROM dbo.election_source_configs
    ORDER BY is_default_catalog DESC, election_id
  `);
  return (r.recordset ?? []).map((row) => ({
    electionId: String(row.electionId ?? ""),
    label: String(row.label ?? ""),
    isEnabled: !!row.isEnabled,
    autoRefreshEnabled: !!row.autoRefreshEnabled,
    usesCivixSos: row.usesCivixSos == null ? true : !!row.usesCivixSos,
    showInCatalog: row.showInCatalog == null ? true : !!row.showInCatalog,
    isDefaultCatalog: !!row.isDefaultCatalog,
    sosCountyInfoUrl: String(row.sosCountyInfoUrl ?? ""),
    harrisSourceUrl: String(row.harrisSourceUrl ?? ""),
    galvestonSourceUrl: String(row.galvestonSourceUrl ?? ""),
    jeffersonSourceUrl: String(row.jeffersonSourceUrl ?? ""),
    montgomerySourceUrl: String(row.montgomerySourceUrl ?? ""),
    chambersSourceUrl: String(row.chambersSourceUrl ?? ""),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function getElectionSourceConfig(electionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("election_id", String(electionId)).query(`
    SELECT election_id AS electionId, label, is_enabled AS isEnabled, auto_refresh_enabled AS autoRefreshEnabled,
           uses_civix_sos AS usesCivixSos, show_in_catalog AS showInCatalog, is_default_catalog AS isDefaultCatalog,
           sos_countyinfo_url AS sosCountyInfoUrl, harris_source_url AS harrisSourceUrl, galveston_source_url AS galvestonSourceUrl,
           jefferson_source_url AS jeffersonSourceUrl, montgomery_source_url AS montgomerySourceUrl, chambers_source_url AS chambersSourceUrl
    FROM dbo.election_source_configs WHERE election_id = @election_id
  `);
  const row = r.recordset?.[0];
  if (!row) return null;
  return {
    electionId: String(row.electionId ?? ""),
    label: String(row.label ?? ""),
    isEnabled: !!row.isEnabled,
    autoRefreshEnabled: !!row.autoRefreshEnabled,
    usesCivixSos: row.usesCivixSos == null ? true : !!row.usesCivixSos,
    showInCatalog: row.showInCatalog == null ? true : !!row.showInCatalog,
    isDefaultCatalog: !!row.isDefaultCatalog,
    sosCountyInfoUrl: String(row.sosCountyInfoUrl ?? ""),
    harrisSourceUrl: String(row.harrisSourceUrl ?? ""),
    galvestonSourceUrl: String(row.galvestonSourceUrl ?? ""),
    jeffersonSourceUrl: String(row.jeffersonSourceUrl ?? ""),
    montgomerySourceUrl: String(row.montgomerySourceUrl ?? ""),
    chambersSourceUrl: String(row.chambersSourceUrl ?? ""),
  };
}

export async function setDefaultElectionCatalog(electionId) {
  const pool = await ensureDb();
  const id = String(electionId ?? "").trim();
  if (!id) throw new Error("electionId is required");
  const check = await pool.request().input("election_id", id).query(`
    SELECT 1 AS ok FROM dbo.election_source_configs WHERE election_id = @election_id
  `);
  if (!check.recordset?.length) throw new Error(`Election ${id} not found`);
  await pool.request().query(`UPDATE dbo.election_source_configs SET is_default_catalog = 0`);
  await pool
    .request()
    .input("election_id", id)
    .query(`
      UPDATE dbo.election_source_configs
      SET is_default_catalog = 1, updated_at = SYSUTCDATETIME()
      WHERE election_id = @election_id
    `);
  return getElectionSourceConfig(id);
}

export async function upsertElectionSourceConfig(payload) {
  const pool = await ensureDb();
  const electionId = String(payload?.electionId ?? "").trim();
  if (!electionId) throw new Error("electionId is required");
  const usesSos = payload?.usesCivixSos === false ? 0 : 1;
  const showCat = payload?.showInCatalog === false ? 0 : 1;
  await pool
    .request()
    .input("election_id", electionId)
    .input("label", String(payload?.label ?? electionId))
    .input("is_enabled", !!payload?.isEnabled)
    .input("auto_refresh_enabled", !!payload?.autoRefreshEnabled)
    .input("uses_civix_sos", usesSos)
    .input("show_in_catalog", showCat)
    .input("sos_countyinfo_url", String(payload?.sosCountyInfoUrl ?? ""))
    .input("harris_source_url", String(payload?.harrisSourceUrl ?? ""))
    .input("galveston_source_url", String(payload?.galvestonSourceUrl ?? ""))
    .input("jefferson_source_url", String(payload?.jeffersonSourceUrl ?? ""))
    .input("montgomery_source_url", String(payload?.montgomerySourceUrl ?? ""))
    .input("chambers_source_url", String(payload?.chambersSourceUrl ?? ""))
    .query(`
      MERGE dbo.election_source_configs AS target
      USING (SELECT @election_id AS election_id) AS source
      ON target.election_id = source.election_id
      WHEN MATCHED THEN UPDATE SET
        label = @label,
        is_enabled = @is_enabled,
        auto_refresh_enabled = @auto_refresh_enabled,
        uses_civix_sos = @uses_civix_sos,
        show_in_catalog = @show_in_catalog,
        sos_countyinfo_url = @sos_countyinfo_url,
        harris_source_url = @harris_source_url,
        galveston_source_url = @galveston_source_url,
        jefferson_source_url = @jefferson_source_url,
        montgomery_source_url = @montgomery_source_url,
        chambers_source_url = @chambers_source_url,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (election_id, label, is_enabled, auto_refresh_enabled, uses_civix_sos, show_in_catalog, sos_countyinfo_url, harris_source_url, galveston_source_url, jefferson_source_url, montgomery_source_url, chambers_source_url)
      VALUES
        (@election_id, @label, @is_enabled, @auto_refresh_enabled, @uses_civix_sos, @show_in_catalog, @sos_countyinfo_url, @harris_source_url, @galveston_source_url, @jefferson_source_url, @montgomery_source_url, @chambers_source_url);
    `);
  return getElectionSourceConfig(electionId);
}

export async function deleteElectionSourceConfig(electionId) {
  const pool = await ensureDb();
  const id = String(electionId ?? "").trim();
  if (!id) throw new Error("electionId is required");
  const row = await getElectionSourceConfig(id);
  if (!row) throw new Error(`Election ${id} not found`);
  const wasDefault = !!row.isDefaultCatalog;
  const importLike = `${id}:%`;

  await pool.request().input("election_id", id).input("import_like", importLike).batch(`
    DELETE FROM dbo.county_sos_race_vote_source WHERE election_id = @election_id;
    DELETE FROM dbo.county_sos_manual_votes WHERE election_id = @election_id;
    DELETE FROM dbo.county_sos_race_links WHERE election_id = @election_id;
    DELETE FROM dbo.election_feed_sources WHERE election_id = @election_id;
    DELETE FROM dbo.county_results WHERE election_id = @election_id;
    DELETE FROM dbo.sos_candidate_results WHERE election_id = @election_id;
    DELETE FROM dbo.sos_county_results WHERE election_id = @election_id;
    DELETE FROM dbo.sos_results WHERE election_id = @election_id;
    DELETE FROM dbo.vote_update_history WHERE election_id = @election_id;
    DELETE FROM dbo.source_import_log WHERE source_key LIKE @import_like;
    DELETE FROM dbo.election_source_configs WHERE election_id = @election_id;
  `);

  removeElectionFeedBackupForElection(id);

  if (wasDefault) {
    const rest = await listElectionSourceConfigs();
    if (rest.length) await setDefaultElectionCatalog(rest[0].electionId);
  }

  return { deleted: true, electionId: id };
}

export async function appendVoteHistoryIfChanged({ electionId, sourceKey, capturedAt, rows }) {
  const pool = await ensureDb();
  const electionKey = String(electionId ?? "56181");
  const source = String(sourceKey ?? "unknown");
  const captured = capturedAt != null ? new Date(capturedAt) : new Date();
  for (const row of rows ?? []) {
    const contestName = String(row.contestName ?? "");
    const choiceName = String(row.choiceName ?? "");
    const partyName = row.partyName == null ? null : String(row.partyName);
    const earlyVotes = Number(row.earlyVotes ?? 0);
    const electionDayVotes = Number(row.electionDayVotes ?? 0);
    const totalVotes = Number(row.totalVotes ?? 0);
    const percentOfVotes = row.percentOfVotes == null ? null : String(row.percentOfVotes);
    const prev = await pool
      .request()
      .input("election_id", electionKey)
      .input("source_key", source)
      .input("contest_name", contestName)
      .input("choice_name", choiceName)
      .input("party_name", partyName)
      .query(`
        SELECT TOP 1 early_votes AS earlyVotes, election_day_votes AS electionDayVotes, total_votes AS totalVotes, percent_of_votes AS percentOfVotes
        FROM dbo.vote_update_history
        WHERE election_id = @election_id AND source_key = @source_key AND contest_name = @contest_name AND choice_name = @choice_name
          AND COALESCE(party_name, '') = COALESCE(@party_name, '')
        ORDER BY id DESC
      `);
    const p = prev.recordset?.[0];
    const changed =
      !p ||
      Number(p.earlyVotes ?? 0) !== earlyVotes ||
      Number(p.electionDayVotes ?? 0) !== electionDayVotes ||
      Number(p.totalVotes ?? 0) !== totalVotes ||
      String(p.percentOfVotes ?? "") !== String(percentOfVotes ?? "");
    if (!changed) continue;
    await pool
      .request()
      .input("election_id", electionKey)
      .input("source_key", source)
      .input("contest_name", contestName)
      .input("choice_name", choiceName)
      .input("party_name", partyName)
      .input("early_votes", earlyVotes)
      .input("election_day_votes", electionDayVotes)
      .input("total_votes", totalVotes)
      .input("percent_of_votes", percentOfVotes)
      .input("captured_at", captured)
      .query(`
        INSERT INTO dbo.vote_update_history
          (election_id, source_key, contest_name, choice_name, party_name, early_votes, election_day_votes, total_votes, percent_of_votes, captured_at)
        VALUES
          (@election_id, @source_key, @contest_name, @choice_name, @party_name, @early_votes, @election_day_votes, @total_votes, @percent_of_votes, @captured_at)
      `);
  }
}

const SOURCE_IMPORT_LOG_CAP = 500;

export async function appendSourceImportLog({ sourceKey, ok, message }) {
  try {
    const pool = await ensureDb();
    const key = String(sourceKey ?? "").trim().slice(0, 64) || "unknown";
    const msg = String(message ?? "").slice(0, 400000);
    await pool
      .request()
      .input("source_key", key)
      .input("ok", !!ok)
      .input("message", msg)
      .query(`INSERT INTO dbo.source_import_log (source_key, ok, message) VALUES (@source_key, @ok, @message)`);
    await pool.request().input("cap", SOURCE_IMPORT_LOG_CAP).query(`
      ;WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn
        FROM dbo.source_import_log
      )
      DELETE FROM dbo.source_import_log WHERE id IN (SELECT id FROM ranked WHERE rn > @cap);
    `);
  } catch (e) {
    console.error("appendSourceImportLog", e);
  }
}

export async function getSourceImportLogPayload({ recentLimit = 200 } = {}) {
  const pool = await ensureDb();
  const limit = Math.max(1, Math.min(500, Number(recentLimit) || 200));
  const recentR = await pool.request().input("lim", limit).query(`
    SELECT TOP (@lim) id, source_key AS sourceKey, ok, message, occurred_at AS occurredAt
    FROM dbo.source_import_log ORDER BY id DESC
  `);
  const entries = (recentR.recordset ?? []).map((row) => ({
    id: Number(row.id),
    sourceKey: String(row.sourceKey ?? ""),
    ok: !!row.ok,
    message: String(row.message ?? ""),
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt ?? ""),
  }));

  const latestR = await pool.request().query(`
    SELECT s.id, s.source_key AS sourceKey, s.ok, s.message, s.occurred_at AS occurredAt
    FROM dbo.source_import_log s
    INNER JOIN (
      SELECT source_key, MAX(id) AS mid FROM dbo.source_import_log GROUP BY source_key
    ) t ON s.source_key = t.source_key AND s.id = t.mid
  `);
  const latestBySource = {};
  for (const row of latestR.recordset ?? []) {
    const at = row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt ?? "");
    latestBySource[String(row.sourceKey ?? "")] = {
      ok: !!row.ok,
      message: String(row.message ?? ""),
      occurredAt: at,
    };
  }
  return { entries, latestBySource };
}

export async function listEvRosterConfigs() {
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT evr_election_id AS evrElectionId, party, election_name AS electionName, election_date AS electionDate,
           is_enabled AS isEnabled, notes, updated_at AS updatedAt
    FROM dbo.ev_roster_configs ORDER BY party, evr_election_id
  `);
  return (r.recordset ?? []).map((row) => ({
    evrElectionId: Number(row.evrElectionId),
    party: String(row.party ?? ""),
    electionName: String(row.electionName ?? ""),
    electionDate: String(row.electionDate ?? ""),
    isEnabled: !!row.isEnabled,
    notes: row.notes != null ? String(row.notes) : null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt ?? ""),
  }));
}

export async function upsertEvRosterConfig({ evrElectionId, party, electionName, electionDate, isEnabled, notes }) {
  const pool = await ensureDb();
  await pool
    .request()
    .input("evr_election_id", Number(evrElectionId))
    .input("party", String(party ?? ""))
    .input("election_name", String(electionName ?? ""))
    .input("election_date", String(electionDate ?? ""))
    .input("is_enabled", isEnabled === false ? 0 : 1)
    .input("notes", notes != null ? String(notes) : null)
    .query(`
      MERGE dbo.ev_roster_configs AS target
      USING (SELECT @evr_election_id AS evr_election_id) AS source
      ON target.evr_election_id = source.evr_election_id
      WHEN MATCHED THEN UPDATE SET
        party = @party, election_name = @election_name, election_date = @election_date,
        is_enabled = @is_enabled, notes = @notes, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (evr_election_id, party, election_name, election_date, is_enabled, notes)
        VALUES (@evr_election_id, @party, @election_name, @election_date, @is_enabled, @notes);
    `);
  return listEvRosterConfigs();
}

/** @returns {Promise<Set<string>>} uppercased county names confirmed for this date */
export async function getConfirmedEvRosterCountyNames(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("evr_election_id", Number(evrElectionId))
    .input("voting_date", String(votingDate ?? "").trim())
    .query(`
      SELECT county_name AS countyName
      FROM dbo.ev_roster_county_pull_status
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date AND confirmed_at IS NOT NULL
    `);
  return new Set((r.recordset ?? []).map((row) => String(row.countyName ?? "").toUpperCase()).filter(Boolean));
}

export async function listEvRosterCountyPullStatuses(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("evr_election_id", Number(evrElectionId))
    .input("voting_date", String(votingDate ?? "").trim())
    .query(`
      SELECT county_name AS countyName, county_key AS countyKey, last_pull_ok AS lastPullOk,
             last_pull_at AS lastPullAt, last_pull_message AS lastPullMessage, voter_count AS voterCount,
             confirmed_at AS confirmedAt
      FROM dbo.ev_roster_county_pull_status
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date
    `);
  return (r.recordset ?? []).map((row) => ({
    countyName: String(row.countyName ?? ""),
    countyKey: row.countyKey != null ? String(row.countyKey) : null,
    lastPullOk: row.lastPullOk == null ? null : !!row.lastPullOk,
    lastPullAt: row.lastPullAt instanceof Date ? row.lastPullAt.toISOString() : row.lastPullAt ? String(row.lastPullAt) : null,
    lastPullMessage: row.lastPullMessage != null ? String(row.lastPullMessage) : null,
    voterCount: Number(row.voterCount ?? 0),
    confirmedAt: row.confirmedAt instanceof Date ? row.confirmedAt.toISOString() : row.confirmedAt ? String(row.confirmedAt) : null,
  }));
}

/**
 * @param {number} evrElectionId
 * @param {string} votingDate
 * @param {Array<{ countyName?: string, countyKey?: string, ok?: boolean, voterCount?: number, message?: string }>} countyPullLog
 */
export async function recordEvRosterCountyPullResults(evrElectionId, votingDate, countyPullLog) {
  const { aggregateCountyPullResults } = await import("./lib/evRosterCountyStatus.mjs");
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const now = new Date();
  for (const row of aggregateCountyPullResults(countyPullLog)) {
    await pool
      .request()
      .input("evr_election_id", eid)
      .input("voting_date", vDate)
      .input("county_name", row.countyName)
      .input("county_key", row.countyKey || null)
      .input("last_pull_ok", row.lastPullOk ? 1 : 0)
      .input("last_pull_at", now)
      .input("last_pull_message", row.messages.join(" | ").slice(0, 4000) || null)
      .input("voter_count", Number(row.voterCount ?? 0))
      .query(`
        MERGE dbo.ev_roster_county_pull_status AS target
        USING (SELECT @evr_election_id AS evr_election_id, @voting_date AS voting_date, @county_name AS county_name) AS source
        ON target.evr_election_id = source.evr_election_id AND target.voting_date = source.voting_date
          AND target.county_name = source.county_name
        WHEN MATCHED THEN UPDATE SET
          county_key = COALESCE(@county_key, target.county_key),
          last_pull_ok = @last_pull_ok, last_pull_at = @last_pull_at, last_pull_message = @last_pull_message,
          voter_count = @voter_count
        WHEN NOT MATCHED THEN INSERT
          (evr_election_id, voting_date, county_name, county_key, last_pull_ok, last_pull_at, last_pull_message, voter_count)
        VALUES (@evr_election_id, @voting_date, @county_name, @county_key, @last_pull_ok, @last_pull_at, @last_pull_message, @voter_count);
      `);
  }
}

export async function confirmEvRosterCountyPull(evrElectionId, votingDate, countyName) {
  const pool = await ensureDb();
  const name = String(countyName ?? "").toUpperCase();
  const check = await pool
    .request()
    .input("evr_election_id", Number(evrElectionId))
    .input("voting_date", String(votingDate ?? "").trim())
    .input("county_name", name)
    .query(`
      SELECT last_pull_ok AS lastPullOk FROM dbo.ev_roster_county_pull_status
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date AND county_name = @county_name
    `);
  if (!check.recordset?.length) {
    throw new Error(`No county pull recorded for ${name} on this date — pull the county first.`);
  }
  if (!check.recordset[0].lastPullOk) {
    throw new Error(`Latest pull for ${name} did not succeed — fix sources and pull again before confirming.`);
  }
  await pool
    .request()
    .input("evr_election_id", Number(evrElectionId))
    .input("voting_date", String(votingDate ?? "").trim())
    .input("county_name", name)
    .query(`
      UPDATE dbo.ev_roster_county_pull_status SET confirmed_at = SYSUTCDATETIME()
      WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date AND county_name = @county_name
    `);
  return listEvRosterCountyPullStatuses(evrElectionId, votingDate);
}

/** Remove all stored pulls, voters, summaries, and per-county pull status (keeps configs & county sources). */
export async function clearEvRosterPullData() {
  const pool = await ensureDb();
  const count = async (table) => {
    const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(r.recordset?.[0]?.n ?? 0);
  };
  const before = {
    voters: await count("dbo.ev_roster_voters"),
    pulls: await count("dbo.ev_roster_pulls"),
  };
  const tables = [
    "dbo.ev_roster_county_pull_log",
    "dbo.ev_roster_county_summary",
    "dbo.ev_roster_county_pull_status",
    "dbo.ev_roster_voters",
    "dbo.ev_roster_pulls",
    "dbo.ev_roster_activity_cache",
    "dbo.ev_roster_registered_cache",
  ];
  for (const t of tables) {
    await pool.request().query(`DELETE FROM ${t}`);
  }
  return { cleared: before, remaining: { voters: 0, pulls: 0 } };
}

export async function saveEvRosterPull(payload, options = {}) {
  if (options?.merge) return mergeEvRosterPull(payload);
  const {
    evrElectionId,
    votingDate,
    hubPageUrl,
    sosTurnoutUrl,
    sosRosterUrl,
    statewideVoterCount,
    rawRecordCount,
    dedupedVoterCount,
    ok,
    message,
    countySummaries,
    voters,
    countyPullLog,
  } = payload;
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const locked = await getConfirmedEvRosterCountyNames(eid, vDate);
  const { filterSummariesForLocked, filterVotersForLocked } = await import("./lib/evRosterCountyStatus.mjs");
  let preservedSummaries = [];
  if (locked.size) {
    const existing = await getEvRosterPullPayload(eid, vDate);
    preservedSummaries = (existing?.counties ?? []).filter((c) =>
      locked.has(String(c.countyName ?? "").toUpperCase()),
    );
  }
  const summariesToWrite = [
    ...filterSummariesForLocked(countySummaries, locked),
    ...preservedSummaries,
  ];
  const votersToWrite = filterVotersForLocked(voters, locked);
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const req = () => new sql.Request(transaction);
    await req()
      .input("evr_election_id", eid)
      .input("voting_date", vDate)
      .query(`DELETE FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
    const ins = await req()
      .input("evr_election_id", eid)
      .input("voting_date", vDate)
      .input("hub_page_url", hubPageUrl ?? null)
      .input("sos_turnout_url", sosTurnoutUrl ?? null)
      .input("sos_roster_url", sosRosterUrl ?? null)
      .input("statewide_voter_count", Number(statewideVoterCount ?? 0))
      .input("raw_record_count", Number(rawRecordCount ?? 0))
      .input("deduped_voter_count", Number(dedupedVoterCount ?? 0))
      .input("ok", ok === false ? 0 : 1)
      .input("message", String(message ?? "").slice(0, 4000))
      .query(`
        INSERT INTO dbo.ev_roster_pulls
          (evr_election_id, voting_date, hub_page_url, sos_turnout_url, sos_roster_url, statewide_voter_count,
           raw_record_count, deduped_voter_count, ok, message)
        OUTPUT INSERTED.id AS id
        VALUES (@evr_election_id, @voting_date, @hub_page_url, @sos_turnout_url, @sos_roster_url, @statewide_voter_count,
                @raw_record_count, @deduped_voter_count, @ok, @message)
      `);
    const pullId = Number(ins.recordset?.[0]?.id);
    for (const c of summariesToWrite) {
      await req()
        .input("pull_id", pullId)
        .input("county_name", String(c.countyName ?? ""))
        .input("county_id", c.countyId != null ? Number(c.countyId) : null)
        .input("registered_voters", Number(c.registeredVoters ?? 0))
        .input("in_person_votes_on_date", Number(c.inPersonVotesOnDate ?? 0))
        .input("total_in_person_votes_for_election", Number(c.totalInPersonVotesForElection ?? 0))
        .input("total_mail_votes_for_election", Number(c.totalMailVotesForElection ?? 0))
        .input("cumulative_total", Number(c.cumulativeTotal ?? 0))
        .input("sos_voter_count", Number(c.sosVoterCount ?? 0))
        .input("county_voter_count", Number(c.countyVoterCount ?? 0))
        .input("chosen_source", String(c.chosenSource ?? "sos"))
        .input("chosen_voter_count", Number(c.chosenVoterCount ?? 0))
        .query(`
          INSERT INTO dbo.ev_roster_county_summary
            (pull_id, county_name, county_id, registered_voters, in_person_votes_on_date, total_in_person_votes_for_election,
             total_mail_votes_for_election, cumulative_total, sos_voter_count, county_voter_count, chosen_source, chosen_voter_count)
          VALUES (@pull_id, @county_name, @county_id, @registered_voters, @in_person_votes_on_date, @total_in_person_votes_for_election,
                  @total_mail_votes_for_election, @cumulative_total, @sos_voter_count, @county_voter_count, @chosen_source, @chosen_voter_count)
        `);
    }
    if (locked.size) {
      const names = [...locked];
      const placeholders = names.map((_, i) => `@lock_${i}`).join(", ");
      const delReq = req()
        .input("evr_election_id", eid)
        .input("voting_date", vDate);
      names.forEach((n, i) => delReq.input(`lock_${i}`, n));
      await delReq.query(`
        DELETE FROM dbo.ev_roster_voters
        WHERE evr_election_id = @evr_election_id
          AND COALESCE(reporting_date, voting_date) = @voting_date
          AND county_name NOT IN (${placeholders})
      `);
    } else {
      await req()
        .input("evr_election_id", eid)
        .input("voting_date", vDate)
        .query(`
          DELETE FROM dbo.ev_roster_voters
          WHERE evr_election_id = @evr_election_id
            AND COALESCE(reporting_date, voting_date) = @voting_date
        `);
    }
    for (const v of votersToWrite) {
      const activityDate = resolveVoterActivityDate(v, vDate);
      await req()
        .input("evr_election_id", eid)
        .input("voting_date", activityDate)
        .input("reporting_date", vDate)
        .input("county_name", String(v.countyName ?? v.county ?? ""))
        .input("vuid", String(v.vuid ?? ""))
        .input("voter_name", v.voterName != null ? String(v.voterName) : null)
        .input("voting_method", v.votingMethod != null ? String(v.votingMethod) : null)
        .input("method_code", v.methodCode != null ? String(v.methodCode) : null)
        .input("party", v.party != null ? String(v.party) : null)
        .input("precinct", v.precinct != null ? String(v.precinct) : null)
        .input("source", String(v.sourceKey ?? v.source ?? "sos"))
        .query(`
          MERGE dbo.ev_roster_voters AS target
          USING (SELECT @evr_election_id AS evr_election_id, @voting_date AS voting_date, @vuid AS vuid) AS source
          ON target.evr_election_id = source.evr_election_id AND target.voting_date = source.voting_date
            AND target.county_name = @county_name AND target.vuid = source.vuid
          WHEN MATCHED THEN UPDATE SET
            voter_name = @voter_name, voting_method = @voting_method,
            method_code = @method_code, party = @party, precinct = @precinct, source = @source,
            reporting_date = @reporting_date
          WHEN NOT MATCHED THEN INSERT
            (evr_election_id, voting_date, reporting_date, county_name, vuid, voter_name, voting_method, method_code, party, precinct, source)
          VALUES (@evr_election_id, @voting_date, @reporting_date, @county_name, @vuid, @voter_name, @voting_method, @method_code, @party, @precinct, @source);
        `);
    }
    for (const log of countyPullLog ?? []) {
      await req()
        .input("pull_id", pullId)
        .input("county_key", String(log.countyKey ?? ""))
        .input("county_name", String(log.countyName ?? ""))
        .input("handler_key", String(log.handlerKey ?? ""))
        .input("ok", log.ok === false ? 0 : 1)
        .input("voter_count", Number(log.voterCount ?? 0))
        .input("source_url", log.sourceUrl ?? null)
        .input("message", String(log.message ?? "").slice(0, 2000))
        .query(`
          INSERT INTO dbo.ev_roster_county_pull_log
            (pull_id, county_key, county_name, handler_key, ok, voter_count, source_url, message)
          VALUES (@pull_id, @county_key, @county_name, @handler_key, @ok, @voter_count, @source_url, @message)
        `);
    }
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
  await rebuildEvRosterSummaryCache(eid, { pool });
  return getEvRosterPullPayload(eid, vDate);
}

/**
 * One row per VUID per runoff election — keep earliest voting_date (then lowest id).
 * @returns {Promise<{ removed: number, distinctVuids: number }>}
 */
export async function dedupeEvRosterVotersKeepOldestDate(evrElectionId) {
  const pool = await ensureDb();
  const eid = Number(evrElectionId);

  const beforeR = await pool
    .request()
    .input("evr_election_id", eid)
    .query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id`);
  const before = Number(beforeR.recordset?.[0]?.n ?? 0);

  await pool.request().input("evr_election_id", eid).query(`
    DELETE FROM dbo.ev_roster_voters
    WHERE evr_election_id = @evr_election_id
    AND id NOT IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY vuid ORDER BY voting_date ASC, id ASC) AS rn
        FROM dbo.ev_roster_voters
        WHERE evr_election_id = @evr_election_id
      ) ranked WHERE rn = 1
    )
  `);

  const afterR = await pool
    .request()
    .input("evr_election_id", eid)
    .query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id`);
  const after = Number(afterR.recordset?.[0]?.n ?? 0);

  const distinctR = await pool
    .request()
    .input("evr_election_id", eid)
    .query(`SELECT COUNT(DISTINCT vuid) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id`);
  const distinctVuids = Number(distinctR.recordset?.[0]?.n ?? 0);

  await pool.request().input("evr_election_id", eid).query(`
    UPDATE p SET deduped_voter_count = c.n
    FROM dbo.ev_roster_pulls p
    INNER JOIN (
      SELECT evr_election_id, voting_date, COUNT(*) AS n
      FROM dbo.ev_roster_voters
      WHERE evr_election_id = @evr_election_id
      GROUP BY evr_election_id, voting_date
    ) c ON c.evr_election_id = p.evr_election_id AND c.voting_date = p.voting_date
    WHERE p.evr_election_id = @evr_election_id
  `);

  await rebuildEvRosterSummaryCache(eid, { pool });
  return { removed: Math.max(0, before - after), distinctVuids };
}

export async function rebuildEvRosterSummaryCacheForElection(evrElectionId) {
  const pool = await ensureDb();
  return rebuildEvRosterSummaryCache(Number(evrElectionId), { pool });
}

export async function mergeEvRosterPull({
  evrElectionId,
  votingDate,
  hubPageUrl,
  sosTurnoutUrl,
  sosRosterUrl,
  statewideVoterCount,
  rawRecordCount,
  dedupedVoterCount,
  ok,
  message,
  countySummaries,
  voters,
  countyPullLog,
}) {
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const locked = await getConfirmedEvRosterCountyNames(eid, vDate);
  const { filterSummariesForLocked, filterVotersForLocked } = await import("./lib/evRosterCountyStatus.mjs");
  const countySummariesWritable = filterSummariesForLocked(countySummaries, locked);
  const votersWritable = filterVotersForLocked(voters, locked);
  const findR = await pool
    .request()
    .input("evr_election_id", eid)
    .input("voting_date", vDate)
    .query(`SELECT TOP 1 id FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
  let pullId = findR.recordset?.[0]?.id != null ? Number(findR.recordset[0].id) : null;
  if (pullId == null) {
    const ins = await pool
      .request()
      .input("evr_election_id", eid)
      .input("voting_date", vDate)
      .input("hub_page_url", hubPageUrl ?? null)
      .input("sos_turnout_url", sosTurnoutUrl ?? null)
      .input("sos_roster_url", sosRosterUrl ?? null)
      .input("statewide_voter_count", Number(statewideVoterCount ?? 0))
      .input("message", String(message ?? "Merged county pull").slice(0, 4000))
      .query(`
        INSERT INTO dbo.ev_roster_pulls
          (evr_election_id, voting_date, hub_page_url, sos_turnout_url, sos_roster_url, statewide_voter_count, raw_record_count, deduped_voter_count, ok, message)
        OUTPUT INSERTED.id AS id
        VALUES (@evr_election_id, @voting_date, @hub_page_url, @sos_turnout_url, @sos_roster_url, @statewide_voter_count, 0, 0, 1, @message)
      `);
    pullId = Number(ins.recordset?.[0]?.id);
  }
  const voterCountyNames = [
    ...new Set(
      (votersWritable ?? []).map((v) => String(v.countyName ?? v.county ?? "").toUpperCase()).filter(Boolean),
    ),
  ];
  for (const name of voterCountyNames) {
    await pool
      .request()
      .input("evr_election_id", eid)
      .input("voting_date", vDate)
      .input("county_name", name)
      .query(`
        DELETE FROM dbo.ev_roster_voters
        WHERE evr_election_id = @evr_election_id
          AND COALESCE(reporting_date, voting_date) = @voting_date
          AND county_name = @county_name
      `);
  }
  const summaryCountyNames = [
    ...new Set(
      (countySummariesWritable ?? []).map((c) => String(c.countyName ?? "").toUpperCase()).filter(Boolean),
    ),
  ];
  for (const name of summaryCountyNames) {
    await pool
      .request()
      .input("pull_id", pullId)
      .input("county_name", name)
      .query(`DELETE FROM dbo.ev_roster_county_summary WHERE pull_id = @pull_id AND county_name = @county_name`);
  }
  for (const c of countySummariesWritable) {
    await pool
      .request()
      .input("pull_id", pullId)
      .input("county_name", String(c.countyName ?? ""))
      .input("county_id", c.countyId != null ? Number(c.countyId) : null)
      .input("registered_voters", Number(c.registeredVoters ?? 0))
      .input("in_person_votes_on_date", Number(c.inPersonVotesOnDate ?? 0))
      .input("total_in_person_votes_for_election", Number(c.totalInPersonVotesForElection ?? 0))
      .input("total_mail_votes_for_election", Number(c.totalMailVotesForElection ?? 0))
      .input("cumulative_total", Number(c.cumulativeTotal ?? 0))
      .input("sos_voter_count", Number(c.sosVoterCount ?? 0))
      .input("county_voter_count", Number(c.countyVoterCount ?? 0))
      .input("chosen_source", String(c.chosenSource ?? "county"))
      .input("chosen_voter_count", Number(c.chosenVoterCount ?? 0))
      .query(`
        INSERT INTO dbo.ev_roster_county_summary
          (pull_id, county_name, county_id, registered_voters, in_person_votes_on_date, total_in_person_votes_for_election,
           total_mail_votes_for_election, cumulative_total, sos_voter_count, county_voter_count, chosen_source, chosen_voter_count)
        VALUES (@pull_id, @county_name, @county_id, @registered_voters, @in_person_votes_on_date, @total_in_person_votes_for_election,
                @total_mail_votes_for_election, @cumulative_total, @sos_voter_count, @county_voter_count, @chosen_source, @chosen_voter_count)
      `);
  }
  for (const v of votersWritable) {
    const activityDate = resolveVoterActivityDate(v, vDate);
    await pool
      .request()
      .input("evr_election_id", eid)
      .input("voting_date", activityDate)
      .input("reporting_date", vDate)
      .input("county_name", String(v.countyName ?? v.county ?? ""))
      .input("vuid", String(v.vuid ?? ""))
      .input("voter_name", v.voterName != null ? String(v.voterName) : null)
      .input("voting_method", v.votingMethod != null ? String(v.votingMethod) : null)
      .input("method_code", v.methodCode != null ? String(v.methodCode) : null)
      .input("party", v.party != null ? String(v.party) : null)
      .input("precinct", v.precinct != null ? String(v.precinct) : null)
      .input("source", String(v.sourceKey ?? v.source ?? "county"))
      .query(`
        MERGE dbo.ev_roster_voters AS target
        USING (SELECT @evr_election_id AS evr_election_id, @voting_date AS voting_date, @vuid AS vuid) AS source
        ON target.evr_election_id = source.evr_election_id AND target.voting_date = source.voting_date
          AND target.county_name = @county_name AND target.vuid = source.vuid
        WHEN MATCHED THEN UPDATE SET
          voter_name = @voter_name, voting_method = @voting_method,
          method_code = @method_code, party = @party, precinct = @precinct, source = @source,
          reporting_date = @reporting_date
        WHEN NOT MATCHED THEN INSERT
          (evr_election_id, voting_date, reporting_date, county_name, vuid, voter_name, voting_method, method_code, party, precinct, source)
        VALUES (@evr_election_id, @voting_date, @reporting_date, @county_name, @vuid, @voter_name, @voting_method, @method_code, @party, @precinct, @source);
      `);
  }
  for (const log of countyPullLog ?? []) {
    await pool
      .request()
      .input("pull_id", pullId)
      .input("county_key", String(log.countyKey ?? ""))
      .input("county_name", String(log.countyName ?? ""))
      .input("handler_key", String(log.handlerKey ?? ""))
      .input("ok", log.ok === false ? 0 : 1)
      .input("voter_count", Number(log.voterCount ?? 0))
      .input("source_url", log.sourceUrl ?? null)
      .input("message", String(log.message ?? "").slice(0, 2000))
      .query(`
        INSERT INTO dbo.ev_roster_county_pull_log
          (pull_id, county_key, county_name, handler_key, ok, voter_count, source_url, message)
        VALUES (@pull_id, @county_key, @county_name, @handler_key, @ok, @voter_count, @source_url, @message)
      `);
  }
  await dedupeEvRosterVotersKeepOldestDate(eid);

  const countR = await pool
    .request()
    .input("evr_election_id", eid)
    .input("voting_date", vDate)
    .query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
  const totalVoters = Number(countR.recordset?.[0]?.n ?? 0);
  await pool
    .request()
    .input("id", pullId)
    .input("raw_record_count", Number(rawRecordCount ?? 0))
    .input("deduped_voter_count", totalVoters)
    .input("message", String(message ?? "").slice(0, 4000))
    .input("ok", ok === false ? 0 : 1)
    .query(`
      UPDATE dbo.ev_roster_pulls SET
        raw_record_count = COALESCE(raw_record_count, 0) + @raw_record_count,
        deduped_voter_count = @deduped_voter_count,
        message = @message,
        pulled_at = SYSUTCDATETIME(),
        ok = @ok
      WHERE id = @id
    `);
  return getEvRosterPullPayload(eid, vDate);
}

export async function listEvRosterVoters(evrElectionId, votingDate, options = {}) {
  const { normalizeVoterCountyFilter } = await import("./lib/evRosterVoters.mjs");
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 5000);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const countyList = normalizeVoterCountyFilter(options.counties, options.county);
  const q = options.q ? String(options.q).trim() : "";

  let where = `WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`;
  const req = pool.request().input("evr_election_id", eid).input("voting_date", vDate);
  countyList.forEach((name, i) => {
    req.input(`county_${i}`, name);
  });
  if (countyList.length) {
    where += ` AND county_name IN (${countyList.map((_, i) => `@county_${i}`).join(", ")})`;
  }
  if (q) {
    where += ` AND (vuid LIKE @q OR county_name LIKE @q OR party LIKE @q)`;
    req.input("q", `%${q}%`);
  }
  const countR = await req.query(`SELECT COUNT(*) AS n FROM dbo.ev_roster_voters ${where}`);
  const total = Number(countR.recordset?.[0]?.n ?? 0);
  const dataReq = pool
    .request()
    .input("evr_election_id", eid)
    .input("voting_date", vDate)
    .input("limit", limit)
    .input("offset", offset);
  countyList.forEach((name, i) => {
    dataReq.input(`county_${i}`, name);
  });
  if (q) dataReq.input("q", `%${q}%`);
  const dataR = await dataReq.query(`
      SELECT vuid, party, voting_date AS votingDate, county_name AS countyName,
             COALESCE(method_code, N'EV') AS methodCode
      FROM dbo.ev_roster_voters
      ${where}
      ORDER BY county_name, vuid
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);
  return {
    total,
    limit,
    offset,
    rows: (dataR.recordset ?? []).map((row) => ({
      vuid: String(row.vuid ?? ""),
      party: String(row.party ?? ""),
      votingDate: String(row.votingDate ?? ""),
      countyName: String(row.countyName ?? ""),
      methodCode: String(row.methodCode ?? "EV"),
    })),
  };
}

export async function listEvRosterPullDates(evrElectionId) {
  return listEvRosterPullDatesForElections([Number(evrElectionId)]);
}

export async function listEvRosterPullDatesForElections(evrElectionIds) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT voting_date AS votingDate, MAX(pulled_at) AS pulledAt,
           SUM(statewide_voter_count) AS statewideVoterCount, MIN(CAST(ok AS INT)) AS okMin,
           MAX(message) AS message
    FROM dbo.ev_roster_pulls
    WHERE evr_election_id IN (${ids.join(", ")})
    GROUP BY voting_date ORDER BY voting_date DESC
  `);
  return (r.recordset ?? []).map((row) => ({
    votingDate: String(row.votingDate ?? ""),
    pulledAt: row.pulledAt instanceof Date ? row.pulledAt.toISOString() : String(row.pulledAt ?? ""),
    statewideVoterCount: Number(row.statewideVoterCount ?? 0),
    ok: row.okMin == null ? true : !!row.okMin,
    message: String(row.message ?? ""),
  }));
}

export async function listEvRosterVoterDatesForElections(evrElectionIds) {
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const pool = await ensureDb();
  const r = await pool.request().query(`
    SELECT voting_date AS votingDate, COUNT(DISTINCT vuid) AS voterCount
    FROM dbo.ev_roster_voters
    WHERE evr_election_id IN (${ids.join(", ")})
    GROUP BY voting_date ORDER BY voting_date DESC
  `);
  return (r.recordset ?? []).map((row) => ({
    votingDate: String(row.votingDate ?? ""),
    pulledAt: "",
    statewideVoterCount: Number(row.voterCount ?? 0),
    ok: true,
    message: "",
  }));
}

export async function getEvRosterAggregatedSummary(evrElectionIds, dateFrom, dateTo) {
  const { countiesFromVoterActivityInRange, computeSummaryTotals } = await import(
    "./lib/evRosterAggregateSummary.mjs"
  );
  const ids = [...new Set((evrElectionIds ?? []).map(Number).filter(Boolean))];
  const from = String(dateFrom ?? "").trim();
  const to = String(dateTo ?? "").trim();
  if (!ids.length || !from || !to) {
    return { pull: null, counties: [], dateFrom: from, dateTo: to, countyPullLog: [] };
  }

  const pool = await ensureDb();
  const idList = ids.join(", ");

  const {
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statewideDistinct,
    storedVoterCount,
  } = await loadSummaryRollupsFromCache(ids, from, to, { pool });

  const statusR = await pool.request().query(`
    SELECT county_name AS countyName, voting_date AS votingDate, last_pull_ok AS lastPullOk,
           last_pull_at AS lastPullAt, last_pull_message AS lastPullMessage, voter_count AS voterCount,
           confirmed_at AS confirmedAt
    FROM dbo.ev_roster_county_pull_status
    WHERE evr_election_id IN (${idList})
  `);
  const statusByCounty = new Map();
  for (const s of statusR.recordset ?? []) {
    const county = String(s.countyName ?? "").toUpperCase();
    const vDate = String(s.votingDate ?? "");
    const prev = statusByCounty.get(county);
    if (!prev || vDate >= String(prev.votingDate ?? "")) {
      statusByCounty.set(county, {
        votingDate: vDate,
        lastPullOk: s.lastPullOk == null ? null : !!s.lastPullOk,
        lastPullAt: s.lastPullAt instanceof Date ? s.lastPullAt.toISOString() : s.lastPullAt ? String(s.lastPullAt) : null,
        lastPullMessage: s.lastPullMessage != null ? String(s.lastPullMessage) : null,
        voterCount: Number(s.voterCount ?? 0),
        confirmedAt: s.confirmedAt instanceof Date ? s.confirmedAt.toISOString() : s.confirmedAt ? String(s.confirmedAt) : null,
      });
    }
  }

  const counties = countiesFromVoterActivityInRange({
    rosterByCounty,
    methodByCounty,
    evInPersonDayByCounty,
    registeredByCounty,
    statusByCounty,
  });

  const summaryTotals = computeSummaryTotals(
    { registeredByCounty, evInPersonDayByCounty },
    0,
    statewideDistinct,
  );
  summaryTotals.cumulativeTotal = storedVoterCount || summaryTotals.cumulativeTotal;
  summaryTotals.chosenVoterCount = storedVoterCount;

  const pullAggR = await pool.request().query(`
    SELECT MAX(pulled_at) AS pulledAt, MIN(CAST(ok AS INT)) AS okMin FROM dbo.ev_roster_pulls WHERE evr_election_id IN (${idList})
  `);
  const pullAgg = pullAggR.recordset?.[0] ?? {};

  return {
    dateFrom: from,
    dateTo: to,
    pull: {
      evrElectionIds: ids,
      votingDate: `${from}..${to}`,
      pulledAt: pullAgg.pulledAt instanceof Date ? pullAgg.pulledAt.toISOString() : String(pullAgg.pulledAt ?? ""),
      ok: pullAgg.okMin == null ? true : !!pullAgg.okMin,
      storedVoterCount,
      dedupedVoterCount: storedVoterCount,
      message: `Voter activity ${from} through ${to}`,
    },
    counties,
    countyPullLog: [],
    summaryTotals,
  };
}

export async function getEvRosterPullPayload(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const eid = Number(evrElectionId);
  const vDate = String(votingDate ?? "").trim();
  const pullR = await pool
    .request()
    .input("evr_election_id", eid)
    .input("voting_date", vDate)
    .query(`
      SELECT TOP 1 id, evr_election_id AS evrElectionId, voting_date AS votingDate, hub_page_url AS hubPageUrl,
             sos_turnout_url AS sosTurnoutUrl, sos_roster_url AS sosRosterUrl, statewide_voter_count AS statewideVoterCount,
             raw_record_count AS rawRecordCount, deduped_voter_count AS dedupedVoterCount,
             pulled_at AS pulledAt, ok, message
      FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date
    `);
  const pullRow = pullR.recordset?.[0];
  if (!pullRow) return null;
  const pullId = Number(pullRow.id);
  const countyR = await pool.request().input("pull_id", pullId).query(`
    SELECT county_name AS countyName, county_id AS countyId, registered_voters AS registeredVoters,
           in_person_votes_on_date AS inPersonVotesOnDate, total_in_person_votes_for_election AS totalInPersonVotesForElection,
           total_mail_votes_for_election AS totalMailVotesForElection, cumulative_total AS cumulativeTotal,
           sos_voter_count AS sosVoterCount, county_voter_count AS countyVoterCount,
           chosen_source AS chosenSource, chosen_voter_count AS chosenVoterCount
    FROM dbo.ev_roster_county_summary WHERE pull_id = @pull_id ORDER BY county_name
  `);
  const countR = await pool
    .request()
    .input("evr_election_id", eid)
    .input("voting_date", vDate)
    .query(
      `SELECT COUNT(*) AS n FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`,
    );
  const storedVoterCount = Number(countR.recordset?.[0]?.n ?? 0);
  const pullStatuses = await listEvRosterCountyPullStatuses(eid, vDate);
  const statusByCounty = new Map(pullStatuses.map((s) => [String(s.countyName).toUpperCase(), s]));
  return {
    pull: {
      evrElectionId: eid,
      votingDate: String(pullRow.votingDate ?? ""),
      hubPageUrl: pullRow.hubPageUrl ? String(pullRow.hubPageUrl) : null,
      sosTurnoutUrl: pullRow.sosTurnoutUrl ? String(pullRow.sosTurnoutUrl) : null,
      sosRosterUrl: pullRow.sosRosterUrl ? String(pullRow.sosRosterUrl) : null,
      statewideVoterCount: Number(pullRow.statewideVoterCount ?? 0),
      rawRecordCount: Number(pullRow.rawRecordCount ?? 0),
      dedupedVoterCount: Number(pullRow.dedupedVoterCount ?? 0),
      pulledAt: pullRow.pulledAt instanceof Date ? pullRow.pulledAt.toISOString() : String(pullRow.pulledAt ?? ""),
      ok: !!pullRow.ok,
      message: String(pullRow.message ?? ""),
      storedVoterCount,
    },
    counties: (countyR.recordset ?? []).map((r) => {
      const countyName = String(r.countyName ?? "");
      const st = statusByCounty.get(countyName.toUpperCase());
      return {
        countyName,
        countyId: r.countyId != null ? Number(r.countyId) : null,
        registeredVoters: Number(r.registeredVoters ?? 0),
        inPersonVotesOnDate: Number(r.inPersonVotesOnDate ?? 0),
        totalInPersonVotesForElection: Number(r.totalInPersonVotesForElection ?? 0),
        totalMailVotesForElection: Number(r.totalMailVotesForElection ?? 0),
        cumulativeTotal: Number(r.cumulativeTotal ?? 0),
        sosVoterCount: Number(r.sosVoterCount ?? 0),
        countyVoterCount: Number(r.countyVoterCount ?? 0),
        chosenSource: String(r.chosenSource ?? "sos"),
        chosenVoterCount: Number(r.chosenVoterCount ?? 0),
        pullStatus: st
          ? {
              lastPullOk: st.lastPullOk,
              lastPullAt: st.lastPullAt,
              lastPullMessage: st.lastPullMessage,
              voterCount: st.voterCount,
              confirmedAt: st.confirmedAt,
            }
          : null,
      };
    }),
    countyPullLog: await getEvRosterCountyPullLog(eid, vDate),
  };
}

export async function listEvRosterCountySources(evrElectionId) {
  const pool = await ensureDb();
  const r = await pool.request().input("evr_election_id", Number(evrElectionId)).query(`
    SELECT id, evr_election_id AS evrElectionId, county_key AS countyKey, variant_key AS variantKey,
           source_label AS sourceLabel, civix_county_name AS civixCountyName, civix_county_id AS civixCountyId,
           handler_key AS handlerKey, hub_page_url AS hubPageUrl, roster_url AS rosterUrl,
           voting_method_scope AS votingMethodScope, date_scope AS dateScope, file_format AS fileFormat,
           roster_party_scope AS rosterPartyScope,
           discovery_profile_key AS discoveryProfileKey, training_notes AS trainingNotes, is_enabled AS isEnabled,
           last_pull_ok AS lastPullOk, last_pull_message AS lastPullMessage, last_pull_at AS lastPullAt
    FROM dbo.ev_roster_county_sources WHERE evr_election_id = @evr_election_id ORDER BY civix_county_name, variant_key
  `);
  return (r.recordset ?? []).map((row) => ({
    id: Number(row.id),
    evrElectionId: Number(row.evrElectionId),
    countyKey: String(row.countyKey ?? ""),
    variantKey: String(row.variantKey ?? "sos-default"),
    sourceLabel: String(row.sourceLabel ?? ""),
    civixCountyName: String(row.civixCountyName ?? ""),
    civixCountyId: row.civixCountyId != null ? Number(row.civixCountyId) : null,
    handlerKey: String(row.handlerKey ?? "civix_sos_county_slice"),
    hubPageUrl: String(row.hubPageUrl ?? ""),
    rosterUrl: String(row.rosterUrl ?? ""),
    votingMethodScope: String(row.votingMethodScope ?? "ALL"),
    dateScope: String(row.dateScope ?? "SINGLE_DAY"),
    fileFormat: String(row.fileFormat ?? "auto"),
    rosterPartyScope: String(row.rosterPartyScope ?? "COMBINED"),
    discoveryProfileKey: row.discoveryProfileKey != null ? String(row.discoveryProfileKey) : null,
    trainingNotes: row.trainingNotes != null ? String(row.trainingNotes) : null,
    isEnabled: !!row.isEnabled,
    lastPullOk: row.lastPullOk == null ? null : !!row.lastPullOk,
    lastPullMessage: row.lastPullMessage != null ? String(row.lastPullMessage) : null,
    lastPullAt: row.lastPullAt instanceof Date ? row.lastPullAt.toISOString() : row.lastPullAt ? String(row.lastPullAt) : null,
  }));
}

export async function upsertEvRosterCountySource(row) {
  const pool = await ensureDb();
  const variantKey = String(row.variantKey ?? "custom").slice(0, 64);
  if (row.id != null) {
    await pool
      .request()
      .input("id", Number(row.id))
      .input("source_label", String(row.sourceLabel ?? ""))
      .input("civix_county_name", String(row.civixCountyName ?? ""))
      .input("civix_county_id", row.civixCountyId != null ? Number(row.civixCountyId) : null)
      .input("handler_key", String(row.handlerKey ?? "generic_file_url"))
      .input("hub_page_url", String(row.hubPageUrl ?? ""))
      .input("roster_url", String(row.rosterUrl ?? ""))
      .input("voting_method_scope", String(row.votingMethodScope ?? "ALL"))
      .input("date_scope", String(row.dateScope ?? "SINGLE_DAY"))
      .input("file_format", String(row.fileFormat ?? "auto"))
      .input("roster_party_scope", String(row.rosterPartyScope ?? "COMBINED"))
      .input("discovery_profile_key", row.discoveryProfileKey != null ? String(row.discoveryProfileKey) : null)
      .input("training_notes", row.trainingNotes != null ? String(row.trainingNotes) : null)
      .input("is_enabled", row.isEnabled === false ? 0 : 1)
      .query(`
        UPDATE dbo.ev_roster_county_sources SET
          source_label = @source_label, civix_county_name = @civix_county_name,
          civix_county_id = COALESCE(@civix_county_id, civix_county_id),
          handler_key = @handler_key, hub_page_url = @hub_page_url, roster_url = @roster_url,
          voting_method_scope = @voting_method_scope, date_scope = @date_scope, file_format = @file_format,
          roster_party_scope = @roster_party_scope,
          discovery_profile_key = @discovery_profile_key, training_notes = @training_notes, is_enabled = @is_enabled,
          updated_at = SYSUTCDATETIME()
        WHERE id = @id
      `);
    return;
  }
  await pool
    .request()
    .input("evr_election_id", Number(row.evrElectionId))
    .input("county_key", String(row.countyKey ?? ""))
    .input("variant_key", variantKey)
    .input("source_label", String(row.sourceLabel ?? ""))
    .input("civix_county_name", String(row.civixCountyName ?? ""))
    .input("civix_county_id", row.civixCountyId != null ? Number(row.civixCountyId) : null)
    .input("handler_key", String(row.handlerKey ?? "generic_file_url"))
    .input("hub_page_url", String(row.hubPageUrl ?? ""))
    .input("roster_url", String(row.rosterUrl ?? ""))
    .input("voting_method_scope", String(row.votingMethodScope ?? "ALL"))
    .input("date_scope", String(row.dateScope ?? "SINGLE_DAY"))
    .input("file_format", String(row.fileFormat ?? "auto"))
    .input("roster_party_scope", String(row.rosterPartyScope ?? "COMBINED"))
    .input("discovery_profile_key", row.discoveryProfileKey != null ? String(row.discoveryProfileKey) : null)
    .input("training_notes", row.trainingNotes != null ? String(row.trainingNotes) : null)
    .input("is_enabled", row.isEnabled === false ? 0 : 1)
    .query(`
      MERGE dbo.ev_roster_county_sources AS target
      USING (SELECT @evr_election_id AS evr_election_id, @county_key AS county_key, @variant_key AS variant_key) AS source
      ON target.evr_election_id = source.evr_election_id AND target.county_key = source.county_key
        AND target.variant_key = source.variant_key
      WHEN MATCHED THEN UPDATE SET
        source_label = @source_label, civix_county_name = @civix_county_name,
        civix_county_id = COALESCE(@civix_county_id, target.civix_county_id),
        handler_key = @handler_key, hub_page_url = @hub_page_url, roster_url = @roster_url,
        voting_method_scope = @voting_method_scope, date_scope = @date_scope, file_format = @file_format,
        roster_party_scope = @roster_party_scope,
        discovery_profile_key = @discovery_profile_key, training_notes = @training_notes, is_enabled = @is_enabled,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (evr_election_id, county_key, variant_key, source_label, civix_county_name, civix_county_id, handler_key,
         hub_page_url, roster_url, voting_method_scope, date_scope, file_format, roster_party_scope,
         discovery_profile_key, training_notes, is_enabled)
      VALUES (@evr_election_id, @county_key, @variant_key, @source_label, @civix_county_name, @civix_county_id, @handler_key,
              @hub_page_url, @roster_url, @voting_method_scope, @date_scope, @file_format, @roster_party_scope,
              @discovery_profile_key, @training_notes, @is_enabled);
    `);
}

export async function syncEvRosterCountySourcesFromTurnout(evrElectionId, counties) {
  const { civixCountyNameToKey } = await import("./lib/texasCountyKeys.mjs");
  for (const c of counties ?? []) {
    const name = String(c.name ?? c.countyName ?? "").toUpperCase();
    if (!name || name === "TOTAL") continue;
    await upsertEvRosterCountySource({
      evrElectionId,
      countyKey: civixCountyNameToKey(name),
      variantKey: "sos-default",
      sourceLabel: "SOS default",
      civixCountyName: name,
      civixCountyId: c.id ?? c.countyId ?? null,
      handlerKey: "civix_sos_county_slice",
      hubPageUrl: "",
      rosterUrl: "",
      votingMethodScope: "ALL",
      dateScope: "SINGLE_DAY",
      fileFormat: "auto",
      isEnabled: true,
    });
  }
  return listEvRosterCountySources(evrElectionId);
}

export async function getEvRosterExportRows(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const r = await pool
    .request()
    .input("evr_election_id", Number(evrElectionId))
    .input("voting_date", String(votingDate ?? "").trim())
    .query(`
      SELECT vuid, party, voting_date AS votingDate, county_name AS countyName, COALESCE(method_code, N'EV') AS methodCode
      FROM dbo.ev_roster_voters WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date
      ORDER BY county_name, vuid
    `);
  return (r.recordset ?? []).map((row) => ({
    vuid: String(row.vuid ?? ""),
    party: String(row.party ?? ""),
    votingDate: String(row.votingDate ?? ""),
    countyName: String(row.countyName ?? ""),
    methodCode: String(row.methodCode ?? "EV"),
  }));
}

export async function getEvRosterCountyPullLog(evrElectionId, votingDate) {
  const pool = await ensureDb();
  const pullR = await pool
    .request()
    .input("evr_election_id", Number(evrElectionId))
    .input("voting_date", String(votingDate ?? "").trim())
    .query(`SELECT TOP 1 id FROM dbo.ev_roster_pulls WHERE evr_election_id = @evr_election_id AND voting_date = @voting_date`);
  const pullId = pullR.recordset?.[0]?.id;
  if (pullId == null) return [];
  const r = await pool.request().input("pull_id", Number(pullId)).query(`
    SELECT county_key AS countyKey, county_name AS countyName, handler_key AS handlerKey, ok,
           voter_count AS voterCount, source_url AS sourceUrl, message
    FROM dbo.ev_roster_county_pull_log WHERE pull_id = @pull_id ORDER BY county_name
  `);
  return (r.recordset ?? []).map((row) => ({
    countyKey: String(row.countyKey ?? ""),
    countyName: String(row.countyName ?? ""),
    handlerKey: String(row.handlerKey ?? ""),
    ok: !!row.ok,
    voterCount: Number(row.voterCount ?? 0),
    sourceUrl: row.sourceUrl != null ? String(row.sourceUrl) : null,
    message: String(row.message ?? ""),
  }));
}
