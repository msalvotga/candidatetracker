import { normalizeTecFilerId } from "./tecFilerId.mjs";

export function candidateLookupKey(officeId, name, party, isIncumbent) {
  return `${officeId}|${String(name).trim().toLowerCase()}|${party}|${isIncumbent ? 1 : 0}`;
}

const CANDIDATE_IDENTITY_FIELDS = ["name", "party", "is_incumbent"];

export function isIncumbentFlag(value) {
  return value === 1 || value === true || value === "1";
}

export async function fetchCandidateIdentity(db, candidateId) {
  return db
    .prepare(
      `SELECT id, office_id, cycle_year, party, name, is_incumbent
       FROM candidates WHERE id = ?`
    )
    .get(candidateId);
}

export async function loadCandidatesForCategory(db, category, cycleYear) {
  return db
    .prepare(
      `SELECT c.id, c.office_id, o.office_code, o.office_name, o.district, o.sort_order,
              c.name, c.party, c.is_incumbent, c.vuid,
              c.filed, c.tec_filer_id, c.consultant, c.endorsements, c.notes,
              c.website, c.social_media, c.running_for_reelection, c.race_category
       FROM candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE o.category = ? AND c.cycle_year = ? AND c.withdrew = 0`
    )
    .all(category, cycleYear);
}

const PARTY_SORT_ORDER = { R: 0, D: 1, I: 2, L: 3, G: 4, O: 5 };

