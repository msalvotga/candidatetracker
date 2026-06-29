import { getDb, closeDb, initDb } from "./db.mjs";
import { ensureCandidate } from "./lib/candidates.mjs";
import {
  SKIPPED_THIRD_PARTY_CANDIDATES,
  THIRD_PARTY_CANDIDATES_2026,
} from "./data/third-party-candidates-2026.mjs";

const CYCLE_YEAR = 2026;

function normalizeName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

export async function seedThirdPartyCandidates(db, { cycleYear = CYCLE_YEAR } = {}) {
  const offices = await db
    .prepare(`SELECT id, category, office_code, office_name FROM offices`)
    .all();
  const officeByCode = new Map(offices.map((office) => [office.office_code, office]));

  const added = [];
  const skipped = [];
  const missingOffices = [];

  for (const entry of THIRD_PARTY_CANDIDATES_2026) {
    const name = normalizeName(entry.name);
    const office = officeByCode.get(entry.officeCode);
    if (!office) {
      missingOffices.push({ ...entry, name });
      continue;
    }

    const existing = await db
      .prepare(
        `SELECT id FROM candidates
         WHERE office_id = ? AND cycle_year = ? AND name = ? AND party = ? AND is_incumbent = 0`
      )
      .get(office.id, cycleYear, name, entry.party);

    if (existing) {
      skipped.push({ name, party: entry.party, officeCode: entry.officeCode, reason: "already present" });
      continue;
    }

    await ensureCandidate(db, {
      officeId: office.id,
      cycleYear,
      name,
      party: entry.party,
      isIncumbent: false,
    });

    if (entry.website) {
      await db
        .prepare(
          `UPDATE candidates SET website = ?
           WHERE office_id = ? AND cycle_year = ? AND party = ? AND name = ? AND is_incumbent = 0`
        )
        .run(entry.website, office.id, cycleYear, entry.party, name);
    }

    added.push({
      name,
      party: entry.party,
      officeCode: entry.officeCode,
      officeName: office.office_name,
      category: office.category,
    });
  }

  return { added, skipped, missingOffices };
}

const isMain = process.argv[1]?.endsWith("seed-third-party-candidates.mjs");
if (isMain) {
  await initDb();
  const db = getDb();
  const result = await seedThirdPartyCandidates(db);
  console.log(`Added ${result.added.length} third-party candidates for ${CYCLE_YEAR}.`);
  for (const row of result.added) {
    const partyLabel = row.party === "G" ? "Green" : "Libertarian";
    console.log(`  + ${partyLabel}: ${row.name} — ${row.officeCode} (${row.officeName})`);
  }
  if (result.skipped.length) {
    console.log(`Skipped ${result.skipped.length} (already present).`);
  }
  if (result.missingOffices.length) {
    console.log("Missing offices:");
    for (const row of result.missingOffices) {
      console.log(`  ! ${row.name} (${row.party}) — ${row.officeCode}`);
    }
  }
  if (SKIPPED_THIRD_PARTY_CANDIDATES.length) {
    console.log("Not imported (no office in tracker):");
    for (const row of SKIPPED_THIRD_PARTY_CANDIDATES) {
      console.log(`  - ${row.name} (${row.party}) — ${row.office}: ${row.reason}`);
    }
  }
  await closeDb();
}
