import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { loadCivixElectionBundle } from "./lib/civix/loadElection";
import {
  fetchCatalogFromBackend,
  fetchAppSettings,
  fetchElectionFavoriteRaces,
  fetchElectionSourceConfigs,
  fetchIngestStatus,
  loadElectionFromBackend,
  probeBackend,
  saveElectionFavoriteRaces,
  type ElectionOption,
  type ElectionFavoriteRace,
  type ElectionSourceConfig,
  type IngestStatus,
} from "./lib/dataBackend";
import type { LoadedElection, OfficeType, RaceInput } from "./types/election";
import { reportingSnapshotForRace } from "./lib/reportingFromRace";
import { ReportingRibbon } from "./components/ReportingRibbon";
import { RaceSummary } from "./components/RaceSummary";
import { CountyBreakdown } from "./components/CountyBreakdown";
import { SettingsScreen } from "./components/SettingsScreen";
import { APP_VERSION } from "./lib/appVersion";
import { EV_ROSTER_ENABLED } from "./lib/featureFlags";
import { EvRosterScreen } from "./components/EvRosterScreen";

const OFFICE_ORDER: OfficeType[] = [
  "FEDERAL OFFICES",
  "STATEWIDE OFFICES",
  "DISTRICT OFFICES",
  "STATEWIDE PROPOSITIONS",
];
const FAVORITES_TAB = "FAVORITES" as const;
type DashboardTab = typeof FAVORITES_TAB | OfficeType;

function officeTypesForElection(election: LoadedElection | undefined): OfficeType[] {
  if (!election) return [];
  const set = new Set(election.file.races.map((r) => r.officeType));
  const ordered = OFFICE_ORDER.filter((t) => set.has(t));
  const extras = [...set].filter((t) => !OFFICE_ORDER.includes(t)).sort();
  return [...ordered, ...extras];
}

function favoriteRacesForElection(
  election: LoadedElection | undefined,
  favorites: ElectionFavoriteRace[],
): RaceInput[] {
  if (!election) return [];
  const byId = new Map(election.file.races.map((race) => [race.id, race]));
  return favorites
    .map((favorite) => byId.get(favorite.raceId) ?? null)
    .filter((race): race is RaceInput => race != null);
}

function racesForTab(
  election: LoadedElection | undefined,
  tab: DashboardTab | null,
  favorites: ElectionFavoriteRace[],
): RaceInput[] {
  if (!election || !tab) return [];
  if (tab === FAVORITES_TAB) return favoriteRacesForElection(election, favorites);
  return election.file.races.filter((r) => r.officeType === tab);
}

/** Numeric Civix election id when catalog entry uses SOS (civix:… or election:… with numeric id). */
function civixElectionIdFromCatalog(catalogId: string | null): string | null {
  if (!catalogId) return null;
  if (catalogId.startsWith("civix:")) return catalogId.slice(6).trim() || null;
  if (catalogId.startsWith("election:")) {
    const key = catalogId.slice(9).trim();
    return /^\d+$/.test(key) ? key : null;
  }
  return null;
}

