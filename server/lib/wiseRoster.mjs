import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const WISE_ROSTER_PAGE = "https://co.wise.tx.us/315/Elections";

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

function voteDateFromText(text) {
  const iso = parseIsoDate(text);
  if (iso) return iso;
  const match = String(text ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) return null;
  const year = 2000 + Number(match[3]);
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The "received as of" date is in the link name, not the upload time. */
export function wiseReceivedAsOf(name) {
  const text = String(name ?? "");
  const dotted = text.match(/received\s+as\s+of\s+(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/i);
  if (dotted) {
    const year = dotted[3].length === 2 ? 2000 + Number(dotted[3]) : dotted[3];
    return `${year}-${dotted[1].padStart(2, "0")}-${dotted[2].padStart(2, "0")}`;
  }
  const compact = text.match(/received-as-of-(\d{2})(\d{2})(\d{4})/i);
  if (compact) return `${compact[3]}-${compact[1]}-${compact[2]}`;
  return null;
}

/** Newest November 3, 2026 early-voting-by-mail roster. The received-as-of date in the name changes. */
export function wiseMailRosterLink(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    const text = decodeHtml(match[2]);
    if (!/roster of early voting by mail/i.test(text)) continue;
    if (!/november\s+3,?\s+2026/i.test(text)) continue;
    const absolute = new URL(href, WISE_ROSTER_PAGE).href;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    found.push({
      href: absolute,
      text,
      asOf: wiseReceivedAsOf(text) || wiseReceivedAsOf(href),
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
    const existing = lines.find((line) => Math.abs(line.y - y) <= 2);
    if (existing) existing.items.push(item);
    else lines.push({ y, items: [item] });
  }
  return lines;
}

/**
 * Wise early-voting-by-mail PDF. VUID Number is the long voter id. Date is the vote date,
 * often printed as M/D/YY.
 */
export function parseWiseRosterPages(pages) {
  const rows = [];
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => /vuid/i.test(text))) continue;
      const vuid = texts.find((text) => /^\d{8,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
      const voteDate = texts.map((text) => voteDateFromText(text)).find(Boolean) ?? null;
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

export async function parseWiseRosterPdf(buffer) {
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
    return parseWiseRosterPages(pages);
  } finally {
    await parser.destroy();
  }
}
