import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bulkImportFinance,
  exportAdminTableCsv,
  exportBallotSummaryXlsx,
  fetchAdminTable,
  fetchAdminTables,
  fetchMultiSelectOptions,
  insertAdminTableRow,
  saveAdminTableRows,
  deleteAdminTableRow,
} from "../api";
import type { OfficeCategory } from "../types";
import { PendingSaveBar } from "./PendingSaveBar";

const CATEGORY_OPTIONS: { id: OfficeCategory | ""; label: string }[] = [
  { id: "", label: "All categories" },
  { id: "house", label: "Texas House" },
  { id: "senate", label: "Texas Senate" },
  { id: "sboe", label: "SBOE" },
  { id: "statewide", label: "Statewide" },
  { id: "congressional", label: "Congressional" },
];

const PARTY_OPTIONS = ["R", "D", "I", "L", "G", "O"];
const BOOLEAN_COLUMNS = new Set(["is_incumbent", "filed"]);
const NUMERIC_COLUMNS = new Set([
  "total_raised",
  "total_spent",
  "cash_on_hand",
  "sort_order",
  "district",
]);

const COLUMN_LABELS: Record<string, string> = {
  candidate_count: "Candidates",
  consultant_key: "Consultant ID",
  org_key: "Org ID",
  consultant_keys: "Consultants",
  target_org_keys: "Target orgs",
  seat_holder_name: "Seat holder",
  seat_holder_party: "Seat holder party",
  office_id: "Office",
  cycle_year: "Cycle year",
  is_incumbent: "Incumbent",
};

const TABLE_COLUMNS: Record<string, string[]> = {
  consultants: ["consultant_key", "name", "candidate_count"],
  targeting_organizations: ["org_key", "name"],
  offices: ["office_code", "office_name", "district", "seat_holder_name", "seat_holder_party", "target_org_keys"],
};

function visibleColumns(tableId: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  const preferred = TABLE_COLUMNS[tableId];
  if (preferred) {
    return preferred.filter((key) => keys.includes(key));
  }
  return keys.filter((key) => key !== "id");
}

type RowEdits = Record<string, Record<string, unknown>>;

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header.trim()] = values[i] ?? "";
    });
    return row;
  });
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function normalizeCellValue(value: unknown) {
  if (value == null) return "";
  return String(value).trim();
}

const MULTI_SELECT_FIELDS = new Set(["target_org_keys", "consultant_keys"]);

function normalizeKeyListValue(value: unknown) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((part) => part.trim())
      .filter(Boolean)
      .sort()
      .join(",");
  }
  return String(value)
    .split(/[,;|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

function cellValuesEqual(a: unknown, b: unknown, column?: string) {
  if (column === "target_org_keys" || column === "consultant_keys") {
    return normalizeKeyListValue(a) === normalizeKeyListValue(b);
  }
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9;
  }
  return normalizeCellValue(a) === normalizeCellValue(b);
}

function buildPendingUpdates(rows: Record<string, unknown>[], edits: RowEdits) {
  return Object.entries(edits)
    .map(([id, patch]) => {
      const row = rows.find(
        (item) =>
          String(item.id) === id ||
          String(item.consultant_key ?? "") === id ||
          String(item.org_key ?? "") === id ||
          String(item.period_key ?? "") === id
      );
      const fields: Record<string, unknown> = {};
      for (const [col, value] of Object.entries(patch)) {
        if (MULTI_SELECT_FIELDS.has(col) || !cellValuesEqual(row?.[col], value, col)) {
          fields[col] = value;
        }
      }
      const numericId = Number(id);
      const rowId = Number.isInteger(numericId) && numericId > 0 ? numericId : id;
      return { id: rowId, fields };
    })
    .filter((update) => Object.keys(update.fields).length > 0);
}

function rowApiId(rowKey: string): string | number {
  const numericId = Number(rowKey);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : rowKey;
}

function rowDisplayLabel(row: Record<string, unknown>, rowKey: string) {
  return String(row.name ?? row.consultant_key ?? row.org_key ?? row.period_key ?? row.id ?? rowKey);
}

function filterSingleCandidateRaces(rows: Record<string, unknown>[]) {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const officeId = Number(row.office_id);
    if (!Number.isFinite(officeId)) continue;
    counts.set(officeId, (counts.get(officeId) ?? 0) + 1);
  }
  const singleOfficeIds = new Set(
    [...counts.entries()].filter(([, count]) => count === 1).map(([officeId]) => officeId)
  );
  return rows.filter((row) => singleOfficeIds.has(Number(row.office_id)));
}

