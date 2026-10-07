import * as XLSX from "xlsx";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const PARKER_ROSTER_PAGE = "https://www.parkercountytx.gov/448/Early-Voting-Election-Day-Rosters";

export const PARKER_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
};

const MONTHS = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
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

function postedDate(text) {
  const named = String(text ?? "")
    .trim()
    .match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (!named) return parseIsoDate(text);
  const month = MONTHS[named[1].toLowerCase()];
  const day = named[2].padStart(2, "0");
  const probe = new Date(Date.UTC(Number(named[3]), Number(month) - 1, Number(named[2])));
  if (probe.getUTCFullYear() !== Number(named[3]) || probe.getUTCMonth() !== Number(month) - 1 || probe.getUTCDate() !== Number(named[2])) {
    return null;
  }
  return `${named[3]}-${month}-${day}`;
}

function methodFrom(text) {
  const hits = [];
  const mail = text.search(/ballot by mail|\bbbm\b|\bmail\b/i);
  const election = text.search(/election day/i);
  const early = text.search(/early vot/i);
  if (mail >= 0) hits.push({ at: mail, method: "AB" });
  if (election >= 0) hits.push({ at: election, method: "ED" });
  if (early >= 0) hits.push({ at: early, method: "EV" });
  hits.sort((a, b) => b.at - a.at);
  return hits[0]?.method ?? "";
}

/**
 * Date links on the roster page. The date text is an Excel file. A nearby "pdf" link is the same day
 * in another format and is skipped. The words before the link say whether the file is mail, early voting,
 * or election day.
 */
export function parkerRosterLinks(html) {
  const view = String(html ?? "").match(/class="fr-view">([\s\S]*?)<\/div>/i)?.[1] ?? String(html ?? "");
  const found = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of view.matchAll(pattern)) {
    const text = decodeHtml(match[2]);
    if (/^pdf\b/i.test(text)) continue;
    const asOf = postedDate(text);
    if (!asOf) continue;
    const href = new URL(decodeHtml(match[1]), PARKER_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    const before = decodeHtml(view.slice(Math.max(0, match.index - 500), match.index));
    found.push({
      href,
      asOf,
      text,
      votingMethod: methodFrom(before) || "AB",
    });
  }
  found.sort((a, b) => a.asOf.localeCompare(b.asOf) || a.href.localeCompare(b.href));
  return found;
}

/** Newest posted day, plus any earlier day that does not already have stored voters. */
export function parkerRosterFilesToPull(files, datesWithVoters) {
  const have = new Set(datesWithVoters ?? []);
  if (!files?.length) return [];
  const latest = files.reduce((max, file) => (file.asOf > max ? file.asOf : max), "");
  return files.filter((file) => file.asOf === latest || !have.has(file.asOf));
}

function columnIndex(header, pattern) {
  return (header ?? []).findIndex((cell) => pattern.test(String(cell ?? "").trim()));
}

function voteDate(value) {
  const text = String(value ?? "").trim();
  const iso = parseIsoDate(text);
  if (iso) return iso;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) return null;
  const year = 2000 + Number(match[3]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function thisElection(name) {
  const text = String(name ?? "").trim();
  if (!text) return true;
  return /2026/.test(text) && /november|general/i.test(text);
}

/**
 * Parker roster workbook. VUID is the voter id. Ballot Received Date is the vote date.
 * The voting method comes from the link on the page, not from a column.
 */
export function parkerRosterRows(matrix, votingMethod = "AB") {
  const table = matrix ?? [];
  let header = -1;
  let vuidColumn = -1;
  let dateColumn = -1;
  let electionColumn = -1;
  for (let index = 0; index < table.length; index += 1) {
    const row = table[index] ?? [];
    const vuid = columnIndex(row, /^vuid$/i);
    const date = columnIndex(row, /ballot\s*received\s*date|^date$|received\s*date|vote\s*date/i);
    if (vuid >= 0 && date >= 0) {
      header = index;
      vuidColumn = vuid;
      dateColumn = date;
      electionColumn = columnIndex(row, /election/i);
      break;
    }
  }
  if (vuidColumn < 0 && table.some((row) => (row ?? []).some((value) => String(value ?? "").trim()))) {
    throw new Error("Parker roster did not include a VUID and a date.");
  }
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table.slice(header + 1)) {
    const values = raw ?? [];
    if (!values.some((value) => String(value ?? "").trim())) continue;
    if (electionColumn >= 0 && !thisElection(values[electionColumn])) continue;
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

export function parseParkerRosterXlsx(buffer, votingMethod = "AB") {
  const bytes = Buffer.from(buffer ?? []);
  const head = bytes.subarray(0, 2).toString("utf8");
  if (head !== "PK" && bytes[0] !== 0xd0) {
    throw new Error("Parker roster date link was not an Excel file.");
  }
  const book = XLSX.read(bytes, { type: "buffer", cellDates: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error("Parker roster workbook did not include a sheet.");
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return parkerRosterRows(matrix, votingMethod);
}
