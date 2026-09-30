import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const summaryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "ballot-score-summary.json");

export function readBallotScoreSummary() {
  if (!fs.existsSync(summaryPath)) return null;
  return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
}
