import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const WASM_PATH = fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.wasm"));

async function countsFor(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const SQL = await initSqlJs({ locateFile: () => WASM_PATH, wasmBinary: fs.readFileSync(WASM_PATH) });
  const db = new SQL.Database(fs.readFileSync(filePath));
  const out = { file: path.basename(filePath), bytes: fs.statSync(filePath).size, tables: {} };
  const list = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = list[0]?.values?.map((r) => r[0]) ?? [];
  for (const t of names) {
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`);
    stmt.step();
    const n = Number(stmt.getAsObject().n ?? 0);
    stmt.free();
    if (n > 0) out.tables[t] = n;
  }
  db.close();
  return out;
}

for (const name of [
  "elections.db",
  "elections.recovered.db",
  "elections.corrupt-20260428-132248.db",
]) {
  const p = path.join(dataDir, name);
  if (fs.existsSync(p)) console.log(await countsFor(p));
}
