import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAppSettings,
  fetchVoteDesk,
  fetchVoteDeskCounty,
  saveVoteDeskManual,
  type VoteDeskCountyBoard,
  type VoteDeskPayload,
} from "../lib/dataBackend";
import { TEXAS_COUNTY_POPULATION } from "../data/texasCountyPopulation";
import { TEXAS_COUNTIES } from "../lib/texasCounties";
import {
  resolveVoteSource,
  sumVoteCells,
  type ManualVoteCell,
  type ManualVoteSource,
} from "../lib/manualVoteMath";
import { formatNumber } from "../lib/voteMath";

const SECTION_LABELS: Record<string, string> = {
  Federal: "Federal",
  StateWide: "Statewide",
  Districted: "District",
  StateWideQ: "Statewide props",
};

type DraftCell = { early: string; mail: string; day: string };
type CountyDraft = Record<string, DraftCell>;
type DeskCounty = VoteDeskPayload["counties"][number];
type BoardRace = VoteDeskCountyBoard["races"][number];
type ViewId = "race" | "county";
type CountySort = "name" | "population";
type RaceInfo = {
  id: string;
  name: string;
  section?: string;
  candidates: Array<{ id: string; name: string; party: string }>;
};

function isGovernorName(name: string) {
  const n = name.toLowerCase();
  return /\bgovernor\b/.test(n) && !n.includes("lieutenant");
}

function sectionPrefix(section: string | undefined) {
  if (!section) return "";
  return `[${SECTION_LABELS[section] ?? section}] `;
}

function raceOrder(a: { name: string; section?: string }, b: { name: string; section?: string }) {
  const ag = isGovernorName(a.name) ? 0 : 1;
  const bg = isGovernorName(b.name) ? 0 : 1;
  if (ag !== bg) return ag - bg;
  const order = ["StateWide", "Federal", "Districted", "StateWideQ", ""];
  const oa = order.indexOf(a.section ?? "");
  const ob = order.indexOf(b.section ?? "");
  if (oa !== ob) return oa - ob;
  return a.name.localeCompare(b.name, "en");
}

