import { useCallback, useEffect, useMemo, useState } from "react";
import { ManualCountyVotesSection } from "./ManualCountyVotesSection";
import { SettingsCollapse } from "./SettingsCollapse";
import {
  deleteCountyRaceLink,
  fetchCountyRaceMapping,
  saveCountyRaceLink,
  saveCountyRaceVoteSource,
  type CountyRaceMappingPayload,
  type CountyVoteSource,
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

export function CountyRaceMappingSection({
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
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CountyRaceMappingPayload | null>(null);

  const reload = useCallback(async () => {
    if (!usesCivixSos || !/^\d+$/.test(String(electionId))) return;
    setLoading(true);
    try {
      setData(await fetchCountyRaceMapping(electionId));
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Failed to load county race mapping");
    } finally {
      setLoading(false);
    }
  }, [electionId, usesCivixSos, onMessage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const unlinkedByContest = useMemo(() => {
    const m = new Map<string, CountyRaceMappingPayload["unlinked"]>();
    for (const row of data?.unlinked ?? []) {
      const k = `${row.countyKey}\u0000${row.contestName}`;
      const list = m.get(k) ?? [];
      list.push(row);
      m.set(k, list);
    }
    return [...m.entries()];
  }, [data?.unlinked]);

  const voteSourceFor = (countyKey: string, sosRaceId: string): CountyVoteSource => {
    const hit = data?.voteSources?.find((s) => s.countyKey === countyKey && s.sosRaceId === sosRaceId);
    return (hit?.voteSource as CountyVoteSource) ?? "auto";
  };

  const sosRacesSorted = useMemo(() => {
    const order = ["Federal", "StateWide", "Districted", "StateWideQ", ""];
    return [...(data?.sosRaces ?? [])].sort((a, b) => {
      const oa = order.indexOf(a.section ?? "");
      const ob = order.indexOf(b.section ?? "");
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name, "en");
    });
  }, [data?.sosRaces]);

  if (!usesCivixSos) return null;
  if (!/^\d+$/.test(String(electionId))) {
    return (
      <p className="enr-muted" style={{ marginTop: 16 }}>
        County-to-SOS race mapping is available for Civix/SOS elections (numeric election id).
      </p>
    );
  }

  async function onLinkContest(
    countyKey: string,
    countyContestName: string,
    sosRaceId: string,
    sosRaceName: string,
  ) {
    try {
      await saveCountyRaceLink(electionId, {
        countyKey,
        countyContestName,
        sosRaceId,
        sosRaceName,
        linkType: "manual",
      });
      onMessage(`Linked “${countyContestName}” to SOS race. Totals use whichever source has more votes (SOS vs county feed) unless you override below.`);
      await reload();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Link failed");
    }
  }

  async function onSetVoteSource(countyKey: string, sosRaceId: string, voteSource: CountyVoteSource) {
    try {
      await saveCountyRaceVoteSource(electionId, { countyKey, sosRaceId, voteSource });
      onMessage(
        voteSource === "auto"
          ? `Vote source for ${countyKey} / race set to Auto (picks higher total).`
          : `Vote source for ${countyKey} / race set to ${voteSource}.`,
      );
      await reload();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Save vote source failed");
    }
  }

  const unlinkedCount = unlinkedByContest.length;
  const linkedCount = data?.links?.length ?? 0;

  return (
    <SettingsCollapse
      title="County results → SOS races"
      badge={unlinkedCount ? `${unlinkedCount} unlinked` : linkedCount ? `${linkedCount} linked` : undefined}
      className="enr-panel enr-settings__section enr-countyRaceMapping"
    >
      <p className="enr-muted">
        County PDF feeds import <strong>all</strong> contests in the file. Only contests you link below are merged into
        Texas SOS races on the main dashboard. Contests that exist only in a county (not on the SOS ballot) stay in the
        unlinked list — they are stored but not applied until you map them to an SOS race and click <strong>Link</strong>.
        The dropdown lists <strong>federal, statewide, district, and proposition</strong> SOS races (same sections as the main Civix
        tabs). Suggestions treat <strong>REP</strong> / <strong>DEM</strong> in county contest names as the ballot party. After linking,
        ingest uses <strong>Auto</strong> by default: for each county and race it compares total votes on the SOS county file vs your
        county feed and applies whichever is higher. Override with <strong>SOS</strong>, <strong>County feed</strong>, or{" "}
        <strong>Manual</strong> if needed.
      </p>
      <button type="button" className="enr-secondaryBtn" disabled={busy || loading} onClick={() => void reload()}>
        {loading ? "Loading…" : "Reload mapping"}
      </button>

      {data?.electionParty ? (
        <p className="enr-muted" style={{ marginTop: 10, fontSize: 13 }}>
          Ballot party for this election: <strong>{data.electionParty}</strong> (from election settings / Civix id).
        </p>
      ) : null}
      {data?.note ? (
        <p className="enr-muted" style={{ marginTop: 10, fontSize: 13 }}>
          {data.note}
        </p>
      ) : null}

      <SettingsCollapse title="Not applied to any SOS race" badge={unlinkedCount || undefined}>
      {!loading && unlinkedByContest.length === 0 ? (
        <p className="enr-muted">No unlinked county contests — either none ingested yet or everything is linked.</p>
      ) : null}
      {unlinkedByContest.length > 0 ? (
        <div className="enr-tableWrap">
          <table className="enr-table enr-table--compact">
            <thead>
              <tr>
                <th>County</th>
                <th>County contest (from feed)</th>
                <th>Candidates (votes)</th>
                <th>Link to SOS race</th>
              </tr>
            </thead>
            <tbody>
              {unlinkedByContest.map(([key, rows]) => {
                const [countyKey, contestName] = key.split("\u0000");
                const first = rows[0];
                const suggestionId = first?.suggestedSosRaceId ?? "";
                return (
                  <tr key={key}>
                    <td>
                      <code>{countyKey}</code>
                    </td>
                    <td>{contestName}</td>
                    <td>
                      <ul className="enr-manualList">
                        {rows.map((r) => (
                          <li key={`${r.choiceName}-${r.partyName}`}>
                            {r.choiceName} ({r.partyName || "—"}): {r.totalVotes.toLocaleString()} total
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <select
                        className="enr-input"
                        defaultValue={suggestionId}
                        id={`link-${key}`}
                        disabled={busy}
                      >
                        <option value="">Select SOS race…</option>
                        {sosRacesSorted.map((sr) => (
                          <option key={sr.id} value={sr.id}>
                            {sosRaceOptionLabel(sr)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="enr-miniBtn"
                        disabled={busy}
                        onClick={() => {
                          const sel = document.getElementById(`link-${key}`) as HTMLSelectElement | null;
                          const sosRaceId = sel?.value ?? "";
                          const sr = data?.sosRaces?.find((r) => r.id === sosRaceId);
                          if (!sosRaceId || !sr) {
                            onMessage("Pick an SOS race to link.");
                            return;
                          }
                          void onLinkContest(countyKey, contestName, sosRaceId, sr.name);
                        }}
                      >
                        Link
                      </button>
                      {suggestionId ? (
                        <span className="enr-muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
                          Suggested: {first?.suggestedSosRaceName}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      </SettingsCollapse>

      <SettingsCollapse title="Linked races — vote source per county" badge={linkedCount || undefined}>
      {(data?.links ?? []).length === 0 ? (
        <p className="enr-muted">No manual links yet. SD4 may still merge automatically when contest names match.</p>
      ) : (
        <div className="enr-tableWrap">
          <table className="enr-table enr-table--compact">
            <thead>
              <tr>
                <th>County</th>
                <th>County contest</th>
                <th>SOS race</th>
                <th>Use votes from</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data?.links ?? []).map((l) => (
                <tr key={`${l.countyKey}-${l.countyContestName}`}>
                  <td>
                    <code>{l.countyKey}</code>
                  </td>
                  <td>{l.countyContestName}</td>
                  <td>{l.sosRaceName || l.sosRaceId}</td>
                  <td>
                    <select
                      className="enr-input"
                      value={voteSourceFor(l.countyKey, l.sosRaceId)}
                      disabled={busy}
                      onChange={(e) =>
                        void onSetVoteSource(l.countyKey, l.sosRaceId, e.target.value as CountyVoteSource)
                      }
                    >
                      <option value="auto">Auto (higher vote total)</option>
                      <option value="sos">SOS / Civix</option>
                      <option value="county_feed">County feed</option>
                      <option value="manual">Manual entry</option>
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="enr-miniBtn"
                      disabled={busy}
                      onClick={() =>
                        void deleteCountyRaceLink(electionId, l.countyKey, l.countyContestName).then(() => reload())
                      }
                    >
                      Unlink
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </SettingsCollapse>

      <SettingsCollapse
        title="Manual county votes"
        badge={
          data?.manualVotes?.length
            ? `${new Set(data.manualVotes.map((m) => m.countyKey)).size} counties`
            : undefined
        }
      >
        <ManualCountyVotesSection
          electionId={electionId}
          busy={busy}
          sosRaces={data?.sosRaces ?? []}
          manualVotes={data?.manualVotes ?? []}
          onMessage={onMessage}
          onReload={reload}
        />
      </SettingsCollapse>
    </SettingsCollapse>
  );
}
