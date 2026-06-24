import { canonicalReportEndForPeriod, loadFilingPeriodMaps } from "./filingPeriods.mjs";
import { syncCandidateConsultants, parseKeyList, formatKeyList, listConsultants } from "./consultants.mjs";
import { syncOfficeTargets } from "./targeting.mjs";

const ADMIN_TABLES = {
  filing_periods: {
    label: "Filing periods",
    query: async (db, { limit, offset }) => {
      const rows = await db
        .prepare(
          `SELECT period_key, period_key AS id, label, sort_order, default_report_period_end
           FROM filing_periods
           ORDER BY sort_order, period_key
           LIMIT @limit OFFSET @offset`
        )
        .all({ limit, offset });
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM filing_periods`).get()).count;
      return { rows, total };
    },
    exportQuery: async (db) => (await adminQueryTable(db, "filing_periods", { limit: 100000, offset: 0 })).rows,
  },
  candidates: {
    label: "Candidates",
    query: async (db, { cycleYear, category, limit, offset, singleCandidateRaces }) => {
      const params = { limit, offset };
      let where = "WHERE 1=1";
      if (cycleYear) {
        where += " AND c.cycle_year = @cycleYear";
        params.cycleYear = cycleYear;
      }
      if (category) {
        where += " AND o.category = @category";
        params.category = category;
      }
      if (singleCandidateRaces) {
        if (!cycleYear) throw new Error("cycle year required for single-candidate race filter");
        let singleWhere = "WHERE c2.cycle_year = @cycleYear AND c2.withdrew = 0";
        if (category) {
          singleWhere += " AND o2.category = @category";
        }
        where += ` AND c.office_id IN (
          SELECT c2.office_id
          FROM candidates c2
          JOIN offices o2 ON o2.id = c2.office_id
          ${singleWhere}
          GROUP BY c2.office_id
          HAVING COUNT(*) = 1
        )`;
      }
      const rows = await db
        .prepare(
          `SELECT c.id, c.vuid, c.office_id, o.office_code, o.office_name, o.category,
                  c.cycle_year, c.name, c.party, c.is_incumbent, c.tec_filer_id,
                  c.filed, c.notes,
                  COALESCE((
                    SELECT GROUP_CONCAT(cc.consultant_key)
                    FROM candidate_consultants cc
                    WHERE cc.candidate_id = c.id
                  ), '') AS consultant_keys
           FROM candidates c
           JOIN offices o ON o.id = c.office_id
           ${where}
           ORDER BY o.category, o.sort_order, c.cycle_year DESC, c.name
           LIMIT @limit OFFSET @offset`
        )
        .all(params);
      const total = (await db
        .prepare(
          `SELECT COUNT(*) AS count FROM candidates c
           JOIN offices o ON o.id = c.office_id ${where}`
        )
        .get(params)).count;
      return { rows, total };
    },
    exportQuery: async (db, filters) =>
      (await adminQueryTable(db, "candidates", { ...filters, limit: 100000, offset: 0 })).rows,
  },
  finance_reports: {
    label: "Finance reports",
    query: async (db, { cycleYear, category, limit, offset }) => {
      const params = { limit, offset };
      let where = "WHERE 1=1";
      if (cycleYear) {
        where += " AND c.cycle_year = @cycleYear";
        params.cycleYear = cycleYear;
      }
      if (category) {
        where += " AND o.category = @category";
        params.category = category;
      }
      const rows = await db
        .prepare(
          `SELECT f.id, f.candidate_id, c.name AS candidate_name, c.party, c.is_incumbent,
                  o.office_code, c.cycle_year, f.period_key, fp.label AS period_label,
                  f.report_period_end, f.report_type,
                  f.total_raised, f.total_spent, f.cash_on_hand
           FROM finance_reports f
           JOIN candidates c ON c.id = f.candidate_id
           JOIN offices o ON o.id = c.office_id
           LEFT JOIN filing_periods fp ON fp.period_key = f.period_key
           ${where}
           ORDER BY f.report_period_end DESC, f.id DESC
           LIMIT @limit OFFSET @offset`
        )
        .all(params);
      const total = (await db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM finance_reports f
           JOIN candidates c ON c.id = f.candidate_id
           JOIN offices o ON o.id = c.office_id
           ${where}`
        )
        .get(params)).count;
      return { rows, total };
    },
    exportQuery: async (db, filters) =>
      (await adminQueryTable(db, "finance_reports", { ...filters, limit: 100000, offset: 0 })).rows,
  },
  offices: {
    label: "Offices",
    query: async (db, { cycleYear, category, limit, offset }) => {
      const params = { limit, offset, cycleYear: cycleYear ?? 2026 };
      let where = "WHERE 1=1";
      if (category) {
        where += " AND o.category = @category";
        params.category = category;
      }
      const rows = await db
        .prepare(
          `SELECT o.id, o.category, o.district, o.office_code, o.office_name, o.sort_order,
                  o.seat_holder_name, o.seat_holder_party,
                  COALESCE((
                    SELECT GROUP_CONCAT(ot.org_key)
                    FROM office_targets ot
                    WHERE ot.office_id = o.id AND ot.cycle_year = @cycleYear
                  ), '') AS target_org_keys
           FROM offices o
           ${where}
           ORDER BY o.category, o.sort_order, o.district
           LIMIT @limit OFFSET @offset`
        )
        .all(params);
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM offices o ${where}`).get(params)).count;
      return { rows, total };
    },
    exportQuery: async (db, filters) =>
      (await adminQueryTable(db, "offices", { ...filters, limit: 100000, offset: 0 })).rows,
  },
  race_sheet_rows: {
    label: "Race sheet rows",
    query: async (db, { cycleYear, category, limit, offset }) => {
      const params = { limit, offset };
      let where = "WHERE 1=1";
      if (cycleYear) {
        where += " AND r.cycle_year = @cycleYear";
        params.cycleYear = cycleYear;
      }
      if (category) {
        where += " AND r.category = @category";
        params.category = category;
      }
      const rows = await db
        .prepare(
          `SELECT r.id, r.office_id, o.office_code, r.cycle_year, r.category, r.row_order,
                  r.incumbent_name, r.incumbent_party, r.candidate_name, r.candidate_party,
                  r.filed, r.consultant, r.notes
           FROM race_sheet_rows r
           JOIN offices o ON o.id = r.office_id
           ${where}
           ORDER BY r.category, o.sort_order, r.row_order
           LIMIT @limit OFFSET @offset`
        )
        .all(params);
      const total = (await db
        .prepare(`SELECT COUNT(*) AS count FROM race_sheet_rows r ${where}`)
        .get(params)).count;
      return { rows, total };
    },
    exportQuery: async (db, filters) =>
      (await adminQueryTable(db, "race_sheet_rows", { ...filters, limit: 100000, offset: 0 })).rows,
  },
  targeting_organizations: {
    label: "Targeting organizations",
    query: async (db, { limit, offset }) => {
      const rows = await db
        .prepare(
          `SELECT org_key, org_key AS id, name
           FROM targeting_organizations
           ORDER BY name COLLATE NOCASE LIMIT @limit OFFSET @offset`
        )
        .all({ limit, offset });
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM targeting_organizations`).get()).count;
      return { rows, total };
    },
    exportQuery: async (db) =>
      (await adminQueryTable(db, "targeting_organizations", { limit: 100000, offset: 0 })).rows,
  },
  consultants: {
    label: "Consultants",
    query: async (db, { cycleYear, category, limit, offset }) => {
      const all = await listConsultants(db, { cycleYear, category });
      const rows = all.slice(offset, offset + limit).map((row) => ({
        ...row,
        id: row.consultant_key,
      }));
      return { rows, total: all.length };
    },
    exportQuery: async (db, filters) =>
      (await adminQueryTable(db, "consultants", { ...filters, limit: 100000, offset: 0 })).rows,
  },
};

