import { fetchCapitolMetadata } from "./lib/tedElectionResults.mjs";

const years = [2024, 2022];
for (const year of years) {
  const file = await fetchCapitolMetadata(year);
  console.log(`Saved ${year} general metadata → ${file}`);
}
