import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const TOM_GREEN_ROSTER_PAGE = "https://www.tomgreencountytx.gov/page/ele.VotingRosters";

const FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/pdf,*/*",
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

function generalSection(html) {
  const source = String(html ?? "");
  const start = source.search(/11\/3\/2026\s+General Election/i);
  if (start < 0) return "";
  const rest = source.slice(start);
  const end = rest.slice(30).search(/_{20,}/);
  return end < 0 ? rest : rest.slice(0, 30 + end);
}

function methodFrom(text) {
  const hits = [];
  const mail = text.search(/absentee|ballot by mail|\bbbm\b|\bmail\b/i);
  const election = text.search(/election day/i);
  const early = text.search(/early vot/i);
  if (mail >= 0) hits.push({ at: mail, method: "AB" });
  if (election >= 0) hits.push({ at: election, method: "ED" });
  if (early >= 0) hits.push({ at: early, method: "EV" });
  hits.sort((a, b) => b.at - a.at);
  return hits[0]?.method ?? "EV";
}

/**
 * PDF links under the 11/3/2026 General Election heading. The county replaces the file, so the
 * address and the date in the label change. Older elections on the same page are left alone.
 */
export function tomGreenRosterLinks(html) {
  const section = generalSection(html);
  const found = [];
  const seen = new Set();
  for (const match of section.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    if (!/\.pdf(?:$|\?)/i.test(href)) continue;
    const absolute = new URL(href, TOM_GREEN_ROSTER_PAGE).href;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = decodeHtml(match[2]);
    const before = decodeHtml(section.slice(Math.max(0, match.index - 240), match.index));
    found.push({
      href: absolute,
      text,
      votingMethod: methodFrom(`${before} ${text}`),
    });
  }
  return found;
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

/**
 * Tom Green roster PDF. VUID is the voter id. The ballot returned column is the vote date,
 * often printed as M/D/YY.
 */
export function parseTomGreenRosterPages(pages, votingMethod = "EV") {
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => /^vuid$/i.test(text))) continue;
      const vuid = texts.find((text) => /^\d{8,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
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
      rows.push({ vuid, activityDate: voteDate, votingMethod });
    }
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}

export async function parseTomGreenRosterPdf(buffer, votingMethod = "EV") {
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
    return parseTomGreenRosterPages(pages, votingMethod);
  } finally {
    await parser.destroy();
  }
}

export { FETCH_HEADERS as TOM_GREEN_FETCH_HEADERS };
