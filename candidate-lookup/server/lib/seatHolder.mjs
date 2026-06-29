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

export function computeRaceIsOpen(race) {
  const incumbent = race.candidates.find((candidate) => candidate.is_incumbent);
  if (incumbent) {
    const running = String(incumbent.running_for_reelection ?? "").trim().toLowerCase();
    if (running === "no") return true;
    if (running === "yes") return false;
  }

  return !race.candidates.some((candidate) => candidate.is_incumbent);
}

export async function attachSeatHoldersToRaces(db, races, category) {
  const { holders: officeHolders, upForReelection } = await loadOfficeSeatHolders(db, category);

  return races.map((race) => ({
    ...race,
    seat_holder: officeHolders.get(race.office_id) ?? null,
    is_open: computeRaceIsOpen(race),
    up_for_reelection: upForReelection.get(race.office_id) ?? false,
  }));
}
