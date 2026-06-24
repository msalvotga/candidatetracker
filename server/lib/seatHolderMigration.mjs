/** Add seat_holder_name / seat_holder_party to offices and backfill from sheet, candidates, or leg results. */

import {
  lastNameMatchesSeatHolder,
  texasHouseSeatHolderByDistrict,
} from "../data/texas-house-seat-holders.mjs";

function columnExists(database, table, column) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => col.name === column);
}

function bestSeatHolderForOffice(database, officeId) {
  const fromSheet = database
    .prepare(
      `SELECT incumbent_name, incumbent_party
       FROM race_sheet_rows
       WHERE office_id = ? AND TRIM(incumbent_name) != ''
       ORDER BY cycle_year DESC, row_order
       LIMIT 1`
    )
    .get(officeId);

  if (fromSheet?.incumbent_name?.trim()) {
    return {
      name: fromSheet.incumbent_name.trim(),
      party: fromSheet.incumbent_party ? String(fromSheet.incumbent_party).trim() : null,
    };
  }

  const fromCandidate = database
    .prepare(
      `SELECT name, party FROM candidates
       WHERE office_id = ? AND is_incumbent = 1
       ORDER BY cycle_year DESC
       LIMIT 1`
    )
    .get(officeId);

  if (fromCandidate?.name?.trim()) {
    return {
      name: fromCandidate.name.trim(),
      party: fromCandidate.party ? String(fromCandidate.party).trim() : null,
    };
  }

  const leg = database
    .prepare(
      `SELECT candidate_name, party FROM metric_contest_candidates
       WHERE office_id = ? AND metric_key = 'leg_2024'
       ORDER BY votes DESC, vote_pct DESC
       LIMIT 1`
    )
    .get(officeId);

  if (leg?.candidate_name?.trim()) {
    return {
      name: leg.candidate_name.trim(),
      party: leg.party ? String(leg.party).trim() : null,
    };
  }

  return null;
}

function isLastNameOnly(name) {
  const trimmed = String(name ?? "").trim();
  return trimmed.length > 0 && !trimmed.includes(" ");
}

function repairLastNameOnlySeatHolders(database) {
  const update = database.prepare(
    `UPDATE offices SET seat_holder_name = @name, seat_holder_party = @party WHERE id = @id`
  );

  const offices = database
    .prepare(
      `SELECT id, district, seat_holder_name, seat_holder_party
       FROM offices
       WHERE category = 'house'`
    )
    .all();

  for (const office of offices) {
    const currentName = String(office.seat_holder_name ?? "").trim();
    if (!isLastNameOnly(currentName)) continue;

    const roster = texasHouseSeatHolderByDistrict(office.district);
    if (!roster) continue;
    if (!lastNameMatchesSeatHolder(currentName, roster.name)) continue;

    update.run({
      id: office.id,
      name: roster.name,
      party: roster.party,
    });
  }
}

export function migrateOfficeSeatHolders(database) {
  if (!columnExists(database, "offices", "seat_holder_name")) {
    database.exec(`ALTER TABLE offices ADD COLUMN seat_holder_name TEXT`);
  }
  if (!columnExists(database, "offices", "seat_holder_party")) {
    database.exec(`ALTER TABLE offices ADD COLUMN seat_holder_party TEXT`);
  }

  const update = database.prepare(
    `UPDATE offices SET seat_holder_name = @name, seat_holder_party = @party
     WHERE id = @id AND (seat_holder_name IS NULL OR TRIM(seat_holder_name) = '')`
  );

  const offices = database.prepare(`SELECT id FROM offices`).all();
  for (const office of offices) {
    const current = database
      .prepare(`SELECT seat_holder_name FROM offices WHERE id = ?`)
      .get(office.id);
    if (String(current?.seat_holder_name ?? "").trim()) continue;

    const holder = bestSeatHolderForOffice(database, office.id);
    if (!holder) continue;

    update.run({ id: office.id, name: holder.name, party: holder.party });
  }

  repairLastNameOnlySeatHolders(database);
}
