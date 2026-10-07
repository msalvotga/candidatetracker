import { useEffect, useMemo, useState } from "react";
import { apiJson, apiQuietMs, apiUrl } from "../lib/apiBase";
import { electionHasRosterScores } from "../lib/rosterScoreElection";
import { ElectionDatasetNotice } from "./ElectionDatasetNotice";
import { TEXAS_COUNTIES } from "../lib/texasCounties";

type RosterDay = { date: string; voters?: number; missingVuid?: number; earlyInPerson?: number; mail?: number };

type CountyPull = {
  key: string;
  label: string;
  trained: boolean;
  fileKinds?: string;
  notes?: string;
  sourcePage?: string;
  status: string;
  pulledAt: string | null;
  sourceUrl: string | null;
  rows: number;
  uniqueVuids: number;
  fileCount: number;
  days: RosterDay[];
  missingVuid?: number;
  earlyInPerson: number;
  mail: number;
  other: number;
  skippedMissingVuid?: number;
  skippedMissingVuidDays?: { date: string; missingVuid: number }[];
  error: string | null;
  running?: boolean;
};

type RosterSchedule = {
  enabled: boolean;
  timeZone: string;
};

type Board = {
  updatedAt: string | null;
  counties: Record<string, CountyPull>;
  schedule?: RosterSchedule;
  pulling?: { key: string; label: string } | null;
  pullQueue?: string[];
  matching?: { pending: number; found: number } | null;
};


type ProfileField = { label: string; value: string };

type VotedRow = {
  vuid: string;
  voteDate: string;
  matched: number;
  county: string | null;
  txHouse: string | null;
  txSenate: string | null;
  usHouse: string | null;
  score2022: number | null;
  score2026: number | null;
  registrationDate?: string | null;
  lookupChecked?: number;
  profile?: ProfileField[] | null;
};

type VoterSort = "voteDate" | "registrationDate";

function compactLabel(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function profileValue(fields: ProfileField[], aliases: string[]) {
  return fields.find((field) => aliases.includes(compactLabel(field.label)))?.value ?? "";
}

function displayName(fields: ProfileField[]) {
  const full = profileValue(fields, ["name", "fullname", "votername"]);
  if (full) return full;
  return [
    profileValue(fields, ["firstname", "first"]),
    profileValue(fields, ["middlename", "middle"]),
    profileValue(fields, ["lastname", "last"]),
    profileValue(fields, ["suffix"]),
  ]
    .filter(Boolean)
    .join(" ");
}

function displayAddress(fields: ProfileField[]) {
  const line1 = profileValue(fields, [
    "registrationaddr1",
    "residenceaddress",
    "residentialaddress",
    "address",
    "streetaddress",
    "voteraddress",
  ]);
  const line2 = profileValue(fields, ["registrationaddr2"]);
  const unit = [profileValue(fields, ["regunittype"]), profileValue(fields, ["regunitnumber"])].filter(Boolean).join(" ");
  const composed = [
    profileValue(fields, ["reghousenum"]),
    profileValue(fields, ["reghousesfx"]),
    profileValue(fields, ["regstprefix"]),
    profileValue(fields, ["regstname"]),
    profileValue(fields, ["regsttype"]),
    profileValue(fields, ["regstpost"]),
    unit,
  ]
    .filter(Boolean)
    .join(" ");
  const street = line1 ? [line1, line2].filter(Boolean) : [composed, line2].filter(Boolean);
  const city = profileValue(fields, ["regcity", "residencecity", "city", "votercity"]);
  const state = profileValue(fields, ["regsta", "residencestate", "state"]);
  const zip = profileValue(fields, ["regzip5", "residencezip", "zip", "zipcode", "voterzip"]);
  const cityLine = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [...street, cityLine].filter(Boolean).join("\n");
}

const IDENTITY_ALIASES = new Set([
  "name",
  "fullname",
  "votername",
  "firstname",
  "first",
  "middlename",
  "middle",
  "lastname",
  "last",
  "suffix",
  "residenceaddress",
  "residentialaddress",
  "address",
  "streetaddress",
  "voteraddress",
  "residencecity",
  "city",
  "votercity",
  "residencestate",
  "state",
  "residencezip",
  "zip",
  "zipcode",
  "voterzip",
  "registrationdate",
  "registrationdateofvoter",
  "regdate",
  "dateofregistration",
  "effectivedateofregistration",
  "voterregistrationdate",
  "registrationaddr1",
  "registrationaddr2",
  "reghousenum",
  "reghousesfx",
  "regstprefix",
  "regstname",
  "regsttype",
  "regstpost",
  "regunittype",
  "regunitnumber",
  "regcity",
  "regsta",
  "regzip5",
]);

function otherProfileFields(fields: ProfileField[]) {
  return fields.filter((field) => !IDENTITY_ALIASES.has(compactLabel(field.label)));
}

function prettyField(label: string) {
  if (label.includes(" ")) return label;
  return label.replace(/([a-z])([A-Z])/g, "$1 $2");
}

type VotedPage = {
  total: number;
  uniqueVuids: number;
  matched: number;
  unmatched: number;
  offset: number;
  limit: number;
  rows: VotedRow[];
};

const PAGE_SIZE = 100;
type CountySort = "name" | "voters" | "vote" | "pulled";

function previousIsoDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

function centralToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function latestVoteDate(days: RosterDay[] | undefined) {
  const today = centralToday();
  let latest = "";
  for (const day of days ?? []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.date) && day.date <= today && day.date > latest) latest = day.date;
  }
  return latest || null;
}

