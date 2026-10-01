import { parse } from "csv-parse/sync";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const HARRIS_ROSTER_PAGE = "https://www.harrisvotes.com/Election-Results/Election-Rosters";

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

export function harrisRosterLinks(html) {
  const links = [];
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    links.push({ href: decodeHtml(match[1]), text: decodeHtml(match[2]) });
  }
  return links;
}

export function harrisRosterFrame(html) {
  const match = String(html ?? "").match(/<iframe[^>]+src="([^"]+)"/i);
  return match ? decodeHtml(match[1]) : null;
}

/** The daily file is the November 3, 2026 general-election Unofficial BBM Roster. */
export function harrisBbmRosterLink(html) {
  return (
    harrisRosterLinks(html).find(
      (link) =>
        /unofficial\s+bbm\s+roster/i.test(link.text) &&
        /general/i.test(link.text) &&
        /november\s+0?3,?\s+2026/i.test(link.text),
    ) ?? null
  );
}

function cell(row, index) {
  return String(row?.[index] ?? "").trim();
}

function isHeaderRow(row) {
  const vuid = cell(row, 4).toLowerCase();
  const date = cell(row, 7).toLowerCase();
  return vuid === "statevoterid" || date === "activitydate" || date === "votedate" || date === "vote date";
}

/**
 * Harris BBM roster: one cumulative CSV. Column E is the state VUID. Column H is the vote date.
 * Rows with a blank state VUID are skipped until a later cumulative file includes one.
 */
export function parseHarrisBbmCsv(text) {
  const table = parse(String(text ?? ""), { bom: true, relax_column_count: true, relax_quotes: true });
  const rows = [];
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table) {
    if (!raw.some((value) => String(value ?? "").trim())) continue;
    if (isHeaderRow(raw)) continue;
    const vuid = cell(raw, 4);
    const voteDate = parseIsoDate(cell(raw, 7));
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
