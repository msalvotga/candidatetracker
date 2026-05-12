import express from "express";
import cors from "cors";
import { listCivixElectionSummaries, fetchCivixElectionBundle, fetchCivixElectionBundleWithOverrides } from "./lib/civixServer.mjs";
import { fetchGalvestonSd4Summary, fetchJeffersonSd4Summary } from "./lib/galvestonClarity.mjs";
import { fetchHarrisSd4Summary } from "./lib/harrisVotes.mjs";
import { fetchMontgomeryEresultsSd4Summary } from "./lib/montgomeryEresults.mjs";
import { fetchChambersSd4Summary } from "./lib/chambersReport.mjs";
import { runCountyFeedFetch } from "./lib/countyFeedHandlers.mjs";
import { countyHasHubDiscoveryProfile, discoverCountyFeedUrlFromHub } from "./lib/countyHubDiscovery.mjs";
import { getSd4HistoricalPayloadForApi } from "./lib/sd4HistoricalPrecinct.mjs";
import { buildElectionFileFromCountyFeeds } from "./lib/electionFileFromCountyResults.mjs";
import { decodeBase64Json, decodeUploadPayload, encodeBase64Json } from "./lib/b64.mjs";
import {
  deleteManualElection,
  ensureDb,
  getAppSettings,
  getDbInfo,
  getDbTablePreview,
  getLatestCountyRows,
  getSd4MergePreferCountyFeedNameSet,
  getLatestSosCountyRows,
  getManualElectionJsonById,
  clearLiveResultTables,
  commitCountyResultsBatch,
  insertSosCountyRows,
  insertSosCandidateRows,
  insertSosResultSnapshot,
  insertManualElection,
  listDbTablesWithCounts,
  listManualElectionsMeta,
  manualElectionExists,
  pruneLiveResultHistory,
  appendSourceImportLog,
  appendVoteHistoryIfChanged,
  getElectionSourceConfig,
  getSourceImportLogPayload,
  listElectionSourceConfigs,
  listElectionFeedSources,
  listIngestVendors,
  replaceElectionFeedSourcesForElection,
  updateElectionFeedSourceUrl,
  upsertElectionSourceConfig,
  updateManualElection,
  updateAppSettings,
} from "./db.mjs";

/** Only civix election wired for full ingest + live merge in this deployment. */
const TRACKED_CIVIX_ELECTION_ID = 56181;
const DEFAULT_ELECTION_CONFIG = {
  electionId: String(TRACKED_CIVIX_ELECTION_ID),
  label: "May 2, 2026 Special Election",
  isEnabled: true,
  autoRefreshEnabled: true,
  usesCivixSos: true,
  showInCatalog: true,
  sosCountyInfoUrl: "",
  harrisSourceUrl: "https://appfiles.harrisvotes.com/harrisvotes/prd/Data/5226/cumulative.pdf",
  galvestonSourceUrl: "https://results.enr.clarityelections.com//TX/Galveston/126195/369887/reports/summary.zip",
  jeffersonSourceUrl: "https://results.enr.clarityelections.com//TX/Jefferson/126275/369848/reports/summary.zip",
  montgomerySourceUrl: "https://elections.mctx.org/index.asp",
  chambersSourceUrl:
    "https://www.chamberscountytx.gov/DocumentCenter/View/6746/ED-Cumulative-Results-Unofficial---Republican-WM-PDF",
};