function voteDateIsCurrent(latest: string | null, pulledAt: string | null) {
  if (!latest) return false;
  const today = centralToday();
  if (latest >= previousIsoDate(today)) return true;
  if (!pulledAt) return false;
  const pulled = Date.parse(pulledAt);
  if (Number.isNaN(pulled)) return false;
  const pullDay = centralToday(new Date(pulled));
  if (pullDay !== today) return false;
  return latest >= previousIsoDate(pullDay);
}

function formatVoteDate(iso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function voteDayRows(pull: CountyPull | undefined) {
  const today = centralToday();
  const by = new Map<string, { date: string; voters: number; missingVuid: number }>();
  for (const day of pull?.days ?? []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.date) && day.date > today) continue;
    by.set(day.date, { date: day.date, voters: day.voters ?? 0, missingVuid: day.missingVuid ?? 0 });
  }
  for (const day of pull?.skippedMissingVuidDays ?? []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.date) && day.date > today) continue;
    const existing = by.get(day.date) ?? { date: day.date, voters: 0, missingVuid: 0 };
    existing.missingVuid += day.missingVuid;
    by.set(day.date, existing);
  }
  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function formatNum(n: number) {
  return n.toLocaleString("en-US");
}

function formatScore(n: number | null, digits: number) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
}

