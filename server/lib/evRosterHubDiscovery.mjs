/**
 * Discover early-voting roster download links from county election hub pages.
 */

import {
  discoverCountyFeedUrlFromHub,
  discoverCountyFeedUrlFromLinks,
  extractAnchorsFromHtml,
  fetchHubPageHtml,
  normalizeLinkText,
  validateHubUrlForDiscoveryFetch,
} from "./countyHubDiscovery.mjs";
import { discoverHarrisReportZipUrls } from "./harrisEvRosterDiscovery.mjs";
import { entryMatchesVotingDate } from "./evRosterDateMatch.mjs";
import { normalizeRosterPartyScope } from "./evRosterNormalize.mjs";

/** @typedef {{ id: string, label: string, test: (text: string) => boolean, suggestedVariantKey?: string, suggestedLabel?: string, suggestedMethodScope?: string, suggestedDateScope?: string, suggestedFileFormat?: string }} EvRosterDiscoveryStage */

/** @type {Record<string, EvRosterDiscoveryStage[]>} */
export const EV_ROSTER_PROFILES = {
  harris: [
    {
      id: "bbm_roster",
      label: "Primary runoff — unofficial BBM roster (ZIP)",
      test: (t) =>
        /\bprimary\s+runoff\b/i.test(t) && /\bBBM\b/i.test(t) && /\broster\b/i.test(t),
      suggestedVariantKey: "bbm-zip",
      suggestedLabel: "Harris BBM roster ZIP",
      suggestedMethodScope: "AB",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "zip",
      suggestedRosterPartyScope: "COMBINED",
    },
    {
      id: "ev_roster",
      label: "Primary runoff — unofficial early voting roster (ZIP)",
      test: (t) =>
        /\bprimary\s+runoff\b/i.test(t) &&
        /\bearly\s+vot/i.test(t) &&
        /\broster\b/i.test(t) &&
        !/\bBBM\b/i.test(t),
      suggestedVariantKey: "ev-zip",
      suggestedLabel: "Harris EV roster ZIP",
      suggestedMethodScope: "EV",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "zip",
      suggestedRosterPartyScope: "COMBINED",
    },
    {
      id: "bbm_roster_loose",
      label: "Unofficial BBM roster",
      test: (t) => /\bBBM\b/i.test(t) && /\broster\b/i.test(t) && !/\bearly\s+vot/i.test(t),
      suggestedVariantKey: "bbm-zip",
      suggestedLabel: "Harris BBM roster ZIP",
      suggestedMethodScope: "AB",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "zip",
    },
    {
      id: "ev_roster_loose",
      label: "Unofficial early voting roster",
      test: (t) =>
        /\bearly\s+vot/i.test(t) && /\broster\b/i.test(t) && !/\bBBM\b/i.test(t),
      suggestedVariantKey: "ev-zip",
      suggestedLabel: "Harris EV roster ZIP",
      suggestedMethodScope: "EV",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "zip",
    },
  ],
  dallas: [
    {
      id: "in_person_early_voter_list",
      label: "In-Person Early Voter List",
      test: (t) =>
        /\bin[- ]?person\b.*\bearly\s+voter\s+list\b/i.test(t) ||
        /in-person-early-voting/i.test(t),
      suggestedVariantKey: "ev-inperson-xlsx",
      suggestedLabel: "Dallas in-person early voter list",
      suggestedMethodScope: "EV",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "xlsx",
      suggestedRosterPartyScope: "COMBINED",
    },
    {
      id: "mail_ballots_returned",
      label: "Mail Ballots Returned",
      test: (t) =>
        /\bmail\s+ballots?\s+returned\b/i.test(t) || /mail-ballot-returns-report/i.test(t),
      suggestedVariantKey: "bbm-returned-xlsx",
      suggestedLabel: "Dallas mail ballots returned",
      suggestedMethodScope: "AB",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "xlsx",
      suggestedRosterPartyScope: "COMBINED",
    },
  ],
  galveston: [
    {
      id: "ev_roster_csv",
      label: "Early voting CSV / roster",
      test: (t) => /\bearly\s+vot/i.test(t) && /\.(csv|xlsx?|zip)\b/i.test(t),
    },
  ],
  travis: [
    {
      id: "voter_rosters_zip",
      label: "PR voter rosters (ZIP of daily XLSX)",
      test: (t) => /voter[- ]?rosters?\.zip/i.test(t) || /PR\d+-Voter-Rosters/i.test(t),
      suggestedVariantKey: "pr26-daily-zip",
      suggestedLabel: "Travis daily rosters (ZIP)",
      suggestedMethodScope: "ALL",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "zip",
      suggestedRosterPartyScope: "COMBINED",
    },
  ],
  fort_bend: [
    {
      id: "bbm_pdf",
      label: "Ballot by mail roster (PDF)",
      test: (t) =>
        /\.pdf\b/i.test(t) &&
        !/sample-ballot/i.test(t) &&
        !/0518-\.\./i.test(t) &&
        (/\bbbm\b/i.test(t) || /0518\._1\.pdf/i.test(t) || /\bby[- ]?mail\b/i.test(t)),
      suggestedVariantKey: "bbm-pdf",
      suggestedLabel: "Fort Bend BBM roster (PDF)",
      suggestedMethodScope: "AB",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "pdf",
      suggestedRosterPartyScope: "COMBINED",
    },
    {
      id: "ev_pdf",
      label: "Early voting in person roster (PDF)",
      test: (t) =>
        /\.pdf\b/i.test(t) &&
        !/sample-ballot/i.test(t) &&
        (/(^|\s)ev(\s|$)/i.test(t) || /\bpersonal\s+appearance\b/i.test(t)) &&
        !/\bby[- ]?mail\b/i.test(t),
      suggestedVariantKey: "ev-pdf",
      suggestedLabel: "Fort Bend EV roster (PDF)",
      suggestedMethodScope: "EV",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "pdf",
      suggestedRosterPartyScope: "COMBINED",
    },
  ],
  williamson: [
    {
      id: "daily_voter_roster",
      label: "Daily voting roster (XLSX)",
      test: (t) =>
        /daily\s+voting\s+roster|voter\s+turnout/i.test(t) &&
        (/\.xlsx/i.test(t) || /documentcenter\/view\/\d+/i.test(t)),
      suggestedVariantKey: "daily-roster-xlsx",
      suggestedLabel: "Williamson daily voting roster",
      suggestedMethodScope: "ALL",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "xlsx",
      suggestedRosterPartyScope: "COMBINED",
    },
  ],
  bexar: [
    {
      id: "bbm_rep",
      label: "Received primary runoff — Republican (election day / BBM)",
      test: (t) =>
        /\breceived\b/i.test(t) &&
        /\bprimary\s+runoff\b/i.test(t) &&
        /\belection\s+day\b/i.test(t) &&
        /\brepublican\b/i.test(t),
      suggestedVariantKey: "bbm-rep",
      suggestedLabel: "Bexar received ballots — Republican",
      suggestedMethodScope: "AB",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "pdf",
      suggestedRosterPartyScope: "REP_ONLY",
    },
    {
      id: "bbm_dem",
      label: "Received primary runoff — Democrat (election day / BBM)",
      test: (t) =>
        /\breceived\b/i.test(t) &&
        /\bprimary\s+runoff\b/i.test(t) &&
        /\belection\s+day\b/i.test(t) &&
        /\bdemocrat(ic)?\b/i.test(t),
      suggestedVariantKey: "bbm-dem",
      suggestedLabel: "Bexar received ballots — Democrat",
      suggestedMethodScope: "AB",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "pdf",
      suggestedRosterPartyScope: "DEM_ONLY",
    },
    {
      id: "ev_rep",
      label: "Early voting — Republican (daily PDF)",
      test: (t) =>
        /\bearly\s+vot/i.test(t) &&
        !/\breceived\b/i.test(t) &&
        /\brepublican\b/i.test(t),
      suggestedVariantKey: "ev-rep",
      suggestedLabel: "Bexar early voting — Republican",
      suggestedMethodScope: "EV",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "pdf",
      suggestedRosterPartyScope: "REP_ONLY",
    },
    {
      id: "ev_dem",
      label: "Early voting — Democrat (daily PDF)",
      test: (t) =>
        /\bearly\s+vot/i.test(t) &&
        !/\breceived\b/i.test(t) &&
        /\bdemocrat(ic)?\b/i.test(t),
      suggestedVariantKey: "ev-dem",
      suggestedLabel: "Bexar early voting — Democrat",
      suggestedMethodScope: "EV",
      suggestedDateScope: "SINGLE_DAY",
      suggestedFileFormat: "pdf",
      suggestedRosterPartyScope: "DEM_ONLY",
    },
  ],
  collin: [
    {
      id: "ab_rep",
      label: "Absentee / by-mail returns — Republican",
      test: (t) =>
        /\b(absentee|by[- ]?mail)\b/i.test(t) &&
        /\b(return|received)/i.test(t) &&
        (/\brepublican\b/i.test(t) || /\b_rep\b/i.test(t) || /_rep\./i.test(t)),
      suggestedVariantKey: "ab-rep",
      suggestedLabel: "Collin absentee returns — Republican",
      suggestedMethodScope: "AB",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "xlsx",
      suggestedRosterPartyScope: "REP_ONLY",
    },
    {
      id: "ab_dem",
      label: "Absentee / by-mail returns — Democrat",
      test: (t) =>
        /\b(absentee|by[- ]?mail)\b/i.test(t) &&
        /\b(return|received)/i.test(t) &&
        (/\bdemocrat(ic)?\b/i.test(t) || /\b_dem\b/i.test(t) || /_dem\./i.test(t)),
      suggestedVariantKey: "ab-dem",
      suggestedLabel: "Collin absentee returns — Democrat",
      suggestedMethodScope: "AB",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "xlsx",
      suggestedRosterPartyScope: "DEM_ONLY",
    },
    {
      id: "ev_rep",
      label: "Early voters — Republican",
      test: (t) =>
        /\bearly\s+vot/i.test(t) &&
        !/\babsentee\b/i.test(t) &&
        (/\brepublican\b/i.test(t) || /-republican/i.test(t) || /_rep\./i.test(t)),
      suggestedVariantKey: "ev-rep",
      suggestedLabel: "Collin early voters — Republican",
      suggestedMethodScope: "EV",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "xlsx",
      suggestedRosterPartyScope: "REP_ONLY",
    },
    {
      id: "ev_dem",
      label: "Early voters — Democrat",
      test: (t) =>
        /\bearly\s+vot/i.test(t) &&
        !/\babsentee\b/i.test(t) &&
        (/\bdemocrat(ic)?\b/i.test(t) || /-democrat/i.test(t) || /_dem\./i.test(t)),
      suggestedVariantKey: "ev-dem",
      suggestedLabel: "Collin early voters — Democrat",
      suggestedMethodScope: "EV",
      suggestedDateScope: "CUMULATIVE",
      suggestedFileFormat: "xlsx",
      suggestedRosterPartyScope: "DEM_ONLY",
    },
  ],
};

