import { fetchRosterFile } from "../server/lib/evRosterFileParse.mjs";
import * as XLSX from "xlsx";

const url =
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/Early-Voting-by-Personal-Appearance-Statistics-1%281%29.xlsx";
const f = await fetchRosterFile(url);
const wb = XLSX.read(f.buffer, { type: "buffer" });
console.log("sheets", wb.SheetNames);
for (const name of wb.SheetNames) {
  const m = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
  console.log("\n--", name, "rows", m.length);
  m.slice(0, 8).forEach((r, i) => console.log(i, r.slice(0, 10)));
}
