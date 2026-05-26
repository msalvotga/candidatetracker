import { useCallback, useEffect, useMemo, useState } from "react";
import {
  discoverCountyFeedUrl,
  discoverCountyFeedUrlsBulk,
  fetchElectionFeedSources,
  fetchHubDiscoveryCountyKeys,
  forceRefreshWithBrowserCivix,
  startIngestStatusPoll,
  saveElectionFeedSources,
  updateElectionSourceConfig,
  type ElectionFeedSourceRow,
  type ElectionSourceConfig,
  type ImportLogPayload,
  type IngestProcess,
  type IngestProgress,
  type SourceImportLatest,
} from "../lib/dataBackend";
import { parseBulkCountyFeedLines } from "../lib/countyFeedBulkParse";
import {
  formatIngestResultSummary,
  IngestProgressStatus,
  IngestResultTimings,
  IngestSpinner,
} from "./IngestProgressStatus";
import type { IngestStepTiming } from "../lib/dataBackend";
import { CountyRaceMappingSection } from "./CountyRaceMappingSection";
import { SettingsCollapse } from "./SettingsCollapse";
import { TX_CIVIX_DEFAULT_COUNTYINFO_PREFIX, civixDefaultCountyInfoUrl } from "../lib/civix/urls";
import { TEXAS_COUNTIES, TEXAS_COUNTY_KEY_SET } from "../lib/texasCounties";

function SourceImportAlert({
  sourceKey,
  latestBySource,
}: {
  sourceKey: string;
  latestBySource: Record<string, SourceImportLatest> | undefined;
}) {
  const st = latestBySource?.[sourceKey];
  if (!st || st.ok) return null;
  return (
    <span className="enr-importWarn" title={st.message}>
      Last import failed ({new Date(st.occurredAt).toLocaleString()})
    </span>
  );
}

type FeedDraft = Pick<
  ElectionFeedSourceRow,
  "countyKey" | "vendorId" | "sourceUrl" | "hubPageUrl" | "isEnabled" | "civixCountyName" | "preferOverSos"
>;

function feedRowKey(r: FeedDraft) {
  return `${r.countyKey.toLowerCase().trim()}|${r.vendorId}`;
}

function hasFeedUrl(r: Pick<FeedDraft, "sourceUrl">) {
  return !!String(r.sourceUrl ?? "").trim();
}

function hasHubPage(r: Pick<FeedDraft, "hubPageUrl">) {
  return !!String(r.hubPageUrl ?? "").trim();
}

/** Row has something worth showing/editing (feed URL and/or hub page). */
function hasFeedOrHub(r: Pick<FeedDraft, "sourceUrl" | "hubPageUrl">) {
  return hasFeedUrl(r) || hasHubPage(r);
}

function mapSourceToFeedDraft(s: ElectionFeedSourceRow): FeedDraft {
  const sourceUrl = s.sourceUrl ?? "";
  return {
    countyKey: s.countyKey,
    vendorId: s.vendorId,
    sourceUrl,
    hubPageUrl: s.hubPageUrl ?? "",
    isEnabled: hasFeedUrl({ sourceUrl }),
    civixCountyName: s.civixCountyName ?? "",
    preferOverSos: !!s.preferOverSos,
  };
}

function patchFeedRow(row: FeedDraft, patch: Partial<FeedDraft>): FeedDraft {
  const next = { ...row, ...patch };
  if ("sourceUrl" in patch) {
    next.isEnabled = hasFeedUrl(next);
  }
  return next;
}

/** Bulk-add column 3: what to paste as the feed URL (not the hub page). */
const BULK_FEED_URL_HINTS: Partial<Record<string, string>> = {
  "harris-pdf": "Direct HTTPS link to the Harris cumulative results PDF.",
  "clarity-enr-summary-zip":
    "Clarity ENR page or direct link to summary.zip (ElectionSystems — imports all contests in the ZIP).",
  "montgomery-eresults-html":
    "Full browser URL from elections.mctx.org while the results page is loaded (not the Election Central landing page alone).",
  "dallas-pdf": "Dallas Votes Electionware “Summary Results Report” PDF (final election night).",
  "collin-pdf":
    "Collin Electionware early-voting summary PDF, e.g. collincountytx.gov/.../early-voting-summary-report.pdf",
  "cameron-pdf":
    "Electionware summary PDF when posted, or SOS reconciliation PDF e.g. cameroncountytx.gov/.../P26-preliminary-reconciliation-REP.pdf",
  "hays-pdf":
    "Hays egovlink.com official cumulative PDF, e.g. …/Cumulative Results - Democratic Party - official.pdf (one PDF per party).",
  "mclennan-pdf":
    "McLennan CivicPlus cumulative PDF, e.g. tx-mclennancounty.civicplus.com/DocumentCenter/View/…/Republican-Party---Cumulative-Results-….pdf",
  "ellis-enr-html":
    "Ellis livevoterturnout ENR Index URL, e.g. livevoterturnout.com/ENR/ellistxenr/9/en/Index_9.html (use the address bar while results are showing).",
  "chambers-pdf": "Chambers cumulative results PDF.",
  "other-vendor": "Any URL to document the source (no automated ingest yet).",
};