/**
 * Map a source variantKey (e.g. ev-inperson-xlsx) to the discovery profile stage id (e.g. in_person_early_voter_list).
 * @param {string} countyKey
 * @param {string} variantKey
 */
export function resolveDiscoveryStageId(countyKey, variantKey) {
  const ck = String(countyKey ?? "")
    .trim()
    .toLowerCase();
  const variant = String(variantKey ?? "").trim();
  if (!ck || !variant) return "";
  const stages = EV_ROSTER_PROFILES[ck];
  if (!stages?.length) return variant.replace(/-/g, "_");
  const byVariant = stages.find((s) => s.suggestedVariantKey === variant);
  if (byVariant) return byVariant.id;
  const underscored = variant.replace(/-/g, "_");
  if (stages.some((s) => s.id === underscored)) return underscored;
  return underscored;
}

export function countyHasEvRosterDiscoveryProfile(countyKey) {
  const k = String(countyKey ?? "")
    .trim()
    .toLowerCase();
  return !!(k && EV_ROSTER_PROFILES[k]?.length);
}

export function listEvRosterDiscoveryProfiles() {
  return Object.entries(EV_ROSTER_PROFILES).map(([countyKey, stages]) => ({
    countyKey,
    stageCount: stages.length,
    stages: stages.map((s) => ({ id: s.id, label: s.label })),
  }));
}

