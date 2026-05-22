import "dotenv/config";
import express from "express";
import cors from "cors";
import { listCivixElectionSummaries, fetchCivixElectionBundle, fetchCivixElectionBundleWithOverrides } from "./lib/civixServer.mjs";
import { fetchGalvestonSd4Summary, fetchJeffersonSd4Summary } from "./lib/galvestonClarity.mjs";
import { fetchHarrisSd4Summary } from "./lib/harrisVotes.mjs";
import { fetchMontgomeryEresultsSd4Summary } from "./lib/montgomeryEresults.mjs";
import { fetchChambersSd4Summary } from "./lib/chambersReport.mjs";
import { runCountyFeedFetch } from "./lib/countyFeedHandlers.mjs";
import {
  countyKeysWithHubDiscoveryProfile,
  discoverCountyFeedUrlFromHub,
  discoverCountyFeedUrlsBulk,
} from "./lib/countyHubDiscovery.mjs";
import { getSd4HistoricalPayloadForApi } from "./lib/sd4HistoricalPrecinct.mjs";
import { buildElectionFileFromCountyFeeds } from "./lib/electionFileFromCountyResults.mjs";
import { decodeBase64Json, decodeUploadPayload, encodeBase64Json } from "./lib/b64.mjs";
import { isEvRosterEnabled } from "./lib/featureFlags.mjs";
import { buildOfficialEarlyVotingTurnoutPageUrl, listEvrElections } from "./lib/civixEvr.mjs";
import { pullEvRoster } from "./lib/evRoster.mjs";
import { EV_ROSTER_PULL_SCOPES } from "./lib/evRosterPullScopes.mjs";
import { rosterRowsToCsv } from "./lib/evRosterNormalize.mjs";
import { EV_ROSTER_HANDLERS } from "./lib/evRosterCountyHandlers.mjs";
import { getSourceOptionsPayload } from "./lib/evRosterSourceOptions.mjs";
import {
  countyHasEvRosterDiscoveryProfile,
  discoverEvRosterUrlFromHub,
  discoverEvRosterUrlsFromHub,
  listEvRosterDiscoveryProfiles,
} from "./lib/evRosterHubDiscovery.mjs";
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
  getLatestSosCivixSnapshot,
  insertManualElection,
  listDbTablesWithCounts,
  listManualElectionsMeta,
  manualElectionExists,
  pruneLiveResultHistory,
  appendSourceImportLog,
  appendVoteHistoryIfChanged,
  getElectionSourceConfig,
  getSourceImportLogPayload,
  listEvRosterConfigs,
  listEvRosterPullDates,
  listEvRosterPullDatesForElections,
  listEvRosterVoterDatesForElections,
  getEvRosterAggregatedSummary,
  getEvRosterPullPayload,
  getEvRosterExportRows,
  listEvRosterCountySources,
  upsertEvRosterCountySource,
  syncEvRosterCountySourcesFromTurnout,
  saveEvRosterPull,
  mergeEvRosterPull,
  recordEvRosterCountyPullResults,
  confirmEvRosterCountyPull,
  listEvRosterVoters,
  upsertEvRosterConfig,
  listElectionSourceConfigs,
  listElectionFeedSources,
  listIngestVendors,
  replaceElectionFeedSourcesForElection,
  flushPendingDatabasePersist,
  upsertElectionSourceConfig,
  setDefaultElectionCatalog,
  updateManualElection,
  updateAppSettings,
  upsertCountySosRaceLink,
  deleteCountySosRaceLink,
  upsertCountySosManualVote,
  upsertCountySosRaceVoteSource,
} from "./db.mjs";
import { catalogIdForSourceConfig, resolveDefaultCatalogId } from "./lib/electionCatalogId.mjs";
import { buildCountyRaceMappingView } from "./lib/countyRaceMappingView.mjs";
import { collectCivixSosRaces } from "./lib/civixSosRaces.mjs";
import { inferElectionPartyFromConfig } from "./lib/countySosRaceMatch.mjs";
import { mergeLinkedCountyOverridesIntoCivix } from "./lib/mergeLinkedCountyIntoCivix.mjs";
import { civixProxyHandler } from "./lib/civixProxy.mjs";
import { decodeCatalogIdFromPath } from "./lib/catalogIdPath.mjs";

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

async function shouldPreferCivixCacheOnCloud() {
  if (process.env.CIVIX_PREFER_CACHE === "1") return true;
  if (process.env.CIVIX_PREFER_CACHE === "0") return false;
  const { resolveCivixCookie } = await import("./lib/civixCredentials.mjs");
  if (await resolveCivixCookie()) return false;
  return Boolean(process.env.RENDER);
}