export function ElectionSettingsDetail({
  cfg,
  allElections,
  vendors,
  importLog,
  onBack,
  onSaved,
}: {
  cfg: ElectionSourceConfig;
  allElections: ElectionSourceConfig[];
  vendors: IngestProcess[];
  importLog: ImportLogPayload | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const feedDraftStorageKey = `enr:feed-draft:${cfg.electionId}`;
  const electionId = cfg.electionId;
  const [busy, setBusy] = useState(false);
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [lastIngestTimings, setLastIngestTimings] = useState<IngestStepTiming[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [label, setLabel] = useState(cfg.label);
  const [isEnabled, setIsEnabled] = useState(cfg.isEnabled);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(cfg.autoRefreshEnabled);
  const [showInCatalog, setShowInCatalog] = useState(cfg.showInCatalog !== false);
  const [usesCivixSos, setUsesCivixSos] = useState(cfg.usesCivixSos !== false);
  const [sosCountyInfoUrl, setSosCountyInfoUrl] = useState(cfg.sosCountyInfoUrl);
  const [feeds, setFeeds] = useState<FeedDraft[]>([]);
  /** Optional pasted page HTML when the hub cannot be fetched (e.g. WAF); not persisted. */
  const [hubHtmlDrafts, setHubHtmlDrafts] = useState<string[]>([]);
  const [bulkText, setBulkText] = useState("");
  const [bulkHubText, setBulkHubText] = useState("");
  const [hubDiscoveryCountyKeys, setHubDiscoveryCountyKeys] = useState<string[]>([]);
  const [copyFromElectionId, setCopyFromElectionId] = useState("");
  const [copyFeedsMode, setCopyFeedsMode] = useState<"replace" | "merge">("replace");
  const [hideNoFeedUrl, setHideNoFeedUrl] = useState(true);

  const visibleFeedIndices = useMemo(() => {
    return feeds
      .map((_, i) => i)
      .filter((i) => !hideNoFeedUrl || hasFeedOrHub(feeds[i]));
  }, [feeds, hideNoFeedUrl]);

  const hiddenNoUrlCount = useMemo(() => feeds.filter((r) => !hasFeedOrHub(r)).length, [feeds]);

  const copySourceOptions = useMemo(
    () => allElections.filter((e) => e.electionId !== electionId).sort((a, b) => a.label.localeCompare(b.label, "en")),
    [allElections, electionId],
  );

  useEffect(() => {
    setLabel(cfg.label);
    setIsEnabled(cfg.isEnabled);
    setAutoRefreshEnabled(cfg.autoRefreshEnabled);
    setShowInCatalog(cfg.showInCatalog !== false);
    setUsesCivixSos(cfg.usesCivixSos !== false);
    setSosCountyInfoUrl(cfg.sosCountyInfoUrl);
  }, [cfg.electionId, cfg.label, cfg.isEnabled, cfg.autoRefreshEnabled, cfg.showInCatalog, cfg.usesCivixSos, cfg.sosCountyInfoUrl]);

  const reloadFeeds = useCallback(async () => {
    const { sources } = await fetchElectionFeedSources(electionId);
    const mapped = sources.map(mapSourceToFeedDraft);
    setFeeds(mapped);
    try {
      localStorage.setItem(feedDraftStorageKey, JSON.stringify(mapped));
    } catch {
      /* ignore localStorage errors */
    }
  }, [electionId, feedDraftStorageKey]);

  useEffect(() => {
    void reloadFeeds().catch(() => {
      try {
        const raw = localStorage.getItem(feedDraftStorageKey);
        if (!raw) {
          setMsg("Could not load county feeds right now. Try reload.");
          return;
        }
        const parsed = JSON.parse(raw) as FeedDraft[];
        if (!Array.isArray(parsed)) {
          setMsg("Could not load county feeds right now. Try reload.");
          return;
        }
        setFeeds(parsed);
        setMsg("Loaded county feed draft from local cache (server read failed).");
      } catch {
        setMsg("Could not load county feeds right now. Try reload.");
      }
    });
  }, [reloadFeeds]);

  useEffect(() => {
    try {
      localStorage.setItem(feedDraftStorageKey, JSON.stringify(feeds));
    } catch {
      /* ignore localStorage errors */
    }
  }, [feedDraftStorageKey, feeds]);

  useEffect(() => {
    setHubHtmlDrafts((prev) => {
      const next = prev.slice(0, feeds.length);
      while (next.length < feeds.length) next.push("");
      return next;
    });
  }, [feeds.length]);

  useEffect(() => {
    void fetchHubDiscoveryCountyKeys()
      .then((p) => setHubDiscoveryCountyKeys(p.countyKeys))
      .catch(() => setHubDiscoveryCountyKeys([]));
  }, []);

  function mergeBulkHubLines(lines: ReturnType<typeof parseBulkCountyFeedLines>) {
    if (!lines.length) return 0;
    setFeeds((prev) => {
      const byKey = new Map(prev.map((r, i) => [feedRowKey(r), i]));
      const next = [...prev];
      for (const line of lines) {
        const key = `${line.countyKey}|${line.vendorId}`;
        const idx = byKey.get(key);
        if (idx != null) {
          next[idx] = { ...next[idx], hubPageUrl: line.url };
        } else {
          const row: FeedDraft = {
            countyKey: line.countyKey,
            vendorId: line.vendorId,
            sourceUrl: "",
            hubPageUrl: line.url,
            isEnabled: false,
            civixCountyName: "",
            preferOverSos: false,
          };
          byKey.set(key, next.length);
          next.push(row);
        }
      }
      return next;
    });
    return lines.length;
  }

  function applyBulkHubs() {
    const lines = parseBulkCountyFeedLines(bulkHubText);
    if (!lines.length) {
      setMsg(
        "No valid hub lines. Each line: county_key,process_id,https://hub-page-url (election results listing page, not the PDF).",
      );
      return;
    }
    mergeBulkHubLines(lines);
    setBulkHubText("");
    setMsg(`Set hub page URL on ${lines.length} row(s) — click “Discover feed URLs from hubs” then Save county feeds.`);
  }

  async function discoverFeedUrlsFromAllHubs() {
    const items = feeds
      .map((r, idx) => ({
        countyKey: r.countyKey.toLowerCase().trim(),
        vendorId: r.vendorId,
        hubUrl: r.hubPageUrl.trim(),
        html: (hubHtmlDrafts[idx] ?? "").trim() || undefined,
        rowIdx: idx,
      }))
      .filter((x) => x.countyKey && x.hubUrl);
    if (!items.length) {
      setMsg("No rows with both a county and a hub page URL. Bulk-add hubs or enter them in the table first.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const { results, okCount, total } = await discoverCountyFeedUrlsBulk({
        items: items.map(({ countyKey, vendorId, hubUrl, html }) => ({ countyKey, vendorId, hubUrl, html })),
      });
      const failures: string[] = [];
      setFeeds((prev) => {
        const next = [...prev];
        for (let i = 0; i < items.length; i++) {
          const hit = results[i];
          const { rowIdx, countyKey } = items[i];
          if (!hit) continue;
          if (hit.url) {
            next[rowIdx] = patchFeedRow(next[rowIdx], { sourceUrl: hit.url });
          } else {
            failures.push(`${countyKey}: ${hit.error ?? hit.message ?? "no match"}`);
          }
        }
        return next;
      });
      const skipNote =
        hubDiscoveryCountyKeys.length && items.some((it) => !hubDiscoveryCountyKeys.includes(it.countyKey))
          ? ` Auto-discovery profiles: ${hubDiscoveryCountyKeys.join(", ")} — other counties need a feed URL set manually.`
          : "";
      if (okCount > 0) {
        setMsg(
          `Discovered feed URL for ${okCount} of ${total} hub row(s).${failures.length ? ` Failed: ${failures.slice(0, 4).join("; ")}${failures.length > 4 ? "…" : ""}` : ""} Click Save county feeds to persist.${skipNote}`,
        );
      } else {
        setMsg(
          failures.length
            ? `No feed URLs discovered. ${failures.slice(0, 5).join("; ")}${failures.length > 5 ? "…" : ""}${skipNote}`
            : `No feed URLs discovered.${skipNote}`,
        );
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Bulk discover failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCopyCountyFeeds(saveAfterCopy: boolean) {
    const fromId = copyFromElectionId.trim();
    if (!fromId) {
      setMsg("Choose an election to copy county feeds from.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const { sources } = await fetchElectionFeedSources(fromId);
      const copied = sources.map(mapSourceToFeedDraft);
      if (!copied.length) {
        setMsg(`Election ${fromId} has no county feeds to copy.`);
        return;
      }
      let next: FeedDraft[];
      if (copyFeedsMode === "replace") {
        next = copied;
      } else {
        const existingKeys = new Set(feeds.map(feedRowKey));
        next = [...feeds, ...copied.filter((r) => !existingKeys.has(feedRowKey(r)))];
      }
      setFeeds(next);
      setHubHtmlDrafts(next.map(() => ""));
      if (saveAfterCopy) {
        const saved = await saveElectionFeedSources(electionId, next);
        setMsg(
          saved.warning
            ? `Copied ${copied.length} feed(s) from ${fromId} and saved. ${saved.warning}`
            : `Copied ${copied.length} feed(s) from ${fromId} and saved.`,
        );
        onSaved();
      } else {
        setMsg(
          `Copied ${copied.length} feed(s) from ${fromId} into the table (${copyFeedsMode === "replace" ? "replaced" : "merged"}). Click Save county feeds to persist.`,
        );
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Copy county feeds failed");
    } finally {
      setBusy(false);
    }
  }

  function setDefaultCountyFeed(idx: number) {
    const key = feeds[idx]?.countyKey?.toLowerCase().trim();
    if (!key) {
      setMsg("Select a county before setting a default feed.");
      return;
    }
    setFeeds((prev) =>
      prev.map((r, i) => ({
        ...r,
        preferOverSos: i === idx ? true : r.countyKey.toLowerCase().trim() === key ? false : r.preferOverSos,
      })),
    );
    setMsg(null);
  }

  async function onSaveElectionMeta() {
    setBusy(true);
    setMsg(null);
    try {
      await updateElectionSourceConfig(electionId, {
        label,
        isEnabled,
        autoRefreshEnabled,
        showInCatalog,
        usesCivixSos,
        sosCountyInfoUrl,
        harrisSourceUrl: cfg.harrisSourceUrl,
        galvestonSourceUrl: cfg.galvestonSourceUrl,
        jeffersonSourceUrl: cfg.jeffersonSourceUrl,
        montgomerySourceUrl: cfg.montgomerySourceUrl,
        chambersSourceUrl: cfg.chambersSourceUrl,
      });
      setMsg("Saved election settings.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveFeeds() {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await saveElectionFeedSources(electionId, feeds);
      setMsg(
        saved.warning
          ? `Saved county feed list. ${saved.warning}`
          : "Saved county feed list to the database.",
      );
      try {
        localStorage.setItem(feedDraftStorageKey, JSON.stringify(feeds));
      } catch {
        /* ignore localStorage errors */
      }
      await reloadFeeds();
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save feeds failed");
    } finally {
      setBusy(false);
    }
  }

  function addFeedRow() {
    setHideNoFeedUrl(false);
    setFeeds((p) => [
      ...p,
      {
        countyKey: "",
        vendorId: "other-vendor",
        sourceUrl: "",
        hubPageUrl: "",
        isEnabled: false,
        civixCountyName: "",
        preferOverSos: false,
      },
    ]);
    setMsg("New row added — pick a county and process, then Save county feeds.");
  }

  function applyBulk() {
    const parsed = parseBulkCountyFeedLines(bulkText);
    const added: FeedDraft[] = parsed.map((line) => ({
      countyKey: line.countyKey,
      vendorId: line.vendorId,
      sourceUrl: line.url,
      hubPageUrl: "",
      isEnabled: hasFeedUrl({ sourceUrl: line.url }),
      civixCountyName: "",
      preferOverSos: false,
    }));
    if (!added.length) {
      setMsg(
        "No valid bulk lines. Each line needs three parts: county_key,process_id,https://feed-url (see Bulk add help). Use bulk hub pages below for listing URLs.",
      );
      return;
    }
    setHideNoFeedUrl(false);
    setFeeds((prev) => [...prev, ...added]);
    setBulkText("");
    setMsg(`Added ${added.length} row(s) from bulk — click “Save county feeds” to persist.`);
  }

  async function fillUrlFromHub(rowIdx: number) {
    const hub = (feeds[rowIdx]?.hubPageUrl ?? "").trim();
    const countyKey = feeds[rowIdx]?.countyKey ?? "";
    if (!countyKey) {
      setMsg("Select a county before discovering the feed URL.");
      return;
    }
    if (!hub) {
      setMsg("Enter the hub page URL (the page that lists results file links).");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const pasted = (hubHtmlDrafts[rowIdx] ?? "").trim();
      const result = await discoverCountyFeedUrl({
        hubUrl: hub,
        countyKey,
        ...(pasted ? { html: pasted } : {}),
      });
      if (result.url) {
        setFeeds((prev) => prev.map((r, i) => (i === rowIdx ? patchFeedRow(r, { sourceUrl: result.url! }) : r)));
        setMsg(
          `Filled feed URL from hub (${result.matchedLabel ?? result.matchedStage ?? "matched link"}).`,
        );
      } else {
        setMsg(result.message ?? "No matching link found — feed URL left unchanged.");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Discover failed");
    } finally {
      setBusy(false);
    }
  }

  async function onForce() {
    setForceRefreshing(true);
    setMsg(null);
    setLastIngestTimings(null);
    setIngestProgress({ detail: `Starting ingest for ${electionId}…` });
    const stopPoll = startIngestStatusPoll((st) => {
      if (st.progress) setIngestProgress(st.progress);
      else if (st.running) setIngestProgress((prev) => prev ?? { detail: "Updating sources…" });
    });
    try {
      const result = await forceRefreshWithBrowserCivix(
        electionId,
        usesCivixSos && /^\d+$/.test(String(electionId))
          ? {
              countyInfoUrl: sosCountyInfoUrl,
              onProgress: (detail) => setIngestProgress((prev) => ({ ...prev, detail })),
            }
          : undefined,
      );
      const warn = result.warnings?.length ? ` Note: ${result.warnings.join(" | ")}` : "";
      const summary = formatIngestResultSummary(result);
      setMsg(
        result.errors.length
          ? `Refresh finished with errors. ${summary} ${result.errors.join(" | ")}${warn}`
          : `OK. ${summary}${warn}`,
      );
      setLastIngestTimings(result.stepTimings ?? null);
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      stopPoll();
      setForceRefreshing(false);
      setIngestProgress(null);
    }
  }

  const countiesSortedByLabel = useMemo(
    () => [...TEXAS_COUNTIES].sort((a, b) => a.label.localeCompare(b.label, "en")),
    [],
  );

  const countyVendors = useMemo(
    () => vendors.filter((v) => v.handlerKey !== "civix_sos" && v.id !== "montgomery-pdf"),
    [vendors],
  );
  const enrVendors = useMemo(
    () =>
      countyVendors
        .filter((v) => v.vendorTier === "enr")
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "en")),
    [countyVendors],
  );
  const otherVendors = useMemo(
    () =>
      countyVendors
        .filter((v) => v.vendorTier !== "enr")
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "en")),
    [countyVendors],
  );

  const bulkProcessHelp = useMemo(
    () =>
      [...enrVendors, ...otherVendors].sort((a, b) => a.displayName.localeCompare(b.displayName, "en")),
    [enrVendors, otherVendors],
  );

  return (
    <>
      <header className="enr-top">
        <div className="enr-top__row">
          <div className="enr-brand">Texas election night tracker</div>
          <div className="enr-top__center">
            <span className="enr-official enr-official--muted">Election sources</span>
          </div>
        </div>
      </header>
      <nav className="enr-nav">
        <div className="enr-nav__left">
          <button type="button" className="enr-navlink" onClick={onBack}>
            ← Back to settings
          </button>
        </div>
      </nav>
      <main className="enr-main enr-main--settings">
        <div className="enr-settings">
          <h1 className="enr-settings__title">
            {label} <span className="enr-muted">({electionId})</span>
          </h1>
          {msg ? <p className={msg.startsWith("OK") || msg.includes("Saved") ? "enr-saveOk" : "enr-errorInline"}>{msg}</p> : null}

          <section className="enr-panel enr-settings__section">
            <h2>Election &amp; SOS (Civix)</h2>
            <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={usesCivixSos} onChange={(e) => setUsesCivixSos(e.target.checked)} disabled={busy} />
              <span>
                <strong>Texas SOS / Civix ingest</strong> — fetch statewide Civix election JSON and SOS countyInfo for
                this id during ingest. Uncheck for elections that are <em>not</em> driven from SOS (county feeds only).
              </span>
            </label>
            {usesCivixSos ? (
              <p className="enr-muted">
                Civix election id: <strong>{electionId}</strong> — main catalog id <code>civix:{electionId}</code>.
              </p>
            ) : (
              <p className="enr-muted">
                Internal election id: <strong>{electionId}</strong> — main catalog id{" "}
                <code>election:{encodeURIComponent(electionId)}</code> (county-feed results only).
              </p>
            )}
            <label className="enr-field">
              Display label
              <input className="enr-input" value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
            </label>
            <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} disabled={busy} />
              Enable ingest for this election
            </label>
            <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={autoRefreshEnabled}
                onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
                disabled={busy}
              />
              Include in automatic refresh cycle
            </label>
            <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={showInCatalog}
                onChange={(e) => setShowInCatalog(e.target.checked)}
                disabled={busy}
              />
              <span>
                <strong>Show on main page</strong> — include this election in the home election dropdown. Uncheck to keep
                it out of the list while leaving ingest settings unchanged.
              </span>
            </label>
            {usesCivixSos ? (
              <label className="enr-field">
                <span className="enr-fieldLabelRow">
                  <span>SOS countyInfo URL (optional override)</span>
                  <SourceImportAlert sourceKey={`${electionId}:sos`} latestBySource={importLog?.latestBySource} />
                </span>
                {civixDefaultCountyInfoUrl(electionId) ? (
                  <div className="enr-settingsReadonlyUrl" style={{ marginBottom: 8 }}>
                    <span className="enr-muted">Default Civix countyInfo (only the id suffix changes per election):</span>
                    <code className="enr-settingsReadonlyUrl__code">
                      <span className="enr-settingsReadonlyUrl__fixed">{TX_CIVIX_DEFAULT_COUNTYINFO_PREFIX}</span>
                      <span className="enr-settingsReadonlyUrl__id">{electionId}</span>
                    </code>
                  </div>
                ) : null}
                <input
                  className="enr-input"
                  placeholder="Leave blank for Civix default"
                  value={sosCountyInfoUrl}
                  onChange={(e) => setSosCountyInfoUrl(e.target.value)}
                  disabled={busy}
                />
              </label>
            ) : (
              <p className="enr-muted">SOS / Civix ingest is off — only configured county feeds will run on refresh.</p>
            )}
            <div className="enr-settings__actions">
              <button type="button" className="enr-primaryBtn" disabled={busy} onClick={() => void onSaveElectionMeta()}>
                Save election settings
              </button>
              <button
                type="button"
                className="enr-primaryBtn"
                disabled={busy || forceRefreshing}
                onClick={() => void onForce()}
              >
                {forceRefreshing ? (
                  <>
                    <IngestSpinner label="Updating sources" /> Updating…
                  </>
                ) : (
                  "Force update (SOS + counties)"
                )}
              </button>
            </div>
            {forceRefreshing ? (
              <IngestProgressStatus progress={ingestProgress} fallback={`Updating election ${electionId}…`} />
            ) : null}
            {lastIngestTimings?.length && !forceRefreshing ? (
              <IngestResultTimings stepTimings={lastIngestTimings} />
            ) : null}
          </section>

          <SettingsCollapse
            title="County feeds"
            badge={feeds.filter((r) => hasFeedOrHub(r)).length || feeds.length}
            className="enr-panel enr-settings__section"
          >
            <p className="enr-muted">
              <strong>Montgomery:</strong> use process <strong>Montgomery County eResults (live HTML)</strong> and paste the
              full browser URL while results are on screen (paths change between elections — you can start from{" "}
              <a href="https://elections.mctx.org/index.asp" target="_blank" rel="noreferrer">
                Election Central
              </a>
              ). Use <strong>Set as default</strong> on that row if Civix SOS totals are wrong for Montgomery.
            </p>
            <p className="enr-muted">
              Each row is a <strong>county</strong> result source (Harris PDF, Clarity ZIP, etc.). These are{" "}
              <strong>not</strong> Civix endpoints — the only Civix-related path in this app is statewide <strong>SOS</strong>{" "}
              above. Choose the county from the dropdown (stored as the ingest <code>county_key</code> slug).{" "}
              <strong>Match name</strong> is optional — leave blank to align county rows to Civix using the slug (e.g.{" "}
              <code>travis</code> → TRAVIS) when you also use SOS data. For counties with hub discovery (
              {hubDiscoveryCountyKeys.length ? hubDiscoveryCountyKeys.join(", ") : "e.g. dallas, harris"}), paste election{" "}
              <strong>hub page</strong> URLs (bulk or per row), run <strong>Discover feed URLs from hubs</strong>, then{" "}
              <strong>Save county feeds</strong>. Ingest uses the saved <strong>Feed URL</strong> only — it does not re-fetch hubs on
              refresh.
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              Counties are listed <strong>A–Z</strong> by name (not by map/FIPS order).{" "}
              <strong>Montgomery County</strong> appears under <strong>M</strong>. Choose{" "}
              <strong>Montgomery County eResults (live HTML)</strong> and paste the address-bar URL after the results page loads.
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              <strong>Collin County:</strong> use process <strong>Collin County (Electionware EV summary PDF)</strong> and paste
              the early-voting summary PDF URL (e.g.{" "}
              <code>collincountytx.gov/.../early-voting-summary-report.pdf</code>).
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              <strong>Cameron County:</strong> use <strong>Cameron County (results / reconciliation PDF)</strong>. Paste the SOS
              preliminary reconciliation PDF (e.g.{" "}
              <code>P26-preliminary-reconciliation-REP.pdf</code> on cameroncountytx.gov) for turnout totals, or an Electionware
              summary PDF when posted for per-contest results. Reconciliation PDFs alone do not include SD4 candidate lines — use
              Texas SOS for SD4 unless Cameron posts an election-night summary with contests.
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              <strong>Hays County:</strong> use <strong>Hays County (eGovlink cumulative PDF)</strong> and paste the official
              cumulative PDF from egovlink.com (e.g.{" "}
              <code>…/Cumulative Results - Democratic Party - official.pdf</code>). Hays posts separate Democratic and Republican
              PDFs — add one feed row per party PDF you want ingested.
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              <strong>McLennan County:</strong> use <strong>McLennan County (CivicPlus cumulative PDF)</strong> and paste the
              official cumulative PDF URL from CivicPlus (e.g.{" "}
              <code>tx-mclennancounty.civicplus.com/DocumentCenter/View/…/Cumulative-Results-….pdf</code>). One row per party
              PDF. Link contests to SOS races in <strong>County results → SOS races</strong> below.
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              <strong>Ellis County:</strong> use <strong>Ellis County (livevoterturnout ENR HTML)</strong> and paste the full{" "}
              <code>Index_*.html</code> URL from the browser while results are on screen (e.g.{" "}
              <code>livevoterturnout.com/ENR/ellistxenr/9/en/Index_9.html</code>). The page lists per-precinct tables;
              ingest sums them to county-wide totals for every contest on that election.
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              <strong>On</strong> starts off for new rows and turns on automatically when you enter a feed URL. Only counties with
              a URL are included on refresh when <strong>On</strong> is checked.
              {usesCivixSos ? (
                <>
                  {" "}
                  <strong>Prefer over SOS</strong> applies only when this election uses Texas SOS / Civix ingest and you have
                  more than one feed for the same county — it picks which county file wins over statewide SOS totals for that
                  county.
                </>
              ) : null}
            </p>
            {copySourceOptions.length > 0 ? (
              <div className="enr-copyFeedsBar">
                <label className="enr-field">
                  Copy county feeds from
                  <select
                    className="enr-input"
                    value={copyFromElectionId}
                    onChange={(e) => setCopyFromElectionId(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">Select election…</option>
                    {copySourceOptions.map((e) => (
                      <option key={e.electionId} value={e.electionId}>
                        {e.label} ({e.electionId})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="enr-copyFeedsBar__mode" role="group" aria-label="Copy mode">
                  <label>
                    <input
                      type="radio"
                      name="copyFeedsMode"
                      checked={copyFeedsMode === "replace"}
                      onChange={() => setCopyFeedsMode("replace")}
                      disabled={busy}
                    />
                    Replace all rows
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="copyFeedsMode"
                      checked={copyFeedsMode === "merge"}
                      onChange={() => setCopyFeedsMode("merge")}
                      disabled={busy}
                    />
                    Add missing only (same county + process)
                  </label>
                </div>
                <button
                  type="button"
                  className="enr-secondaryBtn"
                  disabled={busy || !copyFromElectionId}
                  onClick={() => void onCopyCountyFeeds(false)}
                >
                  Copy into table
                </button>
                <button
                  type="button"
                  className="enr-primaryBtn"
                  disabled={busy || !copyFromElectionId}
                  onClick={() => void onCopyCountyFeeds(true)}
                >
                  Copy and save
                </button>
              </div>
            ) : (
              <p className="enr-muted">Add another election under Source configuration to copy its county feeds here.</p>
            )}
            <div className="enr-countyFeedsToolbar">
              <label className="enr-inlineToggle">
                <input
                  type="checkbox"
                  checked={hideNoFeedUrl}
                  onChange={(e) => setHideNoFeedUrl(e.target.checked)}
                  disabled={busy}
                />
                <span>Hide empty rows (no feed URL or hub page)</span>
              </label>
              <span className="enr-muted" style={{ fontSize: 13 }}>
                Showing {visibleFeedIndices.length} of {feeds.length}
                {hideNoFeedUrl && hiddenNoUrlCount > 0 ? ` (${hiddenNoUrlCount} hidden)` : ""}
              </span>
            </div>
            <div className="enr-tablewrap">
              <table className="enr-table">
                <thead>
                  <tr>
                    <th>County</th>
                    <th>Civix name (opt.)</th>
                    <th>Process</th>
                    <th>Hub page</th>
                    <th>Feed URL</th>
                    {usesCivixSos ? (
                      <th title="When multiple feeds exist for one county, use this row instead of Texas SOS / Civix countyInfo for that county in SD4 merge">
                        Prefer over SOS
                      </th>
                    ) : null}
                    <th title="County feed is included on refresh when On is checked and a feed URL is present">
                      On
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleFeedIndices.length === 0 ? (
                    <tr>
                      <td colSpan={usesCivixSos ? 8 : 7} className="enr-muted">
                        {feeds.length === 0
                          ? "No county feeds yet — add a row or copy from another election."
                          : "All rows are hidden (no feed URL or hub). Uncheck the filter above or add hub/feed URLs."}
                      </td>
                    </tr>
                  ) : null}
                  {visibleFeedIndices.map((idx) => {
                    const row = feeds[idx];
                    return (
                    <tr key={idx} className={!hasFeedUrl(row) ? "enr-feedRow--noUrl" : undefined}>
                      <td>
                        <select
                          className="enr-input"
                          style={{ minWidth: 220 }}
                          value={row.countyKey}
                          onChange={(e) => {
                            const countyKey = e.target.value;
                            setFeeds((prev) =>
                              prev.map((r, i) => {
                                if (i !== idx) return r;
                                let vendorId = r.vendorId;
                                if (countyKey === "collin" && (vendorId === "other-vendor" || !vendorId)) {
                                  vendorId = "collin-pdf";
                                }
                                if (countyKey === "cameron" && (vendorId === "other-vendor" || !vendorId)) {
                                  vendorId = "cameron-pdf";
                                }
                                if (countyKey === "hays" && (vendorId === "other-vendor" || !vendorId)) {
                                  vendorId = "hays-pdf";
                                }
                                if (countyKey === "mclennan" && (vendorId === "other-vendor" || !vendorId)) {
                                  vendorId = "mclennan-pdf";
                                }
                                if (countyKey === "ellis" && (vendorId === "other-vendor" || !vendorId)) {
                                  vendorId = "ellis-enr-html";
                                }
                                return { ...r, countyKey, vendorId };
                              }),
                            );
                          }}
                          disabled={busy}
                        >
                          <option value="">Select county…</option>
                          {row.countyKey && !TEXAS_COUNTY_KEY_SET.has(row.countyKey) ? (
                            <option value={row.countyKey}>{row.countyKey} (custom)</option>
                          ) : null}
                          {countiesSortedByLabel.map((c) => (
                            <option key={c.fips} value={c.key}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="enr-input"
                          placeholder="Auto"
                          value={row.civixCountyName}
                          onChange={(e) =>
                            setFeeds((prev) => prev.map((r, i) => (i === idx ? { ...r, civixCountyName: e.target.value } : r)))
                          }
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <select
                          className="enr-input"
                          value={row.vendorId}
                          onChange={(e) =>
                            setFeeds((prev) => prev.map((r, i) => (i === idx ? { ...r, vendorId: e.target.value } : r)))
                          }
                          disabled={busy}
                        >
                          <optgroup label="Supported ingest processes">
                            {enrVendors.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.displayName}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="Other / placeholder">
                            {otherVendors.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.displayName}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      </td>
                      <td style={{ minWidth: 200 }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            className="enr-input"
                            style={{ flex: "1 1 140px", minWidth: 120 }}
                            placeholder="County results listing"
                            value={row.hubPageUrl}
                            onChange={(e) =>
                              setFeeds((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, hubPageUrl: e.target.value } : r)),
                              )
                            }
                            disabled={busy}
                          />
                          <button
                            type="button"
                            className="enr-navlink"
                            disabled={busy}
                            title="County-specific: e.g. Dallas Final→9pm→7pm; Harris Live Results → Election Cumulative Report."
                            onClick={() => void fillUrlFromHub(idx)}
                          >
                            Fill URL
                          </button>
                        </div>
                        <details style={{ marginTop: 6 }}>
                          <summary className="enr-muted" style={{ cursor: "pointer", fontSize: "0.88rem" }}>
                            Paste HTML if the hub fetch is blocked
                          </summary>
                          <textarea
                            className="enr-textarea"
                            rows={3}
                            style={{ marginTop: 6, width: "100%", boxSizing: "border-box" }}
                            placeholder="View Page Source on the hub, paste here — hub URL above must still match that page (for resolving links)."
                            value={hubHtmlDrafts[idx] ?? ""}
                            onChange={(e) =>
                              setHubHtmlDrafts((prev) => {
                                const next = [...prev];
                                next[idx] = e.target.value;
                                return next;
                              })
                            }
                            disabled={busy}
                          />
                        </details>
                      </td>
                      <td style={{ minWidth: 220 }}>
                        <input
                          className="enr-input"
                          value={row.sourceUrl}
                          onChange={(e) =>
                            setFeeds((prev) =>
                              prev.map((r, i) => (i === idx ? patchFeedRow(r, { sourceUrl: e.target.value }) : r)),
                            )
                          }
                          disabled={busy}
                        />
                      </td>
                      {usesCivixSos ? (
                        <td style={{ whiteSpace: "nowrap" }}>
                          {row.preferOverSos ? (
                            <span
                              className="enr-defaultBadge"
                              title="This feed is preferred over SOS / Civix countyInfo for this county"
                            >
                              Preferred
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="enr-secondaryBtn"
                              disabled={busy || !row.countyKey.trim()}
                              title="Use this feed instead of SOS / Civix countyInfo for this county when both exist"
                              onClick={() => setDefaultCountyFeed(idx)}
                            >
                              Prefer over SOS
                            </button>
                          )}
                        </td>
                      ) : null}
                      <td>
                        <input
                          type="checkbox"
                          checked={row.isEnabled}
                          onChange={(e) =>
                            setFeeds((prev) => prev.map((r, i) => (i === idx ? { ...r, isEnabled: e.target.checked } : r)))
                          }
                          disabled={busy || !hasFeedUrl(row)}
                          title={
                            hasFeedUrl(row)
                              ? "Include this county feed on refresh"
                              : "Add a feed URL first — On turns on automatically when a URL is entered"
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="enr-secondaryBtn"
                          disabled={busy}
                          onClick={() => setFeeds((p) => p.filter((_, i) => i !== idx))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="enr-settings__actions">
              <button type="button" className="enr-primaryBtn" disabled={busy} onClick={addFeedRow}>
                Add row
              </button>
              <button type="button" className="enr-primaryBtn" disabled={busy} onClick={() => void onSaveFeeds()}>
                Save county feeds
              </button>
              <button
                type="button"
                className="enr-secondaryBtn"
                disabled={busy}
                title="Fetch each hub page and fill Feed URL for rows that have a hub (Dallas/Harris profiles today)"
                onClick={() => void discoverFeedUrlsFromAllHubs()}
              >
                Discover feed URLs from hubs
              </button>
              <span className="enr-muted" style={{ fontSize: 13, alignSelf: "center" }}>
                Required for feeds to survive restart — also written to <code>election-feed-configs.json</code> when the
                main database is too large to flush immediately.
              </span>
            </div>
            <SettingsCollapse title="Bulk add hub pages" className="enr-bulkAdd">
              <p className="enr-muted">
                Paste <strong>one hub per line</strong> — the election results <em>listing</em> page where file links appear (not the
                PDF). Same format as bulk feeds, but column 3 is the <strong>Hub page</strong> URL. Updates existing rows or adds new
                ones (feed URL can stay empty until you discover).
              </p>
              <p className="enr-bulkAdd__format">
                <code>county_key</code>,<code>process_id</code>,<code>https://…hub…</code>
              </p>
              <pre className="enr-bulkAdd__examples" aria-hidden="true">
                {`dallas,dallas-pdf,https://www.dallascountyvotes.org/election-results/
harris,harris-pdf,https://www.harrisvotes.com/election-results/`}
              </pre>
              <label className="enr-field">
                Hub lines
                <textarea
                  className="enr-textarea"
                  rows={4}
                  value={bulkHubText}
                  onChange={(e) => setBulkHubText(e.target.value)}
                  disabled={busy}
                  placeholder={
                    "dallas,dallas-pdf,https://www.dallascountyvotes.org/election-results/\n" +
                    "harris,harris-pdf,https://www.harrisvotes.com/election-results/"
                  }
                />
              </label>
              <div className="enr-settings__actions" style={{ marginTop: 8 }}>
                <button type="button" className="enr-primaryBtn" disabled={busy} onClick={applyBulkHubs}>
                  Apply hubs to table
                </button>
                <button
                  type="button"
                  className="enr-secondaryBtn"
                  disabled={busy}
                  onClick={() => {
                    const lines = parseBulkCountyFeedLines(bulkHubText);
                    if (!lines.length) {
                      setMsg("Paste hub lines first, or use Apply hubs to table.");
                      return;
                    }
                    mergeBulkHubLines(lines);
                    setBulkHubText("");
                    void discoverFeedUrlsFromAllHubs();
                  }}
                >
                  Apply hubs &amp; discover feed URLs
                </button>
              </div>
              <p className="enr-muted" style={{ marginTop: 8, fontSize: 13 }}>
                After discovery, click <strong>Save county feeds</strong>. Use per-row <strong>Fill URL</strong> or pasted HTML when a
                hub fetch is blocked (WAF).
              </p>
            </SettingsCollapse>
            <SettingsCollapse title="Bulk add county feeds" className="enr-bulkAdd">
              <p className="enr-muted">
                Paste <strong>one feed per line</strong>. Commas separate the first two fields only; if the URL contains
                commas, everything after the second comma is treated as the URL.
              </p>
              <p className="enr-bulkAdd__format">
                <code>county_key</code>,<code>process_id</code>,<code>https://…</code>
              </p>
              <dl className="enr-bulkAdd__fields">
                <div>
                  <dt>
                    <code>county_key</code>
                  </dt>
                  <dd>
                    Lowercase county slug — same value as the <strong>County</strong> dropdown (
                    <code>collin</code>, <code>cameron</code>, <code>montgomery</code>, <code>harris</code>, etc.). Not
                    the display name (“Collin County”).
                  </dd>
                </div>
                <div>
                  <dt>
                    <code>process_id</code>
                  </dt>
                  <dd>
                    Exact ingest process ID from the <strong>Process</strong> column (e.g. <code>collin-pdf</code>,{" "}
                    <code>cameron-pdf</code>) — not the long label shown in the dropdown.
                  </dd>
                </div>
                <div>
                  <dt>Feed URL</dt>
                  <dd>
                    Full <code>https://</code> link to the file or live results page the ingest pulls from — PDF, HTML
                    page URL, or Clarity <code>summary.zip</code>. This is <strong>Feed URL</strong> in the table — use{" "}
                    <strong>Bulk add hub pages</strong> above for listing pages. Rows turn <strong>On</strong> automatically when a
                    feed URL is present.
                  </dd>
                </div>
              </dl>
              <details className="enr-bulkAdd__processes">
                <summary>Process IDs and what to put in the URL column</summary>
                <ul className="enr-bulkAdd__processList">
                  {bulkProcessHelp.map((v) => (
                    <li key={v.id}>
                      <code>{v.id}</code> — {BULK_FEED_URL_HINTS[v.id] ?? v.notes}
                    </li>
                  ))}
                </ul>
              </details>
              <p className="enr-muted enr-bulkAdd__examplesTitle">Examples (one line each):</p>
              <pre className="enr-bulkAdd__examples" aria-hidden="true">
                {`collin,collin-pdf,https://www.collincountytx.gov/.../early-voting-summary-report.pdf
cameron,cameron-pdf,https://www.cameroncountytx.gov/elections/.../P26-preliminary-reconciliation-REP.pdf
hays,hays-pdf,https://www.egovlink.com/.../Cumulative%20Results%20-%20Democratic%20Party%20-%20official.pdf
mclennan,mclennan-pdf,https://tx-mclennancounty.civicplus.com/DocumentCenter/View/.../Cumulative-Results-....pdf
ellis,ellis-enr-html,https://www.livevoterturnout.com/ENR/ellistxenr/9/en/Index_9.html
montgomery,montgomery-eresults-html,https://elections.mctx.org/...`}
              </pre>
              <label className="enr-field">
                Lines to add
                <textarea
                  className="enr-textarea"
                  rows={5}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  disabled={busy}
                  placeholder={
                    "collin,collin-pdf,https://www.collincountytx.gov/.../early-voting-summary-report.pdf\n" +
                    "cameron,cameron-pdf,https://www.cameroncountytx.gov/elections/.../P26-preliminary-reconciliation-REP.pdf\n" +
                    "hays,hays-pdf,https://www.egovlink.com/.../Cumulative%20Results%20-%20Democratic%20Party%20-%20official.pdf\n" +
                    "ellis,ellis-enr-html,https://www.livevoterturnout.com/ENR/ellistxenr/9/en/Index_9.html"
                  }
                />
              </label>
              <button type="button" className="enr-primaryBtn" disabled={busy} onClick={applyBulk}>
                Apply feed URLs to table
              </button>
              <p className="enr-muted" style={{ marginTop: 8, fontSize: 13 }}>
                After applying, click <strong>Save county feeds</strong> so URLs survive a server restart.
              </p>
            </SettingsCollapse>
          </SettingsCollapse>

          <CountyRaceMappingSection
            electionId={electionId}
            usesCivixSos={usesCivixSos}
            busy={busy}
            onMessage={setMsg}
          />
        </div>
      </main>
    </>
  );
}