const ADMIN_TABLE_NAMES = new Set(Object.keys(ADMIN_TABLES));

export const EDITABLE_COLUMNS = {
  filing_periods: ["label", "sort_order", "default_report_period_end"],
  candidates: ["vuid", "name", "party", "is_incumbent", "tec_filer_id", "filed", "consultant_keys", "notes"],
  finance_reports: ["period_key", "report_period_end", "total_raised", "total_spent", "cash_on_hand"],
  offices: ["office_name", "district", "sort_order", "seat_holder_name", "seat_holder_party", "target_org_keys"],
  race_sheet_rows: [
    "incumbent_name",
    "incumbent_party",
    "candidate_name",
    "candidate_party",
    "filed",
    "tec_filer_id",
    "consultant",
    "notes",
  ],
  targeting_organizations: ["name"],
  consultants: ["name"],
};

export const MULTI_SELECT_COLUMNS = {
  offices: { target_org_keys: "targeting_organizations" },
  candidates: { consultant_keys: "consultants" },
};

export const INSERTABLE_TABLES = {
  candidates: ["office_id", "cycle_year", "name", "party", "is_incumbent"],
  targeting_organizations: ["org_key", "name"],
  consultants: ["consultant_key", "name"],
  filing_periods: ["period_key", "label", "sort_order", "default_report_period_end"],
};

