import * as XLSX from "xlsx";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const DENTON_ROSTER_PAGE = "https://www.votedenton.gov/early-voting-election-day-rosters/";

export const DENTON_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
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

function isExcelLink(href, label) {
  if (/\.xlsx?(?:$|[?#])/i.test(href)) return true;
  return /^excel$/i.test(String(label ?? "").replace(/[()]/g, "").trim());
}

/**
 * The Excel link beside Returned Mail Ballot Roster. The PDF of the same roster, and the totals
 * and weekly mail links, are skipped. The county replaces the file, so the address changes.
 */
export function dentonRosterLinks(html) {
  const found = [];
  const seen = new Set();
  const paragraphs = String(html ?? "").matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi);
  for (const paragraph of paragraphs) {
    const block = paragraph[0];
    if (!/returned mail ballot roster/i.test(decodeHtml(block))) continue;
    const links = block.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
    for (const link of links) {
      const hrefRaw = decodeHtml(link[1]);
      const text = decodeHtml(link[2]);
      if (!isExcelLink(hrefRaw, text)) continue;
      const href = new URL(hrefRaw, DENTON_ROSTER_PAGE).href;
      if (seen.has(href)) continue;
      seen.add(href);
      found.push({ href, text, votingMethod: "AB" });
    }
  }
  return found;
}

function columnIndex(header, pattern) {
  return (header ?? []).findIndex((cell) => pattern.test(String(cell ?? "").trim()));
}

function voteDate(value) {
  const iso = parseIsoDate(value);
  if (!iso) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return iso;
}

/**
 * Denton returned-mail workbook. SOS_Vuid is the voter id. Return Date is the vote date.
 * The voting method is mail because the link sits beside Returned Mail Ballot Roster.
 */
export function dentonRosterRows(matrix, votingMethod = "AB") {
  const table = matrix ?? [];
  let header = -1;
  let vuidColumn = -1;
  let dateColumn = -1;
  for (let index = 0; index < table.length; index += 1) {
    const row = table[index] ?? [];
    const vuid = columnIndex(row, /vuid/i);
    const date = columnIndex(row, /return\s*date|ballot\s*received\s*date|received\s*date|vote\s*date/i);
    if (vuid >= 0 && date >= 0) {
      header = index;
      vuidColumn = vuid;
      dateColumn = date;
      break;
    }
  }
  if (vuidColumn < 0 && table.some((row) => (row ?? []).some((value) => String(value ?? "").trim()))) {
    throw new Error("Denton roster did not include a VUID and a return date.");
  }
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table.slice(header + 1)) {
    const values = raw ?? [];
    if (!values.some((value) => String(value ?? "").trim())) continue;
    const vuid = String(values[vuidColumn] ?? "")
      .trim()
      .replace(/\.0$/, "");
    const activityDate = voteDate(values[dateColumn]);
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      if (activityDate) missingByDate.set(activityDate, (missingByDate.get(activityDate) ?? 0) + 1);
      continue;
    }
    if (!activityDate) {
      skippedMissingDate += 1;
      continue;
    }
    const key = `${vuid}|${activityDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ vuid, activityDate, votingMethod });
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}

export function parseDentonRosterXlsx(buffer, votingMethod = "AB") {
  const bytes = Buffer.from(buffer ?? []);
  const head = bytes.subarray(0, 2).toString("utf8");
  if (head !== "PK" && bytes[0] !== 0xd0) {
    throw new Error("Denton returned mail roster was not an Excel file.");
  }
  const book = XLSX.read(bytes, { type: "buffer", cellDates: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error("Denton roster workbook did not include a sheet.");
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return dentonRosterRows(matrix, votingMethod);
}
