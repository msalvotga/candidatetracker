/** Voting-day alignment for 2022 vs 2026. Day number is the comparison key, not the calendar date. */

export const DAY_DEFS = [
  { id: 1, label: "Day 1", date2022: "2022-10-24", date2026: "2026-10-19" },
  { id: 2, label: "Day 2", date2022: "2022-10-25", date2026: "2026-10-20" },
  { id: 3, label: "Day 3", date2022: "2022-10-26", date2026: "2026-10-21" },
  { id: 4, label: "Day 4", date2022: "2022-10-27", date2026: "2026-10-22" },
  { id: 5, label: "Day 5", date2022: "2022-10-28", date2026: "2026-10-23" },
  { id: 6, label: "Day 6", date2022: "2022-10-29", date2026: "2026-10-24" },
  { id: 7, label: "Day 7", date2022: "2022-10-31", date2026: "2026-10-26" },
  { id: 8, label: "Day 8", date2022: "2022-11-01", date2026: "2026-10-27" },
  { id: 9, label: "Day 9", date2022: "2022-11-02", date2026: "2026-10-28" },
  { id: 10, label: "Day 10", date2022: "2022-11-03", date2026: "2026-10-29" },
  { id: 11, label: "Day 11", date2022: "2022-11-04", date2026: "2026-10-30" },
  { id: 12, label: "Election Day", date2022: "2022-11-08", date2026: "2026-11-03" },
];

const CALENDAR = {
  2022: DAY_DEFS.map((day) => [day.date2022, day.id]),
  2026: DAY_DEFS.map((day) => [day.date2026, day.id]),
};

export function parseIsoDate(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return null;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return null;
}

/**
 * Map a calendar date onto voting day 1–12.
 * Dates before day 1 fold into day 1.
 * Dates on a gap (no voting) fold into the next voting day.
 * Dates after the last early-voting day fold into Election Day.
 */
export function votingDayFromDate(isoDate, year) {
  const calendar = CALENDAR[year];
  if (!calendar || !isoDate) return null;
  if (isoDate <= calendar[0][0]) return 1;
  for (const [date, id] of calendar) {
    if (isoDate === date) return id;
    if (isoDate < date) return id;
  }
  return 12;
}

export function rosterMethod(raw) {
  const text = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ");
  if (!text || text === "OTHER") return "";
  if (text === "AB" || text === "ABB" || text === "BBM" || text === "MAIL" || text === "ABSENTEE" || text === "BALLOT BY MAIL") return "AB";
  if (text === "ED" || text === "ELECTION DAY") return "ED";
  if (text === "EV" || text === "EARLY" || text === "EARLY VOTING" || text === "IN PERSON") return "EV";
  return "";
}

/**
 * Mail and absentee ballots are one total, voting day 0.
 * Dates before in-person early voting are mail even when the file has no method.
 * In-person dates still use the voting-day calendar.
 */
export function rosterBucket(isoDate, method, year = 2026) {
  const calendar = CALENDAR[year];
  if (!calendar || !isoDate) return null;
  if (rosterMethod(method) === "AB" || isoDate < calendar[0][0]) return 0;
  return votingDayFromDate(isoDate, year);
}

export function parseVotingDayNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 12) return null;
  return n;
}
