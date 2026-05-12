import { fetchClarityEnrSummaryZipAllContests } from "./clarityEnrSummaryZip.mjs";
import { fetchHarrisSd4Summary } from "./harrisVotes.mjs";
import { fetchMontgomeryEresultsSd4Summary } from "./montgomeryEresults.mjs";
import { fetchChambersSd4Summary } from "./chambersReport.mjs";
import { fetchDallasElectionwarePdfAllContests } from "./dallasReport.mjs";

/** When a feed row was saved as "Other / custom", infer handler from county_key. */
const COUNTY_FALLBACK_HANDLER_KEY = {
  harris: "harris_pdf",
  chambers: "chambers_pdf",
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
      const summary = await fetchHarrisSd4Summary(url);
      return { countyId, sourceUrl: summary.source.pdfUrl, rows: summary.rows };
    }
    case "clarity_enr_summary_zip":
    /** @deprecated Legacy ids — migrated to clarity-enr-summary-zip; handler kept until rows are re-saved */
    case "clarity_galveston_sd4":
    case "clarity_jefferson_sd4": {
      const summary = await fetchClarityEnrSummaryZipAllContests(url);
      return { countyId, sourceUrl: summary.source.zipUrl, rows: summary.rows };
    }
    case "montgomery_eresults_html": {
      const summary = await fetchMontgomeryEresultsSd4Summary(url);
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
