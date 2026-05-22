import { fetchRosterFile } from "../server/lib/evRosterFileParse.mjs";
import { PDFParse } from "pdf-parse";

const url =
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518._1.pdf";
const f = await fetchRosterFile(url);
const parser = new PDFParse({ data: f.buffer });
const pdfText = await parser.getText();
await parser.destroy();
const lines = String(pdfText?.text ?? "")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

for (let i = 0; i < Math.min(30, lines.length); i++) console.log(i, lines[i]);
console.log("--- around return date ---");
const idx = lines.findIndex((l) => /^Return Date/i.test(l));
for (let i = Math.max(0, idx - 3); i < Math.min(lines.length, idx + 15); i++) console.log(i, lines[i]);
console.log("--- tail ---");
for (let i = lines.length - 5; i < lines.length; i++) console.log(i, lines[i]);
