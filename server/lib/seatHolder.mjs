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
      `SELECT id AS office_id, seat_holder_name, seat_holder_party
       FROM offices
       WHERE category = ?`
    )
    .all(category);

  const map = new Map();
  for (const row of rows) {
    const name = String(row.seat_holder_name ?? "").trim();
    if (!name) continue;
    map.set(row.office_id, {
      name,
      party: row.seat_holder_party ? String(row.seat_holder_party).trim() : null,
      source: "office",
    });
  }
  return map;
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
  const officeHolders = await loadOfficeSeatHolders(db, category);
  const rowsByOffice = sheetRowsByOffice(sheetRows);

  return races.map((race) => ({
    ...race,
    seat_holder: officeHolders.get(race.office_id) ?? null,
    is_open: computeRaceIsOpen(rowsByOffice.get(race.office_id) ?? [], race),
  }));
}
