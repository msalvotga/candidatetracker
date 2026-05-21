import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {pg.Pool | null} */
let _nativePool = null;

export function getDatabaseUrl() {
  const url = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
  if (!url) {
    throw new Error("DATABASE_URL is required (PostgreSQL connection string).");
  }
  return url;
}

/**
 * Normalize T-SQL-ish queries from the legacy MSSQL module for PostgreSQL.
 * @param {string} text
 */
export function normalizeSql(text) {
  let s = String(text ?? "");
  s = s.replace(/\bdbo\./gi, "");
  s = s.replace(/\bN'/g, "'");
  s = s.replace(/\bSYSUTCDATETIME\(\)/gi, "(NOW() AT TIME ZONE 'UTC')");
  s = s.replace(/\bGETUTCDATE\(\)/gi, "(NOW() AT TIME ZONE 'UTC')");
  s = s.replace(/\bSELECT\s+TOP\s+(\d+)\s+/gi, "SELECT ");
  s = s.replace(/\bTOP\s+(\d+)\b/gi, (_, n) => `LIMIT ${n}`);
  s = s.replace(
    /(INSERT\s+INTO\s+[\w.]+\s*\([\s\S]*?\))\s*OUTPUT\s+INSERTED\.(\w+)\s+AS\s+(\w+)\s*(VALUES[\s\S]*?)(;|$)/gi,
    "$1 $4 RETURNING $2 AS $3$5",
  );
  return s;
}

/**
 * @param {pg.Pool} pool
 * @param {string} text
 * @param {Record<string, unknown>} params
 */
function bindParams(text, params) {
  const values = [];
  let n = 0;
  const pgText = normalizeSql(text).replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter @${name}`);
    values.push(params[name]);
    return `$${++n}`;
  });
  return { pgText, values };
}

/**
 * @param {pg.Pool | pg.PoolClient} executor
 * @param {string} text
 * @param {Record<string, unknown>} params
 */
export async function pgQuery(executor, text, params = {}) {
  const { pgText, values } = bindParams(text, params);
  const result = await executor.query(pgText, values);
  return { rows: result.rows, recordset: result.rows, rowCount: result.rowCount };
}

class PgRequest {
  /** @param {pg.Pool} pool */
  constructor(pool) {
    this.pool = pool;
    /** @type {Record<string, unknown>} */
    this.params = {};
  }

  /**
   * @param {string} name
   * @param {unknown} typeOrValue
   * @param {unknown} [maybeValue]
   */
  input(name, typeOrValue, maybeValue) {
    this.params[name] = maybeValue !== undefined ? maybeValue : typeOrValue;
    return this;
  }

  /** @param {string} text */
  async query(text) {
    return pgQuery(this.pool, text, this.params);
  }

  /** @param {string} text */
  async batch(text) {
    const statements = normalizeSql(text)
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    let last = { rows: [], recordset: [] };
    for (const stmt of statements) {
      last = await this.query(stmt);
    }
    return last;
  }
}

class PgRequestClient extends PgRequest {
  /** @param {pg.PoolClient} client */
  constructor(client) {
    super(null);
    this.client = client;
  }

  /** @param {string} text */
  async query(text) {
    return pgQuery(this.client, text, this.params);
  }
}

export class PgTransaction {
  /** @param {ReturnType<typeof createCompatPool>} _compatPool */
  constructor(_compatPool) {
    /** @type {pg.PoolClient | null} */
    this.client = null;
  }

  async begin() {
    const pool = getNativePool();
    if (!pool) throw new Error("PostgreSQL pool not initialized");
    this.client = await pool.connect();
    await this.client.query("BEGIN");
  }

  async commit() {
    if (!this.client) return;
    await this.client.query("COMMIT");
    this.client.release();
    this.client = null;
  }

  async rollback() {
    if (!this.client) return;
    try {
      await this.client.query("ROLLBACK");
    } finally {
      this.client.release();
      this.client = null;
    }
  }

  request() {
    if (!this.client) throw new Error("Transaction not started");
    return new PgRequestClient(this.client);
  }
}

/** MSSQL driver shim for legacy db-mssql query shapes. */
export const sql = {
  Transaction(_compatPool) {
    return new PgTransaction(_compatPool);
  },
  Request(transaction) {
    return transaction.request();
  },
};

/**
 * MSSQL-compatible pool surface used by db-postgres.mjs.
 * @param {string} connectionString
 */
export function createCompatPool(connectionString) {
  const useSsl =
    process.env.PGSSLMODE === "disable"
      ? false
      : /render\.com|sslmode=require/i.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined;
  _nativePool = new pg.Pool({
    connectionString,
    ssl: useSsl,
  });
  const pool = _nativePool;
  return {
    get connected() {
      return !!pool;
    },
    /** @returns {PgRequest} */
    request() {
      return new PgRequest(pool);
    },
    async query(text, params) {
      return pool.query(text, params);
    },
    async end() {
      await pool.end();
    },
  };
}

export function getNativePool() {
  return _nativePool;
}

/** @param {ReturnType<typeof createCompatPool>} _compatPool */
export async function runSchemaSql(_compatPool) {
  const schemaPath = path.join(__dirname, "../schema/postgres.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const pool = getNativePool();
  if (!pool) throw new Error("PostgreSQL pool not initialized");
  await pool.query(sql);
}
