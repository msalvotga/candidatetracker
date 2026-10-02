import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../lib/apiBase";
import "./polling.css";

type PollRow = {
  id: number;
  externalKey: string;
  pollster: string;
  sponsor: string | null;
  sponsorType: string;
  fieldLabel: string;
  midpoint: string | null;
  releaseDate: string | null;
  sampleSize: number | null;
  sampleType: string | null;
  moe: number | null;
  designEffectMoe: number | null;
  abbott: number | null;
  hinojosa: number | null;
  other: number | null;
  undecided: number | null;
  margin: number | null;
  ballot: string | null;
  question: string | null;
  population: string | null;
  weighting: string | null;
  notes: string | null;
  status: string;
  approved: boolean;
  inModel: boolean;
  excluded: boolean;
  warnings: string[];
  messages: { level: string; code: string; message: string }[];
  weights: null | {
    precision: number;
    recency: number;
    sampleType: number;
    sponsorship: number;
    cluster: number;
    clusterSize: number;
    final: number;
    seMargin: number;
    nEff: number | null;
    nEffEstimated: boolean;
    precisionNote: string;
    houseEffect: number | null;
  };
  sources: { tier: number; type: string; url: string; publisher: string | null; isPrimary: boolean; notes: string | null; localFile: string | null }[];
  methodology: string | null;
  results: { candidate: string; party: string | null; percentage: number | null; symbol: string | null; type: string }[];
  subgroups: { dimension: string; original: string; normalized: string; candidate: string; percentage: number | null; n: number | null; definition: string | null; notes: string | null }[];
  alternateFrames: { sample_type?: string; sample_size?: number; reported_moe?: number; notes?: string; results?: { candidate: string; percentage: number }[] }[];
  completeness: { score: number; label: string };
  outlier: { fitted: number; residual: number; standardized: number; flagged: boolean } | null;
};

type Snapshot = {
  meta: {
    asOf: string;
    generatedAt: string;
    softwareVersion: string;
    disclaimer: string;
    halfLifeDays: number;
    halfLifeLabel: string;
    colors: { candidate_a_color?: string; candidate_b_color?: string };
    candidateA: string;
    candidateB: string;
  };
  overview: {
    label: string;
    margin: number | null;
    interval80Label: string | null;
    interval95Label: string | null;
    pollsInModel: number;
    pollstersInModel: number;
    pollsStored: number;
    lvCount: number;
    rvCount: number;
    lvWeightShare: number;
    rvWeightShare: number;
    latestRelease: PollRow | null;
    lastFieldMidpoint: string | null;
    trendHoldNote: string;
    houseEffectApplied: boolean;
  };
  daily: {
    date: string;
    weighted: number | null;
    low80: number | null;
    high80: number | null;
    low95: number | null;
    high95: number | null;
    stateSpace: number | null;
    unweighted: number | null;
    sampleSize: number | null;
    lvOnly: number | null;
    rvOnly: number | null;
  }[];
  polls: PollRow[];
  comparisons: Record<string, string | number | null>;
  subgroups: {
    dimension: string;
    normalized: string;
    originalLabels: string[];
    polls: number;
    knownN: number | null;
    nMissing: number;
    currentLabel: string;
    precisionNote: string;
    points: { pollster: string; date: string; margin: number; n: number | null }[];
  }[];
  pollsters: {
    pollster: string;
    polls: number;
    averageN: number | null;
    sampleTypes: string[];
    averageWeight: number | null;
    houseLabel: string | null;
    houseEffect: number | null;
    houseSe: number | null;
  }[];
  quality: { label: string; note: string; meanCompleteness: number | null; issues: Record<string, number> };
  settings: {
    recency: { half_life_days: number; adaptive: { enabled: boolean } };
    sample_type: { mode: string; weights: { LV: number; RV: number; Adults: number } };
    precision: { tau_pp: number };
    sponsorship_weights: Record<string, number>;
    outliers: { standardized_threshold: number };
    clustering: { window_days: number; method: string };
    house_effects: { apply: boolean };
    trend: { bandwidth_days: number };
    display: { candidate_a_color: string; candidate_b_color: string };
  };
};