/**
 * @param {{ href: string, text: string }[]} links
 * @param {{ countyKey?: string, votingDate?: string }} options
 */
export function discoverEvRosterUrlsFromLinks(links, options = {}) {
  const countyKey = String(options.countyKey ?? "")
    .trim()
    .toLowerCase();
  const stages = EV_ROSTER_PROFILES[countyKey];
  if (!stages?.length) {
    return {
      matches: [],
      message: `No EV roster discovery profile for "${countyKey}".`,
    };
  }
  if (!links.length) return { matches: [], message: "No links found on the hub page." };

  const votingDate = String(options.votingDate ?? "").trim();

  /** @type {Array<{ url: string, matchedStage: string, matchedLabel: string, linkText: string, suggestedVariantKey?: string, suggestedLabel?: string, suggestedMethodScope?: string, suggestedDateScope?: string, suggestedFileFormat?: string, suggestedRosterPartyScope?: string }>} */
  const matches = [];
  const seenStage = new Set();

  for (const stage of stages) {
    if (seenStage.has(stage.id)) continue;
    for (const link of links) {
      const t = normalizeLinkText(`${link.text} ${link.href}`);
      if (!stage.test(t)) continue;
      const cumulativeDiscovery =
        String(stage.suggestedDateScope ?? "").toUpperCase() === "CUMULATIVE";
      if (votingDate && !cumulativeDiscovery && !entryMatchesVotingDate(t, votingDate)) continue;
      matches.push({
        url: link.href,
        matchedStage: stage.id,
        matchedLabel: stage.label,
        linkText: t.slice(0, 300),
        suggestedVariantKey: stage.suggestedVariantKey,
        suggestedLabel: stage.suggestedLabel,
        suggestedMethodScope: stage.suggestedMethodScope,
        suggestedDateScope: stage.suggestedDateScope,
        suggestedFileFormat: stage.suggestedFileFormat,
        suggestedRosterPartyScope: stage.suggestedRosterPartyScope,
      });
      seenStage.add(stage.id);
      break;
    }
  }

  let deduped = matches;
  if (countyKey === "harris") {
    const primary = matches.filter((m) => m.matchedStage === "bbm_roster" || m.matchedStage === "ev_roster");
    deduped = primary.length ? primary : matches.filter((m) => m.matchedStage.endsWith("_loose"));
  }

  if (!deduped.length) {
    const hint =
      countyKey === "harris"
        ? "For Harris, use the Election Rosters hub URL."
        : countyKey === "dallas"
          ? "For Dallas, use the election historical results page (e.g. …/may-26-2026-primary-runoff-election/)."
          : countyKey === "collin"
            ? "For Collin, use https://www.collincountytx.gov/Elections/rosters (four party-specific XLSX links)."
            : countyKey === "bexar"
              ? "For Bexar, use https://www.bexar.org/Archive.aspx?AMID=81 (daily party PDFs: Received Primary Runoff = BBM, Early Voting = EV)."
              : countyKey === "fort_bend"
              ? "For Fort Bend, use the early voting statistics hub (BBM PDF with VUID + return date/party)."
              : countyKey === "williamson"
                ? "For Williamson, use https://www.wilco.org/departments/elections (Daily Voting Roster XLSX)."
                : "";
    return {
      matches: [],
      message: `No roster links matched.${hint ? ` ${hint}` : ""}`,
    };
  }
  return { matches: deduped, message: `Found ${deduped.length} roster link(s).` };
}

