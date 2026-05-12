import { useCallback, useEffect, useMemo, useState } from "react";
import {
  discoverCountyFeedUrl,
  fetchElectionFeedSources,
  forceRefreshAllSources,
  saveElectionFeedSources,
  updateElectionSourceConfig,
  type ElectionFeedSourceRow,
  type ElectionSourceConfig,
  type ImportLogPayload,
  type IngestProcess,
  type SourceImportLatest,
} from "../lib/dataBackend";
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

export function ElectionSettingsDetail({
  cfg,
  vendors,
  importLog,
  onBack,
  onSaved,
}: {
  cfg: ElectionSourceConfig;
  vendors: IngestProcess[];
  importLog: ImportLogPayload | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const feedDraftStorageKey = `enr:feed-draft:${cfg.electionId}`;
  const electionId = cfg.electionId;
  const [busy, setBusy] = useState(false);
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
    const mapped = sources.map((s) => ({
      countyKey: s.countyKey,
      vendorId: s.vendorId,
      sourceUrl: s.sourceUrl,
      hubPageUrl: s.hubPageUrl ?? "",
      isEnabled: s.isEnabled,
      civixCountyName: s.civixCountyName ?? "",
      preferOverSos: !!s.preferOverSos,
    }));
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
      await saveElectionFeedSources(electionId, feeds);
      setMsg("Saved county feed list.");
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

  function applyBulk() {
    const lines = bulkText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const added: FeedDraft[] = [];
    for (const line of lines) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 3) continue;
      const [countyKey, vendorId, ...rest] = parts;
      const sourceUrl = rest.join(",").trim();
      if (!countyKey || !vendorId || !sourceUrl) continue;
      added.push({
        countyKey: countyKey.toLowerCase(),
        vendorId,
        sourceUrl,
        hubPageUrl: "",
        isEnabled: true,
        civixCountyName: "",
        preferOverSos: false,
      });
    }
    if (!added.length) {
      setMsg("No valid bulk lines. Use: county_key,process_id,url (one per line).");
      return;
    }
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
        setFeeds((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, sourceUrl: result.url! } : r)));
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
    setBusy(true);
    setMsg(null);
    try {
      const result = await forceRefreshAllSources(electionId);
      const countyParts = Object.entries(result.counties).map(([k, v]) => `${k}: ${v.inserted}`);
      setMsg(
        result.errors.length
          ? `Refresh finished with errors. SOS: ${result.sos.inserted}. ${countyParts.join(", ")}. ${result.errors.join(" | ")}`
          : `OK. SOS: ${result.sos.inserted}. Counties: ${countyParts.join(", ") || "(none)"}.`,
      );
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy(false);
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
              <button type="button" className="enr-primaryBtn" disabled={busy} onClick={() => void onForce()}>
                Force one-time ingest (this election)
              </button>
            </div>
          </section>

          <section className="enr-panel enr-settings__section">
            <h2>County feeds</h2>
            <p className="enr-muted">
              <strong>Montgomery:</strong> use process <strong>Montgomery County eResults (live HTML)</strong> and paste the
              full browser URL while results are on screen (paths change between elections — you can start from{" "}
              <a href="https://elections.mctx.org/index.asp" target="_blank" rel="noreferrer">
                Election Central
              </a>
              ). Turn on <strong>Feed &gt; SOS</strong> for that row if Civix SOS totals are wrong for Montgomery.
            </p>
            <p className="enr-muted">
              Each row is a <strong>county</strong> result source (Harris PDF, Clarity ZIP, etc.). These are{" "}
              <strong>not</strong> Civix endpoints — the only Civix-related path in this app is statewide <strong>SOS</strong>{" "}
              above. Choose the county from the dropdown (stored as the ingest <code>county_key</code> slug).{" "}
              <strong>Match name</strong> is optional — leave blank to align county rows to Civix using the slug (e.g.{" "}
              <code>travis</code> → TRAVIS) when you also use SOS data. For counties with hub discovery (e.g. Dallas timed reports;
              Harris Live Results → Election Cumulative Report), save a{" "}
              <strong>hub page</strong> URL — each refresh resolves the feed link from that page before pulling data, then stores the
              resolved URL in <strong>Feed URL</strong>.
            </p>
            <p className="enr-muted" style={{ marginTop: 8 }}>
              Counties are listed <strong>A–Z</strong> by name (not by map/FIPS order).{" "}
              <strong>Montgomery County</strong> appears under <strong>M</strong>. Choose{" "}
              <strong>Montgomery County eResults (live HTML)</strong> and paste the address-bar URL after the results page loads.
            </p>
            <div className="enr-tablewrap">
              <table className="enr-table">
                <thead>
                  <tr>
                    <th>County</th>
                    <th>Civix name (opt.)</th>
                    <th>Process</th>
                    <th>Hub page</th>
                    <th>Feed URL</th>
                    <th title="For SD4: use this county feed instead of Texas SOS / Civix countyInfo for this county">
                      Feed &gt; SOS
                    </th>
                    <th>On</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {feeds.map((row, idx) => (
                    <tr key={idx}>
                      <td>
                        <select
                          className="enr-input"
                          style={{ minWidth: 220 }}
                          value={row.countyKey}
                          onChange={(e) =>
                            setFeeds((prev) => prev.map((r, i) => (i === idx ? { ...r, countyKey: e.target.value } : r)))
                          }
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
                            setFeeds((prev) => prev.map((r, i) => (i === idx ? { ...r, sourceUrl: e.target.value } : r)))
                          }
                          disabled={busy}
                        />
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={row.preferOverSos}
                          title={
                            usesCivixSos
                              ? "Prefer this ingested feed over SOS / Civix countyInfo for SD4 in this county"
                              : "Enable Texas SOS / Civix ingest above for this option to apply when viewing Civix elections."
                          }
                          onChange={(e) =>
                            setFeeds((prev) =>
                              prev.map((r, i) => (i === idx ? { ...r, preferOverSos: e.target.checked } : r)),
                            )
                          }
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.isEnabled}
                          onChange={(e) =>
                            setFeeds((prev) => prev.map((r, i) => (i === idx ? { ...r, isEnabled: e.target.checked } : r)))
                          }
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <button type="button" className="enr-navlink" disabled={busy} onClick={() => setFeeds((p) => p.filter((_, i) => i !== idx))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="enr-settings__actions">
              <button
                type="button"
                className="enr-primaryBtn"
                disabled={busy}
                onClick={() =>
                  setFeeds((p) => [
                    ...p,
                    {
                      countyKey: "",
                      vendorId: "other-vendor",
                      sourceUrl: "",
                      hubPageUrl: "",
                      isEnabled: true,
                      civixCountyName: "",
                      preferOverSos: false,
                    },
                  ])
                }
              >
                Add row
              </button>
              <button type="button" className="enr-primaryBtn" disabled={busy} onClick={() => void onSaveFeeds()}>
                Save county feeds
              </button>
            </div>
            <label className="enr-field">
              Bulk add (one per line: <code>county_key,process_id,url</code>)
              <textarea
                className="enr-textarea"
                rows={4}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                disabled={busy}
                placeholder="harris,harris-pdf,https://..."
              />
            </label>
            <button type="button" className="enr-primaryBtn" disabled={busy} onClick={applyBulk}>
              Apply bulk to table
            </button>
          </section>
        </div>
      </main>
    </>
  );
}