function sortRaceCandidates(candidates) {
  candidates.sort((a, b) => {
    const partyDiff = (PARTY_SORT_ORDER[a.party] ?? 9) - (PARTY_SORT_ORDER[b.party] ?? 9);
    if (partyDiff !== 0) return partyDiff;
    if (a.is_incumbent !== b.is_incumbent) return a.is_incumbent ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function storedRowToRaceCandidate(row) {
  const name = String(row.name ?? "").trim();
  const party = String(row.party ?? "").trim();
  if (!name || !party) return null;

  return {
    candidate_id: row.id,
    name,
    party,
    is_incumbent: isIncumbentFlag(row.is_incumbent),
    filed: Boolean(row.filed),
    tec_filer_id: normalizeTecFilerId(row.tec_filer_id),
    consultant: row.consultant ?? null,
    endorsements: row.endorsements ?? null,
    notes: row.notes ?? null,
    website: row.website ?? null,
    social_media: row.social_media ?? null,
    race_category: row.race_category ?? null,
    running_for_reelection: row.running_for_reelection ?? null,
    vuid: row.vuid ?? null,
  };
}

/** Build tracker races from the candidates table (single source of truth). */
export function buildRacesFromCandidates(storedRows, metricsByOffice, metricFields, uncontestedMap = new Map()) {
  const byOffice = new Map();

  for (const row of storedRows) {
    const candidate = storedRowToRaceCandidate(row);
    if (!candidate) continue;

    if (!byOffice.has(row.office_id)) {
      const metrics = metricsByOffice.get(row.office_id) ?? {};
      byOffice.set(row.office_id, {
        office_id: row.office_id,
        office_code: row.office_code,
        office_name: row.office_name,
        district: row.district,
        sort_order: row.sort_order,
        metrics: metricFields.map((field) => {
          const winningParty = uncontestedMap.get(`${row.office_id}|${field.key}`) ?? null;
          return {
            key: field.key,
            label: field.label,
            value: metrics[field.key] ?? null,
            uncontested: winningParty != null,
            winning_party: winningParty,
          };
        }),
        candidates: [],
      });
    }

    byOffice.get(row.office_id).candidates.push(candidate);
  }

  return [...byOffice.values()]
    .map((race) => {
      sortRaceCandidates(race.candidates);
      return race;
    })
    .filter((race) => race.candidates.length > 0);
}

export async function deleteCandidatesByIdentity(db, candidate) {
  return db
    .prepare(
      `DELETE FROM candidates
       WHERE office_id = ? AND cycle_year = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))`
    )
    .run(candidate.office_id, candidate.cycle_year, candidate.name);
}

export async function removeDuplicateCandidatesInSlot(db, keepId, slot) {
  await db
    .prepare(
      `DELETE FROM candidates
       WHERE office_id = ? AND cycle_year = ? AND party = ? AND is_incumbent = ? AND id != ?`
    )
    .run(slot.officeId, slot.cycleYear, slot.party, slot.isIncumbent ? 1 : 0, keepId);
}

export function candidateIdentityFieldsTouched(fields) {
  return CANDIDATE_IDENTITY_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(fields, key));
}

export async function ensureCandidate(db, input) {
  const name = String(input.name ?? "").trim();
  const party = String(input.party ?? "").trim();
  if (!name || !party) return null;

  const isIncumbent = input.isIncumbent ? 1 : 0;

  const existing = await db
    .prepare(
      `SELECT id, vuid FROM candidates
       WHERE office_id = ? AND cycle_year = ? AND party = ? AND name = ? AND is_incumbent = ?`
    )
    .get(input.officeId, input.cycleYear, party, name, isIncumbent);

  if (existing) return existing;

  const slotMatches = await db
    .prepare(
      `SELECT id, vuid, name FROM candidates
       WHERE office_id = ? AND cycle_year = ? AND party = ? AND is_incumbent = ?`
    )
    .all(input.officeId, input.cycleYear, party, isIncumbent);

  if (slotMatches.length === 1) {
    const row = slotMatches[0];
    if (row.name !== name) {
      await db.prepare(`UPDATE candidates SET name = ? WHERE id = ?`).run(name, row.id);
    }
    return { id: row.id, vuid: row.vuid };
  }

  const result = await db
    .prepare(
      `INSERT INTO candidates (office_id, cycle_year, party, name, is_incumbent)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .run(input.officeId, input.cycleYear, party, name, isIncumbent);

  return { id: Number(result.lastInsertRowid), vuid: null };
}

export async function updateCandidateVuid(db, candidateId, vuid) {
  const cleaned = vuid == null || String(vuid).trim() === "" ? null : String(vuid).trim();
  if (cleaned) {
    const conflict = await db
      .prepare(`SELECT id FROM candidates WHERE vuid = ? AND id != ?`)
      .get(cleaned, candidateId);
    if (conflict) {
      throw new Error("VUID already assigned to another candidate");
    }
  }
  await db.prepare(`UPDATE candidates SET vuid = ? WHERE id = ?`).run(cleaned, candidateId);
  return cleaned;
}

export async function migrateCohHistoryToFinanceReports(db) {
  const rows = await db
    .prepare(
      `SELECT office_id, cycle_year, candidate_name, party, is_incumbent,
              period_label, report_period_end, cash_on_hand
       FROM candidate_coh_history`
    )
    .all();

  let migrated = 0;
  for (const row of rows) {
    const candidate = await ensureCandidate(db, {
      officeId: row.office_id,
      cycleYear: row.cycle_year,
      name: row.candidate_name,
      party: row.party,
      isIncumbent: Boolean(row.is_incumbent),
    });
    if (!candidate) continue;

    const periodEnd = row.report_period_end ?? `label:${row.period_label}`;
    const existing = await db
      .prepare(
        `SELECT id FROM finance_reports
         WHERE candidate_id = ? AND report_period_end = ? AND report_type = 'TEC'`
      )
      .get(candidate.id, periodEnd);
    if (existing) continue;

    await db.prepare(
      `INSERT INTO finance_reports (candidate_id, report_period_end, report_type, total_raised, total_spent, cash_on_hand)
       VALUES (?, ?, 'TEC', NULL, NULL, ?)`
    ).run(candidate.id, periodEnd, row.cash_on_hand);
    migrated += 1;
  }
  return migrated;
}
