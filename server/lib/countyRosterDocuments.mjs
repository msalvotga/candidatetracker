import { getNativePool } from "./pgPool.mjs";

let tableReady = null;

async function database() {
  const pool = getNativePool();
  if (!pool) return null;
  if (!tableReady) {
    tableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS county_roster_documents (
           doc_key TEXT PRIMARY KEY,
           payload JSONB NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
         )`,
      )
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  try {
    await tableReady;
  } catch (error) {
    tableReady = null;
    throw error;
  }
  return pool;
}

function rosterDbMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Saved roster document, or undefined when this process has no database yet. */
export async function readRosterDocument(key) {
  try {
    const pool = await database();
    if (!pool) return undefined;
    const found = await pool.query(`SELECT payload FROM county_roster_documents WHERE doc_key = $1`, [key]);
    if (!found.rows.length) return undefined;
    return found.rows[0].payload;
  } catch (error) {
    console.error("Roster document read", rosterDbMessage(error));
    return undefined;
  }
}

export async function writeRosterDocument(key, payload) {
  try {
    const pool = await database();
    if (!pool) return false;
    await pool.query(
      `INSERT INTO county_roster_documents (doc_key, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW() AT TIME ZONE 'UTC')
       ON CONFLICT (doc_key) DO UPDATE
         SET payload = EXCLUDED.payload,
             updated_at = NOW() AT TIME ZONE 'UTC'`,
      [key, JSON.stringify(payload)],
    );
    return true;
  } catch (error) {
    console.error("Roster document write", rosterDbMessage(error));
    return false;
  }
}
