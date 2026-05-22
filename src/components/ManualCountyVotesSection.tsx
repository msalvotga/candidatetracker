import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteCountyRaceManualVote,
  saveCountyRaceManualVote,
  saveCountyRaceVoteSource,
  type CountyRaceMappingPayload,
} from "../lib/dataBackend";
import { TEXAS_COUNTIES } from "../lib/texasCounties";
import { SettingsCollapse } from "./SettingsCollapse";

const SECTION_ORDER = ["Federal", "StateWide", "Districted", "StateWideQ", ""];
const SECTION_LABELS: Record<string, string> = {
  Federal: "Federal",
  StateWide: "Statewide",
  Districted: "District",
  StateWideQ: "Statewide props",
};

type CandidateDraft = { earlyVotes: string; electionDayVotes: string; totalVotes: string };
type CountyRowDraft = Record<string, CandidateDraft>;

function countyLabel(key: string) {
  const hit = TEXAS_COUNTIES.find((c) => c.key === key);
  return hit?.label ?? key.replace(/_/g, " ");
}

function rowKey(raceId: string, countyKey: string) {
  return `${raceId}|${countyKey}`;
}

function emptyCandidateDraft(): CandidateDraft {
  return { earlyVotes: "0", electionDayVotes: "0", totalVotes: "0" };
}

function draftsFromManualVotes(
  manualVotes: CountyRaceMappingPayload["manualVotes"],
  raceId: string,
): Map<string, CountyRowDraft> {
  const byCounty = new Map<string, CountyRowDraft>();
  for (const m of manualVotes.filter((x) => x.sosRaceId === raceId)) {
    const ck = m.countyKey.toLowerCase();
    const row = byCounty.get(ck) ?? {};
    row[m.sosCandidateId] = {
      earlyVotes: String(m.earlyVotes ?? 0),
      electionDayVotes: String(m.electionDayVotes ?? 0),
      totalVotes: String(m.totalVotes ?? 0),
    };
    byCounty.set(ck, row);
  }
  return byCounty;
}

