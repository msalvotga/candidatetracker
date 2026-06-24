import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { bindSql } from "./sql.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "schema-postgres.sql");

let pool;
let dbWrapper;

function createStatement(client, sql) {
  return {
    async get(...args) {
      const { sql: pgSql, values } = bindSql(sql, args);
      const result = await client.query(pgSql, values);
      return result.rows[0];
    },
    async all(...args) {
      const { sql: pgSql, values } = bindSql(sql, args);
      const result = await client.query(pgSql, values);
      return result.rows;
    },
    async run(...args) {
      const { sql: pgSql, values } = bindSql(sql, args);
      const result = await client.query(pgSql, values);
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: result.rows[0]?.id ?? null,
      };
    },
  };
}

function createDb(client, { pool: sharedPool } = {}) {
  let activeClient = client;

  const db = {
    prepare(sql) {
      return createStatement(activeClient, sql);
    },
    async exec(sql) {
      await activeClient.query(sql);
    },
    async query(sql, values = []) {
      return activeClient.query(sql, values);
    },
    transaction(fn) {
      return async (...args) => {
        const txClient = await sharedPool.connect();
        const prev = activeClient;
        activeClient = txClient;
        try {
          await txClient.query("BEGIN");
          const result = await fn(...args);
          await txClient.query("COMMIT");
          return result;
        } catch (err) {
          await txClient.query("ROLLBACK");
          throw err;
        } finally {
          activeClient = prev;
          txClient.release();
        }
      };
    },
  };

  return db;
}

export function getDatabaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required (PostgreSQL connection string)");
  }
  return url;
}

export async function initDb() {
  if (pool) return getDb();

  pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  dbWrapper = createDb(pool, { pool });
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
  await runMigrations(pool);
  return dbWrapper;
}

async function runMigrations(pool) {
  await pool.query(`
    ALTER TABLE offices
    ADD COLUMN IF NOT EXISTS up_for_reelection INTEGER NOT NULL DEFAULT 0
    CHECK (up_for_reelection IN (0, 1))
  `);
}

export function getDb() {
  if (!dbWrapper) {
    throw new Error("Database not initialized — call initDb() before getDb()");
  }
  return dbWrapper;
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = undefined;
    dbWrapper = undefined;
  }
}
