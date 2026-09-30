import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchVoteDesk,
  saveCountyRaceVoteSource,
  saveVoteDeskManual,
  type VoteDeskOrigin,
  type VoteDeskPayload,
} from "../lib/dataBackend";
import { TEXAS_COUNTIES } from "../lib/texasCounties";
import { SettingsCollapse } from "./SettingsCollapse";

const PAGE_SIZE = 40;

const SECTION_LABELS: Record<string, string> = {
  Federal: "Federal",
  StateWide: "Statewide",
  Districted: "District",
  StateWideQ: "Statewide props",
};

type FilterId = "all" | VoteDeskOrigin;
type CellDraft = { early: string; day: string; mail: string };
type CountyDraft = Record<string, CellDraft>;

const FILTERS: Array<{ id: FilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "empty", label: "No numbers" },
  { id: "manual", label: "Manual" },
  { id: "county_feed", label: "County site" },
  { id: "sos", label: "SOS" },
];

function isGovernorName(name: string) {
  const n = name.toLowerCase();
  return /\bgovernor\b/.test(n) && !n.includes("lieutenant");
}

function countyLabel(key: string) {
  return TEXAS_COUNTIES.find((c) => c.key === key)?.label ?? key.replace(/_/g, " ");
}

function zeroCell(): CellDraft {
  return { early: "0", day: "0", mail: "0" };
}

function cellFromNumbers(n: { earlyVotes: number; electionDayVotes: number; mailVotes: number } | undefined): CellDraft {
  if (!n) return zeroCell();
  return {
    early: String(n.earlyVotes ?? 0),
    day: String(n.electionDayVotes ?? 0),
    mail: String(n.mailVotes ?? 0),
  };
}

