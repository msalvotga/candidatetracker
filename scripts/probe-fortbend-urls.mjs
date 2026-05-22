const base =
  "https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/elections-documents/earlyabsentee-voting/early-voting-statistics/";
const names = [
  "0518-Rep.pdf",
  "0518-Dem.pdf",
  "0518-REP.pdf",
  "0518-DEM.pdf",
  "0518-Rep-EV.pdf",
  "0518-Dem-EV.pdf",
  "0518-EV-Rep.pdf",
  "0518-EV-Dem.pdf",
  "0518-ABM-Rep.pdf",
  "0518-ABM-Dem.pdf",
  "0518-Rep-ABM.pdf",
  "0518-Dem-ABM.pdf",
  "Early-Voting-by-Personal-Appearance-Statistics-Rep.pdf",
  "Early-Voting-by-Personal-Appearance-Statistics-Dem.pdf",
  "0518._2.pdf",
  "0518._3.pdf",
  "0518-REP-EV.pdf",
  "0518-DEM-EV.pdf",
];
for (const n of names) {
  const url = base + encodeURIComponent(n).replace(/%2F/g, "/");
  const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
  if (r.ok) console.log("OK", n, r.headers.get("content-type"));
}
