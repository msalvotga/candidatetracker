import type { CandidateInput, CandidateRowView } from "../types/election";

export function electionDayVotes(totalVotes: number, earlyVotes: number): number {
  return Math.max(0, totalVotes - earlyVotes);
}

export function raceTotalVotes(candidates: CandidateInput[]): number {
  return candidates.reduce((sum, c) => sum + c.totalVotes, 0);
}

export function toCandidateRows(candidates: CandidateInput[]): CandidateRowView[] {
  const total = raceTotalVotes(candidates);
  return candidates.map((c) => {
    const ed = electionDayVotes(c.totalVotes, c.earlyVotes);
    const percent = total > 0 ? (c.totalVotes / total) * 100 : 0;
    return {
      id: c.id,
      name: c.name,
      party: c.party,
      incumbent: c.incumbent,
      earlyVotes: c.earlyVotes,
      electionDayVotes: ed,
      totalVotes: c.totalVotes,
      percent,
    };
  });
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatPercent(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export function formatDateTime(iso: string, timeZone = "America/Chicago"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      timeZone,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      timeZone: "America/Chicago",
    }).format(d);
  }
}
