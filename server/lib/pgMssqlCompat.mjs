/**
 * Minimal mssql.ConnectionPool / .request().input().query() shim over node-postgres.
 * Used when DATABASE_URL points at PostgreSQL (e.g. Render) so db-mssql.mjs can run unchanged.
 */

import pg from "pg";

export function isPostgresMode() {
  return !!process.env.DATABASE_URL?.trim();
}

/**
 * Convert T-SQL MERGE … USING … ON … WHEN MATCHED / NOT MATCHED to INSERT … ON CONFLICT.
 * Covers the MERGE patterns used in db-mssql.mjs.
 * @param {string} sql
 */
function translateMergeForPg(sql) {
  if (!/\bMERGE\b/i.test(sql)) return sql;

  const table = sql.match(/\bMERGE\s+(?:dbo\.)?(\w+)\b/i)?.[1];
  if (!table) return sql;

  const onClause = sql.match(/\bON\s+([\s\S]+?)\s+WHEN\s+MATCHED\b/i)?.[1]?.trim() ?? "";
  const conflictCols = [];
  for (const part of onClause.split(/\s+AND\s+/i)) {
    const trimmed = part.trim();
    let m = trimmed.match(/target\.(\w+)\s*=\s*source\.\1/i);
    if (m) {
      conflictCols.push(m[1]);
      continue;
    }
    m = trimmed.match(/target\.(\w+)\s*=\s*@(\w+)/i);
    if (m && m[1] === m[2]) conflictCols.push(m[1]);
  }
  if (!conflictCols.length) return sql;

  const usingInner = sql.match(/\bUSING\s*\(\s*SELECT\s+([\s\S]+?)\s*\)\s+AS\s+\w+/i)?.[1] ?? "";
  /** @type {Map<string, string>} */
  const sourceToParam = new Map();
  for (const piece of usingInner.split(",")) {
    const m = piece.trim().match(/(@\w+)\s+AS\s+(\w+)/i);
    if (m) sourceToParam.set(m[2].toLowerCase(), m[1]);
  }

  const insertBlock = sql.match(/\bWHEN\s+NOT\s+MATCHED\s+THEN\s+INSERT\s*\(([\s\S]+?)\)\s*VALUES\s*\(([\s\S]+?)\)\s*;?/i);
  if (!insertBlock) return sql;

  const insertCols = insertBlock[1].split(",").map((s) => s.trim());
  const insertVals = insertBlock[2].split(",").map((s) => s.trim());

  const valuesList = insertVals.map((v) => {
    const src = v.match(/^source\.(\w+)$/i);
    if (src) return sourceToParam.get(src[1].toLowerCase()) ?? v;
    return v;
  });

  const updateSet = sql.match(/\bWHEN\s+MATCHED\s+THEN\s+UPDATE\s+SET\s+([\s\S]+?)\s+WHEN\s+NOT\s+MATCHED\b/i)?.[1]?.trim() ?? "";
  const pgUpdateSet = updateSet
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((assignment) => {
      const eq = assignment.indexOf("=");
      if (eq < 0) return assignment;
      const col = assignment.slice(0, eq).trim();
      const rhs = assignment.slice(eq + 1).trim();

      if (/^@\w+$/i.test(rhs) || /^source\.\w+$/i.test(rhs)) {
        return `${col} = EXCLUDED.${col}`;
      }
      const coalesce = rhs.match(/^COALESCE\s*\(\s*(@\w+)\s*,\s*target\.(\w+)\s*\)$/i);
      if (coalesce) {
        return `${col} = COALESCE(EXCLUDED.${col}, ${table}.${coalesce[2]})`;
      }
      return assignment;
    })
    .join(", ");

  const conflict = conflictCols.map((c) => c).join(", ");
  return [
    `INSERT INTO ${table} (${insertCols.join(", ")})`,
    `VALUES (${valuesList.join(", ")})`,
    `ON CONFLICT (${conflict}) DO UPDATE SET ${pgUpdateSet}`,
  ].join("\n");
}

/**
 * @param {string} sql
 * @returns {{ sql: string, limitParam: string | null, limitLiteral: string | null }}
 */
