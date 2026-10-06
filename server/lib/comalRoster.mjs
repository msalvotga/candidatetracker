import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const COMAL_ROSTER_PAGE = "https://www.comalcounty.gov/264/Archived-Data";

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

function calendarDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Link labels look like "10-02-2026, GENERAL ELECTION BBM RETD". */
export function comalLinkDate(name) {
  const match = String(name ?? "").match(/(\d{2})-(\d{2})-(20\d{2})/);
  if (!match) return null;
  return calendarDate(match[3], match[1], match[2]);
}

/** Daily general-election mail PDFs. ISD and city rosters on the same list are left alone. */
export function comalMailRosterLinks(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,240}?)<\/a>/gi)) {
    const text = decodeHtml(match[2]);
    const labeled = text.match(/^(\d{2}-\d{2}-20\d{2}),\s*GENERAL ELECTION BBM RETD\b/i);
    if (!labeled) continue;
    const voteDate = comalLinkDate(labeled[1]);
    if (!voteDate) continue;
    const href = new URL(decodeHtml(match[1]), COMAL_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push({ href, text, voteDate, votingMethod: "AB" });
  }
  found.sort((a, b) => a.voteDate.localeCompare(b.voteDate) || a.href.localeCompare(b.href));
  return found;
}

/** Newest labeled day, plus any earlier day that does not already have stored voters. */
export function comalRosterFilesToPull(files, datesWithVoters) {
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
  return lines;
}

/**
 * Comal general-election mail PDF. Vuid is the voter id. Ballot Returned Date is the vote date.
 */
export function parseComalRosterPages(pages, { fallbackDate = null } = {}) {
  const fallback = comalLinkDate(fallbackDate) || (/^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDate ?? "")) ? fallbackDate : null);
  const rows = [];
  const seen = new Set();
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => /^vuid$/i.test(text))) continue;
      const vuid = texts.find((text) => /^\d{8,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
      const voteDate = texts.map((text) => parseIsoDate(text)).find(Boolean) || null;
      if (!vuid && !voteDate) continue;
      if (!vuid) {
        skippedMissingVuid += 1;
        if (voteDate) missingByDate.set(voteDate, (missingByDate.get(voteDate) ?? 0) + 1);
        continue;
      }
      const date = voteDate || fallback;
      if (!date || seen.has(`${vuid}|${date}`)) continue;
      seen.add(`${vuid}|${date}`);
      rows.push({ vuid, activityDate: date, votingMethod: "AB" });
    }
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, missingVuidDays };
}

export async function parseComalRosterPdf(buffer, options) {
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
    return parseComalRosterPages(pages, options);
  } finally {
    await parser.destroy();
  }
}