export function App() {
  const [screen, setScreen] = useState<"dashboard" | "settings" | "ev-roster">("dashboard");
  const [useBackend, setUseBackend] = useState<boolean | null>(null);
  const [catalogRefresh, setCatalogRefresh] = useState(0);

  const [electionOptions, setElectionOptions] = useState<ElectionOption[]>([]);
  const [current, setCurrent] = useState<LoadedElection | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedElectionId, setSelectedElectionId] = useState<string | null>(null);
  const [officeTab, setOfficeTab] = useState<DashboardTab | null>(null);
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);
  const [view, setView] = useState<"race" | "county">("race");
  const [ingestStatus, setIngestStatus] = useState<IngestStatus | null>(null);
  const [displayTimeZone, setDisplayTimeZone] = useState("America/Chicago");
  const [electionSourceConfigs, setElectionSourceConfigs] = useState<ElectionSourceConfig[]>([]);
  const [favoriteRaces, setFavoriteRaces] = useState<ElectionFavoriteRace[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoritesError, setFavoritesError] = useState<string | null>(null);
  /** Last ingest completion time we have merged into `current` (avoids duplicate fetches + establishes baseline). */
  const lastMergedIngestEndRef = useRef<number | null>(null);

  const bumpCatalog = useCallback(() => setCatalogRefresh((n) => n + 1), []);

  useEffect(() => {
    if (!EV_ROSTER_ENABLED && screen === "ev-roster") setScreen("dashboard");
  }, [screen]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setListLoading(true);
      setLoadError(null);
      try {
        const backendOk = await probeBackend();
        if (cancelled) return;
        setUseBackend(backendOk);

        if (!backendOk) {
          setElectionOptions([]);
          setSelectedElectionId(null);
          setLoadError(
            import.meta.env.DEV
              ? "Local election API is not reachable. From the project folder run npm run server (wait for “Database ready”), then npm run dev -- --mode proxy — or run npm run dev:all once. Hard-refresh this page."
              : "Election API is not reachable. Check that /api/health works on this site (static rewrites to your API service) and DATABASE_URL is set on the API.",
          );
          return;
        }

        let options: ElectionOption[];
        let defaultCatalogId: string | null = null;
        const catalog = await fetchCatalogFromBackend();
        options = catalog.options;
        defaultCatalogId = catalog.defaultCatalogId;
        if (cancelled) return;
        setElectionOptions(options);
        const preferred =
          (defaultCatalogId && options.find((o) => o.catalogId === defaultCatalogId)) ??
          options.find((o) => o.provider === "civix") ??
          options[0];
        if (preferred) setSelectedElectionId(preferred.catalogId);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load election list");
        setElectionOptions([]);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogRefresh]);

  useEffect(() => {
    if (useBackend === null) return;
    if (!selectedElectionId) {
      setCurrent(null);
      return;
    }
    const option = electionOptions.find((o) => o.catalogId === selectedElectionId);
    if (!option) {
      setCurrent(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      setCurrent(null);
      setLoadError(null);
      try {
        let bundle: LoadedElection;
        if (useBackend) {
          bundle = await loadElectionFromBackend(option.catalogId, option.catalogLabel);
        } else {
          if (import.meta.env.DEV) {
            throw new Error("Election details require the local /api routes. Run npm run dev and ensure /api/health works.");
          }
          if (option.provider !== "civix" || option.civixElectionId == null) {
            throw new Error("Start the local API (npm run dev) for manual elections, or use a Civix-only catalog.");
          }
          bundle = await loadCivixElectionBundle({
            civixElectionId: option.civixElectionId,
            catalogId: option.catalogId,
            catalogLabel: option.catalogLabel,
          });
        }
        if (cancelled) return;
        setCurrent(bundle);
      } catch (e) {
        if (cancelled) return;
        setCurrent(null);
        setLoadError(e instanceof Error ? e.message : "Failed to load election results");
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedElectionId, electionOptions, useBackend]);

  const tabs = useMemo<DashboardTab[]>(() => [FAVORITES_TAB, ...officeTypesForElection(current ?? undefined)], [current]);

  useEffect(() => {
    if (!current) return;
    const nextTabs: DashboardTab[] = [FAVORITES_TAB, ...officeTypesForElection(current)];
    if (!officeTab || !nextTabs.includes(officeTab)) {
      setOfficeTab(nextTabs[0] ?? null);
    }
  }, [current, officeTab]);

  const tabRaces = useMemo(
    () => racesForTab(current ?? undefined, officeTab, favoriteRaces),
    [current, officeTab, favoriteRaces],
  );
  const showingFavorites = officeTab === FAVORITES_TAB;

  useEffect(() => {
    if (!tabRaces.length) {
      setSelectedRaceId(null);
      return;
    }
    if (!selectedRaceId || !tabRaces.some((r) => r.id === selectedRaceId)) {
      setSelectedRaceId(tabRaces[0]!.id);
    }
  }, [tabRaces, selectedRaceId]);

  const selectedRace = useMemo(() => {
    if (!selectedRaceId) return null;
    return tabRaces.find((race) => race.id === selectedRaceId) ?? null;
  }, [tabRaces, selectedRaceId]);

  useEffect(() => {
    if (useBackend !== true) {
      setElectionSourceConfigs([]);
      return;
    }
    let cancelled = false;
    void fetchElectionSourceConfigs()
      .then((payload) => {
        if (!cancelled) setElectionSourceConfigs(payload.elections ?? []);
      })
      .catch(() => {
        if (!cancelled) setElectionSourceConfigs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [useBackend, catalogRefresh]);

  useEffect(() => {
    if (useBackend !== true || !selectedElectionId) {
      setFavoriteRaces([]);
      setFavoritesLoading(false);
      setFavoritesError(null);
      return;
    }
    let cancelled = false;
    setFavoritesLoading(true);
    setFavoritesError(null);
    void fetchElectionFavoriteRaces(selectedElectionId)
      .then((payload) => {
        if (!cancelled) setFavoriteRaces(payload.favorites ?? []);
      })
      .catch((error) => {
        if (!cancelled) {
          setFavoriteRaces([]);
          setFavoritesError(error instanceof Error ? error.message : "Failed to load favorites");
        }
      })
      .finally(() => {
        if (!cancelled) setFavoritesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedElectionId, useBackend]);

  const favoriteRaceIds = useMemo(() => new Set(favoriteRaces.map((favorite) => favorite.raceId)), [favoriteRaces]);
  const favoriteIndexByRaceId = useMemo(
    () => new Map(favoriteRaces.map((favorite, index) => [favorite.raceId, index])),
    [favoriteRaces],
  );
  const selectedElectionConfig = useMemo(() => {
    const electionId = current?.file.election.id;
    if (!electionId) return null;
    return electionSourceConfigs.find((cfg) => cfg.electionId === electionId) ?? null;
  }, [current?.file.election.id, electionSourceConfigs]);

  const trackedCivixElectionId = useMemo(
    () => civixElectionIdFromCatalog(selectedElectionId),
    [selectedElectionId],
  );

  useEffect(() => {
    if (useBackend !== true) {
      setIngestStatus(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      void fetchIngestStatus(trackedCivixElectionId ?? undefined)
        .then((s) => {
          if (!cancelled) setIngestStatus(s);
        })
        .catch(() => {
          if (!cancelled) setIngestStatus(null);
        });
    };
    poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [useBackend, trackedCivixElectionId]);

  useEffect(() => {
    if (useBackend !== true) {
      setDisplayTimeZone("America/Chicago");
      return;
    }
    let cancelled = false;
    const loadSettings = () => {
      void fetchAppSettings()
        .then((s) => {
          if (!cancelled) setDisplayTimeZone(s.displayTimeZone || "America/Chicago");
        })
        .catch(() => {
          if (!cancelled) setDisplayTimeZone("America/Chicago");
        });
    };
    loadSettings();
    const id = window.setInterval(loadSettings, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [useBackend, screen]);

  /** After server auto/manual ingest finishes, refresh election JSON in place (no full blank + no hard reload). */
  useEffect(() => {
    if (screen !== "dashboard") return;
    if (useBackend !== true) return;
    const t = ingestStatus?.lastRunEndTime;
    if (t == null || ingestStatus?.running) return;

    const option = electionOptions.find((o) => o.catalogId === selectedElectionId);
    if (!option || !selectedElectionId) return;

    if (lastMergedIngestEndRef.current === null) {
      if (current == null) {
        lastMergedIngestEndRef.current = t;
        return;
      }
      lastMergedIngestEndRef.current = t;
      let cancelled = false;
      void (async () => {
        try {
          const bundle = await loadElectionFromBackend(option.catalogId, option.catalogLabel);
          if (!cancelled) setCurrent(bundle);
        } catch {
          /* keep previous results visible */
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    if (t <= lastMergedIngestEndRef.current) return;

    let cancelled = false;
    void (async () => {
      try {
        const bundle = await loadElectionFromBackend(option.catalogId, option.catalogLabel);
        if (!cancelled) setCurrent(bundle);
      } catch {
        /* keep previous results visible */
      } finally {
        if (!cancelled) lastMergedIngestEndRef.current = t;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    screen,
    useBackend,
    current,
    ingestStatus?.lastRunEndTime,
    ingestStatus?.running,
    selectedElectionId,
    electionOptions,
  ]);

  /**
   * Keep UI in sync with direct DB edits (outside ingest cycle) without hard refresh.
   * Polls current election payload and updates numbers in place.
   */
  useEffect(() => {
    if (screen !== "dashboard") return;
    if (useBackend !== true) return;
    if (!selectedElectionId) return;
    const option = electionOptions.find((o) => o.catalogId === selectedElectionId);
    if (!option) return;

    let cancelled = false;
    let inFlight = false;
    const refreshLive = () => {
      if (inFlight || detailLoading || ingestStatus?.running) return;
      inFlight = true;
      void loadElectionFromBackend(option.catalogId, option.catalogLabel)
        .then((bundle) => {
          if (!cancelled) setCurrent(bundle);
        })
        .catch(() => {
          /* keep existing UI visible when background poll fails */
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const id = window.setInterval(refreshLive, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [screen, useBackend, selectedElectionId, electionOptions, detailLoading, ingestStatus?.running]);

  const ribbonReporting = useMemo(() => {
    if (!current?.file.reporting) return null;
    return reportingSnapshotForRace(current.file.reporting, selectedRace ?? null);
  }, [current?.file.reporting, selectedRace]);

  const ribbonAppRefreshedAtMs = useMemo(() => {
    const fromElection =
      trackedCivixElectionId && ingestStatus?.lastRunEndByElection?.[trackedCivixElectionId];
    const fromStatus =
      ingestStatus?.electionLastRunEndTime ?? ingestStatus?.lastRunEndTime ?? null;
    const fromFile = current?.file.reporting.appRefreshedAt
      ? Date.parse(current.file.reporting.appRefreshedAt)
      : null;
    const candidates = [fromElection, fromStatus, fromFile].filter(
      (t): t is number => t != null && Number.isFinite(t),
    );
    return candidates.length ? Math.max(...candidates) : null;
  }, [trackedCivixElectionId, ingestStatus, current?.file.reporting.appRefreshedAt]);

  async function persistFavoriteRaces(nextFavorites: ElectionFavoriteRace[]) {
    if (useBackend !== true || !selectedElectionId) return;
    const normalized = nextFavorites.map((favorite, index) => ({
      electionId: selectedElectionId,
      raceId: favorite.raceId,
      officeType: favorite.officeType,
      raceTitle: favorite.raceTitle,
      sortOrder: index,
      updatedAt: favorite.updatedAt,
    }));
    const previous = favoriteRaces;
    setFavoriteRaces(normalized);
    setFavoritesError(null);
    try {
      const saved = await saveElectionFavoriteRaces(
        selectedElectionId,
        normalized.map((favorite) => ({
          raceId: favorite.raceId,
          officeType: favorite.officeType,
          raceTitle: favorite.raceTitle,
          sortOrder: favorite.sortOrder,
        })),
      );
      setFavoriteRaces(saved.favorites ?? []);
    } catch (error) {
      setFavoriteRaces(previous);
      setFavoritesError(error instanceof Error ? error.message : "Failed to save favorites");
    }
  }

  async function toggleFavoriteRace(race: RaceInput) {
    const existingIndex = favoriteRaces.findIndex((favorite) => favorite.raceId === race.id);
    const nextFavorites =
      existingIndex >= 0
        ? favoriteRaces.filter((favorite) => favorite.raceId !== race.id)
        : [
            ...favoriteRaces,
            {
              electionId: selectedElectionId ?? "",
              raceId: race.id,
              officeType: race.officeType,
              raceTitle: race.title,
              sortOrder: favoriteRaces.length,
            },
          ];
    await persistFavoriteRaces(nextFavorites);
  }

  async function moveFavoriteRace(raceId: string, direction: "up" | "down") {
    const index = favoriteRaces.findIndex((favorite) => favorite.raceId === raceId);
    if (index < 0) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= favoriteRaces.length) return;
    const nextFavorites = [...favoriteRaces];
    const [item] = nextFavorites.splice(index, 1);
    nextFavorites.splice(targetIndex, 0, item);
    await persistFavoriteRaces(nextFavorites);
  }

  function onChangeOfficeTab(tab: DashboardTab) {
    setOfficeTab(tab);
    const races = racesForTab(current ?? undefined, tab, favoriteRaces);
    setSelectedRaceId(races[0]?.id ?? null);
    setView("race");
  }

  const backendLabel = useBackend === null ? "…" : useBackend ? "API + Civix merge" : "Browser only (Civix)";

  if (screen === "ev-roster" && EV_ROSTER_ENABLED) {
    return (
      <div className="enr-app">
        <EvRosterScreen onBack={() => setScreen("dashboard")} />
      </div>
    );
  }

  if (screen === "settings") {
    return (
      <div className="enr-app">
        <SettingsScreen
          onBack={() => setScreen("dashboard")}
          onCatalogChanged={bumpCatalog}
          backendLabel={backendLabel}
        />
        <footer className="enr-footer">
          <div>
            With <code>npm run dev</code>, the election API is served in-process on the same port as Vite (<code>/api/*</code>
            ). Use <code>npm run dev:all</code> if you want the API on port 3847 separately (e.g. for integration tests).
          </div>
        </footer>
      </div>
    );
  }

  return (
    <div className="enr-app">
      <header className="enr-top">
        <div className="enr-top__row">
          <div className="enr-brand">Texas election night tracker</div>
          <div className="enr-top__center">
            {current?.file.reporting.resultStatus ? (
              <span className="enr-official">{current.file.reporting.resultStatus}</span>
            ) : (
              <span className="enr-official enr-official--muted">Unofficial results</span>
            )}
          </div>
          <div className="enr-top__right">
            {/* intentionally blank on home per UI request */}
          </div>
        </div>
      </header>

      <nav className="enr-nav">
        <div className="enr-nav__left">
          <button type="button" className="enr-navlink is-active" onClick={() => setView("race")}>
            Home
          </button>
          {EV_ROSTER_ENABLED ? (
            <button type="button" className="enr-navlink" onClick={() => setScreen("ev-roster")}>
              Early voting rosters
            </button>
          ) : null}
          <button type="button" className="enr-navlink" onClick={() => setScreen("settings")}>
            Settings
          </button>
        </div>
        <div className="enr-nav__right">
          {electionOptions.length > 0 ? (
            <div className="enr-navElectionBlock">
              <label className="enr-navElectionRow">
                <span className="enr-navElectionLabel">Election</span>
                <select
                  className="enr-navElectionSelect"
                  value={selectedElectionId ?? ""}
                  onChange={(e) => setSelectedElectionId(e.target.value || null)}
                  disabled={listLoading}
                  aria-label="Select election"
                >
                  {electionOptions.map((o) => (
                    <option key={o.catalogId} value={o.catalogId}>
                      {o.catalogLabel}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      </nav>

      {current && ribbonReporting ? (
        <ReportingRibbon
          reporting={ribbonReporting}
          nextRunAt={ingestStatus?.nextRunAt ?? null}
          autoRefreshEnabled={!!ingestStatus?.autoRefreshEnabled}
          ingestRunning={!!ingestStatus?.running}
          displayTimeZone={displayTimeZone}
          appRefreshedAtMs={ribbonAppRefreshedAtMs}
        />
      ) : null}

      <main className="enr-main">
        {listLoading ? (
          <div className="enr-panel">
            Loading election list… {useBackend === null ? "(checking /api)" : useBackend ? "(Civix + manual catalog)" : "(Civix direct)"}
          </div>
        ) : null}
        {!listLoading && detailLoading ? <div className="enr-panel">Loading results for the selected election…</div> : null}
        {!listLoading && loadError ? (
          <div className="enr-panel enr-error">
            <div className="enr-error__title">Could not load data</div>
            <div className="enr-error__body">{loadError}</div>
            {useBackend === false && import.meta.env.DEV ? (
              <p className="enr-footnote">
                The dev server should expose <code>/api/health</code> automatically. Restart with <code>npm run dev</code> and
                watch the terminal for startup errors.
              </p>
            ) : null}
          </div>
        ) : null}
        {!listLoading && !loadError && !electionOptions.length ? (
          <div className="enr-panel">No elections are available from the current catalog.</div>
        ) : null}

        {!listLoading && !detailLoading && !loadError && current ? (
          <>
            {!showingFavorites ? (
              <div className="enr-controls">
                <label className="enr-selectLabel">
                  Race
                  <select
                    className="enr-select"
                    value={selectedRaceId ?? ""}
                    onChange={(e) => {
                      setSelectedRaceId(e.target.value);
                      setView("race");
                    }}
                    disabled={!tabRaces.length}
                  >
                    {!tabRaces.length ? <option value="">No races in this category</option> : null}
                    {tabRaces.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : tabRaces.length ? (
              <div className="enr-favoritesSummary">
                Showing {tabRaces.length} favorite race{tabRaces.length === 1 ? "" : "s"} on one page.
              </div>
            ) : null}

            {favoritesError ? <p className="enr-footnote">{favoritesError}</p> : null}

            <div className="enr-officeTabs" role="tablist" aria-label="Office categories">
              {tabs.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={t === officeTab}
                  className={`enr-tab ${t === officeTab ? "is-active" : ""}`}
                  onClick={() => onChangeOfficeTab(t)}
                >
                  {t === FAVORITES_TAB ? "FAVORITES" : t}
                </button>
              ))}
            </div>

            {showingFavorites && favoritesLoading ? <div className="enr-panel">Loading favorites…</div> : null}
            {showingFavorites && !favoritesLoading && !tabRaces.length ? (
              <div className="enr-panel">
                No favorite races yet. Open any race in the other office tabs and click the star to add it here.
              </div>
            ) : null}
            {view === "race" && showingFavorites && tabRaces.length ? (
              <div className="enr-favoritesList">
                {tabRaces.map((race) => {
                  const favoriteIndex = favoriteIndexByRaceId.get(race.id) ?? -1;
                  return (
                    <RaceSummary
                      key={race.id}
                      race={race}
                      onContestDetails={() => {
                        setSelectedRaceId(race.id);
                        setView("county");
                      }}
                      electionDayEstimate={selectedElectionConfig?.electionDayEstimate ?? null}
                      isFavorite={favoriteRaceIds.has(race.id)}
                      onToggleFavorite={
                        useBackend === true
                          ? () => {
                              void toggleFavoriteRace(race);
                            }
                          : undefined
                      }
                      canMoveFavoriteUp={favoriteIndex > 0}
                      canMoveFavoriteDown={favoriteIndex >= 0 && favoriteIndex < favoriteRaces.length - 1}
                      onMoveFavoriteUp={
                        favoriteRaceIds.has(race.id)
                          ? () => {
                              void moveFavoriteRace(race.id, "up");
                            }
                          : undefined
                      }
                      onMoveFavoriteDown={
                        favoriteRaceIds.has(race.id)
                          ? () => {
                              void moveFavoriteRace(race.id, "down");
                            }
                          : undefined
                      }
                      electionId={current?.file.election.id ?? null}
                    />
                  );
                })}
              </div>
            ) : null}
            {view === "race" && !showingFavorites && selectedRace ? (
              <RaceSummary
                race={selectedRace}
                onContestDetails={() => setView("county")}
                electionDayEstimate={selectedElectionConfig?.electionDayEstimate ?? null}
                isFavorite={favoriteRaceIds.has(selectedRace.id)}
                onToggleFavorite={
                  useBackend === true
                    ? () => {
                        void toggleFavoriteRace(selectedRace);
                      }
                    : undefined
                }
                canMoveFavoriteUp={(favoriteIndexByRaceId.get(selectedRace.id) ?? -1) > 0}
                canMoveFavoriteDown={(favoriteIndexByRaceId.get(selectedRace.id) ?? -1) >= 0 && (favoriteIndexByRaceId.get(selectedRace.id) ?? -1) < favoriteRaces.length - 1}
                onMoveFavoriteUp={
                  showingFavorites && favoriteRaceIds.has(selectedRace.id)
                    ? () => {
                        void moveFavoriteRace(selectedRace.id, "up");
                      }
                    : undefined
                }
                onMoveFavoriteDown={
                  showingFavorites && favoriteRaceIds.has(selectedRace.id)
                    ? () => {
                        void moveFavoriteRace(selectedRace.id, "down");
                      }
                    : undefined
                }
                electionId={current?.file.election.id ?? null}
              />
            ) : null}
            {view === "county" && selectedRace ? (
              <CountyBreakdown race={selectedRace} onBack={() => setView("race")} />
            ) : null}
          </>
        ) : null}
      </main>

      <footer className="enr-footer">
        <div>{APP_VERSION}</div>
      </footer>
    </div>
  );
}
