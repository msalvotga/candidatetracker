import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const sqlitePath = process.argv[2] ?? "data/candidates.db";
if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite file not found: ${sqlitePath}`);
const db = new DatabaseSync(sqlitePath, { readOnly: true });
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined,
});

const sqliteSd = db
  .prepare(
    `SELECT office_code, seat_holder_name FROM offices WHERE category = 'senate' AND TRIM(COALESCE(seat_holder_name,'')) != '' ORDER BY district`,
  )
  .all();
const pgSd = (
  await pool.query(
    `SELECT office_code, seat_holder_name FROM offices WHERE category = 'senate' AND TRIM(COALESCE(seat_holder_name,'')) != '' ORDER BY district`,
  )
).rows;

console.log("SD holders SQLite:", sqliteSd.length, "Postgres:", pgSd.length);
console.log("Sample PG SD:", pgSd.slice(0, 5));

const holders = (
  await pool.query(
    `SELECT COUNT(*)::int AS n FROM offices WHERE seat_holder_name IS NOT NULL AND TRIM(seat_holder_name) != ''`,
  )
).rows[0].n;
const consultants = (await pool.query(`SELECT COUNT(*)::int AS n FROM candidate_consultants`)).rows[0].n;
console.log("Total office seat holders on PG:", holders);
console.log("candidate_consultants on PG:", consultants);

db.close();
await pool.end();