function asCount(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function emptyDraft(): DraftCell {
  return { early: "", mail: "", day: "" };
}

function draftFromStored(cell: ManualVoteCell | undefined): DraftCell {
  if (!cell) return emptyDraft();
  const text = (n: number) => (n > 0 ? String(n) : "");
  return { early: text(cell.earlyVotes), mail: text(cell.mailVotes), day: text(cell.electionDayVotes) };
}

function draftToCell(candidateId: string, draft: DraftCell | undefined): ManualVoteCell {
  const earlyVotes = asCount(draft?.early ?? "");
  const mailVotes = asCount(draft?.mail ?? "");
  const electionDayVotes = asCount(draft?.day ?? "");
  return {
    sosCandidateId: candidateId,
    earlyVotes,
    mailVotes,
    electionDayVotes,
    totalVotes: earlyVotes + mailVotes + electionDayVotes,
  };
}

function manualCellsFor(
  candidates: Array<{ id: string }>,
  row: CountyDraft | undefined,
  stored: ManualVoteCell[] | undefined,
): ManualVoteCell[] {
  return candidates.map((candidate) => {
    const drafted = draftToCell(candidate.id, row?.[candidate.id]);
    const saved = stored?.find((cell) => cell.sosCandidateId === candidate.id);
    if (
      saved &&
      drafted.earlyVotes === saved.earlyVotes &&
      drafted.mailVotes === saved.mailVotes &&
      drafted.electionDayVotes === saved.electionDayVotes
    ) {
      return saved;
    }
    return drafted;
  });
}

function chosenSource(county: DeskCounty | undefined, manualCells: ManualVoteCell[], forced: boolean) {
  const sos = sumVoteCells(county?.sos);
  const feed = sumVoteCells(county?.countyFeed);
  const manual = sumVoteCells(manualCells);
  const pinned = county?.voteSource === "sos" || county?.voteSource === "county_feed" ? county.voteSource : null;
  const configured = forced ? "manual" : (pinned ?? "auto");
  const source = resolveVoteSource(configured, feed, sos, manual, forced || manual > 0);
  return { source, sos, feed, manual };
}

function officialLabel(source: ManualVoteSource) {
  if (source === "sos") return "SOS";
  if (source === "county_feed") return "County pull";
  if (source === "manual") return "Manual";
  return "—";
}

function countyLabel(key: string) {
  return TEXAS_COUNTIES.find((county) => county.key === key)?.label ?? key;
}

function CandidateEntry({
  rowKey,
  title,
  candidates,
  draft,
  onCell,
}: {
  rowKey: string;
  title: string;
  candidates: Array<{ id: string; name: string; party: string }>;
  draft: CountyDraft | undefined;
  onCell: (key: string, candidateId: string, field: keyof DraftCell, value: string) => void;
}) {
  return (
    <table className="enr-table enr-manualVotes__inline">
      <thead>
        <tr>
          <th>Candidate</th>
          <th>Party</th>
          <th className="num">Early voting</th>
          <th className="num">Mail</th>
          <th className="num">Election day</th>
          <th className="num">Total</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((candidate) => {
          const cell = draft?.[candidate.id] ?? emptyDraft();
          const total = asCount(cell.early) + asCount(cell.mail) + asCount(cell.day);
          return (
            <tr key={candidate.id}>
              <td>{candidate.name}</td>
              <td>{candidate.party}</td>
              {(["early", "mail", "day"] as const).map((field) => (
                <td key={field} className="num">
                  <input
                    className="enr-manualVotes__input"
                    inputMode="numeric"
                    aria-label={`${title} ${candidate.name} ${field === "day" ? "election day" : field}`}
                    value={cell[field]}
                    onChange={(event) => onCell(rowKey, candidate.id, field, event.target.value)}
                  />
                </td>
              ))}
              <td className="num">{formatNumber(total)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function draftsFromManual(candidates: Array<{ id: string }>, stored: ManualVoteCell[] | undefined): CountyDraft {
  const row: CountyDraft = {};
  const byId = new Map((stored ?? []).map((cell) => [cell.sosCandidateId, cell]));
  for (const candidate of candidates) row[candidate.id] = draftFromStored(byId.get(candidate.id));
  return row;
}

function asDeskCounty(countyKey: string, race: BoardRace): DeskCounty {
  return {
    countyKey,
    voteSource: race.voteSource,
    origin: race.origin,
    linked: false,
    sos: race.sos,
    countyFeed: race.countyFeed,
    manual: race.manual,
    candidates: [],
  };
}

export function ManualVotesScreen({
  electionId,
  onVotesApplied,
}: {
  electionId: string;
  onVotesApplied: (electionId: string) => void;
}) {
  const [setupError, setSetupError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("race");
  const [governorOnly, setGovernorOnly] = useState(false);
  const [desk, setDesk] = useState<VoteDeskPayload | null>(null);
  const [board, setBoard] = useState<VoteDeskCountyBoard | null>(null);
  const [raceId, setRaceId] = useState("");
  const [selectedCounty, setSelectedCounty] = useState("harris");
  const [countySort, setCountySort] = useState<CountySort>("name");
  const [countyDir, setCountyDir] = useState<"asc" | "desc">("asc");
  const [drafts, setDrafts] = useState<Map<string, CountyDraft>>(new Map());
  const [forceManual, setForceManual] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(false);
  const [readyView, setReadyView] = useState<ViewId | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const draftsRef = useRef(drafts);
  const forceRef = useRef(forceManual);
  const deskRef = useRef(desk);
  const boardRef = useRef(board);
  const viewRef = useRef(view);
  const countyRef = useRef(selectedCounty);
  const electionRef = useRef(electionId);
  const appliedRef = useRef(onVotesApplied);
  const timerRef = useRef<number | null>(null);
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const skipRaceSyncRef = useRef(false);
  draftsRef.current = drafts;
  forceRef.current = forceManual;
  deskRef.current = desk;
  boardRef.current = board;
  viewRef.current = view;
  countyRef.current = selectedCounty;
  electionRef.current = electionId;
  appliedRef.current = onVotesApplied;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await fetchAppSettings();
        if (cancelled) return;
        setGovernorOnly(settings.manualVoteGovernorOnly === true);
      } catch (e) {
        if (!cancelled) setSetupError(e instanceof Error ? e.message : "Could not load settings");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view !== "race") return;
    if (skipRaceSyncRef.current) {
      skipRaceSyncRef.current = false;
      return;
    }
    if (!electionId || !/^\d+$/.test(electionId)) {
      setDesk(null);
      setReadyView("race");
      return;
    }
    let cancelled = false;
    setReadyView(null);
    setLoading(true);
    setLoadError(null);
    void fetchVoteDesk(electionId, raceId || undefined)
      .then((next) => {
        if (cancelled) return;
        setDesk(next);
        if (!raceId && next.race?.id) {
          skipRaceSyncRef.current = true;
          setRaceId(next.race.id);
        }
        const nextDrafts = new Map<string, CountyDraft>();
        const nextForce = new Map<string, boolean>();
        const candidates = next.race?.candidates ?? [];
        for (const county of next.counties) {
          nextDrafts.set(county.countyKey, draftsFromManual(candidates, county.manual));
          nextForce.set(county.countyKey, county.voteSource === "manual");
        }
        draftsRef.current = nextDrafts;
        forceRef.current = nextForce;
        setDrafts(nextDrafts);
        setForceManual(nextForce);
        setSaveState("idle");
        setReadyView("race");
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Could not load vote counts");
          setReadyView("race");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [electionId, raceId, view]);

  useEffect(() => {
    if (view !== "county") return;
    if (!electionId || !/^\d+$/.test(electionId)) {
      setBoard(null);
      setReadyView("county");
      return;
    }
    let cancelled = false;
    setReadyView(null);
    setLoading(true);
    setLoadError(null);
    void fetchVoteDeskCounty(electionId, selectedCounty)
      .then((next) => {
        if (cancelled) return;
        setBoard(next);
        const nextDrafts = new Map<string, CountyDraft>();
        const nextForce = new Map<string, boolean>();
        for (const race of next.races) {
          nextDrafts.set(race.id, draftsFromManual(race.candidates, race.manual));
          nextForce.set(race.id, race.voteSource === "manual");
        }
        draftsRef.current = nextDrafts;
        forceRef.current = nextForce;
        setDrafts(nextDrafts);
        setForceManual(nextForce);
        setSaveState("idle");
        setReadyView("county");
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Could not load vote counts");
          setReadyView("county");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [electionId, selectedCounty, view]);

  async function persistKey(key: string) {
    const currentElection = electionRef.current;
    if (!currentElection) return;
    const race: RaceInfo | null | undefined =
      viewRef.current === "race" ? deskRef.current?.race : boardRef.current?.races.find((item) => item.id === key);
    const county = viewRef.current === "race" ? key : countyRef.current;
    if (!race || !county) return;
    const row = draftsRef.current.get(key) ?? {};
    await saveVoteDeskManual(currentElection, {
      sosRaceId: race.id,
      raceName: race.name,
      counties: [
        {
          countyKey: county,
          forceManual: forceRef.current.get(key) === true,
          candidates: race.candidates.map((candidate) => {
            const cell = draftToCell(candidate.id, row[candidate.id]);
            return {
              sosCandidateId: candidate.id,
              choiceName: candidate.name,
              partyName: candidate.party,
              earlyVotes: cell.earlyVotes,
              electionDayVotes: cell.electionDayVotes,
              mailVotes: cell.mailVotes,
            };
          }),
        },
      ],
    });
    appliedRef.current(currentElection);
  }

  async function flushDirty(): Promise<boolean> {
    const keys = [...dirtyKeysRef.current];
    if (!keys.length) return true;
    dirtyKeysRef.current = new Set();
    setSaveState("saving");
    setSaveError(null);
    try {
      for (const key of keys) await persistKey(key);
      setSaveState("saved");
      return true;
    } catch (e) {
      for (const key of keys) dirtyKeysRef.current.add(key);
      setSaveState("error");
      setSaveError(e instanceof Error ? e.message : "Save failed");
      return false;
    }
  }

  function scheduleSave(key: string) {
    dirtyKeysRef.current.add(key);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushDirty();
    }, 300);
  }

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      const keys = [...dirtyKeysRef.current];
      dirtyKeysRef.current = new Set();
      for (const key of keys) void persistKey(key);
    };
  }, []);

  const racesSorted = useMemo(() => {
    const races = [...(desk?.races ?? [])].sort(raceOrder);
    return governorOnly ? races.filter((race) => isGovernorName(race.name)) : races;
  }, [desk?.races, governorOnly]);
  const boardRaces = useMemo(() => {
    const races = [...(board?.races ?? [])].sort(raceOrder);
    return governorOnly ? races.filter((race) => isGovernorName(race.name)) : races;
  }, [board?.races, governorOnly]);
  const candidates = desk?.race?.candidates ?? [];
  const countyByKey = useMemo(() => new Map((desk?.counties ?? []).map((county) => [county.countyKey, county])), [desk?.counties]);

  const countyRows = useMemo(() => {
    const sign = countyDir === "desc" ? -1 : 1;
    return TEXAS_COUNTIES.map((county) => ({
      key: county.key,
      label: county.label,
      population: TEXAS_COUNTY_POPULATION[county.key] ?? 0,
      county: countyByKey.get(county.key),
    })).sort((a, b) => {
      if (countySort === "population") {
        if (a.population !== b.population) return (a.population - b.population) * sign;
        return a.label.localeCompare(b.label, "en");
      }
      return a.label.localeCompare(b.label, "en") * sign;
    });
  }, [countyByKey, countyDir, countySort]);

  useEffect(() => {
    if (!governorOnly || !desk?.races?.length) return;
    const governor = desk.races.find((race) => isGovernorName(race.name));
    if (!governor) return;
    if ((raceId || desk.race?.id) === governor.id) return;
    setRaceId(governor.id);
  }, [governorOnly, desk, raceId]);

  function updateCell(key: string, candidateId: string, field: keyof DraftCell, value: string) {
    const cleaned = value.replace(/[^\d]/g, "");
    const next = new Map(draftsRef.current);
    const row = { ...(next.get(key) ?? {}) };
    row[candidateId] = { ...(row[candidateId] ?? emptyDraft()), [field]: cleaned };
    next.set(key, row);
    draftsRef.current = next;
    setDrafts(next);
    setSaveState("idle");
    scheduleSave(key);
  }

  function updateForce(key: string, checked: boolean) {
    const next = new Map(forceRef.current);
    next.set(key, checked);
    forceRef.current = next;
    setForceManual(next);
    setSaveState("idle");
    scheduleSave(key);
  }

  function toggleCountySort(next: CountySort) {
    if (countySort === next) {
      setCountyDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setCountySort(next);
    setCountyDir(next === "population" ? "desc" : "asc");
  }

  function sortMark(key: CountySort) {
    if (countySort !== key) return "";
    return countyDir === "asc" ? " ↑" : " ↓";
  }

  function afterSave(action: () => void) {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    void flushDirty().then((ok) => {
      if (!ok) return;
      action();
    });
  }

  if (setupError) {
    return (
      <div className="enr-panel enr-error">
        <div className="enr-error__title">Could not open manual votes</div>
        <div className="enr-error__body">{setupError}</div>
      </div>
    );
  }

  if (!electionId) {
    return (
      <div className="enr-panel">
        <h2 className="enr-manualVotes__title">Manual votes</h2>
        <p>Choose an SOS election in the menu at the top of the page.</p>
      </div>
    );
  }

  return (
    <div className="enr-manualVotes">
      <div className="enr-manualVotes__head">
        <h2 className="enr-manualVotes__title">Manual votes</h2>
        <div className="enr-manualVotes__saveState" aria-live="polite">
          {saveState === "saving" ? "Saving…" : null}
          {saveState === "saved" ? "Saved" : null}
          {saveState === "error" ? saveError || "Save failed" : null}
        </div>
      </div>

      <div className="enr-manualVotes__toolbar">
        <div className="enr-manualVotes__tabs">
          <button
            type="button"
            className={view === "race" ? "enr-btn enr-btn--primary" : "enr-btn enr-btn--ghost"}
            onClick={() => afterSave(() => setView("race"))}
          >
            Race
          </button>
          <button
            type="button"
            className={view === "county" ? "enr-btn enr-btn--primary" : "enr-btn enr-btn--ghost"}
            onClick={() => afterSave(() => setView("county"))}
          >
            County
          </button>
        </div>
        {view === "race" && !governorOnly ? (
          <label className="enr-field">
            Race
            <select
              className="enr-input"
              value={raceId || desk?.race?.id || ""}
              disabled={loading || !racesSorted.length}
              onChange={(event) => {
                const next = event.target.value;
                afterSave(() => setRaceId(next));
              }}
            >
              {racesSorted.map((race) => (
                <option key={race.id} value={race.id}>
                  {sectionPrefix(race.section)}
                  {race.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {view === "race" && governorOnly && desk?.race && isGovernorName(desk.race.name) ? (
          <p className="enr-muted enr-manualVotes__election">{desk.race.name}</p>
        ) : null}
        {view === "county" ? (
          <label className="enr-field">
            County
            <select
              className="enr-input"
              value={selectedCounty}
              onChange={(event) => {
                const next = event.target.value;
                afterSave(() => setSelectedCounty(next));
              }}
            >
              {TEXAS_COUNTIES.map((county) => (
                <option key={county.key} value={county.key}>
                  {county.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {loadError ? <p className="enr-errorInline">{loadError}</p> : null}
      {readyView !== view && !loadError ? (
        <div className="enr-panel">{view === "race" ? "Loading counties…" : "Loading races…"}</div>
      ) : null}
      {view === "race" && readyView === "race" && desk && !desk.race ? (
        <div className="enr-panel">No SOS races are loaded for this election yet.</div>
      ) : null}
      {governorOnly && readyView === view && ((view === "race" && desk && !racesSorted.length) || (view === "county" && board && !boardRaces.length)) ? (
        <div className="enr-panel">This election has no Governor race.</div>
      ) : null}

      {view === "race" && readyView === "race" && desk?.race && (!governorOnly || isGovernorName(desk.race.name)) ? (
        <div className="enr-tablewrap">
          <table className="enr-table enr-manualVotes__board">
            <thead>
              <tr>
                <th aria-sort={countySort === "name" ? (countyDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="enr-ballot__sort" onClick={() => toggleCountySort("name")}>
                    County{sortMark("name")}
                  </button>
                </th>
                <th className="num" aria-sort={countySort === "population" ? (countyDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="enr-ballot__sort" onClick={() => toggleCountySort("population")}>
                    Population{sortMark("population")}
                  </button>
                </th>
                <th className="num">SOS</th>
                <th className="num">County pull</th>
                <th className="num">Manual</th>
                <th>Official</th>
                <th>Always</th>
              </tr>
            </thead>
            <tbody>
              {countyRows.map((row) => {
                const choice = chosenSource(
                  row.county,
                  manualCellsFor(candidates, drafts.get(row.key), row.county?.manual),
                  forceManual.get(row.key) === true,
                );
                return (
                  <Fragment key={row.key}>
                    <tr>
                      <td>{row.label}</td>
                      <td className="num">{formatNumber(row.population)}</td>
                      <td className={choice.source === "sos" ? "num enr-manualVotes__used" : "num"}>{formatNumber(choice.sos)}</td>
                      <td className={choice.source === "county_feed" ? "num enr-manualVotes__used" : "num"}>
                        {formatNumber(choice.feed)}
                      </td>
                      <td className={choice.source === "manual" ? "num enr-manualVotes__used" : "num"}>{formatNumber(choice.manual)}</td>
                      <td>
                        <span className={`enr-manualVotes__badge enr-manualVotes__badge--${choice.source}`}>{officialLabel(choice.source)}</span>
                      </td>
                      <td>
                        <label className="enr-manualVotes__force">
                          <input
                            type="checkbox"
                            checked={forceManual.get(row.key) === true}
                            aria-label={`Always use manual numbers for ${row.label}`}
                            onChange={(event) => updateForce(row.key, event.target.checked)}
                          />
                        </label>
                      </td>
                    </tr>
                    <tr className="enr-manualVotes__candidates">
                      <td colSpan={7}>
                        <CandidateEntry
                          rowKey={row.key}
                          title={row.label}
                          candidates={candidates}
                          draft={drafts.get(row.key)}
                          onCell={updateCell}
                        />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {view === "county" && readyView === "county" && board ? (
        <div className="enr-tablewrap">
          <table className="enr-table enr-manualVotes__board">
            <thead>
              <tr>
                <th>Race</th>
                <th className="num">SOS</th>
                <th className="num">County pull</th>
                <th className="num">Manual</th>
                <th>Official</th>
                <th>Always</th>
              </tr>
            </thead>
            <tbody>
              {boardRaces.length ? (
                boardRaces.map((race) => {
                  const choice = chosenSource(
                    asDeskCounty(selectedCounty, race),
                    manualCellsFor(race.candidates, drafts.get(race.id), race.manual),
                    forceManual.get(race.id) === true,
                  );
                  const raceTitle = `${countyLabel(selectedCounty)} ${race.name}`;
                  return (
                    <Fragment key={race.id}>
                      <tr>
                        <td>
                          {sectionPrefix(race.section)}
                          {race.name}
                        </td>
                        <td className={choice.source === "sos" ? "num enr-manualVotes__used" : "num"}>{formatNumber(choice.sos)}</td>
                        <td className={choice.source === "county_feed" ? "num enr-manualVotes__used" : "num"}>
                          {formatNumber(choice.feed)}
                        </td>
                        <td className={choice.source === "manual" ? "num enr-manualVotes__used" : "num"}>{formatNumber(choice.manual)}</td>
                        <td>
                          <span className={`enr-manualVotes__badge enr-manualVotes__badge--${choice.source}`}>{officialLabel(choice.source)}</span>
                        </td>
                        <td>
                          <label className="enr-manualVotes__force">
                            <input
                              type="checkbox"
                              checked={forceManual.get(race.id) === true}
                              aria-label={`Always use manual numbers for ${raceTitle}`}
                              onChange={(event) => updateForce(race.id, event.target.checked)}
                            />
                          </label>
                        </td>
                      </tr>
                      <tr className="enr-manualVotes__candidates">
                        <td colSpan={6}>
                          <CandidateEntry
                            rowKey={race.id}
                            title={raceTitle}
                            candidates={race.candidates}
                            draft={drafts.get(race.id)}
                            onCell={updateCell}
                          />
                        </td>
                      </tr>
                    </Fragment>
                  );
                })
              ) : governorOnly ? null : (
                <tr>
                  <td colSpan={6}>No SOS races are loaded for this election yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
