import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const TARRANT_ROSTER_PAGE =
  "https://www.tarrantcountytx.gov/en/elections/past-election-information/2026-archives/november-3--2026--joint-general-and-special-election-results.html";

function decodeHtml(text) {
  return String(text ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function tarrantRosterKind(label) {
  const text = String(label ?? "");
  if (/ballot\s+by\s+mail/i.test(text) && !/tracker/i.test(text)) return "AB";
  if (/in\s+person\s+during\s+early\s+voting/i.test(text)) return "EV";
  return null;
}

/** Zip links labeled Ballot by Mail or In Person during Early Voting. The file address can change. */
export function tarrantRosterLinks(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    const text = decodeHtml(match[2]);
    if (!/\.zip(?:$|\?)/i.test(href)) continue;
    const votingMethod = tarrantRosterKind(text);
    if (!votingMethod) continue;
    const absolute = new URL(href, TARRANT_ROSTER_PAGE).href;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    found.push({ href: absolute, text, votingMethod });
  }
  found.sort((a, b) => a.votingMethod.localeCompare(b.votingMethod) || a.text.localeCompare(b.text));
  return found;
}

function columnKey(row, aliases) {
  const want = new Set(aliases.map(compact));
  return Object.keys(row ?? {}).find((key) => want.has(compact(key))) ?? null;
}

/**
 * Tab-separated roster. SOS Voter ID is the VUID. Return Date is the vote date.
 * A notice file with no those columns is not posted yet.
 */
export function parseTarrantRosterText(text, { votingMethod = "AB" } = {}) {
  const table = parse(String(text ?? "").replace(/^\uFEFF/, ""), {
    columns: true,
    delimiter: "\t",
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  const sample = table[0] ?? {};
  const vuidKey = columnKey(sample, ["sos voter id", "sosvoterid", "state voter id"]);
  const dateKey = columnKey(sample, ["return date", "returndate", "vote date", "activity date", "ballot status date"]);
  if (!vuidKey || !dateKey) {
    return { rows: [], skippedMissingVuid: 0, missingVuidDays: [], posted: false };
  }
  const rows = [];
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  for (const record of table) {
    const voteDate = parseIsoDate(record[dateKey]);
    const vuid = String(record[vuidKey] ?? "").trim();
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      if (voteDate) missingByDate.set(voteDate, (missingByDate.get(voteDate) ?? 0) + 1);
      continue;
    }
    if (!voteDate) continue;
    rows.push({ vuid, activityDate: voteDate, votingMethod });
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, missingVuidDays, posted: true };
}

export async function parseTarrantRosterZip(buffer, options) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir && /\.txt$/i.test(name));
  if (!names.length) throw new Error("Tarrant roster ZIP did not contain a text file.");
  const text = await zip.files[names[0]].async("string");
  return parseTarrantRosterText(text, options);
}
