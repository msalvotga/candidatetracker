import type { StafferDistrictEntry } from "../types";

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
    staffer.districts.some((district) => district >= 126 && district <= 150)
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
