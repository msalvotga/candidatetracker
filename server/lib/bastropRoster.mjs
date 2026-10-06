import { parse } from "csv-parse/sync";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const BASTROP_ROSTER_PAGE = "https://www.bastropvotes.org/election-information-2/upcoming-elections/";

/** A short agent gets an AWS browser check instead of the page. */
export const BASTROP_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,text/csv,*/*",
};

function decodeHtml(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inPersonSection(html) {
  const text = String(html ?? "");
  const start = text.search(/In-Person Voters/i);
  if (start < 0) return "";
  const block = text.slice(start);
  const end = block.search(/<\/ul>\s*<\/li>\s*<\/ul>/i);
  return end > 0 ? block.slice(0, end) : block.slice(0, 8000);
}

/**
 * Mail Ballots CSV, plus any in-person CSV that has been posted.
 * Day names with no link are not files yet.
 */
export function bastropRosterLinks(html) {
  const text = String(html ?? "");
  const found = [];
  const seen = new Set();
  const add = (href, label, votingMethod) => {
    const absolute = new URL(decodeHtml(href), BASTROP_ROSTER_PAGE).href;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    found.push({ href: absolute, text: label, votingMethod });
  };
  for (const match of text.matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,240}?)<\/a>/gi)) {
    const label = decodeHtml(match[2]);
    if (!/^mail ballots$/i.test(label)) continue;
    add(match[1], label, "AB");
  }
  for (const match of inPersonSection(text).matchAll(/href="([^"]+\.csv)"[^>]*>([\s\S]{0,240}?)<\/a>/gi)) {
    add(match[1], decodeHtml(match[2]) || "In-Person Voters", "EV");
  }
  found.sort((a, b) => a.votingMethod.localeCompare(b.votingMethod) || a.href.localeCompare(b.href));
  return found;
}

function columnKey(row, pattern) {
  return Object.keys(row ?? {}).find((key) => pattern.test(key)) ?? null;
}

/**
 * Bastrop roster CSV. VUID is the voter id. Ballot Status Date is the vote date.
 */
export function parseBastropRosterCsv(text, votingMethod = "AB") {
  const table = parse(String(text ?? ""), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table) {
    const vuidKey = columnKey(raw, /^vuid$/i);
    const dateKey = columnKey(raw, /ballot\s*status\s*date|status\s*date/i);
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
    const key = `${vuid}|${voteDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ vuid, activityDate: voteDate, votingMethod });
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}