function ManualRaceTable({
  electionId,
  race,
  manualVotes,
  busy,
  onSaved,
  onError,
}: {
  electionId: string;
  race: CountyRaceMappingPayload["sosRaces"][number];
  manualVotes: CountyRaceMappingPayload["manualVotes"];
  busy: boolean;
  onSaved: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const candidates = race.candidates ?? [];
  const [addCountyKey, setAddCountyKey] = useState("");
  const [extraCounties, setExtraCounties] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Map<string, CountyRowDraft>>(() => draftsFromManualVotes(manualVotes, race.id));
  const [savingRow, setSavingRow] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(draftsFromManualVotes(manualVotes, race.id));
    setExtraCounties([]);
  }, [manualVotes, race.id]);

  const countyKeysInTable = useMemo(() => {
    const keys = new Set<string>([...drafts.keys(), ...extraCounties]);
    return [...keys].sort((a, b) => countyLabel(a).localeCompare(countyLabel(b), "en"));
  }, [drafts, extraCounties]);

  const countiesAvailableToAdd = useMemo(
    () => TEXAS_COUNTIES.filter((c) => !countyKeysInTable.includes(c.key)),
    [countyKeysInTable],
  );

  const updateCell = useCallback(
    (countyKey: string, candidateId: string, field: keyof CandidateDraft, value: string) => {
      setDrafts((prev) => {
        const next = new Map(prev);
        const rk = rowKey(race.id, countyKey);
        const row = { ...(next.get(countyKey) ?? {}) };
        row[candidateId] = { ...(row[candidateId] ?? emptyCandidateDraft()), [field]: value };
        next.set(countyKey, row);
        return next;
      });
    },
    [race.id],
  );

  async function saveCountyRow(countyKey: string) {
    const row = drafts.get(countyKey) ?? {};
    setSavingRow(countyKey);
    try {
      let anyVotes = false;
      for (const c of candidates) {
        const d = row[c.id] ?? emptyCandidateDraft();
        const earlyVotes = Number(d.earlyVotes) || 0;
        const electionDayVotes = Number(d.electionDayVotes) || 0;
        const totalVotes = Number(d.totalVotes) || 0;
        const hadStored = manualVotes.some(
          (m) => m.countyKey === countyKey && m.sosRaceId === race.id && m.sosCandidateId === c.id,
        );
        if (earlyVotes === 0 && electionDayVotes === 0 && totalVotes === 0) {
          if (hadStored) {
            await deleteCountyRaceManualVote(electionId, {
              countyKey,
              sosRaceId: race.id,
              sosCandidateId: c.id,
            });
          }
          continue;
        }
        anyVotes = true;
        await saveCountyRaceManualVote(electionId, {
          countyKey,
          sosRaceId: race.id,
          sosCandidateId: c.id,
          choiceName: c.name,
          partyName: c.party,
          earlyVotes,
          electionDayVotes,
          totalVotes,
        });
      }
      if (anyVotes) {
        await saveCountyRaceVoteSource(electionId, { countyKey, sosRaceId: race.id, voteSource: "manual" });
      }
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingRow(null);
    }
  }

  async function deleteCountyRow(countyKey: string) {
    setSavingRow(countyKey);
    try {
      await deleteCountyRaceManualVote(electionId, { countyKey, sosRaceId: race.id });
      setDrafts((prev) => {
        const next = new Map(prev);
        next.delete(countyKey);
        return next;
      });
      setExtraCounties((prev) => prev.filter((k) => k !== countyKey));
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSavingRow(null);
    }
  }

  function addCounty() {
    const k = addCountyKey.trim().toLowerCase();
    if (!k || countyKeysInTable.includes(k)) return;
    setExtraCounties((prev) => [...prev, k]);
    setDrafts((prev) => {
      const next = new Map(prev);
      if (!next.has(k)) next.set(k, {});
      return next;
    });
    setAddCountyKey("");
  }

  if (!candidates.length) {
    return <p className="enr-muted">No SOS candidates on file for this race.</p>;
  }

  return (
    <div className="enr-manualCountyRace">
      <div className="enr-manualCountyRace__toolbar">
        <label className="enr-field enr-manualCountyRace__addField">
          Add county
          <select
            className="enr-input"
            value={addCountyKey}
            disabled={busy || !countiesAvailableToAdd.length}
            onChange={(e) => setAddCountyKey(e.target.value)}
          >
            <option value="">Select county…</option>
            {countiesAvailableToAdd.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="enr-secondaryBtn" disabled={busy || !addCountyKey} onClick={addCounty}>
          Add row
        </button>
        <span className="enr-muted" style={{ fontSize: 13 }}>
          All {TEXAS_COUNTIES.length} Texas counties available. Edit cells, then <strong>Save row</strong>.
        </span>
      </div>

      {countyKeysInTable.length === 0 ? (
        <p className="enr-muted">No manual entries for this race yet — add a county above.</p>
      ) : (
        <div className="enr-countyGridWrap enr-manualCountyRace__gridWrap">
          <table className="enr-countyGrid enr-manualCountyGrid">
            <thead>
              <tr>
                <th rowSpan={2}>County</th>
                <th rowSpan={2}>Source</th>
                <th rowSpan={2} className="enr-manualCountyGrid__actionsHead">
                  Actions
                </th>
                {candidates.map((c) => (
                  <th key={c.id} colSpan={3} className="enr-candHead">
                    {c.name}
                    {c.party ? ` (${c.party})` : ""}
                  </th>
                ))}
              </tr>
              <tr>
                {candidates.map((c) => (
                  <Fragment key={`${c.id}-sub`}>
                    <th className="enr-subHead num">Early votes</th>
                    <th className="enr-subHead num">Election day</th>
                    <th className="enr-subHead num">Total votes</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {countyKeysInTable.map((countyKey) => {
                const row = drafts.get(countyKey) ?? {};
                const rowBusy = busy || savingRow === countyKey;
                return (
                  <tr key={countyKey}>
                    <td className="enr-countyName">{countyLabel(countyKey)}</td>
                    <td className="enr-precinct">MANUAL</td>
                    <td className="enr-manualCountyGrid__actions">
                      <button
                        type="button"
                        className="enr-miniBtn"
                        disabled={rowBusy}
                        onClick={() => void saveCountyRow(countyKey)}
                      >
                        {savingRow === countyKey ? "Saving…" : "Save row"}
                      </button>
                      <button
                        type="button"
                        className="enr-miniBtn enr-miniBtn--danger"
                        disabled={rowBusy}
                        onClick={() => void deleteCountyRow(countyKey)}
                      >
                        Delete
                      </button>
                    </td>
                    {candidates.map((c) => {
                      const d = row[c.id] ?? emptyCandidateDraft();
                      return (
                        <Fragment key={`${countyKey}-${c.id}`}>
                          <td className="num">
                            <input
                              type="number"
                              min={0}
                              className="enr-manualCellInput"
                              value={d.earlyVotes}
                              disabled={rowBusy}
                              onChange={(e) => updateCell(countyKey, c.id, "earlyVotes", e.target.value)}
                            />
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min={0}
                              className="enr-manualCellInput"
                              value={d.electionDayVotes}
                              disabled={rowBusy}
                              onChange={(e) => updateCell(countyKey, c.id, "electionDayVotes", e.target.value)}
                            />
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min={0}
                              className="enr-manualCellInput"
                              value={d.totalVotes}
                              disabled={rowBusy}
                              onChange={(e) => updateCell(countyKey, c.id, "totalVotes", e.target.value)}
                            />
                          </td>
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ManualCountyVotesSection({
  electionId,
  busy,
  sosRaces,
  manualVotes,
  onMessage,
  onReload,
}: {
  electionId: string;
  busy: boolean;
  sosRaces: CountyRaceMappingPayload["sosRaces"];
  manualVotes: CountyRaceMappingPayload["manualVotes"];
  onMessage: (msg: string | null) => void;
  onReload: () => void | Promise<void>;
}) {
  const racesBySection = useMemo(() => {
    const sorted = [...sosRaces].sort((a, b) => {
      const oa = SECTION_ORDER.indexOf(a.section ?? "");
      const ob = SECTION_ORDER.indexOf(b.section ?? "");
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name, "en");
    });
    const groups = new Map<string, typeof sorted>();
    for (const r of sorted) {
      const sec = SECTION_LABELS[r.section ?? ""] ?? r.section ?? "Other";
      const list = groups.get(sec) ?? [];
      list.push(r);
      groups.set(sec, list);
    }
    return [...groups.entries()];
  }, [sosRaces]);

  const manualCountyCount = useMemo(() => new Set(manualVotes.map((m) => m.countyKey)).size, [manualVotes]);
  const manualRaceCount = useMemo(() => new Set(manualVotes.map((m) => m.sosRaceId)).size, [manualVotes]);

  const handleSaved = useCallback(async () => {
    onMessage("Manual votes saved.");
    await onReload();
  }, [onMessage, onReload]);

  if (!sosRaces.length) {
    return <p className="enr-muted">Load SOS races first (Civix election required).</p>;
  }

  return (
    <>
      <p className="enr-muted" style={{ fontSize: 13 }}>
        Override county totals by race, grouped like <strong>County Returns</strong>. Every SOS race is listed below.
        Pick any Texas county, enter Early / Election day / Total per candidate, then <strong>Save row</strong>. Saving
        sets that county’s vote source to <strong>Manual</strong> for the race. Clear all cells and save to remove a
        candidate; use <strong>Delete</strong> to remove the whole county row.
      </p>

      {racesBySection.map(([sectionLabel, races]) => (
        <div key={sectionLabel} className="enr-manualCountySection">
          <h3 className="enr-manualCountySection__title">{sectionLabel}</h3>
          {races.map((race) => {
            const countyCount = new Set(
              manualVotes.filter((m) => m.sosRaceId === race.id).map((m) => m.countyKey),
            ).size;
            return (
              <SettingsCollapse
                key={race.id}
                title={race.name}
                badge={countyCount ? `${countyCount} ${countyCount === 1 ? "county" : "counties"}` : undefined}
                className="enr-manualCountyRaceCollapse"
              >
                <ManualRaceTable
                  electionId={electionId}
                  race={race}
                  manualVotes={manualVotes}
                  busy={busy}
                  onSaved={handleSaved}
                  onError={(m) => onMessage(m)}
                />
              </SettingsCollapse>
            );
          })}
        </div>
      ))}

      <p className="enr-muted" style={{ fontSize: 12, marginTop: 12 }}>
        {manualVotes.length} candidate {manualVotes.length === 1 ? "entry" : "entries"} across {manualRaceCount}{" "}
        {manualRaceCount === 1 ? "race" : "races"} and {manualCountyCount}{" "}
        {manualCountyCount === 1 ? "county" : "counties"}.
      </p>
    </>
  );
}
