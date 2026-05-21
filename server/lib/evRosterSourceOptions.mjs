/** How voters in this file should be tagged on export (Method column). */
export const VOTING_METHOD_SCOPES = [
  { id: "ALL", label: "All methods (use file / detect)" },
  { id: "EV", label: "Early voting in person (EV)" },
  { id: "AB", label: "Ballot by mail / absentee (AB, BBM)" },
  { id: "ED", label: "Election day (ED)" },
];

/** Whether this file is one early-voting day or cumulative across all EV days. */
export const DATE_SCOPES = [
  { id: "SINGLE_DAY", label: "Single day (matches pull date)" },
  { id: "CUMULATIVE", label: "Cumulative / all early-voting days combined" },
];

/** File type at roster_url (auto = from URL extension or Content-Type). */
export const FILE_FORMATS = [
  { id: "auto", label: "Auto-detect" },
  { id: "csv", label: "CSV" },
  { id: "txt", label: "Text / delimited" },
  { id: "zip", label: "ZIP (all daily CSV/TXT inside)" },
  { id: "xlsx", label: "Excel (.xlsx)" },
  { id: "pdf", label: "PDF (Bexar / Fort Bend roster)" },
];

/**
 * Whether the roster file lists both major parties or a single party only.
 * COMBINED: filter rows to the election party (REP/DEM) using the Party column.
 */
export const ROSTER_PARTY_SCOPES = [
  { id: "COMBINED", label: "Combined — R and D in file (filter to election party)" },
  { id: "REP_ONLY", label: "Republican only — no D rows in file" },
  { id: "DEM_ONLY", label: "Democrat only — no R rows in file" },
];

export function getSourceOptionsPayload() {
  return {
    votingMethodScopes: VOTING_METHOD_SCOPES,
    dateScopes: DATE_SCOPES,
    fileFormats: FILE_FORMATS,
    rosterPartyScopes: ROSTER_PARTY_SCOPES,
  };
}
