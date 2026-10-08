import { parse } from "csv-parse/sync";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const EL_PASO_ROSTER_PAGE = "https://epcountyvotestx.gov/voter-information/current-election";

export const EL_PASO_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,text/csv,*/*",
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

function novemberRosterSection(html) {
  const source = String(html ?? "");
  const rosterAt = source.search(/id="early-voting-rosters"/i);
  const from = rosterAt < 0 ? source : source.slice(rosterAt);
  const start = from.search(/November\s+2026\s+General/i);
  if (start < 0) return "";
  const rest = from.slice(start);
  const end = rest.slice(50).search(/<h[23]\b|id="collapse/i);
  return end < 0 ? rest : rest.slice(0, 50 + end);
}

function methodFrom(text) {
  const hits = [];
  const mail = text.search(/ballot by mail|\bmail\b/i);
  const election = text.search(/election day/i);
  const early = text.search(/early vot|in person|personal appearance/i);
  if (mail >= 0) hits.push({ at: mail, method: "AB" });
  if (election >= 0) hits.push({ at: election, method: "ED" });
  if (early >= 0) hits.push({ at: early, method: "EV" });
  hits.sort((a, b) => b.at - a.at);
  return hits[0]?.method ?? "AB";
}

/**
 * CSV links under November 2026 General & Special Election in Early Voting Rosters.
 * Each day is its own file. Older sections on the page are left alone.
 */
export function elPasoRosterLinks(html) {
  const section = novemberRosterSection(html);
  const found = [];
  const seen = new Set();
  for (const match of section.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const hrefRaw = decodeHtml(match[1]);
    if (!/\.csv(?:$|\?)/i.test(hrefRaw)) continue;
    const href = new URL(hrefRaw, EL_PASO_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push({ href, text: decodeHtml(match[2]), votingMethod: methodFrom(decodeHtml(match[2])) });
  }
  return found;
}

function columnKey(row, pattern) {
  return Object.keys(row ?? {}).find((key) => pattern.test(String(key).trim())) ?? null;
}

function voteDate(value) {
  const iso = parseIsoDate(value);
  if (!iso) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return iso;
}

/**
 * El Paso roster CSV. VUID is the voter id. Received Date is the vote date.
 * A Mail Date column, when the file has one, is not the vote date.
 */
export function parseElPasoRosterCsv(text, votingMethod = "AB") {
  const table = parse(String(text ?? ""), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  if (table.length && !columnKey(table[0], /vuid/i) && !columnKey(table[0], /received\s*date|^date$/i)) {
    throw new Error("El Paso roster did not include a VUID and a received date.");
  }
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table) {
    const vuid = String(raw[columnKey(raw, /vuid/i)] ?? "")
      .trim()
      .replace(/\.0$/, "");
    const activityDate = voteDate(raw[columnKey(raw, /received\s*date|ballot\s*received|return\s*date|vote\s*date|^date$/i)]);
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      if (activityDate) missingByDate.set(activityDate, (missingByDate.get(activityDate) ?? 0) + 1);
      continue;
    }
    if (!activityDate) {
      skippedMissingDate += 1;
      continue;
    }
    const key = `${vuid}|${activityDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ vuid, activityDate, votingMethod });
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}
