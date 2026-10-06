import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const RANDALL_ROSTER_PAGE = "https://www.randallcounty.gov/166/Election-Administration";

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

/** Mail Ballot Roster on the election administration page. The document address changes when the file is replaced. */
export function randallMailRosterLink(html) {
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const text = decodeHtml(match[2]);
    if (!/^mail ballot roster$/i.test(text)) continue;
    return { href: new URL(decodeHtml(match[1]), RANDALL_ROSTER_PAGE).href, text, votingMethod: "AB" };
  }
  return null;
}

function voteDateFromText(text) {
  const iso = parseIsoDate(text);
  if (iso) return iso;
  const match = String(text ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) return null;
  const year = 2000 + Number(match[3]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
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

function vuidFromTexts(texts) {
  for (const text of texts) {
    const exact = text.replace(/\s+/g, "");
    if (/^\d{8,}$/.test(exact)) return exact;
    const lead = text.match(/^(\d{8,})\b/);
    if (lead) return lead[1];
  }
  return "";
}

/**
 * Randall mail ballot PDF. The VUID starts the name field. Ballot Received Date is the vote date.
 */
export function parseRandallRosterPages(pages) {
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => /^vuid$/i.test(text))) continue;
      const vuid = vuidFromTexts(texts);
      const voteDate = texts.map((text) => voteDateFromText(text)).find(Boolean) ?? null;
      if (!vuid && !voteDate) continue;
      if (!vuid) {
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
      rows.push({ vuid, activityDate: voteDate, votingMethod: "AB" });
    }
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}

export async function parseRandallRosterPdf(buffer) {
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
    return parseRandallRosterPages(pages);
  } finally {
    await parser.destroy();
  }
}
