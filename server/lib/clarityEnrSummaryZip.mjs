import JSZip from "jszip";
import { parse } from "csv-parse/sync";
import { assertLikelyZip } from "./zipFetchUtils.mjs";

/**
 * Shared ENR Clarity pipeline: summary.zip → summary.csv.
 * County ingest uses **all contests** in the CSV; race alignment happens when combining totals, not here.
 */
async function fetchSummaryCsvRowsFromZip(zipUrl) {
  const res = await fetch(zipUrl, {
    headers: {
      Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ElectionNightTracker/1",
    },
  });
  if (!res.ok) throw new Error(`Clarity summary zip HTTP ${res.status} (${zipUrl.slice(0, 80)}…)`);

  const buf = Buffer.from(await res.arrayBuffer());
  assertLikelyZip(buf, { url: zipUrl, contentType: res.headers.get("content-type") });
  const zip = await JSZip.loadAsync(buf);
  const summary = zip.file("summary.csv") ?? Object.values(zip.files).find((f) => /summary\.csv$/i.test(f.name));
  if (!summary) throw new Error("summary.csv not found in Clarity summary.zip");

  const csvText = await summary.async("string");
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function asNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function mapClarityCsvRow(r) {
  return {
    lineNumber: asNum(r["line number"]),
    contestName: String(r["contest name"] ?? ""),
    choiceName: String(r["choice name"] ?? ""),
    partyName: String(r["party name"] ?? ""),
    earlyVotes: 0,
    electionDayVotes: 0,
    totalVotes: asNum(r["total votes"]),
    percentOfVotes: String(r["percent of votes"] ?? ""),
    registeredVoters: asNum(r["registered voters"]),
    ballotsCast: asNum(r["ballots cast"]),
    precinctTotal: asNum(r["num Precinct total"]),
    precinctReporting: asNum(r["num Precinct rptg"]),
    overVotes: asNum(r["over votes"]),
    underVotes: asNum(r["under votes"]),
  };
}

/**
 * Full county ingest: every contest/choice row in summary.csv (same URL shape for all Clarity ENR counties).
 */
export async function fetchClarityEnrSummaryZipAllContests(zipUrl) {
  const rawRows = await fetchSummaryCsvRowsFromZip(zipUrl);
  const mapped = rawRows.map((r) => mapClarityCsvRow(r));
  return {
    source: {
      id: "county-clarity-enr",
      type: "county",
      zipUrl,
    },
    rows: mapped,
    totals: {
      candidateVotes: mapped.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: mapped[0]?.registeredVoters ?? 0,
      ballotsCast: mapped[0]?.ballotsCast ?? 0,
      precinctTotal: mapped[0]?.precinctTotal ?? 0,
      precinctReporting: mapped[0]?.precinctReporting ?? 0,
    },
    rowCount: mapped.length,
  };
}

/**
 * Filter to one contest — used only by legacy county SD4 JSON probe routes (narrow slice for debugging).
 * @param {string} zipUrl
 * @param {string} contestNameExact Exact contest title cell in summary.csv for one race.
 * @param {{ id: string; county: string }} sourceMeta
 */
export async function fetchClarityEnrSd4SummaryFromZip(zipUrl, contestNameExact, sourceMeta) {
  const rows = await fetchSummaryCsvRowsFromZip(zipUrl);
  const filtered = rows.filter((r) => String(r["contest name"] ?? "").trim() === contestNameExact);
  const mapped = filtered.map((r) => mapClarityCsvRow(r));

  return {
    source: {
      id: sourceMeta.id,
      type: "county",
      county: sourceMeta.county,
      contest: contestNameExact,
      zipUrl,
    },
    rows: mapped,
    totals: {
      candidateVotes: mapped.reduce((n, r) => n + r.totalVotes, 0),
      registeredVoters: mapped[0]?.registeredVoters ?? 0,
      ballotsCast: mapped[0]?.ballotsCast ?? 0,
      precinctTotal: mapped[0]?.precinctTotal ?? 0,
      precinctReporting: mapped[0]?.precinctReporting ?? 0,
    },
    rowCount: mapped.length,
  };
}
