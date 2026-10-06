import JSZip from "jszip";
import * as XLSX from "xlsx";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyZip } from "./zipFetchUtils.mjs";

export const ELLIS_ROSTER_PAGE = "https://www.elliscountytx.gov/629/Upcoming-Elections";

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

/** M/D/YY or an ISO date. */
export function ellisDateFromText(text) {
  const raw = String(text ?? "").trim();
  const iso = parseIsoDate(raw);
  if (iso) return iso;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) return null;
  const year = 2000 + Number(match[3]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

/** Vote date is the MMDDYY stamp at the end of the Excel file name, such as _100526.xlsx. */
export function ellisVoteDateFromFileName(name) {
  const match = String(name ?? "").match(/_(\d{2})(\d{2})(\d{2})(?=\.[A-Za-z0-9]+$|$)/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = 2000 + Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${match[1]}-${match[2]}`;
}

/** The Returned Ballots by Mail Roster Report. The document address changes when the file is replaced. */
export function ellisMailRosterLink(html) {
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    const text = decodeHtml(match[2]);
    if (!/returned ballots by mail roster/i.test(text)) continue;
    return { href: new URL(decodeHtml(match[1]), ELLIS_ROSTER_PAGE).href, text };
  }
  return null;
}

/**
 * Cumulative mail roster. VUID is the voter id. There is no date on each row.
 * Voters already stored for Ellis are left alone. New VUIDs get the date from the Excel file name.
 */
export function ellisRosterRows(matrix, voteDate, knownVuids) {
  const known = new Set(knownVuids ?? []);
  const date = ellisDateFromText(voteDate) || (/^\d{4}-\d{2}-\d{2}$/.test(String(voteDate ?? "")) ? voteDate : null);
  const table = matrix ?? [];
  let header = -1;
  let vuidColumn = -1;
  for (let index = 0; index < table.length; index += 1) {
    const column = (table[index] ?? []).findIndex((value) => /^vuid$/i.test(String(value ?? "").trim()));
    if (column >= 0) {
      header = index;
      vuidColumn = column;
      break;
    }
  }
  if (vuidColumn < 0 && table.some((row) => (row ?? []).some((value) => String(value ?? "").trim()))) {
    throw new Error("Ellis roster did not include a VUID column.");
  }
  const seen = new Set();
  const rows = [];
  let skippedMissingVuid = 0;
  for (const raw of table.slice(header + 1)) {
    const values = raw ?? [];
    if (!values.some((value) => String(value ?? "").trim())) continue;
    const vuid = String(values[vuidColumn] ?? "").trim();
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      continue;
    }
    if (seen.has(vuid) || known.has(vuid)) continue;
    seen.add(vuid);
    if (!date) continue;
    rows.push({ vuid, activityDate: date, votingMethod: "AB" });
  }
  const missingVuidDays = date && skippedMissingVuid ? [{ date, missingVuid: skippedMissingVuid }] : [];
  return { rows, voteDate: date, skippedMissingVuid, missingVuidDays };
}

export function parseEllisRosterWorkbook(buffer, fileName, knownVuids = []) {
  const voteDate = ellisVoteDateFromFileName(fileName);
  if (!voteDate) throw new Error("Ellis roster file name did not include an MMDDYY date.");
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return ellisRosterRows([], voteDate, knownVuids);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return ellisRosterRows(matrix, voteDate, knownVuids);
}

export async function parseEllisRosterZip(buffer, knownVuids) {
  assertLikelyZip(buffer, {});
  const zip = await JSZip.loadAsync(buffer);
  const name = Object.keys(zip.files).find((entry) => !zip.files[entry].dir && /\.xlsx$/i.test(entry));
  if (!name) throw new Error("Ellis roster ZIP did not contain an Excel file.");
  const voteDate = ellisVoteDateFromFileName(name);
  if (!voteDate) throw new Error("Ellis roster file name did not include an MMDDYY date.");
  const workbook = XLSX.read(await zip.files[name].async("nodebuffer"), { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Ellis roster workbook did not contain a sheet.");
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return ellisRosterRows(matrix, voteDate, knownVuids);
}
