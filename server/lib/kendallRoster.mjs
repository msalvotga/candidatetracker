import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const KENDALL_ROSTER_PAGE = "https://www.kendallcountytx.gov/262/Current-Election-Information";

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

/** The "as of" date is in the link name and changes when the county posts a new file. */
export function kendallAsOfDate(name) {
  const match = String(name ?? "").match(/as of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  return match ? parseIsoDate(match[1]) : null;
}

/** Newest November 3 returned-ballots roster. Older elections on the same page are left alone. */
export function kendallReturnedRosterLink(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    const text = decodeHtml(match[2]);
    if (!/returned ballots roster/i.test(text)) continue;
    if (!/november\s+3/i.test(text)) continue;
    const absolute = new URL(href, KENDALL_ROSTER_PAGE).href;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    found.push({
      href: absolute,
      text,
      asOf: kendallAsOfDate(text) || kendallAsOfDate(href),
      votingMethod: "AB",
    });
  }
  found.sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? "") || a.text.localeCompare(b.text));
  return found[0] ?? null;
}

function groupLines(items) {
  const lines = [];
  for (const item of items) {
    const y = Number(item.y);
    const existing = lines.find((line) => Math.abs(line.y - y) <= 4);
    if (existing) existing.items.push(item);
    else lines.push({ y, items: [item] });
  }
  return lines;
}

/**
 * Kendall returned-ballot PDF. VUID is the voter id. DATE BALLOT RECEIVED is the vote date.
 * Those two fields sit a few pixels apart on the same row.
 */
export function parseKendallRosterPages(pages) {
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => /^vuid$/i.test(text))) continue;
      const vuid = texts.find((text) => /^\d{8,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
      const voteDate = texts.map((text) => parseIsoDate(text)).find(Boolean) ?? null;
      if (!vuid && !voteDate) continue;
      if (!vuid) {
        skippedMissingVuid += 1;
        if (voteDate) missingByDate.set(voteDate, (missingByDate.get(voteDate) ?? 0) + 1);
        continue;
      }
      if (!voteDate) continue;
      rows.push({ vuid, activityDate: voteDate, votingMethod: "AB" });
    }
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, missingVuidDays };
}

export async function parseKendallRosterPdf(buffer) {
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
    return parseKendallRosterPages(pages);
  } finally {
    await parser.destroy();
  }
}
