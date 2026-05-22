import { fetchHubPageHtml } from "../server/lib/countyHubDiscovery.mjs";
import { fetchRosterFile } from "../server/lib/evRosterFileParse.mjs";
import { PDFParse } from "pdf-parse";

const hub =
  "https://www.fortbendcountytx.gov/government/departments/elections-voter-registration/early-voting-statistics";
const html = await fetchHubPageHtml(hub);
const idx = html.indexOf("early-voting-statistics/");
if (idx >= 0) console.log(html.slice(idx, idx + 800));

const candidates = [
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-REP.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-DEM.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-Rep.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-Dem.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-EV-Rep.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-EV.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-ABM-Rep.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/0518-ABM.pdf",
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/Early-Voting-by-Personal-Appearance-Statistics-1%281%29.xlsx",
];

for (const url of candidates) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    console.log(url.split("/").pop(), res.status, res.headers.get("content-type"));
  } catch (e) {
    console.log(url.split("/").pop(), "ERR");
  }
}
