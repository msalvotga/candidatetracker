import { extractAnchorsFromHtml } from "../server/lib/countyHubDiscovery.mjs";
import { discoverEvRosterUrlsFromLinks } from "../server/lib/evRosterHubDiscovery.mjs";

const urls = [
  "https://www.dallascountyvotes.org/election-results/current/",
  "https://www.dallascountyvotes.org/election-results/historical/030326-republican-daily-cumulative/",
  "https://www.dallascountyvotes.org/election-results/historical/may-26-2026-primary-runoff-election/",
];
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

for (const url of urls) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const html = await res.text();
  const waf = html.includes("awsWaf") || html.includes("gokuProps");
  const links = extractAnchorsFromHtml(html, res.url);
  const hit = links.filter((l) =>
    /in-person\s+early\s+voter|mail\s+ballots?\s+returned|early\s+voting\s+roster/i.test(l.text),
  );
  const hitLoose = links.filter((l) => /early\s+vot|mail\s+ballot|voter\s+list/i.test(l.text + l.href));
  console.log(
    res.status,
    waf ? "WAF" : "OK",
    "len",
    html.length,
    "anchors",
    links.length,
    "hits",
    hit.length,
    url,
  );
  for (const l of hit) console.log(" [strict]", l.text, "->", l.href);
  for (const l of hitLoose.slice(0, 15)) console.log(" [loose]", l.text.slice(0, 80), "->", l.href.slice(0, 100));
  if (/In-Person Early Voter List/i.test(html)) console.log(" html contains 'In-Person Early Voter List'");
  if (/Mail Ballots Returned/i.test(html)) console.log(" html contains 'Mail Ballots Returned'");

  const uploads = [...html.matchAll(/https?:\/\/[^"'\\s>]+wp-content\/uploads[^"'\\s>]*/gi)].map((m) => m[0]);
  const rosterish = uploads.filter((u) => /early|voter|mail|ballot|xlsx|csv|zip/i.test(u));
  if (rosterish.length) console.log(" uploads in html:", rosterish.slice(0, 10));

  const discovered = discoverEvRosterUrlsFromLinks(links, { countyKey: "dallas" });
  console.log(" discover:", discovered.message);
}
