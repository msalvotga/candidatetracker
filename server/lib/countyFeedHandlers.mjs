import { fetchClarityEnrSummaryZipAllContests } from "./clarityEnrSummaryZip.mjs";
import { fetchHarrisCumulativePdfAllContests } from "./harrisVotes.mjs";
import { fetchMontgomeryEresultsAllContests } from "./montgomeryEresults.mjs";
import { fetchChambersSd4Summary } from "./chambersReport.mjs";
import { fetchDallasElectionwarePdfAllContests } from "./dallasReport.mjs";
import { fetchCollinElectionwarePdfAllContests } from "./collinReport.mjs";
import { fetchCameronCountyResultsPdf } from "./cameronReport.mjs";
import { fetchHaysEgovlinkCumulativePdfAllContests } from "./haysReport.mjs";
import { fetchMcLennanCivicplusCumulativePdfAllContests } from "./mclennanReport.mjs";
import { fetchEllisLiveVoterTurnoutAllContests } from "./ellisLiveVoterTurnout.mjs";
import { fetchCivixDetailXlsxAllContests } from "./civixDetailXlsx.mjs";

/** When a feed row was saved as "Other / custom", infer handler from county_key. */
const COUNTY_FALLBACK_HANDLER_KEY = {
  harris: "harris_pdf",
  chambers: "chambers_pdf",
  collin: "collin_electionware_pdf",
  cameron: "cameron_pdf",
  hays: "hays_egovlink_cumulative_pdf",
  mclennan: "mclennan_civicplus_cumulative_pdf",
  ellis: "ellis_livevoterturnout_html",
  hidalgo: "civix_detail_xlsx",
};

/**
 * @param {{ id?: string, handlerKey?: string, handler_key?: string }} vendor
 * @param {string} countyId normalized lowercase county_key
 */
function resolveCountyHandlerKey(vendor, countyId) {
  let hk = String(vendor.handlerKey ?? vendor.handler_key ?? "").trim();
  const vid = String(vendor?.id ?? "").trim();

  if (!hk || hk === "unimplemented") {
    hk = COUNTY_FALLBACK_HANDLER_KEY[countyId] ?? hk;
    if (countyId === "montgomery") hk = "montgomery_eresults_html";
  }

  /** Legacy rows used montgomery-pdf; Montgomery ingest is live eResults HTML only. */
  if (countyId === "montgomery" && (hk === "montgomery_pdf" || vid === "montgomery-pdf")) {
    hk = "montgomery_eresults_html";
  }

  return hk;
}

/**
 * Ingest "process" (stored as ingest_vendors.id): one pipeline can serve every county whose URL matches that format.
 * Clarity ENR summary.zip and Dallas Electionware summary PDF → import **all** contests; combine comparable races later when merging totals.
 *
 * @param {{ countyKey: string, sourceUrl: string, civixCountyName?: string }} feed
 * @param {{ id: string, handlerKey: string, displayName: string }} vendor
 * @returns {Promise<{ countyId: string, sourceUrl: string | null, rows: unknown[] }>}
 */
export async function runCountyFeedFetch(feed, vendor) {
  const url = String(feed.sourceUrl ?? "").trim();
  const countyId = String(feed.countyKey ?? "").trim().toLowerCase();
  if (!countyId) throw new Error("county_key is required for county feeds");
  if (!url) throw new Error("source URL is required");

  const hk = resolveCountyHandlerKey(vendor, countyId);

  switch (hk) {
    case "harris_pdf": {
      const summary = await fetchHarrisCumulativePdfAllContests(url);
      return { countyId, sourceUrl: summary.source.pdfUrl, rows: summary.rows };
    }
    case "clarity_enr_summary_zip":
    /** @deprecated Legacy ids — migrated to clarity-enr-summary-zip; handler kept until rows are re-saved */
    case "clarity_galveston_sd4":
    case "clarity_jefferson_sd4": {
      const summary = await fetchClarityEnrSummaryZipAllContests(url);
      return { countyId, sourceUrl: summary.source.zipUrl, rows: summary.rows };
    }
    case "civix_detail_xlsx": {
      const summary = await fetchCivixDetailXlsxAllContests(url);
      return { countyId, sourceUrl: summary.source.zipUrl, rows: summary.rows };
    }
    case "montgomery_eresults_html": {
      const summary = await fetchMontgomeryEresultsAllContests(url);
      return { countyId, sourceUrl: summary.source.pageUrl, rows: summary.rows };
    }
    case "chambers_pdf": {
      const summary = await fetchChambersSd4Summary(url);
      return { countyId, sourceUrl: summary.source.pdfUrl, rows: summary.rows };
    }
    case "dallas_pdf": {
      const summary = await fetchDallasElectionwarePdfAllContests(url);
      return { countyId, sourceUrl: summary.source.pdfUrl, rows: summary.rows };
    }
    case "collin_electionware_pdf": {
      const summary = await fetchCollinElectionwarePdfAllContests(url);
      return { countyId, sourceUrl: summary.source.pdfUrl, rows: summary.rows };
    }
    case "cameron_pdf": {
      const summary = await fetchCameronCountyResultsPdf(url);
      return {
        countyId,
        sourceUrl: summary.source.pdfUrl,
        rows: summary.rows,
        reconciliationOnly: Boolean(summary.reconciliationOnly),
      };
    }
    case "hays_egovlink_cumulative_pdf": {
      const summary = await fetchHaysEgovlinkCumulativePdfAllContests(url);
      return { countyId, sourceUrl: summary.source.pdfUrl, rows: summary.rows };
    }
    case "mclennan_civicplus_cumulative_pdf": {
      const summary = await fetchMcLennanCivicplusCumulativePdfAllContests(url);
      return { countyId, sourceUrl: summary.source.pdfUrl, rows: summary.rows };
    }
    case "ellis_livevoterturnout_html": {
      const summary = await fetchEllisLiveVoterTurnoutAllContests(url);
      return { countyId, sourceUrl: summary.source.pageUrl, rows: summary.rows };
    }
    case "civix_sos":
      throw new Error("SOS / Civix is fetched separately; pick a county ingest process for county feeds.");
    case "unimplemented":
      throw new Error(
        `No automated ingest for "${vendor.displayName ?? vendor.display_name}". Choose a supported process or add a handler.`,
      );
    default:
      throw new Error(`Unknown ingest handler: ${hk}`);
  }
}
