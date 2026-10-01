import { parse } from "csv-parse/sync";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const GALVESTON_ROSTER_PAGE =
  "https://galvestonvotes.org/election-information/current-and-upcoming-elections/";

/** A short agent gets an empty 202 from this site. */
export const GALVESTON_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,text/csv,*/*",
};

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

function mailRosterSection(html) {
  const match = String(html ?? "").match(
    /Mail Ballot Rosters[\s\S]*?<div class="al-accordion-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  );
  return match?.[1] ?? "";
}

/**
 * CSV links inside Mail Ballot Rosters. The vote day is the date printed beside the link.
 * File names are unreliable (typos and a wrong year).
 */
export function galvestonMailRosterLinks(html) {
  const found = [];
  const seen = new Set();
  for (const paragraph of mailRosterSection(html).matchAll(/<p>([\s\S]*?)<\/p>/gi)) {
    const block = paragraph[1];
    const labeled = decodeHtml(block).match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    const voteDate = labeled ? parseIsoDate(labeled[1]) : null;
    const csv = block.match(/href="([^"]+\.csv)"/i);
    if (!csv || !voteDate) continue;
    const href = new URL(decodeHtml(csv[1]), GALVESTON_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push({ href, voteDate, votingMethod: "AB" });
  }
  found.sort((a, b) => a.voteDate.localeCompare(b.voteDate) || a.href.localeCompare(b.href));
  return found;
}

/** Newest labeled day, plus any earlier day that does not already have stored voters. */
export function galvestonRosterFilesToPull(files, datesWithVoters) {
  const have = new Set(datesWithVoters ?? []);
  if (!files?.length) return [];
  const latest = files.reduce((max, file) => (file.voteDate > max ? file.voteDate : max), "");
  return files.filter((file) => file.voteDate === latest || !have.has(file.voteDate));
}

function columnKey(row, pattern) {
  return Object.keys(row ?? {}).find((key) => pattern.test(key)) ?? null;
}

/**
 * Galveston mail roster CSV. VUID is the voter id. Ballot Received Date is the vote date.
 */
export function parseGalvestonMailCsv(text) {
  const table = parse(String(text ?? ""), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  const rows = [];
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table) {
    const vuidKey = columnKey(raw, /vuid/i);
    const dateKey = columnKey(raw, /ballot\s*received\s*date|received\s*date|vote\s*date/i);
    const vuid = String(raw[vuidKey] ?? "").trim();
    const voteDate = parseIsoDate(raw[dateKey]);
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      if (voteDate) missingByDate.set(voteDate, (missingByDate.get(voteDate) ?? 0) + 1);
      continue;
    }
    if (!voteDate) {
      skippedMissingDate += 1;
      continue;
    }
    rows.push({ vuid, activityDate: voteDate, votingMethod: "AB" });
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}