export function CountyRosterScreen({ electionId }: { electionId: string }) {
  const [view, setView] = useState<"voted" | "counties">("voted");
  const [board, setBoard] = useState<Board | null>(null);
  const [voted, setVoted] = useState<VotedPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "trained" | "waiting" | "behind">("all");
  const [sortKey, setSortKey] = useState<CountySort>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [voterSort, setVoterSort] = useState<VoterSort>("voteDate");
  const [voterDir, setVoterDir] = useState<"asc" | "desc">("asc");
  const [detail, setDetail] = useState<VotedRow | null>(null);
  const [dayCountyKey, setDayCountyKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function refresh() {
    const body = await apiJson<Board>("/api/county-rosters", { cache: "no-store" });
    setBoard(body);
    return body;
  }

  async function refreshVoted(nextOffset = offset, sort = voterSort, direction = voterDir) {
    const body = await apiJson<VotedPage>(
      `/api/county-rosters/voters?offset=${nextOffset}&limit=${PAGE_SIZE}&sort=${sort}&dir=${direction}`,
      { cache: "no-store" },
    );
    setVoted(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer = 0;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        await refresh();
        await refreshVoted(offset, voterSort, voterDir);
        if (!cancelled) setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load county rosters");
      } finally {
        inFlight = false;
      }
    }
    function arm() {
      timer = window.setTimeout(() => {
        void load().finally(() => {
          if (!cancelled) arm();
        });
      }, apiQuietMs() > 0 ? Math.max(60_000, apiQuietMs()) : 15000);
    }
    void load().finally(() => {
      if (!cancelled) arm();
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [offset, voterSort, voterDir]);

  useEffect(() => {
    if (!detail) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDetail(null);
        setDayCountyKey(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, dayCountyKey]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = TEXAS_COUNTIES.filter((county) => {
      const pullState = board?.counties[county.key];
      const trained = Boolean(pullState?.trained);
      if (filter === "trained" && !trained) return false;
      if (filter === "waiting" && trained) return false;
      if (filter === "behind") {
        if (!trained) return false;
        const latest = latestVoteDate(pullState?.days);
        if (!latest || voteDateIsCurrent(latest, pullState?.pulledAt ?? null)) return false;
      }
      if (!q) return true;
      return county.label.toLowerCase().includes(q) || county.key.includes(q);
    });
    const dir = sortDir === "asc" ? 1 : -1;
    const countyName = (county: (typeof TEXAS_COUNTIES)[number]) => county.label.replace(/ County$/, "");
    const voterCount = (county: (typeof TEXAS_COUNTIES)[number]) => {
      const pullState = board?.counties[county.key];
      if (!pullState?.trained) return null;
      return pullState.uniqueVuids ?? 0;
    };
    const voteDate = (county: (typeof TEXAS_COUNTIES)[number]) => {
      const pullState = board?.counties[county.key];
      if (!pullState?.trained) return null;
      return latestVoteDate(pullState.days);
    };
    const pulledAt = (county: (typeof TEXAS_COUNTIES)[number]) => {
      const pullState = board?.counties[county.key];
      if (!pullState?.trained || !pullState.pulledAt) return null;
      const time = Date.parse(pullState.pulledAt);
      return Number.isNaN(time) ? null : time;
    };
    return filtered.sort((a, b) => {
      if (sortKey === "name") return countyName(a).localeCompare(countyName(b)) * dir;
      const av = sortKey === "voters" ? voterCount(a) : sortKey === "vote" ? voteDate(a) : pulledAt(a);
      const bv = sortKey === "voters" ? voterCount(b) : sortKey === "vote" ? voteDate(b) : pulledAt(b);
      if (av == null && bv == null) return countyName(a).localeCompare(countyName(b));
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av !== bv) return av < bv ? -dir : dir;
      return countyName(a).localeCompare(countyName(b));
    });
  }, [board, filter, query, sortKey, sortDir]);

  function onCountySort(next: CountySort) {
    if (sortKey === next) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(next);
    setSortDir(next === "name" ? "asc" : "desc");
  }

  function countySortMark(key: CountySort) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  function onVoterSort(next: VoterSort) {
    if (voterSort === next) setVoterDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else {
      setVoterSort(next);
      setVoterDir("asc");
    }
    setOffset(0);
  }

  function voterSortMark(key: VoterSort) {
    if (voterSort !== key) return "";
    return voterDir === "asc" ? " ↑" : " ↓";
  }

  const pullingName = board?.pulling?.label ?? null;
  const pullQueue = board?.pullQueue ?? [];
  const matchingLabel = board?.matching
    ? board.matching.pending > 0
      ? `Matching ${formatNum(board.matching.pending)} voters to ballot scores`
      : "Matching voters to ballot scores"
    : null;
  const detailFields = detail?.profile ?? [];
  const detailName = displayName(detailFields);
  const detailAddress = displayAddress(detailFields);
  const detailRest = otherProfileFields(detailFields);

  const anyRunning = busyKey != null || Object.values(board?.counties ?? {}).some((county) => county.running || county.status === "running");

  async function pull(countyKey: string) {
    setBusyKey(countyKey);
    setError(null);
    try {
      const body = await apiJson<Board>(`/api/county-rosters/${countyKey}/pull`, { method: "POST" });
      setBoard(body);
      setOffset(0);
      await refreshVoted(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function pullAll() {
    setBusyKey("all");
    setError(null);
    try {
      const body = await apiJson<Board>("/api/county-rosters/pull-all", { method: "POST" });
      setBoard(body);
      setOffset(0);
      await refreshVoted(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setBusyKey(null);
    }
  }

  const dayCounty = TEXAS_COUNTIES.find((county) => county.key === dayCountyKey) ?? null;
  const dayPull = dayCountyKey ? board?.counties[dayCountyKey] : undefined;
  const dayRows = voteDayRows(dayPull);
  const dayLatest = latestVoteDate(dayPull?.days);
  const dayCurrent = voteDateIsCurrent(dayLatest, dayPull?.pulledAt ?? null);
  const skippedListed = (dayPull?.skippedMissingVuidDays ?? []).reduce((sum, day) => sum + day.missingVuid, 0);
  const undatedMissingVuid = Math.max(0, (dayPull?.skippedMissingVuid ?? 0) - skippedListed);
  const page = voted ? Math.floor(voted.offset / PAGE_SIZE) + 1 : 1;
  const pageCount = Math.max(1, Math.ceil((voted?.total ?? 0) / PAGE_SIZE));
  const rangeStart = voted && voted.total > 0 ? voted.offset + 1 : 0;
  const rangeEnd = voted ? Math.min(voted.offset + voted.rows.length, voted.total) : 0;

  if (electionId && !electionHasRosterScores(electionId)) {
    return <ElectionDatasetNotice dataset="County rosters" />;
  }

  return (
      <main className="enr-ballot">
        <div className="enr-ballot__filters">
          <button
            type="button"
            className={view === "voted" ? "enr-btn enr-btn--primary" : "enr-btn enr-btn--ghost"}
            onClick={() => setView("voted")}
          >
            Voted
          </button>
          <button
            type="button"
            className={view === "counties" ? "enr-btn enr-btn--primary" : "enr-btn enr-btn--ghost"}
            onClick={() => setView("counties")}
          >
            County pulls
          </button>
          {view === "voted" ? (
            <button type="button" className="enr-btn enr-btn--pull" disabled={anyRunning} onClick={() => void pullAll()}>
              {pullingName ? `Pulling ${pullingName}…` : "Pull all rosters"}
            </button>
          ) : null}
          <a className="enr-btn enr-btn--ghost" href={apiUrl(`/api/county-rosters/export.csv?sort=${voterSort}&dir=${voterDir}`)}>
            Export CSV
          </a>
        </div>
        {error ? <p className="enr-ballot__status enr-ballot__status--error">{error}</p> : null}
        {pullingName || matchingLabel ? (
          <p className="enr-roster-pulling" role="status">
            {pullingName ? `Pulling ${pullingName}` : ""}
            {pullingName && pullQueue.length ? ` · next ${pullQueue.join(", ")}` : ""}
            {pullingName && matchingLabel ? " · " : ""}
            {matchingLabel ?? ""}
          </p>
        ) : null}

        {view === "voted" ? (
          <>
            <section className="enr-ballot__kpis enr-ballot__kpis--counts" aria-label="Statewide counts">
              <article className="enr-ballot__kpi">
                <div className="enr-ballot__kpi-label">Statewide roster rows</div>
                <div className="enr-ballot__kpi-value">{voted ? formatNum(voted.total) : "…"}</div>
              </article>
              <article className="enr-ballot__kpi">
                <div className="enr-ballot__kpi-label">Unique voters</div>
                <div className="enr-ballot__kpi-value">{voted ? formatNum(voted.uniqueVuids) : "…"}</div>
              </article>
              <article className="enr-ballot__kpi">
                <div className="enr-ballot__kpi-label">Matched</div>
                <div className="enr-ballot__kpi-value">{voted ? formatNum(voted.matched) : "…"}</div>
              </article>
              <article className="enr-ballot__kpi">
                <div className="enr-ballot__kpi-label">Still to match</div>
                <div className="enr-ballot__kpi-value">{voted ? formatNum(voted.unmatched) : "…"}</div>
              </article>
            </section>
            <section className="enr-card">
              <div className="enr-ev-roster__pager">
                <button type="button" className="enr-btn enr-btn--ghost" disabled={page <= 1} onClick={() => setOffset(0)}>
                  First
                </button>
                <button
                  type="button"
                  className="enr-btn enr-btn--ghost"
                  disabled={page <= 1}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </button>
                <span className="enr-ev-roster__pager-meta">
                  Page {formatNum(page)} of {formatNum(pageCount)} · {formatNum(rangeStart)}–{formatNum(rangeEnd)} of{" "}
                  {formatNum(voted?.total ?? 0)}
                </span>
                <button
                  type="button"
                  className="enr-btn enr-btn--ghost"
                  disabled={page >= pageCount}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
              <div className="enr-tablewrap">
                <table className="enr-table enr-table--compact enr-roster-table">
                  <thead>
                    <tr>
                      <th aria-sort={voterSort === "voteDate" ? (voterDir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className="enr-ballot__sort" onClick={() => onVoterSort("voteDate")}>
                          Vote date{voterSortMark("voteDate")}
                        </button>
                      </th>
                      <th>VUID</th>
                      <th aria-sort={voterSort === "registrationDate" ? (voterDir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className="enr-ballot__sort" onClick={() => onVoterSort("registrationDate")}>
                          Registration date{voterSortMark("registrationDate")}
                        </button>
                      </th>
                      <th className="num">2026 model</th>
                      <th className="num">2022 model</th>
                      <th>County</th>
                      <th>State House</th>
                      <th>State Senate</th>
                      <th>Congress</th>
                      <th className="num">Matched</th>
                      <th className="enr-roster-info">Info</th>
                    </tr>
                  </thead>
                  <tbody>
                    {voted?.rows.length ? (
                      voted.rows.map((row) => (
                        <tr key={`${row.vuid}|${row.voteDate}`}>
                          <td>{row.voteDate}</td>
                          <td>{row.vuid}</td>
                          <td>{row.registrationDate || "—"}</td>
                          <td className="num">{formatScore(row.score2026, 1)}</td>
                          <td className="num">{formatScore(row.score2022, 3)}</td>
                          <td>{row.county || "—"}</td>
                          <td>{row.txHouse || "—"}</td>
                          <td>{row.txSenate || "—"}</td>
                          <td>{row.usHouse || "—"}</td>
                          <td className="num">{row.matched === 1 ? 1 : 0}</td>
                          <td className="enr-roster-info">
                            <button
                              type="button"
                              className="enr-voter-info"
                              aria-label={`Voter details for ${row.vuid}`}
                              onClick={() => setDetail(row)}
                            >
                              i
                            </button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={11}>No voted rows yet. Pull all rosters to load a trained county.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            {detail ? (
              <div className="enr-voter-dialog" role="dialog" aria-modal="true" aria-labelledby="voter-info-title">
                <button type="button" className="enr-voter-dialog__backdrop" aria-label="Close voter details" onClick={() => setDetail(null)} />
                <div className="enr-voter-dialog__panel">
                  <div className="enr-voter-dialog__head">
                    <h2 id="voter-info-title">{detailName || `VUID ${detail.vuid}`}</h2>
                    <button type="button" className="enr-btn enr-btn--ghost" onClick={() => setDetail(null)}>
                      Close
                    </button>
                  </div>
                  <p className="enr-muted">
                    VUID {detail.vuid}
                    {detail.registrationDate ? ` · registered ${detail.registrationDate}` : ""}
                  </p>
                  {detail.matched !== 1 ? (
                    detail.lookupChecked === 1 ? (
                      <p>This voter is not on the current voter file.</p>
                    ) : (
                      <p>This voter is still waiting to be matched to the voter file.</p>
                    )
                  ) : detailFields.length ? (
                    <dl className="enr-voter-dialog__facts">
                      {detailName ? (
                        <div>
                          <dt>Name</dt>
                          <dd>{detailName}</dd>
                        </div>
                      ) : null}
                      {detailAddress ? (
                        <div>
                          <dt>Address</dt>
                          <dd>{detailAddress}</dd>
                        </div>
                      ) : null}
                      {detailRest.map((field) => (
                        <div key={field.label}>
                          <dt>{prettyField(field.label)}</dt>
                          <dd>{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p>This voter is matched. The voter file does not have name, address, or other detail columns yet.</p>
                  )}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <section className="enr-card">
            <div className="enr-card__head enr-ballot__head">
              <h2 className="enr-card__title">Counties</h2>
              <div className="enr-ballot__filters">
                <input
                  className="enr-ballot__search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search counties"
                  aria-label="Search counties"
                />
                <label className="enr-selectLabel">
                  Show
                  <select className="enr-select" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
                    <option value="all">All counties</option>
                    <option value="trained">Trained</option>
                    <option value="behind">Needs a pull</option>
                    <option value="waiting">Not trained</option>
                  </select>
                </label>
              </div>
            </div>
            <p className="enr-ballot__schedule">
              {board?.schedule?.enabled
                ? "Automatic pulls run in the background at 9:00, 10:00, 11:00, and 12:00 Central, Monday through Saturday, until a county's roster includes ballots from the day before."
                : "Automatic pulls are off. Pull all rosters updates every trained county."}
            </p>
            <div className="enr-tablewrap">
              <table className="enr-table enr-table--compact enr-roster-table">
                <thead>
                  <tr>
                    <th aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" className="enr-ballot__sort" onClick={() => onCountySort("name")}>
                        County{countySortMark("name")}
                      </button>
                    </th>
                    <th>Training</th>
                    <th className="num" aria-sort={sortKey === "voters" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" className="enr-ballot__sort" onClick={() => onCountySort("voters")}>
                        Voters{countySortMark("voters")}
                      </button>
                    </th>
                    <th aria-sort={sortKey === "vote" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" className="enr-ballot__sort" onClick={() => onCountySort("vote")}>
                        Latest vote{countySortMark("vote")}
                      </button>
                    </th>
                    <th aria-sort={sortKey === "pulled" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" className="enr-ballot__sort" onClick={() => onCountySort("pulled")}>
                        Last pull{countySortMark("pulled")}
                      </button>
                    </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        {filter === "behind" && !query.trim()
                          ? "Every trained county is current."
                          : "No counties match this filter."}
                      </td>
                    </tr>
                  ) : null}
                  {rows.map((county) => {
                    const pullState = board?.counties[county.key];
                    const trained = Boolean(pullState?.trained);
                    const running = pullState?.running || pullState?.status === "running" || busyKey === county.key;
                    const latest = trained ? latestVoteDate(pullState?.days) : null;
                    const current = voteDateIsCurrent(latest, pullState?.pulledAt ?? null);
                    return (
                      <tr key={county.key}>
                        <td>
                          {pullState?.sourcePage ? (
                            <a className="enr-roster-source" href={pullState.sourcePage} target="_blank" rel="noopener noreferrer">
                              {county.label.replace(/ County$/, "")}
                            </a>
                          ) : (
                            county.label.replace(/ County$/, "")
                          )}
                        </td>
                        <td>{!board ? "…" : trained ? "Trained" : "Not trained"}</td>
                        <td className="num">{trained ? formatNum(pullState?.uniqueVuids ?? 0) : "—"}</td>
                        <td>
                          {latest ? (
                            <button
                              type="button"
                              className={`enr-roster-date${current ? " is-current" : " is-behind"}`}
                              onClick={() => setDayCountyKey(county.key)}
                            >
                              <span className="enr-roster-date__day">{formatVoteDate(latest)}</span>
                              <span className="enr-roster-date__state">{current ? "Current" : "Needs a pull"}</span>
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{trained ? formatWhen(pullState?.pulledAt ?? null) : "—"}</td>
                        <td>
                          {trained ? (
                            <button
                              type="button"
                              className="enr-btn enr-btn--pull"
                              disabled={anyRunning}
                              onClick={() => void pull(county.key)}
                            >
                              {running ? `Pulling ${county.label.replace(/ County$/, "")}…` : "Pull roster"}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {dayCounty && dayPull ? (
          <div className="enr-voter-dialog" role="dialog" aria-modal="true" aria-labelledby="roster-days-title">
            <button type="button" className="enr-voter-dialog__backdrop" aria-label="Close vote days" onClick={() => setDayCountyKey(null)} />
            <div className="enr-voter-dialog__panel enr-voter-dialog__panel--days">
              <div className="enr-voter-dialog__head">
                <h2 id="roster-days-title">{dayCounty.label.replace(/ County$/, "")} vote days</h2>
                <button type="button" className="enr-btn enr-btn--ghost" onClick={() => setDayCountyKey(null)}>
                  Close
                </button>
              </div>
              <p className="enr-muted">
                {dayCurrent
                  ? `${formatVoteDate(dayLatest ?? "")} is current. No automatic pull is needed for the rest of today. Pull roster still updates this county.`
                  : dayLatest
                    ? `${formatVoteDate(dayLatest)} is older than the day before the last pull. An automatic pull will try again at the next scheduled hour.`
                    : "No vote dates are stored for this county yet."}
              </p>
              {dayRows.length ? (
                <div className="enr-roster-days-scroll">
                  <table className="enr-table enr-table--compact enr-roster-days">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th className="num">Voters</th>
                        <th className="num">No VUID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dayRows.map((day) => (
                        <tr key={day.date}>
                          <td>{formatVoteDate(day.date)}</td>
                          <td className="num">{formatNum(day.voters)}</td>
                          <td className="num">{day.missingVuid ? formatNum(day.missingVuid) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No vote days are stored yet.</p>
              )}
              {dayPull.skippedMissingVuidDays?.length ? (
                undatedMissingVuid ? (
                  <p className="enr-muted">{formatNum(undatedMissingVuid)} more rows on the last pull had no VUID and no vote date.</p>
                ) : null
              ) : dayPull.skippedMissingVuid ? (
                <p className="enr-muted">{formatNum(dayPull.skippedMissingVuid)} rows on the last pull had no VUID.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </main>
  );
}
