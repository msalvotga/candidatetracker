import { fetchCivicplusCumulativePdfAllContests } from "./civicplusCumulativeReport.mjs";

const MCLENNAN_SAMPLE_PDF_URL =
  "https://tx-mclennancounty.civicplus.com/DocumentCenter/View/18206/Republican-Party---Cumulative-Results-3-10-2026-01-29-07-PM";

/**
 * McLennan County CivicPlus cumulative results PDF.
 * @param {string} [pdfUrl]
 */
export async function fetchMcLennanCivicplusCumulativePdfAllContests(pdfUrl = MCLENNAN_SAMPLE_PDF_URL) {
  return fetchCivicplusCumulativePdfAllContests(pdfUrl, {
    countyLabel: "McLennan",
    countyId: "mclennan",
    countyNamePattern: /McLennan County|Cumulative Results/i,
  });
}
