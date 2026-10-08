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
           payload_text TEXT,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
         )`,
      )
      .then(() => pool.query(`ALTER TABLE county_roster_documents ADD COLUMN IF NOT EXISTS payload_text TEXT`))
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

/** Above this size, store the document as text. Postgres uses several times more memory to build one large JSONB value. */
export const ROSTER_DOCUMENT_TEXT_BYTES = 256 * 1024;

export function rosterDocumentBody(payload) {
  const text = JSON.stringify(payload ?? null);
  return { text, asText: text.length > ROSTER_DOCUMENT_TEXT_BYTES };
}

/** Saved roster document, or undefined when this process has no database yet. */
export async function readRosterDocument(key) {
  try {
    const pool = await database();
    if (!pool) return undefined;
    const found = await pool.query(
      `SELECT payload_text, payload FROM county_roster_documents WHERE doc_key = $1`,
      [key],
    );
    if (!found.rows.length) return undefined;
    const row = found.rows[0];
    if (row.payload_text) return JSON.parse(row.payload_text);
    return row.payload;
  } catch (error) {
    console.error("Roster document read", rosterDbMessage(error));
    return undefined;
  }
}

export async function writeRosterDocument(key, payload) {
  try {
    const pool = await database();
    if (!pool) return false;
    const body = rosterDocumentBody(payload);
    if (body.asText) {
      await pool.query(
        `INSERT INTO county_roster_documents (doc_key, payload, payload_text, updated_at)
         VALUES ($1, '{}'::jsonb, $2, NOW() AT TIME ZONE 'UTC')
         ON CONFLICT (doc_key) DO UPDATE
           SET payload = '{}'::jsonb,
               payload_text = EXCLUDED.payload_text,
               updated_at = NOW() AT TIME ZONE 'UTC'`,
        [key, body.text],
      );
    } else {
      await pool.query(
        `INSERT INTO county_roster_documents (doc_key, payload, payload_text, updated_at)
         VALUES ($1, $2::jsonb, NULL, NOW() AT TIME ZONE 'UTC')
         ON CONFLICT (doc_key) DO UPDATE
           SET payload = EXCLUDED.payload,
               payload_text = NULL,
               updated_at = NOW() AT TIME ZONE 'UTC'`,
        [key, body.text],
      );
    }
    return true;
  } catch (error) {
    console.error("Roster document write", rosterDbMessage(error));
    return false;
  }
}
