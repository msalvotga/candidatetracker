import { Fragment, useEffect, useMemo, useState } from "react";
import type { CandidateInput, CountyRowInput, RaceInput } from "../types/election";
import {
  fetchSd4HistoricalGeCountyTotals,
  type Sd4HistoricalGeCountyTotalsPayload,
} from "../lib/dataBackend";
import { isSd4SenateRaceTitle, normalizeCountyLookupKey } from "../lib/sd4Historical";
import { LiveCount } from "./LiveCount";

function sortCounties(rows: CountyRowInput[]): CountyRowInput[] {
  const totals = rows.filter((r) => r.isTotalRow);
  const rest = rows.filter((r) => !r.isTotalRow).sort((a, b) => a.name.localeCompare(b.name));
  return [...totals, ...rest];
}

function partyAbbrevForHistory(party: string): string {
  const p = party.trim().toUpperCase();
  if (!p || p === "—" || p === "-") return "";
  return p;
}

function priorPartyDetail(
  hist: Sd4HistoricalGeCountyTotalsPayload | null,
  countyLookupKey: string,
  party: string,
): { year: number; earlyVote: number; electionDay: number; total: number } | null {
  if (!hist?.counties[countyLookupKey]) return null;
  const block = hist.counties[countyLookupKey];
  const pk = partyAbbrevForHistory(party);
  if (!pk) return null;
  const d = block.byPartyDetail?.[pk];
  if (!d) return null;
  return { year: block.year, earlyVote: d.earlyVote, electionDay: d.electionDay, total: d.total };
}

/** Sum prior GE vote-type totals for one party across all counties in the breakdown (ALL COUNTIES row). */
function priorPartyDetailDistrict(
  hist: Sd4HistoricalGeCountyTotalsPayload | null,
  countyLookupKeys: string[],
  party: string,
): { year: number; earlyVote: number; electionDay: number; total: number } | null {
  if (!hist || !countyLookupKeys.length) return null;
  const pk = partyAbbrevForHistory(party);
  if (!pk) return null;
  let earlyVote = 0;
  let electionDay = 0;
  let total = 0;
  let maxYear = 0;
  for (const k of countyLookupKeys) {
    const p = priorPartyDetail(hist, k, party);
    if (!p) continue;
    earlyVote += p.earlyVote;
    electionDay += p.electionDay;
    total += p.total;
    maxYear = Math.max(maxYear, p.year);
  }
  if (earlyVote === 0 && electionDay === 0 && total === 0) return null;
  return { year: maxYear, earlyVote, electionDay, total };
}

function districtSumGeEarlyDenom(hist: Sd4HistoricalGeCountyTotalsPayload | null, countyLookupKeys: string[]): number {
  if (!hist) return 0;
  return countyLookupKeys.reduce((s, k) => s + countyGeDenomEarly(hist, k), 0);
}

function districtSumGeEdDenom(hist: Sd4HistoricalGeCountyTotalsPayload | null, countyLookupKeys: string[]): number {
  if (!hist) return 0;
  return countyLookupKeys.reduce((s, k) => s + countyGeDenomEd(hist, k), 0);
}

function districtSumGeGrandTotal(hist: Sd4HistoricalGeCountyTotalsPayload | null, countyLookupKeys: string[]): number {
  if (!hist) return 0;
  return countyLookupKeys.reduce((s, k) => s + countyGeGrandTotal(hist, k), 0);
}

function rowSumEarly(row: CountyRowInput, candidates: CandidateInput[]): number {
  return candidates.reduce((sum, c) => sum + (row.candidates[c.id]?.earlyVotes ?? 0), 0);
}

function rowSumElectionDay(row: CountyRowInput, candidates: CandidateInput[]): number {
  return candidates.reduce((sum, c) => sum + (row.candidates[c.id]?.electionDayVotes ?? 0), 0);
}

function rowLiveVoteTotal(row: CountyRowInput, candidates: CandidateInput[]): number {
  return candidates.reduce((sum, c) => sum + (row.candidates[c.id]?.totalVotes ?? 0), 0);
}

