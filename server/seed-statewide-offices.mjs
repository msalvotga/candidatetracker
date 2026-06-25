import { closeDb, getDb, initDb } from "./db.mjs";
import { STATEWIDE_OFFICES } from "./data/statewide-offices.mjs";

/** Legacy CCA-PL3 row stored the presiding judge before CCA-PRES existed. */
const LEGACY_OFFICE_MIGRATIONS = [
  {
    from_code: "CCA-PL3",
    to_code: "CCA-PRES",
    when_holder: "David J. Schenck",
  },
];

export async function syncStatewideOffices(database) {
  let inserted = 0;
  let updated = 0;

  for (const migration of LEGACY_OFFICE_MIGRATIONS) {
    const legacy = await database
      .prepare(`SELECT id, seat_holder_name FROM offices WHERE office_code = ? AND category = 'statewide'`)
      .get(migration.from_code);
    if (!legacy) continue;
    if (String(legacy.seat_holder_name ?? "").trim() !== migration.when_holder) continue;

    const target = await database
      .prepare(`SELECT id FROM offices WHERE office_code = ? AND category = 'statewide'`)
      .get(migration.to_code);
    if (!target) {
      await database
        .prepare(
          `UPDATE offices
           SET office_code = @to_code,
               office_name = @office_name,
               seat_holder_name = @holder,
               seat_holder_party = @party,
               up_for_reelection = @up_for_reelection,
               sort_order = @sort_order
           WHERE id = @id`
        )
        .run({
          id: legacy.id,
          to_code: migration.to_code,
          office_name: STATEWIDE_OFFICES.find((office) => office.code === migration.to_code)?.name ?? migration.to_code,
          holder: migration.when_holder,
          party: "R",
          up_for_reelection: 0,
          sort_order: 200,
        });
    } else {
      await database.prepare(`DELETE FROM offices WHERE id = ?`).run(legacy.id);
    }
  }

  const upsert = database.prepare(
    `INSERT INTO offices (category, district, office_code, office_name, sort_order, seat_holder_name, seat_holder_party, up_for_reelection)
     VALUES ('statewide', NULL, @code, @name, @sort_order, @holder, @party, @up_for_reelection)
     ON CONFLICT (office_code) DO UPDATE SET
       office_name = EXCLUDED.office_name,
       sort_order = EXCLUDED.sort_order,
       seat_holder_name = EXCLUDED.seat_holder_name,
       seat_holder_party = EXCLUDED.seat_holder_party,
       up_for_reelection = EXCLUDED.up_for_reelection`
  );

  for (const office of STATEWIDE_OFFICES) {
    const before = await database.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(office.code);
    await upsert.run({
      code: office.code,
      name: office.name,
      sort_order: office.sort_order,
      holder: office.holder,
      party: office.party,
      up_for_reelection: office.up_for_reelection,
    });
    if (before) updated += 1;
    else inserted += 1;
  }

  await database
    .prepare(`DELETE FROM offices WHERE category = 'statewide' AND office_code IN ('RRC', 'RRC-1', 'RRC-2', 'RRC-3')`)
    .run();

  return { inserted, updated, total: STATEWIDE_OFFICES.length };
}

const isMain = process.argv[1]?.endsWith("seed-statewide-offices.mjs");
if (isMain) {
  await initDb();
  const database = getDb();
  const result = await syncStatewideOffices(database);
  const rows = await database
    .prepare(
      `SELECT office_code, seat_holder_name, seat_holder_party, up_for_reelection
       FROM offices WHERE category = 'statewide'
       ORDER BY sort_order, office_code`
    )
    .all();
  console.log(`Synced ${result.total} statewide offices (${result.inserted} new, ${result.updated} updated).`);
  console.table(rows);
  await closeDb();
}
