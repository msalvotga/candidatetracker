/**
 * One-time: generate server/db-postgres.mjs from server/db-mssql.mjs
 * Run: node server/scripts/build-db-postgres.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const srcPath = path.join(root, "db-mssql.mjs");
const outPath = path.join(root, "db-postgres.mjs");

let s = fs.readFileSync(srcPath, "utf8");

const schemaStart = s.indexOf("const SCHEMA_SQL = `");
const schemaEnd = s.indexOf("async function migrateLegacyJsonIfNeeded(pool)");
if (schemaStart < 0 || schemaEnd < 0) throw new Error("Could not locate SCHEMA_SQL block in db-mssql.mjs");
s = s.slice(0, schemaStart) + s.slice(schemaEnd);

const header = `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCompatPool, getDatabaseUrl, runSchemaSql } from "./lib/pgPool.mjs";
import {
  EV_ROSTER_SUMMARY_CACHE_DDL_POSTGRES,
} from "./lib/evRosterSummaryCache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "data");
const LEGACY_MANIFEST = path.join(DATA_DIR, "manual-manifest.json");
const LEGACY_MANUAL_DIR = path.join(DATA_DIR, "manual");

/** @type {ReturnType<typeof createCompatPool> | null} */
let _pool = null;
/** @type {Promise<ReturnType<typeof createCompatPool>> | null} */
let _init = null;

`;

s = s.replace(/^import sql from "mssql";[\s\S]*?const LEGACY_MANUAL_DIR[\s\S]*?let _init = null;\n\n/m, header);

s = s.replace(
  /function buildConfig\(\) \{[\s\S]*?return \{ config \};\n\}/,
  `function buildConfig() {
  getDatabaseUrl();
  return {};
}`,
);

s = s.replace(
  /import \{\s*EV_ROSTER_SUMMARY_CACHE_DDL_MSSQL,\s*\} from "\.\/lib\/evRosterSummaryCache\.mjs";/,
  "",
);

s = s.replace(
  `_init = \(async \(\) => \{\s*const \{ config \} = buildConfig\(\);\s*_pool = new sql\.ConnectionPool\(config\);\s*await _pool\.connect\(\);\s*await _pool\.batch\(SCHEMA_SQL\);\s*await syncIngestVendorMetadataMssql\(_pool\);\s*await migrateLegacyJsonIfNeeded\(_pool\);\s*return _pool;\s*\}\)\(\);`,
  `_init = (async () => {
    _pool = createCompatPool(getDatabaseUrl());
    await runSchemaSql(_pool);
    await _pool.query(EV_ROSTER_SUMMARY_CACHE_DDL_POSTGRES);
    await syncIngestVendorMetadataMssql(_pool);
    await migrateLegacyJsonIfNeeded(_pool);
    return _pool;
  })();`,
);

s = s.replace(
  /export function getDbInfo\(\) \{[\s\S]*?hint: "[^"]*",\s*\};\s*\}/,
  `export function getDbInfo() {
  const url = getDatabaseUrl();
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "(invalid DATABASE_URL)";
  }
  return {
    engine: "postgres",
    host,
    driver: "pg",
    ssms: false,
    hint: "Set DATABASE_URL to your PostgreSQL connection string.",
  };
}`,
);

s = s.replace(/\.input\(([^,]+),\s*sql\.[^,]+,\s*/g, ".input($1, ");

fs.writeFileSync(outPath, s);
console.log("Wrote", outPath, "(" + fs.statSync(outPath).size + " bytes)");