/**
 * @param {string} hubUrl
 * @param {{ countyKey?: string, html?: string, votingDate?: string }} options
 */
export async function discoverEvRosterUrlsFromHub(hubUrl, options = {}) {
  const trimmed = String(hubUrl ?? "").trim();
  const pasted = String(options.html ?? "").trim();
  const countyKey = String(options.countyKey ?? "")
    .trim()
    .toLowerCase();
  if (!trimmed && !pasted) return { matches: [], message: "hubUrl is required." };

  let html = pasted;
  const fetchUrl = trimmed || "https://invalid.invalid/";
  if (!html) {
    validateHubUrlForDiscoveryFetch(trimmed);
    html = await fetchHubPageHtml(fetchUrl);
  }

  const links = extractAnchorsFromHtml(html, fetchUrl);
  const fromLinks = discoverEvRosterUrlsFromLinks(links, {
    countyKey,
    votingDate: options.votingDate,
  });
  if (countyKey === "harris" && !fromLinks.matches?.length) {
    const zips = await discoverHarrisReportZipUrls({
      electionDate: options.electionDate,
      reportCode: options.reportCode,
    });
    if (zips.length) {
      return {
        matches: zips,
        message: `Found ${zips.length} Harris roster ZIP(s) on appfiles (hub page has no static links).`,
      };
    }
  }
  return fromLinks;
}

