import { fetchHubPageHtml, extractAnchorsFromHtml } from "../server/lib/countyHubDiscovery.mjs";
import { discoverEvRosterUrlsFromLinks } from "../server/lib/evRosterHubDiscovery.mjs";

const hub =
  "https://www.fortbendcountytx.gov/government/departments/elections-voter-registration/early-voting-statistics";
const html = await fetchHubPageHtml(hub);
const links = extractAnchorsFromHtml(html, hub);
for (const l of links) {
  if (/0518|bbm|\.pdf/i.test(`${l.text} ${l.href}`)) {
    console.log(JSON.stringify({ text: l.text, href: l.href.slice(-40) }));
  }
}
const disc = discoverEvRosterUrlsFromLinks(links, { countyKey: "fort_bend", votingDate: "2026-05-18" });
console.log(disc);
