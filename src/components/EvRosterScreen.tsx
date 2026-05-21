import { useCallback, useEffect, useMemo, useState } from "react";
import { CountyMultiSelect } from "./CountyMultiSelect";
import {
  discoverEvRosterCountyUrl,
  discoverEvRosterCountyUrls,
  evRosterExportCsvUrl,
  fetchEvRosterConfigs,
  fetchEvRosterCountySources,
  fetchEvRosterHandlers,
  fetchEvRosterPullDates,
  fetchEvRosterSourceOptions,
  fetchEvRosterSummary,
  summaryDateRangeFromPullDates,
  isoToCivixDate,
  runEvRosterPull,
  confirmEvRosterCountyPull,
  fetchEvRosterPullProgress,
  fetchEvRosterVoters,
  formatEvRosterDateYyyymmdd,
  saveEvRosterCountySource,
  civixCountyNameToSourceKey,
  isCustomCountySource,
  type EvRosterPullScope,
  type EvRosterConfig,
  type EvRosterVoterRow,
  type EvRosterCountySource,
  type EvRosterCountySummary,
  type EvRosterHandler,
  type EvRosterSourceOptionsPayload,
  type EvRosterSummaryPayload,
  type EvRosterSummaryTotals,
  type EvRosterRunoff,
  type EvRosterPullProgress,
} from "../lib/evRosterBackend";

function suggestVariantKey(methodScope: string, dateScope: string) {
  const m = methodScope.toLowerCase();
  const d = dateScope === "CUMULATIVE" ? "cumulative" : "daily";
  return `${m}-${d}`;
}

function methodScopeShort(scope: string) {
  const s = scope.toUpperCase();
  if (s === "AB" || s === "BBM") return "BBM";
  if (s === "EV") return "EV";
  if (s === "ED") return "ED";
  return scope;
}

function partyScopeShort(scope: string) {
  const s = scope.toUpperCase();
  if (s === "REP_ONLY" || s === "REP") return "R only";
  if (s === "DEM_ONLY" || s === "DEM") return "D only";
  return "R+D";
}

function formatNum(n: number) {
  return n.toLocaleString("en-US");
}

type SortKey = "countyName" | "registeredVoters";
type SortDir = "asc" | "desc";

function sortIndicator(active: boolean, dir: SortDir) {
  if (!active) return " ↕";
  return dir === "asc" ? " ↑" : " ↓";
}

function CountyPullSpinner({ label = "Pulling county data" }: { label?: string }) {
  return <span className="enr-ev-roster__pull-spinner" role="status" aria-label={label} title={label} />;
}

function VoterPagination({
  offset,
  pageSize,
  total,
  loading,
  onPageChange,
}: {
  offset: number;
  pageSize: number;
  total: number;
  loading: boolean;
  onPageChange: (nextOffset: number) => void;
}) {
  const page = Math.floor(offset / pageSize) + 1;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + pageSize, total);

  return (
    <div className="enr-ev-roster__pager">
      <button
        type="button"
        className="enr-btn enr-btn--ghost"
        disabled={page <= 1 || loading}
        onClick={() => onPageChange(0)}
      >
        First
      </button>
      <button
        type="button"
        className="enr-btn enr-btn--ghost"
        disabled={page <= 1 || loading}
        onClick={() => onPageChange(Math.max(0, offset - pageSize))}
      >
        Previous
      </button>
      <span className="enr-ev-roster__pager-meta">
        Page {formatNum(page)} of {formatNum(pageCount)} · {formatNum(rangeStart)}–{formatNum(rangeEnd)} of{" "}
        {formatNum(total)}
      </span>
      <button
        type="button"
        className="enr-btn enr-btn--ghost"
        disabled={page >= pageCount || loading}
        onClick={() => onPageChange(offset + pageSize)}
      >
        Next
      </button>
      <button
        type="button"
        className="enr-btn enr-btn--ghost"
        disabled={page >= pageCount || loading}
        onClick={() => onPageChange((pageCount - 1) * pageSize)}
      >
        Last
      </button>
    </div>
  );
}

const COUNTY_PAGE_SIZE = 10;

function totalsFromCounties(counties: EvRosterCountySummary[]): EvRosterSummaryTotals {
  return counties.reduce(
    (acc, c) => ({
      registeredVoters: acc.registeredVoters + c.registeredVoters,
      inPersonVotesOnDate: acc.inPersonVotesOnDate + c.inPersonVotesOnDate,
      totalInPersonVotesForElection:
        acc.totalInPersonVotesForElection + c.totalInPersonVotesForElection,
      totalMailVotesForElection: acc.totalMailVotesForElection + c.totalMailVotesForElection,
      cumulativeTotal: acc.cumulativeTotal + c.cumulativeTotal,
      chosenVoterCount: acc.chosenVoterCount + c.chosenVoterCount,
    }),
    {
      registeredVoters: 0,
      inPersonVotesOnDate: 0,
      totalInPersonVotesForElection: 0,
      totalMailVotesForElection: 0,
      cumulativeTotal: 0,
      chosenVoterCount: 0,
    },
  );
}