function asCount(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function cellTotal(cell: CellDraft) {
  return asCount(cell.early) + asCount(cell.day) + asCount(cell.mail);
}

function originLabel(origin: VoteDeskOrigin) {
  if (origin === "manual") return "Manual";
  if (origin === "county_feed") return "County site";
  if (origin === "sos") return "SOS";
  return "No numbers";
}

function historySourceLabel(sourceKey: string) {
  if (sourceKey.startsWith("manual:")) return "Manual";
  if (sourceKey.startsWith("county:")) return "County site";
  if (sourceKey === "sos") return "Statewide SOS";
  return sourceKey || "Update";
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatDelta(total: number, previous: number | null) {
  if (previous == null) return "—";
  const d = total - previous;
  if (d === 0) return "0";
  return `${d > 0 ? "+" : ""}${d.toLocaleString()}`;
}

export function CountyVoteDesk({
  electionId,
  usesCivixSos,
  busy,
  refreshToken,
  onMessage,
}: {
  electionId: string;
  usesCivixSos: boolean;
  busy: boolean;
  refreshToken: number;
  onMessage: (msg: string | null) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [desk, setDesk] = useState<VoteDeskPayload | null>(null);
  const [raceId, setRaceId] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Map<string, CountyDraft>>(new Map());
  const [loaded, setLoaded] = useState<Map<string, CountyDraft>>(new Map());
  const [alwaysManual, setAlwaysManual] = useState<Map<string, boolean>>(new Map());

  const load = useCallback(async () => {
    if (!usesCivixSos || !/^\d+$/.test(String(electionId))) return;
    setLoading(true);
    try {
      const next = await fetchVoteDesk(electionId, raceId || undefined);
      setDesk(next);
      const map = new Map<string, CountyDraft>();
      for (const county of next.counties) {
        const row: CountyDraft = {};
        for (const c of county.candidates) row[c.sosCandidateId] = cellFromNumbers(c);
        map.set(county.countyKey, row);
      }
      setDrafts(map);
      setLoaded(new Map(map));
      const flags = new Map<string, boolean>();
      for (const county of next.counties) flags.set(county.countyKey, county.voteSource === "manual");
      setAlwaysManual(flags);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Failed to load vote counts");
    } finally {
      setLoading(false);
    }
  }, [electionId, usesCivixSos, raceId, onMessage]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const race = desk?.race ?? null;
  const candidates = race?.candidates ?? [];

  const countyState = useMemo(() => {
    const byKey = new Map((desk?.counties ?? []).map((c) => [c.countyKey, c]));
    return TEXAS_COUNTIES.map((county) => {
      const hit = byKey.get(county.key);
      return {
        key: county.key,
        label: county.label,
        origin: (hit?.origin ?? "empty") as VoteDeskOrigin,
        linked: hit?.linked ?? false,
        voteSource: hit?.voteSource ?? "auto",
      };
    });
  }, [desk?.counties]);

  const counts = useMemo(() => {
    const out = { all: countyState.length, empty: 0, manual: 0, county_feed: 0, sos: 0 };
    for (const c of countyState) out[c.origin] += 1;
    return out;
  }, [countyState]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return countyState.filter((c) => {
      if (filter !== "all" && c.origin !== filter) return false;
      if (!q) return true;
      return c.label.toLowerCase().includes(q) || c.key.includes(q);
    });
  }, [countyState, filter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [filter, query, race?.id]);

  const racesSorted = useMemo(() => {
    return [...(desk?.races ?? [])].sort((a, b) => {
      const ag = isGovernorName(a.name) ? 0 : 1;
      const bg = isGovernorName(b.name) ? 0 : 1;
      if (ag !== bg) return ag - bg;
      const order = ["StateWide", "Federal", "Districted", "StateWideQ", ""];
      const oa = order.indexOf(a.section ?? "");
      const ob = order.indexOf(b.section ?? "");
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name, "en");
    });
  }, [desk?.races]);

  function draftFor(countyKey: string, candidateId: string): CellDraft {
    return drafts.get(countyKey)?.[candidateId] ?? loaded.get(countyKey)?.[candidateId] ?? zeroCell();
  }

  function countyDirty(countyKey: string) {
    const county = countyState.find((c) => c.key === countyKey);
    if ((alwaysManual.get(countyKey) === true) !== (county?.voteSource === "manual")) return true;
    for (const c of candidates) {
      const d = draftFor(countyKey, c.id);
      const base = loaded.get(countyKey)?.[c.id] ?? zeroCell();
      if (d.early !== base.early || d.day !== base.day || d.mail !== base.mail) return true;
    }
    return false;
  }

  const dirtyKeys = useMemo(() => {
    const keys: string[] = [];
    for (const county of countyState) {
      let dirty = (alwaysManual.get(county.key) === true) !== (county.voteSource === "manual");
      for (const c of candidates) {
        const d = drafts.get(county.key)?.[c.id] ?? loaded.get(county.key)?.[c.id] ?? zeroCell();
        const base = loaded.get(county.key)?.[c.id] ?? zeroCell();
        if (d.early !== base.early || d.day !== base.day || d.mail !== base.mail) dirty = true;
      }
      if (dirty) keys.push(county.key);
    }
    return keys;
  }, [countyState, drafts, loaded, candidates, alwaysManual]);

  function updateCell(countyKey: string, candidateId: string, field: keyof CellDraft, value: string) {
    setDrafts((prev) => {
      const next = new Map(prev);
      const row = { ...(next.get(countyKey) ?? {}) };
      row[candidateId] = { ...(row[candidateId] ?? draftFor(countyKey, candidateId)), [field]: value };
      next.set(countyKey, row);
      return next;
    });
  }

  async function saveCounties(keys: string[]) {
    if (!race || !keys.length) return;
    setSavingKey(keys.length === 1 ? keys[0] : "*");
    try {
      await saveVoteDeskManual(electionId, {
        sosRaceId: race.id,
        raceName: race.name,
        counties: keys.map((countyKey) => ({
          countyKey,
          forceManual: alwaysManual.get(countyKey) === true,
          candidates: candidates.map((c) => {
            const cell = draftFor(countyKey, c.id);
            return {
              sosCandidateId: c.id,
              choiceName: c.name,
              partyName: c.party,
              earlyVotes: asCount(cell.early),
              electionDayVotes: asCount(cell.day),
              mailVotes: asCount(cell.mail),
            };
          }),
        })),
      });
      onMessage(keys.length === 1 ? `Saved ${countyLabel(keys[0])}.` : `Saved ${keys.length} counties.`);
      await load();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingKey(null);
    }
  }

  async function useAuto(countyKey: string) {
    if (!race) return;
    setSavingKey(countyKey);
    try {
      await saveCountyRaceVoteSource(electionId, { countyKey, sosRaceId: race.id, voteSource: "auto" });
      setAlwaysManual((prev) => {
        const next = new Map(prev);
        next.set(countyKey, false);
        return next;
      });
      onMessage(`${countyLabel(countyKey)} is back on auto. Manual numbers apply only when they are higher than SOS and the county site.`);
      await load();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Could not switch to auto");
    } finally {
      setSavingKey(null);
    }
  }

  if (!usesCivixSos || !/^\d+$/.test(String(electionId))) {
    return (
      <section className="enr-panel enr-settings__section enr-voteDesk">
        <SettingsCollapse title="Vote counts">
          <p className="enr-muted">County vote entry is available for Civix / SOS elections.</p>
        </SettingsCollapse>
      </section>
    );
  }

  const selectedRaceId = raceId || race?.id || "";
  const rowBusy = (key: string) => busy || loading || savingKey === "*" || savingKey === key;

  return (
    <section className="enr-panel enr-settings__section enr-voteDesk">
      <SettingsCollapse title="Vote counts">
      <p className="enr-muted">
        Pick a race — <strong>Governor</strong> is first — and review every Texas county. Type{" "}
        <strong>Early</strong>, <strong>Election day</strong>, and <strong>Mail</strong> when a county’s SOS or county-site
        numbers are missing or behind. Saved manual totals replace the pulled numbers when they are higher. Check{" "}
        <strong>Always use</strong> to keep the manual numbers even when they are lower. Mail is counted with early voting
        on the tracker. The same entry is on the <strong>Manual votes</strong> tab.
      </p>

      <div className="enr-voteDesk__toolbar">
        <label className="enr-field">
          Race
          <select
            className="enr-input"
            value={selectedRaceId}
            disabled={busy || loading || !racesSorted.length}
            onChange={(e) => setRaceId(e.target.value)}
          >
            {racesSorted.map((r) => {
              const sec = r.section ? (SECTION_LABELS[r.section] ?? r.section) : "";
              const gov = isGovernorName(r.name) ? " · primary" : "";
              return (
                <option key={r.id} value={r.id}>
                  {sec ? `[${sec}] ` : ""}
                  {r.name}
                  {gov}
                </option>
              );
            })}
          </select>
        </label>
        <label className="enr-field">
          County
          <input
            className="enr-input"
            value={query}
            placeholder="Search counties"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className="enr-secondaryBtn" disabled={busy || loading} onClick={() => void load()}>
          {loading ? "Loading…" : "Reload"}
        </button>
        <button
          type="button"
          className="enr-primaryBtn"
          disabled={busy || loading || savingKey != null || dirtyKeys.length === 0}
          onClick={() => void saveCounties(dirtyKeys)}
        >
          {savingKey === "*" ? "Saving…" : `Save changes${dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}`}
        </button>
      </div>

      <div className="enr-voteDesk__filters" role="tablist" aria-label="County status">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? "enr-voteDesk__chip is-on" : "enr-voteDesk__chip"}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <span>{f.id === "all" ? counts.all : counts[f.id]}</span>
          </button>
        ))}
      </div>

      {!race && !loading ? <p className="enr-muted">No SOS races loaded for this election yet.</p> : null}
      {race && !candidates.length ? <p className="enr-muted">This race has no candidates on the SOS file.</p> : null}

      {race && candidates.length ? (
        <>
          <div className="enr-countyGridWrap enr-voteDesk__gridWrap">
            <table className="enr-countyGrid enr-manualCountyGrid enr-voteDesk__grid">
              <thead>
                <tr>
                  <th rowSpan={2}>County</th>
                  <th rowSpan={2}>Status</th>
                  <th rowSpan={2}>Actions</th>
                  {candidates.map((c) => (
                    <th key={c.id} colSpan={4} className="enr-candHead">
                      {c.name}
                      {c.party ? ` (${c.party})` : ""}
                    </th>
                  ))}
                </tr>
                <tr>
                  {candidates.map((c) => (
                    <Fragment key={`${c.id}-sub`}>
                      <th className="enr-subHead num">Early</th>
                      <th className="enr-subHead num">Election day</th>
                      <th className="enr-subHead num">Mail</th>
                      <th className="enr-subHead num">Total</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((county) => {
                  const locked = rowBusy(county.key);
                  const dirty = countyDirty(county.key);
                  return (
                    <tr key={county.key} className={dirty ? "enr-voteDesk__rowDirty" : undefined}>
                      <td className="enr-countyName">{county.label}</td>
                      <td>
                        <span className={`enr-voteDesk__badge enr-voteDesk__badge--${county.origin}`}>
                          {originLabel(county.origin)}
                        </span>
                        {county.origin === "county_feed" && !county.linked ? (
                          <span className="enr-voteDesk__unlinked">Not linked</span>
                        ) : null}
                      </td>
                      <td className="enr-manualCountyGrid__actions">
                        <label className="enr-voteDesk__always">
                          <input
                            type="checkbox"
                            checked={alwaysManual.get(county.key) === true}
                            disabled={locked}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setAlwaysManual((prev) => {
                                const next = new Map(prev);
                                next.set(county.key, checked);
                                return next;
                              });
                            }}
                          />
                          Always use
                        </label>
                        <button
                          type="button"
                          className="enr-miniBtn"
                          disabled={locked}
                          onClick={() => void saveCounties([county.key])}
                        >
                          {savingKey === county.key ? "Saving…" : "Save"}
                        </button>
                        {county.voteSource === "manual" || county.origin === "manual" ? (
                          <button
                            type="button"
                            className="enr-miniBtn"
                            disabled={locked}
                            onClick={() => void useAuto(county.key)}
                          >
                            Use auto
                          </button>
                        ) : null}
                      </td>
                      {candidates.map((c) => {
                        const cell = draftFor(county.key, c.id);
                        return (
                          <Fragment key={`${county.key}-${c.id}`}>
                            {(["early", "day", "mail"] as const).map((field) => (
                              <td key={field} className="num">
                                <input
                                  type="number"
                                  min={0}
                                  className="enr-manualCellInput"
                                  aria-label={`${county.label} ${c.name} ${field}`}
                                  value={cell[field]}
                                  disabled={locked}
                                  onChange={(e) => updateCell(county.key, c.id, field, e.target.value)}
                                />
                              </td>
                            ))}
                            <td className="num enr-voteDesk__total">{cellTotal(cell).toLocaleString()}</td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="enr-voteDesk__pager">
            <button
              type="button"
              className="enr-secondaryBtn"
              disabled={safePage <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span className="enr-muted">
              {filtered.length === 0
                ? "No counties match"
                : `${safePage * PAGE_SIZE + 1}–${Math.min(filtered.length, (safePage + 1) * PAGE_SIZE)} of ${filtered.length}`}
            </span>
            <button
              type="button"
              className="enr-secondaryBtn"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      ) : null}

      <SettingsCollapse title="Change history" badge={desk?.history.length ? `${desk.history.length} recent` : undefined}>
        <p className="enr-muted" style={{ fontSize: 13 }}>
          Each line is a change for this race: a county-site pull, a statewide SOS update, or a manual save. The change
          column is the difference in total votes from the previous snapshot for that same source, county, and candidate.
        </p>
        {(desk?.history.length ?? 0) === 0 ? (
          <p className="enr-muted">No recorded changes for this race yet.</p>
        ) : (
          <div className="enr-tableWrap enr-voteDesk__historyWrap">
            <table className="enr-table enr-table--compact">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th>County</th>
                  <th>Candidate</th>
                  <th className="num">Early</th>
                  <th className="num">Election day</th>
                  <th className="num">Mail</th>
                  <th className="num">Total</th>
                  <th className="num">Change</th>
                </tr>
              </thead>
              <tbody>
                {(desk?.history ?? []).map((h) => (
                  <tr key={h.id}>
                    <td>{formatWhen(h.capturedAt)}</td>
                    <td>{historySourceLabel(h.sourceKey)}</td>
                    <td>{h.countyKey ? countyLabel(h.countyKey) : "Statewide"}</td>
                    <td>
                      {h.choiceName}
                      {h.partyName ? ` (${h.partyName})` : ""}
                    </td>
                    <td className="num">{h.earlyVotes.toLocaleString()}</td>
                    <td className="num">{h.electionDayVotes.toLocaleString()}</td>
                    <td className="num">{h.mailVotes.toLocaleString()}</td>
                    <td className="num">{h.totalVotes.toLocaleString()}</td>
                    <td className="num">{formatDelta(h.totalVotes, h.previousTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCollapse>
      </SettingsCollapse>
    </section>
  );
}
