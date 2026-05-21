import { fetchCivicplusCumulativePdfAllContests } from "./civicplusCumulativeReport.mjs";

const HAYS_SAMPLE_PDF_URL =
  "https://www.egovlink.com/public_documents300/hayscounty/published_documents/departments/elections/results/2026/0303%20Primaries/Cumulative%20Results%20-%20Democratic%20Party%20-%20official.pdf";

/**
 * Hays County eGovlink cumulative PDF.
 * @param {string} [pdfUrl]
 */
export async function fetchHaysEgovlinkCumulativePdfAllContests(pdfUrl = HAYS_SAMPLE_PDF_URL) {
  return fetchCivicplusCumulativePdfAllContests(pdfUrl, {
    countyLabel: "Hays",
    countyId: "hays",
    countyNamePattern: /Hays County|Cumulative Results/i,
  });
}
