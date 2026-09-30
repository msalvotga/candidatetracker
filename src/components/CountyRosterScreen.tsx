import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/apiBase";
import { TEXAS_COUNTIES } from "../lib/texasCounties";

type RosterDay = { date: string; voters: number; earlyInPerson: number; mail: number };

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
  earlyInPerson: number;
  mail: number;
  other: number;
  skippedMissingVuid?: number;
  error: string | null;
  running?: boolean;
};

type RosterSchedule = {
  enabled: boolean;
  intervalMinutes: number;
  startHour: number;
  endHour: number;
  timeZone: string;
};

type Board = {
  updatedAt: string | null;
  counties: Record<string, CountyPull>;
  schedule?: RosterSchedule;
  pulling?: { key: string; label: string } | null;
  pullQueue?: string[];
};

function hourLabel(hour: number) {
  const h = hour % 12 || 12;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${h}:00 ${suffix}`;
}

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
type CountySort = "name" | "voters" | "pulled";

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

export function CountyRosterScreen({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<"voted" | "counties">("voted");
  const [board, setBoard] = useState<Board | null>(null);
  const [voted, setVoted] = useState<VotedPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "trained" | "waiting">("all");
  const [sortKey, setSortKey] = useState<CountySort>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [voterSort, setVoterSort] = useState<VoterSort>("voteDate");
  const [voterDir, setVoterDir] = useState<"asc" | "desc">("asc");
  const [detail, setDetail] = useState<VotedRow | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function refresh() {
    const response = await apiFetch("/api/county-rosters", { cache: "no-store" });
    const body = (await response.json()) as Board & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not load county rosters");
    setBoard(body);
    return body;
  }

  async function refreshVoted(nextOffset = offset, sort = voterSort, direction = voterDir) {
    const response = await apiFetch(
      `/api/county-rosters/voters?offset=${nextOffset}&limit=${PAGE_SIZE}&sort=${sort}&dir=${direction}`,
      { cache: "no-store" },
    );
    const body = (await response.json()) as VotedPage & { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not load voted voters");
    setVoted(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    void refresh().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "Could not load county rosters");
    });
    void refreshVoted(offset, voterSort, voterDir).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "Could not load voted voters");
    });
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
      void refreshVoted(offset, voterSort, voterDir).catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [offset, voterSort, voterDir]);

  useEffect(() => {
    if (!detail) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setDetail(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = TEXAS_COUNTIES.filter((county) => {
      const trained = Boolean(board?.counties[county.key]?.trained);
      if (filter === "trained" && !trained) return false;
      if (filter === "waiting" && trained) return false;
      if (!q) return true;
      return county.label.toLowerCase().includes(q) || county.key.includes(q);
    });
    const dir = sortDir === "asc" ? 1 : -1;
    const countyName = (county: (typeof TEXAS_COUNTIES)[number]) => county.label.replace(/ County$/, "");
    const voterCount = (county: (typeof TEXAS_COUNTIES)[number]) => {
      const pullState = board?.counties[county.key];
      if (!pullState?.trained || pullState.status !== "ready") return null;
      return pullState.uniqueVuids;
    };
    const pulledAt = (county: (typeof TEXAS_COUNTIES)[number]) => {
      const pullState = board?.counties[county.key];
      if (!pullState?.trained || !pullState.pulledAt) return null;
      const time = Date.parse(pullState.pulledAt);
      return Number.isNaN(time) ? null : time;
    };
    return filtered.sort((a, b) => {
      if (sortKey === "name") return countyName(a).localeCompare(countyName(b)) * dir;
      const av = sortKey === "voters" ? voterCount(a) : pulledAt(a);
      const bv = sortKey === "voters" ? voterCount(b) : pulledAt(b);
      if (av == null && bv == null) return countyName(a).localeCompare(countyName(b));
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av !== bv) return (av - bv) * dir;
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
  const detailFields = detail?.profile ?? [];
  const detailName = displayName(detailFields);
  const detailAddress = displayAddress(detailFields);
  const detailRest = otherProfileFields(detailFields);

  const anyRunning = busyKey != null || Object.values(board?.counties ?? {}).some((county) => county.running || county.status === "running");

  async function pull(countyKey: string) {
    setBusyKey(countyKey);
    setError(null);
    try {
      const response = await apiFetch(`/api/county-rosters/${countyKey}/pull`, { method: "POST" });
      const body = (await response.json()) as Board & { error?: string };
      if (!response.ok) throw new Error(body.error || "Pull failed");
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
      const response = await apiFetch("/api/county-rosters/pull-all", { method: "POST" });
      const body = (await response.json()) as Board & { error?: string };
      if (!response.ok) throw new Error(body.error || "Pull failed");
      setBoard(body);
      setOffset(0);
      await refreshVoted(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setBusyKey(null);
    }
  }

  const page = voted ? Math.floor(voted.offset / PAGE_SIZE) + 1 : 1;
  const pageCount = Math.max(1, Math.ceil((voted?.total ?? 0) / PAGE_SIZE));
  const rangeStart = voted && voted.total > 0 ? voted.offset + 1 : 0;
  const rangeEnd = voted ? Math.min(voted.offset + voted.rows.length, voted.total) : 0;

  return (
    <>
      <header className="enr-top">
        <div className="enr-top__row">
          <div className="enr-brand">County rosters</div>
          <div className="enr-top__center">
            <span className="enr-official enr-official--muted">Voter roster pulls</span>
          </div>
          <div className="enr-top__right">
            <button type="button" className="enr-btn enr-btn--ghost" onClick={onBack}>
              Back
            </button>
          </div>
        </div>
      </header>
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
        </div>
        {error ? <p className="enr-ballot__status enr-ballot__status--error">{error}</p> : null}
        {pullingName ? (
          <p className="enr-roster-pulling" role="status">
            Pulling {pullingName}
            {pullQueue.length ? ` · next ${pullQueue.join(", ")}` : ""}
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
                    <p>This voter is not on the current voter file.</p>
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
                    <option value="waiting">Not trained</option>
                  </select>
                </label>
              </div>
            </div>
            <p className="enr-ballot__schedule">
              {board?.schedule?.enabled
                ? `Automatic pulls run every ${board.schedule.intervalMinutes} minutes from ${hourLabel(board.schedule.startHour)} through ${hourLabel(board.schedule.endHour)} Central, when a county's last pull is older than that interval.`
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
                    <th className="num">Days</th>
                    <th aria-sort={sortKey === "pulled" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" className="enr-ballot__sort" onClick={() => onCountySort("pulled")}>
                        Last pull{countySortMark("pulled")}
                      </button>
                    </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((county) => {
                    const pullState = board?.counties[county.key];
                    const trained = Boolean(pullState?.trained);
                    const running = pullState?.running || pullState?.status === "running" || busyKey === county.key;
                    return (
                      <tr key={county.key}>
                        <td>{county.label.replace(/ County$/, "")}</td>
                        <td>{!board ? "…" : trained ? "Trained" : "Not trained"}</td>
                        <td className="num">
                          {trained && pullState?.status === "ready" ? formatNum(pullState.uniqueVuids) : "—"}
                          {trained && pullState?.skippedMissingVuid ? (
                            <div className="enr-ballot__n">{formatNum(pullState.skippedMissingVuid)} without a VUID</div>
                          ) : null}
                        </td>
                        <td className="num">{trained && pullState?.status === "ready" ? formatNum(pullState.days.length) : "—"}</td>
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
      </main>
    </>
  );
}
