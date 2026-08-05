import type { StafferDistrictEntry } from "../types";

/** Harris County Texas House districts (PLANH2316). HD-136 is Travis/Williamson, not Harris. */
export const HARRIS_HOUSE_DISTRICTS = [
  126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149,
  150,
] as const;

const HARRIS_HOUSE_DISTRICT_SET = new Set<number>(HARRIS_HOUSE_DISTRICTS);

export function isHarrisHouseDistrict(district: number) {
  return HARRIS_HOUSE_DISTRICT_SET.has(district);
}

/** Harris County HD staffers from tga-staffers seed (used when API district data is unavailable). */
export const HARRIS_DISTRICT_STAFFER_FALLBACK: StafferDistrictEntry[] = [
  { id: -1, name: "Howard Barker", districts: [126] },
  { id: -2, name: "Rodney Sims", districts: [127] },
  { id: -3, name: "Marga Matthews", districts: [128] },
  { id: -4, name: "Sara Tracey", districts: [130] },
  { id: -5, name: "Lee Vigil", districts: [132] },
  { id: -6, name: "James Clayton", districts: [133] },
  { id: -7, name: "Harrison Hink", districts: [134] },
  { id: -8, name: "Kayla Hensley", districts: [135] },
  { id: -9, name: "Helen Zhou", districts: [137] },
  { id: -10, name: "Dwayne Bohac", districts: [138] },
  { id: -11, name: "Julie Hunt", districts: [139, 140, 141] },
  { id: -12, name: "Paola Velasco", districts: [144] },
  { id: -13, name: "Jeff MacGeorge", districts: [148] },
  { id: -14, name: "Karen Ben-Moyal", districts: [149] },
  { id: -15, name: "Coleton Emr", districts: [150] },
];

export function harrisDistrictStaffersForMap(districtStaffers: StafferDistrictEntry[]) {
  const hasHarrisAssignments = districtStaffers.some((staffer) =>
    staffer.districts.some((district) => isHarrisHouseDistrict(district))
  );
  return hasHarrisAssignments ? districtStaffers : HARRIS_DISTRICT_STAFFER_FALLBACK;
}

export function staffersByHouseDistrict(districtStaffers: StafferDistrictEntry[]) {
  const map = new Map<number, string[]>();
  for (const staffer of districtStaffers) {
    for (const district of staffer.districts) {
      if (!map.has(district)) map.set(district, []);
      map.get(district)!.push(staffer.name);
    }
  }
  for (const names of map.values()) {
    names.sort((a, b) => a.localeCompare(b));
  }
  return map;
}
