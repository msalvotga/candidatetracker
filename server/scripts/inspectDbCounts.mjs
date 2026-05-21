import pg from "pg";
import { getDatabaseUrl } from "../lib/pgPool.mjs";

async function main() {
  const url = getDatabaseUrl();
  const pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const out = { host: new URL(url).host, tables: {} };
    for (const row of tables.rows) {
      const t = row.tablename;
      const c = await pool.query(`SELECT COUNT(*)::bigint AS n FROM "${t}"`);
      const n = Number(c.rows[0]?.n ?? 0);
      if (n > 0) out.tables[t] = n;
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