export function AdminDataPanel({ cycleYear, editMode }: { cycleYear: number; editMode: boolean }) {
  const [filterCategory, setFilterCategory] = useState<OfficeCategory | "">("house");
  const [singleCandidateRacesOnly, setSingleCandidateRacesOnly] = useState(false);
  const [tables, setTables] = useState<
    {
      id: string;
      label: string;
      editableColumns: string[];
      multiSelectColumns?: Record<string, string>;
      insertableColumns?: string[];
      deletable?: boolean;
    }[]
  >([]);
  const [selectedTable, setSelectedTable] = useState("candidates");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importResult, setImportResult] = useState("");
  const [edits, setEdits] = useState<RowEdits>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [newRowFields, setNewRowFields] = useState<Record<string, unknown>>({});
  const [multiSelectOptions, setMultiSelectOptions] = useState<Record<string, { value: string; label: string }[]>>({});
  const [officeOptions, setOfficeOptions] = useState<{ value: string; label: string }[]>([]);
  const [addingRow, setAddingRow] = useState(false);
  const [deletingRowId, setDeletingRowId] = useState<string | null>(null);

  const selectedTableMeta = useMemo(() => tables.find((table) => table.id === selectedTable), [tables, selectedTable]);
  const editableColumns = useMemo(() => new Set(selectedTableMeta?.editableColumns ?? []), [selectedTableMeta]);
  const multiSelectColumns = selectedTableMeta?.multiSelectColumns ?? {};
  const insertableColumns = selectedTableMeta?.insertableColumns ?? [];
  const deletable = selectedTableMeta?.deletable ?? false;

  const singleCandidateFilterActive = singleCandidateRacesOnly && selectedTable === "candidates";
  const visibleRows = useMemo(
    () => (singleCandidateFilterActive ? filterSingleCandidateRaces(rows) : rows),
    [rows, singleCandidateFilterActive]
  );
  const visibleTotal = singleCandidateFilterActive ? visibleRows.length : total;

  const columns = useMemo(
    () =>
      visibleRows[0]
        ? visibleColumns(selectedTable, visibleRows[0] as Record<string, unknown>)
        : rows[0]
          ? visibleColumns(selectedTable, rows[0] as Record<string, unknown>)
          : [],
    [visibleRows, rows, selectedTable]
  );

  const pendingUpdates = useMemo(() => buildPendingUpdates(rows, edits), [rows, edits]);
  const hasPendingEdits = pendingUpdates.length > 0;

  const loadTable = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchAdminTable(selectedTable, {
        cycleYear,
        category: filterCategory || undefined,
        limit: 500,
        singleCandidateRaces: selectedTable === "candidates" && singleCandidateRacesOnly,
      });
      setRows(data.rows as Record<string, unknown>[]);
      setTotal(data.total);
      setEdits({});
      setSaved(false);
      setSaveError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load table");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [selectedTable, cycleYear, filterCategory, singleCandidateRacesOnly]);

  useEffect(() => {
    void fetchAdminTables()
      .then((list) => {
        setTables(list);
        if (!list.some((t) => t.id === selectedTable)) setSelectedTable(list[0]?.id ?? "candidates");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load admin tables");
        setTables([]);
      });
  }, [selectedTable]);

  useEffect(() => {
    void loadTable();
  }, [loadTable]);

  useEffect(() => {
    const refs = [...new Set(Object.values(multiSelectColumns))];
    if (refs.length === 0) {
      setMultiSelectOptions({});
      return;
    }
    void Promise.all(
      refs.map(async (ref) => [ref, await fetchMultiSelectOptions(ref, { cycleYear, category: filterCategory || undefined })] as const)
    ).then((entries) => {
      setMultiSelectOptions(Object.fromEntries(entries));
    });
  }, [multiSelectColumns, selectedTable, rows.length, cycleYear, filterCategory]);

  useEffect(() => {
    setNewRowFields(
      selectedTable === "candidates"
        ? { cycle_year: cycleYear, is_incumbent: 0, party: "R" }
        : {}
    );
  }, [selectedTable, cycleYear]);

  useEffect(() => {
    if (selectedTable !== "candidates" || !insertableColumns.includes("office_id")) {
      setOfficeOptions([]);
      return;
    }
    void fetchMultiSelectOptions("offices", { category: filterCategory || undefined }).then(setOfficeOptions);
  }, [selectedTable, insertableColumns, filterCategory]);

  useEffect(() => {
    if (!editMode) {
      setEdits({});
      setSaveError("");
      setSaved(false);
    }
  }, [editMode]);

  function updateCell(rowId: string, column: string, value: unknown) {
    setEdits((prev) => {
      const row = rows.find(
        (item) =>
          String(item.id) === rowId ||
          String(item.consultant_key ?? "") === rowId ||
          String(item.org_key ?? "") === rowId ||
          String(item.period_key ?? "") === rowId
      );
      const nextRow = { ...(prev[rowId] ?? {}) };
      if (cellValuesEqual(row?.[column], value, column)) {
        delete nextRow[column];
      } else {
        nextRow[column] = value;
      }
      if (Object.keys(nextRow).length === 0) {
        const { [rowId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [rowId]: nextRow };
    });
    setSaved(false);
    setSaveError("");
  }

  async function handleSave() {
    if (!hasPendingEdits) return;
    setSaving(true);
    setSaveError("");
    try {
      await saveAdminTableRows(selectedTable, pendingUpdates, cycleYear);
      setEdits({});
      setSaved(true);
      await loadTable();
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  function discardEdits() {
    setEdits({});
    setSaveError("");
    setSaved(false);
  }

  async function handleAddRow() {
    if (insertableColumns.length === 0) return;
    setAddingRow(true);
    setError("");
    try {
      const fields: Record<string, unknown> = {};
      for (const column of insertableColumns) {
        const value = newRowFields[column];
        if (value == null || String(value).trim() === "") {
          setError(`${COLUMN_LABELS[column] ?? column} is required`);
          return;
        }
        fields[column] = value;
      }
      await insertAdminTableRow(selectedTable, fields);
      setNewRowFields(
        selectedTable === "candidates"
          ? { cycle_year: cycleYear, is_incumbent: 0, party: "R" }
          : {}
      );
      await loadTable();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add row");
    } finally {
      setAddingRow(false);
    }
  }

  async function handleDeleteRow(row: Record<string, unknown>, rowKey: string) {
    const label = rowDisplayLabel(row, rowKey);
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;

    setDeletingRowId(rowKey);
    setError("");
    try {
      await deleteAdminTableRow(selectedTable, rowApiId(rowKey));
      setEdits((prev) => {
        const { [rowKey]: _removed, ...rest } = prev;
        return rest;
      });
      await loadTable();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete row");
    } finally {
      setDeletingRowId(null);
    }
  }

  async function handleExport() {
    const url = exportAdminTableCsv(selectedTable, {
      cycleYear,
      category: filterCategory || undefined,
    });
    window.open(url, "_blank");
  }

  async function handleTemplateDownload() {
    window.open("/api/admin/finance/template.csv", "_blank");
  }

  function handleBallotExport() {
    const url = exportBallotSummaryXlsx(cycleYear);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ballot-summary-${cycleYear}.xlsx`;
    link.click();
  }

  async function handleCsvImport(file: File) {
    setImportResult("");
    setError("");
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        setError("CSV has no data rows");
        return;
      }
      const result = await bulkImportFinance(parsed);
      setImportResult(`Imported ${result.imported} row(s).${result.errors.length ? ` ${result.errors.length} error(s).` : ""}`);
      if (result.errors.length) {
        setError(result.errors.slice(0, 5).map((e) => `Row ${e.row}: ${e.error}`).join("\n"));
      }
      void loadTable();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  }

  return (
    <div className="admin-data-panel">
      <header className="admin-data-header">
        <div>
          <h2>Database tables</h2>
          <p className="subtitle">
            {editMode
              ? "Edit mode on — change cells, add rows, or delete rows below, then save edits. Joined columns (office code, etc.) are read-only."
              : "Browse raw data, bulk-import finance reports, and export CSV. Turn on Edit mode to change values."}
          </p>
        </div>
        <div className="admin-data-actions">
          <button type="button" className="filter-chip" onClick={handleBallotExport}>
            Ballot summary (Excel)
          </button>
          <button type="button" className="filter-chip" onClick={() => void handleExport()}>
            Export CSV
          </button>
          <button type="button" className="filter-chip" onClick={() => void handleTemplateDownload()}>
            Finance template
          </button>
          <label className="filter-chip admin-file-button">
            Bulk import finance CSV
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleCsvImport(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </header>

      <div className="admin-data-filters">
        <label className="year-picker">
          Category filter
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as OfficeCategory | "")}
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.id || "all"} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        {selectedTable === "candidates" ? (
          <label className="filter-check-item admin-data-filter-check">
            <input
              type="checkbox"
              checked={singleCandidateRacesOnly}
              onChange={(e) => setSingleCandidateRacesOnly(e.target.checked)}
            />
            <span>Single-candidate races only</span>
          </label>
        ) : null}
      </div>

      <div className="admin-table-tabs">
        {tables.map((table) => (
          <button
            key={table.id}
            type="button"
            className={selectedTable === table.id ? "filter-chip active" : "filter-chip"}
            onClick={() => {
              if (hasPendingEdits && !window.confirm("Discard unsaved table edits?")) return;
              setSelectedTable(table.id);
            }}
          >
            {table.label}
          </button>
        ))}
      </div>

      {error ? <div className="banner error">{error}</div> : null}
      {importResult ? <div className="banner success">{importResult}</div> : null}

      {editMode && insertableColumns.length > 0 ? (
        <div className="admin-add-row">
          {insertableColumns.map((column) => (
            <label key={column} className="admin-add-field">
              <span className="admin-add-label">{COLUMN_LABELS[column] ?? column}</span>
              <AdminTableCell
                column={column}
                value={newRowFields[column] ?? ""}
                editable
                changed={false}
                selectOptions={column === "office_id" ? officeOptions : undefined}
                multiSelectRef={undefined}
                multiSelectOptions={[]}
                onChange={(value) => setNewRowFields((prev) => ({ ...prev, [column]: value }))}
              />
            </label>
          ))}
          <button type="button" className="coh-add-button" disabled={addingRow} onClick={() => void handleAddRow()}>
            Add row
          </button>
        </div>
      ) : null}

      {editMode && selectedTable === "candidates" ? (
        <p className="admin-add-hint">
          Add a candidate by office, cycle year, name, party, and whether they are the incumbent. Use the category
          filter above to narrow the office list.
        </p>
      ) : null}

      {editMode && selectedTable === "consultants" ? (
        <p className="admin-add-hint">
          <strong>Candidates</strong> column shows how many candidates each consultant is assigned to for cycle{" "}
          {cycleYear}
          {filterCategory ? ` · ${filterCategory}` : ""}.
        </p>
      ) : null}

      {editMode && selectedTable === "offices" ? (
        <p className="admin-add-hint">
          Edit <strong>seat_holder_name</strong> and <strong>seat_holder_party</strong> for the current office holder shown in
          the race list. Target orgs use cycle {cycleYear}. Deleting an office also removes its candidates, sheet rows, and
          metrics.
        </p>
      ) : null}

      {loading ? (
        <p className="loading">Loading table…</p>
      ) : (
        <div className="admin-data-body">
          <p className="admin-table-meta">
            Showing {visibleRows.length} of {visibleTotal} rows · cycle {cycleYear}
            {filterCategory ? ` · ${filterCategory}` : " · all categories"}
            {singleCandidateFilterActive ? " · single-candidate races" : ""}
            {editMode ? " · editing enabled" : ""}
          </p>
          {editMode && (hasPendingEdits || saved) ? (
            <PendingSaveBar
              visible={hasPendingEdits}
              saving={saving}
              saved={saved}
              error={saveError}
              onSave={() => void handleSave()}
              onDiscard={discardEdits}
            />
          ) : null}
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>
                      {COLUMN_LABELS[col] ?? col}
                      {editMode && editableColumns.has(col) ? <span className="admin-col-editable"> ✎</span> : null}
                    </th>
                  ))}
                  {editMode && deletable ? <th className="admin-actions-col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => {
                  const rowId = String(row.consultant_key ?? row.org_key ?? row.period_key ?? row.id ?? index);
                  const rowEdits = edits[rowId];
                  return (
                    <tr key={rowId}>
                      {columns.map((col) => (
                        <td key={col} className={editMode && editableColumns.has(col) ? "admin-cell-editable" : undefined}>
                          <AdminTableCell
                            column={col}
                            value={rowEdits && col in rowEdits ? rowEdits[col] : row[col]}
                            editable={editMode && editableColumns.has(col)}
                            changed={Boolean(rowEdits && col in rowEdits)}
                            multiSelectRef={multiSelectColumns[col]}
                            multiSelectOptions={multiSelectColumns[col] ? multiSelectOptions[multiSelectColumns[col]] ?? [] : []}
                            onChange={(value) => updateCell(rowId, col, value)}
                          />
                        </td>
                      ))}
                      {editMode && deletable ? (
                        <td className="admin-actions-col">
                          <button
                            type="button"
                            className="admin-row-delete"
                            disabled={deletingRowId === rowId}
                            onClick={() => void handleDeleteRow(row, rowId)}
                          >
                            {deletingRowId === rowId ? "Deleting…" : "Delete"}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function parseKeyList(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(/[,;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function AdminTableCell({
  column,
  value,
  editable,
  changed,
  multiSelectRef,
  multiSelectOptions,
  selectOptions,
  onChange,
}: {
  column: string;
  value: unknown;
  editable: boolean;
  changed: boolean;
  multiSelectRef?: string;
  multiSelectOptions?: { value: string; label: string }[];
  selectOptions?: { value: string; label: string }[];
  onChange: (value: unknown) => void;
}) {
  if (!editable) return <span className={column === "candidate_count" ? "admin-count-cell" : undefined}>{formatCell(value, column)}</span>;

  if (selectOptions) {
    return (
      <select
        className={`edit-input edit-input-sm${changed ? " edit-input-changed" : ""}`}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">Select office…</option>
        {selectOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (multiSelectRef && multiSelectOptions) {
    const optionKeys = new Set(multiSelectOptions.map((option) => option.value));
    const selected = new Set(parseKeyList(value).filter((key) => optionKeys.has(key)));
    const orphanKeys = parseKeyList(value).filter((key) => !optionKeys.has(key));
    return (
      <div className={`admin-multi-select${changed ? " admin-multi-select-changed" : ""}`}>
        {orphanKeys.length > 0 ? (
          <span className="admin-add-hint">Unlisted: {orphanKeys.join(", ")}</span>
        ) : null}
        {multiSelectOptions.length === 0 ? (
          <span className="admin-add-hint">Add entries in {multiSelectRef} first</span>
        ) : (
          multiSelectOptions.map((option) => (
            <label key={option.value} className="admin-multi-select-item">
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(option.value)) next.delete(option.value);
                  else next.add(option.value);
                  onChange([...next].sort().join(","));
                }}
              />
              <span>{option.label}</span>
            </label>
          ))
        )}
      </div>
    );
  }

  if (column === "party" || column === "incumbent_party" || column === "candidate_party" || column === "seat_holder_party") {
    return (
      <select
        className={`edit-input edit-input-sm${changed ? " edit-input-changed" : ""}`}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">—</option>
        {PARTY_OPTIONS.map((party) => (
          <option key={party} value={party}>
            {party}
          </option>
        ))}
      </select>
    );
  }

  if (BOOLEAN_COLUMNS.has(column)) {
    return (
      <select
        className={`edit-input edit-input-sm${changed ? " edit-input-changed" : ""}`}
        value={value === 1 || value === true || value === "1" ? "1" : "0"}
        onChange={(e) => onChange(e.target.value === "1" ? 1 : 0)}
      >
        <option value="0">0</option>
        <option value="1">1</option>
      </select>
    );
  }

  if (NUMERIC_COLUMNS.has(column)) {
    return (
      <input
        className={`edit-input edit-input-sm${changed ? " edit-input-changed" : ""}`}
        type="number"
        step={column.includes("raised") || column.includes("spent") || column.includes("coh") ? 1 : undefined}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value.trim() === "" ? null : Number(e.target.value))}
      />
    );
  }

  return (
    <input
      className={`edit-input edit-input-sm${changed ? " edit-input-changed" : ""}`}
      type="text"
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value.trim() === "" ? null : e.target.value)}
    />
  );
}

function formatCell(value: unknown, column?: string) {
  if (value == null) return column === "candidate_count" ? "0" : "";
  if (column === "candidate_count") return String(value);
  if (typeof value === "boolean" || value === 0 || value === 1) return String(value);
  return String(value);
}
