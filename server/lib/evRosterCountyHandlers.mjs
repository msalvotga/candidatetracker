import { fetchCountyEarlyVotingRosterCsv, parseStatewideRosterCsv } from "./civixEvr.mjs";
import { fetchRosterFile, parseRosterFromFile } from "./evRosterFileParse.mjs";
import { toIsoDateKey } from "./evRosterDateMatch.mjs";
import {
  countyHasEvRosterDiscoveryProfile,
  discoverEvRosterUrlFromHub,
  resolveDiscoveryStageId,
} from "./evRosterHubDiscovery.mjs";
import { methodCodeFromScope, normalizeParty, partyTagForRosterRow } from "./evRosterNormalize.mjs";

export const EV_ROSTER_HANDLERS = [
  {
    id: "civix_sos_county_csv",
    displayName: "Texas SOS Civix (per-county CSV)",
    notes: "Civix getFileByFormat for one county. Falls back to statewide slice if empty.",
  },
  {
    id: "civix_sos_county_slice",
    displayName: "Texas SOS Civix (slice from statewide pull)",
    notes: "Uses already-downloaded statewide CSV filtered to this county.",
  },
  {
    id: "hub_page_discover",
    displayName: "Hub page (discover file on each pull)",
    notes:
      "Uses hub_page_url and the county discovery profile. Finds the BBM or EV roster link on the hub when you pull — no static file URL required.",
  },
  {
    id: "generic_file_url",
    displayName: "Direct file URL (CSV / TXT / ZIP)",
    notes: "Downloads roster_url. If roster_url is empty but hub_page_url is set, discovers from the hub first.",
  },
  {
    id: "generic_csv_url",
    displayName: "Direct CSV URL (legacy)",
    notes: "Same as generic_file_url.",
  },
  {
    id: "unimplemented",
    displayName: "Not configured",
    notes: "Set roster_url manually or train a county discovery profile + handler.",
  },
];

/**
 * @typedef {object} CountyPullContext
 * @property {number} evrElectionId
 * @property {string} votingDate
 * @property {string} electionDate
 * @property {string} party
 * @property {string} countyKey
 * @property {string} civixCountyName
 * @property {number | null} [civixCountyId]
 * @property {string} [rosterUrl]
 * @property {string} [votingMethodScope]
 * @property {string} [dateScope]
 * @property {string} [fileFormat]
 * @property {import('./civixEvr.mjs').ReturnType<typeof parseStatewideRosterCsv>} [statewideRows]
 */

/**
 * @param {object} source
 * @param {CountyPullContext} ctx
 */