function countyGeDenomEarly(hist: Sd4HistoricalGeCountyTotalsPayload | null, lookupKey: string): number {
  const d = hist?.counties[lookupKey]?.byPartyDetail;
  if (!d) return 0;
  return Object.values(d).reduce((s, x) => s + x.earlyVote, 0);
}

function countyGeDenomEd(hist: Sd4HistoricalGeCountyTotalsPayload | null, lookupKey: string): number {
  const d = hist?.counties[lookupKey]?.byPartyDetail;
  if (!d) return 0;
  return Object.values(d).reduce((s, x) => s + x.electionDay, 0);
}

function countyGeGrandTotal(hist: Sd4HistoricalGeCountyTotalsPayload | null, lookupKey: string): number {
  const d = hist?.counties[lookupKey]?.byPartyDetail;
  if (!d) return 0;
  return Object.values(d).reduce((s, x) => s + x.total, 0);
}

function formatPctShare(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function pctValue(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** Green if prior share > current share, red if lower; no class if nothing to compare. */
function priorPctCompareClass(
  priorPct: number | null,
  currentPct: number | null,
  canCompare: boolean,
): string {
  if (!canCompare || priorPct == null || currentPct == null) return "";
  const diff = priorPct - currentPct;
  if (diff > 0.05) return "enr-countyPct--up";
  if (diff < -0.05) return "enr-countyPct--down";
  return "";
}

function maxHistoricalYearForRows(
  hist: Sd4HistoricalGeCountyTotalsPayload | null,
  rows: CountyRowInput[],
): number | null {
  if (!hist?.counties) return null;
  let maxY = 0;
  for (const row of rows) {
    if (row.isTotalRow) continue;
    const k = normalizeCountyLookupKey(row.name);
    const y = hist.counties[k]?.year;
    if (y != null && y > maxY) maxY = y;
  }
  return maxY > 0 ? maxY : null;
}

/** Strip wording like "polling locations reporting"; keep leading "# of #". */
function compactPrecinctReporting(raw: string): string {
  const s = String(raw ?? "").trim();
  const m = s.match(/([\d,]+)\s+of\s+([\d,]+)/i);
  if (m) return `${m[1]} of ${m[2]}`;
  return s;
}

export function CountyBreakdown({
  race,
  onBack,
}: {
  race: RaceInput;
  onBack: () => void;
}) {
  const counties = race.counties?.length ? sortCounties(race.counties) : [];
  const candidates = race.candidates;
  const showSd4History = isSd4SenateRaceTitle(race.title);
  const [sd4Hist, setSd4Hist] = useState<Sd4HistoricalGeCountyTotalsPayload | null>(null);
  const [showPriorElection, setShowPriorElection] = useState(true);

  useEffect(() => {
    if (!showSd4History) {
      setSd4Hist(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchSd4HistoricalGeCountyTotals();
        if (!cancelled) setSd4Hist(payload);
      } catch {
        if (!cancelled) setSd4Hist(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showSd4History]);

  const historicalHeaderYear = useMemo(
    () => (showSd4History ? maxHistoricalYearForRows(sd4Hist, counties) : null),
    [showSd4History, sd4Hist, counties],
  );

  const countyLookupKeysInRace = useMemo(
    () => counties.filter((r) => !r.isTotalRow).map((r) => normalizeCountyLookupKey(r.name)),
    [counties],
  );

  const districtGeEarlyDenom = useMemo(
    () => (showSd4History && sd4Hist ? districtSumGeEarlyDenom(sd4Hist, countyLookupKeysInRace) : 0),
    [showSd4History, sd4Hist, countyLookupKeysInRace],
  );
  const districtGeEdDenom = useMemo(
    () => (showSd4History && sd4Hist ? districtSumGeEdDenom(sd4Hist, countyLookupKeysInRace) : 0),
    [showSd4History, sd4Hist, countyLookupKeysInRace],
  );
  const districtGeTotalDenom = useMemo(
    () => (showSd4History && sd4Hist ? districtSumGeGrandTotal(sd4Hist, countyLookupKeysInRace) : 0),
    [showSd4History, sd4Hist, countyLookupKeysInRace],
  );

  const priorCols = showSd4History && showPriorElection ? 3 : 0;
  const candSpan = 3 + priorCols;

  if (!counties.length) {
    return (
      <div className="enr-county">
        <div className="enr-county__bar">
          <button type="button" className="enr-back" onClick={onBack}>
            Back
          </button>
        </div>
        <h2 className="enr-county__title">{race.title}</h2>
        <p className="enr-muted">No county breakdown is included for this race in the current dataset.</p>
      </div>
    );
  }

  return (
    <div className="enr-county">
      <div className="enr-county__bar">
        <button type="button" className="enr-back" onClick={onBack}>
          Back
        </button>
      </div>
      <h2 className="enr-county__title">{race.title}</h2>

      {showSd4History && sd4Hist?.description ? (
        <p className="enr-muted enr-countyHistNote">{sd4Hist.description}</p>
      ) : null}

      {showSd4History ? (
        <label className="enr-countyPriorToggle">
          <input
            type="checkbox"
            checked={showPriorElection}
            onChange={(e) => setShowPriorElection(e.target.checked)}
          />
          Show prior general election columns
        </label>
      ) : null}

      <div className="enr-countyGridWrap">
        <table className="enr-countyGrid">
          <thead>
            <tr>
              <th rowSpan={2}>County</th>
              <th rowSpan={2}>Source</th>
              <th rowSpan={2}>Precinct reporting</th>
              {candidates.map((c) => (
                <th key={c.id} colSpan={candSpan} className="enr-candHead">
                  {c.name}
                  {c.incumbent ? " (I)" : ""}
                </th>
              ))}
            </tr>
            <tr>
              {candidates.map((c) => (
                <Fragment key={`${c.id}-sub`}>
                  <th className="enr-subHead num">Early votes</th>
                  <th className="enr-subHead num">Election day</th>
                  <th className="enr-subHead num">Total votes</th>
                  {priorCols ? (
                    <>
                      <th className="enr-subHead num enr-subHead--historical">
                        {historicalHeaderYear != null ? `${historicalHeaderYear} Early` : "GE Early"}
                      </th>
                      <th className="enr-subHead num enr-subHead--historical">
                        {historicalHeaderYear != null ? `${historicalHeaderYear} Election day` : "GE Election day"}
                      </th>
                      <th className="enr-subHead num enr-subHead--historical">
                        {historicalHeaderYear != null ? `${historicalHeaderYear} Total` : "GE Total"}
                      </th>
                    </>
                  ) : null}
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {counties.map((row) => {
              const liveDenom = rowLiveVoteTotal(row, candidates);
              const rowEarlyTotal = rowSumEarly(row, candidates);
              const rowEdTotal = rowSumElectionDay(row, candidates);
              const lookupKey = row.isTotalRow ? "" : normalizeCountyLookupKey(row.name);
              const geEarlyDenom =
                showSd4History && sd4Hist
                  ? row.isTotalRow
                    ? districtGeEarlyDenom
                    : lookupKey
                      ? countyGeDenomEarly(sd4Hist, lookupKey)
                      : 0
                  : 0;
              const geEdDenom =
                showSd4History && sd4Hist
                  ? row.isTotalRow
                    ? districtGeEdDenom
                    : lookupKey
                      ? countyGeDenomEd(sd4Hist, lookupKey)
                      : 0
                  : 0;
              const geDenom =
                showSd4History && sd4Hist
                  ? row.isTotalRow
                    ? districtGeTotalDenom
                    : lookupKey
                      ? countyGeGrandTotal(sd4Hist, lookupKey)
                      : 0
                  : 0;

              const canCmpEarly = rowEarlyTotal > 0;
              const canCmpEd = rowEdTotal > 0;
              const canCmpTotal = liveDenom > 0;

              return (
                <tr key={row.id} className={row.isTotalRow ? "enr-totalRow" : undefined}>
                  <td className={row.isTotalRow ? "enr-countyName enr-strong" : "enr-countyName"}>{row.name}</td>
                  <td className="enr-precinct">{row.sourceTag ?? (row.isTotalRow ? "MIX" : "SOS")}</td>
                  <td className="enr-precinct">{compactPrecinctReporting(row.precinctsReporting)}</td>
                  {candidates.map((c) => {
                    const cell = row.candidates[c.id] ?? { earlyVotes: 0, electionDayVotes: 0, totalVotes: 0 };
                    const prior =
                      showSd4History && sd4Hist && priorCols
                        ? row.isTotalRow
                          ? priorPartyDetailDistrict(sd4Hist, countyLookupKeysInRace, c.party ?? "")
                          : lookupKey
                            ? priorPartyDetail(sd4Hist, lookupKey, c.party ?? "")
                            : null
                        : null;

                    const curEarlyPct = pctValue(cell.earlyVotes, rowEarlyTotal);
                    const curEdPct = pctValue(cell.electionDayVotes, rowEdTotal);
                    const curTotPct = pctValue(cell.totalVotes, liveDenom);

                    const pEarlyPct = prior ? pctValue(prior.earlyVote, geEarlyDenom) : null;
                    const pEdPct = prior ? pctValue(prior.electionDay, geEdDenom) : null;
                    const pTotPct = prior ? pctValue(prior.total, geDenom) : null;

                    return (
                      <Fragment key={`${row.id}-${c.id}`}>
                        <td className="num">
                          <div className="enr-countyCellStack">
                            <LiveCount value={cell.earlyVotes} />
                            <span className="enr-countyPct">{formatPctShare(cell.earlyVotes, rowEarlyTotal)}</span>
                          </div>
                        </td>
                        <td className="num">
                          <div className="enr-countyCellStack">
                            <LiveCount value={cell.electionDayVotes} />
                            <span className="enr-countyPct">{formatPctShare(cell.electionDayVotes, rowEdTotal)}</span>
                          </div>
                        </td>
                        <td className="num">
                          <div className="enr-countyCellStack">
                            <LiveCount value={cell.totalVotes} />
                            <span className="enr-countyPct">{formatPctShare(cell.totalVotes, liveDenom)}</span>
                          </div>
                        </td>
                        {priorCols ? (
                          <>
                            <td
                              className="num enr-historicalGe"
                              title={
                                prior
                                  ? row.isTotalRow
                                    ? `Sum of GE ${prior.year} early votes by party across counties in this table`
                                    : `GE ${prior.year} early vote — same party in precinct file`
                                  : row.isTotalRow
                                    ? undefined
                                    : "No matching party / county in historical file"
                              }
                            >
                              {prior ? (
                                <div className="enr-countyCellStack">
                                  <span>{prior.earlyVote.toLocaleString()}</span>
                                  <span
                                    className={`enr-countyPct ${priorPctCompareClass(pEarlyPct, curEarlyPct, canCmpEarly)}`}
                                  >
                                    {formatPctShare(prior.earlyVote, geEarlyDenom)}
                                  </span>
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td
                              className="num enr-historicalGe"
                              title={
                                prior
                                  ? row.isTotalRow
                                    ? `Sum of GE ${prior.year} election day votes by party across counties in this table`
                                    : `GE ${prior.year} election day — same party in precinct file`
                                    : undefined
                              }
                            >
                              {prior ? (
                                <div className="enr-countyCellStack">
                                  <span>{prior.electionDay.toLocaleString()}</span>
                                  <span
                                    className={`enr-countyPct ${priorPctCompareClass(pEdPct, curEdPct, canCmpEd)}`}
                                  >
                                    {formatPctShare(prior.electionDay, geEdDenom)}
                                  </span>
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td
                              className="num enr-historicalGe"
                              title={
                                prior
                                  ? row.isTotalRow
                                    ? `Sum of GE ${prior.year} total votes by party across counties in this table`
                                    : `GE ${prior.year} total — same party in precinct file`
                                    : undefined
                              }
                            >
                              {prior ? (
                                <div className="enr-countyCellStack">
                                  <span>{prior.total.toLocaleString()}</span>
                                  <span
                                    className={`enr-countyPct ${priorPctCompareClass(pTotPct, curTotPct, canCmpTotal)}`}
                                  >
                                    {formatPctShare(prior.total, geDenom)}
                                  </span>
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                          </>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