/**
 * @param {string} hubUrl
 * @param {{ countyKey?: string, html?: string, stageId?: string, methodScope?: string, rosterPartyScope?: string, votingDate?: string }} options
 */
export async function discoverEvRosterUrlFromHub(hubUrl, options = {}) {
  const countyKey = String(options.countyKey ?? "")
    .trim()
    .toLowerCase();
  const stages = EV_ROSTER_PROFILES[countyKey];
  if (!stages?.length) {
    return {
      url: null,
      message: `No EV roster discovery profile for "${countyKey}".`,
    };
  }

  if (options.stageId || options.methodScope || options.rosterPartyScope) {
    const all = await discoverEvRosterUrlsFromHub(hubUrl, {
      countyKey,
      html: options.html,
      electionDate: options.electionDate,
      reportCode: options.reportCode,
      votingDate: options.votingDate,
    });
    let pick = null;
    if (options.stageId) {
      const stageId = String(options.stageId);
      pick = all.matches.find((m) => m.matchedStage === stageId) ?? null;
      if (!pick && options.variantKey) {
        const resolved = resolveDiscoveryStageId(countyKey, options.variantKey);
        if (resolved && resolved !== stageId) {
          pick = all.matches.find((m) => m.matchedStage === resolved) ?? null;
        }
      }
    }
    if (!pick) {
      const wantMethod = String(options.methodScope ?? "").toUpperCase();
      const wantParty = normalizeRosterPartyScope(options.rosterPartyScope ?? "");
      const candidates = all.matches.filter((m) => {
        const methodOk =
          !wantMethod ||
          wantMethod === "ALL" ||
          String(m.suggestedMethodScope ?? "").toUpperCase() === wantMethod;
        const partyScope = normalizeRosterPartyScope(m.suggestedRosterPartyScope ?? "");
        const partyOk =
          !wantParty || wantParty === "COMBINED" || partyScope === wantParty || partyScope === "COMBINED";
        return methodOk && partyOk;
      });
      pick = candidates[0] ?? null;
    }
    if (!pick) return { url: null, message: all.message ?? "No link matched for that method." };
    return { ...pick, url: pick.url };
  }

  return {
    url: null,
    message:
      "Specify method scope, party scope, or source variant (stage) to pick one roster link. For Collin, use the four preconfigured sources or Discover & save all.",
  };
}

export { discoverCountyFeedUrlFromLinks, extractAnchorsFromHtml };
