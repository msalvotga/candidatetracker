import { fetchHubPageHtml, extractAnchorsFromHtml } from "../server/lib/countyHubDiscovery.mjs";

const url =
  "https://www.fortbendcountytx.gov/government/departments/elections-voter-registration/early-voting-statistics";
const html = await fetchHubPageHtml(url);
const links = extractAnchorsFromHtml(html, url);
for (const l of links) {
  if (/\.(pdf|xlsx|csv)/i.test(l.href) || /early|mail|appearance|bbm|statistic/i.test(`${l.text} ${l.href}`)) {
    console.log(l.text.slice(0, 80), "|", l.href);
  }
}
const fromHtml = [...html.matchAll(/href="([^"]+\.(?:pdf|xlsx|csv)[^"]*)"/gi)].map((m) => m[1]);
for (const u of [...new Set(fromHtml)]) console.log("href:", u);
const allPdf = [...html.matchAll(/elections-documents\/[^"'\\s]+\.pdf/gi)].map((m) => m[0]);
for (const p of [...new Set(allPdf)].sort()) console.log("path:", p);
