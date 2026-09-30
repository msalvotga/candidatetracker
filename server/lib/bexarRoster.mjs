import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const BEXAR_ROSTER_PAGE = "https://elections.bexar.gov/DocumentCenter/Index/245";
export const BEXAR_FOLDER_ID = "245";
const BEXAR_ORIGIN = "https://elections.bexar.gov";

function documentName(doc) {
  return String(doc?.DisplayName ?? doc?.Name ?? "").replace(/\s+/g, " ").trim();
}

function modifiedTime(doc) {
  const text = String(doc?.LastModifiedDateString ?? "");
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : 0;
}

/** The daily file is the November 3, 2026 general-election mail-ballot PDF in folder 245. */
export function bexarMailRosterDocument(documents) {
  const matches = (documents ?? []).filter((doc) => {
    const name = documentName(doc);
    const type = String(doc?.FileType ?? "");
    return /pdf/i.test(type) && /abbm|absentee|received mail ballots/i.test(name);
  });
  matches.sort((a, b) => modifiedTime(b) - modifiedTime(a));
  const doc = matches[0];
  if (!doc?.URL) return null;
  return {
    href: new URL(doc.URL, BEXAR_ORIGIN).href,
    text: documentName(doc),
  };
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

/**
 * Bexar ABBM PDF. Column 1 is the VUID. Column 6 is the ballot received date.
 * Empty name columns are skipped, so the date is found by its position on the page.
 */
export function parseBexarRosterPages(pages) {
  const rows = [];
  let skippedMissingDate = 0;
  let headers = null;
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      if (line.items.some((item) => item.str.trim().toUpperCase() === "VUID")) {
        headers = line.items.map((item) => ({ x: item.x, label: item.str.trim() }));
        continue;
      }
      if (!headers || headers.length < 6) continue;
      const cells = Array.from({ length: headers.length }, () => []);
      for (const item of line.items) {
        cells[columnIndex(item.x, headers)].push(item.str.trim());
      }
      const vuid = cells[0].join("").replace(/\s+/g, "");
      const voteDate = parseIsoDate(cells[5]?.join(" ") ?? "");
      if (!/^\d{8,}$/.test(vuid)) continue;
      if (!voteDate) {
        skippedMissingDate += 1;
        continue;
      }
      rows.push({ vuid, activityDate: voteDate, votingMethod: "AB" });
    }
  }
  return { rows, skippedMissingDate };
}

export async function parseBexarAbbmPdf(buffer) {
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
    return parseBexarRosterPages(pages);
  } finally {
    await parser.destroy();
  }
}