/** @param {unknown} raw */
function normalizeClientCivixBundle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const election = raw.election;
  const county = raw.county;
  if (!election || typeof election !== "object" || !county || typeof county !== "object") return null;
  return { election, county };
}

/**
 * Civix blocks many cloud/datacenter IPs (HTTP 403). Fall back to the last sos_results snapshot when live fetch fails.
 * @param {string | number} electionId
 * @param {string} [countyInfoUrl]
 */
async function loadCivixBundleWithCacheFallback(electionId, countyInfoUrl = "", opts = {}) {
  const override = String(countyInfoUrl ?? "").trim();
  const eid = String(electionId);
  const clientBundle = normalizeClientCivixBundle(opts.clientBundle);

  if (clientBundle) {
    return {
      election: clientBundle.election,
      county: clientBundle.county,
      sosCountyInfoUrlConfigured: override,
      sosCountyInfoUrlUsed:
        override ||
        `https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/${eid}`,
      civixFromCache: false,
      civixCacheNote: "SOS loaded from browser (live Civix JSON posted with force update).",
    };
  }

  if (await shouldPreferCivixCacheOnCloud()) {
    const snap = await getLatestSosCivixSnapshot(eid);
    if (snap) {
      console.info(
        `Civix: using stored sos_results for election ${eid} (${snap.fetchedAt || "unknown time"}); live API skipped on cloud host (set CIVIX_COOKIE to refresh from Civix on Render).`,
      );
      return {
        election: snap.election,
        county: snap.county,
        sosCountyInfoUrlConfigured: override,
        sosCountyInfoUrlUsed: snap.sosCountyInfoUrlUsed || "",
        civixFromCache: true,
        civixCacheNote: `SOS from stored snapshot${snap.fetchedAt ? ` (${snap.fetchedAt})` : ""}. Live Civix skipped on cloud host — set CIVIX_COOKIE on the API service to pull fresh statewide data on Render.`,
      };
    }
  }

  try {
    const bundle = override
      ? await fetchCivixElectionBundleWithOverrides(electionId, { countyInfoUrl: override })
      : await fetchCivixElectionBundle(electionId);
    return { ...bundle, civixFromCache: false, civixCacheNote: null };
  } catch (e) {
    const snap = await getLatestSosCivixSnapshot(eid);
    if (!snap) throw e;
    const err = e instanceof Error ? e.message : String(e);
    console.info(
      `Civix live fetch failed for election ${eid}; using cached sos_results (${snap.fetchedAt || "unknown time"}): ${err}`,
    );
    return {
      election: snap.election,
      county: snap.county,
      sosCountyInfoUrlConfigured: override,
      sosCountyInfoUrlUsed: snap.sosCountyInfoUrlUsed || "",
      civixFromCache: true,
      civixCacheNote: `Live Civix API unavailable (${err}). Using last stored SOS snapshot${snap.fetchedAt ? ` from ${snap.fetchedAt}` : ""}.`,
    };
  }
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
  const corsOrigins = [/localhost:\d+$/, /^127\.0\.0\.1:\d+$/, /^https:\/\/[a-z0-9-]+\.onrender\.com$/i];
  const extra = String(process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of extra) {
    try {
      corsOrigins.push(new RegExp(`^${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
    } catch {
      corsOrigins.push(o);
    }
  }
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: "80mb" }));

  /** Texas Civix ENR — browser uses /api-ivis-system on same host (Vite or static rewrite → here). */
  app.use("/api-ivis-system", (req, res) => {
    void civixProxyHandler(req, res);
  });

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
      isDefaultCatalog: !!r.isDefaultCatalog,
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
    /** Live step for /api/ingest/status while a refresh is in flight. */
    progress: null,
  };

  function clearIngestProgress() {
    ingestState.progress = null;
  }

  /** @param {Record<string, unknown>} update */
  function setIngestProgress(update) {
    ingestState.progress = {
      ...ingestState.progress,
      ...update,
      updatedAt: Date.now(),
    };
  }

  /** Serialize every full ingest (auto + manual) so two runs never append rows ms apart. */
  let ingestChain = Promise.resolve();
  function withIngestLock(task) {
    const next = ingestChain.then(() => task());
    ingestChain = next.catch(() => {});
    return next;
  }

  async function runFullIngestRefresh(electionId, ingestOpts = {}) {
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
      warnings: [],
    };
    /** Built after all county fetches; committed in one DB transaction (see commitCountyResultsBatch). */
    const countySegments = [];

    const vendorRows = await listIngestVendors();
    const vendorById = Object.fromEntries(vendorRows.map((v) => [v.id, v]));
    const feedRows = await listElectionFeedSources(String(electionId));
    const enabledFeeds = feedRows.filter((f) => f.isEnabled && String(f.countyKey || "").trim());
    const totalSteps = (cfg.usesCivixSos ? 1 : 0) + enabledFeeds.length + 2;
    let step = 0;
    setIngestProgress({
      electionId: String(electionId),
      phase: "start",
      detail: `Election ${electionId}: preparing ingest…`,
      step,
      totalSteps,
    });

    if (cfg.usesCivixSos) {
      step += 1;
      setIngestProgress({
        electionId: String(electionId),
        phase: "sos",
        detail: "Updating Texas SOS / Civix statewide data…",
        step,
        totalSteps,
      });
      try {
        const countyInfoUrl = cfg.sosCountyInfoUrl;
        const bundle = await loadCivixBundleWithCacheFallback(electionId, countyInfoUrl, {
          clientBundle: ingestOpts.clientCivixBundle,
        });
        const { election, county, civixFromCache, civixCacheNote } = bundle;
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
        const sosLogSuffix = civixFromCache && civixCacheNote ? ` — ${civixCacheNote}` : "";
        await appendSourceImportLog({
          sourceKey: sourceLogKey("sos"),
          ok: true,
          message: `OK: civix bundle + snapshot + ${sosCandidateRows.length} candidate rows + ${sosCountyRows.length} SOS county rows${sosLogSuffix}`,
        });
        if (civixCacheNote) result.warnings.push(civixCacheNote);
      } catch (e) {
        const msg = String(e?.message || e);
        result.errors.push(
          `SOS pull failed: ${msg}. County feeds can still update. Run a successful ingest once from a network that can reach Civix, or rely on county feeds only.`,
        );
        await appendSourceImportLog({ sourceKey: sourceLogKey("sos"), ok: false, message: msg });
      }
    } else {
      await appendSourceImportLog({
        sourceKey: sourceLogKey("sos"),
        ok: true,
        message: "Skipped: election is configured as not using Texas SOS / Civix ingest (county feeds only)",
      });
    }

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
      step += 1;
      const countyLabel = String(feed.civixCountyName || "").trim() || ck;
      setIngestProgress({
        electionId: String(electionId),
        phase: "county",
        countyKey: ck,
        detail: `Updating ${countyLabel} (${vendor.displayName})…`,
        step,
        totalSteps,
      });
      try {
        const effectiveUrl = String(feed.sourceUrl ?? "").trim();
        if (!effectiveUrl) {
          const hubPage = String(feed.hubPageUrl ?? "").trim();
          const msg = hubPage
            ? "Feed URL is empty — use “Discover from hubs” in election settings (hub page is saved but not resolved on ingest)."
            : "Feed URL is empty — set a feed URL or hub page in election settings.";
          result.errors.push(`${label}: ${msg}`);
          result.counties[ck] = { inserted: 0 };
          await appendSourceImportLog({ sourceKey: sourceLogKey(ck), ok: false, message: msg });
          continue;
        }

        const seg = await runCountyFeedFetch(
          { countyKey: ck, sourceUrl: effectiveUrl, civixCountyName: feed.civixCountyName },
          vendor,
        );
        countySegments.push(seg);
        const n = seg.rows?.length ?? 0;
        result.counties[ck] = { inserted: n };
        const reconNote = seg.reconciliationOnly
          ? " — reconciliation turnout only (no per-contest SD4)"
          : "";
        await appendSourceImportLog({
          sourceKey: sourceLogKey(ck),
          ok: true,
          message: `OK: ${n} rows (${vendor.displayName})${reconNote}`,
        });
      } catch (e) {
        const msg = String(e?.message || e);
        result.errors.push(`${label} (${vendor.displayName}): ${msg}`);
        result.counties[ck] = { inserted: 0 };
        await appendSourceImportLog({ sourceKey: sourceLogKey(ck), ok: false, message: msg });
      }
    }

    if (countySegments.length > 0) {
      step += 1;
      setIngestProgress({
        electionId: String(electionId),
        phase: "commit",
        detail: `Committing ${countySegments.length} county feed(s) to the database…`,
        step,
        totalSteps,
      });
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
    step += 1;
    setIngestProgress({
      electionId: String(electionId),
      phase: "prune",
      detail: "Pruning old result history…",
      step,
      totalSteps,
    });
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
    const { isDatabaseLoaded } = await import("./db.mjs");
    if (!isDatabaseLoaded()) await ensureDb();
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
      progress: ingestState.progress,
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
            for (let i = 0; i < active.length; i++) {
              const c = active[i];
              setIngestProgress({
                electionId: String(c.electionId),
                phase: "batch",
                detail: `Auto refresh ${i + 1}/${active.length}: ${c.label || c.electionId}`,
                step: i + 1,
                totalSteps: active.length,
              });
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
            clearIngestProgress();
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
    const { isDatabaseLoaded } = await import("./db.mjs");
    res.json({
      ok: true,
      service: "electionnighttracker-api",
      port: PORT,
      databaseReady: isDatabaseLoaded(),
      database: getDbInfo(),
      evRosterEnabled: isEvRosterEnabled(),
    });
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

  app.post("/api/election-source-configs/:electionId/set-default", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      if (!electionId) return res.status(400).json({ error: "electionId required" });
      const legacy = await getAppSettings();
      const updated = await setDefaultElectionCatalog(electionId);
      res.json(buildElectionConfig(electionId, updated, legacy));
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || e);
      res.status(msg.includes("not found") ? 404 : 500).json({ error: msg });
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

  app.get("/api/elections/:electionId/county-race-mapping", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      if (!electionId) return res.status(400).json({ error: "electionId required" });
      const num = Number(electionId);
      if (!Number.isFinite(num)) {
        return res.status(400).json({ error: "County race mapping requires a Civix numeric election id" });
      }
      const cfg = await getElectionIngestConfig(num);
      const bundle = await loadCivixBundleWithCacheFallback(num, cfg.sosCountyInfoUrl);
      const sosRaces = collectCivixSosRaces(bundle.election);
      const electionParty = inferElectionPartyFromConfig({
        electionId: cfg.electionId ?? electionId,
        label: cfg.label,
      });
      const view = await buildCountyRaceMappingView(electionId, sosRaces, {
        electionParty,
        electionLabel: cfg.label,
      });
      res.json({ electionId, ...view });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/elections/:electionId/county-race-mapping/link", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      const link = req.body?.link;
      if (!electionId || !link?.countyKey || !link?.countyContestName || !link?.sosRaceId) {
        return res.status(400).json({ error: "link.countyKey, link.countyContestName, and link.sosRaceId required" });
      }
      await upsertCountySosRaceLink(electionId, link);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.delete("/api/elections/:electionId/county-race-mapping/link", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      const countyKey = String(req.body?.countyKey ?? req.query?.countyKey ?? "").trim();
      const countyContestName = String(req.body?.countyContestName ?? req.query?.countyContestName ?? "").trim();
      if (!electionId || !countyKey || !countyContestName) {
        return res.status(400).json({ error: "countyKey and countyContestName required" });
      }
      await deleteCountySosRaceLink(electionId, countyKey, countyContestName);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/elections/:electionId/county-race-mapping/manual-vote", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      const row = req.body?.row;
      if (!electionId || !row?.countyKey || !row?.sosRaceId || !row?.sosCandidateId) {
        return res.status(400).json({ error: "row.countyKey, row.sosRaceId, and row.sosCandidateId required" });
      }
      await upsertCountySosManualVote(electionId, row);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/elections/:electionId/county-race-mapping/vote-source", async (req, res) => {
    try {
      await ensureDb();
      const electionId = String(req.params.electionId ?? "").trim();
      const row = req.body?.row;
      if (!electionId || !row?.countyKey || !row?.sosRaceId || !row?.voteSource) {
        return res.status(400).json({ error: "row.countyKey, row.sosRaceId, and row.voteSource required" });
      }
      await upsertCountySosRaceVoteSource(electionId, row);
      res.json({ ok: true });
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
      const persistedToDisk = await flushPendingDatabasePersist();
      const warning = persistedToDisk
        ? undefined
        : "County feeds were written to election-feed-configs.json. The main SQLite database file was not flushed yet (large database) — feeds will reload from that JSON backup after restart.";
      res.json({ electionId, sources: updated, persistedToDisk, ...(warning ? { warning } : {}) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/county-feed/hub-discovery-counties", (_req, res) => {
    res.json({ countyKeys: countyKeysWithHubDiscoveryProfile() });
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

  /** Bulk-resolve feed URLs from hub pages (settings workflow; not run during ingest). */
  app.post("/api/county-feed/discover-urls-bulk", async (req, res) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: "body.items must be a non-empty array" });
      }
      const normalized = items.map((item) => ({
        countyKey: String(item?.countyKey ?? "").trim().toLowerCase(),
        vendorId: item?.vendorId != null ? String(item.vendorId).trim() : undefined,
        hubUrl: String(item?.hubUrl ?? "").trim(),
        html: item?.html != null && String(item.html).trim() ? String(item.html) : undefined,
      }));
      const results = await discoverCountyFeedUrlsBulk(normalized);
      const okCount = results.filter((r) => r.ok).length;
      res.json({ results, okCount, total: results.length });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/settings", async (_req, res) => {
    try {
      await ensureDb();
      const settings = await getAppSettings();
      const { civixCookie: _omit, ...publicSettings } = settings;
      res.json(publicSettings);
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
        civixCookie: req.body?.civixCookie,
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
          result = await runFullIngestRefresh(String(electionId), {
            clientCivixBundle: normalizeClientCivixBundle(req.body?.civixBundle),
          });
          ingestState.lastRunEndTime = Date.now();
          ingestState.lastResult = result;
          const settings = await getAppSettings();
          const intervalMs = Math.max(15, Number(settings.autoRefreshIntervalSec) || 60) * 1000;
          if (settings.autoRefreshEnabled) {
            ingestState.nextScheduledRunAt = ingestState.lastRunEndTime + intervalMs;
          }
        } finally {
          ingestState.running = false;
          clearIngestProgress();
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
      let summaries = [];
      if (process.env.CIVIX_CATALOG_LABELS === "1") {
        try {
          summaries = await Promise.race([
            listCivixElectionSummaries(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Civix election list timed out")), 8_000),
            ),
          ]);
        } catch (e) {
          console.warn("Civix catalog labels skipped:", e?.message ?? e);
        }
      }
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

        const catalogId = catalogIdForSourceConfig(cfg);
        fromSettings.push({
          routeId: catalogId,
          catalogId,
          catalogLabel:
            isPureNumericId && cfg.usesCivixSos !== false
              ? `${labelBase} [Civix]`
              : `${labelBase} [County feeds]`,
          provider: isPureNumericId && cfg.usesCivixSos !== false ? "civix" : "manual",
          ...(isPureNumericId && cfg.usesCivixSos !== false ? { civixElectionId: num } : {}),
        });
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
      res.json({ entries, defaultCatalogId: resolveDefaultCatalogId(cfgs) });
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  async function civixElectionHttpPayload(num) {
    const cfg = await getElectionIngestConfig(num);
    const countyInfoUrl = cfg.sosCountyInfoUrl;
    const bundle = await loadCivixBundleWithCacheFallback(num, countyInfoUrl);
    const { election, county, sosCountyInfoUrlConfigured, sosCountyInfoUrlUsed, civixFromCache, civixCacheNote } =
      bundle;
    const mergedSd4 = await mergeSd4CountyOverridesIntoCivix(num, election, county);
    const merged = await mergeLinkedCountyOverridesIntoCivix(num, mergedSd4.electionPayload, mergedSd4.countyDoc);
    return {
      provider: "civix",
      civixElectionId: num,
      sosCountyInfoUrlConfigured,
      sosCountyInfoUrlUsed,
      election: merged.electionPayload,
      county: merged.countyDoc,
      ...(civixFromCache ? { civixFromCache: true, civixCacheNote } : {}),
    };
  }

  async function respondElectionByCatalogId(id, res) {
    if (typeof id !== "string" || !id.includes(":")) {
      return res.status(400).json({ error: "Catalog id must be like civix:…, manual:…, or election:…" });
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
      return res.status(502).json({ error: String(e.message || e) });
    }
  }

  function catalogIdFromElectionDataRequest(req) {
    if (typeof req.body?.catalogId === "string") return req.body.catalogId;
    if (typeof req.query.catalogId === "string") return req.query.catalogId;
    if (typeof req.query.id === "string") return req.query.id;
    if (typeof req.query.token === "string") {
      try {
        return decodeCatalogIdFromPath(req.query.token);
      } catch {
        return null;
      }
    }
    return null;
  }

  async function handleElectionDataRequest(req, res) {
    const id = catalogIdFromElectionDataRequest(req);
    if (typeof id !== "string" || !id.includes(":")) {
      return res.status(400).json({
        error: "Pass catalogId (e.g. civix:56181) as ?catalogId=… or POST JSON { catalogId }",
        hint: "Render static rewrites often drop POST bodies — prefer GET ?catalogId=",
      });
    }
    return respondElectionByCatalogId(id, res);
  }

  app.get("/api/election-data", handleElectionDataRequest);
  app.post("/api/election-data", handleElectionDataRequest);

  /** Base64url token in path (direct API access only). */
  app.get("/api/election-data/:token", async (req, res) => {
    try {
      const id = decodeCatalogIdFromPath(String(req.params.token ?? ""));
      return respondElectionByCatalogId(id, res);
    } catch {
      return res.status(400).json({ error: "Invalid election-data token" });
    }
  });

  /** @deprecated Prefer /api/election-data/:token */
  app.get("/api/election/:catalogIdEncoded", async (req, res) => {
    const id = decodeURIComponent(String(req.params.catalogIdEncoded ?? ""));
    return respondElectionByCatalogId(id, res);
  });

  app.get("/api/election", async (req, res) => {
    const id = req.query.id;
    if (typeof id !== "string" || !id.includes(":")) {
      return res.status(400).json({
        error: "Query `id` must be like civix:…, manual:…, or election:… (or use /api/election/:id)",
      });
    }
    return respondElectionByCatalogId(id, res);
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

  if (!isEvRosterEnabled()) {
    app.use("/api/ev-roster", (_req, res) => {
      res.status(503).json({
        error:
          "Early voting rosters are disabled (set EV_ROSTER_ENABLED=1 on the server to enable).",
      });
    });
  } else {
  /** Early voting rosters (Civix EVR) — separate from ENR election results. */
  app.get("/api/ev-roster/configs", async (_req, res) => {
    try {
      await ensureDb();
      const configs = await listEvRosterConfigs();
      const { groupConfigsIntoRunoffs } = await import("./lib/evRosterRunoff.mjs");
      res.json({ configs, runoffs: groupConfigsIntoRunoffs(configs) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/ev-roster/configs", async (req, res) => {
    try {
      await ensureDb();
      const body = req.body ?? {};
      const configs = await upsertEvRosterConfig({
        evrElectionId: Number(body.evrElectionId),
        party: body.party,
        electionName: body.electionName,
        electionDate: body.electionDate,
        isEnabled: body.isEnabled,
        notes: body.notes,
      });
      res.json({ configs });
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/civix-elections", async (_req, res) => {
    try {
      const data = await listEvrElections();
      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/page-url", (req, res) => {
    try {
      const electionId = Number(req.query.electionId);
      const electionName = String(req.query.electionName ?? "");
      const electionDate = String(req.query.electionDate ?? "");
      const date = String(req.query.date ?? req.query.votingDate ?? "");
      if (!electionId || !electionName || !electionDate || !date) {
        return res.status(400).json({
          error: "electionId, electionName, electionDate, and date (early voting day) are required",
        });
      }
      res.json({
        url: buildOfficialEarlyVotingTurnoutPageUrl({
          date,
          electionId,
          electionDate,
          electionName,
          isCertified: String(req.query.isCertified ?? "false").toLowerCase() === "true",
        }),
      });
    } catch (e) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/pulls", async (req, res) => {
    try {
      await ensureDb();
      const evrElectionId = Number(req.query.evrElectionId);
      if (!evrElectionId) return res.status(400).json({ error: "evrElectionId required" });
      const configs = await listEvRosterConfigs();
      const { runoffConfigsForElection } = await import("./lib/evRosterRunoff.mjs");
      const runoffCfgs = runoffConfigsForElection(configs, evrElectionId);
      const evrIds = runoffCfgs.map((c) => Number(c.evrElectionId));
      let dates = await listEvRosterVoterDatesForElections(evrIds);
      if (!dates.length) dates = await listEvRosterPullDatesForElections(evrIds);
      res.json({ evrElectionId, evrElectionIds: evrIds, pulls: dates });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/summary", async (req, res) => {
    try {
      await ensureDb();
      const evrElectionId = Number(req.query.evrElectionId);
      if (!evrElectionId) return res.status(400).json({ error: "evrElectionId required" });

      const configs = await listEvRosterConfigs();
      const { runoffConfigsForElection, configsForPartyFilter, summaryDateRangeFromPullDates } = await import(
        "./lib/evRosterRunoff.mjs"
      );
      const partyFilter = String(req.query.party ?? "ALL").toUpperCase();
      const runoffAll = runoffConfigsForElection(configs, evrElectionId);
      const runoffCfgs = configsForPartyFilter(runoffAll, partyFilter);
      const evrIds = runoffCfgs.map((c) => Number(c.evrElectionId));
      const runoffAllIds = runoffAll.map((c) => Number(c.evrElectionId));

      let dateFrom = String(req.query.dateFrom ?? "").trim();
      let dateTo = String(req.query.dateTo ?? "").trim();
      const votingDate = String(req.query.votingDate ?? "").trim();

      if (votingDate && !dateFrom && !dateTo) {
        dateFrom = votingDate;
        dateTo = votingDate;
      }

      if (!dateFrom || !dateTo) {
        let pulls = await listEvRosterVoterDatesForElections(runoffAllIds);
        if (!pulls.length) pulls = await listEvRosterPullDatesForElections(runoffAllIds);
        const stored = pulls.map((p) => p.votingDate).filter(Boolean);
        const defaults = summaryDateRangeFromPullDates(stored);
        dateFrom = dateFrom || defaults.dateFrom;
        dateTo = dateTo || defaults.dateTo;
      }

      if (!dateFrom || !dateTo) {
        return res.json({ pull: null, counties: [], countyPullLog: [], dateFrom: "", dateTo: "", party: partyFilter });
      }

      if (!evrIds.length) {
        return res.json({
          pull: null,
          counties: [],
          countyPullLog: [],
          dateFrom,
          dateTo,
          party: partyFilter,
          message: `No ${partyFilter} election configured for this runoff.`,
        });
      }

      const aggregated = await getEvRosterAggregatedSummary(evrIds, dateFrom, dateTo);
      if (aggregated.counties?.length) {
        return res.json({ ...aggregated, party: partyFilter });
      }

      let storedPulls = await listEvRosterVoterDatesForElections(runoffAllIds);
      if (!storedPulls.length) storedPulls = await listEvRosterPullDatesForElections(runoffAllIds);
      const hasStoredPulls = storedPulls.length > 0;

      const cfg = runoffCfgs[0] ?? configs.find((c) => c.evrElectionId === evrElectionId);
      if (!hasStoredPulls && partyFilter === "ALL" && cfg) {
        try {
          const { pullSosEarlyVotingRoster } = await import("./lib/evRoster.mjs");
          const sos = await pullSosEarlyVotingRoster({
            evrElectionId: cfg.evrElectionId,
            electionName: cfg.electionName,
            electionDate: cfg.electionDate,
            votingDate: dateTo,
            party: "",
          });
          return res.json({
            pull: null,
            counties: sos.countySummaries,
            countyPullLog: [],
            dateFrom,
            dateTo,
            party: partyFilter,
            sosPreview: true,
            message:
              "Live SOS turnout preview — run Pull to save all parties and days through today.",
          });
        } catch (e) {
          console.warn("SOS preview for summary failed:", e?.message ?? e);
        }
      }

      res.json({ pull: null, counties: [], countyPullLog: [], dateFrom, dateTo, party: partyFilter });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/pull/progress", async (req, res) => {
    const { getPullProgress, prunePullProgress } = await import("./lib/evRosterPullProgress.mjs");
    prunePullProgress();
    const jobId = String(req.query.jobId ?? "");
    res.json(getPullProgress(jobId));
  });

  app.post("/api/ev-roster/pull", async (req, res) => {
    try {
      await ensureDb();
      const { startEvRosterPullJob } = await import("./lib/evRosterPullJob.mjs");
      const started = await startEvRosterPullJob(req.body ?? {});
      res.json(started);
    } catch (e) {
      const msg = String(e?.message || e);
      console.error("ev-roster pull start", e);
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/ev-roster/county-confirm", async (req, res) => {
    try {
      await ensureDb();
      const body = req.body ?? {};
      const evrElectionId = Number(body.evrElectionId);
      const votingDate = String(body.votingDate ?? body.date ?? "").trim();
      const countyName = String(body.countyName ?? "").trim();
      if (!evrElectionId || !votingDate || !countyName) {
        return res.status(400).json({ error: "evrElectionId, votingDate, and countyName required" });
      }
      const statuses = await confirmEvRosterCountyPull(evrElectionId, votingDate, countyName);
      const payload = await getEvRosterPullPayload(evrElectionId, votingDate);
      res.json({ ok: true, statuses, summary: payload });
    } catch (e) {
      console.error("ev-roster county-confirm", e);
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/pull-scopes", (_req, res) => {
    res.json({ scopes: EV_ROSTER_PULL_SCOPES });
  });

  app.get("/api/ev-roster/voters", async (req, res) => {
    try {
      await ensureDb();
      const evrElectionId = Number(req.query.evrElectionId);
      const votingDate = String(req.query.votingDate ?? "");
      if (!evrElectionId || !votingDate) {
        return res.status(400).json({ error: "evrElectionId and votingDate required" });
      }
      const countyParam = req.query.county;
      const counties = req.query.counties
        ? String(req.query.counties)
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : Array.isArray(countyParam)
          ? countyParam
          : countyParam
            ? [String(countyParam)]
            : [];
      const result = await listEvRosterVoters(evrElectionId, votingDate, {
        limit: req.query.limit,
        offset: req.query.offset,
        counties,
        q: req.query.q,
      });
      res.json({ evrElectionId, votingDate, ...result });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/export.csv", async (req, res) => {
    try {
      await ensureDb();
      const evrElectionId = Number(req.query.evrElectionId);
      const votingDate = String(req.query.votingDate ?? "");
      if (!evrElectionId || !votingDate) {
        return res.status(400).json({ error: "evrElectionId and votingDate required" });
      }
      const rows = await getEvRosterExportRows(evrElectionId, votingDate);
      const csv = rows.length ? rosterRowsToCsv(rows) : "VUID,County,Party,Date,Method\r\n";
      const configs = await listEvRosterConfigs();
      const cfg = configs.find((c) => c.evrElectionId === evrElectionId);
      const party = cfg?.party ?? "export";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ev-roster-${party}-${votingDate}.csv"`,
      );
      res.send(csv);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/ev-roster/handlers", (_req, res) => {
    res.json({ handlers: EV_ROSTER_HANDLERS });
  });

  app.get("/api/ev-roster/source-options", (_req, res) => {
    res.json(getSourceOptionsPayload());
  });

  app.get("/api/ev-roster/discovery-profiles", (_req, res) => {
    res.json({ profiles: listEvRosterDiscoveryProfiles() });
  });

  app.get("/api/ev-roster/county-sources", async (req, res) => {
    try {
      await ensureDb();
      const evrElectionId = Number(req.query.evrElectionId);
      if (!evrElectionId) return res.status(400).json({ error: "evrElectionId required" });
      const configs = await listEvRosterConfigs();
      const cfg = configs.find((c) => c.evrElectionId === evrElectionId);
      const { ensureKnownCountyEvRosterSources } = await import("./lib/evRosterCountySeed.mjs");
      const sources = await ensureKnownCountyEvRosterSources(evrElectionId, cfg?.electionDate, cfg?.party, {
        listFn: listEvRosterCountySources,
        upsertFn: upsertEvRosterCountySource,
        listConfigsFn: listEvRosterConfigs,
      });
      res.json({ evrElectionId, sources });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/ev-roster/county-sources", async (req, res) => {
    try {
      await ensureDb();
      const body = req.body ?? {};
      const savedRow = {
        id: body.id != null ? Number(body.id) : null,
        evrElectionId: Number(body.evrElectionId),
        countyKey: body.countyKey,
        variantKey: body.variantKey,
        sourceLabel: body.sourceLabel,
        civixCountyName: body.civixCountyName,
        civixCountyId: body.civixCountyId,
        handlerKey: body.handlerKey,
        hubPageUrl: body.hubPageUrl,
        rosterUrl: body.rosterUrl,
        votingMethodScope: body.votingMethodScope,
        dateScope: body.dateScope,
        fileFormat: body.fileFormat,
        rosterPartyScope: body.rosterPartyScope,
        discoveryProfileKey: body.discoveryProfileKey,
        trainingNotes: body.trainingNotes,
        isEnabled: body.isEnabled,
      };
      await upsertEvRosterCountySource(savedRow);
      const { propagateCountySourceToSiblingElections } = await import("./lib/evRosterCountyMirror.mjs");
      await propagateCountySourceToSiblingElections(savedRow, {
        listFn: listEvRosterCountySources,
        upsertFn: upsertEvRosterCountySource,
        listConfigsFn: listEvRosterConfigs,
      });
      const sources = await listEvRosterCountySources(Number(body.evrElectionId));
      res.json({ sources });
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.post("/api/ev-roster/discover", async (req, res) => {
    try {
      const body = req.body ?? {};
      const { hubPageUrl, countyKey, html } = body;
      if (!hubPageUrl || !countyKey) {
        return res.status(400).json({ error: "hubPageUrl and countyKey required" });
      }
      if (!countyHasEvRosterDiscoveryProfile(countyKey)) {
        return res.status(400).json({
          error: `No EV roster discovery profile for "${countyKey}". Add one in server/lib/evRosterHubDiscovery.mjs.`,
        });
      }
      const configs = await listEvRosterConfigs();
      const cfg = configs.find((c) => c.evrElectionId === Number(body.evrElectionId));
      const discoverAll = body.all === true || body.discoverAll === true;
      const discoverOpts = {
        countyKey,
        html,
        electionDate: body.electionDate ?? cfg?.electionDate,
        reportCode: body.reportCode,
      };
      const result = discoverAll
        ? await discoverEvRosterUrlsFromHub(String(hubPageUrl), discoverOpts)
        : await discoverEvRosterUrlFromHub(String(hubPageUrl), {
            ...discoverOpts,
            methodScope: body.methodScope,
            stageId: body.stageId,
            rosterPartyScope: body.rosterPartyScope,
            votingDate: body.votingDate,
          });
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e?.message || e) });
    }
  });
  }

  app.use((req, res) => {
    const path = String(req.path ?? req.url ?? "").split("?")[0];
    if (path === "/api" || path.startsWith("/api/")) {
      const hint =
        path === "/api/$1"
          ? "Render rewrite used $1 — use Destination https://YOUR-API.onrender.com/api/* (asterisk, not $1)."
          : path === "/api/election" || path.startsWith("/api/election/")
            ? "Use /api/election-data/{token} — catalog ids must not include raw colons in the path"
            : undefined;
      res.status(404).json({ error: `No API route for ${path}`, hint });
      return;
    }
    res.status(404).send("Not found");
  });

  return app;
}
