import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

export const HIDALGO_ROSTER_PAGE =
  "https://www.hidalgocounty.us/3523/Unofficial-Early-Voting-Totals-Rosters";

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

function decodeFileToken(raw) {
  const text = String(raw ?? "").trim().replace(/^"|"$/g, "");
  if (!text) return "";
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/** The download name is on the response. The page link itself has no date stamp. */
export function hidalgoDownloadName(contentDisposition, fallbackUrl = "") {
  const header = String(contentDisposition ?? "");
  const star = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i);
  const plain = header.match(/filename\s*=\s*"([^"]+)"/i) || header.match(/filename\s*=\s*([^;]+)/i);
  const named = decodeFileToken(star?.[1] || plain?.[1]);
  if (named) return named;
  try {
    return decodeURIComponent(new URL(String(fallbackUrl)).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

/** Vote date is the YYYYMMDD stamp after the underscore. Extra digits after that are a time. */
export function hidalgoVoteDateFromFileName(name) {
  const match = String(name ?? "").match(/_(\d{8})\d*(?=\.[A-Za-z0-9]+$|$)/);
  if (!match) return null;
  const stamp = match[1];
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  if (year < 2024 || year > 2032) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

/** The Mail in Ballots file for this election. Other ballot links on the page are left alone. */
export function hidalgoMailRosterLink(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    const text = decodeHtml(match[2]);
    if (!/^mail[\s-]*in ballots\b/i.test(text)) continue;
    const href = new URL(decodeHtml(match[1]), HIDALGO_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push({ href, text, votingMethod: "AB" });
  }
  const current = found.filter((link) => /november[\s-]*3|2026/i.test(`${link.text} ${link.href}`));
  return (current[0] ?? found[0]) || null;
}

function vuidColumn(row) {
  return (row ?? []).findIndex((value) => /^vuid$/i.test(String(value ?? "").trim()));
}

/**
 * Cumulative mail roster. VUID is the voter id. There is no date on each row.
 * Voters already stored for Hidalgo are left alone. New VUIDs get the file-name date.
 */
export function hidalgoRosterRows(matrix, voteDate, knownVuids) {
  const known = new Set([...(knownVuids ?? [])].map((vuid) => String(vuid ?? "").trim()).filter(Boolean));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(voteDate ?? "")) ? voteDate : hidalgoVoteDateFromFileName(voteDate);
  const table = matrix ?? [];
  let header = -1;
  let column = -1;
  for (let index = 0; index < table.length; index += 1) {
    const found = vuidColumn(table[index]);
    if (found >= 0) {
      header = index;
      column = found;
      break;
    }
  }
  if (column < 0 && table.some((row) => (row ?? []).some((value) => String(value ?? "").trim()))) {
    throw new Error("Hidalgo roster did not include a VUID column.");
  }
  const seen = new Set();
  const rows = [];
  let skippedMissingVuid = 0;
  let alreadyStored = 0;
  for (const raw of table.slice(header + 1)) {
    const values = raw ?? [];
    if (!values.some((value) => String(value ?? "").trim())) continue;
    const vuid = String(values[column] ?? "").trim();
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      continue;
    }
    if (seen.has(vuid)) continue;
    seen.add(vuid);
    if (known.has(vuid)) {
      alreadyStored += 1;
      continue;
    }
    if (!date) continue;
    rows.push({ vuid, activityDate: date, votingMethod: "AB" });
  }
  const missingVuidDays = date && skippedMissingVuid ? [{ date, missingVuid: skippedMissingVuid }] : [];
  return { rows, voteDate: date, skippedMissingVuid, alreadyStored, missingVuidDays };
}

function matrixFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    if (matrix.some((row) => vuidColumn(row) >= 0)) return matrix;
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
}

function matrixFromCsv(buffer) {
  return parse(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), {
    bom: true,
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
}

export function parseHidalgoRosterFile(buffer, fileName, knownVuids) {
  const voteDate = hidalgoVoteDateFromFileName(fileName);
  if (!voteDate) {
    throw new Error("Hidalgo roster file name did not include a YYYYMMDD date after the underscore.");
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
  const workbook = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const matrix = workbook ? matrixFromWorkbook(bytes) : matrixFromCsv(bytes);
  return hidalgoRosterRows(matrix, voteDate, knownVuids);
}
