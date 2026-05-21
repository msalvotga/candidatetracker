import { toIsoDateKey } from "./evRosterDateMatch.mjs";

/**
 * Activity / vote date stored on the voter row (from file ActivityDate, etc.).
 * @param {Record<string, unknown>} record
 * @param {string} reportingDate Civix pull / reporting date (YYYY-MM-DD)
 */
export function resolveVoterActivityDate(record, reportingDate) {
  const reporting = toIsoDateKey(reportingDate);
  const fromRow = toIsoDateKey(
    record?.votingDate ??
      record?.activityDate ??
      record?.activity_date ??
      record?.ActivityDate ??
      record?.["Activity Date"] ??
      record?.["Return Date"] ??
      record?.returnDate,
  );
  return fromRow || reporting || "";
}

/**
 * @param {Array<Record<string, unknown>>} voters
 * @param {string} reportingDate
 */
export function tagVotersForStorage(voters, reportingDate) {
  const reporting = toIsoDateKey(reportingDate);
  return (voters ?? []).map((v) => {
    const votingDate = resolveVoterActivityDate(v, reporting);
    return { ...v, votingDate, reportingDate: reporting };
  });
}
