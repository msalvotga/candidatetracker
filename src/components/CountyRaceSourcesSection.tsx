import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsCollapse } from "./SettingsCollapse";
import {
  deleteCountyCandidateLink,
  fetchCountyRaceMapping,
  fetchCountyRaceSources,
  saveCountyCandidateLink,
  type CountyRaceMappingPayload,
  type CountyRaceSourcesPayload,
} from "../lib/dataBackend";

const CIVIX_SECTION_LABELS: Record<string, string> = {
  Federal: "Federal",
  StateWide: "Statewide",
  Districted: "District",
  StateWideQ: "Statewide props",
};

function sosRaceOptionLabel(r: { name: string; section?: string }) {
  const sec = r.section ? (CIVIX_SECTION_LABELS[r.section] ?? r.section) : "";
  return sec ? `[${sec}] ${r.name}` : r.name;
}

function matchStatusLabel(status: string) {
  switch (status) {
    case "manual":
      return "Manual map";
    case "auto":
      return "Auto-match";
    case "unmatched":
      return "Unmatched";
    case "no_feed":
      return "No feed data";
    default:
      return status;
  }
}

export function CountyRaceSourcesSection({
  electionId,
  usesCivixSos,
  busy,
  onMessage,
}: {
  electionId: string;
  usesCivixSos: boolean;
  busy: boolean;
  onMessage: (msg: string | null) => void;
}) {
  const [mappingLoading, setMappingLoading] = useState(false);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [mapping, setMapping] = useState<CountyRaceMappingPayload | null>(null);
  const [selectedRaceId, setSelectedRaceId] = useState("");
  const [sources, setSources] = useState<CountyRaceSourcesPayload | null>(null);

  const reloadMapping = useCallback(async () => {
    if (!usesCivixSos || !/^\d+$/.test(String(electionId))) return;
    setMappingLoading(true);
    try {
      setMapping(await fetchCountyRaceMapping(electionId));
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Failed to load SOS races");
    } finally {
      setMappingLoading(false);
    }
  }, [electionId, usesCivixSos, onMessage]);

  const reloadSources = useCallback(async () => {
    if (!selectedRaceId || !/^\d+$/.test(String(electionId))) {
      setSources(null);
      return;
    }
    setSourcesLoading(true);
    try {
      setSources(await fetchCountyRaceSources(electionId, selectedRaceId));
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Failed to load county source results");
      setSources(null);
    } finally {
      setSourcesLoading(false);
    }
  }, [electionId, selectedRaceId, onMessage]);

  useEffect(() => {
    void reloadMapping();
  }, [reloadMapping]);

  useEffect(() => {
    void reloadSources();
  }, [reloadSources]);

  const linkedRaceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const l of mapping?.links ?? []) ids.add(l.sosRaceId);
    return ids;
  }, [mapping?.links]);

  const sosRacesSorted = useMemo(() => {
    const order = ["Federal", "StateWide", "Districted", "StateWideQ", ""];
    return [...(mapping?.sosRaces ?? [])].sort((a, b) => {
      const oa = order.indexOf(a.section ?? "");
      const ob = order.indexOf(b.section ?? "");
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name, "en");
    });
  }, [mapping?.sosRaces]);

  const mappableRowsByCounty = useMemo(() => {
    const m = new Map<string, CountyRaceSourcesPayload["rows"]>();
    for (const row of sources?.rows ?? []) {
      if (!row.countyChoiceName) continue;
      const list = m.get(row.countyKey) ?? [];
      list.push(row);
      m.set(row.countyKey, list);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sources?.rows]);

  if (!usesCivixSos) return null;
  if (!/^\d+$/.test(String(electionId))) {
    return (
      <p className="enr-muted" style={{ marginTop: 16 }}>
        County source results are available for Civix/SOS elections (numeric election id).
      </p>
    );
  }

  async function onCandidateMap(
    row: CountyRaceSourcesPayload["rows"][number],
    sosCandidateId: string,
    sosCandidateName: string,
  ) {
    if (!selectedRaceId) return;
    try {
      if (!sosCandidateId) {
        await deleteCountyCandidateLink(electionId, row.countyKey, selectedRaceId, row.countyChoiceName);
        onMessage(`Cleared manual map for “${row.countyChoiceName}” in ${row.countyKey} — will use auto-match.`);
      } else {
        await saveCountyCandidateLink(electionId, {
          countyKey: row.countyKey,
          sosRaceId: selectedRaceId,
          countyChoiceName: row.countyChoiceName,
          sosCandidateId,
          sosCandidateName,
          countyContestName: row.countyContestName,
          linkType: "manual",
        });
        onMessage(`Mapped “${row.countyChoiceName}” → ${sosCandidateName}. Refresh election data to apply.`);
      }
      await reloadSources();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Save candidate map failed");
    }
  }

  const badge =
    sources && sources.rows.length
      ? sources.unmatchedCount
        ? `${sources.unmatchedCount} unmatched`
        : `${sources.rows.filter((r) => r.countyChoiceName).length} names`
      : linkedRaceIds.size
        ? `${linkedRaceIds.size} linked races`
        : undefined;

  return (
    <SettingsCollapse
      title="County candidate name mapping"
      badge={badge}
      className="enr-panel enr-settings__section enr-countyRaceSources"
    >
      <p className="enr-muted">
        Map county candidate names to SOS candidates when spellings differ (e.g. <em>John Smith</em> vs{" "}
        <em>SMITH, JOHN</em>). Manual maps override auto-match on the next refresh.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginTop: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 280 }}>
          <span className="enr-muted" style={{ fontSize: 13 }}>
            SOS race
          </span>
          <select
            className="enr-input"
            value={selectedRaceId}
            disabled={busy || mappingLoading}
            onChange={(e) => setSelectedRaceId(e.target.value)}
          >
            <option value="">Select race…</option>
            {sosRacesSorted.map((sr) => (
              <option key={sr.id} value={sr.id}>
                {sosRaceOptionLabel(sr)}
                {linkedRaceIds.has(sr.id) ? "" : " (no county links)"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="enr-secondaryBtn"
          disabled={busy || mappingLoading || sourcesLoading || !selectedRaceId}
          onClick={() => void reloadSources()}
        >
          {sourcesLoading ? "Loading…" : "Reload names"}
        </button>
      </div>

      {sources?.note ? (
        <p className="enr-muted" style={{ marginTop: 10, fontSize: 13 }}>
          {sources.note}
        </p>
      ) : null}
      {sources?.error ? (
        <p className="enr-muted" style={{ marginTop: 10, fontSize: 13 }}>
          {sources.error}
        </p>
      ) : null}

      {selectedRaceId && !sourcesLoading && sources && sources.links.length === 0 ? (
        <p className="enr-muted" style={{ marginTop: 12 }}>
          No counties linked to this race yet. Link county contests under{" "}
          <strong>County results → SOS races</strong> first.
        </p>
      ) : null}

      {selectedRaceId && sources && sources.links.length > 0 ? (
        <>
          {sources.sosRace.candidates.length ? (
            <p className="enr-muted" style={{ marginTop: 10, fontSize: 13 }}>
              SOS candidates:{" "}
              {sources.sosRace.candidates.map((c) => `${c.name} (${c.party || "—"})`).join(" · ")}
            </p>
          ) : null}

          {mappableRowsByCounty.length === 0 && !sourcesLoading ? (
            <p className="enr-muted" style={{ marginTop: 12 }}>
              No county candidate names found for linked contests yet.
            </p>
          ) : null}

          {mappableRowsByCounty.map(([countyKey, rows]) => (
            <SettingsCollapse
              key={countyKey}
              title={countyKey}
              badge={
                rows.some((r) => r.matchStatus === "unmatched" && r.countyChoiceName)
                  ? "needs map"
                  : rows.some((r) => r.matchStatus === "no_feed")
                    ? "no data"
                    : undefined
              }
              className="enr-countyRaceSources__county"
            >
              <div className="enr-tableWrap">
                <table className="enr-table enr-table--compact">
                  <thead>
                    <tr>
                      <th>County name</th>
                      <th>Party</th>
                      <th>Map to SOS candidate</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const rowKey = `${row.countyKey}-${row.countyContestName}-${row.countyChoiceName || "empty"}`;
                      const effectiveId =
                        row.linkedSosCandidateId || row.suggestedSosCandidateId || "";
                      return (
                        <tr key={rowKey}>
                          <td>
                            <strong>{row.countyChoiceName}</strong>
                            <span className="enr-muted" style={{ display: "block", fontSize: 12 }}>
                              {row.countyContestName}
                            </span>
                          </td>
                          <td>{row.partyName || "—"}</td>
                          <td>
                            <select
                              className="enr-input"
                              defaultValue={row.linkedSosCandidateId || ""}
                              disabled={busy}
                              id={`cand-map-${rowKey}`}
                            >
                              <option value="">
                                {row.suggestedSosCandidateId
                                  ? `Auto: ${row.suggestedSosCandidateName}`
                                  : "Unmatched — pick SOS candidate…"}
                              </option>
                              {sources.sosRace.candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} ({c.party || "—"})
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="enr-miniBtn"
                              disabled={busy}
                              onClick={() => {
                                const sel = document.getElementById(`cand-map-${rowKey}`) as HTMLSelectElement | null;
                                const id = sel?.value ?? "";
                                const cand = sources.sosRace.candidates.find((c) => c.id === id);
                                void onCandidateMap(row, id, cand?.name ?? "");
                              }}
                            >
                              Save
                            </button>
                            {row.linkedSosCandidateId && row.suggestedSosCandidateId ? (
                              <button
                                type="button"
                                className="enr-miniBtn"
                                disabled={busy}
                                onClick={() => void onCandidateMap(row, "", "")}
                              >
                                Use auto
                              </button>
                            ) : null}
                          </td>
                          <td>
                            <span
                              className={
                                row.matchStatus === "unmatched"
                                  ? "enr-badge enr-badge--warn"
                                  : row.matchStatus === "manual"
                                    ? "enr-badge enr-badge--ok"
                                    : "enr-badge"
                              }
                            >
                              {matchStatusLabel(row.matchStatus)}
                            </span>
                            {row.matchStatus === "auto" && effectiveId ? (
                              <span className="enr-muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
                                → {row.effectiveSosCandidateName || row.suggestedSosCandidateName}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SettingsCollapse>
          ))}
        </>
      ) : null}
    </SettingsCollapse>
  );
}
