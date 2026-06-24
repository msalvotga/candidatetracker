import XLSX from "xlsx";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Districts blank in xlsx but present in the tracking spreadsheet. */
const OVERRIDES = {
  1: { trump: 55.71, cruz: 53.12, abbott: 58.5 },
  3: { trump: 52.31, cruz: 49.13, abbott: 55.93 },
  9: { trump: 57.95, cruz: 54.91, abbott: 61.43 },
  15: { trump: 27.0, cruz: 23.37, abbott: 28.52 },
  21: { trump: 50.22, cruz: 54.92, abbott: 51.25 },
  41: { trump: 1.65, cruz: -8.31, abbott: -11.67 },
  47: { trump: -40.3, cruz: -43.5, abbott: -44.4 },
  49: { trump: -22.3, cruz: -25.1, abbott: -24.3 },
  50: { trump: -80.3, cruz: -81.3, abbott: -78.4 },
  71: { trump: 15.83, cruz: 12.01, abbott: 18.26 },
  85: { trump: 15.35, cruz: 11.81, abbott: 19.27 },
  86: { trump: 35.0, cruz: 31.75, abbott: 38.0 },
  93: { trump: 19.17, cruz: 12.22, abbott: 18.53 },
  94: { trump: 9.57, cruz: 4.0, abbott: 10.99 },
  96: { trump: 10.64, cruz: 5.14, abbott: 11.59 },
  98: { trump: 20.15, cruz: 12.42, abbott: 17.87 },
  118: { trump: 4.55, cruz: -3.11, abbott: -1.22 },
  125: { trump: -11.61, cruz: -19.17, abbott: -16.82 },
  126: { trump: 22.12, cruz: 15.3, abbott: 20.22 },
  128: { trump: 34.22, cruz: 31.53, abbott: 34.82 },
  129: { trump: 17.07, cruz: 12.47, abbott: 16.3 },
  131: { trump: -40.34, cruz: -45.91, abbott: -45.17 },
  135: { trump: -7.9, cruz: -15.97, abbott: -10.55 },
  149: { trump: 16.31, cruz: 11.05, abbott: 19.1 },
};

function toPct(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.abs(n) <= 1 ? Math.round(n * 10000) / 100 : Math.round(n * 100) / 100;
}

const xlsxPath =
  process.argv[2] || "C:/Users/TGAData/Downloads/2026 TX Lege Races (2).xlsx";
const wb = XLSX.readFile(xlsxPath);
const rows = XLSX.utils.sheet_to_json(wb.Sheets["2026 TX House"], { header: 1, defval: "" });
const byHd = {};

for (let i = 1; i < rows.length; i++) {
  const d = Number(rows[i][0]);
  if (!d || d < 1 || d > 150) continue;
  const trump = toPct(rows[i][23]);
  const cruz = toPct(rows[i][24]);
  const abbott = toPct(rows[i][25]);
  if (trump != null || cruz != null || abbott != null) {
    byHd[d] = { trump, cruz, abbott };
  }
}

const benchmarks = [];
for (let d = 1; d <= 150; d++) {
  const row = OVERRIDES[d] || byHd[d];
  if (!row) throw new Error(`Missing benchmark data for HD-${d}`);
  benchmarks.push({ district: d, trump: row.trump, cruz: row.cruz, abbott: row.abbott });
}

const lines = benchmarks.map(
  (r) => `  { district: ${r.district}, trump: ${r.trump}, cruz: ${r.cruz}, abbott: ${r.abbott} },`
);

const content = `/** R% − D% margins for TX House districts (2024 Trump/Cruz, 2022 Abbott). */
export const HOUSE_BENCHMARKS = [
${lines.join("\n")}
];
`;

writeFileSync(join(__dirname, "data/house-benchmarks.mjs"), content);
console.log(`Wrote ${benchmarks.length} house district benchmarks.`);
