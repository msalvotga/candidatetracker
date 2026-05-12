import { fetchClarityEnrSd4SummaryFromZip } from "./clarityEnrSummaryZip.mjs";

const GALVESTON_SUMMARY_ZIP_URL =
  "https://results.enr.clarityelections.com//TX/Galveston/126195/369887/reports/summary.zip";
/** Exact string in summary.csv `contest name` column for Galveston SD4 on ENR. */
export const GALVESTON_SD4_CONTEST_NAME = "State Senate District #4 Unexpired Term (Vote For 1)";

const JEFFERSON_SUMMARY_ZIP_URL =
  "https://results.enr.clarityelections.com//TX/Jefferson/126275/369848/reports/summary.zip";
/** Exact string in summary.csv `contest name` column for Jefferson SD4 on ENR. */
export const JEFFERSON_SD4_CONTEST_NAME = "State Senator, District 4 (Vote For 1)";

/**
 * @deprecated Use fetchClarityEnrSd4SummaryFromZip with GALVESTON_SD4_CONTEST_NAME — kept for callers.
 */
export async function fetchGalvestonSd4Summary(zipUrl = GALVESTON_SUMMARY_ZIP_URL) {
  return fetchClarityEnrSd4SummaryFromZip(zipUrl, GALVESTON_SD4_CONTEST_NAME, {
    id: "county-galveston-clarity",
    county: "Galveston",
  });
}

/**
 * @deprecated Use fetchClarityEnrSd4SummaryFromZip with JEFFERSON_SD4_CONTEST_NAME — kept for callers.
 */
export async function fetchJeffersonSd4Summary(zipUrl = JEFFERSON_SUMMARY_ZIP_URL) {
  return fetchClarityEnrSd4SummaryFromZip(zipUrl, JEFFERSON_SD4_CONTEST_NAME, {
    id: "county-jefferson-clarity",
    county: "Jefferson",
  });
}
