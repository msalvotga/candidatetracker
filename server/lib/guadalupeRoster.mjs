import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const GUADALUPE_ROSTER_PAGE = "https://www.guadalupetx.gov/page/elections.election1";

export const GUADALUPE_FETCH_HEADERS = {
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

function returnedSection(html) {
  const source = String(html ?? "");
  const start = source.search(/Returned Ballots Log/i);
  if (start < 0) return "";
  const rest = source.slice(start);
  const end = rest.search(/<\/div>\s*<\/div>/i);
  return end < 0 ? rest : rest.slice(0, end);
}

function methodFrom(text) {
  if (/mail|absentee|\bbbm\b/i.test(text)) return "AB";
  if (/election day/i.test(text)) return "ED";
  if (/early vot/i.test(text)) return "EV";
  return "AB";
}

/**
 * PDF links under Returned Ballots Log. The county replaces that file, so the label date changes.
 * The link text says whether the file is mail.
 */
export function guadalupeRosterLinks(html) {
  const section = returnedSection(html);
  const found = [];
  const seen = new Set();
  for (const match of section.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    if (!/\.pdf(?:$|\?)/i.test(href)) continue;
    const absolute = new URL(href, GUADALUPE_ROSTER_PAGE).href;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = decodeHtml(match[2]);
    found.push({ href: absolute, text, votingMethod: methodFrom(text) });
  }
  return found;
}

function voteDateFromText(text) {
  const iso = parseIsoDate(text);
  if (!iso) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return iso;
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
 * Guadalupe returned-ballots PDF. VUID is the voter id, including shorter ids printed in that column.
 * Date Rcv'd is the vote date.
 */
export function parseGuadalupeRosterPages(pages, votingMethod = "AB") {
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => /^vuid$/i.test(text))) continue;
      const vuid = texts.find((text) => /^\d{6,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
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

export async function parseGuadalupeRosterPdf(buffer, votingMethod = "AB") {
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
    return parseGuadalupeRosterPages(pages, votingMethod);
  } finally {
    await parser.destroy();
  }
}
