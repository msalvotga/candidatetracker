import { fetchHubPageHtml, extractAnchorsFromHtml } from "../server/lib/countyHubDiscovery.mjs";

const hubs = [
  "https://www.wilcotx.gov/452/Early-Voting-Ballot-Board",
  "https://www.wilcotx.gov/165/Election-Results",
  "https://www.wilcotx.gov/164/Elections",
  "https://www.wilco.org/departments/elections",
];

for (const url of hubs) {
  try {
    const html = await fetchHubPageHtml(url);
    const links = extractAnchorsFromHtml(html, url);
    const hits = links.filter((l) =>
      /\.(csv|xlsx|zip|pdf|txt)/i.test(l.href) ||
      /roster|early.?vot|absentee|mail|voter.?list/i.test(`${l.text} ${l.href}`),
    );
    console.log("\n===", url, "links", hits.length, "===");
    for (const l of hits.slice(0, 25)) {
      console.log(l.text.slice(0, 70), "|", l.href.slice(0, 120));
    }
    const files = [...html.matchAll(/href="([^"]+\.(?:csv|xlsx|zip|pdf)[^"]*)"/gi)].map((m) => m[1]);
    for (const u of [...new Set(files)].slice(0, 15)) console.log("href:", u.slice(0, 120));
  } catch (e) {
    console.log(url, "ERR", e.message);
  }
}