/** Tables that support row deletion in the Data tab. */
export const DELETABLE_TABLES = {
  filing_periods: { keyColumn: "period_key", stringKey: true },
  candidates: { keyColumn: "id", stringKey: false },
  finance_reports: { keyColumn: "id", stringKey: false },
  offices: { keyColumn: "id", stringKey: false },
  race_sheet_rows: { keyColumn: "id", stringKey: false },
  targeting_organizations: { keyColumn: "org_key", stringKey: true },
  consultants: { keyColumn: "consultant_key", stringKey: true },
};

const INTEGER_COLUMNS = new Set([
  "is_incumbent",
  "filed",
  "sort_order",
  "district",
  "row_order",
  "cycle_year",
  "office_id",
]);
const REAL_COLUMNS = new Set(["total_raised", "total_spent", "cash_on_hand"]);

const PARTY_VALUES = new Set(["R", "D", "I", "L", "G", "O"]);

function coerceAdminValue(column, value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  if (column === "party" || column === "seat_holder_party") {
    const party = String(value).trim().toUpperCase();
    if (!PARTY_VALUES.has(party)) throw new Error(`invalid party: ${value}`);
    return party;
  }
  if (INTEGER_COLUMNS.has(column)) {
    if (value === true || value === "true" || value === 1 || value === "1") return 1;
    if (value === false || value === "false" || value === 0 || value === "0") return 0;
    const num = Number(value);
    if (!Number.isInteger(num)) throw new Error(`invalid integer for ${column}`);
    return num;
  }
  if (REAL_COLUMNS.has(column)) {
    const num = Number(String(value).replace(/[$,%\s]/g, ""));
    if (!Number.isFinite(num)) throw new Error(`invalid number for ${column}`);
    return num;
  }
  return String(value);
}