export function EvRosterScreen({ onBack }: { onBack: () => void }) {
  const [configs, setConfigs] = useState<EvRosterConfig[]>([]);
  const [runoffs, setRunoffs] = useState<EvRosterRunoff[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [summaryDateFrom, setSummaryDateFrom] = useState("");
  const [summaryDateTo, setSummaryDateTo] = useState("");
  const [summaryParty, setSummaryParty] = useState<"ALL" | "REP" | "DEM">("ALL");
  const [pullDates, setPullDates] = useState<string[]>([]);
  const [summary, setSummary] = useState<EvRosterSummaryPayload | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [countyPage, setCountyPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("registeredVoters");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [handlers, setHandlers] = useState<EvRosterHandler[]>([]);
  const [countySources, setCountySources] = useState<EvRosterCountySource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [showTraining, setShowTraining] = useState(false);
  const [trainCountyKey, setTrainCountyKey] = useState("");
  const [trainSourceId, setTrainSourceId] = useState<number | null>(null);
  const [addingNewSource, setAddingNewSource] = useState(false);
  const [trainLabel, setTrainLabel] = useState("");
  const [trainVariant, setTrainVariant] = useState("");
  const [trainHub, setTrainHub] = useState("");
  const [trainRosterUrl, setTrainRosterUrl] = useState("");
  const [trainHandler, setTrainHandler] = useState("civix_sos_county_slice");
  const [trainMethodScope, setTrainMethodScope] = useState("ALL");
  const [trainDateScope, setTrainDateScope] = useState("SINGLE_DAY");
  const [trainFileFormat, setTrainFileFormat] = useState("auto");
  const [trainPartyScope, setTrainPartyScope] = useState("COMBINED");
  const [trainNotes, setTrainNotes] = useState("");
  const [trainEnabled, setTrainEnabled] = useState(true);
  const [trainBusy, setTrainBusy] = useState(false);
  const [sourceOptions, setSourceOptions] = useState<EvRosterSourceOptionsPayload | null>(null);
  const [viewTab, setViewTab] = useState<"counties" | "voters">("counties");
  const [voterRows, setVoterRows] = useState<EvRosterVoterRow[]>([]);
  const [voterTotal, setVoterTotal] = useState(0);
  const [voterLoading, setVoterLoading] = useState(false);
  const [voterSearch, setVoterSearch] = useState("");
  const [voterCountyFilters, setVoterCountyFilters] = useState<string[]>([]);
  const [voterOffset, setVoterOffset] = useState(0);
  const voterPageSize = 500;
  const [pullingCountyKey, setPullingCountyKey] = useState<string | null>(null);
  const [confirmingCountyKey, setConfirmingCountyKey] = useState<string | null>(null);
  const [activePullScope, setActivePullScope] = useState<EvRosterPullScope | null>(null);
  const [pullProgress, setPullProgress] = useState<EvRosterPullProgress | null>(null);

  const selected = useMemo(
    () => configs.find((c) => c.evrElectionId === selectedId) ?? null,
    [configs, selectedId],
  );

  const loadSummary = useCallback(
    async (
      evrId: number,
      opts: { dateFrom: string; dateTo: string; party: "ALL" | "REP" | "DEM" },
    ) => {
      if (!opts.dateFrom || !opts.dateTo) {
        setSummary(null);
        return;
      }
      setSummaryLoading(true);
      try {
        const data = await fetchEvRosterSummary(evrId, {
          dateFrom: opts.dateFrom,
          dateTo: opts.dateTo,
          party: opts.party,
        });
        setSummary(data);
        if (data?.sosPreview && data.message) {
          setStatus(data.message);
        }
      } catch {
        setSummary(null);
      } finally {
        setSummaryLoading(false);
      }
    },
    [],
  );

  const summaryDateBounds = useMemo(() => {
    const defaults = summaryDateRangeFromPullDates(pullDates);
    return {
      min: defaults.dateFrom,
      max: defaults.dateTo || new Date().toISOString().slice(0, 10),
    };
  }, [pullDates]);

  const refreshMeta = useCallback(
    async (
      evrId: number,
      preferRange?: { from?: string; to?: string },
      party: "ALL" | "REP" | "DEM" = summaryParty,
    ) => {
      const pulls = await fetchEvRosterPullDates(evrId);
      const dates = [...new Set(pulls.pulls.map((p) => p.votingDate).filter(Boolean))].sort();
      setPullDates(dates);
      const { dateFrom: defaultFrom, dateTo: defaultTo } = summaryDateRangeFromPullDates(dates);
      const clamp = (iso: string) => {
        if (!defaultFrom || !defaultTo) return iso;
        if (iso < defaultFrom) return defaultFrom;
        if (iso > defaultTo) return defaultTo;
        return iso;
      };
      const from = preferRange?.from ? clamp(preferRange.from) : defaultFrom;
      const to = preferRange?.to ? clamp(preferRange.to) : defaultTo;
      if (from && to) {
        setSummaryDateFrom(from);
        setSummaryDateTo(to);
        await loadSummary(evrId, { dateFrom: from, dateTo: to, party });
      } else {
        setSummaryDateFrom("");
        setSummaryDateTo("");
        setSummary(null);
      }
    },
    [loadSummary, summaryParty],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { configs: list, runoffs: runoffList } = await fetchEvRosterConfigs();
        if (cancelled) return;
        setConfigs(list);
        setRunoffs(runoffList);
        const firstRunoff = runoffList[0];
        const firstId = firstRunoff?.primaryEvrElectionId ?? list.find((c) => c.isEnabled)?.evrElectionId ?? list[0]?.evrElectionId;
        if (firstId) {
          setSelectedId(firstId);
          await refreshMeta(firstId);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load configs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  useEffect(() => {
    void fetchEvRosterHandlers()
      .then(setHandlers)
      .catch(() => setHandlers([]));
    void fetchEvRosterSourceOptions()
      .then(setSourceOptions)
      .catch(() => setSourceOptions(null));
  }, []);

  const loadCountySources = useCallback(async (evrId: number) => {
    setSourcesLoading(true);
    try {
      const sources = await fetchEvRosterCountySources(evrId);
      setCountySources(sources);
      return sources;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load county sources");
      setCountySources([]);
      return [];
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void refreshMeta(selectedId).catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load pulls"),
    );
    void loadCountySources(selectedId);
  }, [selectedId, refreshMeta, loadCountySources]);

  useEffect(() => {
    if (!selectedId || !summaryDateFrom || !summaryDateTo) return;
    void loadSummary(selectedId, {
      dateFrom: summaryDateFrom,
      dateTo: summaryDateTo,
      party: summaryParty,
    });
  }, [selectedId, summaryDateFrom, summaryDateTo, summaryParty, loadSummary]);

  const applySourceToForm = useCallback((source: EvRosterCountySource | undefined) => {
    if (!source) {
      setTrainLabel("County file");
      setTrainVariant(suggestVariantKey("EV", "SINGLE_DAY"));
      setTrainHub("");
      setTrainRosterUrl("");
      setTrainHandler("hub_page_discover");
      setTrainMethodScope("EV");
      setTrainDateScope("SINGLE_DAY");
      setTrainFileFormat("auto");
      setTrainPartyScope("COMBINED");
      setTrainNotes("");
      setTrainEnabled(true);
      return;
    }
    setTrainLabel(source.sourceLabel || source.variantKey);
    setTrainVariant(source.variantKey);
    setTrainHub(source.hubPageUrl ?? "");
    setTrainRosterUrl(source.rosterUrl ?? "");
    setTrainHandler(source.handlerKey || "civix_sos_county_slice");
    setTrainMethodScope(source.votingMethodScope ?? "ALL");
    setTrainDateScope(source.dateScope ?? "SINGLE_DAY");
    setTrainFileFormat(source.fileFormat ?? "auto");
    setTrainPartyScope(source.rosterPartyScope ?? "COMBINED");
    setTrainNotes(source.trainingNotes ?? "");
    setTrainEnabled(source.isEnabled);
  }, []);

  useEffect(() => {
    if (!showTraining || !selectedId) return;
    void loadCountySources(selectedId).then((sources) => {
      if (!trainCountyKey && sources.length) {
        setTrainCountyKey(sources[0].countyKey);
      }
    });
  }, [showTraining, selectedId, loadCountySources]);

  const countyChoices = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of countySources) {
      if (!m.has(s.countyKey)) m.set(s.countyKey, s.civixCountyName);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [countySources]);

  const sourcesForCounty = useMemo(
    () => countySources.filter((s) => s.countyKey === trainCountyKey),
    [countySources, trainCountyKey],
  );

  const customSourcesForCounty = useMemo(
    () => sourcesForCounty.filter(isCustomCountySource),
    [sourcesForCounty],
  );

  const customSourcesByCountyKey = useMemo(() => {
    const m = new Map<string, EvRosterCountySource[]>();
    for (const s of countySources) {
      if (!isCustomCountySource(s)) continue;
      const list = m.get(s.countyKey) ?? [];
      list.push(s);
      m.set(s.countyKey, list);
    }
    return m;
  }, [countySources]);

  const countyKeysWithTrainableSources = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, list] of customSourcesByCountyKey) {
      if (list.some((s) => s.isEnabled !== false)) keys.add(key);
    }
    return keys;
  }, [customSourcesByCountyKey]);

  const isPullActive = pulling || pullingCountyKey != null;

  const countyRowIsPulling = useCallback(
    (countyKey: string) => {
      if (pullingCountyKey === countyKey) return true;
      if (!pulling || !activePullScope) return false;
      if (activePullScope === "sos" || activePullScope === "all") return true;
      if (activePullScope === "counties") return countyKeysWithTrainableSources.has(countyKey);
      return false;
    },
    [pulling, pullingCountyKey, activePullScope, countyKeysWithTrainableSources],
  );

  useEffect(() => {
    if (addingNewSource || trainSourceId == null) return;
    const source = countySources.find((s) => s.id === trainSourceId);
    if (source) applySourceToForm(source);
  }, [trainSourceId, countySources, applySourceToForm, addingNewSource]);

  const countyTrainingBase = useMemo(
    () => countySources.find((s) => s.countyKey === trainCountyKey) ?? null,
    [countySources, trainCountyKey],
  );

  const editingSource = useMemo(() => {
    if (addingNewSource || trainSourceId == null) return null;
    return countySources.find((s) => s.id === trainSourceId) ?? null;
  }, [countySources, trainSourceId, addingNewSource]);

  function beginNewCountySource(preset: { method: "EV" | "AB"; label: string; variant: string }) {
    setAddingNewSource(true);
    setTrainSourceId(null);
    const hub = customSourcesForCounty[0]?.hubPageUrl ?? trainHub;
    const countyName = countyTrainingBase?.civixCountyName ?? trainCountyKey.toUpperCase();
    setTrainHub(hub);
    setTrainLabel(preset.label || `${countyName} ${preset.method === "EV" ? "EV" : "BBM"} roster`);
    setTrainVariant(preset.variant);
    setTrainMethodScope(preset.method === "EV" ? "EV" : "AB");
    setTrainDateScope("SINGLE_DAY");
    setTrainFileFormat("zip");
    setTrainPartyScope("COMBINED");
    setTrainHandler("hub_page_discover");
    setTrainRosterUrl("");
    setTrainNotes("");
    setTrainEnabled(true);
  }

  function selectExistingSource(sourceId: number) {
    setAddingNewSource(false);
    setTrainSourceId(sourceId);
  }

  function openTrainingForCounty(countyName: string, opts?: { newSource?: boolean; methodPreset?: "EV" | "AB" }) {
    if (!selectedId) return;
    setShowTraining(true);
    void (async () => {
      const sources = countySources.length ? countySources : await loadCountySources(selectedId);
      const key = civixCountyNameToSourceKey(countyName);
      const match =
        sources.find((s) => s.civixCountyName === countyName.toUpperCase()) ??
        sources.find((s) => s.countyKey === key);
      const countyKey = match?.countyKey ?? key;
      setTrainCountyKey(countyKey);
      const custom = sources.filter((s) => s.countyKey === countyKey && isCustomCountySource(s));
      if (opts?.newSource || opts?.methodPreset) {
        setTrainCountyKey(countyKey);
        setAddingNewSource(true);
        setTrainSourceId(null);
        const hub = custom[0]?.hubPageUrl ?? match?.hubPageUrl ?? "";
        if (opts.methodPreset === "EV") {
          setTrainHub(hub);
          setTrainLabel(`${countyName} EV roster`);
          setTrainVariant("ev-zip");
          setTrainMethodScope("EV");
          setTrainDateScope("SINGLE_DAY");
          setTrainFileFormat("zip");
          setTrainHandler("hub_page_discover");
          setTrainRosterUrl("");
          setTrainEnabled(true);
        } else if (opts.methodPreset === "AB") {
          setTrainHub(hub);
          setTrainLabel(`${countyName} BBM roster`);
          setTrainVariant("bbm-zip");
          setTrainMethodScope("AB");
          setTrainDateScope("SINGLE_DAY");
          setTrainFileFormat("zip");
          setTrainHandler("hub_page_discover");
          setTrainRosterUrl("");
          setTrainEnabled(true);
        } else {
          applySourceToForm(undefined);
          if (hub) setTrainHub(hub);
        }
      } else {
        setAddingNewSource(false);
        setTrainSourceId(custom[0]?.id ?? null);
      }
    })();
  }

  function countySourcesAction(countyName: string) {
    const key = civixCountyNameToSourceKey(countyName);
    const custom = customSourcesByCountyKey.get(key) ?? [];
    if (custom.length === 0) {
      return {
        label: "Add county source",
        title: "No county-specific roster yet (SOS statewide only)",
        isConfigured: false,
      };
    }
    const tags = [...new Set(custom.map((s) => methodScopeShort(s.votingMethodScope)))].join(" + ");
    return {
      label: custom.length === 1 ? `Edit source (${tags})` : `Edit sources (${custom.length}: ${tags})`,
      title: custom.map((s) => s.sourceLabel || s.variantKey).join(", "),
      isConfigured: true,
    };
  }

  function variantLabel(source: EvRosterCountySource) {
    const label = source.sourceLabel?.trim() || source.variantKey;
    const tag = methodScopeShort(source.votingMethodScope);
    const party = partyScopeShort(source.rosterPartyScope ?? "COMBINED");
    const hub = source.hubPageUrl?.trim();
    if (source.handlerKey === "hub_page_discover" && hub) {
      return `${label} — ${tag}, ${party} (hub)`;
    }
    if (isCustomCountySource(source)) {
      return `${label} — ${tag}, ${party}`;
    }
    return `${label} (SOS only)`;
  }

  function onSortColumn(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "registeredVoters" ? "desc" : "asc");
  }

  const displayedCounties = useMemo(() => {
    const rows = summary?.counties ?? [];
    const q = filter.trim().toUpperCase();
    const filtered = q ? rows.filter((c) => c.countyName.includes(q)) : rows;
    return [...filtered].sort((a, b) => {
      if (sortKey === "countyName") {
        const cmp = a.countyName.localeCompare(b.countyName);
        return sortDir === "asc" ? cmp : -cmp;
      }
      const cmp = a.registeredVoters - b.registeredVoters;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [summary, filter, sortKey, sortDir]);

  useEffect(() => {
    setCountyPage(0);
  }, [filter, sortKey, sortDir, summaryParty, summaryDateFrom, summaryDateTo, selectedId]);

  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(displayedCounties.length / COUNTY_PAGE_SIZE) - 1);
    if (countyPage > maxPage) setCountyPage(maxPage);
  }, [displayedCounties.length, countyPage]);

  const paginatedCounties = useMemo(() => {
    const start = countyPage * COUNTY_PAGE_SIZE;
    return displayedCounties.slice(start, start + COUNTY_PAGE_SIZE);
  }, [displayedCounties, countyPage]);

  const totals = useMemo((): EvRosterSummaryTotals => {
    if (summary?.summaryTotals) return summary.summaryTotals;
    return totalsFromCounties(summary?.counties ?? []);
  }, [summary]);

  const voterCountyOptions = useMemo(() => {
    const names = (summary?.counties ?? []).map((c) => c.countyName).filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }, [summary]);

  const loadVoters = useCallback(
    async (evrId: number, date: string, offset = 0) => {
      setVoterLoading(true);
      try {
        const data = await fetchEvRosterVoters(evrId, date, {
          limit: voterPageSize,
          offset,
          counties: voterCountyFilters.length ? voterCountyFilters : undefined,
          q: voterSearch.trim() || undefined,
        });
        setVoterRows(data.rows);
        setVoterTotal(data.total);
        setVoterOffset(offset);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load voter records");
        setVoterRows([]);
        setVoterTotal(0);
      } finally {
        setVoterLoading(false);
      }
    },
    [voterCountyFilters, voterSearch],
  );

  const voterListDate =
    summaryDateFrom && summaryDateTo && summaryDateFrom === summaryDateTo ? summaryDateTo : summaryDateTo;

  useEffect(() => {
    if (viewTab !== "voters" || !selectedId || !voterListDate || !pullDates.includes(voterListDate)) return;
    const timer = window.setTimeout(() => {
      void loadVoters(selectedId, voterListDate, 0);
    }, voterSearch ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [viewTab, selectedId, voterListDate, pullDates, voterCountyFilters, voterSearch, loadVoters]);

  function evrIdForSummaryParty(): number | null {
    if (!selectedRunoff) return selectedId;
    if (summaryParty === "REP") {
      return (
        selectedRunoff.configs.find((c) => String(c.party).toUpperCase() === "REP")?.evrElectionId ??
        selectedId
      );
    }
    if (summaryParty === "DEM") {
      return (
        selectedRunoff.configs.find((c) => String(c.party).toUpperCase() === "DEM")?.evrElectionId ??
        selectedId
      );
    }
    return selectedRunoff.configs[0]?.evrElectionId ?? selectedId;
  }

  async function doConfirm(countyName: string, countyKey: string, confirmDate: string) {
    const evrId = evrIdForSummaryParty();
    if (!evrId || !confirmDate) return;
    if (summaryParty === "ALL") {
      setError("Choose Republican only or Democratic only in the party filter before confirming a county.");
      return;
    }
    setConfirmingCountyKey(countyKey);
    setError(null);
    try {
      await confirmEvRosterCountyPull(evrId, confirmDate, countyName);
      setStatus(`${countyName} confirmed — data locked for ${confirmDate}.`);
      await refreshMeta(selectedId, { from: summaryDateFrom, to: summaryDateTo });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Confirm failed");
    } finally {
      setConfirmingCountyKey(null);
    }
  }

  async function doPull(pullScope: EvRosterPullScope, countyKey?: string) {
    if (!selectedId) return;
    const isCounty = pullScope === "county" && countyKey;
    const jobId = crypto.randomUUID();
    if (isCounty) {
      setPullingCountyKey(countyKey);
      setActivePullScope("county");
    } else {
      setPulling(true);
      setActivePullScope(pullScope);
    }
    setStatus(null);
    setError(null);
    setPullProgress({
      active: true,
      jobId,
      phase: "starting",
      message: "Starting pull…",
      pullScope,
      countyKey: countyKey ?? undefined,
    });
    try {
      const result = await runEvRosterPull(selectedId, {
        pullScope,
        countyKey,
        pullThroughToday: true,
        jobId,
        onProgress: (p) => setPullProgress(p.active ? p : null),
      });
      const scopeLabel =
        pullScope === "counties"
          ? "County sources"
          : pullScope === "sos"
            ? "SOS"
            : pullScope === "county"
              ? countyKey?.toUpperCase()
              : "All sources";
      setStatus(
        `${scopeLabel}: ${result.daysPulled ?? 0} day(s) × ${result.electionsPulled ?? 0} party runoff(s) — ${formatNum(result.rawRecordCount ?? 0)} raw → ${formatNum(result.dedupedVoterCount ?? 0)} unique VUIDs (${result.countyPullCount ?? 0} source pulls).`,
      );
      await refreshMeta(selectedId);
      if (showTraining) void loadCountySources(selectedId);
      if (viewTab === "voters" && voterListDate) void loadVoters(selectedId, voterListDate, 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setPullProgress(null);
      setPulling(false);
      setPullingCountyKey(null);
      setActivePullScope(null);
    }
  }

  const pullProgressPct = useMemo(() => {
    if (pullProgress?.batchTotal && pullProgress.batchStep) {
      return Math.min(100, Math.round((pullProgress.batchStep / pullProgress.batchTotal) * 100));
    }
    if (pullProgress?.totalSteps && pullProgress.step) {
      return Math.min(100, Math.round((pullProgress.step / pullProgress.totalSteps) * 100));
    }
    return null;
  }, [pullProgress]);

  const selectedRunoff = useMemo(
    () => runoffs.find((r) => r.evrElectionIds.includes(Number(selectedId))) ?? null,
    [runoffs, selectedId],
  );

  const sosPageUrl =
    selected &&
    summaryDateTo &&
    `https://goelect.txelections.civixapps.com/ivis-evr-ui/official-early-voting-turnout?type=EV&date=${encodeURIComponent(isoToCivixDate(summaryDateTo))}&electionId=${selected.evrElectionId}&electionDate=${encodeURIComponent(selected.electionDate)}&electionName=${encodeURIComponent(selected.electionName)}&isCertified=false`;

  return (
    <div className="enr-ev-roster">
      <header className="enr-ev-roster__header">
        <button type="button" className="enr-btn enr-btn--ghost" onClick={onBack}>
          ← Results
        </button>
        <div>
          <h1>Early voting rosters</h1>
          <p className="enr-muted">
            One pull loads every early voting day through today for both party runoffs (Dem + Rep). County table filters by party and
            date range. Voter list uses the &quot;Through&quot; date when the range is a single day.
          </p>
        </div>
      </header>

      {loading && <p className="enr-muted">Loading…</p>}
      {error && <p className="enr-error">{error}</p>}
      {status && !isPullActive && <p className="enr-success">{status}</p>}

      {isPullActive && (
        <div className="enr-ev-roster__pull-statusbar" role="status" aria-live="polite">
          <CountyPullSpinner label={pullProgress?.message ?? "Pull in progress"} />
          <div className="enr-ev-roster__pull-statusbar-body">
            <p className="enr-ev-roster__pull-statusbar-title">{pullProgress?.message ?? "Pull in progress…"}</p>
            <p className="enr-ev-roster__pull-statusbar-meta">
              {pullProgress?.phase === "county" && pullProgress.countyName && (
                <span>
                  <strong>{pullProgress.countyName}</strong>
                  {pullProgress.sourceLabel ? ` · ${pullProgress.sourceLabel}` : ""}
                  {pullProgress.handlerKey ? ` (${pullProgress.handlerKey})` : ""}
                  {" · "}
                </span>
              )}
              {pullProgress?.party && <span>{pullProgress.party}</span>}
              {pullProgress?.votingDate && (
                <span>
                  {pullProgress.party ? " · " : ""}
                  {pullProgress.votingDate}
                </span>
              )}
              {pullProgress?.batchStep != null && pullProgress?.batchTotal != null && (
                <span>
                  {" · "}
                  Run {pullProgress.batchStep} of {pullProgress.batchTotal}
                </span>
              )}
              {pullProgress?.step != null && pullProgress?.totalSteps != null && pullProgress?.phase === "county" && (
                <span>
                  {" · "}
                  County {pullProgress.step} of {pullProgress.totalSteps}
                </span>
              )}
            </p>
            {pullProgressPct != null && (
              <div className="enr-ev-roster__pull-statusbar-track" aria-hidden>
                <div className="enr-ev-roster__pull-statusbar-fill" style={{ width: `${pullProgressPct}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && (
        <section className="enr-ev-roster__controls">
          <label>
            Runoff election
            <select
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(Number(e.target.value))}
            >
              {(runoffs.length ? runoffs : configs.map((c) => ({
                runoffKey: String(c.evrElectionId),
                label: c.electionName,
                primaryEvrElectionId: c.evrElectionId,
                evrElectionIds: [c.evrElectionId],
                parties: [c.party],
                electionDate: c.electionDate,
                configs: [c],
              }))).map((r) => (
                <option key={r.runoffKey} value={r.primaryEvrElectionId ?? r.evrElectionIds[0]}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="enr-btn enr-btn--primary"
            disabled={isPullActive || !selectedId}
            onClick={() => void doPull("all")}
          >
            {pulling && activePullScope === "all" ? (
              <>
                <CountyPullSpinner label="Pulling all sources" /> Pulling…
              </>
            ) : (
              "Pull all (all days & parties)"
            )}
          </button>
          <button
            type="button"
            className="enr-btn enr-btn--ghost"
            disabled={isPullActive || !selectedId}
            onClick={() => void doPull("counties")}
          >
            {pulling && activePullScope === "counties" ? (
              <>
                <CountyPullSpinner label="Pulling county sources" /> Pulling counties…
              </>
            ) : (
              "Pull county sources only"
            )}
          </button>
          <button
            type="button"
            className="enr-btn enr-btn--ghost"
            disabled={isPullActive || !selectedId}
            onClick={() => void doPull("sos")}
          >
            {pulling && activePullScope === "sos" ? (
              <>
                <CountyPullSpinner label="Pulling SOS statewide data" /> Pulling SOS…
              </>
            ) : (
              "Pull SOS only"
            )}
          </button>
          {selectedId && summaryDateTo && pullDates.includes(summaryDateTo) && (
            <a className="enr-btn enr-btn--ghost" href={evRosterExportCsvUrl(selectedId, summaryDateTo)} download>
              Export CSV (through date)
            </a>
          )}
          {sosPageUrl && (
            <a className="enr-btn enr-btn--ghost" href={sosPageUrl} target="_blank" rel="noreferrer">
              Open SOS page
            </a>
          )}
          <button type="button" className="enr-btn enr-btn--ghost" onClick={() => setShowTraining((v) => !v)}>
            {showTraining ? "Hide county sources" : "County source training"}
          </button>
        </section>
      )}

      {showTraining && selectedId && (
        <section className="enr-ev-roster__training">
          <h2>County source training</h2>
          <p className="enr-muted">
            Counties can have multiple sources (e.g. Harris: separate BBM and EV ZIPs). ZIPs often contain one CSV per
            early-voting day — use <strong>Single day</strong> date scope so the pull uses only the day you select.
            For each county source, set <strong>Parties in file</strong>: <strong>Combined</strong> (one file for both
            runoffs — shared with the other party&apos;s config on the same election day), <strong>Republican only</strong>, or{" "}
            <strong>Democrat only</strong> (separate links per party, e.g. Collin).
            Set the <strong>hub page URL</strong> and handler <strong>Hub page (discover on each pull)</strong> — you do
            not need a static roster file URL. Use <strong>Discover &amp; save all</strong> to create BBM + EV sources.
          </p>
          {sourcesLoading && <p className="enr-muted">Loading county list…</p>}
          {!sourcesLoading && countySources.length === 0 && (
            <p className="enr-muted">Run <strong>Pull all sources</strong> once to seed the county list from SOS, then edit sources here.</p>
          )}
          <div className="enr-ev-roster__training-form">
            <label>
              County
              <select
                value={trainCountyKey}
                onChange={(e) => {
                  const key = e.target.value;
                  setTrainCountyKey(key);
                  setAddingNewSource(false);
                  const custom = countySources.filter(
                    (s) => s.countyKey === key && isCustomCountySource(s),
                  );
                  setTrainSourceId(custom[0]?.id ?? null);
                }}
                disabled={!countyChoices.length}
              >
                <option value="">Select county…</option>
                {countyChoices.map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {trainCountyKey && (
              <label>
                Source variant
                <select
                  value={addingNewSource ? "new" : String(trainSourceId ?? "new")}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "new") {
                      setAddingNewSource(true);
                      setTrainSourceId(null);
                      applySourceToForm(undefined);
                      const hub = customSourcesForCounty[0]?.hubPageUrl ?? "";
                      if (hub) setTrainHub(hub);
                    } else {
                      selectExistingSource(Number(v));
                    }
                  }}
                >
                  {customSourcesForCounty.map((s) => (
                    <option key={s.id} value={s.id}>
                      {variantLabel(s)}
                    </option>
                  ))}
                  <option value="new">+ Add another source…</option>
                </select>
              </label>
            )}
            {trainCountyKey === "collin" && customSourcesForCounty.length === 0 && (
              <p className="enr-muted">
                Collin uses four hub-discovered sources (EV/AB × Republican/Democrat). They are created automatically
                when you open this panel — pick each variant below to review. Hub: collincountytx.gov/Elections/rosters
                (file URLs refresh on each pull).
              </p>
            )}
            {trainCountyKey && trainCountyKey !== "collin" && customSourcesForCounty.length < 2 && (
              <div className="enr-ev-roster__training-presets">
                <span className="enr-muted">Quick add for this county:</span>
                <button
                  type="button"
                  className="enr-btn enr-btn--ghost enr-btn--sm"
                  disabled={trainBusy || customSourcesForCounty.some((s) => s.votingMethodScope === "EV")}
                  onClick={() =>
                    beginNewCountySource({
                      method: "EV",
                      variant: "ev-zip",
                      label: `${countyTrainingBase?.civixCountyName ?? "County"} EV roster`,
                    })
                  }
                >
                  + EV source
                </button>
                <button
                  type="button"
                  className="enr-btn enr-btn--ghost enr-btn--sm"
                  disabled={trainBusy || customSourcesForCounty.some((s) => s.votingMethodScope === "AB")}
                  onClick={() =>
                    beginNewCountySource({
                      method: "AB",
                      variant: "bbm-zip",
                      label: `${countyTrainingBase?.civixCountyName ?? "County"} BBM roster`,
                    })
                  }
                >
                  + BBM source
                </button>
              </div>
            )}
            {addingNewSource && (
              <p className="enr-ev-roster__training-new-banner">
                Adding a new source for this county — click <strong>Add source</strong> below (will not replace
                existing sources).
              </p>
            )}
            {countyTrainingBase && (
              <p className="enr-muted enr-ev-roster__training-meta">
                SOS name: {countyTrainingBase.civixCountyName}
                {countyTrainingBase.civixCountyId != null ? ` · Civix ID ${countyTrainingBase.civixCountyId}` : ""}
              </p>
            )}
            <label>
              Source label
              <input value={trainLabel} onChange={(e) => setTrainLabel(e.target.value)} placeholder="e.g. Harris EV daily CSV" />
            </label>
            <label>
              Variant key (unique per county)
              <input
                value={trainVariant}
                onChange={(e) => setTrainVariant(e.target.value)}
                placeholder={suggestVariantKey(trainMethodScope, trainDateScope)}
                disabled={!addingNewSource && editingSource?.variantKey === "sos-default"}
              />
            </label>
            <label>
              Voting method in file
              <select value={trainMethodScope} onChange={(e) => setTrainMethodScope(e.target.value)}>
                {(sourceOptions?.votingMethodScopes ?? [{ id: "ALL", label: "All methods" }]).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Date scope
              <select value={trainDateScope} onChange={(e) => setTrainDateScope(e.target.value)}>
                {(sourceOptions?.dateScopes ?? [{ id: "SINGLE_DAY", label: "Single day" }]).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              File format
              <select value={trainFileFormat} onChange={(e) => setTrainFileFormat(e.target.value)}>
                {(sourceOptions?.fileFormats ?? [{ id: "auto", label: "Auto" }]).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Parties in file
              <select value={trainPartyScope} onChange={(e) => setTrainPartyScope(e.target.value)}>
                {(sourceOptions?.rosterPartyScopes ?? [
                  { id: "COMBINED", label: "Combined R and D" },
                  { id: "REP_ONLY", label: "Republican only" },
                  { id: "DEM_ONLY", label: "Democrat only" },
                ]).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Hub page URL
              <input value={trainHub} onChange={(e) => setTrainHub(e.target.value)} placeholder="https://…" />
            </label>
            <label>
              Roster file URL{" "}
              <span className="enr-muted">(optional — leave blank to resolve from hub on each pull)</span>
              <input
                value={trainRosterUrl}
                onChange={(e) => setTrainRosterUrl(e.target.value)}
                placeholder="Only if you want a fixed file URL instead of hub discovery"
                disabled={trainHandler === "hub_page_discover"}
              />
            </label>
            <label>
              Handler
              <select value={trainHandler} onChange={(e) => setTrainHandler(e.target.value)}>
                {handlers.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="enr-ev-roster__training-check">
              <input
                type="checkbox"
                checked={trainEnabled}
                onChange={(e) => setTrainEnabled(e.target.checked)}
              />
              Include this county on pull (enabled)
            </label>
            <label>
              Training notes
              <textarea value={trainNotes} onChange={(e) => setTrainNotes(e.target.value)} rows={2} />
            </label>
            <div className="enr-ev-roster__training-actions">
              <button
                type="button"
                className="enr-btn enr-btn--ghost"
                disabled={trainBusy || !trainCountyKey}
                onClick={() => {
                  setAddingNewSource(true);
                  setTrainSourceId(null);
                  applySourceToForm(undefined);
                  const hub = customSourcesForCounty[0]?.hubPageUrl ?? "";
                  if (hub) setTrainHub(hub);
                }}
              >
                Add another source
              </button>
              <button
                type="button"
                className="enr-btn enr-btn--ghost"
                disabled={trainBusy || !trainHub || !trainCountyKey}
                onClick={() => {
                  void (async () => {
                    setTrainBusy(true);
                    setError(null);
                    try {
                      const found = await discoverEvRosterCountyUrl(
                        trainHub,
                        trainCountyKey,
                        trainMethodScope,
                      );
                      if (found.url) {
                        setTrainHandler("hub_page_discover");
                        setStatus(
                          `Matched: ${found.matchedLabel ?? "roster link"}. Save with hub handler — file URL is resolved on each pull.`,
                        );
                      } else setStatus(found.message ?? "No link matched");
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Discover failed");
                    } finally {
                      setTrainBusy(false);
                    }
                  })();
                }}
              >
                Discover link
              </button>
              <button
                type="button"
                className="enr-btn enr-btn--ghost"
                disabled={trainBusy || !trainHub || !trainCountyKey || !countyTrainingBase}
                onClick={() => {
                  void (async () => {
                    if (!countyTrainingBase || !selectedId) return;
                    setTrainBusy(true);
                    setError(null);
                    try {
                      const found = await discoverEvRosterCountyUrls(trainHub, trainCountyKey, {
                        evrElectionId: selectedId,
                        electionDate: selected?.electionDate,
                      });
                      if (!found.matches?.length) {
                        setStatus(found.message ?? "No links matched");
                        return;
                      }
                      let updated = countySources;
                      for (const m of found.matches) {
                        const directUrl = m.url?.trim() ?? "";
                        updated = await saveEvRosterCountySource({
                          evrElectionId: selectedId,
                          countyKey: countyTrainingBase.countyKey,
                          variantKey: m.suggestedVariantKey ?? m.matchedStage,
                          sourceLabel: m.suggestedLabel ?? m.matchedLabel,
                          civixCountyName: countyTrainingBase.civixCountyName,
                          civixCountyId: countyTrainingBase.civixCountyId,
                          handlerKey: directUrl ? "generic_file_url" : "hub_page_discover",
                          hubPageUrl: trainHub,
                          rosterUrl: directUrl,
                          votingMethodScope: m.suggestedMethodScope ?? "ALL",
                          dateScope: m.suggestedDateScope ?? "SINGLE_DAY",
                          fileFormat: m.suggestedFileFormat ?? "zip",
                          rosterPartyScope: m.suggestedRosterPartyScope ?? "COMBINED",
                          isEnabled: true,
                        });
                      }
                      setCountySources(updated);
                      setStatus(
                        `Saved ${found.matches.length} source(s): ${found.matches.map((m) => m.suggestedLabel ?? m.matchedLabel).join(", ")}.`,
                      );
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Discover all failed");
                    } finally {
                      setTrainBusy(false);
                    }
                  })();
                }}
              >
                Discover &amp; save all on page
              </button>
              <button
                type="button"
                className="enr-btn enr-btn--primary"
                disabled={trainBusy || !trainCountyKey || !countyTrainingBase}
                onClick={() => {
                  void (async () => {
                    if (!countyTrainingBase || !selectedId) return;
                    setTrainBusy(true);
                    setError(null);
                    try {
                      const variantKey =
                        trainVariant.trim() || suggestVariantKey(trainMethodScope, trainDateScope);
                      const handlerKey =
                        trainRosterUrl.trim() && trainHandler !== "hub_page_discover"
                          ? trainHandler
                          : trainHub.trim()
                            ? "hub_page_discover"
                            : trainHandler;
                      const updated = await saveEvRosterCountySource({
                        id: addingNewSource ? undefined : trainSourceId ?? undefined,
                        evrElectionId: selectedId,
                        countyKey: countyTrainingBase.countyKey,
                        variantKey,
                        sourceLabel: trainLabel.trim() || variantKey,
                        civixCountyName: countyTrainingBase.civixCountyName,
                        civixCountyId: countyTrainingBase.civixCountyId,
                        handlerKey,
                        hubPageUrl: trainHub,
                        rosterUrl: handlerKey === "hub_page_discover" ? "" : trainRosterUrl,
                        votingMethodScope: trainMethodScope,
                        dateScope: trainDateScope,
                        fileFormat: trainFileFormat,
                        rosterPartyScope: trainPartyScope,
                        trainingNotes: trainNotes || null,
                        isEnabled: trainEnabled,
                      });
                      setCountySources(updated);
                      const saved = updated.find(
                        (s) => s.countyKey === countyTrainingBase.countyKey && s.variantKey === variantKey,
                      );
                      const wasAdding = addingNewSource;
                      setAddingNewSource(false);
                      if (saved) setTrainSourceId(saved.id);
                      setStatus(
                        wasAdding
                          ? `Added ${trainLabel || variantKey} for ${countyTrainingBase.civixCountyName}.`
                          : `Saved ${trainLabel || variantKey} for ${countyTrainingBase.civixCountyName}.`,
                      );
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Save failed");
                    } finally {
                      setTrainBusy(false);
                    }
                  })();
                }}
              >
                {addingNewSource ? "Add source" : "Save changes"}
              </button>
            </div>
          </div>
        </section>
      )}

      {summary?.sosPreview && (
        <section className="enr-ev-roster__training-new-banner">
          Showing live <strong>SOS</strong> county turnout and roster counts for this runoff. Run{" "}
          <strong>Pull all sources</strong> to save voters and county file data.
        </section>
      )}

      {summary?.pull && (
        <section className="enr-ev-roster__meta enr-muted">
          <span>
            Last pull: {summary.pull.pulledAt ? new Date(summary.pull.pulledAt).toLocaleString() : "—"}
          </span>
          <span>Unique VUIDs (deduped): {formatNum(summary.pull.dedupedVoterCount ?? summary.pull.storedVoterCount)}</span>
          <span>Raw rows ingested: {formatNum(summary.pull.rawRecordCount ?? 0)}</span>
          <span>
            Roster VUIDs in range ({summaryParty === "ALL" ? "both parties" : summaryParty}):{" "}
            {formatNum(totals.chosenVoterCount)}
          </span>
        </section>
      )}

      <section className="enr-ev-roster__view-tabs">
        <button type="button" className={viewTab === "counties" ? "is-active" : ""} onClick={() => setViewTab("counties")}>
          County summary
        </button>
        <button
          type="button"
          className={viewTab === "voters" ? "is-active" : ""}
          onClick={() => setViewTab("voters")}
          disabled={!voterListDate || !pullDates.includes(voterListDate)}
          title={
            summaryDateFrom !== summaryDateTo
              ? "Set From and Through to the same date to browse voter rows"
              : undefined
          }
        >
          Voter records{summary?.pull ? ` (${formatNum(summary.pull.storedVoterCount)})` : ""}
        </button>
      </section>

      {viewTab === "voters" && (
        <section className="enr-ev-roster__table-wrap enr-ev-roster__voters-wrap">
          <div className="enr-ev-roster__table-toolbar enr-ev-roster__voters-toolbar">
            <input
              type="search"
              placeholder="Search VUID, county, party…"
              value={voterSearch}
              onChange={(e) => setVoterSearch(e.target.value)}
            />
            <CountyMultiSelect
              options={voterCountyOptions}
              value={voterCountyFilters}
              onChange={setVoterCountyFilters}
              disabled={voterLoading || !voterCountyOptions.length}
            />
            <span className="enr-muted enr-ev-roster__voters-meta">
              {voterLoading ? "Loading…" : `${formatNum(voterTotal)} matching rows`}
            </span>
          </div>
          {voterTotal > 0 && (
            <VoterPagination
              offset={voterOffset}
              pageSize={voterPageSize}
              total={voterTotal}
              loading={voterLoading}
              onPageChange={(next) => selectedId && voterListDate && void loadVoters(selectedId, voterListDate, next)}
            />
          )}
          <table className="enr-ev-roster__table enr-ev-roster__voters-table">
            <thead>
              <tr>
                <th>VUID</th>
                <th>County</th>
                <th>Party</th>
                <th>Date</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {voterRows.map((v) => (
                <tr key={`${v.vuid}-${v.countyName}-${v.methodCode}`}>
                  <td className="mono">{v.vuid}</td>
                  <td>{v.countyName}</td>
                  <td>{v.party}</td>
                  <td className="mono">{formatEvRosterDateYyyymmdd(v.votingDate)}</td>
                  <td>{v.methodCode}</td>
                </tr>
              ))}
              {!voterLoading && voterRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="enr-muted">
                    No rows for this date. Run a pull, then refresh.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {voterTotal > 0 && (
            <VoterPagination
              offset={voterOffset}
              pageSize={voterPageSize}
              total={voterTotal}
              loading={voterLoading}
              onPageChange={(next) => selectedId && voterListDate && void loadVoters(selectedId, voterListDate, next)}
            />
          )}
        </section>
      )}

      {viewTab === "counties" && (
      <section
        className={`enr-ev-roster__table-wrap${summaryLoading ? " is-summary-loading" : ""}`}
        aria-busy={summaryLoading}
      >
        {summaryLoading && (
          <p className="enr-ev-roster__summary-loading" role="status" aria-live="polite">
            <span className="enr-ev-roster__pull-spinner" aria-hidden />
            Updating county summary…
          </p>
        )}
        <div className="enr-ev-roster__table-toolbar">
          <label>
            Party
            <select
              value={summaryParty}
              disabled={summaryLoading}
              onChange={(e) => setSummaryParty(e.target.value as "ALL" | "REP" | "DEM")}
            >
              <option value="ALL">All parties</option>
              <option value="REP">Republican only</option>
              <option value="DEM">Democratic only</option>
            </select>
          </label>
          <label title="Filter by vote/activity date on each voter record (mail ballots may be weeks before the pull date)">
            From
            <input
              type="date"
              value={summaryDateFrom}
              min={summaryDateBounds.min || undefined}
              max={summaryDateBounds.max}
              onChange={(e) => setSummaryDateFrom(e.target.value)}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              value={summaryDateTo}
              min={summaryDateBounds.min || undefined}
              max={summaryDateBounds.max}
              onChange={(e) => setSummaryDateTo(e.target.value)}
            />
          </label>
          <input
            type="search"
            placeholder="Filter county…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <table className="enr-ev-roster__table">
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  className={`enr-ev-roster__sort${sortKey === "countyName" ? " is-active" : ""}`}
                  onClick={() => onSortColumn("countyName")}
                  aria-sort={sortKey === "countyName" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                >
                  County{sortIndicator(sortKey === "countyName", sortDir)}
                </button>
              </th>
              <th className="num">
                <button
                  type="button"
                  className={`enr-ev-roster__sort enr-ev-roster__sort--num${sortKey === "registeredVoters" ? " is-active" : ""}`}
                  onClick={() => onSortColumn("registeredVoters")}
                  aria-sort={sortKey === "registeredVoters" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                >
                  Registered{sortIndicator(sortKey === "registeredVoters", sortDir)}
                </button>
              </th>
              <th
                className="num"
                title={
                  summaryDateFrom === summaryDateTo
                    ? "In-person voters whose activity date is that day"
                    : "Sum of in-person voters by activity date in the filtered range"
                }
              >
                In-person (day)
              </th>
              <th className="num" title="Distinct in-person (EV) voters with activity date in range">
                Cum. in-person
              </th>
              <th className="num" title="Distinct mail/BBM (AB) voters with activity date in range">
                Cum. mail
              </th>
              <th className="num" title="Distinct voters with activity date in range (all methods)">
                Cum. total
              </th>
              <th className="num" title="Distinct VUIDs with vote/activity date in range">
                Roster (VUIDs)
              </th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {paginatedCounties.map((c) => {
              const srcAction = countySourcesAction(c.countyName);
              const countyKey = civixCountyNameToSourceKey(c.countyName);
              const rowPulling = countyRowIsPulling(countyKey);
              const ps = c.pullStatus;
              const isConfirmed = !!ps?.confirmedAt;
              const pullSucceeded = ps?.lastPullOk === true;
              const pullFailed = ps?.lastPullOk === false;
              const confirming = confirmingCountyKey === countyKey;
              return (
              <tr
                key={c.countyName}
                className={[
                  rowPulling ? "is-county-pulling" : "",
                  isConfirmed ? "is-county-confirmed" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined}
              >
                <td>
                  <span className="enr-ev-roster__county-label">
                    {c.countyName}
                    {pullSucceeded && (
                      <span
                        className="enr-ev-roster__pull-status enr-ev-roster__pull-status--ok"
                        title={ps?.lastPullMessage ?? "County pull succeeded"}
                        aria-label="Pull succeeded"
                      >
                        ✓
                      </span>
                    )}
                    {pullFailed && (
                      <span
                        className="enr-ev-roster__pull-status enr-ev-roster__pull-status--fail"
                        title={ps?.lastPullMessage ?? "County pull failed"}
                        aria-label="Pull failed"
                      >
                        ✗
                      </span>
                    )}
                    {isConfirmed && (
                      <span
                        className="enr-ev-roster__pull-status enr-ev-roster__pull-status--locked"
                        title="Confirmed — locked from re-pull and row replacement"
                        aria-label="Confirmed and locked"
                      >
                        🔒
                      </span>
                    )}
                    {rowPulling && <CountyPullSpinner label={`Pulling ${c.countyName}`} />}
                  </span>
                  {pullSucceeded && !isConfirmed && (
                    <button
                      type="button"
                      className="enr-ev-roster__confirm-pull"
                      disabled={isPullActive || confirming}
                      onClick={() =>
                        void doConfirm(
                          c.countyName,
                          countyKey,
                          ps?.votingDate ?? summaryDateTo,
                        )
                      }
                      title="Confirm this county’s pull — locks data so bulk pulls won’t replace it"
                    >
                      {confirming ? "Confirming…" : "Confirm"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`enr-ev-roster__edit-source${srcAction.isConfigured ? "" : " enr-ev-roster__edit-source--add"}`}
                    onClick={() => openTrainingForCounty(c.countyName)}
                    title={srcAction.title}
                  >
                    {srcAction.label}
                  </button>
                  {srcAction.isConfigured &&
                    (customSourcesByCountyKey.get(countyKey)?.length ?? 0) <
                      (countyKey === "collin" ? 4 : 2) && (
                    <button
                      type="button"
                      className="enr-ev-roster__edit-source enr-ev-roster__edit-source--add"
                      onClick={() => openTrainingForCounty(c.countyName, { newSource: true })}
                      title={
                        countyKey === "collin"
                          ? "Add Collin roster sources"
                          : "Add a second roster source (e.g. EV + BBM)"
                      }
                    >
                      + Add source
                    </button>
                  )}
                  <button
                    type="button"
                    className="enr-ev-roster__edit-source"
                    disabled={isPullActive || isConfirmed}
                    onClick={() => void doPull("county", countyKey)}
                    title={
                      isConfirmed
                        ? "County confirmed for this date — data is locked from re-pull"
                        : "Pull all enabled sources for this county only"
                    }
                  >
                    {pullingCountyKey === countyKey ? (
                      <>
                        <CountyPullSpinner label={`Pulling ${c.countyName}`} /> Pulling…
                      </>
                    ) : (
                      "Pull county"
                    )}
                  </button>
                </td>
                <td className="num">{formatNum(c.registeredVoters)}</td>
                <td className="num">{formatNum(c.inPersonVotesOnDate)}</td>
                <td className="num">{formatNum(c.totalInPersonVotesForElection)}</td>
                <td className="num">{formatNum(c.totalMailVotesForElection)}</td>
                <td className="num">{formatNum(c.cumulativeTotal)}</td>
                <td className="num">{formatNum(c.chosenVoterCount)}</td>
                <td>{c.chosenSource}</td>
              </tr>
            );
            })}
            {(summary?.counties?.length ?? 0) > 0 && (
              <tr className="enr-ev-roster__totals">
                <td>Statewide</td>
                <td className="num">{formatNum(totals.registeredVoters)}</td>
                <td className="num">{formatNum(totals.inPersonVotesOnDate)}</td>
                <td className="num">{formatNum(totals.totalInPersonVotesForElection)}</td>
                <td className="num">{formatNum(totals.totalMailVotesForElection)}</td>
                <td className="num">{formatNum(totals.cumulativeTotal)}</td>
                <td className="num">{formatNum(totals.chosenVoterCount)}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
        {displayedCounties.length > COUNTY_PAGE_SIZE && (
          <VoterPagination
            offset={countyPage * COUNTY_PAGE_SIZE}
            pageSize={COUNTY_PAGE_SIZE}
            total={displayedCounties.length}
            loading={summaryLoading}
            onPageChange={(next) => setCountyPage(Math.floor(next / COUNTY_PAGE_SIZE))}
          />
        )}
        {displayedCounties.length > 0 && displayedCounties.length <= COUNTY_PAGE_SIZE && (
          <p className="enr-muted enr-ev-roster__county-page-hint">
            {displayedCounties.length} {displayedCounties.length === 1 ? "county" : "counties"}
            {filter.trim() ? " matching filter" : ""}
          </p>
        )}
        {!summary && !loading && !summaryLoading && (
          <p className="enr-muted">No stored pulls yet. Click Pull all to load every early voting day through today for both parties.</p>
        )}
      </section>
      )}
    </div>
  );
}
