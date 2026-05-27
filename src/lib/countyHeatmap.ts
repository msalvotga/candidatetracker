import type { CandidateInput, CountyRowInput, RaceInput } from "../types/election";
import { normalizeCountyLookupKey } from "./sd4Historical";

export interface CandidateHeatColor {
  id: string;
  name: string;
  party: string;
  /** Base hue for legend swatches */
  base: string;
  /** Light → dark margin shades when this candidate leads the county */
  shades: [string, string, string];
}

export interface CountyHeatCell {
  countyKey: string;
  displayName: string;
  hasData: boolean;
  totalVotes: number;
  leaderId: string | null;
  runnerUpId: string | null;
  /** Share of county vote for leader minus runner-up (0–100). */
  marginPct: number;
  votesByCandidate: Record<string, number>;
}

export interface CountyHeatmapModel {
  viewBox: string;
  candidates: CandidateHeatColor[];
  /** All 254 counties — includes keys with no race data. */
  cells: CountyHeatCell[];
  byKey: Map<string, CountyHeatCell>;
}

const PALETTES: Array<{ base: string; shades: [string, string, string] }> = [
  { base: "#e8b923", shades: ["#f5e4a8", "#e8b923", "#c99a12"] },
  { base: "#e85d5d", shades: ["#f5b5b5", "#e85d5d", "#c0392b"] },
  { base: "#5b8def", shades: ["#b5cff5", "#5b8def", "#2e5fc9"] },
  { base: "#6bc97a", shades: ["#b8e8bf", "#6bc97a", "#3d9e4d"] },
  { base: "#b56be8", shades: ["#ddb8f5", "#b56be8", "#8a3dc9"] },
];

const NO_DATA_FILL = "#2e3038";

export function noDataCountyFill(): string {
  return NO_DATA_FILL;
}

export function countyFillColor(
  cell: CountyHeatCell,
  colors: CandidateHeatColor[],
): string {
  if (!cell.hasData || cell.totalVotes <= 0 || !cell.leaderId) return NO_DATA_FILL;
  const idx = colors.findIndex((c) => c.id === cell.leaderId);
  if (idx < 0) return NO_DATA_FILL;
  const tier = cell.marginPct >= 20 ? 2 : cell.marginPct >= 10 ? 1 : 0;
  return colors[idx].shades[tier];
}

function countyRowToKey(name: string): string {
  return normalizeCountyLookupKey(name);
}

function buildCandidateColors(candidates: CandidateInput[]): CandidateHeatColor[] {
  const sorted = [...candidates].sort((a, b) => b.totalVotes - a.totalVotes);
  return sorted.map((c, i) => {
    const pal = PALETTES[i % PALETTES.length];
    return {
      id: c.id,
      name: c.name,
      party: c.party,
      base: pal.base,
      shades: pal.shades,
    };
  });
}

function cellFromCountyRow(row: CountyRowInput, candidates: CandidateInput[]): CountyHeatCell {
  const countyKey = countyRowToKey(row.name);
  const votesByCandidate: Record<string, number> = {};
  let totalVotes = 0;
  for (const c of candidates) {
    const v = row.candidates[c.id]?.totalVotes ?? 0;
    votesByCandidate[c.id] = v;
    totalVotes += v;
  }

  if (totalVotes <= 0) {
    return {
      countyKey,
      displayName: row.name,
      hasData: true,
      totalVotes: 0,
      leaderId: null,
      runnerUpId: null,
      marginPct: 0,
      votesByCandidate,
    };
  }

  const ranked = candidates
    .map((c) => ({ id: c.id, votes: votesByCandidate[c.id] ?? 0 }))
    .sort((a, b) => b.votes - a.votes);
  const leaderId = ranked[0]?.id ?? null;
  const runnerUpId = ranked[1]?.id ?? null;
  const leaderVotes = leaderId ? votesByCandidate[leaderId] : 0;
  const runnerVotes = runnerUpId ? votesByCandidate[runnerUpId] : 0;
  const marginPct = totalVotes > 0 ? ((leaderVotes - runnerVotes) / totalVotes) * 100 : 0;

  return {
    countyKey,
    displayName: row.name,
    hasData: true,
    totalVotes,
    leaderId,
    runnerUpId,
    marginPct,
    votesByCandidate,
  };
}

/** Build heatmap model for a race; requires texas county keys from paths data. */
export function buildCountyHeatmapModel(
  race: RaceInput,
  allCountyKeys: string[],
  keyToLabel: Map<string, string>,
  viewBox: string,
): CountyHeatmapModel | null {
  const candidates = race.candidates ?? [];
  if (!candidates.length || !allCountyKeys.length) return null;

  const colors = buildCandidateColors(candidates);
  const rowByKey = new Map<string, CountyRowInput>();
  for (const row of race.counties ?? []) {
    if (row.isTotalRow) continue;
    rowByKey.set(countyRowToKey(row.name), row);
  }

  const cells: CountyHeatCell[] = allCountyKeys.map((countyKey) => {
    const row = rowByKey.get(countyKey);
    if (row) return cellFromCountyRow(row, candidates);
    return {
      countyKey,
      displayName: keyToLabel.get(countyKey) ?? countyKey,
      hasData: false,
      totalVotes: 0,
      leaderId: null,
      runnerUpId: null,
      marginPct: 0,
      votesByCandidate: Object.fromEntries(candidates.map((c) => [c.id, 0])),
    };
  });

  return {
    viewBox,
    candidates: colors,
    cells,
    byKey: new Map(cells.map((c) => [c.countyKey, c])),
  };
}

export function raceHasCountyHeatmap(race: RaceInput): boolean {
  const rows = (race.counties ?? []).filter((r) => !r.isTotalRow);
  return rows.length > 0 && race.candidates.length > 0;
}

export function countyVotePercent(cell: CountyHeatCell, candidateId: string): number {
  if (cell.totalVotes <= 0) return 0;
  return ((cell.votesByCandidate[candidateId] ?? 0) / cell.totalVotes) * 100;
}
