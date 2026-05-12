import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripCountySuffix(label) {
  const t = String(label ?? "").trim();
  if (t.toLowerCase().endsWith(" county")) {
    return t.slice(0, -7).trim();
  }
  return t;
}

https
  .get("https://gist.githubusercontent.com/vphill/7974200/raw/", (r) => {
    let d = "";
    r.on("data", (c) => {
      d += c;
    });
    r.on("end", () => {
      const j = JSON.parse(d);
      const rows = [];
      for (const [fips, name] of Object.entries(j)) {
        const label = String(name).trim();
        const shortName = stripCountySuffix(label);
        const key = shortName.toLowerCase().replace(/\s+/g, "_");
        rows.push({ fips, key, label });
      }
      rows.sort((a, b) => a.label.localeCompare(b.label));
      const dup = new Map();
      for (const r of rows) {
        dup.set(r.key, (dup.get(r.key) ?? 0) + 1);
      }
      const collisions = [...dup.entries()].filter(([, n]) => n > 1);
      if (collisions.length) {
        console.error("Key collisions", collisions);
        process.exit(1);
      }
      const ts =
        `/** Auto-generated: Texas counties (254). Keys match ingest county_key slugs (lowercase, underscores). */\n\n` +
        `export interface TexasCounty {\n  readonly fips: string;\n  readonly key: string;\n  readonly label: string;\n}\n\n` +
        `export const TEXAS_COUNTIES: readonly TexasCounty[] = ${JSON.stringify(rows, null, 2)} as const;\n\n` +
        `export const TEXAS_COUNTY_KEY_SET: ReadonlySet<string> = new Set(TEXAS_COUNTIES.map((c) => c.key));\n`;
      const out = path.join(__dirname, "..", "src", "lib", "texasCounties.ts");
      fs.writeFileSync(out, ts, "utf8");
      console.error("Wrote", out, rows.length);
    });
  })
  .on("error", (e) => {
    console.error(e);
    process.exit(1);
  });
