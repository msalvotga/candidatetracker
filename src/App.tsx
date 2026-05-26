import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { loadCivixElectionBundle } from "./lib/civix/loadElection";
import {
  fetchCatalogFromBackend,
  fetchAppSettings,
  fetchIngestStatus,
  loadElectionFromBackend,
  probeBackend,
  type ElectionOption,
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

function officeTypesForElection(election: LoadedElection | undefined): OfficeType[] {
  if (!election) return [];
  const set = new Set(election.file.races.map((r) => r.officeType));
  const ordered = OFFICE_ORDER.filter((t) => set.has(t));
  const extras = [...set].filter((t) => !OFFICE_ORDER.includes(t)).sort();
  return [...ordered, ...extras];
}

function racesForTab(election: LoadedElection | undefined, tab: OfficeType | null): RaceInput[] {
  if (!election || !tab) return [];
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
  const [officeTab, setOfficeTab] = useState<OfficeType | null>(null);
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);
  const [view, setView] = useState<"race" | "county">("race");
  const [ingestStatus, setIngestStatus] = useState<IngestStatus | null>(null);
  const [displayTimeZone, setDisplayTimeZone] = useState("America/Chicago");
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

  const tabs = useMemo(() => officeTypesForElection(current ?? undefined), [current]);

  useEffect(() => {
    if (!current) return;
    const nextTabs = officeTypesForElection(current);
    if (!officeTab || !nextTabs.includes(officeTab)) {
      setOfficeTab(nextTabs[0] ?? null);
    }
  }, [current, officeTab]);

  const tabRaces = useMemo(() => racesForTab(current ?? undefined, officeTab), [current, officeTab]);

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
    if (!current || !selectedRaceId) return null;
    return current.file.races.find((r) => r.id === selectedRaceId) ?? null;
  }, [current, selectedRaceId]);

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

  function onChangeOfficeTab(tab: OfficeType) {
    setOfficeTab(tab);
    const races = racesForTab(current ?? undefined, tab);
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
                  {t}
                </button>
              ))}
            </div>

            {view === "race" && selectedRace ? (
              <RaceSummary race={selectedRace} onContestDetails={() => setView("county")} />
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
