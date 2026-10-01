import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const BEXAR_ROSTER_PAGE = "https://elections.bexar.gov/DocumentCenter/Index/245";
export const BEXAR_FOLDER_ID = "245";
const BEXAR_ORIGIN = "https://elections.bexar.gov";

function documentName(doc) {
  return String(doc?.DisplayName ?? doc?.Name ?? "").replace(/\s+/g, " ").trim();
}

/** The vote or mail date is in the link name, never the upload time. */
export function bexarRosterDateFromName(name) {
  const text = String(name ?? "");
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return parseIsoDate(date);
  }
  return parseIsoDate(text);
}

export function bexarRosterKind(name) {
  const text = String(name ?? "");
  if (/early\s*vot|in[-\s]?person|election\s*day/i.test(text)) return "EV";
  if (/mail|abbm|absentee|\bbbm\b/i.test(text)) return "AB";
  return null;
}

export function bexarRosterDocuments(documents) {
  const files = [];
  for (const doc of documents ?? []) {
    if (!/pdf/i.test(String(doc?.FileType ?? ""))) continue;
    const text = documentName(doc);
    const voteDate = bexarRosterDateFromName(text) || bexarRosterDateFromName(doc?.URL);
    const votingMethod = bexarRosterKind(text) || bexarRosterKind(doc?.URL);
    if (!voteDate || !votingMethod || !doc?.URL) continue;
    files.push({
      href: new URL(doc.URL, BEXAR_ORIGIN).href,
      text,
      voteDate,
      votingMethod,
    });
  }
  files.sort((a, b) => a.voteDate.localeCompare(b.voteDate) || a.text.localeCompare(b.text));
  return files;
}

/** Newest file by the date in its name, plus any earlier day that has no stored voters. */
export function bexarRosterFilesToPull(files, datesWithVoters) {
  const have = new Set(datesWithVoters ?? []);
  if (!files?.length) return [];
  const latest = files.reduce((max, file) => (file.voteDate > max ? file.voteDate : max), "");
  return files.filter((file) => file.voteDate === latest || !have.has(file.voteDate));
}

function groupLines(items) {
  const lines = [];
  for (const item of items) {
    const y = Number(item.y);
    const existing = lines.find((line) => Math.abs(line.y - y) <= 2);
    if (existing) existing.items.push(item);
    else lines.push({ y, items: [item] });
  }
  lines.sort((a, b) => a.y - b.y);
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function columnIndex(x, headers) {
  let index = 0;
  for (let i = 0; i < headers.length; i += 1) {
    if (x + 8 >= headers[i].x) index = i;
  }
  return index;
}

function isDateHeader(label) {
  return /received\s*date|ballot\s*received/i.test(label);
}

/**
 * Bexar roster PDF. The VUID is the first column. The date column is labeled
 * Ballot Received Date or Received Date, so a shorter Name / Received Date layout still reads.
 */
export function parseBexarRosterPages(pages, { votingMethod = "AB", fallbackDate = null } = {}) {
  const rows = [];
  let skippedMissingDate = 0;
  let headers = null;
  let vuidIndex = 0;
  let dateIndex = -1;
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      if (line.items.some((item) => item.str.trim().toUpperCase() === "VUID")) {
        headers = line.items.map((item) => ({ x: item.x, label: item.str.trim() }));
        vuidIndex = headers.findIndex((header) => header.label.toUpperCase() === "VUID");
        dateIndex = headers.findIndex((header) => isDateHeader(header.label));
        continue;
      }
      if (!headers || vuidIndex < 0) continue;
      const cells = Array.from({ length: headers.length }, () => []);
      for (const item of line.items) {
        cells[columnIndex(item.x, headers)].push(item.str.trim());
      }
      const vuid = cells[vuidIndex].join("").replace(/\s+/g, "");
      const voteDate = (dateIndex >= 0 ? parseIsoDate(cells[dateIndex]?.join(" ") ?? "") : null) || fallbackDate;
      if (!/^\d{8,}$/.test(vuid)) continue;
      if (!voteDate) {
        skippedMissingDate += 1;
        continue;
      }
      rows.push({ vuid, activityDate: voteDate, votingMethod });
    }
  }
  return { rows, skippedMissingDate };
}

export async function parseBexarAbbmPdf(buffer, options) {
  assertLikelyPdf(buffer, {});
  const parser = new PDFParse({ data: buffer });
  try {
    const doc = await parser.load();
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push(
        content.items
          .filter((item) => item.str && String(item.str).trim())
          .map((item) => {
            const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            return { str: String(item.str), x, y };
          }),
      );
      page.cleanup();
    }
    return parseBexarRosterPages(pages, options);
  } finally {
    await parser.destroy();
  }
}
