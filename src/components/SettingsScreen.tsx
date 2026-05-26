import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forceRefreshWithBrowserCivix,
  startIngestStatusPoll,
  fetchDbTablePreview,
  fetchDbOverview,
  fetchElectionSourceConfigs,
  fetchAppSettings,
  fetchImportLog,
  fetchIngestVendors,
  createElectionSourceConfig,
  deleteElectionSourceConfig,
  setDefaultElectionCatalog,
  updateElectionSourceConfig,
  updateAppSettings,
  prepareCivixConnect,
  clearCivixConnect,
  type AppSettings,
  type CivixConnectPrepare,
  type DbTablePreview,
  type DbOverview,
  type ElectionSourceConfig,
  type ImportLogPayload,
  type IngestProcess,
  type IngestProgress,
  type SourceImportLatest,
} from "../lib/dataBackend";
import { ElectionSettingsDetail } from "./ElectionSettingsDetail";
import {
  formatIngestResultSummary,
  IngestProgressStatus,
  IngestResultTimings,
  IngestSpinner,
} from "./IngestProgressStatus";
import type { IngestStepTiming } from "../lib/dataBackend";
import { SettingsCollapse } from "./SettingsCollapse";

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

export function SettingsScreen({
  onBack,
  onCatalogChanged,
  backendLabel,
}: {
  onBack: () => void;
  onCatalogChanged: () => void;
  backendLabel: string;
}) {
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dbOverview, setDbOverview] = useState<DbOverview | null>(null);
  const [dataSourcesPreview, setDataSourcesPreview] = useState<DbTablePreview | null>(null);
  const [sosCountyPreview, setSosCountyPreview] = useState<DbTablePreview | null>(null);
  const [dbPreviewErr, setDbPreviewErr] = useState<string | null>(null);
  const [electionsLoadErr, setElectionsLoadErr] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>({
    disableAutoIngest: false,
    autoRefreshEnabled: false,
    autoRefreshIntervalSec: 60,
    displayTimeZone: "America/Chicago",
    sosCountyInfoUrl: "",
    harrisSourceUrl: "",
    galvestonSourceUrl: "",
    jeffersonSourceUrl: "",
    montgomerySourceUrl: "",
    chambersSourceUrl: "",
    civixCookieConfigured: false,
  });
  const [civixConnect, setCivixConnect] = useState<CivixConnectPrepare | null>(null);
  const [forceMsg, setForceMsg] = useState<string | null>(null);
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);
  const [lastIngestTimings, setLastIngestTimings] = useState<IngestStepTiming[] | null>(null);
  const [importLog, setImportLog] = useState<ImportLogPayload | null>(null);
  const [electionConfigs, setElectionConfigs] = useState<ElectionSourceConfig[]>([]);
  const [selectedElectionId, setSelectedElectionId] = useState<string>("");
  const userPickedForceElection = useRef(false);
  const [detailElectionId, setDetailElectionId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<IngestProcess[]>([]);
  const [newElectionId, setNewElectionId] = useState("");
  const [newElectionLabel, setNewElectionLabel] = useState("");
  const [newElectionUsesSos, setNewElectionUsesSos] = useState(true);

  const refresh = useCallback(async () => {
    setElectionsLoadErr(null);
    try {
      const configs = await fetchElectionSourceConfigs();
      setElectionConfigs(configs.elections);
      const defaultCfg =
        configs.elections.find((c) => c.isDefaultCatalog) ?? configs.elections[0];
      const defaultId = defaultCfg?.electionId ?? "";
      if (!userPickedForceElection.current && defaultId) {
        setSelectedElectionId(defaultId);
      } else if (selectedElectionId && !configs.elections.some((c) => c.electionId === selectedElectionId)) {
        setSelectedElectionId(defaultId);
      }
    } catch (e) {
      setElectionConfigs([]);
      setElectionsLoadErr(
        e instanceof Error
          ? e.message
          : "Could not load saved elections — is the API running on port 3847?",
      );
    }

    try {
      const [db, settings, dsPreview, sosPreview, log, vend] = await Promise.all([
        fetchDbOverview(),
        fetchAppSettings(),
        fetchDbTablePreview("data_sources", 25),
        fetchDbTablePreview("sos_county_results", 25),
        fetchImportLog(250).catch(() => null),
        fetchIngestVendors().catch(() => ({ vendors: [] as IngestProcess[] })),
      ]);
      setDbOverview(db);
      setAppSettings(settings);
      setDataSourcesPreview(dsPreview);
      setSosCountyPreview(sosPreview);
      setImportLog(log);
      setVendors(vend.vendors);
      setDbPreviewErr(null);
    } catch (e) {
      setDbPreviewErr(e instanceof Error ? e.message : "Failed to load DB preview");
    }
  }, [selectedElectionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onToggleAutoIngest(nextDisabled: boolean) {
    setBusy(true);
    setSaveMsg(null);
    try {
      const updated = await updateAppSettings({ disableAutoIngest: nextDisabled });
      setAppSettings(updated);
      setSaveMsg(updated.disableAutoIngest ? "Auto ingest disabled." : "Auto ingest enabled.");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to update setting");
    } finally {
      setBusy(false);
    }
  }

  async function onPrepareCivixConnect() {
    setBusy(true);
    setSaveMsg(null);
    try {
      setCivixConnect(await prepareCivixConnect());
      setSaveMsg("Follow the steps below to link Civix once (bookmarklet).");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to prepare Civix link");
    } finally {
      setBusy(false);
    }
  }

  async function onClearCivixConnect() {
    setBusy(true);
    setSaveMsg(null);
    try {
      await clearCivixConnect();
      setCivixConnect(null);
      const settings = await fetchAppSettings();
      setAppSettings(settings);
      setSaveMsg("Civix link removed. Force update will use the last SOS snapshot until you link again.");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to clear Civix link");
    } finally {
      setBusy(false);
    }
  }

  async function onUpdateAutoRefresh(nextEnabled: boolean, nextIntervalSec: number) {
    setBusy(true);
    setSaveMsg(null);
    try {
      const updated = await updateAppSettings({
        disableAutoIngest: appSettings.disableAutoIngest,
        autoRefreshEnabled: nextEnabled,
        autoRefreshIntervalSec: Math.max(15, Number(nextIntervalSec) || 60),
        displayTimeZone: appSettings.displayTimeZone ?? "America/Chicago",
        sosCountyInfoUrl: appSettings.sosCountyInfoUrl ?? "",
        harrisSourceUrl: appSettings.harrisSourceUrl ?? "",
        galvestonSourceUrl: appSettings.galvestonSourceUrl ?? "",
        jeffersonSourceUrl: appSettings.jeffersonSourceUrl ?? "",
        montgomerySourceUrl: appSettings.montgomerySourceUrl ?? "",
        chambersSourceUrl: appSettings.chambersSourceUrl ?? "",
      });
      setAppSettings(updated);
      setSaveMsg("Auto refresh settings saved.");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to update auto refresh settings");
    } finally {
      setBusy(false);
    }
  }

  async function onForceRefresh() {
    setForceRefreshing(true);
    setForceMsg(null);
    setLastIngestTimings(null);
    setIngestProgress({ detail: `Starting update for election ${selectedElectionId}…` });
    const stopPoll = startIngestStatusPoll((st) => {
      if (st.progress) setIngestProgress(st.progress);
      else if (st.running) {
        setIngestProgress((prev) => prev ?? { detail: "Updating sources…" });
      }
    });
    try {
      const cfg = electionConfigs.find((c) => c.electionId === selectedElectionId);
      const result = await forceRefreshWithBrowserCivix(
        selectedElectionId,
        cfg?.usesCivixSos !== false && /^\d+$/.test(selectedElectionId)
          ? {
              countyInfoUrl: cfg?.sosCountyInfoUrl,
              onProgress: (detail) => setIngestProgress((prev) => ({ ...prev, detail })),
            }
          : undefined,
      );
      await refresh();
      onCatalogChanged();
      const base = `Updated election ${selectedElectionId}. ${formatIngestResultSummary(result)}`;
      const warn =
        result.warnings?.length ? ` Note: ${result.warnings.join(" | ")}` : "";
      const err = result.errors.length ? ` Errors: ${result.errors.join(" | ")}` : "";
      setForceMsg(`${base}${warn}${err}`);
      setLastIngestTimings(result.stepTimings ?? null);
    } catch (e) {
      setForceMsg(e instanceof Error ? e.message : "Force refresh failed");
    } finally {
      stopPoll();
      setForceRefreshing(false);
      setIngestProgress(null);
    }
  }

  async function onSetDefaultElection(cfg: ElectionSourceConfig) {
    if (cfg.isDefaultCatalog) return;
    setBusy(true);
    setSaveMsg(null);
    try {
      await setDefaultElectionCatalog(cfg.electionId);
      userPickedForceElection.current = false;
      setSelectedElectionId(cfg.electionId);
      await refresh();
      onCatalogChanged();
      setSaveMsg(`Default selection set to ${cfg.label}.`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to set default election");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleAutoRefreshForElection(cfg: ElectionSourceConfig, next: boolean) {
    setBusy(true);
    setSaveMsg(null);
    try {
      await updateElectionSourceConfig(cfg.electionId, { autoRefreshEnabled: next });
      setElectionConfigs((prev) => prev.map((x) => (x.electionId === cfg.electionId ? { ...x, autoRefreshEnabled: next } : x)));
      setSaveMsg(`Auto refresh ${next ? "on" : "off"} for ${cfg.label} (${cfg.electionId}).`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to update auto refresh");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteElection(cfg: ElectionSourceConfig) {
    const ok = window.confirm(
      `Delete "${cfg.label}" (${cfg.electionId})?\n\nThis removes the source configuration, county feeds, SOS/county results, and import log entries for this election.`,
    );
    if (!ok) return;
    setBusy(true);
    setSaveMsg(null);
    try {
      await deleteElectionSourceConfig(cfg.electionId);
      if (detailElectionId === cfg.electionId) setDetailElectionId(null);
      if (selectedElectionId === cfg.electionId) userPickedForceElection.current = false;
      await refresh();
      onCatalogChanged();
      setSaveMsg(`Deleted election ${cfg.electionId}.`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to delete election");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateElection() {
    const label = newElectionLabel.trim();
    let id = newElectionId.trim();
    if (newElectionUsesSos) {
      if (!/^\d+$/.test(id)) {
        setSaveMsg("Civix election id must be numeric when SOS / Civix ingest is enabled.");
        return;
      }
    } else {
      if (!label) {
        setSaveMsg("Label is required for county-only (non-SOS) elections.");
        return;
      }
      id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    setBusy(true);
    setSaveMsg(null);
    try {
      await createElectionSourceConfig({
        electionId: id,
        label: label || undefined,
        usesCivixSos: newElectionUsesSos,
      });
      setNewElectionId("");
      setNewElectionLabel("");
      setNewElectionUsesSos(true);
      await refresh();
      onCatalogChanged();
      setSaveMsg(`Created election ${id}. Open it below to add county feeds.`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Failed to create election");
    } finally {
      setBusy(false);
    }
  }

  const filteredTables = useMemo(
    () =>
      (dbOverview?.tables ?? []).filter((t) => t.name === "data_sources" || t.name === "sos_county_results"),
    [dbOverview],
  );

  function renderPreviewTable(preview: DbTablePreview | null, emptyLabel: string) {
    if (!preview) return <p className="enr-muted">Loading preview…</p>;
    if (!preview.rows.length) return <p className="enr-muted">{emptyLabel}</p>;
    const columns = preview.columns;
    return (
      <div className="enr-tablewrap">
        <table className="enr-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, idx) => (
              <tr key={idx}>
                {columns.map((c) => (
                  <td key={`${idx}-${c}`}>{String(row[c] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const detailCfg = detailElectionId ? electionConfigs.find((c) => c.electionId === detailElectionId) : undefined;
  if (detailCfg) {
    return (
      <ElectionSettingsDetail
        cfg={detailCfg}
        allElections={electionConfigs}
        vendors={vendors}
        importLog={importLog}
        onBack={() => setDetailElectionId(null)}
        onSaved={() => {
          void refresh();
          onCatalogChanged();
        }}
      />
    );
  }

  return (
    <>
      <header className="enr-top">
        <div className="enr-top__row">
          <div className="enr-brand">Texas election night tracker</div>
          <div className="enr-top__center">
            <span className="enr-official enr-official--muted">Settings</span>
          </div>
          <div className="enr-top__right">
            <span className="enr-backendPill" title="Data loading mode">
              {backendLabel}
            </span>
          </div>
        </div>
      </header>

      <nav className="enr-nav">
        <div className="enr-nav__left">
          <button type="button" className="enr-navlink" onClick={onBack}>
            Home
          </button>
          <span className="enr-navlink is-active" aria-current="page">
            Settings
          </span>
        </div>
      </nav>

      <main className="enr-main enr-main--settings">
        <div className="enr-settings">
          <h1 className="enr-settings__title">Data &amp; ingest</h1>
          {saveMsg ? (
            <p className={saveMsg.includes("failed") || saveMsg.includes("Failed") ? "enr-errorInline" : "enr-saveOk"}>{saveMsg}</p>
          ) : null}

          <section className="enr-panel enr-settings__section">
        <h2>Ingest controls</h2>
        <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={appSettings.disableAutoIngest}
            disabled={busy}
            onChange={(e) => void onToggleAutoIngest(e.target.checked)}
          />
          Disable auto ingest (prevents page/API refresh from appending SOS/county rows to DB)
        </label>
        <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={!!appSettings.autoRefreshEnabled}
            disabled={busy}
            onChange={(e) => void onUpdateAutoRefresh(e.target.checked, Number(appSettings.autoRefreshIntervalSec ?? 60))}
          />
          Enable automatic refresh cycle (clear + repull all sources each interval)
        </label>
        <p className="enr-muted" style={{ marginTop: -4, marginBottom: 12 }}>
          Timed refresh runs the same full ingest as <strong>Force update (SOS + counties)</strong> on the server (live
          Civix when possible, then each enabled county feed). If a run is still in progress when the next interval hits,
          that cycle is skipped.
        </p>
        <label className="enr-field">
          Auto refresh interval (seconds)
          <input
            className="enr-input"
            type="number"
            min={15}
            step={1}
            value={Number(appSettings.autoRefreshIntervalSec ?? 60)}
            onChange={(e) =>
              setAppSettings((s) => ({ ...s, autoRefreshIntervalSec: Math.max(15, Number(e.target.value) || 60) }))
            }
            onBlur={() =>
              void onUpdateAutoRefresh(!!appSettings.autoRefreshEnabled, Number(appSettings.autoRefreshIntervalSec ?? 60))
            }
          />
        </label>
        <label className="enr-field">
          Display time zone
          <select
            className="enr-input"
            value={appSettings.displayTimeZone ?? "America/Chicago"}
            onChange={(e) => setAppSettings((s) => ({ ...s, displayTimeZone: e.target.value }))}
            onBlur={() =>
              void onUpdateAutoRefresh(!!appSettings.autoRefreshEnabled, Number(appSettings.autoRefreshIntervalSec ?? 60))
            }
          >
            <option value="America/Chicago">America/Chicago (Central, DST)</option>
            <option value="America/New_York">America/New_York (Eastern, DST)</option>
            <option value="America/Denver">America/Denver (Mountain, DST)</option>
            <option value="America/Los_Angeles">America/Los_Angeles (Pacific, DST)</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
        <div className="enr-field">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Texas SOS / Civix (live statewide on Render)</div>
          <p className="enr-muted" style={{ margin: "0 0 8px" }}>
            <strong>Force update</strong> fetches the same Civix JSON as the SOS reporting site and updates county
            feeds — no extra steps required. <strong>Link Civix</strong> is optional (only if Civix blocks your
            server host, e.g. some cloud deploys).
          </p>
          {appSettings.civixCookieConfigured ? (
            <p className="enr-saveOk" style={{ margin: "0 0 8px", fontSize: 13 }}>
              Server Civix cookie is also saved (bookmarklet).
            </p>
          ) : null}
          <div className="enr-settings__actions" style={{ flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="enr-secondaryBtn" disabled={busy} onClick={() => void onPrepareCivixConnect()}>
              {appSettings.civixCookieConfigured ? "Renew Civix link" : "Link Civix (one time)"}
            </button>
            {appSettings.civixCookieConfigured ? (
              <button type="button" className="enr-secondaryBtn" disabled={busy} onClick={() => void onClearCivixConnect()}>
                Unlink Civix
              </button>
            ) : null}
          </div>
          {civixConnect ? (
            <div className="enr-panel" style={{ marginTop: 12, padding: 12 }}>
              <ol className="enr-muted" style={{ margin: "0 0 12px", paddingLeft: 20 }}>
                {civixConnect.steps.map((s) => (
                  <li key={s} style={{ marginBottom: 6 }}>
                    {s}
                  </li>
                ))}
              </ol>
              <a className="enr-primaryBtn" href={civixConnect.bookmarklet} style={{ display: "inline-block", marginBottom: 8 }}>
                Link Civix — drag to bookmarks bar
              </a>
              <button
                type="button"
                className="enr-secondaryBtn"
                style={{ marginTop: 8 }}
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    setBusy(true);
                    try {
                      setAppSettings(await fetchAppSettings());
                      setSaveMsg("Refreshed link status.");
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                I clicked the bookmarklet — check status
              </button>
              <p className="enr-muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Token expires {new Date(civixConnect.expiresAt).toLocaleTimeString()}.
              </p>
            </div>
          ) : null}
        </div>
        <div className="enr-settings__actions">
          <select
            className="enr-input"
            value={selectedElectionId}
            disabled={busy}
            onChange={(e) => {
              userPickedForceElection.current = true;
              setSelectedElectionId(e.target.value);
            }}
            style={{ maxWidth: 360 }}
          >
            {electionConfigs.map((cfg) => (
              <option key={cfg.electionId} value={cfg.electionId}>
                {cfg.label} ({cfg.electionId})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="enr-primaryBtn"
            disabled={busy || forceRefreshing}
            onClick={() => void onForceRefresh()}
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
          <IngestProgressStatus
            progress={ingestProgress}
            fallback={`Updating election ${selectedElectionId}…`}
          />
        ) : null}
        {forceMsg ? <p className={forceMsg.startsWith("Updated") ? "enr-saveOk" : "enr-errorInline"}>{forceMsg}</p> : null}
        {lastIngestTimings?.length ? <IngestResultTimings stepTimings={lastIngestTimings} /> : null}
      </section>

      <section className="enr-panel enr-settings__section">
        <SettingsCollapse
          title="Ingest processes"
          badge={vendors.filter((v) => v.id !== "montgomery-pdf").length}
        >
        <p className="enr-muted">
          Each <strong>process</strong> is how a URL is fetched and parsed. Assign the <strong>same process id</strong> to
          every county that uses the same steps (e.g. all Clarity ENR <code>summary.zip</code> counties share{" "}
          <code>clarity-enr-summary-zip</code>). Initial import stores all contests from that format; when you combine
          totals across counties, match on contest/race then. <strong>Civix</strong> here is only the statewide{" "}
          <strong>SOS</strong> path. <em>ENR-style</em> processes are the usual Texas reporting patterns wired in;{" "}
          <em>Other</em> is documentation-only until a handler exists.
        </p>
        <p className="enr-muted" style={{ marginTop: 8 }}>
          <strong>Same pipeline, many counties:</strong> <code>clarity_enr_summary_zip</code> — Clarity{" "}
          <code>summary.zip</code> → full <code>summary.csv</code> (all contests). <strong>County-specific parsers:</strong>{" "}
          <code>montgomery_eresults_html</code> (Montgomery live web), <code>harris_pdf</code>, <code>chambers_pdf</code>, and{" "}
          <code>dallas_pdf</code> (Dallas Electionware), each with their own layout.
        </p>
        <div className="enr-tablewrap">
          <table className="enr-table">
            <thead>
              <tr>
                <th>Process id</th>
                <th>Tier</th>
                <th>Handler</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {vendors
                .filter((v) => v.id !== "montgomery-pdf")
                .map((v) => (
                <tr key={v.id}>
                  <td>
                    <code>{v.id}</code>
                    <div>{v.displayName}</div>
                  </td>
                  <td>{v.vendorTier === "enr" ? "ENR-style" : "Other"}</td>
                  <td>
                    <code>{v.handlerKey}</code>
                  </td>
                  <td className="enr-muted">{v.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </SettingsCollapse>
      </section>

      <section className="enr-panel enr-settings__section">
        <SettingsCollapse title="Elections" badge={electionConfigs.length}>
        <p className="enr-muted">
          Choose whether this election uses <strong>Texas SOS / Civix</strong> statewide ingest. When it does, enter the
          Civix election id; when it does not, only a label is required (an internal catalog key is created). Configure
          county feeds on the election detail page. The main page election dropdown lists{" "}
          <strong>every election you add here</strong> (plus manual JSON uploads), including county-only elections without a
          Civix id — unless you turn off <strong>Show on main page</strong> on the election detail screen.
        </p>
        <p className="enr-muted" style={{ marginTop: 8 }}>
          <strong>Note:</strong> Early voting <em>rosters</em> (runoff Dem/Rep Civix IDs 58314 / 58315) are separate from
          election-night results and are currently turned off to save memory. Re-add any missing election here if it does not
          appear below.
        </p>
        <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={newElectionUsesSos}
            onChange={(e) => {
              const on = e.target.checked;
              setNewElectionUsesSos(on);
              if (!on) setNewElectionId("");
            }}
            disabled={busy}
          />
          <span>
            This election uses <strong>Texas SOS / Civix</strong> ingest (statewide JSON + countyInfo). Uncheck if this
            election is <strong>not SOS-related</strong> — only county feeds will be ingested.
          </span>
        </label>
        <div className="enr-settings__actions" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          {newElectionUsesSos ? (
            <label className="enr-field" style={{ marginBottom: 0 }}>
              Civix election id
              <input
                className="enr-input"
                value={newElectionId}
                onChange={(e) => setNewElectionId(e.target.value)}
                placeholder="56181"
                disabled={busy}
              />
            </label>
          ) : null}
          <label className="enr-field" style={{ marginBottom: 0 }}>
            Label
            <input
              className="enr-input"
              value={newElectionLabel}
              onChange={(e) => setNewElectionLabel(e.target.value)}
              placeholder="May 2026 election"
              disabled={busy}
              style={{ minWidth: 220 }}
            />
          </label>
          <button type="button" className="enr-primaryBtn" disabled={busy} onClick={() => void onCreateElection()}>
            Add election
          </button>
        </div>
        </SettingsCollapse>
      </section>

      <section className="enr-panel enr-settings__section">
        <SettingsCollapse title="Source configuration" badge={electionConfigs.length}>
        <p className="enr-muted">
          Open an election for SOS / Civix options, county feed URLs, ingest processes, and bulk import. Use{" "}
          <strong>Set as default</strong> to choose which election opens first on the home page and in ingest controls below.
          Toggle auto refresh here without opening the detail page.
        </p>
        {electionsLoadErr ? (
          <p className="enr-errorInline" role="alert">
            {electionsLoadErr} — run <code>npm run server</code> and <code>npm run dev -- --mode proxy</code> (or{" "}
            <code>npm run dev:all</code>), wait for &quot;Database ready&quot;, then refresh.
          </p>
        ) : null}
        {!electionsLoadErr && electionConfigs.length === 0 ? (
          <p className="enr-muted">No elections saved yet. Add one above.</p>
        ) : null}
        <ul className="enr-manualList" style={{ marginTop: 12 }}>
          {electionConfigs.map((cfg) => (
            <li key={cfg.electionId} style={{ marginBottom: 12 }}>
              <button
                type="button"
                className="enr-electionOpenBtn"
                disabled={busy}
                onClick={() => setDetailElectionId(cfg.electionId)}
              >
                {cfg.label} <span className="enr-muted">({cfg.electionId})</span>
              </button>
              <SourceImportAlert sourceKey={`${cfg.electionId}:sos`} latestBySource={importLog?.latestBySource} />
              <div className="enr-settingsElectionMeta">
                <span className="enr-muted" style={{ fontSize: 12 }}>
                  {cfg.isDefaultCatalog ? (
                    <>
                      <strong>Default selection</strong>
                      {" · "}
                    </>
                  ) : null}
                  Ingest {cfg.isEnabled ? "on" : "off"}
                  {cfg.usesCivixSos !== false ? " · SOS/Civix on" : " · SOS/Civix off"}
                  {cfg.showInCatalog === false ? " · Hidden from home menu" : null}
                </span>
                {cfg.isDefaultCatalog ? (
                  <span className="enr-defaultBadge" title="Opens first on the home page and in ingest controls">
                    Home default
                  </span>
                ) : (
                  <button
                    type="button"
                    className="enr-secondaryBtn"
                    disabled={busy}
                    title="Pre-select this election on the home page and in ingest controls"
                    onClick={() => void onSetDefaultElection(cfg)}
                  >
                    Set as default
                  </button>
                )}
                <label className="enr-inlineToggle">
                  <input
                    type="checkbox"
                    checked={cfg.autoRefreshEnabled}
                    disabled={busy}
                    onChange={(e) => void onToggleAutoRefreshForElection(cfg, e.target.checked)}
                  />
                  <span>Include in automatic refresh</span>
                </label>
                <button
                  type="button"
                  className="enr-dangerBtn"
                  disabled={busy}
                  title="Remove this election configuration and its stored ingest data"
                  onClick={() => void onDeleteElection(cfg)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        </SettingsCollapse>
      </section>

      <section className="enr-panel enr-settings__section">
        <SettingsCollapse title="Import log" badge={importLog?.entries?.length ?? 0}>
        <p className="enr-muted">
          Per-source outcomes from the latest ingest runs (newest first). When one source fails, others still update and are
          logged here.
        </p>
        <div className="enr-importLog">
          {importLog?.entries?.length ? (
            <ul className="enr-manualList" style={{ marginTop: 8 }}>
              {importLog.entries.map((e) => (
                <li key={e.id}>
                  <strong>{e.sourceKey}</strong> {e.ok ? "OK" : "FAILED"} · {new Date(e.occurredAt).toLocaleString()} —{" "}
                  {e.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="enr-muted">No log entries yet. Run a refresh from ingest controls to populate.</p>
          )}
        </div>
        </SettingsCollapse>
      </section>

      <section className="enr-panel enr-settings__section">
        <h2>Database live view</h2>
        {dbOverview ? (
          <>
            <p>
              Engine: <strong>{dbOverview.database.engine}</strong> | Driver: <code>{dbOverview.database.driver}</code>
            </p>
            {dbOverview.database.path ? (
              <p>
                File: <code>{dbOverview.database.path}</code>
              </p>
            ) : null}
            {dbOverview.database.server ? (
              <p>
                Server: <code>{dbOverview.database.server}</code> | Database:{" "}
                <code>{dbOverview.database.database ?? "(default)"}</code>
              </p>
            ) : null}
            <h3>Table row counts</h3>
            <ul className="enr-manualList">
              {filteredTables.map((t) => (
                <li key={t.name}>
                  <code>{t.name}</code>: {t.rowCount.toLocaleString()}
                </li>
              ))}
            </ul>
            {dbPreviewErr ? <p className="enr-errorInline">{dbPreviewErr}</p> : null}
            <SettingsCollapse
              title="data_sources preview"
              badge={dataSourcesPreview?.rows?.length ?? "…"}
            >
              {renderPreviewTable(dataSourcesPreview, "data_sources has no rows.")}
            </SettingsCollapse>
            <SettingsCollapse
              title="sos_county_results preview"
              badge={sosCountyPreview?.rows?.length ?? "…"}
            >
              {renderPreviewTable(sosCountyPreview, "sos_county_results has no rows.")}
            </SettingsCollapse>
          </>
        ) : (
          <p>Loading DB metadata…</p>
        )}
      </section>
        </div>
      </main>
    </>
  );
}
