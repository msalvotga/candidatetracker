import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { ensureDb } from "../db.mjs";
import { getNativePool } from "../lib/pgPool.mjs";
import {
  cleanCountyHistoricalText,
  isCountyHistoricalRegisteredVoters,
  isCountyHistoricalTotalVotes,
  normalizeCountyHistoricalDimensionKey,
  normalizeCountyHistoricalKey,
} from "../lib/countyHistoricalResults.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");
const defaultCsvPath = path.join(root, "County Historical Results Master File.csv");
const csvPath = path.resolve(process.cwd(), process.argv[2] || defaultCsvPath);

function parseInteger(value) {
  const normalized = String(value ?? "")
    .replace(/,/g, "")
    .replace(/"/g, "")
    .trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toRows(records) {
  return records
    .map((record, index) => {
      const countyName = cleanCountyHistoricalText(record.County);
      const officeName = cleanCountyHistoricalText(record.Office);
      const electionType = cleanCountyHistoricalText(record["Election Type"]);
      const candidateName = cleanCountyHistoricalText(record.Candidate);
      const partyName = cleanCountyHistoricalText(record.Party) || null;
      const year = parseInteger(record.Year);
      const votes = parseInteger(record.Votes);

      if (!countyName || !electionType || !candidateName || !year) return null;

      return {
        county_name: countyName,
        county_key: normalizeCountyHistoricalKey(countyName),
        year,
        office_name: officeName,
        office_key: normalizeCountyHistoricalDimensionKey(officeName),
        election_type: electionType,
        election_type_key: normalizeCountyHistoricalDimensionKey(electionType),
        candidate_name: candidateName,
        party_name: partyName,
        party_key: normalizeCountyHistoricalDimensionKey(partyName),
        votes,
        is_total_votes: isCountyHistoricalTotalVotes(candidateName) ? 1 : 0,
        is_registered_voters: isCountyHistoricalRegisteredVoters(candidateName) ? 1 : 0,
        sort_order: index + 1,
      };
    })
    .filter(Boolean);
}

function buildInsert(rows) {
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const base = rowIndex * 14;
    values.push(
      row.county_name,
      row.county_key,
      row.year,
      row.office_name,
      row.office_key,
      row.election_type,
      row.election_type_key,
      row.candidate_name,
      row.party_name,
      row.party_key,
      row.votes,
      row.is_total_votes,
      row.is_registered_voters,
      row.sort_order,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`;
  });

  return {
    sql: `
      INSERT INTO county_historical_results (
        county_name,
        county_key,
        year,
        office_name,
        office_key,
        election_type,
        election_type_key,
        candidate_name,
        party_name,
        party_key,
        votes,
        is_total_votes,
        is_registered_voters,
        sort_order
      )
      VALUES ${placeholders.join(", ")}
    `,
    values,
  };
}

async function main() {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const csvText = fs.readFileSync(csvPath, "utf8");
  const records = parse(csvText, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const rows = toRows(records);
  if (!rows.length) {
    throw new Error("No county historical rows were parsed from the CSV.");
  }

  await ensureDb();
  const pool = getNativePool();
  if (!pool) throw new Error("PostgreSQL pool is not initialized.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE county_historical_results RESTART IDENTITY");

    const chunkSize = 1000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const insert = buildInsert(chunk);
      await client.query(insert.sql, insert.values);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const distinctCounties = new Set(rows.map((row) => row.county_key)).size;
  console.log(`Imported ${rows.length.toLocaleString()} county historical rows for ${distinctCounties.toLocaleString()} counties from ${csvPath}`);
}

await main();
