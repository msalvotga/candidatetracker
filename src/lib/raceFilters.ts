import type { OfficeCategory, Race, SeatHolder } from "../types";

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

/** Named GOP candidate on the ballot for this race, if any. */
export function raceGopCandidate(race: Race) {
  return (
    race.candidates.find((candidate) => candidate.party === "R" && String(candidate.name ?? "").trim()) ??
    null
  );
}

export function raceGopCandidateName(race: Race) {
  return raceGopCandidate(race)?.name?.trim() || null;
}

export function raceCurrentHolderLabel(race: Race) {
  const holder = raceSeatHolder(race);
  return holder?.name?.trim() || "Vacant";
}

export function raceGopCandidateLabel(race: Race) {
  return raceGopCandidateName(race) || "none";
}

export function raceRunningForReelectionLabel(race: Race) {
  return race.is_open ? "No" : "Yes";
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

const REELECTION_RELEVANT_CATEGORIES = new Set<OfficeCategory>(["senate", "sboe", "statewide"]);

export function isOfficeFlagTrue(value: unknown) {
  return value === true || value === 1 || value === "1";
}

export function isUpForReelectionRelevant(category: OfficeCategory) {
  return REELECTION_RELEVANT_CATEGORIES.has(category);
}

export function matchesUpForReelectionFilter(race: Race, category: OfficeCategory, upOnly: boolean) {
  if (!upOnly) return true;
  if (!isUpForReelectionRelevant(category)) return true;
  return isOfficeFlagTrue(race.up_for_reelection);
}

export function matchesOrganizationFilter(race: Race, selectedOrgKeys: string[]) {
  if (selectedOrgKeys.length === 0) return true;

  const raceKeys =
    race.targeting_organization_keys ??
    (race.targeting_organizations ?? []).map((target) => target.org_key);

  return selectedOrgKeys.some((selectedKey) =>
    raceKeys.some(
      (raceKey) =>
        raceKey === selectedKey ||
        raceKey.toUpperCase() === selectedKey.toUpperCase()
    )
  );
}

export function matchesConsultantFilter(race: Race, selectedConsultantKeys: string[]) {
  if (selectedConsultantKeys.length === 0) return true;
  return race.candidates.some((candidate) =>
    (candidate.consultant_keys ?? []).some((key) => selectedConsultantKeys.includes(key))
  );
}

export function normalizeConsultantFilterMode(
  mode: "all" | "select",
  selectedConsultantKeys: string[]
): "all" | "select" {
  if (mode === "select" && selectedConsultantKeys.length === 0) return "all";
  return mode;
}

const RACE_CATEGORY_SORT_ORDER: Record<OfficeCategory, number> = {
  house: 0,
  senate: 1,
  sboe: 2,
  statewide: 3,
  congressional: 4,
};

function raceCategoryForSort(race: Race): OfficeCategory {
  return race.category ?? "house";
}

/** Sort races by category, then district number, then ballot order (statewide), then office name. */
export function compareRaces(a: Race, b: Race) {
  const categoryA = raceCategoryForSort(a);
  const categoryB = raceCategoryForSort(b);
  const categoryOrder = RACE_CATEGORY_SORT_ORDER[categoryA] - RACE_CATEGORY_SORT_ORDER[categoryB];
  if (categoryOrder !== 0) return categoryOrder;

  const districtA = a.district;
  const districtB = b.district;
  if (districtA != null && districtB != null && districtA !== districtB) {
    return districtA - districtB;
  }
  if (districtA != null && districtB == null) return -1;
  if (districtA == null && districtB != null) return 1;

  if (categoryA === "statewide") {
    const sortA = a.sort_order ?? Number.MAX_SAFE_INTEGER;
    const sortB = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    if (sortA !== sortB) return sortA - sortB;
  }

  const labelA = a.office_name?.trim() || a.office_code;
  const labelB = b.office_name?.trim() || b.office_code;
  const nameOrder = labelA.localeCompare(labelB, undefined, { sensitivity: "base" });
  if (nameOrder !== 0) return nameOrder;

  return a.office_code.localeCompare(b.office_code, undefined, { sensitivity: "base" });
}