export async function runCountyRosterFetch(source, ctx) {
  const hk = String(source.handlerKey ?? "unimplemented").trim();
  const countyName = String(source.civixCountyName ?? ctx.civixCountyName ?? "").toUpperCase();
  const variant = source.variantKey ? `${source.variantKey}` : source.countyKey;
  const sourceKey = `county:${ctx.countyKey}:${variant}`;

  const normOpts = {
    countyName,
    party: ctx.party,
    sourceKey,
    votingMethodScope: source.votingMethodScope ?? ctx.votingMethodScope ?? "ALL",
  };

  switch (hk) {
    case "civix_sos_county_csv": {
      if (!ctx.civixCountyId) throw new Error("civix_county_id required for Civix county CSV");
      const fetched = await fetchCountyEarlyVotingRosterCsv(
        ctx.evrElectionId,
        ctx.votingDate,
        countyName,
        ctx.civixCountyId,
      );
      let rows = fetched.rows;
      if (!rows.length && ctx.statewideRows?.length) {
        rows = sliceStatewideForCounty(ctx.statewideRows, countyName);
      }
      return {
        sourceUrl: fetched.sourceUrl,
        rows: toNormalizedRecords(rows, normOpts),
      };
    }
    case "civix_sos_county_slice": {
      if (!ctx.statewideRows?.length) throw new Error("Statewide SOS roster required before per-county slice");
      const rows = sliceStatewideForCounty(ctx.statewideRows, countyName);
      return {
        sourceUrl: `sos-statewide-slice:${countyName}`,
        rows: toNormalizedRecords(rows, { ...normOpts, sourceKey: `sos:${countyName}` }),
      };
    }
    case "hub_page_discover": {
      const resolved = await resolveRosterDownloadUrl(source, ctx);
      return fetchAndParseRosterFile(resolved.url, source, ctx, normOpts, resolved.via);
    }
    case "generic_file_url":
    case "generic_csv_url": {
      const resolved = await resolveRosterDownloadUrl(source, ctx);
      return fetchAndParseRosterFile(resolved.url, source, ctx, normOpts, resolved.via);
    }
    case "unimplemented": {
      const hub = String(source.hubPageUrl ?? "").trim();
      if (hub && countyHasEvRosterDiscoveryProfile(ctx.countyKey)) {
        return runCountyRosterFetch({ ...source, handlerKey: "hub_page_discover" }, ctx);
      }
      const url = String(source.rosterUrl ?? "").trim();
      if (!url) {
        return { sourceUrl: null, rows: [], skipped: true, message: "No hub URL or roster URL configured" };
      }
      return runCountyRosterFetch({ ...source, handlerKey: "generic_file_url" }, ctx);
    }
    default:
      throw new Error(`Unknown EV roster handler: ${hk}`);
  }
}

/**
 * @param {object} source
 * @param {CountyPullContext} ctx
 */
async function resolveRosterDownloadUrl(source, ctx) {
  const hk = String(source.handlerKey ?? "").trim();
  const hub = String(source.hubPageUrl ?? "").trim();
  const countyKey = String(ctx.countyKey ?? source.countyKey ?? "").toLowerCase();
  const methodScope = source.votingMethodScope ?? ctx.votingMethodScope ?? "ALL";
  const cached = String(source.rosterUrl ?? ctx.rosterUrl ?? "").trim();

  if (hk === "hub_page_discover") {
    if (!hub) throw new Error("hub_page_url required — file link is resolved from the hub on each pull");
    if (!countyHasEvRosterDiscoveryProfile(countyKey)) {
      throw new Error(`No discovery profile for county "${countyKey}"`);
    }
    const discovered = await discoverEvRosterUrlFromHub(hub, {
      countyKey,
      methodScope,
      rosterPartyScope: source.rosterPartyScope,
      variantKey: source.variantKey,
      stageId: resolveDiscoveryStageId(countyKey, source.variantKey) || undefined,
      votingDate: ctx.votingDate,
    });
    if (!discovered.url) {
      throw new Error(discovered.message ?? `No roster link on hub for method scope ${methodScope}`);
    }
    return { url: discovered.url, via: `hub:${discovered.matchedStage ?? "discover"}` };
  }

  if (cached) return { url: cached, via: "direct" };

  if (hub && countyHasEvRosterDiscoveryProfile(countyKey)) {
    const discovered = await discoverEvRosterUrlFromHub(hub, {
      countyKey,
      methodScope,
      rosterPartyScope: source.rosterPartyScope,
      variantKey: source.variantKey,
      stageId: resolveDiscoveryStageId(countyKey, source.variantKey) || undefined,
      votingDate: ctx.votingDate,
    });
    if (discovered.url) {
      return { url: discovered.url, via: `hub:${discovered.matchedStage ?? "discover"}` };
    }
  }

  throw new Error("roster_url or hub_page_url with discovery profile required");
}

/**
 * @param {string} url
 * @param {object} source
 * @param {CountyPullContext} ctx
 * @param {object} normOpts
 * @param {string} via
 */
/**
 * Williamson DocumentCenter "View" pages need a direct .xlsx URL on wilcotx.gov.
 * @param {string} url
 * @param {string} countyKey
 */