function slugId(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function validateElectionFile(obj) {
  if (!obj || typeof obj !== "object") return "Body must be a JSON object";
  if (obj.schemaVersion !== 1) return "schemaVersion must be 1";
  if (!obj.election || typeof obj.election.id !== "string") return "election.id (string) required";
  if (!Array.isArray(obj.races)) return "races must be an array";
  if (!obj.source || typeof obj.source.label !== "string") return "source.label required";
  return null;
}

function partyFromRowName(name, fallback = "") {
  const src = String(name ?? "");
  if (/\bDEM\b/i.test(src)) return "DEM";
  if (/\bREP\b/i.test(src)) return "REP";
  return String(fallback || "").toUpperCase();
}

function normalizePersonName(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSd4ContestName(value) {
  const text = String(value ?? "").toUpperCase();
  // Chambers PDF uses "District No. 4"; others use "District 4" or "District #4".
  const hasSd4 =
    /STATE\s+SENAT(?:E|OR)/i.test(text) &&
    /DISTRICT\s*(?:NO\.?\s*)?\s*#?\s*4\b/i.test(text);
  return hasSd4;
}

function findTargetRaceCandidateFromRow(raceCandidates, row) {
  const rowParty = String(row?.partyName ?? "").toUpperCase();
  const rowName = normalizePersonName(row?.choiceName);
  if (!Array.isArray(raceCandidates) || !raceCandidates.length) return null;

  const byNameAndParty = raceCandidates.find((c) => {
    const cName = normalizePersonName(c?.N);
    const cParty = String(c?.P ?? "").toUpperCase();
    return cParty === rowParty && (cName === rowName || cName.includes(rowName) || rowName.includes(cName));
  });
  if (byNameAndParty) return byNameAndParty;

  const byNameOnly = raceCandidates.find((c) => {
    const cName = normalizePersonName(c?.N);
    return cName === rowName || cName.includes(rowName) || rowName.includes(cName);
  });
  if (byNameOnly) return byNameOnly;

  const byParty = raceCandidates.filter((c) => String(c?.P ?? "").toUpperCase() === rowParty);
  if (byParty.length === 1) return byParty[0];

  return null;
}

function findCountyCellByFallback(rr, targetCandidate, rowParty, rowChoiceName) {
  if (!rr?.C || !targetCandidate) return null;
  const entries = Object.entries(rr.C);
  if (!entries.length) return null;

  // 1) Exact candidate id (normal path).
  const exact = rr.C[String(targetCandidate.ID)];
  if (exact) return exact;

  // 2) Name+party fallback for cross-election countyInfo overrides.
  const wantedName = normalizePersonName(targetCandidate.N);
  const wantedParty = String(targetCandidate.P ?? "").toUpperCase();
  const namePartyMatch = entries.find(([, c]) => {
    const candName = normalizePersonName(c?.N);
    const candParty = String(c?.P ?? "").toUpperCase();
    return candName === wantedName && candParty === wantedParty;
  });
  if (namePartyMatch) return namePartyMatch[1];

  // 3) County row label+party fallback (e.g., "Brett Ligon" vs "BRETT W. LIGON").
  const rowName = normalizePersonName(rowChoiceName);
  const looseNameParty = entries.find(([, c]) => {
    const candName = normalizePersonName(c?.N);
    const candParty = String(c?.P ?? "").toUpperCase();
    return (
      candParty === rowParty &&
      (candName === rowName || candName.includes(rowName) || rowName.includes(candName))
    );
  });
  if (looseNameParty) return looseNameParty[1];

  // 4) Last-resort unique party match.
  const partyMatches = entries.filter(([, c]) => String(c?.P ?? "").toUpperCase() === rowParty);
  if (partyMatches.length === 1) return partyMatches[0][1];

  return null;
}

function findCountyCellForRaceCandidate(rr, targetCandidate) {
  if (!rr?.C || !targetCandidate) return null;
  const exact = rr.C[String(targetCandidate.ID)];
  if (exact) return exact;
  const entries = Object.values(rr.C);
  const wantedName = normalizePersonName(targetCandidate.N);
  const wantedParty = String(targetCandidate.P ?? "").toUpperCase();

  const byNameParty = entries.find((c) => {
    const candName = normalizePersonName(c?.N);
    const candParty = String(c?.P ?? "").toUpperCase();
    return candName === wantedName && candParty === wantedParty;
  });
  if (byNameParty) return byNameParty;

  const byNameOnly = entries.find((c) => {
    const candName = normalizePersonName(c?.N);
    return candName === wantedName || candName.includes(wantedName) || wantedName.includes(candName);
  });
  if (byNameOnly) return byNameOnly;

  const byParty = entries.filter((c) => String(c?.P ?? "").toUpperCase() === wantedParty);
  if (byParty.length === 1) return byParty[0];

  return null;
}

function createDefaultCountyCellFromCandidate(candidate, order) {
  return {
    id: Number(candidate?.ID ?? 0),
    N: String(candidate?.N ?? ""),
    P: String(candidate?.P ?? ""),
    V: 0,
    PE: 0,
    C: String(candidate?.C ?? ""),
    O: Number(candidate?.O ?? order ?? 0),
    EV: 0,
    LN: String(candidate?.LN ?? ""),
    FN: String(candidate?.FN ?? ""),
    ED: 0,
  };
}

async function mergeSd4CountyOverridesIntoCivix(electionId, electionPayload, countyDoc) {
  if (!electionPayload?.Districted || !electionPayload?.Home || !countyDoc?.upload) return { electionPayload, countyDoc };

  const districted = decodeBase64Json(electionPayload.Districted);
  const home = decodeBase64Json(electionPayload.Home);
  const race = (districted?.Races || []).find((r) => /STATE SENATOR,\s*DISTRICT 4/i.test(String(r?.N ?? "")));
  if (!race || !Array.isArray(race.Candidates)) return { electionPayload, countyDoc };
  const raceId = String(race.id);

  const preferCountyNames = await getSd4MergePreferCountyFeedNameSet(String(electionId));
  const byCountyName = await getLatestCountyRows(String(electionId));
  const sosCountyRows = (await getLatestSosCountyRows(String(electionId))).filter((row) => isSd4ContestName(row?.contestName));
  const liveSosCountyRows = extractSd4SosCountyRowsFromCivix({
    electionId,
    electionLabel: `civix:${electionId}`,
    electionPayload,
    countyDoc,
  });
  const bySosCountyName = new Map();
  for (const row of sosCountyRows) {
    const k = String(row.countyName ?? "").toUpperCase();
    const list = bySosCountyName.get(k) ?? [];
    list.push(row);
    bySosCountyName.set(k, list);
  }
  const byLiveSosCountyName = new Map();
  for (const row of liveSosCountyRows) {
    const k = String(row.countyName ?? "").toUpperCase();
    const list = byLiveSosCountyName.get(k) ?? [];
    list.push(row);
    byLiveSosCountyName.set(k, list);
  }

  const countyRoot = decodeUploadPayload(countyDoc);

  for (const block of Object.values(countyRoot)) {
    const countyName = String(block?.N ?? "").toUpperCase();
    const rows = byCountyName[countyName];
    const sosRows = bySosCountyName.get(countyName) ?? [];
    const liveSosRows = byLiveSosCountyName.get(countyName) ?? [];
    const preferCounty = preferCountyNames.has(countyName);
    const countySd4Rows = (rows ?? []).filter((r) => isSd4ContestName(r?.contestName));
    const mergedRows = preferCounty
      ? countySd4Rows
      : [...liveSosRows, ...sosRows, ...(rows ?? [])].filter((r) => isSd4ContestName(r?.contestName));

    if (!preferCounty && !mergedRows.length) continue;

    const precinctSourceRows = preferCounty ? countySd4Rows : mergedRows;
    if (precinctSourceRows.length && block?.Summary) block.Summary.SRC = preferCounty ? "CNTY" : "SOS";
    else if (preferCounty && block?.Summary) block.Summary.SRC = "CNTY";

    if (precinctSourceRows.length) {
      const countyPrecinctReporting = Math.max(...precinctSourceRows.map((r) => Number(r.precinctReporting ?? 0)), 0);
      const countyPrecinctTotal = Math.max(...precinctSourceRows.map((r) => Number(r.precinctTotal ?? 0)), 0);
      if (block?.Summary) {
        block.Summary.PRR = Math.max(Number(block.Summary.PRR ?? 0), countyPrecinctReporting);
        block.Summary.PRP = Math.max(Number(block.Summary.PRP ?? 0), countyPrecinctTotal);
      }
    }

    const rr = block?.Races?.[raceId];
    if (!rr?.C) continue;

    // Normalize county race candidate set to the target election candidates
    // so rows can still merge even when countyInfo source has different IDs/candidates.
    const normalizedCells = {};
    for (let idx = 0; idx < race.Candidates.length; idx++) {
      const rc = race.Candidates[idx];
      const existing = findCountyCellForRaceCandidate(rr, rc);
      normalizedCells[String(rc.ID)] = preferCounty
        ? createDefaultCountyCellFromCandidate(rc, idx + 1)
        : existing ?? createDefaultCountyCellFromCandidate(rc, idx + 1);
    }
    rr.C = normalizedCells;

    for (const row of mergedRows) {
      const party = partyFromRowName(row.choiceName, row.partyName);
      const target = findTargetRaceCandidateFromRow(race.Candidates, row);
      if (!target) continue;
      const cell = findCountyCellByFallback(rr, target, party, row.choiceName);
      if (!cell) continue;
      const nextTotal = Number(row.totalVotes ?? 0);
      const nextEarly = Number(row.earlyVotes ?? 0);
      const nextEd = Number(row.electionDayVotes ?? 0);
      const currentTotal = Number(cell.V ?? 0);
      const currentEarly = Number(cell.EV ?? 0);
      const currentEd = Number(cell.ED ?? Math.max(currentTotal - currentEarly, 0));
      if (preferCounty) {
        const mergedTotal = Math.max(currentTotal, nextTotal, nextEarly + nextEd);
        const mergedEarly = Math.max(currentEarly, nextEarly);
        const mergedEd = Math.max(currentEd, nextEd, mergedTotal - mergedEarly);
        cell.V = mergedTotal;
        cell.EV = mergedEarly;
        cell.ED = mergedEd;
        if (block?.Summary) block.Summary.SRC = "CNTY";
      } else {
        const mergedTotal = Math.max(currentTotal, nextTotal, nextEarly + nextEd);
        const mergedEarly = Math.max(currentEarly, nextEarly);
        const mergedEd = Math.max(currentEd, nextEd, mergedTotal - mergedEarly);
        const isCountyRow = (rows ?? []).includes(row);
        if (isCountyRow && (nextTotal > currentTotal || nextEarly > currentEarly || nextEd > currentEd)) {
          if (block?.Summary) block.Summary.SRC = "CNTY";
        }
        cell.V = mergedTotal;
        cell.EV = mergedEarly;
        cell.ED = mergedEd;
      }
    }
  }

  const countyValues = Object.values(countyRoot);
  const rolledPRR = countyValues.reduce((n, b) => n + Number(b?.Summary?.PRR ?? 0), 0);
  const rolledPRP = countyValues.reduce((n, b) => n + Number(b?.Summary?.PRP ?? 0), 0);
  if (home?.PollingReporting) {
    home.PollingReporting.PLR = Math.max(Number(home.PollingReporting.PLR ?? 0), rolledPRR);
    home.PollingReporting.PLT = Math.max(Number(home.PollingReporting.PLT ?? 0), rolledPRP);
  }
  if (home?.PrecinctsReporting) {
    home.PrecinctsReporting.PR = Math.max(Number(home.PrecinctsReporting.PR ?? 0), rolledPRR);
    home.PrecinctsReporting.PT = Math.max(Number(home.PrecinctsReporting.PT ?? 0), rolledPRP);
  }

  for (const c of race.Candidates) {
    let total = 0;
    let early = 0;
    let electionDay = 0;
    for (const block of Object.values(countyRoot)) {
      const rr = block?.Races?.[raceId];
      const cell = findCountyCellForRaceCandidate(rr, c);
      if (!cell) continue;
      total += Number(cell.V ?? 0);
      early += Number(cell.EV ?? 0);
      electionDay += Number(cell.ED ?? Math.max(Number(cell.V ?? 0) - Number(cell.EV ?? 0), 0));
    }
    // Use county-by-county merged lines as the source of truth.
    c.V = total;
    c.EV = early;
    c.ED = electionDay;
  }
  race.T = race.Candidates.reduce((n, c) => n + Number(c.V ?? 0), 0);

  return {
    electionPayload: { ...electionPayload, Districted: encodeBase64Json(districted), Home: encodeBase64Json(home) },
    countyDoc: { ...countyDoc, upload: encodeBase64Json(countyRoot) },
  };
}

function extractSd4SosCandidateRowsFromCivix({ electionId, electionLabel, electionPayload }) {
  const districted = decodeBase64Json(electionPayload.Districted);
  const home = decodeBase64Json(electionPayload.Home);
  const race = (districted?.Races || []).find((r) => /STATE SENATOR,\s*DISTRICT 4/i.test(String(r?.N ?? "")));
  if (!race?.Candidates?.length) return [];

  const precinctReporting = Number(home?.PollingReporting?.PLR ?? home?.PrecinctsReporting?.PR ?? 0);
  const precinctTotal = Number(home?.PollingReporting?.PLT ?? home?.PrecinctsReporting?.PT ?? 0);
  const raceTotal = Number(race.T ?? 0);

  return race.Candidates.map((c, idx) => {
    const totalVotes = Number(c.V ?? 0);
    const earlyVotes = Number(c.EV ?? 0);
    const electionDayVotes = Number(c.ED ?? Math.max(totalVotes - earlyVotes, 0));
    const pct = raceTotal > 0 ? ((totalVotes / raceTotal) * 100).toFixed(2) : "0.00";
    return {
      lineNumber: idx + 1,
      contestName: String(race.N ?? ""),
      choiceName: String(c.N ?? ""),
      partyName: String(c.P ?? ""),
      earlyVotes,
      electionDayVotes,
      totalVotes,
      percentOfVotes: pct,
      precinctTotal,
      precinctReporting,
    };
  });
}

function extractAllSosCountyRowsFromCivix({ electionId, electionLabel, countyDoc }) {
  const countyRoot = decodeUploadPayload(countyDoc);
  const out = [];

  for (const block of Object.values(countyRoot)) {
    const precinctTotal = Number(block?.Summary?.PRP ?? 0);
    const precinctReporting = Number(block?.Summary?.PRR ?? 0);
    const races = block?.Races && typeof block.Races === "object" ? Object.values(block.Races) : [];
    for (const rr of races) {
      if (!rr?.C || typeof rr.C !== "object") continue;
      const contestTotal = Number(rr.T ?? 0);
      for (const cand of Object.values(rr.C)) {
        const totalVotes = Number(cand.V ?? 0);
        const earlyVotes = Number(cand.EV ?? 0);
        const electionDayVotes = Number(cand.ED ?? Math.max(totalVotes - earlyVotes, 0));
        out.push({
          electionId: String(electionId),
          electionLabel,
          countyName: String(block?.N ?? ""),
          contestName: String(rr?.N ?? ""),
          choiceName: String(cand.N ?? ""),
          partyName: String(cand.P ?? ""),
          earlyVotes,
          electionDayVotes,
          totalVotes,
          percentOfVotes: contestTotal > 0 ? ((totalVotes / contestTotal) * 100).toFixed(2) : "0.00",
          precinctTotal,
          precinctReporting,
        });
      }
    }
  }
  return out;
}

function extractSd4SosCountyRowsFromCivix({ electionId, electionLabel, electionPayload, countyDoc }) {
  const districted = decodeBase64Json(electionPayload.Districted);
  const race = (districted?.Races || []).find((r) => /STATE SENATOR,\s*DISTRICT 4/i.test(String(r?.N ?? "")));
  if (!race?.Candidates?.length) return [];
  const sd4ContestName = String(race.N ?? "").toUpperCase();
  return extractAllSosCountyRowsFromCivix({ electionId, electionLabel, countyDoc }).filter(
    (row) => String(row.contestName ?? "").toUpperCase() === sd4ContestName,
  );
}

/**
 * Express app with all /api/* routes. Used by standalone `server/index.mjs`
 * and mounted inside Vite dev server (no separate port required).
 */
export function createApiApp() {
  const PORT = Number(process.env.PORT || 3847);

  const app = express();
  app.use(
    cors({
      origin: [/localhost:\d+$/, /^127\.0\.0\.1:\d+$/],
    }),
  );
  app.use(express.json({ limit: "80mb" }));

  async function shouldAutoIngest() {
    const settings = await getAppSettings();
    return !settings.disableAutoIngest;
  }

  /**
   * First non-empty URL wins: stored election config, then legacy app_settings (56181 only), then baked-in defaults.
   * Exposes `harrisSourceUrl` (etc.) for the UI and `harris` (etc.) aliases for ingest.
   */
  function buildElectionConfig(electionId, rawRow, legacyAppSettings) {
    const id = String(electionId);
    const base =
      id === DEFAULT_ELECTION_CONFIG.electionId
        ? { ...DEFAULT_ELECTION_CONFIG }
        : { ...DEFAULT_ELECTION_CONFIG, electionId: id, label: `Election ${id}` };
    const legacy = id === "56181" && legacyAppSettings ? legacyAppSettings : null;
    const r = rawRow ?? {};

    function pickUrl(...candidates) {
      for (const p of candidates) {
        if (p == null) continue;
        const s = String(p).trim();
        if (s) return s;
      }
      return "";
    }

    const sosCountyInfoUrl = pickUrl(r.sosCountyInfoUrl, legacy?.sosCountyInfoUrl, base.sosCountyInfoUrl);
    const harrisSourceUrl = pickUrl(r.harrisSourceUrl, legacy?.harrisSourceUrl, base.harrisSourceUrl);
    const galvestonSourceUrl = pickUrl(r.galvestonSourceUrl, legacy?.galvestonSourceUrl, base.galvestonSourceUrl);
    const jeffersonSourceUrl = pickUrl(r.jeffersonSourceUrl, legacy?.jeffersonSourceUrl, base.jeffersonSourceUrl);
    const montgomerySourceUrl = pickUrl(r.montgomerySourceUrl, legacy?.montgomerySourceUrl, base.montgomerySourceUrl);
    const chambersSourceUrl = pickUrl(r.chambersSourceUrl, legacy?.chambersSourceUrl, base.chambersSourceUrl);

    return {
      electionId: id,
      label: String(r.label ?? base.label),
      isEnabled: r.isEnabled != null ? !!r.isEnabled : true,
      autoRefreshEnabled: r.autoRefreshEnabled != null ? !!r.autoRefreshEnabled : true,
      usesCivixSos: r.usesCivixSos != null ? !!r.usesCivixSos : !!base.usesCivixSos,
      showInCatalog: r.showInCatalog != null ? !!r.showInCatalog : !!base.showInCatalog,
      sosCountyInfoUrl,
      harrisSourceUrl,
      galvestonSourceUrl,
      jeffersonSourceUrl,
      montgomerySourceUrl,
      chambersSourceUrl,
      updatedAt: r.updatedAt,
      harris: harrisSourceUrl,
      galveston: galvestonSourceUrl,
      jefferson: jeffersonSourceUrl,
      montgomery: montgomerySourceUrl,
      chambers: chambersSourceUrl,
    };
  }

  async function getElectionIngestConfig(electionId) {
    const legacy = await getAppSettings();
    const row = await getElectionSourceConfig(String(electionId));
    return buildElectionConfig(electionId, row, legacy);
  }

  const ingestState = {
    lastRunEndTime: null,
    /** Wall-clock time for the next planned auto refresh (stable until a run completes). */
    nextScheduledRunAt: null,
    running: false,
    lastResult: null,
  };

  /** Serialize every full ingest (auto + manual) so two runs never append rows ms apart. */
  let ingestChain = Promise.resolve();
  function withIngestLock(task) {
    const next = ingestChain.then(() => task());
    ingestChain = next.catch(() => {});
    return next;
  }

  async function runFullIngestRefresh(electionId) {
    const cfg = await getElectionIngestConfig(electionId);
    if (!cfg.isEnabled) {
      return {
        ok: false,
        electionId,
        skipped: true,
        reason: "Election ingest disabled",
        sos: { inserted: 0 },
        counties: {},
        errors: ["Election ingest disabled for this election"],
      };
    }
    const sourceLogKey = (k) => `${String(electionId)}:${k}`;
    /** One timestamp for all county rows in this run — one logical batch in the DB. */
    const countyBatchAt = new Date().toISOString();
    const result = {
      ok: true,
      electionId,
      sos: { inserted: 0 },
      counties: /** @type {Record<string, { inserted: number }>} */ ({}),
      errors: [],
    };
    /** Built after all county fetches; committed in one DB transaction (see commitCountyResultsBatch). */
    const countySegments = [];

    if (cfg.usesCivixSos) {
      try {
        const countyInfoUrl = cfg.sosCountyInfoUrl;
        const { election, county } = countyInfoUrl
          ? await fetchCivixElectionBundleWithOverrides(electionId, { countyInfoUrl })
          : await fetchCivixElectionBundle(electionId);
        const sosCandidateRows = extractSd4SosCandidateRowsFromCivix({
          electionId,
          electionLabel: `civix:${electionId}`,
          electionPayload: election,
        });
        const sosCountyRows = extractAllSosCountyRowsFromCivix({
          electionId,
          electionLabel: `civix:${electionId}`,
          countyDoc: county,
        });
        await insertSosResultSnapshot({
          electionId: String(electionId),
          electionLabel: `civix:${electionId}`,
          payload: { election, county },
        });
        await insertSosCandidateRows({
          electionId: String(electionId),
          electionLabel: `civix:${electionId}`,
          sourceUrl: "https://goelect.txelections.civixapps.com/ivis-enr-ui/races",
          rows: sosCandidateRows,
        });
        await insertSosCountyRows({
          electionId: String(electionId),
          electionLabel: `civix:${electionId}`,
          sourceUrl:
            countyInfoUrl ||
            `https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/${electionId}`,
          rows: sosCountyRows,
        });
        result.sos.inserted = 1;
        await appendVoteHistoryIfChanged({
          electionId: String(electionId),
          sourceKey: "sos",
          capturedAt: countyBatchAt,
          rows: sosCandidateRows,
        });
        await appendSourceImportLog({
          sourceKey: sourceLogKey("sos"),
          ok: true,
          message: `OK: civix bundle + snapshot + ${sosCandidateRows.length} candidate rows + ${sosCountyRows.length} SOS county rows`,
        });
      } catch (e) {
        const msg = String(e?.message || e);
        result.errors.push(`SOS pull failed: ${msg}`);
        await appendSourceImportLog({ sourceKey: sourceLogKey("sos"), ok: false, message: msg });
      }
    } else {
      await appendSourceImportLog({
        sourceKey: sourceLogKey("sos"),
        ok: true,
        message: "Skipped: election is configured as not using Texas SOS / Civix ingest (county feeds only)",
      });
    }

    const vendorRows = await listIngestVendors();
    const vendorById = Object.fromEntries(vendorRows.map((v) => [v.id, v]));
    const feedRows = await listElectionFeedSources(String(electionId));
    for (const feed of feedRows) {
      if (!feed.isEnabled) continue;
      const ck = String(feed.countyKey || "").trim().toLowerCase();
      if (!ck) continue;
      const vendor = vendorById[feed.vendorId];
      const label = ck;
      if (!vendor) {
        const msg = `Unknown vendor id: ${feed.vendorId}`;
        result.errors.push(`${label}: ${msg}`);
        await appendSourceImportLog({ sourceKey: sourceLogKey(ck), ok: false, message: msg });
        continue;
      }
      try {
        let effectiveUrl = String(feed.sourceUrl ?? "").trim();
        const hubPage = String(feed.hubPageUrl ?? "").trim();
        let hubSuffix = "";
        if (hubPage && countyHasHubDiscoveryProfile(ck)) {
          try {
            const disc = await discoverCountyFeedUrlFromHub(hubPage, { countyKey: ck });
            if (disc.url) {
              effectiveUrl = disc.url;
              await updateElectionFeedSourceUrl(String(electionId), feed.id, disc.url);
              hubSuffix = `; hub → ${disc.matchedLabel ?? disc.matchedStage ?? "matched link"}`;
            } else if (disc.message) {
              hubSuffix = `; hub discovery: ${disc.message}`;
            }
          } catch (e) {
            hubSuffix = `; hub discovery failed: ${String(e?.message || e)}`;
          }
        }

        const seg = await runCountyFeedFetch(
          { countyKey: ck, sourceUrl: effectiveUrl, civixCountyName: feed.civixCountyName },
          vendor,
        );
        countySegments.push(seg);
        const n = seg.rows?.length ?? 0;
        result.counties[ck] = { inserted: n };
        await appendSourceImportLog({
          sourceKey: sourceLogKey(ck),
          ok: true,
          message: `OK: ${n} rows (${vendor.displayName})${hubSuffix}`,
        });
      } catch (e) {
        const msg = String(e?.message || e);
        result.errors.push(`${label} (${vendor.displayName}): ${msg}`);
        result.counties[ck] = { inserted: 0 };
        await appendSourceImportLog({ sourceKey: sourceLogKey(ck), ok: false, message: msg });
      }
    }

    if (countySegments.length > 0) {
      try {
        await commitCountyResultsBatch({ electionId: String(electionId), batchAt: countyBatchAt, segments: countySegments });
        for (const seg of countySegments) {
          await appendVoteHistoryIfChanged({
            electionId: String(electionId),
            sourceKey: `county:${seg.countyId}`,
            capturedAt: countyBatchAt,
            rows: seg.rows ?? [],
          });
        }
        await appendSourceImportLog({
          sourceKey: sourceLogKey("counties_commit"),
          ok: true,
          message: `OK: committed ${countySegments.length} county segment(s)`,
        });
      } catch (e) {
        const msg = String(e?.message || e);
        result.errors.push(`County batch commit failed: ${msg}`);
        await appendSourceImportLog({ sourceKey: sourceLogKey("counties_commit"), ok: false, message: msg });
      }
    } else {
      await appendSourceImportLog({
        sourceKey: sourceLogKey("counties_commit"),
        ok: true,
        message: "No county segments to commit (all county pulls failed or returned empty)",
      });
    }

    if (result.errors.length) result.ok = false;
    try {
      await pruneLiveResultHistory(2);
    } catch (e) {
      const msg = String(e?.message || e);
      result.errors.push(`History prune failed: ${msg}`);
      await appendSourceImportLog({ sourceKey: sourceLogKey("prune_history"), ok: false, message: msg });
    }
    return result;
  }

  async function getIngestStatusPayload() {
    await ensureDb();
    const settings = await getAppSettings();
    const intervalSec = Math.max(15, Number(settings.autoRefreshIntervalSec) || 60);
    const intervalMs = intervalSec * 1000;
    const now = Date.now();
    let nextRunAt = null;
    if (settings.autoRefreshEnabled) {
      if (ingestState.nextScheduledRunAt != null) {
        nextRunAt = ingestState.nextScheduledRunAt;
      } else {
        nextRunAt = now + intervalMs;
      }
    }
    return {
      autoRefreshEnabled: settings.autoRefreshEnabled,
      autoRefreshIntervalSec: intervalSec,
      lastRunEndTime: ingestState.lastRunEndTime,
      nextRunAt,
      running: ingestState.running,
      lastResult: ingestState.lastResult,
    };
  }

  setInterval(() => {
    void (async () => {
      try {
        const settings = await getAppSettings();
        const intervalMs = Math.max(15, Number(settings.autoRefreshIntervalSec) || 60) * 1000;
        if (!settings.autoRefreshEnabled) {
          ingestState.nextScheduledRunAt = null;
          return;
        }
        const now = Date.now();
        if (ingestState.nextScheduledRunAt == null) {
          ingestState.nextScheduledRunAt = now + intervalMs;
        }
        if (now < ingestState.nextScheduledRunAt) return;

        await withIngestLock(async () => {
          const s = await getAppSettings();
          if (!s.autoRefreshEnabled) {
            ingestState.nextScheduledRunAt = null;
            return;
          }
          const im = Math.max(15, Number(s.autoRefreshIntervalSec) || 60) * 1000;
          const n = Date.now();
          if (n < ingestState.nextScheduledRunAt) return;

          ingestState.running = true;
          try {
            const configs = await listElectionSourceConfigs();
            const active = configs.filter((c) => c.isEnabled && c.autoRefreshEnabled);
            const batch = [];
            for (const c of active) {
              batch.push(await runFullIngestRefresh(String(c.electionId)));
            }
            ingestState.lastRunEndTime = Date.now();
            ingestState.lastResult = { ok: batch.every((r) => r.ok), elections: batch };
            ingestState.nextScheduledRunAt = ingestState.lastRunEndTime + im;
          } catch (e) {
            console.error("auto ingest failed", e);
            ingestState.lastResult = { ok: false, errors: [String(e?.message || e)] };
            ingestState.lastRunEndTime = Date.now();
            ingestState.nextScheduledRunAt = ingestState.lastRunEndTime + im;
          } finally {
            ingestState.running = false;
          }
        });
      } catch (e) {
        console.error("ingest tick", e);
      }
    })();
  }, 1000);

  app.get("/api/ingest/status", async (_req, res) => {
    try {
      res.json(await getIngestStatusPayload());
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /** Precinct-level SD4 general-election history (GE columns); aggregated by county and party for county tab. */
  app.get("/api/historical/sd4-ge-county-totals", (_req, res) => {
    try {
      const counties = getSd4HistoricalPayloadForApi();
      res.json({
        description:
          "Totals from server/data/historical/SD4_precinct_wide_by_election.csv — latest GE year per county with early+ED+mail+absentee (votes_reported fallback).",
        counties,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/health", async (_req, res) => {
    try {
      await ensureDb();
      res.json({ ok: true, service: "electionnighttracker-api", port: PORT, database: getDbInfo() });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/sources", async (_req, res) => {
    try {
      await ensureDb();
      const countySources = await getElectionIngestConfig(TRACKED_CIVIX_ELECTION_ID);
      const manual = (await listManualElectionsMeta()).map((e) => ({
        id: e.id,
        label: e.label,
        type: "manual",
        updatedAt: e.updatedAt,
      }));
      res.json({
        civix: {
          id: "sos-civix",
          name: "Texas SOS Civix ENR",
          type: "sos",
          baseUrl: "https://goelect.txelections.civixapps.com",
        },
        counties: [
          {
            id: "county-harrisvotes",
            name: "Harris Votes",
            type: "county",
            baseUrl: countySources.harris,
          },
          {
            id: "county-galveston-clarity",
            name: "Galveston Clarity",
            type: "county",
            baseUrl: countySources.galveston,
          },
          {
            id: "county-jefferson-clarity",
            name: "Jefferson Clarity",
            type: "county",
            baseUrl: countySources.jefferson,
          },
          {
            id: "county-chambers",
            name: "Chambers County",
            type: "county",
            baseUrl: countySources.chambers || DEFAULT_ELECTION_CONFIG.chambersSourceUrl,
          },
          {
            id: "county-montgomery",
            name: "Montgomery County",
            type: "county",
            baseUrl: countySources.montgomery,
          },
        ],
        manual,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/db/overview", async (_req, res) => {
    try {
      await ensureDb();
      const tables = await listDbTablesWithCounts();
      res.json({ database: getDbInfo(), tables });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/db/preview", async (req, res) => {
    try {
      await ensureDb();
      const table = String(req.query.table ?? "");
      const limit = Number(req.query.limit ?? 20);
      const preview = await getDbTablePreview(table, limit);
      res.json(preview);
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/import-log", async (req, res) => {
    try {
      await ensureDb();
      const recentLimit = Number(req.query.limit ?? 200);
      const payload = await getSourceImportLogPayload({ recentLimit });
      res.json(payload);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/election-source-configs", async (_req, res) => {
    try {
      await ensureDb();
      const legacy = await getAppSettings();
      const rows = await listElectionSourceConfigs();
      res.json({ elections: rows.map((r) => buildElectionConfig(r.electionId, r, legacy)) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/election-source-configs/:electionId", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      if (!electionId) return res.status(400).json({ error: "electionId required" });
      const legacy = await getAppSettings();
      const row = await getElectionSourceConfig(electionId);
      const current = buildElectionConfig(electionId, row, legacy);
      const updated = await upsertElectionSourceConfig({
        electionId,
        label: req.body?.label ?? current.label,
        isEnabled: typeof req.body?.isEnabled === "boolean" ? req.body.isEnabled : current.isEnabled,
        autoRefreshEnabled:
          typeof req.body?.autoRefreshEnabled === "boolean" ? req.body.autoRefreshEnabled : current.autoRefreshEnabled,
        usesCivixSos: typeof req.body?.usesCivixSos === "boolean" ? req.body.usesCivixSos : current.usesCivixSos,
        showInCatalog: typeof req.body?.showInCatalog === "boolean" ? req.body.showInCatalog : current.showInCatalog,
        sosCountyInfoUrl: req.body?.sosCountyInfoUrl ?? current.sosCountyInfoUrl,
        harrisSourceUrl: req.body?.harrisSourceUrl ?? current.harrisSourceUrl,
        galvestonSourceUrl: req.body?.galvestonSourceUrl ?? current.galvestonSourceUrl,
        jeffersonSourceUrl: req.body?.jeffersonSourceUrl ?? current.jeffersonSourceUrl,
        montgomerySourceUrl: req.body?.montgomerySourceUrl ?? current.montgomerySourceUrl,
        chambersSourceUrl: req.body?.chambersSourceUrl ?? current.chambersSourceUrl,
      });
      res.json(buildElectionConfig(electionId, updated, legacy));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post("/api/election-source-configs", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.body?.electionId ?? "").trim();
      if (!electionId) return res.status(400).json({ error: "electionId required" });
      const usesSos = req.body?.usesCivixSos !== false;
      if (usesSos) {
        if (!/^\d+$/.test(electionId)) {
          return res.status(400).json({ error: "electionId must be numeric when SOS / Civix ingest is enabled" });
        }
      } else if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,126}$/.test(electionId)) {
        return res.status(400).json({
          error: "electionId must be a short alphanumeric key (e.g. local-…) when SOS / Civix ingest is off",
        });
      }
      const existing = await getElectionSourceConfig(electionId);
      if (existing) return res.status(409).json({ error: `Election ${electionId} already exists` });
      const label = String(req.body?.label ?? `Election ${electionId}`).trim() || `Election ${electionId}`;
      const row = await upsertElectionSourceConfig({
        electionId,
        label,
        isEnabled: req.body?.isEnabled !== false,
        autoRefreshEnabled: req.body?.autoRefreshEnabled !== false,
        usesCivixSos: usesSos,
        showInCatalog: req.body?.showInCatalog !== false,
        sosCountyInfoUrl: String(req.body?.sosCountyInfoUrl ?? ""),
        harrisSourceUrl: String(req.body?.harrisSourceUrl ?? ""),
        galvestonSourceUrl: String(req.body?.galvestonSourceUrl ?? ""),
        jeffersonSourceUrl: String(req.body?.jeffersonSourceUrl ?? ""),
        montgomerySourceUrl: String(req.body?.montgomerySourceUrl ?? ""),
        chambersSourceUrl: String(req.body?.chambersSourceUrl ?? ""),
      });
      const legacy = await getAppSettings();
      res.status(201).json(buildElectionConfig(electionId, row, legacy));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ingest-vendors", async (_req, res) => {
    try {
      await ensureDb();
      res.json({ vendors: await listIngestVendors() });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/election-feed-sources/:electionId", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      if (!electionId) return res.status(400).json({ error: "electionId required" });
      res.json({ electionId, sources: await listElectionFeedSources(electionId) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/election-feed-sources/:electionId", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      if (!electionId) return res.status(400).json({ error: "electionId required" });
      const sources = req.body?.sources;
      if (!Array.isArray(sources)) return res.status(400).json({ error: "body.sources must be an array" });
      const updated = await replaceElectionFeedSourcesForElection(electionId, sources);
      res.json({ electionId, sources: updated });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /** Resolve a county results file URL from an election hub HTML page (county-specific link matching). */
  app.post("/api/county-feed/discover-url", async (req, res) => {
    try {
      const hubUrl = String(req.body?.hubUrl ?? "").trim();
      const countyKey = String(req.body?.countyKey ?? "").trim().toLowerCase();
      const htmlRaw = req.body?.html;
      const html = htmlRaw != null && String(htmlRaw).trim() ? String(htmlRaw) : undefined;
      if (!hubUrl) return res.status(400).json({ error: "hubUrl is required" });
      if (!countyKey) return res.status(400).json({ error: "countyKey is required" });
      const result = await discoverCountyFeedUrlFromHub(hubUrl, { countyKey, html });
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/settings", async (_req, res) => {
    try {
      await ensureDb();
      const settings = await getAppSettings();
      res.json(settings);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/settings", async (req, res) => {
    try {
      await ensureDb();
      const settings = await updateAppSettings({
        disableAutoIngest: !!req.body?.disableAutoIngest,
        autoRefreshEnabled: typeof req.body?.autoRefreshEnabled === "boolean" ? req.body.autoRefreshEnabled : undefined,
        autoRefreshIntervalSec: req.body?.autoRefreshIntervalSec,
        displayTimeZone: req.body?.displayTimeZone,
        sosCountyInfoUrl: req.body?.sosCountyInfoUrl,
        harrisSourceUrl: req.body?.harrisSourceUrl,
        galvestonSourceUrl: req.body?.galvestonSourceUrl,
        jeffersonSourceUrl: req.body?.jeffersonSourceUrl,
        montgomerySourceUrl: req.body?.montgomerySourceUrl,
        chambersSourceUrl: req.body?.chambersSourceUrl,
      });
      res.json(settings);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post("/api/ingest/refresh-once", async (req, res) => {
    let electionId = req.body?.electionId;
    if (electionId != null && String(electionId).trim()) {
      electionId = String(electionId).trim();
    } else {
      const n = Number(req.body?.civixElectionId ?? TRACKED_CIVIX_ELECTION_ID);
      electionId = Number.isFinite(n) ? String(n) : "";
    }
    if (!electionId) return res.status(400).json({ error: "electionId required" });
    try {
      const cfg = await getElectionIngestConfig(electionId);
      if (!cfg.isEnabled) {
        return res.status(409).json({ error: `Election ${electionId} is disabled for ingest` });
      }
      let result;
      await withIngestLock(async () => {
        ingestState.running = true;
        try {
          result = await runFullIngestRefresh(String(electionId));
          ingestState.lastRunEndTime = Date.now();
          ingestState.lastResult = result;
          const settings = await getAppSettings();
          const intervalMs = Math.max(15, Number(settings.autoRefreshIntervalSec) || 60) * 1000;
          if (settings.autoRefreshEnabled) {
            ingestState.nextScheduledRunAt = ingestState.lastRunEndTime + intervalMs;
          }
        } finally {
          ingestState.running = false;
        }
      });
      res.status(result.ok ? 200 : 207).json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post("/api/sos/bootstrap-sd4-primary", async (_req, res) => {
    try {
      const civixElectionId = 53813; // 2026 Republican Primary
      const { election, county, sosCountyInfoUrlConfigured, sosCountyInfoUrlUsed } =
        await fetchCivixElectionBundle(civixElectionId);
      const rows = extractSd4SosCandidateRowsFromCivix({
        electionId: civixElectionId,
        electionLabel: "2026 REPUBLICAN PRIMARY ELECTION",
        electionPayload: election,
      });
      await insertSosCandidateRows({
        electionId: String(civixElectionId),
        electionLabel: "2026 REPUBLICAN PRIMARY ELECTION",
        sourceUrl: "https://goelect.txelections.civixapps.com/ivis-enr-ui/races",
        rows,
      });
      await insertSosResultSnapshot({
        electionId: String(civixElectionId),
        electionLabel: "civix:53813",
        payload: { election, county },
      });
      res.json({
        ok: true,
        civixElectionId,
        inserted: rows.length,
        contest: rows[0]?.contestName ?? "STATE SENATOR, DISTRICT 4",
        sosCountyInfoUrlConfigured,
        sosCountyInfoUrlUsed,
      });
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/catalog", async (_req, res) => {
    try {
      await ensureDb();
      const cfgs = await listElectionSourceConfigs();
      const summaries = await listCivixElectionSummaries();
      const summaryById = new Map(summaries.map((s) => [s.civixElectionId, s]));

      /** Main dropdown: elections from Settings (respect `showInCatalog`), plus manual JSON uploads — not the full Civix list. */
      const fromSettings = [];
      for (const cfg of cfgs) {
        if (cfg.showInCatalog === false) continue;
        const labelBase =
          String(cfg.label ?? "").trim() ||
          summaryById.get(Number(cfg.electionId))?.catalogLabel ||
          `Election ${cfg.electionId}`;
        const rawId = String(cfg.electionId ?? "").trim();
        const num = Number(rawId);
        const isPureNumericId = Number.isFinite(num) && rawId === String(num);

        if (isPureNumericId && cfg.usesCivixSos !== false) {
          fromSettings.push({
            routeId: `civix:${num}`,
            catalogId: `civix:${num}`,
            catalogLabel: `${labelBase} [Civix]`,
            provider: "civix",
            civixElectionId: num,
          });
        } else {
          const enc = encodeURIComponent(rawId);
          fromSettings.push({
            routeId: `election:${enc}`,
            catalogId: `election:${enc}`,
            catalogLabel: `${labelBase} [County feeds]`,
            provider: "manual",
          });
        }
      }

      const manualRows = await listManualElectionsMeta();
      const entries = [
        ...fromSettings,
        ...manualRows.map((e) => ({
          routeId: `manual:${e.id}`,
          catalogId: `manual:${e.id}`,
          catalogLabel: `${e.label} [Manual]`,
          provider: "manual",
          manualId: e.id,
        })),
      ];
      res.json({ entries });
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  async function civixElectionHttpPayload(num) {
    const cfg = await getElectionIngestConfig(num);
    const countyInfoUrl = cfg.sosCountyInfoUrl;
    const bundle = countyInfoUrl
      ? await fetchCivixElectionBundleWithOverrides(num, { countyInfoUrl })
      : await fetchCivixElectionBundle(num);
    const { election, county, sosCountyInfoUrlConfigured, sosCountyInfoUrlUsed } = bundle;
    const merged = await mergeSd4CountyOverridesIntoCivix(num, election, county);
    return {
      provider: "civix",
      civixElectionId: num,
      sosCountyInfoUrlConfigured,
      sosCountyInfoUrlUsed,
      election: merged.electionPayload,
      county: merged.countyDoc,
    };
  }

  app.get("/api/election", async (req, res) => {
    const id = req.query.id;
    if (typeof id !== "string" || !id.includes(":")) {
      return res.status(400).json({ error: "Query `id` must be like civix:…, manual:…, or election:…" });
    }

    let provider;
    let key;
    if (id.startsWith("civix:")) {
      provider = "civix";
      key = id.slice(6);
    } else if (id.startsWith("manual:")) {
      provider = "manual";
      key = id.slice(7);
    } else if (id.startsWith("election:")) {
      provider = "election";
      key = decodeURIComponent(id.slice(9));
    } else {
      return res.status(400).json({ error: "Unknown catalog id format" });
    }

    try {
      if (provider === "civix") {
        const num = Number(key);
        if (!Number.isFinite(num)) return res.status(400).json({ error: "Invalid civix id" });
        return res.json(await civixElectionHttpPayload(num));
      }
      if (provider === "manual") {
        const json = await getManualElectionJsonById(key);
        if (!json) return res.status(404).json({ error: "Unknown manual election id" });
        return res.json({ provider: "manual", electionFile: JSON.parse(json) });
      }
      if (provider === "election") {
        const cfg = await getElectionSourceConfig(key);
        if (!cfg) return res.status(404).json({ error: "Unknown configured election" });
        const label = String(cfg.label ?? key).trim() || key;
        const rawElectionId = String(cfg.electionId ?? "").trim();
        const num = Number(rawElectionId);
        const isPureNumericId = Number.isFinite(num) && rawElectionId === String(num);
        if (isPureNumericId && cfg.usesCivixSos !== false) {
          return res.json(await civixElectionHttpPayload(num));
        }
        const file = await buildElectionFileFromCountyFeeds(rawElectionId, label);
        return res.json({ provider: "manual", electionFile: file });
      }
      return res.status(400).json({ error: "Unknown provider" });
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.post("/api/manual-elections", async (req, res) => {
    try {
      const { id: requestedId, label, electionFile } = req.body ?? {};
      const err = validateElectionFile(electionFile);
      if (err) return res.status(400).json({ error: err });
      if (!label || typeof label !== "string") return res.status(400).json({ error: "label (string) required" });

      const id = slugId(requestedId) || slugId(electionFile.election.id) || `election-${Date.now()}`;
      if (!id) return res.status(400).json({ error: "Could not derive id; pass id or election.election.id" });

      if (await manualElectionExists(id)) {
        return res.status(409).json({ error: `Manual election id already exists: ${id}` });
      }

      await insertManualElection(id, label.trim(), electionFile);

      res.status(201).json({
        ok: true,
        id,
        routeId: `manual:${id}`,
        catalogLabel: `${label.trim()} [Manual]`,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/compare/preview", (_req, res) => {
    res.json({
      implemented: false,
      description: "Will accept election + race keys and return per-candidate maxima across Civix, manual, and county feeds.",
    });
  });

  app.get("/api/county/galveston/sd4", async (_req, res) => {
    try {
      const countySources = await getElectionIngestConfig(TRACKED_CIVIX_ELECTION_ID);
      const summary = await fetchGalvestonSd4Summary(countySources.galveston);
      res.json(summary);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/county/jefferson/sd4", async (_req, res) => {
    try {
      const countySources = await getElectionIngestConfig(TRACKED_CIVIX_ELECTION_ID);
      const summary = await fetchJeffersonSd4Summary(countySources.jefferson);
      res.json(summary);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/county/harris/sd4", async (_req, res) => {
    try {
      const countySources = await getElectionIngestConfig(TRACKED_CIVIX_ELECTION_ID);
      const summary = await fetchHarrisSd4Summary(countySources.harris);
      res.json(summary);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/county/montgomery/sd4", async (_req, res) => {
    try {
      const countySources = await getElectionIngestConfig(TRACKED_CIVIX_ELECTION_ID);
      const summary = await fetchMontgomeryEresultsSd4Summary(countySources.montgomery);
      res.json(summary);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/county/chambers/sd4", async (_req, res) => {
    try {
      const countySources = await getElectionIngestConfig(TRACKED_CIVIX_ELECTION_ID);
      const summary = await fetchChambersSd4Summary(countySources.chambers || DEFAULT_ELECTION_CONFIG.chambersSourceUrl);
      res.json(summary);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  app.delete("/api/manual-elections/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const ok = await deleteManualElection(id);
      if (!ok) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/manual-elections/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const { label, electionFile } = req.body ?? {};
      const err = validateElectionFile(electionFile);
      if (err) return res.status(400).json({ error: err });
      if (!label || typeof label !== "string") return res.status(400).json({ error: "label (string) required" });

      const ok = await updateManualElection(id, label.trim(), electionFile);
      if (!ok) return res.status(404).json({ error: "Manual election not found" });
      res.json({ ok: true, id, routeId: `manual:${id}`, catalogLabel: `${label.trim()} [Manual]` });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return app;
}
