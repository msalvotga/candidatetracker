import { PDFParse } from "pdf-parse";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyPdf } from "./pdfFetchUtils.mjs";

export const BOWIE_ROSTER_PAGE = "https://www.bowiecounty.org/1239/Elections";

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

/** Link labels look like "BBM Received 9.22.2026". */
export function bowieReceivedDate(name) {
  const dotted = String(name ?? "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotted) return calendarDate(dotted[3], dotted[1], dotted[2]);
  const slashed = parseIsoDate(name);
  if (!slashed) return null;
  const [year, month, day] = slashed.split("-");
  return calendarDate(year, month, day);
}

/** The November 3, 2026 General Election tab. Other election tabs stay out of the pull. */
export function bowieNovemberSection(html) {
  const text = String(html ?? "");
  const nameAt = text.search(/data-tabname="November 3,\s*2026 General Election"/i);
  if (nameAt < 0) return "";
  const before = text.slice(Math.max(0, nameAt - 1200), nameAt);
  const controls = [...before.matchAll(/aria-controls="(tab[^"]+)"/gi)].pop();
  if (!controls) return "";
  const panelAt = text.indexOf(`id="${controls[1]}"`);
  if (panelAt < 0) return "";
  const rest = text.slice(panelAt);
  const next = rest.slice(200).search(/<div class="tabbedWidget cpTabPanel /i);
  return next > 0 ? rest.slice(0, next + 200) : rest;
}

/** Daily mail PDFs under the November 3, 2026 general election. */
export function bowieMailRosterLinks(html) {
  const section = bowieNovemberSection(html);
  const found = [];
  const seen = new Set();
  for (const match of section.matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const text = decodeHtml(match[2]);
    const labeled = text.match(/BBM\s+Received\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (!labeled) continue;
    const voteDate = bowieReceivedDate(labeled[1]);
    if (!voteDate) continue;
    const href = new URL(decodeHtml(match[1]), BOWIE_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push({ href, text, voteDate, votingMethod: "AB" });
  }
  found.sort((a, b) => a.voteDate.localeCompare(b.voteDate) || a.href.localeCompare(b.href));
  return found;
}

/** Newest labeled day, plus any earlier day that does not already have stored voters. */
export function bowieRosterFilesToPull(files, datesWithVoters) {
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
 * Bowie daily mail PDF. VUID is the voter id. Date Rec'd is the vote date.
 */
export function parseBowieRosterPages(pages, { fallbackDate = null } = {}) {
  const rows = [];
  const seen = new Set();
  let skippedMissingVuid = 0;
  const missingByDate = new Map();
  const fallback = bowieReceivedDate(fallbackDate) || (/^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDate ?? "")) ? fallbackDate : null);
  for (const items of pages ?? []) {
    for (const line of groupLines(items)) {
      const texts = line.items.map((item) => String(item.str ?? "").trim()).filter(Boolean);
      if (texts.some((text) => /^vuid$/i.test(text))) continue;
      const vuid = texts.find((text) => /^\d{8,}$/.test(text.replace(/\s+/g, "")))?.replace(/\s+/g, "") ?? "";
      const onPage = texts.map((text) => bowieReceivedDate(text)).find(Boolean) ?? null;
      if (!vuid && !onPage) continue;
      if (!vuid) {
        skippedMissingVuid += 1;
        missingByDate.set(onPage, (missingByDate.get(onPage) ?? 0) + 1);
        continue;
      }
      const voteDate = onPage || fallback;
      if (!voteDate || seen.has(`${vuid}|${voteDate}`)) continue;
      seen.add(`${vuid}|${voteDate}`);
      rows.push({ vuid, activityDate: voteDate, votingMethod: "AB" });
    }
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, missingVuidDays };
}

export async function parseBowieRosterPdf(buffer, options) {
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
    return parseBowieRosterPages(pages, options);
  } finally {
    await parser.destroy();
  }
}
