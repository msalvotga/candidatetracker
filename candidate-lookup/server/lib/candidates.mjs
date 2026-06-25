export function candidateLookupKey(officeId, name, party, isIncumbent) {
  return `${officeId}|${String(name).trim().toLowerCase()}|${party}|${isIncumbent ? 1 : 0}`;
}

export async function ensureCandidate(db, input) {
  const name = String(input.name ?? "").trim();
  const party = String(input.party ?? "").trim();
  if (!name || !party) return null;

  const existing = await db
    .prepare(
      `SELECT id, vuid FROM candidates
       WHERE office_id = ? AND cycle_year = ? AND party = ? AND name = ? AND is_incumbent = ?`
    )
    .get(input.officeId, input.cycleYear, party, name, input.isIncumbent ? 1 : 0);

  if (existing) return existing;

  const result = await db
    .prepare(
      `INSERT INTO candidates (office_id, cycle_year, party, name, is_incumbent)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .run(input.officeId, input.cycleYear, party, name, input.isIncumbent ? 1 : 0);

  return { id: Number(result.lastInsertRowid), vuid: null };
}

export async function loadCandidateMetaMap(db, category, cycleYear) {
  const rows = await db
    .prepare(
      `SELECT c.id, c.office_id, c.name, c.party, c.is_incumbent, c.vuid,
              c.filed, c.tec_filer_id, c.consultant, c.endorsements, c.notes,
              c.website, c.social_media, c.running_for_reelection, c.race_category
       FROM candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE o.category = ? AND c.cycle_year = ?`
    )
    .all(category, cycleYear);

  const map = new Map();
  for (const row of rows) {
    map.set(candidateLookupKey(row.office_id, row.name, row.party, row.is_incumbent), {
      id: row.id,
      vuid: row.vuid,
      filed: Boolean(row.filed),
      tec_filer_id: row.tec_filer_id,
      consultant: row.consultant,
      endorsements: row.endorsements,
      notes: row.notes,
      website: row.website,
      social_media: row.social_media,
      running_for_reelection: row.running_for_reelection,
      race_category: row.race_category,
    });
  }
  return map;
}

function mergeCandidateMeta(candidate, meta) {
  candidate.candidate_id = meta.id;
  candidate.vuid = meta.vuid;
  candidate.filed = meta.filed;
  candidate.tec_filer_id = meta.tec_filer_id ?? candidate.tec_filer_id ?? null;
  candidate.consultant = meta.consultant ?? candidate.consultant ?? null;
  candidate.endorsements = meta.endorsements ?? candidate.endorsements ?? null;
  candidate.notes = meta.notes ?? candidate.notes ?? null;
  candidate.website = meta.website ?? candidate.website ?? null;
  candidate.social_media = meta.social_media ?? candidate.social_media ?? null;
  candidate.running_for_reelection =
    meta.running_for_reelection ?? candidate.running_for_reelection ?? null;
  candidate.race_category = meta.race_category ?? candidate.race_category ?? null;
}

export async function syncRaceCandidates(db, races, cycleYear, category) {
  for (const race of races) {
    for (const candidate of race.candidates) {
      const ensured = await ensureCandidate(db, {
        officeId: race.office_id,
        cycleYear,
        name: candidate.name,
        party: candidate.party,
        isIncumbent: candidate.is_incumbent,
      });
      if (ensured) {
        candidate.candidate_id = ensured.id;
        if (ensured.vuid != null) candidate.vuid = ensured.vuid;
      }
    }
  }

  if (!category) return races;

  const metaMap = await loadCandidateMetaMap(db, category, cycleYear);
  for (const race of races) {
    for (const candidate of race.candidates) {
      const stored = metaMap.get(
        candidateLookupKey(race.office_id, candidate.name, candidate.party, candidate.is_incumbent)
      );
      if (stored) mergeCandidateMeta(candidate, stored);
    }
  }
  return races;
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
