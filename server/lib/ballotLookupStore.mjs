import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getNativePool } from "./pgPool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOOKUP_CSV_PATH = path.join(HERE, "../data/ballot-score-ev/lookup.csv");
export const LOOKUP_CHUNK_BYTES = 1024 * 1024;

let tableReady = null;

async function database() {
  const pool = getNativePool();
  if (!pool) return null;
  if (!tableReady) {
    tableReady = pool.query(
      `CREATE TABLE IF NOT EXISTS ballot_lookup_chunks (
         chunk_no INTEGER PRIMARY KEY,
         bytes BYTEA NOT NULL
       )`,
    );
  }
  await tableReady;
  return pool;
}

async function fileReady() {
  try {
    await access(LOOKUP_CSV_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function lookupStoredInDatabase() {
  const pool = await database();
  if (!pool) return false;
  const found = await pool.query(`SELECT 1 FROM ballot_lookup_chunks LIMIT 1`);
  return found.rowCount > 0;
}

async function* lookupChunks() {
  const pool = await database();
  if (!pool) throw new Error("The voter lookup is not in the database.");
  const count = await pool.query(`SELECT count(*)::int AS n FROM ballot_lookup_chunks`);
  const total = count.rows[0]?.n ?? 0;
  for (let index = 0; index < total; index += 1) {
    const row = await pool.query(`SELECT bytes FROM ballot_lookup_chunks WHERE chunk_no = $1`, [index]);
    if (!row.rows[0]) break;
    yield row.rows[0].bytes;
  }
}

/** Local lookup.csv when it is on disk. Otherwise the copy stored in Postgres. */
export async function openLookupCsvStream() {
  if (await fileReady()) return createReadStream(LOOKUP_CSV_PATH);
  return Readable.from(lookupChunks());
}

export async function openCsvStream(filePath) {
  if (path.resolve(String(filePath ?? "")) === path.resolve(LOOKUP_CSV_PATH)) return openLookupCsvStream();
  return createReadStream(filePath);
}