export async function bulkUpdateAdminTableRows(db, tableName, updates, { cycleYear } = {}) {
  if (!ADMIN_TABLE_NAMES.has(tableName)) throw new Error("unknown table");
  const editable = new Set(EDITABLE_COLUMNS[tableName] ?? []);
  if (editable.size === 0) throw new Error("table is not editable");

  const apply = db.transaction(async (rows) => {
    let updated = 0;
    for (const item of rows) {
      const fields = { ...(item?.fields ?? item?.patch ?? {}) };

      if (tableName === "filing_periods") {
        const periodKey = String(item?.period_key ?? item?.id ?? "").trim();
        if (!periodKey) throw new Error("period_key required");
        const setParts = [];
        const params = { period_key: periodKey };
        for (const [key, raw] of Object.entries(fields)) {
          if (!editable.has(key)) continue;
          const paramKey = `f_${key}`;
          setParts.push(`${key} = @${paramKey}`);
          params[paramKey] = coerceAdminValue(key, raw);
        }
        if (setParts.length === 0) continue;
        const result = await db
          .prepare(`UPDATE filing_periods SET ${setParts.join(", ")} WHERE period_key = @period_key`)
          .run(params);
        if (result.changes === 0) throw new Error(`period ${periodKey} not found`);
        updated += 1;
        continue;
      }

      if (tableName === "targeting_organizations") {
        const orgKey = String(item?.org_key ?? item?.id ?? "").trim();
        if (!orgKey) throw new Error("org_key required");
        const setParts = [];
        const params = { org_key: orgKey };
        for (const [key, raw] of Object.entries(fields)) {
          if (!editable.has(key)) continue;
          const paramKey = `f_${key}`;
          setParts.push(`${key} = @${paramKey}`);
          params[paramKey] = coerceAdminValue(key, raw);
        }
        if (setParts.length === 0) continue;
        const result = await db
          .prepare(`UPDATE targeting_organizations SET ${setParts.join(", ")} WHERE org_key = @org_key`)
          .run(params);
        if (result.changes === 0) throw new Error(`organization ${orgKey} not found`);
        updated += 1;
        continue;
      }

      if (tableName === "consultants") {
        const consultantKey = String(item?.consultant_key ?? item?.id ?? "").trim();
        if (!consultantKey) throw new Error("consultant_key required");
        const setParts = [];
        const params = { consultant_key: consultantKey };
        for (const [key, raw] of Object.entries(fields)) {
          if (!editable.has(key)) continue;
          const paramKey = `f_${key}`;
          setParts.push(`${key} = @${paramKey}`);
          params[paramKey] = coerceAdminValue(key, raw);
        }
        if (setParts.length === 0) continue;
        const result = await db
          .prepare(`UPDATE consultants SET ${setParts.join(", ")} WHERE consultant_key = @consultant_key`)
          .run(params);
        if (result.changes === 0) throw new Error(`consultant ${consultantKey} not found`);
        updated += 1;
        continue;
      }

      const rowId = Number(item?.id);
      if (!Number.isInteger(rowId) || rowId < 1) throw new Error("invalid row id");

      if (tableName === "offices" && Object.prototype.hasOwnProperty.call(fields, "target_org_keys")) {
        await syncOfficeTargets(db, rowId, cycleYear ?? 2026, parseKeyList(fields.target_org_keys));
        delete fields.target_org_keys;
      }

      if (tableName === "candidates" && Object.prototype.hasOwnProperty.call(fields, "consultant_keys")) {
        await syncCandidateConsultants(db, rowId, parseKeyList(fields.consultant_keys));
        delete fields.consultant_keys;
      }

      if (tableName === "finance_reports" && fields.period_key != null) {
        const maps = await loadFilingPeriodMaps(db);
        const periodKey = String(fields.period_key).trim();
        fields.report_period_end = canonicalReportEndForPeriod(
          periodKey,
          maps,
          fields.report_period_end != null ? String(fields.report_period_end) : null
        );
      }

      const setParts = [];
      const params = { id: rowId };
      for (const [key, raw] of Object.entries(fields)) {
        if (!editable.has(key)) continue;
        const paramKey = `f_${key}`;
        setParts.push(`${key} = @${paramKey}`);
        params[paramKey] = coerceAdminValue(key, raw);
      }
      if (setParts.length === 0) {
        if (tableName === "offices" || tableName === "candidates") updated += 1;
        continue;
      }
      const result = await db.prepare(`UPDATE ${tableName} SET ${setParts.join(", ")} WHERE id = @id`).run(params);
      if (result.changes === 0) throw new Error(`row ${rowId} not found`);
      updated += 1;
    }
    return { updated };
  });

  return await apply(updates);
}

