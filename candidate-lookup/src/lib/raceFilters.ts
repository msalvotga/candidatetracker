import type { Race, SeatHolder } from "../types";

export function raceSeatHolder(race: Race): SeatHolder | null {
  if (race.seat_holder?.name) return race.seat_holder;

  const flagged = race.candidates.find((candidate) => candidate.is_incumbent);
  if (flagged) {
    return { name: flagged.name, party: flagged.party, source: "incumbent" };
  }

  return null;
}

/** @deprecated use raceSeatHolder */
export function raceIncumbent(race: Race) {
  const holder = raceSeatHolder(race);
  if (!holder?.party) return null;
  return { name: holder.name, party: holder.party, is_incumbent: true };
}

export function raceHasSeatHolder(race: Race) {
  return raceSeatHolder(race) != null;
}

export function raceMetricValue(race: Race, key: string) {
  return race.metrics?.find((metric) => metric.key === key)?.value ?? null;
}

export type SeatHolderFilter = "all" | "gop" | "dem";

export function matchesSeatHolderFilter(race: Race, filter: SeatHolderFilter) {
  if (filter === "all") return true;
  const holder = raceSeatHolder(race);
  if (!holder?.party) return false;
  if (filter === "gop") return holder.party === "R";
  if (filter === "dem") return holder.party === "D";
  return true;
}

/** Trump 2024 margin within ±10 points (stored as R−D decimal). */
export function matchesTrumpSwingFilter(race: Race, enabled: boolean) {
  if (!enabled) return true;
  const trump = raceMetricValue(race, "trump_2024");
  if (trump == null || Number.isNaN(trump)) return false;
  return trump >= -0.1 && trump <= 0.1;
}

export function matchesOpenSeatFilter(race: Race, openOnly: boolean) {
  if (!openOnly) return true;
  return Boolean(race.is_open);
}

export function matchesOrganizationFilter(race: Race, selectedOrgKeys: string[]) {
  if (selectedOrgKeys.length === 0) return true;
  const raceKeys = race.targeting_organization_keys ?? [];
  return selectedOrgKeys.some((key) => raceKeys.includes(key));
}

export function matchesConsultantFilter(race: Race, selectedConsultantKeys: string[]) {
  if (selectedConsultantKeys.length === 0) return true;
  return race.candidates.some((candidate) =>
    (candidate.consultant_keys ?? []).some((key) => selectedConsultantKeys.includes(key))
  );
}