function resolveDocumentCenterFileUrl(url, countyKey) {
  const u = String(url ?? "").trim();
  if (!u) return u;
  const m = /documentcenter\/view\/(\d+)\/([^/?#]+?)(?:\.[a-z0-9]{2,5})?$/i.exec(u);
  if (!m || /\.(xlsx|csv|zip|pdf|txt)$/i.test(u)) return u;
  const slug = m[2];
  const id = m[1];
  if (String(countyKey ?? "").toLowerCase() === "williamson") {
    return `https://www.wilcotx.gov/DocumentCenter/View/${id}/${slug}.xlsx`;
  }
  return `${u}.xlsx`;
}

async function fetchAndParseRosterFile(url, source, ctx, normOpts, via) {
  const countyName = String(source.civixCountyName ?? ctx.civixCountyName ?? "").toUpperCase();
  const downloadUrl = resolveDocumentCenterFileUrl(url, ctx.countyKey ?? source.countyKey);
  const file = await fetchRosterFile(downloadUrl);
  const dateScope = String(source.dateScope ?? ctx.dateScope ?? "SINGLE_DAY").toUpperCase();
  const parsed = await parseRosterFromFile(
    {
      buffer: file.buffer,
      contentType: file.contentType,
      fileName: file.fileName,
      fileFormat: source.fileFormat ?? ctx.fileFormat ?? "auto",
    },
    {
      defaultCounty: countyName,
      votingDate: toIsoDateKey(ctx.votingDate ?? ""),
      dateScope,
      pullParty: ctx.party,
      filePartyScope: source.rosterPartyScope ?? "COMBINED",
      votingMethodScope: source.votingMethodScope ?? ctx.votingMethodScope ?? "ALL",
      archiveFileName: file.fileName,
    },
  );
  const dateNote = dateScope === "CUMULATIVE" ? " (cumulative)" : "";
  const partyNote = ctx.party ? `, ${ctx.party} voters` : "";
  const viaNote = via.startsWith("hub:") ? ` via hub (${via.slice(4)})` : "";
  return {
    sourceUrl: downloadUrl,
    rows: toNormalizedRecords(parsed, {
      ...normOpts,
      filePartyScope: source.rosterPartyScope ?? "COMBINED",
    }),
    message: `Parsed ${parsed.length} rows as ${resolveFormatLabel(source, file)}${dateNote}${partyNote}${viaNote}`,
  };
}

function resolveFormatLabel(source, file) {
  const ff = String(source.fileFormat ?? "auto");
  if (ff !== "auto") return ff;
  if (file.fileName?.toLowerCase().endsWith(".zip")) return "zip";
  if (file.fileName?.toLowerCase().endsWith(".txt")) return "txt";
  return "csv";
}

function sliceStatewideForCounty(statewideRows, countyName) {
  const want = String(countyName ?? "").toUpperCase();
  return statewideRows.filter((r) => String(r.county ?? "").toUpperCase() === want);
}

function toNormalizedRecords(rows, { countyName, party, sourceKey, votingMethodScope, filePartyScope }) {
  const pullParty = normalizeParty(party);
  const scope = filePartyScope ?? "COMBINED";
  return rows.map((r) => {
    const rawMethod = r.votingMethod ?? r.VOTING_METHOD ?? "";
    const rowParty = normalizeParty(partyTagForRosterRow(r, scope, pullParty) || r.party || pullParty);
    return {
      vuid: String(r.vuid ?? r.ID_VOTER ?? ""),
      countyName: String(r.county ?? r.countyName ?? countyName).toUpperCase(),
      voterName: r.voterName ?? r.VOTER_NAME ?? null,
      votingMethod: rawMethod,
      methodCode: methodCodeFromScope(rawMethod, votingMethodScope),
      party: rowParty || pullParty,
      precinct: r.precinct ?? r.PRECINCT ?? null,
      activityDate: r.activityDate ?? r.ActivityDate ?? null,
      sourceKey,
    };
  });
}
