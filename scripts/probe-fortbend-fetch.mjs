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

const vuids = [];
const dateParties = [];
for (const l of lines) {
  if (/^VUID\b/i.test(l)) continue;
  if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(l)) continue;
  if (/^Return Date/i.test(l)) continue;
  const m1 = l.match(/^(\d{10})\s/);
  if (m1) {
    vuids.push(m1[1]);
    continue;
  }
  const m2 = l.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(REP|DEM)\b/i);
  if (m2) dateParties.push({ date: m2[1], party: m2[2] });
}

console.log("vuids", vuids.length, "dateParties", dateParties.length);
if (vuids.length === dateParties.length) {
  console.log("paired sample", vuids[0], dateParties[0], vuids[100], dateParties[100]);
}
