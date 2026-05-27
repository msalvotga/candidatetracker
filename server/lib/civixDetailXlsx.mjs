import JSZip from "jszip";
import * as XLSX from "xlsx";
import { assertLikelyZip } from "./zipFetchUtils.mjs";

function asText(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function asNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function isNumericLike(v) {
  const s = asText(v);
  if (!s) return false;
  return /^-?\d[\d,]*(\.\d+)?$/.test(s);
}

function isVoteTypeLabel(v) {
  const s = asText(v).toLowerCase();
  if (!s) return "";
  if (/\babsentee\b|\bmail\b/.test(s)) return "absentee";
  if (/\bearly\b/.test(s)) return "early";
  if (/\belection\s*day\b/.test(s)) return "election_day";
  if (s === "election") return "election_day";
  if (/\beday\b/.test(s) && !/\bearly\b/.test(s)) return "election_day";
  if (/\btotal\b/.test(s)) return "total";
  return "";
}

function isGenericHeader(text) {
  const s = asText(text).toLowerCase();
  if (!s) return true;
  if (isNumericLike(s)) return true;
  return (
    /\bcontest\b|\bpage\b|\bprecinct\b|\bregistered\b|\bturnout\b|\bballot\b|\breport\b/.test(s) ||
    isVoteTypeLabel(s) !== ""
  );
}

function sheetToMatrix(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
}

function matrixCell(matrix, r, c) {
  return asText(matrix?.[r]?.[c]);
}

function resolveMergedCellText(matrix, merge) {
  const v = matrixCell(matrix, merge.s.r, merge.s.c);
  if (v) return v;
  for (let r = merge.s.r; r <= merge.e.r; r++) {
    for (let c = merge.s.c; c <= merge.e.c; c++) {
      const x = matrixCell(matrix, r, c);
      if (x) return x;
    }
  }
  return "";
}

function parseTocEntries(workbook) {
  const tocName = workbook.SheetNames[0];
  const ws = workbook.Sheets[tocName];
  if (!ws) return [];
  const matrix = sheetToMatrix(ws);
  if (!matrix.length) return [];

  let pageCol = -1;
  let contestCol = -1;
  let headerRow = -1;
  for (let r = 0; r < Math.min(20, matrix.length); r++) {
    const row = matrix[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const v = asText(row[c]).toLowerCase();
      if (pageCol < 0 && /\bpage\b|\btab\b|\bsheet\b/.test(v)) pageCol = c;
      if (contestCol < 0 && /\bcontest\b|\brace\b/.test(v)) contestCol = c;
    }
    if (pageCol >= 0 && contestCol >= 0) {
      headerRow = r;
      break;
    }
  }

  if (headerRow < 0 || pageCol < 0 || contestCol < 0) return [];

  const entries = [];
  for (let r = headerRow + 1; r < matrix.length; r++) {
    const pageRaw = asText(matrix[r]?.[pageCol]);
    const contestName = asText(matrix[r]?.[contestCol]);
    if (!pageRaw && !contestName) continue;
    const pageNum = Number(pageRaw.replace(/[^\d]/g, ""));
    if (!contestName) continue;
    entries.push({
      pageRaw,
      pageNum: Number.isFinite(pageNum) && pageNum > 0 ? pageNum : null,
      contestName,
    });
  }
  return entries;
}

function resolveSheetNameForPage(workbook, tocEntry) {
  const names = workbook.SheetNames;
  const pageRaw = asText(tocEntry.pageRaw);
  if (pageRaw) {
    const exact = names.find((n) => asText(n) === pageRaw);
    if (exact) return exact;
  }
  if (tocEntry.pageNum != null) {
    const byName = names.find((n) => Number(asText(n).replace(/[^\d]/g, "")) === tocEntry.pageNum);
    if (byName) return byName;
    const byIndex = names[tocEntry.pageNum - 1];
    if (byIndex) return byIndex;
  }
  return null;
}

function buildCandidateColumns(ws, matrix) {
  const merges = ws["!merges"] ?? [];
  const candidateByCol = new Map();

  for (const merge of merges) {
    if (merge.e.c <= merge.s.c) continue;
    const text = resolveMergedCellText(matrix, merge);
    if (!text || isGenericHeader(text)) continue;
    for (let c = merge.s.c; c <= merge.e.c; c++) {
      candidateByCol.set(c, text);
    }
  }

  const maxCols = Math.max(0, ...matrix.map((r) => (Array.isArray(r) ? r.length : 0)));
  for (let c = 0; c < maxCols; c++) {
    if (candidateByCol.has(c)) continue;
    for (let r = 0; r < Math.min(3, matrix.length); r++) {
      const v = matrixCell(matrix, r, c);
      if (!v || isGenericHeader(v)) continue;
      candidateByCol.set(c, v);
      break;
    }
  }
  return candidateByCol;
}

function buildVoteTypeColumns(matrix) {
  const voteTypeByCol = new Map();
  const scanRows = Math.min(16, matrix.length);
  const maxCols = Math.max(0, ...matrix.map((r) => (Array.isArray(r) ? r.length : 0)));
  for (let c = 0; c < maxCols; c++) {
    for (let r = 0; r < scanRows; r++) {
      const vt = isVoteTypeLabel(matrixCell(matrix, r, c));
      if (!vt) continue;
      voteTypeByCol.set(c, vt);
      break;
    }
  }
  return voteTypeByCol;
}

function detectLikelyTotalRows(matrix, candidateByCol, voteTypeByCol) {
  const rows = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const rowText = row.map((x) => asText(x).toLowerCase()).join(" ");
    const firstCell = asText(row[0]).toLowerCase();
    if (!/\btotal\b/.test(rowText) || !/^total\b/.test(firstCell)) continue;
    let score = 0;
    for (let c = 0; c < row.length; c++) {
      if (!candidateByCol.get(c) || !voteTypeByCol.get(c)) continue;
      if (isNumericLike(row[c])) score += 1;
    }
    if (score > 0) rows.push({ rowIndex: r, score });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

function parseContestSheetRows(ws, fallbackContestName = "") {
  const matrix = sheetToMatrix(ws);
  if (!matrix.length) return [];
  const contestName = matrixCell(matrix, 0, 0) || asText(fallbackContestName);
  if (!contestName) return [];

  const candidateByCol = buildCandidateColumns(ws, matrix);
  const voteTypeByCol = buildVoteTypeColumns(matrix);
  if (!candidateByCol.size || !voteTypeByCol.size) return [];

  const byCandidate = new Map();
  const totalRows = detectLikelyTotalRows(matrix, candidateByCol, voteTypeByCol);
  const rowIndexesToUse =
    totalRows.length > 0 ? new Set([totalRows[0].rowIndex]) : new Set(Array.from({ length: matrix.length }, (_, i) => i));

  for (let r = 0; r < matrix.length; r++) {
    if (!rowIndexesToUse.has(r)) continue;
    const row = matrix[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const candidateName = asText(candidateByCol.get(c));
      const vt = voteTypeByCol.get(c);
      if (!candidateName || !vt) continue;
      if (isNumericLike(candidateName)) continue;
      const value = asNum(row[c]);
      const cur = byCandidate.get(candidateName) ?? { absentee: 0, early: 0, election_day: 0, total: 0 };
      if (vt === "absentee") cur.absentee += value;
      else if (vt === "early") cur.early += value;
      else if (vt === "election_day") cur.election_day += value;
      else if (vt === "total") cur.total += value;
      byCandidate.set(candidateName, cur);
    }
  }

  const rows = [];
  for (const [choiceName, v] of byCandidate.entries()) {
    const earlyVotes = v.absentee + v.early;
    const electionDayVotes = v.election_day;
    const totalVotes = v.total > 0 ? v.total : earlyVotes + electionDayVotes;
    rows.push({
      lineNumber: 0,
      contestName,
      choiceName,
      partyName: "",
      earlyVotes,
      electionDayVotes,
      totalVotes,
      percentOfVotes: "",
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal: 0,
      precinctReporting: 0,
      overVotes: 0,
      underVotes: 0,
    });
  }
  return rows;
}

function isSkippedSheetName(name) {
  const s = asText(name).toLowerCase();
  return !s || s.includes("table of contents") || s === "registered voters";
}

/** Contest tabs only — race title always from A1 (TOC contest text is unreliable on some counties). */
function listContestSheetNames(workbook) {
  return workbook.SheetNames.filter((n) => !isSkippedSheetName(n));
}

export function normalizeDetailXlsxZipUrl(zipUrl) {
  const u = String(zipUrl ?? "").trim();
  if (!u) return u;
  return u.replace(/summary\.zip(\?.*)?$/i, "detailxlsx.zip$1");
}

async function fetchDetailXlsxWorkbook(zipUrl) {
  const res = await fetch(zipUrl, {
    headers: {
      Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
    },
  });
  if (!res.ok) throw new Error(`Civix detail xlsx zip HTTP ${res.status} (${zipUrl.slice(0, 80)}…)`);
  const buf = Buffer.from(await res.arrayBuffer());
  assertLikelyZip(buf, { url: zipUrl, contentType: res.headers.get("content-type") });
  const zip = await JSZip.loadAsync(buf);
  const xlsxEntry =
    zip.file("detail.xlsx") ??
    Object.values(zip.files).find((f) => !f.dir && /\.xlsx$/i.test(f.name));
  if (!xlsxEntry) throw new Error("No .xlsx file found inside detailxlsx.zip");
  const xlsxBuf = await xlsxEntry.async("nodebuffer");
  const workbook = XLSX.read(xlsxBuf, { type: "buffer", cellDates: false });
  return { workbook, xlsxEntryName: xlsxEntry.name };
}

export async function fetchCivixDetailXlsxAllContests(zipUrl) {
  const resolvedUrl = normalizeDetailXlsxZipUrl(zipUrl);
  const { workbook, xlsxEntryName } = await fetchDetailXlsxWorkbook(resolvedUrl);

  const rows = [];
  for (const sheetName of listContestSheetNames(workbook)) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;
    rows.push(...parseContestSheetRows(ws));
  }

  return {
    source: {
      id: "county-civix-detail-xlsx",
      type: "county",
      zipUrl: resolvedUrl,
      xlsxEntryName,
      tocSheetName: workbook.SheetNames[0] ?? "",
    },
    rows,
    totals: {
      candidateVotes: rows.reduce((n, r) => n + Number(r.totalVotes ?? 0), 0),
      registeredVoters: 0,
      ballotsCast: 0,
      precinctTotal: 0,
      precinctReporting: 0,
    },
    rowCount: rows.length,
  };
}
