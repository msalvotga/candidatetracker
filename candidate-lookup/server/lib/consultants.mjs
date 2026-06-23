export function listConsultants(db, { cycleYear, category } = {}) {
  const params = {};
  let countFilter = "";
  if (cycleYear) {
    params.cycleYear = cycleYear;
    countFilter += " AND cand.cycle_year = @cycleYear";
  }
  if (category) {
    params.category = category;
    countFilter += " AND o.category = @category";
  }

  return db
    .prepare(
      `SELECT c.consultant_key, c.name,
              (SELECT COUNT(DISTINCT cc.candidate_id)
               FROM candidate_consultants cc
               JOIN candidates cand ON cand.id = cc.candidate_id
               JOIN offices o ON o.id = cand.office_id
               WHERE cc.consultant_key = c.consultant_key${countFilter}) AS candidate_count
       FROM consultants c
       ORDER BY c.name COLLATE NOCASE`
    )
    .all(params);
}

export function loadCandidateConsultantsMap(db, category, cycleYear) {
  const rows = db
    .prepare(
      `SELECT c.id AS candidate_id, c.office_id, c.name, c.party, c.is_incumbent,
              cc.consultant_key, con.name
       FROM candidate_consultants cc
       JOIN candidates c ON c.id = cc.candidate_id
       JOIN offices o ON o.id = c.office_id
       JOIN consultants con ON con.consultant_key = cc.consultant_key
       WHERE o.category = ? AND c.cycle_year = ?
       ORDER BY con.name COLLATE NOCASE`
    )
    .all(category, cycleYear);

  const map = new Map();
  for (const row of rows) {
    const key = `${row.office_id}|${String(row.name).trim().toLowerCase()}|${row.party}|${row.is_incumbent ? 1 : 0}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      consultant_key: row.consultant_key,
      name: row.name,
    });
  }
  return map;
}

export function attachConsultantsToRaces(races, consultantsMap) {
  return races.map((race) => ({
    ...race,
    candidates: race.candidates.map((candidate) => {
      const key = `${race.office_id}|${String(candidate.name).trim().toLowerCase()}|${candidate.party}|${candidate.is_incumbent ? 1 : 0}`;
      const consultants = consultantsMap.get(key) ?? [];
      const consultantNames = consultants.map((c) => c.name).join(", ");
      return {
        ...candidate,
        consultants,
        consultant_keys: consultants.map((c) => c.consultant_key),
        consultant: consultantNames || candidate.consultant || null,
      };
    }),
  }));
}

export function syncCandidateConsultants(db, candidateId, consultantKeys) {
  const keys = [...new Set(consultantKeys.map((key) => String(key).trim()).filter(Boolean))];
  const apply = db.transaction(() => {
    db.prepare(`DELETE FROM candidate_consultants WHERE candidate_id = ?`).run(candidateId);
    const insert = db.prepare(
      `INSERT INTO candidate_consultants (candidate_id, consultant_key) VALUES (?, ?)`
    );
    for (const consultantKey of keys) {
      insert.run(candidateId, consultantKey);
    }
    const names = keys.length
      ? db
          .prepare(
            `SELECT name FROM consultants WHERE consultant_key IN (${keys.map(() => "?").join(", ")}) ORDER BY name COLLATE NOCASE`
          )
          .all(...keys)
          .map((row) => row.name)
          .join(", ")
      : null;
    db.prepare(`UPDATE candidates SET consultant = ? WHERE id = ?`).run(names, candidateId);
  });
  apply();
  return keys;
}

export function addConsultant(db, { consultant_key, name }) {
  const key = String(consultant_key ?? "").trim();
  const consultantName = String(name ?? "").trim();
  if (!key || !consultantName) throw new Error("consultant_key and name required");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error("consultant_key must start with a letter and contain only letters, numbers, _ or -");
  }
  db.prepare(`INSERT INTO consultants (consultant_key, name) VALUES (?, ?)`).run(key, consultantName);
  return { consultant_key: key, name: consultantName };
}

export function parseKeyList(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.trim()).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return text
    .split(/[,;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function formatKeyList(keys) {
  return keys.join(", ");
}
