import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { translateMergeForPg } from "./pgMssqlCompat.mjs";

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
  let s = translateMergeForPg(String(text ?? ""));
  s = s.replace(/\bdbo\./gi, "");
  s = s.replace(/\bISNULL\s*\(/gi, "COALESCE(");
  s = s.replace(/\bN'/g, "'");
  s = s.replace(/\bSYSUTCDATETIME\(\)/gi, "(NOW() AT TIME ZONE 'UTC')");
  s = s.replace(/\bGETUTCDATE\(\)/gi, "(NOW() AT TIME ZONE 'UTC')");
  const topAt = s.match(/\bSELECT\s+TOP\s*\(\s*(@\w+)\s*\)/i);
  if (!topAt) {
    s = s.replace(/\bSELECT\s+TOP\s*\(\s*(\d+)\s*\)/gi, "SELECT");
    s = s.replace(/\bSELECT\s+TOP\s+(\d+)\s+/gi, "SELECT ");
  }
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
  let pgText = normalizeSql(text);
  let limitParam = null;
  let limitLiteral = null;

  const topAt = pgText.match(/\bSELECT\s+TOP\s*\(\s*(@\w+)\s*\)/i);
  if (topAt) {
    limitParam = topAt[1];
    pgText = pgText.replace(/\bSELECT\s+TOP\s*\(\s*@\w+\s*\)/i, "SELECT");
  } else {
    const topParen = pgText.match(/\bSELECT\s+TOP\s*\(\s*(\d+)\s*\)/i);
    if (topParen) {
      limitLiteral = topParen[1];
      pgText = pgText.replace(/\bSELECT\s+TOP\s*\(\s*\d+\s*\)/i, "SELECT");
    } else {
      const topBare = pgText.match(/\bSELECT\s+TOP\s+(\d+)\b/i);
      if (topBare) {
        limitLiteral = topBare[1];
        pgText = pgText.replace(/\bSELECT\s+TOP\s+\d+\b/i, "SELECT");
      }
    }
  }

  const paramIndex = new Map();
  pgText = pgText.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter @${name}`);
    if (!paramIndex.has(name)) {
      values.push(params[name]);
      paramIndex.set(name, ++n);
    }
    return `$${paramIndex.get(name)}`;
  });

  if (limitParam) {
    const idx = paramIndex.get(limitParam.slice(1));
    if (idx && !/\bLIMIT\b/i.test(pgText)) {
      pgText = pgText.trimEnd().replace(/;+\s*$/, "") + ` LIMIT $${idx}`;
    }
  } else if (limitLiteral && !/\bLIMIT\b/i.test(pgText)) {
    pgText = pgText.trimEnd().replace(/;+\s*$/, "") + ` LIMIT ${limitLiteral}`;
  }

  return { pgText, values };
}

/** @param {string} key */
function snakeToCamel(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * PostgreSQL lowercases unquoted SELECT aliases (electionId → electionid).
 * Rebuild camelCase keys using AS aliases from the query text.
 * @param {string} text
 */
function buildAliasMap(text) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const re = /\bAS\s+"([^"]+)"|\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const alias = m[1] ?? m[2];
    map.set(alias.toLowerCase(), alias);
  }
  return map;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Map<string, string>} aliasMap
 */
function mapPgRows(rows, aliasMap) {
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      const lower = k.toLowerCase();
      const key = aliasMap.get(lower) ?? (k.includes("_") ? snakeToCamel(k) : k);
      out[key] = v;
    }
    return out;
  });
}

/**
 * @param {pg.Pool | pg.PoolClient} executor
 * @param {string} text
 * @param {Record<string, unknown>} params
 */
export async function pgQuery(executor, text, params = {}) {
  const { pgText, values } = bindParams(text, params);
  const result = await executor.query(pgText, values);
  const aliasMap = buildAliasMap(pgText);
  const rows = mapPgRows(result.rows, aliasMap);
  return { rows, recordset: rows, rowCount: result.rowCount };
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
    let v = maybeValue !== undefined ? maybeValue : typeOrValue;
    if (typeof v === "boolean") v = v ? 1 : 0;
    this.params[name] = v;
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
