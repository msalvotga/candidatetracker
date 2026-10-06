import { PDFParse } from "pdf-parse";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const BRAZOS_ROSTER_PAGE = "https://elections.brazoscountytx.gov/roster/";

function decodeHtml(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8211;/gi, "-")
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

/** A day written as MM/DD/YYYY or MM-DD-YYYY. File names use the dashed form. */
export function brazosDateFromText(text) {
  const source = String(text ?? "");
  const slash = source.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/);
  if (slash) return calendarDate(slash[3], slash[1], slash[2]);
  const dashed = [...source.matchAll(/(\d{2})-(\d{2})-(20\d{2})/g)].at(-1);
  if (dashed) return calendarDate(dashed[3], dashed[1], dashed[2]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return source;
  return null;
}

function brazosVotingMethod(text) {
  const blob = String(text ?? "");
  if (/in[-\s]?person|personal\s+appearance/i.test(blob)) return "EV";
  if (/\bmail/i.test(blob)) return "AB";
  return null;
}

/** Rosters under the 2026 General/Special heading. Earlier elections on the page stay out. */
export function brazosGeneralSection(html) {
  const text = String(html ?? "");
  const start = text.search(/<h[1-4][^>]*>\s*2026 General\/Special Election\s*<\/h[1-4]>/i);
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.slice(40).search(/<h[1-4][^>]*>/i);
  return next > 0 ? rest.slice(0, next + 40) : rest;
}

/**
 * November 2026 general-election PDFs. The vote day is in the file name.
 * Duplicate links that share one file are kept once.
 */
export function brazosRosterLinks(html) {
  const found = [];
  const seen = new Set();
  for (const match of brazosGeneralSection(html).matchAll(/href="([^"]+\.pdf)"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = new URL(decodeHtml(match[1]), BRAZOS_ROSTER_PAGE).href;
    const text = decodeHtml(match[2]);
    const votingMethod = brazosVotingMethod(`${text} ${href}`);
    if (!votingMethod || seen.has(href)) continue;
    seen.add(href);
    found.push({
      href,
      text,
      voteDate: brazosDateFromText(href),
      votingMethod,
    });
  }
  found.sort((a, b) => (a.voteDate ?? "").localeCompare(b.voteDate ?? "") || a.href.localeCompare(b.href));
  return found;
}

/** Newest day, plus any earlier file whose day and method are not already stored. */
export function brazosRosterFilesToPull(files, storedKeys) {
  const have = new Set(storedKeys ?? []);
  if (!files?.length) return [];
  const latest = files.reduce((max, file) => ((file.voteDate ?? "") > max ? file.voteDate : max), "");
  return files.filter((file) => {
    if (!file.voteDate || file.voteDate === latest) return true;
    return !have.has(`${file.voteDate}|${file.votingMethod}`);
  });
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

function lineTexts(line) {
  return line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
}

/**
 * Brazos roster PDF. VUID is the voter id. There is no date on the row.
 * The first line states the day, for example "Mailed ballots received 09/30/2026".
 * When that line has no day, the file name is used.
 */
export function parseBrazosRosterPages(pages, { fallbackDate = null, votingMethod = "AB" } = {}) {
  const pageLines = (pages ?? []).map((items) => groupLines(items).sort((a, b) => a.y - b.y));
  let voteDate = null;
  for (const line of pageLines[0] ?? []) {
    const date = lineTexts(line).map((text) => brazosDateFromText(text)).find(Boolean);
    if (date) {
      voteDate = date;
      break;
    }
  }
  if (!voteDate) voteDate = brazosDateFromText(fallbackDate);
  const rows = [];
  const seen = new Set();
  let skippedMissingVuid = 0;
  for (const lines of pageLines) {
    for (const line of lines) {
      const texts = lineTexts(line);
      if (texts.some((text) => /^vuid$/i.test(text))) continue;
      const vuid = texts.find((text) => /^\d{8,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
      const datedLine = texts.map((text) => brazosDateFromText(text)).find(Boolean);
      if (!vuid) {
        if (datedLine && datedLine !== voteDate) {
          skippedMissingVuid += 1;
        }
        continue;
      }
      if (!voteDate || seen.has(vuid)) continue;
      seen.add(vuid);
      rows.push({ vuid, activityDate: voteDate, votingMethod });
    }
  }
  const missingVuidDays = voteDate && skippedMissingVuid ? [{ date: voteDate, missingVuid: skippedMissingVuid }] : [];
  return { rows, voteDate, skippedMissingVuid, missingVuidDays };
}

export async function parseBrazosRosterPdf(buffer, options) {
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
    return parseBrazosRosterPages(pages, options);
  } finally {
    await parser.destroy();
  }
}
