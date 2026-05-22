import { fetchRosterFile, parseRosterFromFile } from "../server/lib/evRosterFileParse.mjs";

const docUrl =
  "https://www.wilco.org/DocumentCenter/View/19729/Voter-Turnout-for-May-26-2026-Primary-Runoff";
const r = await fetch(docUrl, {
  headers: { "User-Agent": "Mozilla/5.0" },
  redirect: "follow",
});
const html = await r.text();
console.log("page", r.status, r.url);
const files = [...html.matchAll(/\/DocumentCenter\/(?:View|Download)\/\d+\/[^"'\\s]+/gi)].map((m) => m[0]);
for (const p of [...new Set(files)]) console.log("path:", p);

const tryUrls = [
  "https://www.wilco.org/DocumentCenter/View/19729/Voter-Turnout-for-May-26-2026-Primary-Runoff",
  "https://www.wilcotx.gov/DocumentCenter/View/19729/Voter-Turnout-for-May-26-2026-Primary-Runoff",
];
for (const base of tryUrls) {
  for (const ext of [".xlsx", ".csv", ".pdf"]) {
    const url = base + ext;
    try {
      const f = await fetchRosterFile(url);
      console.log("OK", ext, f.fileName, f.buffer.length, f.contentType.slice(0, 40));
      if (ext !== ".pdf") {
        const rows = await parseRosterFromFile(
          { ...f, fileFormat: ext.slice(1) },
          { defaultCounty: "WILLIAMSON", dateScope: "CUMULATIVE", pullParty: "REP", filePartyScope: "COMBINED" },
        );
        console.log("rows", rows.length, rows[0]);
      }
    } catch (e) {
      console.log("fail", ext, e.message.slice(0, 80));
    }
  }
}
