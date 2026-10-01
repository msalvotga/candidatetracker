import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const POTTER_ROSTER_PAGE = "https://www.pottercountytexasvotes.gov/voting-rosters";

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

export function potterRosterKind(label) {
  const text = String(label ?? "");
  if (/early\s+voting\s+roster/i.test(text)) return "EV";
  if (/mail\s+ballot\s+rosters?/i.test(text)) return "AB";
  return null;
}

/** PDF links whose visible label is the mail roster or the early-voting roster. The file address changes. */
export function potterRosterLinks(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    const text = decodeHtml(match[2]);
    if (!/\.pdf(?:$|\?)/i.test(href)) continue;
    const votingMethod = potterRosterKind(text);
    if (!votingMethod) continue;
    const absolute = new URL(href, POTTER_ROSTER_PAGE).href;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    found.push({ href: absolute, text, votingMethod });
  }
  found.sort((a, b) => a.votingMethod.localeCompare(b.votingMethod) || a.text.localeCompare(b.text));
  return found;
}

function groupLines(items) {
  const lines = [];
  for (const item of items) {
    const y = Number(item.y);
    const existing = lines.find((line) => Math.abs(line.y - y) <= 2);
    if (existing) existing.items.push(item);
    else lines.push({ y, items: [item] });
  }
  return lines;
}

/**
 * Potter roster PDF. A row number sits just left of the VUID, so the VUID is the long number
 * and the vote date is the Ballot Status Date.
 */
export function parsePotterRosterPages(pages, { votingMethod = "AB" } = {}) {
  const rows = [];
  let skippedMissingDate = 0;
  let skippedMissingVuid = 0;
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => text.toUpperCase() === "VUID")) continue;
      const vuid = texts.find((text) => /^\d{8,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
      const voteDate = texts.map((text) => parseIsoDate(text)).find(Boolean) ?? null;
      if (!vuid && !voteDate) continue;
      if (!vuid) {
        skippedMissingVuid += 1;
        continue;
      }
      if (!voteDate) {
        skippedMissingDate += 1;
        continue;
      }
      rows.push({ vuid, activityDate: voteDate, votingMethod });
    }
  }
  return { rows, skippedMissingDate, skippedMissingVuid };
}

export async function parsePotterRosterPdf(buffer, options) {
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
    return parsePotterRosterPages(pages, options);
  } finally {
    await parser.destroy();
  }
}