function translateSqlForPg(sql) {
  let q = translateMergeForPg(String(sql ?? ""));
  q = q.replace(/\bdbo\./gi, "");
  q = q.replace(/SYSUTCDATETIME\s*\(\s*\)/gi, "CURRENT_TIMESTAMP");
  q = q.replace(/\bISNULL\s*\(/gi, "COALESCE(");
  q = q.replace(/\bN'/g, "'");
  q = q.replace(/^\s*;\s*WITH\b/i, "WITH");

  q = q.replace(/\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (match, alias) => {
    if (/[A-Z]/.test(alias)) return `AS "${alias}"`;
    return match;
  });

  let limitParam = null;
  let limitLiteral = null;

  const topAt = q.match(/\bSELECT\s+TOP\s*\(\s*(@\w+)\s*\)/i);
  if (topAt) {
    limitParam = topAt[1];
    q = q.replace(/\bSELECT\s+TOP\s*\(\s*@\w+\s*\)/i, "SELECT");
  } else {
    const topParen = q.match(/\bSELECT\s+TOP\s*\(\s*(\d+)\s*\)/i);
    if (topParen) {
      limitLiteral = topParen[1];
      q = q.replace(/\bSELECT\s+TOP\s*\(\s*\d+\s*\)/i, "SELECT");
    } else {
      const topBare = q.match(/\bSELECT\s+TOP\s+(\d+)\b/i);
      if (topBare) {
        limitLiteral = topBare[1];
        q = q.replace(/\bSELECT\s+TOP\s+\d+\b/i, "SELECT");
      }
    }
  }

  return { sql: q, limitParam, limitLiteral };
}

function appendLimitClause(q, limitFragment) {
  if (/\bLIMIT\b/i.test(q)) return q;
  return q.trimEnd().replace(/;+\s*$/, "") + ` LIMIT ${limitFragment}`;
}

/** @param {unknown} tx */
export function isPgTransaction(tx) {
  return tx instanceof PgTransaction;
}

export class PgTransaction {
  /** @param {{ _pgPool: import("pg").Pool }} poolWrapper */
  constructor(poolWrapper) {
    this._pool = poolWrapper._pgPool;
    /** @type {import("pg").PoolClient | null} */
    this._client = null;
  }

  async begin() {
    this._client = await this._pool.connect();
    await this._client.query("BEGIN");
  }

  async commit() {
    if (!this._client) return;
    try {
      await this._client.query("COMMIT");
    } finally {
      this._client.release();
      this._client = null;
    }
  }

  async rollback() {
    if (!this._client) return;
    try {
      await this._client.query("ROLLBACK");
    } finally {
      this._client.release();
      this._client = null;
    }
  }

  request() {
    if (!this._client) throw new Error("Transaction has not begun. Call begin() first.");
    return new PgRequest(this._pool, this._client);
  }
}

class PgRequest {
  /**
   * @param {import("pg").Pool} pool
   * @param {import("pg").PoolClient | null} [client]
   */
  constructor(pool, client = null) {
    this.pool = pool;
    this.client = client;
    /** @type {{ name: string, value: unknown }[]} */
    this.inputs = [];
  }

  input(name, _type, value) {
    let v = value;
    if (typeof v === "boolean") v = v ? 1 : 0;
    this.inputs.push({ name: String(name), value: v });
    return this;
  }

  async query(sql) {
    const { sql: baseSql, limitParam, limitLiteral } = translateSqlForPg(sql);
    let q = baseSql;
    const params = [];
    let idx = 1;
    for (const { name, value } of this.inputs) {
      const re = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      q = q.replace(re, `$${idx}`);
      params.push(value);
      idx += 1;
    }

    if (limitParam) {
      const paramName = limitParam.slice(1);
      const inputIdx = this.inputs.findIndex((i) => i.name === paramName);
      if (inputIdx >= 0) {
        q = appendLimitClause(q, `$${inputIdx + 1}`);
      }
    } else if (limitLiteral) {
      q = appendLimitClause(q, limitLiteral);
    }

    const runner = this.client ?? this.pool;
    const res = await runner.query(q, params);
    return { recordset: res.rows ?? [], rowsAffected: [res.rowCount ?? 0] };
  }

  /** T-SQL batches are not run on PostgreSQL (schema is managed separately). */
  async batch(_sql) {
    return { recordset: [], rowsAffected: [] };
  }
}

/**
 * @returns {{ connect: () => Promise<void>, get connected(): boolean, request: () => PgRequest, batch: (sql: string) => Promise<void> }}
 */
export function createPgPool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL mode");

  const useSsl =
    process.env.DATABASE_SSL !== "false" &&
    (/render\.com|sslmode=require/i.test(connectionString) || process.env.NODE_ENV === "production");

  const pool = new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 10),
  });

  return {
    _pgPool: pool,
    async connect() {
      await pool.query("SELECT 1");
    },
    get connected() {
      return true;
    },
    request() {
      return new PgRequest(pool);
    },
    async batch(_sql) {
      /* schema already on Render Postgres — no dbo IF OBJECT_ID batches */
    },
  };
}
