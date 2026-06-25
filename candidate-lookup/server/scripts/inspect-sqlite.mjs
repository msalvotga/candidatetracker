import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] ?? "candidates.db";
const db = new DatabaseSync(path, { readOnly: true });
console.log("file:", path, "size:", fs.statSync(path).size);
console.log("office cols:", db.prepare("PRAGMA table_info(offices)").all());
console.log("tables:", db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all());
try {
  const sample = db.prepare("SELECT * FROM offices WHERE category='senate' LIMIT 3").all();
  console.log("SD sample:", sample);
} catch (e) {
  console.log("SD query error:", e.message);
}
