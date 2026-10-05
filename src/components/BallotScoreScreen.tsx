import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/apiBase";
import { electionHasRosterScores } from "../lib/rosterScoreElection";
import { ElectionDatasetNotice } from "./ElectionDatasetNotice";
import { BallotScoreHeatmap, type BallotMapCell } from "./BallotScoreHeatmap";
import {
  FALLBACK_DAYS,
  cumulativeBucket,
  dailyBucket,
  emptyStat,
  formatDayDate,
  votingDayTitle,
  formatDelta,
  modelDelta,
  statFromScore,
  type EvBucket,
  type EvGeo,
  type EvModel,
  type ScoreStat,
} from "../lib/ballotScoreModel";

type GeoMetrics = {
  gov2026: ScoreStat;
  gov2026Among2022Voters: ScoreStat;
  abbott2022: ScoreStat;
  early2026: ScoreStat;
  earlyDays: unknown[];
};

type GeoRow = GeoMetrics & { key: string; label: string };

type BallotScoreSummary = {
  generatedAt: string;
  score: { column: string; label: string; scale: string };
  compare?: { missing2018?: string };
  coverageNote: string;
  voters: {
    rows: number;
    with2026Score: number;
    counties: number;
    house: number;
    senate: number;
    congress: number;
  };
  ev: { status: string; note: string };
  statewide: GeoMetrics;
  groups: {
    county: GeoRow[];
    house: GeoRow[];
    senate: GeoRow[];
    congress: GeoRow[];
  };
};

type EvPayload = {
  status: string;
  phase: string | null;
  scanned: number;
  error: string | null;
  datasets?: {
    lookup?: { validation?: string };
    static2022?: { validation?: string };
    roster2026?: { validation?: string };
  };
  model: EvModel | null;
};

type GroupId = "county" | "house" | "senate" | "congress";
type Board = "table" | "absolute" | "compare";
type SortKey = "label" | "y2022score2026" | "y2022score2022" | "y2026score2026" | "y2026score2022";

type ViewRow = {
  key: string;
  label: string;
  all2026: ScoreStat;
  y2022score2026: ScoreStat;
  y2022score2022: ScoreStat;
  y2026score2026: ScoreStat;
  y2026score2022: ScoreStat;
  y2026voters: number;
  y2022voters: number;
};

const GROUPS: { id: GroupId; label: string }[] = [
  { id: "county", label: "County" },
  { id: "house", label: "State House" },
  { id: "senate", label: "State Senate" },
  { id: "congress", label: "Congress" },
];

function formatNum(n: number) {
  return n.toLocaleString("en-US");
}

function formatScore(n: number | null, digits = 1) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

function ScoreCell({ stat, digits = 1, split = false }: { stat: ScoreStat; digits?: number; split?: boolean }) {
  return (
    <td className={split ? "num enr-ballot__split" : "num"}>
      <div className="enr-ballot__score">{formatScore(stat.avg, digits)}</div>
      <div className="enr-ballot__n">{stat.n ? formatNum(stat.n) : "—"}</div>
    </td>
  );
}

function withFallback(primary: ScoreStat, fallback: ScoreStat, allow: boolean): ScoreStat {
  if (primary.avg != null) return primary;
  return allow ? fallback : emptyStat();
}

function bucketStat(bucket: EvBucket | null, field: "score2022" | "score2026") {
  return statFromScore(bucket?.[field]);
}

function viewFromSources(
  summaryRow: GeoRow | undefined,
  evRow: EvGeo | undefined,
  dayId: string,
  allowStaticFallback: boolean,
  lookupOn: boolean,
): ViewRow {
  const key = summaryRow?.key ?? evRow?.key ?? "";
  const label = summaryRow?.label ?? evRow?.label ?? key;
  const y2022 = cumulativeBucket(evRow, dayId, "y2022");
  const y2026 = cumulativeBucket(evRow, dayId, "y2026");
  return {
    key,
    label,
    all2026: lookupOn ? statFromScore(evRow?.allCurrent.score2026) : withFallback(statFromScore(evRow?.allCurrent.score2026), summaryRow?.gov2026 ?? emptyStat(), true),
    y2022score2026: withFallback(bucketStat(y2022, "score2026"), summaryRow?.gov2026Among2022Voters ?? emptyStat(), allowStaticFallback),
    y2022score2022: withFallback(bucketStat(y2022, "score2022"), summaryRow?.abbott2022 ?? emptyStat(), allowStaticFallback),
    y2026score2026: bucketStat(y2026, "score2026"),
    y2026score2022: bucketStat(y2026, "score2022"),
    y2026voters: y2026?.voters ?? 0,
    y2022voters: y2022?.voters ?? 0,
  };
}