export async function insertAdminTableRow(db, tableName, fields) {
  const columns = INSERTABLE_TABLES[tableName];
  if (!columns?.length) throw new Error("table does not support inserts");

  const params = {};
  const values = [];
  for (const column of columns) {
    const raw = fields[column];
    if (raw == null || String(raw).trim() === "") {
      throw new Error(`${column} is required`);
    }
    params[column] = coerceAdminValue(column, raw);
    values.push(`@${column}`);
  }

  if (tableName === "targeting_organizations") {
    await db.prepare(
      `INSERT INTO targeting_organizations (${columns.join(", ")}) VALUES (${values.join(", ")})`
    ).run(params);
    return await db.prepare(`SELECT org_key AS id, org_key, name FROM targeting_organizations WHERE org_key = ?`).get(params.org_key);
  }

  if (tableName === "consultants") {
    await db.prepare(`INSERT INTO consultants (${columns.join(", ")}) VALUES (${values.join(", ")})`).run(params);
    return await db
      .prepare(`SELECT consultant_key AS id, consultant_key, name FROM consultants WHERE consultant_key = ?`)
      .get(params.consultant_key);
  }

  if (tableName === "filing_periods") {
    await db.prepare(`INSERT INTO filing_periods (${columns.join(", ")}) VALUES (${values.join(", ")})`).run(params);
    return await db.prepare(`SELECT * FROM filing_periods WHERE period_key = ?`).get(params.period_key);
  }

  if (tableName === "candidates") {
    const office = await db.prepare(`SELECT id FROM offices WHERE id = ?`).get(params.office_id);
    if (!office) throw new Error("office not found");

    const result = await db.prepare(
      `INSERT INTO candidates (office_id, cycle_year, name, party, is_incumbent, filed, withdrew)
       VALUES (@office_id, @cycle_year, @name, @party, @is_incumbent, 0, 0)
       RETURNING id`
    ).run(params);

    const id = result.lastInsertRowid;
    return await db
      .prepare(
        `SELECT c.id, c.vuid, c.office_id, o.office_code, o.office_name, o.category,
                c.cycle_year, c.name, c.party, c.is_incumbent, c.tec_filer_id,
                c.filed, c.notes, '' AS consultant_keys
         FROM candidates c
         JOIN offices o ON o.id = c.office_id
         WHERE c.id = ?`
      )
      .get(id);
  }

  throw new Error("unsupported insert table");
}

export async function deleteAdminTableRow(db, tableName, rowId) {
  const config = DELETABLE_TABLES[tableName];
  if (!config) throw new Error("table rows cannot be deleted");

  const key = config.stringKey ? String(rowId ?? "").trim() : Number(rowId);
  if (config.stringKey) {
    if (!key) throw new Error("invalid row id");
  } else if (!Number.isInteger(key) || key < 1) {
    throw new Error("invalid row id");
  }

  const result = await db.prepare(`DELETE FROM ${tableName} WHERE ${config.keyColumn} = ?`).run(key);
  if (result.changes === 0) throw new Error("row not found");
  return { deleted: result.changes };
}

export async function loadAdminMultiSelectOptions(db, refTable, { cycleYear, category } = {}) {
  if (refTable === "targeting_organizations") {
    return await db
      .prepare(`SELECT org_key AS value, name AS label FROM targeting_organizations ORDER BY name COLLATE NOCASE`)
      .all();
  }
  if (refTable === "consultants") {
    return (await listConsultants(db, { cycleYear, category })).map((row) => ({
      value: row.consultant_key,
      label: `${row.name} (${row.candidate_count ?? 0})`,
      count: row.candidate_count ?? 0,
    }));
  }
  if (refTable === "offices") {
    const params = {};
    let where = "WHERE 1=1";
    if (category) {
      where += " AND category = @category";
      params.category = category;
    }
    return await db
      .prepare(
        `SELECT id AS value, office_code || ' — ' || office_name AS label
         FROM offices
         ${where}
         ORDER BY sort_order, district, office_code`
      )
      .all(params);
  }
  return [];
}

export function listAdminTables() {
  return Object.entries(ADMIN_TABLES).map(([id, table]) => ({
    id,
    label: table.label,
    editableColumns: EDITABLE_COLUMNS[id] ?? [],
    multiSelectColumns: MULTI_SELECT_COLUMNS[id] ?? {},
    insertableColumns: INSERTABLE_TABLES[id] ?? [],
    deletable: Boolean(DELETABLE_TABLES[id]),
  }));
}

export async function adminQueryTable(
  db,
  tableName,
  { cycleYear, category, limit = 100, offset = 0, singleCandidateRaces = false } = {}
) {
  const table = ADMIN_TABLES[tableName];
  if (!table) throw new Error("unknown table");
  return table.query(db, { cycleYear, category, limit, offset, singleCandidateRaces });
}

export async function exportTableCsv(db, tableName, filters = {}) {
  const table = ADMIN_TABLES[tableName];
  if (!table) throw new Error("unknown table");
  const rows = await table.exportQuery(db, filters);
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n");
}

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export const FINANCE_BULK_TEMPLATE = [
  "candidate_id",
  "office_code",
  "cycle_year",
  "candidate_name",
  "party",
  "is_incumbent",
  "period_key",
  "period_label",
  "report_period_end",
  "contributions",
  "expenditures",
  "cash_on_hand",
].join(",");
