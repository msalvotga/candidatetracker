import { useEffect, useId, useMemo, useRef, useState } from "react";

type Props = {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function CountyMultiSelect({
  options,
  value,
  onChange,
  disabled = false,
  placeholder = "Search counties…",
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedSet = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const list = q ? options.filter((c) => c.includes(q)) : options;
    return [...list].sort((a, b) => a.localeCompare(b));
  }, [options, search]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(county: string) {
    const next = new Set(selectedSet);
    if (next.has(county)) next.delete(county);
    else next.add(county);
    onChange([...next].sort((a, b) => a.localeCompare(b)));
  }

  function selectAllFiltered() {
    const next = new Set(selectedSet);
    for (const c of filtered) next.add(c);
    onChange([...next].sort((a, b) => a.localeCompare(b)));
  }

  function clearAll() {
    onChange([]);
  }

  const triggerLabel =
    value.length === 0
      ? "All counties"
      : value.length === 1
        ? value[0]
        : `${value.length} counties selected`;

  return (
    <div className="enr-county-multi" ref={rootRef}>
      <button
        type="button"
        className="enr-county-multi__trigger"
        disabled={disabled || !options.length}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="enr-county-multi__trigger-label">{triggerLabel}</span>
        <span className="enr-county-multi__chevron" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="enr-county-multi__panel" id={listId} role="listbox" aria-multiselectable="true">
          <div className="enr-county-multi__search-wrap">
            <input
              type="search"
              className="enr-county-multi__search"
              placeholder={placeholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="enr-county-multi__actions">
            <button type="button" className="enr-btn enr-btn--ghost enr-btn--sm" onClick={selectAllFiltered}>
              Select shown
            </button>
            <button
              type="button"
              className="enr-btn enr-btn--ghost enr-btn--sm"
              onClick={clearAll}
              disabled={!value.length}
            >
              Clear all
            </button>
          </div>
          <ul className="enr-county-multi__list">
            {filtered.length === 0 && <li className="enr-county-multi__empty">No counties match</li>}
            {filtered.map((county) => (
              <li key={county}>
                <label className="enr-county-multi__option">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(county)}
                    onChange={() => toggle(county)}
                  />
                  <span>{county}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}