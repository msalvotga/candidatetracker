function sheetRowsByOffice(sheetRows) {
  const map = new Map();
  for (const row of sheetRows) {
    if (!map.has(row.office_id)) map.set(row.office_id, []);
    map.get(row.office_id).push(row);
  }
  return map;
}

export async function loadOfficeSeatHolders(db, category) {
  const rows = await db
    .prepare(
      `SELECT id AS office_id, seat_holder_name, seat_holder_party, up_for_reelection
       FROM offices
       WHERE category = ?`
    )
    .all(category);

  const holders = new Map();
  const upForReelection = new Map();
  for (const row of rows) {
    upForReelection.set(row.office_id, row.up_for_reelection === 1 || row.up_for_reelection === true);
    const name = String(row.seat_holder_name ?? "").trim();
    if (!name) continue;
    holders.set(row.office_id, {
      name,
      party: row.seat_holder_party ? String(row.seat_holder_party).trim() : null,
      source: "office",
    });
  }
  return { holders, upForReelection };
}

export function computeRaceIsOpen(officeSheetRows, race) {
  if (
    officeSheetRows?.some((row) => {
      const incumbent = String(row.incumbent_name ?? "").trim();
      const running = String(row.running_for_reelection ?? "").trim().toLowerCase();
      return incumbent && running === "no";
    })
  ) {
    return true;
  }

  return !race.candidates.some((candidate) => candidate.is_incumbent);
}

export async function attachSeatHoldersToRaces(db, races, sheetRows, category) {
  const { holders: officeHolders, upForReelection } = await loadOfficeSeatHolders(db, category);
  const rowsByOffice = sheetRowsByOffice(sheetRows);

  return races.map((race) => ({
    ...race,
    seat_holder: officeHolders.get(race.office_id) ?? null,
    is_open: computeRaceIsOpen(rowsByOffice.get(race.office_id) ?? [], race),
    up_for_reelection: upForReelection.get(race.office_id) ?? false,
  }));
}
