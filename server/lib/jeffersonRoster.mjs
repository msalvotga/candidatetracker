import * as XLSX from "xlsx";

export const JEFFERSON_ROSTER_PAGE =
  "https://www.jeffcotxvotes.gov/elections/elections-dept/early-voting-history-received-mail-ballots/";

export const JEFFERSON_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
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
  const start = source.search(/November\s+3(?:rd)?\s*[-–]\s*General Election/i);
  if (start < 0) return "";
  const rest = source.slice(start);
  const end = rest.slice(40).search(/<h2\b/i);
  return end < 0 ? rest : rest.slice(0, 40 + end);
}

/** The vote date is the MMDDYYYY stamp in the last 8 characters of the file name, such as 10072026. */
export function jeffersonVoteDateFromFileName(name) {
  const base = String(name ?? "").split(/[?#]/)[0].split("/").pop() ?? "";
  const stem = base.replace(/\.[A-Za-z0-9]+$/, "");
  const match = stem.match(/(\d{2})(\d{2})(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function spreadsheetLinks(html, votingMethod) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/gi)) {
    const hrefRaw = decodeHtml(match[1]);
    if (!/\.xlsx?(?:$|[?#])/i.test(hrefRaw)) continue;
    const href = new URL(hrefRaw, JEFFERSON_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push({
      href,
      voteDate: jeffersonVoteDateFromFileName(href),
      votingMethod,
    });
  }
  return found;
}

/**
 * Spreadsheet links under November 3rd General Election. The mail roster is the file before
 * "Early Voting In Person". Later in-person links are early voting. Older elections on the page are ignored.
 */
export function jeffersonRosterLinks(html) {
  const section = generalSection(html);
  const splitAt = section.search(/early voting in person/i);
  const mailHtml = splitAt < 0 ? section : section.slice(0, splitAt);
  const earlyHtml = splitAt < 0 ? "" : section.slice(splitAt);
  const found = [...spreadsheetLinks(mailHtml, "AB"), ...spreadsheetLinks(earlyHtml, "EV")];
  found.sort((a, b) => String(a.voteDate).localeCompare(String(b.voteDate)) || a.href.localeCompare(b.href));
  return found;
}

function columnIndex(header, pattern) {
  return (header ?? []).findIndex((cell) => pattern.test(String(cell ?? "").trim()));
}

function thisElection(name) {
  const text = String(name ?? "").trim();
  if (!text) return true;
  return /2026/.test(text) && /november|general/i.test(text);
}

/**
 * Jefferson roster workbook. VUID is the voter id. There is no vote date on the row.
 * Voters already stored are left alone. A new VUID gets the date from the file name.
 * The known set is updated so a later file in the same pull does not store that VUID again.
 */
export function jeffersonRosterRows(matrix, voteDate, votingMethod, knownVuids) {
  const known = knownVuids instanceof Set ? knownVuids : new Set(knownVuids ?? []);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(voteDate ?? "")) ? voteDate : null;
  const table = matrix ?? [];
  let header = -1;
  let vuidColumn = -1;
  let electionColumn = -1;
  for (let index = 0; index < table.length; index += 1) {
    const row = table[index] ?? [];
    const vuid = columnIndex(row, /^vuid$/i);
    if (vuid >= 0) {
      header = index;
      vuidColumn = vuid;
      electionColumn = columnIndex(row, /election/i);
      break;
    }
  }
  if (vuidColumn < 0 && table.some((row) => (row ?? []).some((value) => String(value ?? "").trim()))) {
    throw new Error("Jefferson roster did not include a VUID column.");
  }
  const rows = [];
  let skippedMissingVuid = 0;
  for (const raw of table.slice(header + 1)) {
    const values = raw ?? [];
    if (!values.some((value) => String(value ?? "").trim())) continue;
    if (electionColumn >= 0 && !thisElection(values[electionColumn])) continue;
    const vuid = String(values[vuidColumn] ?? "")
      .trim()
      .replace(/\.0$/, "");
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      continue;
    }
    if (known.has(vuid)) continue;
    known.add(vuid);
    if (!date) continue;
    rows.push({ vuid, activityDate: date, votingMethod });
  }
  const missingVuidDays = date && skippedMissingVuid ? [{ date, missingVuid: skippedMissingVuid }] : [];
  return { rows, voteDate: date, skippedMissingVuid, missingVuidDays };
}

export function parseJeffersonRosterXls(buffer, fileName, votingMethod = "AB", knownVuids = []) {
  const voteDate = jeffersonVoteDateFromFileName(fileName);
  if (!voteDate) throw new Error("Jefferson roster file name did not end with an MMDDYYYY date.");
  const bytes = Buffer.from(buffer ?? []);
  const head = bytes.subarray(0, 2).toString("utf8");
  if (head !== "PK" && bytes[0] !== 0xd0) {
    throw new Error("Jefferson roster link was not an Excel file.");
  }
  const book = XLSX.read(bytes, { type: "buffer", cellDates: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error("Jefferson roster workbook did not include a sheet.");
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return jeffersonRosterRows(matrix, voteDate, votingMethod, knownVuids);
}
