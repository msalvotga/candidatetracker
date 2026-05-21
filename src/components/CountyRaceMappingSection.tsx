import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteCountyRaceLink,
  fetchCountyRaceMapping,
  saveCountyRaceLink,
  saveCountyRaceManualVote,
  saveCountyRaceVoteSource,
  type CountyRaceMappingPayload,
  type CountyVoteSource,
} from "../lib/dataBackend";

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
    return (hit?.voteSource as CountyVoteSource) ?? "county_feed";
  };

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
      await saveCountyRaceVoteSource(electionId, {
        countyKey,
        sosRaceId,
        voteSource: "county_feed",
      });
      onMessage(`Linked “${countyContestName}” to SOS race. Refresh the main page to see merged totals.`);
      await reload();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Link failed");
    }
  }

  async function onSetVoteSource(countyKey: string, sosRaceId: string, voteSource: CountyVoteSource) {
    try {
      await saveCountyRaceVoteSource(electionId, { countyKey, sosRaceId, voteSource });
      onMessage(`Vote source for ${countyKey} / race set to ${voteSource}.`);
      await reload();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "Save vote source failed");
    }
  }

  return (
    <section className="enr-panel enr-settings__section enr-countyRaceMapping">
      <h2>County results → SOS races</h2>
      <p className="enr-muted">
        County PDF feeds import <strong>all</strong> contests in the file. Only contests you link below are merged into
        Texas SOS races on the main dashboard. Contests that exist only in a county (not on the SOS ballot) stay in the
        unlinked list — they are stored but not applied until you map them to an SOS race. For each linked race, choose
        whether that county uses <strong>SOS</strong>, <strong>county feed</strong>, or <strong>manual</strong> votes.
      </p>
      <button type="button" className="enr-secondaryBtn" disabled={busy || loading} onClick={() => void reload()}>
        {loading ? "Loading…" : "Reload mapping"}
      </button>

      {data?.note ? (
        <p className="enr-muted" style={{ marginTop: 10, fontSize: 13 }}>
          {data.note}
        </p>
      ) : null}

      <h3 className="enr-countyRaceMapping__subtitle">Not applied to any SOS race</h3>
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
                        {(data?.sosRaces ?? []).map((sr) => (
                          <option key={sr.id} value={sr.id}>
                            {sr.name}
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
                        Link & use county feed
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

      <h3 className="enr-countyRaceMapping__subtitle">Linked races — vote source per county</h3>
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

      <h3 className="enr-countyRaceMapping__subtitle">Manual county votes (linked SOS races)</h3>
      <p className="enr-muted" style={{ fontSize: 13 }}>
        Set a linked race’s vote source to <strong>Manual entry</strong>, then enter totals below. Used instead of SOS or
        county PDF for that county and race.
      </p>
      <ManualVoteForm
        electionId={electionId}
        busy={busy}
        sosRaces={data?.sosRaces ?? []}
        links={data?.links ?? []}
        manualVotes={data?.manualVotes ?? []}
        onSaved={async () => {
          onMessage("Manual votes saved.");
          await reload();
        }}
        onError={(m) => onMessage(m)}
      />
    </section>
  );
}

function ManualVoteForm({
  electionId,
  busy,
  sosRaces,
  links,
  manualVotes,
  onSaved,
  onError,
}: {
  electionId: string;
  busy: boolean;
  sosRaces: CountyRaceMappingPayload["sosRaces"];
  links: CountyRaceMappingPayload["links"];
  manualVotes: CountyRaceMappingPayload["manualVotes"];
  onSaved: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const countyKeys = useMemo(() => [...new Set(links.map((l) => l.countyKey))].sort(), [links]);
  const [countyKey, setCountyKey] = useState("");
  const [sosRaceId, setSosRaceId] = useState("");
  const [sosCandidateId, setSosCandidateId] = useState("");
  const [earlyVotes, setEarlyVotes] = useState("0");
  const [electionDayVotes, setElectionDayVotes] = useState("0");
  const [totalVotes, setTotalVotes] = useState("0");

  const race = sosRaces.find((r) => r.id === sosRaceId);

  useEffect(() => {
    if (!countyKey && countyKeys.length) setCountyKey(countyKeys[0]);
  }, [countyKey, countyKeys]);

  const existingForSelection = manualVotes.filter((m) => m.countyKey === countyKey && m.sosRaceId === sosRaceId);

  return (
    <div className="enr-manualVoteForm">
      <div className="enr-manualVoteForm__row">
        <label className="enr-field">
          County
          <select className="enr-input" value={countyKey} disabled={busy} onChange={(e) => setCountyKey(e.target.value)}>
            <option value="">Select…</option>
            {countyKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="enr-field">
          SOS race
          <select
            className="enr-input"
            value={sosRaceId}
            disabled={busy}
            onChange={(e) => {
              setSosRaceId(e.target.value);
              setSosCandidateId("");
            }}
          >
            <option value="">Select…</option>
            {[...new Set(links.filter((l) => l.countyKey === countyKey).map((l) => l.sosRaceId))].map((rid) => {
              const sr = sosRaces.find((r) => r.id === rid);
              return (
                <option key={rid} value={rid}>
                  {sr?.name ?? rid}
                </option>
              );
            })}
          </select>
        </label>
        <label className="enr-field">
          SOS candidate
          <select
            className="enr-input"
            value={sosCandidateId}
            disabled={busy || !race}
            onChange={(e) => setSosCandidateId(e.target.value)}
          >
            <option value="">Select…</option>
            {(race?.candidates ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.party})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="enr-manualVoteForm__row">
        <label className="enr-field">
          Early / EV
          <input className="enr-input" value={earlyVotes} disabled={busy} onChange={(e) => setEarlyVotes(e.target.value)} />
        </label>
        <label className="enr-field">
          Election day
          <input
            className="enr-input"
            value={electionDayVotes}
            disabled={busy}
            onChange={(e) => setElectionDayVotes(e.target.value)}
          />
        </label>
        <label className="enr-field">
          Total
          <input className="enr-input" value={totalVotes} disabled={busy} onChange={(e) => setTotalVotes(e.target.value)} />
        </label>
        <button
          type="button"
          className="enr-primaryBtn"
          disabled={busy || !countyKey || !sosRaceId || !sosCandidateId}
          onClick={() => {
            const c = race?.candidates?.find((x) => x.id === sosCandidateId);
            void saveCountyRaceManualVote(electionId, {
              countyKey,
              sosRaceId,
              sosCandidateId,
              choiceName: c?.name ?? "",
              partyName: c?.party ?? "",
              earlyVotes: Number(earlyVotes) || 0,
              electionDayVotes: Number(electionDayVotes) || 0,
              totalVotes: Number(totalVotes) || 0,
            })
              .then(() => saveCountyRaceVoteSource(electionId, { countyKey, sosRaceId, voteSource: "manual" }))
              .then(() => onSaved())
              .catch((e) => onError(e instanceof Error ? e.message : "Save failed"));
          }}
        >
          Save manual votes
        </button>
      </div>
      {existingForSelection.length > 0 ? (
        <ul className="enr-manualList enr-muted" style={{ fontSize: 13 }}>
          {existingForSelection.map((m) => (
            <li key={m.sosCandidateId}>
              {m.choiceName}: {m.totalVotes.toLocaleString()} (EV {m.earlyVotes.toLocaleString()}, ED{" "}
              {m.electionDayVotes.toLocaleString()})
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