const TABS = ["Overview", "Polls", "Comparison", "Subgroups", "Pollsters", "Settings", "Review"] as const;

function pct(value: number | null | undefined, digits = 0) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}`;
}

export function PollingScreen() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [sampleFilter, setSampleFilter] = useState("all");
  const [pollsterFilter, setPollsterFilter] = useState("all");
  const [ballotFilter, setBallotFilter] = useState("all");
  const [modelOnly, setModelOnly] = useState(false);
  const [dimension, setDimension] = useState("all");

  async function load() {
    setError(null);
    const response = await apiFetch("/api/polling/state");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The polling archive did not load.");
    setState(body);
  }

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, []);

  async function post(path: string, payload?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Request failed");
      if (body.overview) setState(body);
      else await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const selected = state?.polls.find((poll) => poll.id === selectedId) ?? null;
  const pollsters = useMemo(() => [...new Set(state?.polls.map((poll) => poll.pollster) ?? [])], [state]);
  const ballots = useMemo(() => [...new Set(state?.polls.map((poll) => poll.ballot || "unspecified") ?? [])], [state]);
  const filtered = (state?.polls ?? []).filter((poll) => {
    if (modelOnly && !poll.inModel) return false;
    if (sampleFilter !== "all" && poll.sampleType !== sampleFilter) return false;
    if (pollsterFilter !== "all" && poll.pollster !== pollsterFilter) return false;
    if (ballotFilter !== "all" && (poll.ballot || "unspecified") !== ballotFilter) return false;
    return true;
  });

  if (error && !state) return <div className="poll-page"><div className="poll-wrap poll-error">{error}</div></div>;
  if (!state) return <div className="poll-page"><div className="poll-wrap">Loading the polling archive…</div></div>;

  return (
    <div className="poll-page">
      <div className="poll-wrap">
        <div className="poll-kicker">Polling laboratory · {state.meta.asOf}</div>
        <h1>Texas Governor Poll Trend</h1>
        <p className="poll-disclaimer">{state.meta.disclaimer} A positive number is a lead for {state.meta.candidateA}. The RealClearPolitics average is never an input.</p>
        {error ? <div className="poll-error">{error}</div> : null}
        <div className="poll-tabs">
          {TABS.map((item) => (
            <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>
          ))}
        </div>
        {busy ? <p className="poll-muted">Recalculating…</p> : null}

        {tab === "Overview" ? <Overview state={state} onSelect={setSelectedId} /> : null}
        {tab === "Polls" ? (
          <PollTable
            rows={filtered}
            pollsters={pollsters}
            ballots={ballots}
            sampleFilter={sampleFilter}
            pollsterFilter={pollsterFilter}
            ballotFilter={ballotFilter}
            modelOnly={modelOnly}
            onSample={setSampleFilter}
            onPollster={setPollsterFilter}
            onBallot={setBallotFilter}
            onModelOnly={setModelOnly}
            onSelect={setSelectedId}
            selectedId={selectedId}
          />
        ) : null}
        {tab === "Comparison" ? <Comparison state={state} /> : null}
        {tab === "Subgroups" ? <Subgroups state={state} dimension={dimension} onDimension={setDimension} /> : null}
        {tab === "Pollsters" ? <Pollsters state={state} /> : null}
        {tab === "Settings" ? <Settings state={state} onSave={(patch) => post("/api/polling/settings", patch)} onReset={() => post("/api/polling/settings/reset")} /> : null}
        {tab === "Review" ? <Review state={state} onPost={post} /> : null}
        {selected ? <Detail poll={selected} onClose={() => setSelectedId(null)} onPost={post} /> : null}
      </div>
    </div>
  );
}

function Overview({ state, onSelect }: { state: Snapshot; onSelect: (id: number) => void }) {
  const modeled = state.polls.filter((poll) => poll.inModel).sort((a, b) => (b.weights?.final ?? 0) - (a.weights?.final ?? 0));
  return (
    <>
      <div className="poll-grid">
        <section className="poll-card">
          <div className="poll-kicker">Estimated current polling margin</div>
          <div className="poll-margin" style={{ color: (state.overview.margin ?? 0) >= 0 ? state.meta.colors.candidate_a_color : state.meta.colors.candidate_b_color }}>
            {state.overview.label}
          </div>
          <p>80% interval: {state.overview.interval80Label ?? "—"}</p>
          <p>95% interval: {state.overview.interval95Label ?? "—"}</p>
          <p className="poll-muted">{state.overview.trendHoldNote} Newest fieldwork midpoint: {state.overview.lastFieldMidpoint ?? "—"}.</p>
          <div className="poll-meta">
            <div><span>Polls in model</span>{state.overview.pollsInModel} of {state.overview.pollsStored}</div>
            <div><span>Pollsters</span>{state.overview.pollstersInModel}</div>
            <div><span>LV / RV counts</span>{state.overview.lvCount} / {state.overview.rvCount}</div>
            <div><span>LV / RV weight</span>{pct((state.overview.lvWeightShare ?? 0) * 100)}% / {pct((state.overview.rvWeightShare ?? 0) * 100)}%</div>
            <div><span>Half-life</span>{state.meta.halfLifeDays} days</div>
            <div><span>House effects</span>{state.overview.houseEffectApplied ? "Applied" : "Off"}</div>
          </div>
          <p className="poll-muted">{state.meta.halfLifeLabel}. Latest release: {state.overview.latestRelease?.pollster ?? "—"} {state.overview.latestRelease?.releaseDate ?? ""}.</p>
        </section>
        <TrendChart state={state} />
      </div>
      <h2>What is driving the estimate</h2>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead>
            <tr><th>Poll</th><th>Margin</th><th>Precision</th><th>Recency</th><th>Sample</th><th>Sponsor</th><th>Cluster</th><th>Final weight</th></tr>
          </thead>
          <tbody>
            {modeled.map((poll) => (
              <tr key={poll.id}>
                <td><button type="button" className="linkish" onClick={() => onSelect(poll.id)}>{poll.pollster}</button><div className="poll-muted">{poll.fieldLabel}</div></td>
                <td>{poll.margin != null ? poll.margin.toFixed(1) : "—"}</td>
                <td>{poll.weights ? poll.weights.precision.toFixed(3) : "—"}</td>
                <td>{poll.weights ? poll.weights.recency.toFixed(2) : "—"}</td>
                <td>{poll.weights ? `${poll.sampleType} × ${poll.weights.sampleType.toFixed(2)}` : "—"}</td>
                <td>{poll.weights ? poll.weights.sponsorship.toFixed(2) : "—"}</td>
                <td>{poll.weights ? `${poll.weights.cluster.toFixed(2)} (${poll.weights.clusterSize})` : "—"}</td>
                <td>{poll.weights ? `${(poll.weights.final * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TrendChart({ state }: { state: Snapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    let plotly: { purge: (el: HTMLElement) => void; newPlot: (el: HTMLElement, data: unknown[], layout?: object, config?: object) => Promise<void> } | null = null;
    (async () => {
      const Plotly = (await import("plotly.js-basic-dist")).default;
      if (cancelled || !host) return;
      plotly = Plotly;
      const days = state.daily.map((row) => row.date);
      const a = state.meta.colors.candidate_a_color || "#9f1d2e";
      const modeled = state.polls.filter((poll) => poll.inModel && poll.margin != null);
      const traces = [
        { x: days, y: state.daily.map((row) => row.high95), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        { x: days, y: state.daily.map((row) => row.low95), mode: "lines", fill: "tonexty", fillcolor: "rgba(15,43,82,0.12)", line: { width: 0 }, name: "95% interval", hovertemplate: "%{x}<br>95% band %{y:.1f}<extra></extra>" },
        { x: days, y: state.daily.map((row) => row.high80), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        { x: days, y: state.daily.map((row) => row.low80), mode: "lines", fill: "tonexty", fillcolor: "rgba(15,43,82,0.2)", line: { width: 0 }, name: "80% interval" },
        { x: days, y: state.daily.map((row) => row.weighted), mode: "lines", name: "Weighted trend", line: { color: "#0b2b52", width: 2.4 } },
        { x: days, y: state.daily.map((row) => row.stateSpace), mode: "lines", name: "State-space", line: { color: "#1d4f91", width: 1.4, dash: "dot" } },
        {
          x: modeled.map((poll) => poll.midpoint || poll.fieldLabel.slice(0, 10)),
          y: modeled.map((poll) => poll.margin),
          mode: "markers",
          name: "Polls",
          marker: {
            size: modeled.map((poll) => 9 + (poll.weights?.final ?? 0) * 40),
            color: modeled.map((poll) => ((poll.margin ?? 0) >= 0 ? a : state.meta.colors.candidate_b_color || "#1d4f91")),
          },
          text: modeled.map((poll) => `${poll.pollster}<br>margin ${poll.margin?.toFixed(1)}<br>weight ${((poll.weights?.final ?? 0) * 100).toFixed(1)}%`),
          hovertemplate: "%{text}<extra></extra>",
        },
      ];
      await Plotly.newPlot(host, traces, {
        margin: { l: 48, r: 16, t: 24, b: 40 },
        paper_bgcolor: "#fff",
        plot_bgcolor: "#fff",
        yaxis: { title: "Abbott margin (points)", zeroline: true, zerolinecolor: "#9aa6b2" },
        xaxis: { title: "Date" },
        legend: { orientation: "h", y: 1.12 },
        hovermode: "closest",
      }, { responsive: true, displaylogo: false });
    })();
    return () => {
      cancelled = true;
      if (plotly && host) plotly.purge(host);
    };
  }, [state]);
  return <div className="poll-card poll-chart" ref={ref} />;
}

function PollTable(props: {
  rows: PollRow[];
  pollsters: string[];
  ballots: string[];
  sampleFilter: string;
  pollsterFilter: string;
  ballotFilter: string;
  modelOnly: boolean;
  onSample: (value: string) => void;
  onPollster: (value: string) => void;
  onBallot: (value: string) => void;
  onModelOnly: (value: boolean) => void;
  onSelect: (id: number) => void;
  selectedId: number | null;
}) {
  return (
    <>
      <div className="poll-filters">
        <select value={props.sampleFilter} onChange={(event) => props.onSample(event.target.value)} aria-label="Sample type">
          <option value="all">All samples</option>
          <option>LV</option><option>RV</option><option>Adults</option><option>Other</option>
        </select>
        <select value={props.pollsterFilter} onChange={(event) => props.onPollster(event.target.value)} aria-label="Pollster">
          <option value="all">All pollsters</option>
          {props.pollsters.map((name) => <option key={name}>{name}</option>)}
        </select>
        <select value={props.ballotFilter} onChange={(event) => props.onBallot(event.target.value)} aria-label="Ballot format">
          <option value="all">All ballots</option>
          {props.ballots.map((name) => <option key={name}>{name}</option>)}
        </select>
        <label><input type="checkbox" checked={props.modelOnly} onChange={(event) => props.onModelOnly(event.target.checked)} /> In model only</label>
      </div>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead>
            <tr>
              <th>Pollster</th><th>Sponsor</th><th>Field</th><th>Released</th><th>N</th><th>Sample</th><th>MOE</th>
              <th>Abbott</th><th>Hinojosa</th><th>Other</th><th>Undecided</th><th>Margin</th><th>Ballot</th><th>Weight</th><th>Review</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((poll) => (
              <tr key={poll.id} className={poll.id === props.selectedId ? "is-selected" : ""}>
                <td><button type="button" className="linkish" onClick={() => props.onSelect(poll.id)}>{poll.pollster}</button></td>
                <td>{poll.sponsor || "—"}</td>
                <td>{poll.fieldLabel || "—"}</td>
                <td>{poll.releaseDate || "—"}</td>
                <td>{poll.sampleSize ?? "—"}</td>
                <td>{poll.sampleType || "—"}</td>
                <td>{poll.designEffectMoe ?? poll.moe ?? "—"}</td>
                <td>{pct(poll.abbott, 1)}</td>
                <td>{pct(poll.hinojosa, 1)}</td>
                <td>{pct(poll.other, 1)}</td>
                <td>{pct(poll.undecided, 1)}</td>
                <td>{poll.margin == null ? "—" : poll.margin.toFixed(1)}</td>
                <td>{poll.ballot || "—"}</td>
                <td>{poll.weights ? `${(poll.weights.final * 100).toFixed(1)}%` : "—"}</td>
                <td>{poll.inModel ? "In model" : poll.status}{poll.outlier?.flagged ? " · outlier flag" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Comparison({ state }: { state: Snapshot }) {
  const rows: [string, string][] = [
    ["Weighted trend", String(state.comparisons.weightedLabel ?? "—")],
    ["State-space trend", String(state.comparisons.stateSpaceLabel ?? "—")],
    ["Unweighted local mean", String(state.comparisons.unweightedLabel ?? "—")],
    ["Sample-size weighted", String(state.comparisons.sampleSizeLabel ?? "—")],
    ["LV only", String(state.comparisons.lvLabel ?? "—")],
    ["RV only", String(state.comparisons.rvLabel ?? "—")],
    ["Published RCP average", "Not ingested"],
  ];
  return (
    <section className="poll-card">
      <p>These are sensitivity checks. They are all polling margins. None of them is a win probability. {String(state.comparisons.rcpNote ?? "")}</p>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <tbody>
            {rows.map(([label, value]) => <tr key={label}><th>{label}</th><td>{value}</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Subgroups({ state, dimension, onDimension }: { state: Snapshot; dimension: string; onDimension: (value: string) => void }) {
  const dimensions = ["all", ...new Set(state.subgroups.map((card) => card.dimension))];
  const cards = state.subgroups.filter((card) => dimension === "all" || card.dimension === dimension);
  return (
    <>
      <div className="poll-filters">
        <select value={dimension} onChange={(event) => onDimension(event.target.value)} aria-label="Subgroup dimension">
          {dimensions.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <p className="poll-muted">Subgroup trends are diagnostic. They are not fed back into the statewide topline. A line is withheld until there are at least three approved polls in the same compatible group.</p>
      <div className="poll-grid">
        {cards.map((card) => (
          <article key={`${card.dimension}-${card.normalized}`} className="poll-card">
            <div className="poll-kicker">{card.dimension}</div>
            <h3>{card.normalized}</h3>
            <div className="poll-margin" style={{ fontSize: 22 }}>{card.currentLabel}</div>
            <p>{card.polls} polls. Known subgroup n: {card.knownN ?? "not reported"}. Cells missing n: {card.nMissing}.</p>
            <p className="poll-muted">{card.precisionNote}</p>
            <p className="poll-muted">Original labels: {card.originalLabels.join(", ")}</p>
            <ul>
              {card.points.map((point) => (
                <li key={`${point.pollster}-${point.date}`}>{point.date} {point.pollster}: {point.margin.toFixed(1)} {point.n == null ? "(n not reported)" : `(n=${point.n})`}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </>
  );
}

function Pollsters({ state }: { state: Snapshot }) {
  return (
    <div className="poll-table-wrap">
      <table className="poll-table">
        <thead><tr><th>Pollster</th><th>Polls in model</th><th>Avg N</th><th>Samples</th><th>Avg weight</th><th>House effect</th></tr></thead>
        <tbody>
          {state.pollsters.map((row) => (
            <tr key={row.pollster}>
              <td>{row.pollster}</td>
              <td>{row.polls}</td>
              <td>{row.averageN == null ? "—" : Math.round(row.averageN)}</td>
              <td>{row.sampleTypes.join(", ")}</td>
              <td>{row.averageWeight == null ? "—" : `${(row.averageWeight * 100).toFixed(1)}%`}</td>
              <td>{row.houseLabel || "—"}{row.houseSe != null ? ` (SE ${row.houseSe.toFixed(1)})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Settings({ state, onSave, onReset }: { state: Snapshot; onSave: (patch: unknown) => void; onReset: () => void }) {
  const [form, setForm] = useState(state.settings);
  useEffect(() => setForm(state.settings), [state.settings]);
  return (
    <section className="poll-card">
      <p>These are modeling assumptions. Changing them recalculates the trend. Reset restores model.yaml.</p>
      <div className="poll-settings">
        <label>Recency half-life (days)<input type="number" value={form.recency.half_life_days} onChange={(event) => setForm({ ...form, recency: { ...form.recency, half_life_days: Number(event.target.value) } })} /></label>
        <label>Adaptive half-life
          <select value={form.recency.adaptive.enabled ? "yes" : "no"} onChange={(event) => setForm({ ...form, recency: { ...form.recency, adaptive: { ...form.recency.adaptive, enabled: event.target.value === "yes" } } })}>
            <option value="yes">On</option><option value="no">Off</option>
          </select>
        </label>
        <label>Variance floor τ (points)<input type="number" step="0.1" value={form.precision.tau_pp} onChange={(event) => setForm({ ...form, precision: { ...form.precision, tau_pp: Number(event.target.value) } })} /></label>
        <label>LV weight<input type="number" step="0.05" value={form.sample_type.weights.LV} onChange={(event) => setForm({ ...form, sample_type: { ...form.sample_type, weights: { ...form.sample_type.weights, LV: Number(event.target.value) } } })} /></label>
        <label>RV weight<input type="number" step="0.05" value={form.sample_type.weights.RV} onChange={(event) => setForm({ ...form, sample_type: { ...form.sample_type, weights: { ...form.sample_type.weights, RV: Number(event.target.value) } } })} /></label>
        <label>Adults weight<input type="number" step="0.05" value={form.sample_type.weights.Adults} onChange={(event) => setForm({ ...form, sample_type: { ...form.sample_type, weights: { ...form.sample_type.weights, Adults: Number(event.target.value) } } })} /></label>
        <label>Outlier |z| threshold<input type="number" step="0.1" value={form.outliers.standardized_threshold} onChange={(event) => setForm({ ...form, outliers: { ...form.outliers, standardized_threshold: Number(event.target.value) } })} /></label>
        <label>Cluster window (days)<input type="number" value={form.clustering.window_days} onChange={(event) => setForm({ ...form, clustering: { ...form.clustering, window_days: Number(event.target.value) } })} /></label>
        <label>Bandwidth (days)<input type="number" value={form.trend.bandwidth_days} onChange={(event) => setForm({ ...form, trend: { ...form.trend, bandwidth_days: Number(event.target.value) } })} /></label>
        <label>House-effect adjustment
          <select value={form.house_effects.apply ? "yes" : "no"} onChange={(event) => setForm({ ...form, house_effects: { ...form.house_effects, apply: event.target.value === "yes" } })}>
            <option value="no">Off</option><option value="yes">On</option>
          </select>
        </label>
        <label>Abbott color<input value={form.display.candidate_a_color} onChange={(event) => setForm({ ...form, display: { ...form.display, candidate_a_color: event.target.value } })} /></label>
        <label>Hinojosa color<input value={form.display.candidate_b_color} onChange={(event) => setForm({ ...form, display: { ...form.display, candidate_b_color: event.target.value } })} /></label>
      </div>
      <h3>Sponsor multipliers</h3>
      <div className="poll-settings">
        {Object.entries(form.sponsorship_weights).map(([key, value]) => (
          <label key={key}>{key}
            <input type="number" step="0.05" value={value} onChange={(event) => setForm({ ...form, sponsorship_weights: { ...form.sponsorship_weights, [key]: Number(event.target.value) } })} />
          </label>
        ))}
      </div>
      <p>
        <button type="button" className="poll-btn primary" onClick={() => onSave(form)}>Apply</button>{" "}
        <button type="button" className="poll-btn" onClick={onReset}>Reset to defaults</button>
      </p>
      <p className="poll-muted">Sample-type mode is "{form.sample_type.mode}". Multipliers are the live adjustment. A model-based sample-type effect is not estimated until there is enough overlapping LV and RV fieldwork, and flipping the switch does not drop the RV multiplier on its own. Sponsor weights are assumptions, not quality grades.</p>
    </section>
  );
}

function Review({ state, onPost }: { state: Snapshot; onPost: (path: string, payload?: unknown) => Promise<void> }) {
  const [manual, setManual] = useState({ pollster: "", sponsor: "", field_start: "", field_end: "", release_date: "", sample_size: "", sample_type: "LV", reported_moe: "", abbott: "", hinojosa: "", other: "", undecided: "", url: "" });
  const queue = state.polls.filter((poll) => !poll.inModel || poll.warnings.length);
  return (
    <>
      <section className="poll-card">
        <h2>Data completeness</h2>
        <p>{state.quality.note} Mean score: {state.quality.meanCompleteness ?? "—"}.</p>
        <div className="poll-meta">
          {Object.entries(state.quality.issues).map(([key, value]) => <div key={key}><span>{key}</span>{value}</div>)}
        </div>
      </section>
      <h2>Queue</h2>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead><tr><th>Poll</th><th>Status</th><th>Warnings</th><th></th></tr></thead>
          <tbody>
            {queue.map((poll) => (
              <tr key={poll.id}>
                <td>{poll.pollster}<div className="poll-muted">{poll.fieldLabel}</div></td>
                <td>{poll.status}</td>
                <td style={{ whiteSpace: "normal", minWidth: 280 }}>{poll.warnings.slice(0, 2).join(" ") || "—"}</td>
                <td>
                  {!poll.approved ? <button type="button" className="poll-btn" onClick={() => onPost(`/api/polling/polls/${poll.id}/approval`, { approved: true })}>Approve</button> : null}{" "}
                  {poll.approved ? <button type="button" className="poll-btn" onClick={() => onPost(`/api/polling/polls/${poll.id}/approval`, { approved: false })}>Reject</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="poll-card">
        <h2>Manual entry</h2>
        <p className="poll-muted">Saved as needs-review. Duplicate checks run before it can enter the model.</p>
        <form className="poll-form" onSubmit={(event) => {
          event.preventDefault();
          void onPost("/api/polling/manual", {
            ...manual,
            sample_size: manual.sample_size ? Number(manual.sample_size) : null,
            reported_moe: manual.reported_moe ? Number(manual.reported_moe) : null,
            abbott: manual.abbott ? Number(manual.abbott) : null,
            hinojosa: manual.hinojosa ? Number(manual.hinojosa) : null,
            other: manual.other ? Number(manual.other) : null,
            undecided: manual.undecided ? Number(manual.undecided) : null,
          });
        }}>
          {(["pollster", "sponsor", "field_start", "field_end", "release_date", "sample_size", "reported_moe", "abbott", "hinojosa", "other", "undecided", "url"] as const).map((key) => (
            <label key={key}>{key}<input value={manual[key]} onChange={(event) => setManual({ ...manual, [key]: event.target.value })} /></label>
          ))}
          <label>sample_type
            <select value={manual.sample_type} onChange={(event) => setManual({ ...manual, sample_type: event.target.value })}>
              <option>LV</option><option>RV</option><option>Adults</option><option>Other</option>
            </select>
          </label>
          <button type="submit" className="poll-btn primary">Save for review</button>
        </form>
      </section>
    </>
  );
}

function Detail({ poll, onClose, onPost }: { poll: PollRow; onClose: () => void; onPost: (path: string, payload?: unknown) => Promise<void> }) {
  const [reason, setReason] = useState("");
  return (
    <section className="poll-detail">
      <article className="poll-card">
        <button type="button" className="poll-btn" onClick={onClose}>Close</button>
        <h2>{poll.pollster}</h2>
        <p>{poll.sponsor || "Sponsor not recorded"} · {poll.sponsorType} · {poll.fieldLabel || "Field dates missing"} · released {poll.releaseDate || "—"}</p>
        <p>N {poll.sampleSize ?? "missing"} {poll.sampleType || ""} · MOE {poll.moe ?? "—"}{poll.designEffectMoe ? ` (design-effect ${poll.designEffectMoe})` : ""} · {poll.ballot}</p>
        <p>{poll.population}</p>
        <p><strong>Question.</strong> {poll.question || "Question wording was not archived."}</p>
        <h3>Topline</h3>
        <ul>
          {poll.results.map((row) => <li key={`${row.candidate}-${row.type}`}>{row.candidate}: {row.percentage == null ? row.symbol || "—" : `${row.percentage}%`} <span className="poll-muted">{row.type}</span></li>)}
        </ul>
        {poll.alternateFrames.map((frame, index) => (
          <p key={index}>Alternate frame {frame.sample_type}, n={frame.sample_size}, MOE {frame.reported_moe}. {frame.notes} {(frame.results || []).map((row) => `${row.candidate} ${row.percentage}`).join(", ")}</p>
        ))}
        <h3>Methodology</h3>
        <p>{poll.methodology || "No methodology note."}</p>
        <p>{poll.weighting}</p>
        <h3>Validation</h3>
        {poll.messages.map((message, index) => <div key={index} className={message.level === "info" ? "poll-muted" : "poll-warn"}>{message.level}: {message.message}</div>)}
        <p>Data completeness {poll.completeness.score}. This is not an ideological score.</p>
        {poll.outlier ? <p>Residual {poll.outlier.residual.toFixed(1)} vs the trend on the midpoint (fitted {poll.outlier.fitted.toFixed(1)}). Standardized residual {poll.outlier.standardized.toFixed(2)}.{poll.outlier.flagged ? " Flagged." : " Not flagged."}</p> : null}
        <p>
          <input value={reason} placeholder="Reason required to exclude" onChange={(event) => setReason(event.target.value)} />{" "}
          <button type="button" className="poll-btn" onClick={() => onPost(`/api/polling/polls/${poll.id}/exclusion`, { excluded: true, reason })}>Exclude</button>{" "}
          {poll.excluded ? <button type="button" className="poll-btn" onClick={() => onPost(`/api/polling/polls/${poll.id}/exclusion`, { excluded: false })}>Include</button> : null}
        </p>
      </article>
      <article className="poll-card">
        <h3>Weight</h3>
        {poll.weights ? (
          <ul>
            <li>Precision contribution {poll.weights.precision.toFixed(4)} — {poll.weights.precisionNote}</li>
            <li>Margin SE {poll.weights.seMargin.toFixed(2)} points. n_eff {poll.weights.nEff == null ? "—" : Math.round(poll.weights.nEff)}{poll.weights.nEffEstimated ? " (estimated)" : ""}</li>
            <li>Recency {poll.weights.recency.toFixed(3)}</li>
            <li>Sample type × {poll.weights.sampleType.toFixed(2)}</li>
            <li>Sponsor × {poll.weights.sponsorship.toFixed(2)}</li>
            <li>Cluster × {poll.weights.cluster.toFixed(2)} across {poll.weights.clusterSize} poll{poll.weights.clusterSize === 1 ? "" : "s"}</li>
            <li>Final normalized weight {(poll.weights.final * 100).toFixed(1)}%</li>
          </ul>
        ) : <p>Not in the model.</p>}
        <h3>Sources</h3>
        <ul>
          {poll.sources.map((source) => (
            <li key={source.url}>Tier {source.tier} {source.type}{source.isPrimary ? " · primary" : ""} — <a href={source.url}>{source.publisher || source.url}</a><div className="poll-muted">{source.notes}</div>{source.localFile ? <div className="poll-muted">{source.localFile}</div> : null}</li>
          ))}
        </ul>
        <h3>Crosstabs</h3>
        {poll.subgroups.length === 0 ? <p>No subgroup cells stored.</p> : (
          <ul>
            {poll.subgroups.map((cell, index) => (
              <li key={index}>{cell.original} ({cell.normalized}) {cell.candidate} {cell.percentage}% {cell.n == null ? "— subgroup sample size not reported" : `n=${cell.n}`}</li>
            ))}
          </ul>
        )}
        {poll.notes ? <p>{poll.notes}</p> : null}
      </article>
    </section>
  );
}
