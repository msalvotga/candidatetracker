/** Convert SQLite-oriented SQL to PostgreSQL. */

export function toPgSql(sql) {
  let s = sql;

  s = s.replace(/GROUP_CONCAT\(([^)]+)\)/gi, "STRING_AGG($1::text, ',')");
  s = s.replace(/ORDER BY ([^\s,]+) COLLATE NOCASE/gi, "ORDER BY LOWER($1)");
  s = s.replace(/\bINSERT OR IGNORE\b/gi, "INSERT");
  s = s.replace(/\bINSERT OR REPLACE\b/gi, "INSERT");
  s = s.replace(/ON CONFLICT\(([^)]+)\) DO NOTHING/gi, "ON CONFLICT ($1) DO NOTHING");
  s = s.replace(/last_insert_rowid\(\)/gi, "currval(pg_get_serial_sequence('candidates', 'id'))");

  return s;
}

function appendOnConflictDoNothing(sql) {
  const trimmed = sql.trimEnd();
  if (/ON CONFLICT/i.test(trimmed)) return sql;
  const insertMatch = trimmed.match(
    /^INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]+)\)\s*VALUES/i
  );
  if (!insertMatch) return sql;

  const table = insertMatch[1];
  const conflictTargets = {
    offices: "office_code",
    targeting_organizations: "org_key",
    consultants: "consultant_key",
    candidate_consultants: "(candidate_id, consultant_key)",
    office_targets: "(office_id, cycle_year, org_key)",
    app_meta: "key",
  };
  const target = conflictTargets[table];
  if (!target) return sql;
  return `${trimmed} ON CONFLICT (${target}) DO NOTHING`;
}

export function bindSql(sql, args) {
  let pgSql = toPgSql(sql);
  if (/INSERT OR IGNORE/i.test(sql)) {
    pgSql = appendOnConflictDoNothing(pgSql);
  }

  if (
    args.length === 1 &&
    args[0] != null &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0])
  ) {
    const obj = args[0];
    const names = [];
    const converted = pgSql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      if (!names.includes(name)) names.push(name);
      return `$${names.indexOf(name) + 1}`;
    });
    return { sql: converted, values: names.map((n) => obj[n]) };
  }

  const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : [...args];
  let i = 0;
  const converted = pgSql.replace(/\?/g, () => `$${++i}`);
  return { sql: converted, values };
}

export function isConstraintError(err) {
  return err?.code === "23505" || err?.code === "23503" || err?.code === "23514";
}
