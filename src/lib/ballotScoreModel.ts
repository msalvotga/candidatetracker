export type ScoreStat = { n: number; avg: number | null };

export type EvScore = { n: number; sum: number; avg: number | null };

export type EvBucket = {
  voters: number;
  score2022: EvScore;
  score2026: EvScore;
};

export type EvDayRecord = {
  y2022: { daily: EvBucket; cumulative: EvBucket };
  y2026: { daily: EvBucket; cumulative: EvBucket };
};

export type EvGeo = {
  key: string;
  label: string;
  allCurrent: EvBucket;
  byDay: Record<string, EvDayRecord>;
};

export type VotingDayDef = {
  id: number;
  label: string;
  date2022: string;
  date2026: string;
};

export type EvModel = {
  generatedAt: string;
  rosterMode: "replace" | string;
  days: VotingDayDef[];
  rosterJoin: { uniqueVuids: number; matched: number; unmatched: number };
  statewide: EvGeo;
  groups: {
    county: EvGeo[];
    house: EvGeo[];
    senate: EvGeo[];
    congress: EvGeo[];
  };
};

export const FALLBACK_DAYS: VotingDayDef[] = [
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

export function emptyStat(): ScoreStat {
  return { n: 0, avg: null };
}

export function statFromScore(score: EvScore | undefined): ScoreStat {
  if (!score || score.avg == null || score.n <= 0) return emptyStat();
  return { n: score.n, avg: score.avg };
}

export function cumulativeBucket(geo: EvGeo | undefined, dayId: string, year: "y2022" | "y2026"): EvBucket | null {
  return geo?.byDay?.[dayId]?.[year]?.cumulative ?? null;
}

export function dailyBucket(geo: EvGeo | undefined, dayId: string, year: "y2022" | "y2026"): EvBucket | null {
  return geo?.byDay?.[dayId]?.[year]?.daily ?? null;
}

export function formatDayDate(iso: string, month: "short" | "long" = "short") {
  const [year, monthNum, day] = iso.split("-").map(Number);
  if (!year || !monthNum || !day) return iso;
  return new Date(Date.UTC(year, monthNum - 1, day)).toLocaleDateString("en-US", {
    month,
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function votingDayTitle(day: { label: string; date2026: string }) {
  return `${day.label}, ${formatDayDate(day.date2026, "long")}`;
}

export function formatDelta(value: number | null) {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}`;
}

export function modelDelta(left: ScoreStat, right: ScoreStat) {
  if (left.avg == null || right.avg == null) return null;
  return left.avg - right.avg;
}
