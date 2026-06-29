import XLSX from "xlsx";
import {
  canonicalCountyKey,
  canonicalCountyName,
  normalizeCountyMargin,
  normalizeCountyShare,
} from "./countyElection.mjs";

/** @deprecated use canonicalCountyKey from countyElection.mjs */
export function normalizeCountyKey(name) {
  return canonicalCountyKey(name);
}

function parseNum(value) {
  if (value === "" || value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const num = Number(String(value).replace(/[$,%\s]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function findHeaderIndex(rows, matcher) {
  for (let i = 0; i < Math.min(rows.length, 4); i += 1) {
    const row = rows[i] ?? [];
    for (let c = 0; c < row.length; c += 1) {
      const text = String(row[c] ?? "").trim().toLowerCase();
      if (matcher(text)) return { rowIndex: i, colIndex: c };
    }
  }
  return null;
}

function skipCounty(name) {
  const value = String(name ?? "").trim();
  if (!value) return true;
  return /all\s+count/i.test(value);
}

function computeMargin(gopPct, demPct, rawMargin) {
  const gop = normalizeCountyShare(gopPct);
  const dem = normalizeCountyShare(demPct);
  return normalizeCountyMargin(rawMargin, gop, dem);
}

function finalizeCountyRow(countyName, fields) {
  const county_name = canonicalCountyName(countyName);
  return {
    county_name,
    county_key: canonicalCountyKey(county_name),
    margin: fields.margin,
    gop_pct: normalizeCountyShare(fields.gop_pct),
    dem_pct: normalizeCountyShare(fields.dem_pct),
    gop_votes: fields.gop_votes ?? null,
    dem_votes: fields.dem_votes ?? null,
  };
}

function parsePres2024(rows) {
  const marginCol = findHeaderIndex(rows, (t) => t === "+/-" || t.includes("+/-"));
  const trumpPctCol = findHeaderIndex(rows, (t) => t.includes("trump") && t.includes("%"));
  const kamalaPctCol = findHeaderIndex(rows, (t) => t.includes("kamala") && t.includes("%"));
  const trumpVotesCol = findHeaderIndex(rows, (t) => t.includes("trump") && !t.includes("%"));
  const kamalaVotesCol = findHeaderIndex(rows, (t) => t.includes("kamala") && !t.includes("%"));

  const startRow = (marginCol?.rowIndex ?? trumpPctCol?.rowIndex ?? 0) + 1;
  const results = [];

  for (let i = startRow; i < rows.length; i += 1) {
    const row = rows[i];
    const countyName = String(row[0] ?? "").trim();
    if (skipCounty(countyName)) continue;

    const gopPct = trumpPctCol ? parseNum(row[trumpPctCol.colIndex]) : null;
    const demPct = kamalaPctCol ? parseNum(row[kamalaPctCol.colIndex]) : null;
    const margin = computeMargin(gopPct, demPct, marginCol ? row[marginCol.colIndex] : null);
    const gopVotes = trumpVotesCol ? parseNum(row[trumpVotesCol.colIndex + 1] ?? row[trumpVotesCol.colIndex]) : null;
    const demVotes = kamalaVotesCol ? parseNum(row[kamalaVotesCol.colIndex + 1] ?? row[kamalaVotesCol.colIndex]) : null;

    results.push(
      finalizeCountyRow(countyName, {
        margin,
        gop_pct: gopPct,
        dem_pct: demPct,
        gop_votes: gopVotes != null ? Math.round(gopVotes) : null,
        dem_votes: demVotes != null ? Math.round(demVotes) : null,
      })
    );
  }

  return results;
}

function parseCruz2024(rows) {
  const headerRow = rows.find((row) =>
    row.some((cell) => String(cell).toLowerCase().includes("cruz %"))
  );
  if (!headerRow) return [];

  const cruzPctCol = headerRow.findIndex((c) => String(c).toLowerCase().includes("cruz %"));
  const allredPctCol = headerRow.findIndex((c) => String(c).toLowerCase().includes("allred %"));
  const marginCol = headerRow.findIndex((c) => String(c).trim() === "+/-");
  const cruzVotesCol = headerRow.findIndex((c) => String(c).toLowerCase().includes("ted cruz"));
  const allredVotesCol = headerRow.findIndex((c) => String(c).toLowerCase().includes("colin allred"));

  const startRow = rows.indexOf(headerRow) + 1;
  const results = [];

  for (let i = startRow; i < rows.length; i += 1) {
    const row = rows[i];
    const countyName = String(row[0] ?? "").trim();
    if (skipCounty(countyName)) continue;

    const gopPct = cruzPctCol >= 0 ? parseNum(row[cruzPctCol]) : null;
    const demPct = allredPctCol >= 0 ? parseNum(row[allredPctCol]) : null;
    const margin = computeMargin(gopPct, demPct, marginCol >= 0 ? row[marginCol] : null);
    const gopVotes = cruzVotesCol >= 0 ? parseNum(row[cruzVotesCol + 2] ?? row[cruzVotesCol + 1]) : null;
    const demVotes = allredVotesCol >= 0 ? parseNum(row[allredVotesCol + 2] ?? row[allredVotesCol + 1]) : null;

    if (margin == null && gopPct == null && demPct == null) continue;

    results.push(
      finalizeCountyRow(countyName, {
        margin,
        gop_pct: gopPct,
        dem_pct: demPct,
        gop_votes: gopVotes != null ? Math.round(gopVotes) : null,
        dem_votes: demVotes != null ? Math.round(demVotes) : null,
      })
    );
  }

  return results;
}

function parseAbbott2022(rows) {
  const headerRow = rows.find((row) =>
    row.some((cell) => String(cell).toLowerCase().includes("abbott %"))
  );
  if (!headerRow) return [];

  const abbottPctCol = headerRow.findIndex((c) => String(c).toLowerCase().includes("abbott %"));
  const betoPctCol = headerRow.findIndex((c) => String(c).toLowerCase().includes("beto %"));
  const marginCol = headerRow.findIndex((c) => String(c).trim() === "+/-");

  const startRow = rows.indexOf(headerRow) + 1;
  const results = [];

  for (let i = startRow; i < rows.length; i += 1) {
    const row = rows[i];
    const countyName = String(row[0] ?? "").trim();
    if (skipCounty(countyName)) continue;

    const gopPct = abbottPctCol >= 0 ? parseNum(row[abbottPctCol]) : null;
    const demPct = betoPctCol >= 0 ? parseNum(row[betoPctCol]) : null;
    const margin = computeMargin(gopPct, demPct, marginCol >= 0 ? row[marginCol] : null);

    if (margin == null && gopPct == null && demPct == null) continue;

    results.push(
      finalizeCountyRow(countyName, {
        margin,
        gop_pct: gopPct,
        dem_pct: demPct,
        gop_votes: null,
        dem_votes: null,
      })
    );
  }

  return results;
}

const COUNTY_SHEETS = [
  { sheetName: "2024 Pres Results by Cnty", electionKey: "pres_2024", parse: parsePres2024 },
  { sheetName: "2024 US Sen Results by Cnty", electionKey: "cruz_2024", parse: parseCruz2024 },
  { sheetName: "2022 Gov Results by Cnty", electionKey: "abbott_2022", parse: parseAbbott2022 },
];

export async function importCountySheets(database, workbook) {
  const insert = database.prepare(`
    INSERT INTO county_election_results (
      election_key, county_name, county_key, margin, gop_pct, dem_pct, gop_votes, dem_votes
    ) VALUES (
      @electionKey, @county_name, @county_key, @margin, @gop_pct, @dem_pct, @gop_votes, @dem_votes
    )
    ON CONFLICT(election_key, county_key) DO UPDATE SET
      county_name = excluded.county_name,
      margin = excluded.margin,
      gop_pct = excluded.gop_pct,
      dem_pct = excluded.dem_pct,
      gop_votes = excluded.gop_votes,
      dem_votes = excluded.dem_votes
  `);

  const summary = {};

  for (const config of COUNTY_SHEETS) {
    const sheet = workbook.Sheets[config.sheetName];
    if (!sheet) {
      console.warn(`County sheet not found: ${config.sheetName}`);
      continue;
    }

    await database.prepare(`DELETE FROM county_election_results WHERE election_key = ?`).run(config.electionKey);

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    const parsed = config.parse(rows);

    const importMany = database.transaction(async (items) => {
      for (const item of items) {
        await insert.run({ electionKey: config.electionKey, ...item });
      }
    });
    await importMany(parsed);
    summary[config.electionKey] = parsed.length;
    console.log(`${config.sheetName}: ${parsed.length} counties`);
  }

  return summary;
}