function mapLines(row: ViewRow, mode: "absolute" | "compare", dayLabel: string): BallotMapCell {
  if (mode === "absolute") {
    return {
      key: row.key,
      label: row.label,
      value: row.y2026score2026.avg,
      lines: [
        { label: "Voting day", value: dayLabel },
        { label: "Cumulative voters", value: formatNum(row.y2026voters) },
        { label: "Voters with 2026 score", value: formatNum(row.y2026score2026.n) },
        { label: "Cumulative 2026 model", value: formatScore(row.y2026score2026.avg) },
      ],
    };
  }
  const diff = modelDelta(row.y2026score2026, row.y2022score2026);
  return {
    key: row.key,
    label: row.label,
    value: diff,
    lines: [
      { label: "Voting day", value: dayLabel },
      { label: "2022 voters, 2026 model", value: formatScore(row.y2022score2026.avg) },
      { label: "2022 voters with 2026 score", value: formatNum(row.y2022score2026.n) },
      { label: "2026 voters, 2026 model", value: formatScore(row.y2026score2026.avg) },
      { label: "2026 voters with 2026 score", value: formatNum(row.y2026score2026.n) },
      { label: "Difference", value: formatDelta(diff) },
    ],
  };
}

export function BallotScoreScreen({ electionId }: { electionId: string }) {
  const [summary, setSummary] = useState<BallotScoreSummary | null>(null);
  const [ev, setEv] = useState<EvPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [group, setGroup] = useState<GroupId>("county");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("label");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [evDay, setEvDay] = useState("1");
  const [votingDay, setVotingDay] = useState("all");
  const [board, setBoard] = useState<Board>("table");

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer = 0;
    async function readBody(response: Response) {
      const text = await response.text();
      if (!text || text.trimStart().startsWith("<")) {
        if (response.status === 429 || response.status === 503) {
          throw new Error("The live server is busy. Ballot scores will try again shortly.");
        }
        throw new Error(`Ballot scores could not load (${response.status || "error"}).`);
      }
      const body = JSON.parse(text) as { error?: string; score?: { column?: string } };
      if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
      return body;
    }
    async function load() {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const [summaryResponse, evResponse] = await Promise.all([
          apiFetch("/api/ballot-score", { cache: "no-store" }),
          apiFetch("/api/ballot-score/ev", { cache: "no-store" }),
        ]);
        const summaryBody = await readBody(summaryResponse);
        const evBody = (await readBody(evResponse)) as EvPayload;
        if (cancelled) return;
        setError(null);
        setEv(evBody);
        if (summaryBody?.score?.column !== "MODEL_GOV_BALLOT_SCORE") {
          setRebuilding(true);
          return;
        }
        setRebuilding(false);
        setSummary(summaryBody as BallotScoreSummary);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load ballot scores");
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
          timer = window.setTimeout(() => void load(), 20000);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const model = ev?.model ?? null;
  const days = model?.days?.length ? model.days : FALLBACK_DAYS;
  const dayId = votingDay === "all" ? "12" : votingDay;
  const dayDef = days.find((day) => String(day.id) === (votingDay === "all" ? "12" : votingDay)) ?? days[0];
  const evDef = days.find((day) => String(day.id) === evDay) ?? days[0];
  const lookupOn = Boolean(model) && ev?.datasets?.lookup?.validation === "valid";
  const staticOn = Boolean(model) && ev?.datasets?.static2022?.validation === "valid";
  const allowStaticFallback = votingDay === "all" && !staticOn;

  const rows = useMemo(() => {
    const summaryRows = (summary?.groups[group] ?? []).filter((row) => row.key !== "0");
    const evRows = (model?.groups[group] ?? []).filter((row) => row.key !== "0");
    const evByKey = new Map(evRows.map((row) => [row.key, row]));
    const seen = new Set<string>();
    const merged: ViewRow[] = [];
    for (const row of summaryRows) {
      seen.add(row.key);
      merged.push(viewFromSources(row, evByKey.get(row.key), dayId, allowStaticFallback, lookupOn));
    }
    for (const row of evRows) {
      if (seen.has(row.key)) continue;
      merged.push(viewFromSources(undefined, row, dayId, false, lookupOn));
    }
    return merged;
  }, [summary, model, group, dayId, allowStaticFallback, lookupOn]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((row) => row.label.toLowerCase().includes(q) || row.key.toLowerCase().includes(q)) : rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "label") {
        const an = Number(a.key);
        const bn = Number(b.key);
        if (Number.isFinite(an) && Number.isFinite(bn) && String(an) === a.key && String(bn) === b.key) return (an - bn) * dir;
        return a.label.localeCompare(b.label) * dir;
      }
      const av = a[sortKey].avg;
      const bv = b[sortKey].avg;
      if (av == null && bv == null) return a.label.localeCompare(b.label);
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }, [rows, query, sortKey, sortDir]);

  const mapCells = useMemo(() => {
    const label = votingDay === "all" ? "All / Final" : dayDef.label;
    const mode = board === "compare" ? "compare" : "absolute";
    return rows.map((row) => mapLines(row, mode, label));
  }, [rows, board, votingDay, dayDef.label]);

  function onSort(next: SortKey) {
    if (sortKey === next) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(next);
    setSortDir(next === "label" ? "asc" : "desc");
  }

  function sortMark(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  const evState = model?.statewide;
  const evDaily2026 = bucketStat(dailyBucket(evState, evDay, "y2026"), "score2026");
  const evCum2026 = bucketStat(cumulativeBucket(evState, evDay, "y2026"), "score2026");
  const evDaily2022Model = bucketStat(dailyBucket(evState, evDay, "y2022"), "score2026");
  const evCum2022Model = bucketStat(cumulativeBucket(evState, evDay, "y2022"), "score2026");
  const evDaily2026on2022 = bucketStat(dailyBucket(evState, evDay, "y2026"), "score2022");
  const evCum2026on2022 = bucketStat(cumulativeBucket(evState, evDay, "y2026"), "score2022");
  const evDaily2022 = bucketStat(dailyBucket(evState, evDay, "y2022"), "score2022");
  const evCum2022 = bucketStat(cumulativeBucket(evState, evDay, "y2022"), "score2022");

  if (electionId && !electionHasRosterScores(electionId)) {
    return <ElectionDatasetNotice dataset="Ballot scores" />;
  }

  return (
    <main className="enr-ballot">
        {loading ? <p className="enr-ballot__status">Loading ballot scores…</p> : null}
        {rebuilding ? (
          <p className="enr-ballot__status">
            Rebuilding scores from the full statewide voter file. Counties, House seats, Senate seats, and congressional
            districts will show up when that pass finishes.
          </p>
        ) : null}
        {error ? <p className="enr-ballot__status enr-ballot__status--error">{error}</p> : null}
        {ev?.status === "running" ? (
          <p className="enr-ballot__status">
            Reading uploaded voter files{ev.phase ? ` (${ev.phase})` : ""}
            {ev.scanned ? ` — ${formatNum(ev.scanned)} rows` : ""}.
          </p>
        ) : null}

        {summary ? (
          <>
            <section className="enr-ballot__kpis" aria-label="Statewide averages">
              <Kpi label={`2026 election, 2026 model · ${votingDayTitle(evDef)} cumulative`} stat={evCum2026} />
              <Kpi label={`2022 election, 2026 model · ${votingDayTitle(evDef)} cumulative`} stat={evCum2022Model} />
            </section>

            <section className="enr-card">
              <div className="enr-card__head enr-ballot__head">
                <h2 className="enr-card__title">Early voting by day</h2>
                <label className="enr-selectLabel">
                  Early voting day
                  <select className="enr-select" value={evDay} onChange={(event) => setEvDay(event.target.value)}>
                    {days.map((day) => (
                      <option key={day.id} value={String(day.id)}>
                        {votingDayTitle(day)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="enr-tablewrap">
                <table className="enr-table enr-table--compact enr-ballot__table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Statewide</th>
                      <th className="enr-ballot__group" colSpan={2}>
                        2022 Election (2022 Voters)
                      </th>
                      <th className="enr-ballot__group enr-ballot__split" colSpan={2}>
                        2026 Election (2026 Voters)
                      </th>
                    </tr>
                    <tr>
                      <th className="num">2026 model</th>
                      <th className="num">2022 model</th>
                      <th className="num enr-ballot__split">2026 model</th>
                      <th className="num">2022 model</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{votingDayTitle(evDef)}</td>
                      <ScoreCell stat={evDaily2022Model} />
                      <ScoreCell stat={evDaily2022} digits={3} />
                      <ScoreCell stat={evDaily2026} split />
                      <ScoreCell stat={evDaily2026on2022} digits={3} />
                    </tr>
                    <tr>
                      <td>Cumulative</td>
                      <ScoreCell stat={evCum2022Model} />
                      <ScoreCell stat={evCum2022} digits={3} />
                      <ScoreCell stat={evCum2026} split />
                      <ScoreCell stat={evCum2026on2022} digits={3} />
                    </tr>
                    <tr>
                      <td>2026 model difference</td>
                      <td className="enr-ballot__diff" colSpan={4}>
                        {votingDayTitle(evDef)} {formatDelta(modelDelta(evDaily2026, evDaily2022Model))}
                        {" · "}
                        Cumulative {formatDelta(modelDelta(evCum2026, evCum2022Model))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="enr-ballot__hint">
                {evDef.label} lines up {formatDayDate(evDef.date2022)} with {formatDayDate(evDef.date2026, "long")}. Day 1
                includes all mail-in ballots up to and including that day. Election Day includes mail-in ballots received
                on Oct 31, Nov 1, and Nov 2 as well as Election Day.
              </p>
            </section>

            <section className="enr-card">
              <div className="enr-card__head enr-ballot__head">
                <div className="enr-ballot__tabs" role="tablist">
                  {GROUPS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={group === item.id}
                      className={group === item.id ? "enr-ballot__tab is-active" : "enr-ballot__tab"}
                      onClick={() => {
                        setGroup(item.id);
                        setQuery("");
                        setSortKey("label");
                        setSortDir("asc");
                      }}
                    >
                      {item.label}
                      <span className="enr-ballot__tab-count">
                        {summary.voters[item.id === "county" ? "counties" : item.id]}
                      </span>
                    </button>
                  ))}
                </div>
                <input
                  className="enr-ballot__search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search"
                  aria-label="Search geographies"
                />
              </div>
              <div className="enr-ballot__filters">
                <label className="enr-selectLabel">
                  Voting day
                  <select className="enr-select" value={votingDay} onChange={(event) => setVotingDay(event.target.value)}>
                    <option value="all">All / Final</option>
                    {days.map((day) => (
                      <option key={day.id} value={String(day.id)}>
                        {day.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="enr-ballot__tabs" role="tablist" aria-label="Score view">
                  <button type="button" className={board === "table" ? "enr-ballot__tab is-active" : "enr-ballot__tab"} onClick={() => setBoard("table")}>
                    Table
                  </button>
                  <button type="button" className={board === "absolute" ? "enr-ballot__tab is-active" : "enr-ballot__tab"} onClick={() => setBoard("absolute")}>
                    2026 model map
                  </button>
                  <button type="button" className={board === "compare" ? "enr-ballot__tab is-active" : "enr-ballot__tab"} onClick={() => setBoard("compare")}>
                    2022 vs 2026 map
                  </button>
                </div>
              </div>
              {board === "table" ? (
                <div className="enr-tablewrap">
                  <table className="enr-table enr-table--compact enr-ballot__table">
                    <thead>
                      <tr>
                        <th rowSpan={2}>
                          <button type="button" className="enr-ballot__sort" onClick={() => onSort("label")}>
                            Geography{sortMark("label")}
                          </button>
                        </th>
                        <th className="enr-ballot__group" colSpan={2}>
                          2022 Election (2022 Voters)
                        </th>
                        <th className="enr-ballot__group enr-ballot__split" colSpan={2}>
                          2026 Election (2026 Voters)
                        </th>
                      </tr>
                      <tr>
                        <th className="num">
                          <button type="button" className="enr-ballot__sort" onClick={() => onSort("y2022score2026")}>
                            2026 model{sortMark("y2022score2026")}
                          </button>
                        </th>
                        <th className="num">
                          <button type="button" className="enr-ballot__sort" onClick={() => onSort("y2022score2022")}>
                            2022 model{sortMark("y2022score2022")}
                          </button>
                        </th>
                        <th className="num enr-ballot__split">
                          <button type="button" className="enr-ballot__sort" onClick={() => onSort("y2026score2026")}>
                            2026 model{sortMark("y2026score2026")}
                          </button>
                        </th>
                        <th className="num">
                          <button type="button" className="enr-ballot__sort" onClick={() => onSort("y2026score2022")}>
                            2022 model{sortMark("y2026score2022")}
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.length === 0 ? (
                        <tr>
                          <td colSpan={5}>No matches.</td>
                        </tr>
                      ) : (
                        visible.map((row) => (
                          <tr key={row.key}>
                            <td>{row.label}</td>
                            <ScoreCell stat={row.y2022score2026} />
                            <ScoreCell stat={row.y2022score2022} digits={3} />
                            <ScoreCell stat={row.y2026score2026} split />
                            <ScoreCell stat={row.y2026score2022} digits={3} />
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <BallotScoreHeatmap
                  geography={group}
                  mode={board === "compare" ? "compare" : "absolute"}
                  dayLabel={votingDay === "all" ? "All / Final" : dayDef.label}
                  cells={mapCells}
                  query={query}
                />
              )}
              <p className="enr-ballot__hint">
                Counts under a score are voters with that score, not total turnout. Each model column is cumulative
                through {votingDay === "all" ? "the full calendar" : dayDef.label}. Upload files in Settings → Ballot
                score data.
              </p>
            </section>
          </>
        ) : null}
      </main>
  );
}

function Kpi({ label, stat, digits = 1 }: { label: string; stat: ScoreStat; digits?: number }) {
  return (
    <article className="enr-ballot__kpi">
      <div className="enr-ballot__kpi-label">{label}</div>
      <div className="enr-ballot__kpi-value">{formatScore(stat.avg, digits)}</div>
      <div className="enr-ballot__kpi-n">{stat.n ? `${formatNum(stat.n)} voters` : "Not in yet"}</div>
    </article>
  );
}
