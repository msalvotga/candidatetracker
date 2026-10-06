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
  modelStatus: string;
  modelStatusLabel: string;
  modelStatusDetail: string;
  preferredVersion: string | null;
  sourceCompleteness: string;
  sourceCompletenessLabel: string;
  sameSampleNote: string;
  canonical: string;
  warnings: string[];
  messages: { level: string; code: string; message: string }[];
  weights: null | {
    precision: number;
    precisionShare: number;
    recency: number;
    sampleType: number;
    sourceQuality: number;
    sponsorship: number;
    sponsorTable: number;
    cluster: number;
    clusterSize: number;
    nearestGapDays: number | null;
    outlierFactor: number;
    raw: number;
    final: number;
    seMargin: number;
    nEff: number | null;
    nEffEstimated: boolean;
    precisionNote: string;
    designEffect: number | null;
    designEffectEstimated: boolean;
    samplingVariance: number;
    varianceFloor: number;
    totalVariance: number;
    ageDays: number;
    baseHalfLife: number;
    effectiveHalfLife: number;
    rawMargin: number;
    adjustedMargin: number | null;
    houseEffect: number | null;
    formula: string;
  };
  measurement?: {
    samplingVariance: number;
    excessVariance: number;
    methodVariance: number;
    populationVariance: number;
    totalVariance: number;
    samplingSe: number;
    totalSe: number;
    nEff: number | null;
    nEffStatus: string;
    samplingStatus: string;
    moeStatus: string;
    note: string;
  } | null;
  impact?: {
    withPoll: number;
    withoutPoll: number | null;
    impact: number | null;
    measurementSe: number;
    samplingSe?: number | null;
    excessSd?: number | null;
    firmShockSd?: number | null;
    populationModeSd?: number | null;
    varianceFloorSd?: number | null;
    finalObservationSd?: number | null;
    expectedField?: number | null;
    innovation?: number | null;
    priorSd?: number | null;
    gain?: number | null;
    before?: number | null;
    after?: number | null;
    update?: number | null;
  } | null;
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
    modelVersion: string;
    baseHalfLifeDays: number;
    halfLifeDays: number;
    halfLifeLabel: string;
    weightFormula: string;
    intervalMethod: string;
    pointEstimateDefinition: string;
    engine?: string;
    processSd?: number | null;
    ewmaHalfLife?: number | null;
    whyQ?: string | null;
    whyHalfLife?: string | null;
    colors: { candidate_a_color?: string; candidate_b_color?: string };
    candidateA: string;
    candidateB: string;
  };
  overview: {
    label: string;
    margin: number | null;
    interval50Label?: string | null;
    interval80Label: string | null;
    interval95Label: string | null;
    emerging?: string | null;
    recentPolls?: number | null;
    recentPollsters?: number | null;
    averageMeasurementSe?: number | null;
    median?: number | null;
    sd?: number | null;
    simulation?: {
      runs: number;
      abbottLeads: number;
      hinojosaLeads: number;
      ties: number;
      abbottShare: number;
      hinojosaShare: number;
      note: string;
    } | null;
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
    statusCounts: { total: number; included: number; pending: number; excluded: number };
    effectivePollCount: number | null;
    weightConcentration: { largest: number | null; top3: number | null; top5: number | null };
    minimumPollsToDraw: number;
  };
  specification: Record<string, unknown>;
  uncertainty: Record<string, number | string | null> & { histogram?: { x0: number; x1: number; count: number }[]; pointEstimateDefinition?: string; method?: string };
  sensitivity: {
    minimum: number;
    maximum: number;
    median: number;
    range: number;
    minimumLabel: string;
    maximumLabel: string;
    medianLabel: string;
    sentence: string;
    largestChanges: { name: string; label: string; gapFromPrimary: number }[];
  };
  modelChange: null | {
    priorVersion: string;
    currentVersion: string;
    priorLabel: string;
    currentLabel: string;
    priorMargin: number;
    currentMargin: number;
    priorInterval80: string | null;
    priorInterval95: string | null;
    note: string;
    weightChanges: { pollster: string; field: string; priorWeight: number; currentWeight: number; reason: string }[];
  };
  clusterDiagnostics: { pollster: string; midpoint: string; clusterSize: number; clusterFactor: number; nearestGapDays: number | null; relation: string; sameSampleNote: string }[];
  daily: {
    date: string;
    pollsToDate: number | null;
    weighted: number | null;
    latent?: number | null;
    low50?: number | null;
    high50?: number | null;
    conservative?: number | null;
    fast?: number | null;
    straight?: number | null;
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
  movement?: { days: number; change: number; sd: number | null; low95: number | null; high95: number | null; probPositive?: number | null; probNegative?: number | null; newPolls: number; newPollsters: number }[];
  audit?: {
    processSd?: number;
    numericalBestQ?: number;
    qBand?: number[];
    selectionScore?: number;
    numericalBestScore?: number;
    selectionSe?: number | null;
    whyQ?: string;
    excessSd?: number;
    firmSd?: number;
    houseSd?: number;
    qFast?: number | null;
    whyFast?: string | null;
    polls?: number;
    pollsters?: number;
    margin?: number;
    sd?: number;
    fieldDates?: string;
    recency?: string;
    sampleType?: string;
    varianceFloor?: string;
    pollsterDependence?: string;
    bootstrap?: string;
    houseEffects?: string;
    updates?: { pollId: number; pollster: string; margin: number; innovation: number; observationSd: number; gain: number; before: number; after: number; priorSd: number }[];
  } | null;
  modelLab?: {
    whyQ: string;
    whyHalfLife: string;
    whyHouse?: string;
    objective: string;
    excludedFromObjective: string;
    dateLimitation: string;
    source: string;
    races: number;
    cycles: number[];
    selected: Record<string, unknown>;
    leaveOneCycleQ: number[];
    leaveOneCycleHalfLife: number[];
    rows: { model: string; selected: boolean; rmse7: number | null; rmse14: number | null; rmse28: number | null; mae: number | null; coverage95: number | null; logLik14: number | null; residualAutocorr: number | null; detail: string }[];
  };
  polls: PollRow[];
  comparisons: Record<string, string | number | null> & {
    rows?: {
      id: string;
      name: string;
      label: string | null;
      margin: number | null;
      explanation: string;
      polls: number | null;
      window: string | null;
      meanAgeDays: number | null;
      weightedMidpoint: string | null;
      lv: number | null;
      rv: number | null;
      ballots: string[];
    }[];
  };
  subgroups: {
    dimension: string;
    group: string;
    normalized: string;
    originalLabels: string[];
    polls: number;
    trendPolls: number;
    knownN: number | null;
    nMissing: number;
    currentLabel: string;
    precisionNote: string;
    points: { pollster: string; date: string; margin: number; n: number | null; sourceUrl: string | null; sourcePublisher: string | null }[];
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
  sources?: SourceCatalog;
  quality: { label: string; note: string; meanCompleteness: number | null; issues: Record<string, number>; checks: { code: string; count: number; note: string }[] };
  settings: {
    recency: { half_life_days: number; adaptive: { enabled: boolean } };
    sample_type: { mode: string; weights: { LV: number; RV: number; Adults: number; Other?: number } };
    precision: { tau_pp: number };
    source_completeness: Record<string, number>;
    sponsorship_weights: Record<string, number | boolean>;
    outliers: { standardized_threshold: number };
    clustering: { window_days: number; method: string };
    house_effects: { apply: boolean };
    trend: { bandwidth_days: number };
    display: { candidate_a_color: string; candidate_b_color: string };
  };
};

type SourceCatalog = {
  note: string;
  pollsterNote: string;
  discovery: {
    id: string;
    name: string;
    url: string;
    kind: string;
    tier: number | null;
    role: string;
    notes: string;
    last: { ok: boolean; rows: number; error: string | null } | null;
  }[];
  pollsters: { name: string; domains: string[] }[];
};

const TABS = ["Overview", "Polls", "Sources", "Comparison", "Model lab", "Model audit", "Subgroups", "Pollsters", "Settings", "Review"] as const;

function pct(value: number | null | undefined, digits = 0) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}`;
}

type PullNote = {
  added: { id: number; pollster: string; fieldStart: string | null; fieldEnd: string | null; abbott: number; hinojosa: number; margin: number; sampleType: string | null; sampleSize: number | null }[];
  alreadyStored: number;
  parsed: number;
  errors: string[];
  source: string;
  asOf: string;
  label: string;
  note: string;
};

export function PollingScreen({ onLeave }: { onLeave?: () => void }) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Recalculating…");
  const [pullNote, setPullNote] = useState<PullNote | null>(null);
  const [sampleFilter, setSampleFilter] = useState("all");
  const [pollsterFilter, setPollsterFilter] = useState("all");
  const [ballotFilter, setBallotFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
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

  async function pullPolls() {
    setBusy(true);
    setBusyLabel("Pulling new polls and updating the estimate…");
    setError(null);
    try {
      const response = await apiFetch("/api/polling/pull", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The poll update failed.");
      if (body.overview) setState(body);
      setPullNote(body.pull ?? null);
      setTab("Overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function post(path: string, payload?: unknown) {
    setBusy(true);
    setBusyLabel("Recalculating…");
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
    if (statusFilter === "included" && !poll.inModel) return false;
    if (statusFilter === "pending" && poll.modelStatus !== "pending_review") return false;
    if (statusFilter === "excluded" && (poll.inModel || poll.modelStatus === "pending_review")) return false;
    if (statusFilter === "out" && poll.inModel) return false;
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
        <div className="poll-top">
          <div className="poll-kicker">Polling laboratory · {state.meta.asOf}</div>
          <div className="poll-actions">
            <button type="button" className="poll-btn primary" disabled={busy} onClick={() => void pullPolls()}>Pull new polls</button>
            {onLeave ? <button type="button" className="linkish" onClick={onLeave}>Election night tracker</button> : null}
          </div>
        </div>
        <h1>Texas Governor Poll Trend</h1>
        <p className="poll-disclaimer">{state.meta.disclaimer} A positive number is a lead for {state.meta.candidateA}. The RealClearPolitics average is never an input.</p>
        {error ? <div className="poll-error">{error}</div> : null}
        {pullNote ? <PullResult note={pullNote} polls={state.polls} busy={busy} onPost={post} /> : null}
        <div className="poll-tabs">
          {TABS.map((item) => (
            <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>
          ))}
        </div>
        {busy ? <p className="poll-muted">{busyLabel}</p> : null}

        {tab === "Overview" ? <Overview state={state} onSelect={setSelectedId} onOpenOut={() => { setStatusFilter("out"); setTab("Polls"); }} /> : null}
        {tab === "Polls" ? (
          <PollTable
            rows={filtered}
            pollsters={pollsters}
            ballots={ballots}
            sampleFilter={sampleFilter}
            pollsterFilter={pollsterFilter}
            ballotFilter={ballotFilter}
            statusFilter={statusFilter}
            onSample={setSampleFilter}
            onPollster={setPollsterFilter}
            onBallot={setBallotFilter}
            onStatus={setStatusFilter}
            onSelect={setSelectedId}
            selectedId={selectedId}
            onPost={post}
          />
        ) : null}
        {tab === "Comparison" ? <Comparison state={state} /> : null}
        {tab === "Model lab" ? <ModelLab state={state} /> : null}
        {tab === "Model audit" ? <ModelAudit state={state} /> : null}
        {tab === "Subgroups" ? <Subgroups state={state} dimension={dimension} onDimension={setDimension} /> : null}
        {tab === "Sources" ? <Sources state={state} /> : null}
        {tab === "Pollsters" ? <Pollsters state={state} /> : null}
        {tab === "Settings" ? <Settings state={state} onSave={(patch) => post("/api/polling/settings", patch)} onReset={() => post("/api/polling/settings/reset")} /> : null}
        {tab === "Review" ? <Review state={state} onPost={post} /> : null}
        {selected ? <Detail poll={selected} onClose={() => setSelectedId(null)} onPost={post} /> : null}
      </div>
    </div>
  );
}

function PullResult({ note, polls, busy, onPost }: { note: PullNote; polls: PollRow[]; busy: boolean; onPost: (path: string, payload?: unknown) => Promise<void> }) {
  const waiting = note.added.filter((item) => {
    const poll = polls.find((row) => row.id === item.id);
    return !poll?.inModel;
  });
  return (
    <section className="poll-card">
      <h2>Poll update</h2>
      <p>{note.note} Current estimate: {note.label}. As of {note.asOf}.</p>
      <p className="poll-muted">{note.source}. {note.parsed} rows read, {note.alreadyStored} already in the archive, {note.added.length} new.</p>
      {note.errors.length ? <p className="poll-warn">{note.errors.join(" ")}</p> : null}
      {waiting.length ? (
        <ul>
          {waiting.map((item) => (
            <li key={item.id}>
              {item.pollster}, {item.fieldStart ?? "?"} – {item.fieldEnd ?? "?"}, {item.sampleType ?? "sample type missing"} n={item.sampleSize ?? "—"}. Abbott {item.abbott}, Hinojosa {item.hinojosa} ({item.margin >= 0 ? `Abbott +${item.margin}` : `Hinojosa +${Math.abs(item.margin)}`}).{" "}
              <button type="button" className="poll-btn primary" disabled={busy} onClick={() => void onPost(`/api/polling/polls/${item.id}/exclusion`, { excluded: false })}>Include in estimate</button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Sources({ state }: { state: Snapshot & { sources?: SourceCatalog } }) {
  const catalog = state.sources;
  if (!catalog) return <p>Source list is not in this snapshot yet. Pull new polls to refresh it.</p>;
  return (
    <>
      <section className="poll-card">
        <h2>Where polls are pulled from</h2>
        <p>{catalog.note}</p>
      </section>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead>
            <tr><th>Source</th><th>Kind</th><th>What Pull does</th><th>Last check</th></tr>
          </thead>
          <tbody>
            {catalog.discovery.map((source) => (
              <tr key={source.id}>
                <td><a href={source.url}>{source.name}</a></td>
                <td>{source.kind}{source.tier ? `, tier ${source.tier}` : ""}</td>
                <td style={{ whiteSpace: "normal", minWidth: 280 }}>{source.role}{source.notes ? ` ${source.notes}` : ""}</td>
                <td>
                  {source.last ? (
                    source.last.ok ? `${source.last.rows} poll rows` : source.last.error
                  ) : "Not checked yet"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="poll-card">
        <h2>Organizations on the watch list</h2>
        <p className="poll-muted">{catalog.pollsterNote}</p>
        <ul>
          {catalog.pollsters.map((pollster) => (
            <li key={pollster.name}>{pollster.name} <span className="poll-muted">{pollster.domains.join(", ")}</span></li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Overview({ state, onSelect, onOpenOut }: { state: Snapshot; onSelect: (id: number) => void; onOpenOut: () => void }) {
  const modeled = state.polls.filter((poll) => poll.inModel).sort((a, b) => (b.weights?.final ?? 0) - (a.weights?.final ?? 0));
  return (
    <>
      <div className="poll-grid">
        <section className="poll-card">
          <div className="poll-kicker">Estimated current polling margin</div>
          <div className="poll-margin" style={{ color: (state.overview.margin ?? 0) >= 0 ? state.meta.colors.candidate_a_color : state.meta.colors.candidate_b_color }}>
            {state.overview.label}
          </div>
          {state.overview.simulation ? (
            <div className="poll-odds">
              <div className="poll-odds-figure" style={{ color: state.meta.colors.candidate_a_color }}>
                {(state.overview.simulation.abbottShare * 100).toFixed(1)}%
              </div>
              <p>Governor Abbott leads in {state.overview.simulation.abbottLeads.toLocaleString()} of {state.overview.simulation.runs.toLocaleString()} draws. Gina Hinojosa leads {(state.overview.simulation.hinojosaShare * 100).toFixed(1)}%.</p>
            </div>
          ) : null}
          <p>50% interval: {state.overview.interval50Label ?? "—"}</p>
          <p>80% interval: {state.overview.interval80Label ?? "—"}</p>
          <p>95% interval: {state.overview.interval95Label ?? "—"}</p>
          {state.overview.simulation ? <p className="poll-muted">{state.overview.simulation.note}</p> : null}
          {state.overview.emerging ? <p className="poll-warn">{state.overview.emerging}</p> : null}
          <p className="poll-muted">{state.overview.trendHoldNote} Newest fieldwork midpoint: {state.overview.lastFieldMidpoint ?? "—"}.</p>
          <div className="poll-meta">
            <div><span>Polls in model</span><button type="button" className="linkish" onClick={onOpenOut}>{state.overview.pollsInModel} of {state.overview.pollsStored}</button></div>
            <div><span>Pollsters</span>{state.overview.pollstersInModel}</div>
            <div><span>Polls in recent evidence</span>{state.overview.recentPolls ?? "—"}</div>
            <div><span>Distinct pollsters, recent</span>{state.overview.recentPollsters ?? "—"}</div>
            <div><span>Effective poll count</span>{state.overview.effectivePollCount == null ? "—" : state.overview.effectivePollCount.toFixed(2)}</div>
            <div><span>Average measurement SE</span>{state.overview.averageMeasurementSe == null ? "—" : state.overview.averageMeasurementSe.toFixed(1)}</div>
            <div><span>LV / RV counts</span>{state.overview.lvCount} / {state.overview.rvCount}</div>
            <div><span>House effects</span>{state.overview.houseEffectApplied ? "Shrunk toward zero" : "Off"}</div>
          </div>
          <p className="poll-muted">{state.meta.pointEstimateDefinition}</p>
          <p className="poll-muted">{state.meta.whyQ}</p>
          <p className="poll-muted">Comparison EWMA half-life: {state.meta.ewmaHalfLife ?? "—"} days. {state.meta.whyHalfLife}</p>
        </section>
        <TrendChart state={state} />
      </div>
      <Specification state={state} />
      <ChangeAnalysis state={state} />
      <Uncertainty state={state} />
      {state.modelChange ? <ModelChange change={state.modelChange} /> : null}
      <h2>What is driving the estimate</h2>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead>
            <tr>
              <th>Poll</th><th>Margin</th>
              <th title="Inverse-variance factor: 1 / (margin SE² + tau²). It is not a share of the model. The final weight multiplies it by recency, sample type, source completeness, clustering, and the outlier factor, then normalizes.">Precision factor</th>
              <th>Recency</th><th>Sample</th><th>Source completeness</th><th>Cluster</th><th>Final weight</th>
            </tr>
          </thead>
          <tbody>
            {modeled.map((poll) => (
              <tr key={poll.id}>
                <td><button type="button" className="linkish" onClick={() => onSelect(poll.id)}>{poll.pollster}</button><div className="poll-muted">{poll.fieldLabel}</div></td>
                <td>{poll.margin != null ? poll.margin.toFixed(1) : "—"}</td>
                <td>{poll.weights ? poll.weights.precision.toFixed(3) : "—"}</td>
                <td>{poll.weights ? poll.weights.recency.toFixed(2) : "—"}</td>
                <td>{poll.weights ? `${poll.sampleType} × ${poll.weights.sampleType.toFixed(2)}` : "—"}</td>
                <td title={poll.sourceCompletenessLabel}>{poll.weights ? poll.weights.sourceQuality.toFixed(2) : "—"}</td>
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

function Specification({ state }: { state: Snapshot }) {
  const spec = state.specification;
  return (
    <section className="poll-card">
      <h2>Current model specification</h2>
      <div className="poll-meta">
        <div><span>Version</span>{String(spec.modelVersion)}</div>
      </div>
      <h3>Primary latent model</h3>
      <div className="poll-meta">
        <div><span>Daily process SD</span>{spec.processSd == null ? "—" : `${Number(spec.processSd).toFixed(2)} points`}</div>
        <div><span>Excess variance</span>{spec.excessVariance == null ? "—" : `${Number(spec.excessVariance).toFixed(2)}`}</div>
        <div><span>Firm-shock variance</span>{spec.firmVariance == null ? "—" : `${Number(spec.firmVariance).toFixed(2)}`}</div>
        <div><span>House-effect prior SD</span>{spec.sigmaHouse == null ? "—" : `${Number(spec.sigmaHouse).toFixed(2)}`}</div>
        <div><span>Field dates</span>Full field window</div>
        <div><span>Recency multiplier</span>Not used</div>
        <div><span>LV/RV multipliers</span>Not used</div>
        <div><span>Posterior</span>Gaussian filter</div>
      </div>
      <h3>Comparison models</h3>
      <div className="poll-meta">
        <div><span>EWMA half-life</span>{spec.ewmaHalfLife == null ? "—" : `${String(spec.ewmaHalfLife)} days`}</div>
        <div><span>Conservative half-life</span>{spec.conservativeHalfLife == null ? "—" : `${String(spec.conservativeHalfLife)} days`}</div>
        <div><span>Fast latent process SD</span>{spec.qFast == null ? "—" : `${Number(spec.qFast).toFixed(2)}`}</div>
        <div><span>Local-linear bandwidth</span>{String(spec.bandwidthDays)} days</div>
        <div><span>Comparison half-life</span>{String(spec.effectiveHalfLifeDays)} days</div>
        <div><span>LV / RV / Adults weights</span>{String(spec.lvMultiplier)} / {String(spec.rvMultiplier)} / {String(spec.adultsMultiplier)}</div>
        <div><span>Comparison variance floor</span>{String(spec.tauPp)} pp</div>
        <div><span>Bootstrap draws</span>{String(spec.bootstrapDraws)}</div>
        <div><span>Cluster window</span>{String(spec.clusterWindowDays)} days</div>
        <div><span>Comparison house-effect switch</span>{spec.houseEffectsApplied ? "On" : "Off"}</div>
        <div><span>Comparison interval</span>{String(spec.intervalMethod)}</div>
        <div><span>Sponsor multipliers</span>{spec.sponsorMultipliersInDefault ? "On" : "Off"}</div>
        <div><span>Outlier factor</span>{String(spec.outlierMultiplier)}</div>
      </div>
      <p className="poll-muted">{String(spec.whyQ ?? "")}</p>
      <p className="poll-muted">{String(spec.whyHalfLife ?? "")} The weight formula still applies to the local-linear comparison: {String(spec.weightFormula)}.</p>
    </section>
  );
}

function ChangeAnalysis({ state }: { state: Snapshot }) {
  const rows = state.movement ?? [];
  const impacts = state.polls.filter((poll) => poll.inModel && poll.impact);
  return (
    <section className="poll-card">
      <h2>Change analysis</h2>
      <p className="poll-muted">Change in the latent polling margin. P(change &gt; 0) is the posterior probability that the latent polling margin moved toward Abbott over that window. It is not a probability that either candidate wins the election.</p>
      {rows.length === 0 ? <p>No change window is available yet.</p> : (
        <div className="poll-table-wrap">
          <table className="poll-table">
            <thead><tr><th>Window</th><th>Change</th><th>95% interval of the change</th><th>P(change &gt; 0)</th><th>P(change &lt; 0)</th><th>New polls</th><th>Independent pollsters</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.days}>
                  <td>{row.days} day{row.days === 1 ? "" : "s"}</td>
                  <td>{row.change >= 0 ? "+" : ""}{row.change.toFixed(2)}</td>
                  <td>{row.low95 == null || row.high95 == null ? "—" : `${row.low95.toFixed(1)} to ${row.high95.toFixed(1)}`}</td>
                  <td>{row.probPositive == null ? "—" : `${Math.round(row.probPositive * 100)}%`}</td>
                  <td>{row.probNegative == null ? "—" : `${Math.round(row.probNegative * 100)}%`}</td>
                  <td>{row.newPolls}</td>
                  <td>{row.newPollsters}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>What each poll did to today's estimate</h3>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead><tr><th>Poll</th><th>Poll margin</th><th>Field expectation</th><th>Innovation</th><th>Sampling margin SE</th><th>Final observation SD</th><th>Kalman gain</th><th>Before</th><th>After</th><th>Update</th><th>Without today</th><th>Impact today</th></tr></thead>
          <tbody>
            {impacts.map((poll) => (
              <tr key={poll.id}>
                <td>{poll.pollster}<div className="poll-muted">{poll.fieldLabel}</div></td>
                <td>{fmtSigned(poll.margin)}</td>
                <td>{fmtSigned(poll.impact?.expectedField)}</td>
                <td>{fmtSigned(poll.impact?.innovation)}</td>
                <td>{fmtNum(poll.impact?.samplingSe)}</td>
                <td>{fmtNum(poll.impact?.finalObservationSd)}</td>
                <td>{fmtNum(poll.impact?.gain)}</td>
                <td>{fmtSigned(poll.impact?.before)}</td>
                <td>{fmtSigned(poll.impact?.after)}</td>
                <td>{fmtSigned(poll.impact?.update)}</td>
                <td>{fmtSigned(poll.impact?.withoutPoll)}</td>
                <td>{fmtSigned(poll.impact?.impact)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Uncertainty({ state }: { state: Snapshot }) {
  const u = state.uncertainty;
  const gaussian = u.method === "gaussian_posterior";
  const rows: [string, string][] = [
    ["Draws", String(u.n ?? "—")],
    ["Mean", num(u.mean)],
    ["Median", num(u.median)],
    ["SD", num(u.sd)],
    ["Minimum", num(u.minimum)],
    ["Maximum", num(u.maximum)],
    ["2.5th", num(u.p2_5)],
    ["5th", num(u.p5)],
    ["10th", num(u.p10)],
    ["16th", num(u.p16)],
    ["25th", num(u.p25)],
    ["50th", num(u.p50)],
    ["75th", num(u.p75)],
    ["84th", num(u.p84)],
    ["90th", num(u.p90)],
    ["95th", num(u.p95)],
    ["97.5th", num(u.p97_5)],
    ["Skewness", num(u.skewness)],
  ];
  return (
    <section className="poll-card">
      <h2>{gaussian ? "Posterior uncertainty" : "Uncertainty draws"}</h2>
      <p className="poll-muted">{gaussian
        ? "The latent margin's posterior is Gaussian. The mean and the median match. The 50% interval is the mean plus or minus 0.67 standard deviations, the 80% interval plus or minus 1.28, and the 95% interval plus or minus 1.96. The histogram is that normal curve scaled to 400. It is not a bootstrap and not a win probability."
        : "These are the cluster-bootstrap draws for the local-linear comparison. The 80% interval is the 10th to 90th percentile. The 95% interval is the 2.5th to 97.5th percentile."} {u.pointEstimateDefinition}</p>
      <div className="poll-meta">
        {rows.map(([label, value]) => <div key={label}><span>{label}</span>{value}</div>)}
      </div>
      <DrawHistogram bins={u.histogram ?? []} />
    </section>
  );
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

function fmtNum(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? "—" : value.toFixed(2);
}

function fmtSigned(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function DrawHistogram({ bins }: { bins: { x0: number; x1: number; count: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || bins.length === 0) return;
    let plotly: { purge: (el: HTMLElement) => void } | null = null;
    let cancelled = false;
    (async () => {
      const Plotly = (await import("plotly.js-basic-dist")).default;
      if (cancelled || !host) return;
      plotly = Plotly;
      await Plotly.newPlot(host, [{
        type: "bar",
        x: bins.map((bin) => (bin.x0 + bin.x1) / 2),
        y: bins.map((bin) => bin.count),
        width: bins.map((bin) => Math.max(0.2, (bin.x1 - bin.x0) * 0.9)),
        marker: { color: "#0b2b52" },
        hovertemplate: "%{x:.1f}<br>%{y} draws<extra></extra>",
      }], {
        margin: { l: 40, r: 12, t: 10, b: 36 },
        height: 220,
        paper_bgcolor: "#fff",
        plot_bgcolor: "#fff",
        xaxis: { title: "Simulated margin (points)" },
        yaxis: { title: "Draws" },
        showlegend: false,
      }, { responsive: true, displaylogo: false });
    })();
    return () => {
      cancelled = true;
      if (plotly && host) plotly.purge(host);
    };
  }, [bins]);
  return <div ref={ref} />;
}

function ModelChange({ change }: { change: NonNullable<Snapshot["modelChange"]> }) {
  return (
    <section className="poll-card">
      <h2>Before and after {change.currentVersion}</h2>
      <p>{change.note}</p>
      <div className="poll-meta">
        <div><span>{change.priorVersion}</span>{change.priorLabel}</div>
        <div><span>{change.currentVersion}</span>{change.currentLabel}</div>
        <div><span>Prior 80%</span>{change.priorInterval80 || "—"}</div>
        <div><span>Prior 95%</span>{change.priorInterval95 || "—"}</div>
      </div>
      {change.weightChanges.length === 0 ? <p className="poll-muted">No poll weight moved by more than 0.05 points of share.</p> : (
        <div className="poll-table-wrap">
          <table className="poll-table">
            <thead><tr><th>Poll</th><th>Prior weight</th><th>Current weight</th><th>Why</th></tr></thead>
            <tbody>
              {change.weightChanges.map((row) => (
                <tr key={`${row.pollster}-${row.field}`}>
                  <td>{row.pollster}<div className="poll-muted">{row.field}</div></td>
                  <td>{(row.priorWeight * 100).toFixed(1)}%</td>
                  <td>{(row.currentWeight * 100).toFixed(1)}%</td>
                  <td style={{ whiteSpace: "normal", minWidth: 280 }}>{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function chartAxis(state: Snapshot) {
  const minPolls = state.overview.minimumPollsToDraw || 3;
  const modeled = state.polls.filter((poll) => poll.inModel && poll.margin != null);
  const dense = state.daily.filter((row) => (row.pollsToDate ?? 0) >= minPolls);
  const core = [
    ...modeled.map((poll) => poll.margin as number),
    ...dense.map((row) => row.latent ?? row.weighted).filter((value): value is number => value != null),
  ];
  return {
    yMin: core.length ? Math.min(...core) - 6 : -15,
    yMax: core.length ? Math.max(...core) + 6 : 15,
  };
}

function TrendChart({ state }: { state: Snapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  const axis = chartAxis(state);
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
      const minPolls = state.overview.minimumPollsToDraw || 3;
      const denseEnough = (row: Snapshot["daily"][number]) => (row.pollsToDate ?? 0) >= minPolls;
      const { yMin, yMax } = chartAxis(state);
      const visual = (row: Snapshot["daily"][number], key: "low95" | "high95" | "low80" | "high80" | "low50" | "high50") => {
        if (!denseEnough(row) || row[key] == null) return null;
        return Math.min(yMax, Math.max(yMin, row[key] as number));
      };
      const bandHover = (row: Snapshot["daily"][number], key: "low95" | "high95" | "low80" | "high80" | "low50" | "high50") => {
        const actual = row[key];
        if (actual == null) return "";
        const shown = visual(row, key);
        if (shown != null && Math.abs(shown - actual) > 0.05) return `${actual.toFixed(1)} (extends beyond the axis)`;
        return actual.toFixed(1);
      };
      const traces = [
        { x: days, y: state.daily.map((row) => visual(row, "high95")), customdata: state.daily.map((row) => bandHover(row, "high95")), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        { x: days, y: state.daily.map((row) => visual(row, "low95")), customdata: state.daily.map((row) => bandHover(row, "low95")), mode: "lines", fill: "tonexty", fillcolor: "rgba(15,43,82,0.12)", line: { width: 0 }, name: "95% interval", hovertemplate: "%{x}<br>95% %{customdata}<extra></extra>" },
        { x: days, y: state.daily.map((row) => visual(row, "high80")), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        { x: days, y: state.daily.map((row) => visual(row, "low80")), customdata: state.daily.map((row) => bandHover(row, "low80")), mode: "lines", fill: "tonexty", fillcolor: "rgba(15,43,82,0.2)", line: { width: 0 }, name: "80% interval", hovertemplate: "%{x}<br>80% %{customdata}<extra></extra>" },
        { x: days, y: state.daily.map((row) => visual(row, "high50")), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        { x: days, y: state.daily.map((row) => visual(row, "low50")), customdata: state.daily.map((row) => bandHover(row, "low50")), mode: "lines", fill: "tonexty", fillcolor: "rgba(15,43,82,0.28)", line: { width: 0 }, name: "50% interval", hovertemplate: "%{x}<br>50% %{customdata}<extra></extra>" },
        { x: days, y: state.daily.map((row) => denseEnough(row) ? (row.latent ?? row.weighted) : null), mode: "lines", name: "Latent trend", line: { color: "#0b2b52", width: 2.4 } },
        { x: days, y: state.daily.map((row) => denseEnough(row) ? (row.conservative ?? null) : null), mode: "lines", name: "Conservative average", line: { color: "#5c6b7a", width: 1.4, dash: "dash" } },
        { x: days, y: state.daily.map((row) => denseEnough(row) ? (row.fast ?? null) : null), mode: "lines", name: "Fast latent trend", line: { color: "#9f1d2e", width: 1.4, dash: "dot" } },
        { x: days, y: state.daily.map((row) => denseEnough(row) ? (row.straight ?? null) : null), mode: "lines", name: "Straight average", line: { color: "#1d4f91", width: 1.2 } },
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
        yaxis: { title: "Abbott margin (points)", zeroline: true, zerolinecolor: "#9aa6b2", range: [yMin, yMax] },
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
  const exceeds = state.daily.some((row) => (row.pollsToDate ?? 0) >= (state.overview.minimumPollsToDraw || 3) && row.high95 != null && row.low95 != null && (row.high95 > axis.yMax + 0.05 || row.low95 < axis.yMin - 0.05));
  return (
    <div className="poll-card poll-chart">
      <div ref={ref} />
      <p className="poll-muted">The latent line starts once {state.overview.minimumPollsToDraw || 3} qualifying polls are in the series. Bands are the posterior of that latent margin. The fast trend is a diagnostic. If it moves while the latent and conservative lines stay put, the overview says so. That sentence is not a prediction. Stored intervals are not clipped{exceeds ? "; a tooltip notes where a band extends past the axis" : ""}.</p>
    </div>
  );
}

function PollTable(props: {
  rows: PollRow[];
  pollsters: string[];
  ballots: string[];
  sampleFilter: string;
  pollsterFilter: string;
  ballotFilter: string;
  statusFilter: string;
  onSample: (value: string) => void;
  onPollster: (value: string) => void;
  onBallot: (value: string) => void;
  onStatus: (value: string) => void;
  onSelect: (id: number) => void;
  selectedId: number | null;
  onPost: (path: string, payload?: unknown) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
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
        <select value={props.statusFilter} onChange={(event) => props.onStatus(event.target.value)} aria-label="Model status">
          <option value="all">All polls</option>
          <option value="included">Included only</option>
          <option value="excluded">Excluded only</option>
          <option value="pending">Pending review</option>
          <option value="out">Not in the model</option>
        </select>
        <label>Exclusion reason
          <input value={reason} placeholder="Required when excluding" onChange={(event) => setReason(event.target.value)} />
        </label>
      </div>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead>
            <tr>
              <th>Pollster</th><th>Sponsor</th><th>Field</th><th>Released</th><th>N</th><th>Sample</th><th>MOE</th>
              <th>Abbott</th><th>Hinojosa</th><th>Other</th><th>Undecided</th><th>Margin</th><th>Ballot</th><th>Weight</th><th>Model status</th><th></th>
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
                <td style={{ whiteSpace: "normal", minWidth: 180 }}>{poll.modelStatusLabel}{poll.outlier?.flagged ? " · outlier flag" : ""}</td>
                <td>
                  {poll.inModel ? (
                    <button type="button" className="poll-btn" onClick={() => props.onPost(`/api/polling/polls/${poll.id}/exclusion`, { excluded: true, reason })}>Exclude</button>
                  ) : (
                    <button type="button" className="poll-btn" onClick={() => props.onPost(`/api/polling/polls/${poll.id}/exclusion`, { excluded: false })}>Include</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Comparison({ state }: { state: Snapshot }) {
  const rows = state.comparisons.rows ?? [];
  const sensitivity = state.sensitivity;
  return (
    <>
      <section className="poll-card">
        <h2>Sensitivity summary</h2>
        <p>{sensitivity?.sentence}</p>
        <div className="poll-meta">
          <div><span>Minimum</span>{sensitivity?.minimumLabel ?? "—"}</div>
          <div><span>Median</span>{sensitivity?.medianLabel ?? "—"}</div>
          <div><span>Maximum</span>{sensitivity?.maximumLabel ?? "—"}</div>
          <div><span>Range</span>{sensitivity ? `${sensitivity.range.toFixed(1)} points` : "—"}</div>
        </div>
        {sensitivity?.largestChanges?.length ? (
          <p className="poll-muted">Largest gaps from the latent trend: {sensitivity.largestChanges.map((row) => `${row.name} (${row.label}, ${row.gapFromPrimary >= 0 ? "+" : ""}${row.gapFromPrimary.toFixed(1)})`).join("; ")}.</p>
        ) : null}
        <p className="poll-muted">This is the spread across specifications. It is not an election probability. {String(state.comparisons.rcpNote ?? "")}</p>
      </section>
      {rows.map((row) => (
        <details key={row.id} className="poll-card" open={row.id === "weighted"}>
          <summary><strong>{row.name}</strong> — {row.label ?? "—"}</summary>
          <p>{row.explanation}</p>
          <div className="poll-meta">
            <div><span>Polls used</span>{row.polls ?? "—"}</div>
            <div><span>Field window</span>{row.window ?? "—"}</div>
            <div><span>Mean poll age</span>{row.meanAgeDays == null ? "—" : `${row.meanAgeDays.toFixed(0)} days`}</div>
            <div><span>Weighted midpoint</span>{row.weightedMidpoint ?? "—"}</div>
            <div><span>LV / RV</span>{row.lv == null ? "—" : `${row.lv} / ${row.rv}`}</div>
            <div><span>Ballots</span>{row.ballots?.length ? row.ballots.join(", ") : "—"}</div>
          </div>
        </details>
      ))}
    </>
  );
}

const DIMENSION_LABELS: [string, string][] = [
  ["all", "All dimensions"],
  ["age", "Age"],
  ["race_ethnicity", "Race / ethnicity"],
  ["party", "Party"],
  ["ideology", "Ideology"],
  ["gender", "Gender"],
  ["education", "Education"],
  ["region", "Geography"],
  ["urbanicity", "Urbanicity"],
  ["vote_history", "Prior vote"],
];

function Subgroups({ state, dimension, onDimension }: { state: Snapshot; dimension: string; onDimension: (value: string) => void }) {
  const known = new Set(DIMENSION_LABELS.map(([key]) => key));
  const extra = [...new Set(state.subgroups.map((card) => card.dimension))].filter((item) => !known.has(item));
  const dimensions = [...DIMENSION_LABELS, ...extra.map((item) => [item, item] as [string, string])];
  const cards = state.subgroups.filter((card) => dimension === "all" || card.dimension === dimension);
  return (
    <>
      <div className="poll-filters">
        <select value={dimension} onChange={(event) => onDimension(event.target.value)} aria-label="Subgroup dimension">
          {dimensions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <p className="poll-muted">Subgroup trends are diagnostic. They are not fed back into the statewide topline. A line is withheld until there are at least three approved polls in the same compatible group.</p>
      <div className="poll-grid">
        {cards.map((card) => (
          <article key={`${card.dimension}-${card.normalized}`} className="poll-card">
            <div className="poll-kicker">{card.dimension}</div>
            <h3>{card.normalized}</h3>
            <div className="poll-margin" style={{ fontSize: 22 }}>{card.currentLabel}</div>
            <p>{card.polls} polls available. {card.trendPolls} in the subgroup trend. Known subgroup n: {card.knownN ?? "not reported"}. Cells missing n: {card.nMissing}.</p>
            <p className="poll-muted">{card.precisionNote}</p>
            <p className="poll-muted">Normalized group: {card.group}. Original labels: {card.originalLabels.join(", ")}</p>
            <ul>
              {card.points.map((point) => (
                <li key={`${point.pollster}-${point.date}`}>{point.date} {point.pollster}: {point.margin.toFixed(1)} {point.n == null ? "(subgroup sample size not reported)" : `(n=${point.n})`} {point.sourceUrl ? <a href={point.sourceUrl}>{point.sourcePublisher || "source"}</a> : null}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </>
  );
}

function ModelAudit({ state }: { state: Snapshot }) {
  const audit = state.audit;
  if (!audit) return <p>The model audit is not in this snapshot.</p>;
  return (
    <>
      <section className="poll-card">
        <h2>Current primary model</h2>
        <div className="poll-meta">
          <div><span>Daily process SD</span>{fmtNum(audit.processSd)}</div>
          <div><span>Numerically best q</span>{fmtNum(audit.numericalBestQ)}</div>
          <div><span>q inside the one-SE band</span>{(audit.qBand ?? []).join(", ") || "—"}</div>
          <div><span>Selected score</span>{fmtNum(audit.selectionScore)}</div>
          <div><span>Best score</span>{fmtNum(audit.numericalBestScore)}</div>
          <div><span>Score standard error</span>{fmtNum(audit.selectionSe)}</div>
          <div><span>Excess SD</span>{fmtNum(audit.excessSd)}</div>
          <div><span>Firm-shock SD</span>{fmtNum(audit.firmSd)}</div>
          <div><span>House prior SD</span>{fmtNum(audit.houseSd)}</div>
          <div><span>Fast latent SD</span>{fmtNum(audit.qFast)}</div>
          <div><span>Polls</span>{audit.polls ?? "—"}</div>
          <div><span>Independent pollsters</span>{audit.pollsters ?? "—"}</div>
          <div><span>Headline</span>{fmtSigned(audit.margin)}</div>
          <div><span>Posterior SD</span>{fmtNum(audit.sd)}</div>
        </div>
        <p>{audit.whyQ}</p>
        <p>{audit.whyFast}</p>
        <p className="poll-muted">{audit.fieldDates}</p>
        <p className="poll-muted">{audit.recency}</p>
        <p className="poll-muted">{audit.sampleType}</p>
        <p className="poll-muted">{audit.varianceFloor}</p>
        <p className="poll-muted">{audit.pollsterDependence}</p>
        <p className="poll-muted">{audit.houseEffects}</p>
        <p className="poll-muted">{audit.bootstrap}</p>
      </section>
      <h2>State updates, in the order the filter saw them</h2>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead><tr><th>Poll</th><th>Margin</th><th>Innovation</th><th>Observation SD</th><th>Prior SD</th><th>Gain</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {(audit.updates ?? []).map((row) => (
              <tr key={row.pollId}>
                <td>{row.pollster}</td>
                <td>{fmtSigned(row.margin)}</td>
                <td>{fmtSigned(row.innovation)}</td>
                <td>{fmtNum(row.observationSd)}</td>
                <td>{fmtNum(row.priorSd)}</td>
                <td>{fmtNum(row.gain)}</td>
                <td>{fmtSigned(row.before)}</td>
                <td>{fmtSigned(row.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ModelLab({ state }: { state: Snapshot }) {
  const lab = state.modelLab;
  if (!lab) return <p>Historical calibration has not been loaded.</p>;
  const fmt = (value: number | null | undefined) => value == null ? "—" : value.toFixed(2);
  return (
    <>
      <section className="poll-card">
        <h2>Why this default</h2>
        <p>{lab.whyQ}</p>
        <p>{lab.whyHalfLife}</p>
        <p>{lab.whyHouse}</p>
        <p className="poll-muted">{lab.objective} {lab.excludedFromObjective}</p>
        <p className="poll-muted">{lab.dateLimitation} Source: {lab.source}. {lab.races} races, cycles {lab.cycles.join(", ")}.</p>
        <p className="poll-muted">Leave-one-cycle process SD values: {lab.leaveOneCycleQ.join(", ") || "—"}. Leave-one-cycle EWMA half-lives: {lab.leaveOneCycleHalfLife.join(", ") || "—"}.</p>
      </section>
      <div className="poll-table-wrap">
        <table className="poll-table">
          <thead><tr><th>Model</th><th>7-day RMSE</th><th>14-day RMSE</th><th>28-day RMSE</th><th>MAE</th><th>95% coverage</th><th>Log lik.</th><th>Residual autocorr.</th></tr></thead>
          <tbody>
            {lab.rows.map((row) => (
              <tr key={row.model}>
                <td>{row.selected ? `${row.model} (selected)` : row.model}<div className="poll-muted">{row.detail}</div></td>
                <td>{fmt(row.rmse7)}</td>
                <td>{fmt(row.rmse14)}</td>
                <td>{fmt(row.rmse28)}</td>
                <td>{fmt(row.mae)}</td>
                <td>{row.coverage95 == null ? "—" : `${(row.coverage95 * 100).toFixed(0)}%`}</td>
                <td>{fmt(row.logLik14)}</td>
                <td>{fmt(row.residualAutocorr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Pollsters({ state }: { state: Snapshot }) {
  return (
    <>
    <p className="poll-muted">House effects are shrunk toward zero. A pollster with few polls stays near zero. The number is where that pollster has sat relative to the latent margin. It is not a partisan-bias label.</p>
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
    <h2>Cluster check</h2>
    <p className="poll-muted">Polls from the same pollster are dampened only when their field midpoints fall in one chain with gaps of at most the cluster window. A later poll from the same firm is a new observation. An LV and RV result from one sample is one observation; the other frame is an alternate.</p>
    <div className="poll-table-wrap">
      <table className="poll-table">
        <thead><tr><th>Pollster</th><th>Midpoint</th><th>In window</th><th>Factor</th><th>Nearest gap</th><th>Same sample</th></tr></thead>
        <tbody>
          {(state.clusterDiagnostics ?? []).map((row) => (
            <tr key={`${row.pollster}-${row.midpoint}`}>
              <td>{row.pollster}</td>
              <td>{row.midpoint}</td>
              <td>{row.clusterSize}</td>
              <td>{row.clusterFactor.toFixed(2)}</td>
              <td>{row.nearestGapDays == null ? "—" : row.nearestGapDays.toFixed(1)}</td>
              <td style={{ whiteSpace: "normal", minWidth: 240 }}>{row.sameSampleNote}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
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
      <h3>Source completeness</h3>
      <p className="poll-muted">These multipliers measure whether the original poll can be documented. They are not a sponsor or ideology score.</p>
      <div className="poll-settings">
        {Object.entries(form.source_completeness).map(([key, value]) => (
          <label key={key}>{key.replaceAll("_", " ")}
            <input type="number" step="0.05" value={value} onChange={(event) => setForm({ ...form, source_completeness: { ...form.source_completeness, [key]: Number(event.target.value) } })} />
          </label>
        ))}
      </div>
      <h3>Sponsor multipliers, sensitivity only</h3>
      <p className="poll-muted">Sponsor type stays on every poll. It does not change the default weight unless this switch is on. The comparison page also has a row that uses these factors instead of source completeness.</p>
      <label>Apply sponsor multipliers in the default model
        <select value={form.sponsorship_weights.apply_in_default_model ? "yes" : "no"} onChange={(event) => setForm({ ...form, sponsorship_weights: { ...form.sponsorship_weights, apply_in_default_model: event.target.value === "yes" } })}>
          <option value="no">Off</option><option value="yes">On</option>
        </select>
      </label>
      <div className="poll-settings">
        {Object.entries(form.sponsorship_weights).filter(([key]) => key !== "apply_in_default_model").map(([key, value]) => (
          <label key={key}>{key.replaceAll("_", " ")}
            <input type="number" step="0.05" value={Number(value)} onChange={(event) => setForm({ ...form, sponsorship_weights: { ...form.sponsorship_weights, [key]: Number(event.target.value) } })} />
          </label>
        ))}
      </div>
      <p>
        <button type="button" className="poll-btn primary" onClick={() => onSave(form)}>Apply</button>{" "}
        <button type="button" className="poll-btn" onClick={onReset}>Reset to defaults</button>
      </p>
      <p className="poll-muted">Sample-type mode is "{form.sample_type.mode}". Multipliers are the live adjustment. A model-based sample-type effect is not estimated until there is enough overlapping LV and RV fieldwork, and flipping the switch does not drop the RV multiplier on its own. Model version {state.meta.modelVersion}. Changing a default in model.yaml requires a version increment; this screen stores an override on top of that file.</p>
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
          {(state.quality.checks ?? []).map((check) => <div key={check.code} title={check.note}><span>{check.code}</span>{check.count}</div>)}
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
        <p><strong>{poll.modelStatusLabel}.</strong> {poll.modelStatusDetail}</p>
        {poll.preferredVersion ? <p>Preferred version: {poll.preferredVersion}</p> : null}
        <p>Ballot: {poll.ballot || "unspecified"}. Data completeness {poll.completeness.score}. Source: {poll.sourceCompletenessLabel}.</p>
        <p>{poll.sameSampleNote}</p>
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
          {poll.inModel ? (
            <>
              <input value={reason} placeholder="Reason required to exclude" onChange={(event) => setReason(event.target.value)} />{" "}
              <button type="button" className="poll-btn" onClick={() => onPost(`/api/polling/polls/${poll.id}/exclusion`, { excluded: true, reason })}>Exclude from model</button>
            </>
          ) : (
            <button type="button" className="poll-btn primary" onClick={() => onPost(`/api/polling/polls/${poll.id}/exclusion`, { excluded: false })}>Include in model</button>
          )}
        </p>
      </article>
      <article className="poll-card">
        <h3>Measurement variance</h3>
        {poll.measurement ? (
          <ul>
            <li>Sampling margin SE {poll.impact?.samplingSe == null ? poll.measurement.samplingSe.toFixed(2) : poll.impact.samplingSe.toFixed(2)} ({poll.measurement.samplingStatus}). This is derived from the shares. It is not the reported candidate MOE.</li>
            <li>Excess error SD {poll.impact?.excessSd == null ? "—" : poll.impact.excessSd.toFixed(2)}. Firm-shock SD {poll.impact?.firmShockSd == null ? "—" : poll.impact.firmShockSd.toFixed(2)}. Population/mode SD {poll.impact?.populationModeSd == null ? "—" : poll.impact.populationModeSd.toFixed(2)}.</li>
            <li>Variance floor in the primary observation: {poll.impact?.varianceFloorSd == null ? "0" : poll.impact.varianceFloorSd.toFixed(2)}. The 2-point floor belongs to the comparison weights.</li>
            <li>Final observation SD used by the filter {poll.impact?.finalObservationSd == null ? "—" : poll.impact.finalObservationSd.toFixed(2)}. Components are added as variances, then square-rooted.</li>
            <li>Reported candidate MOE {poll.designEffectMoe ?? poll.moe ?? "not reported"}. MOE status {poll.measurement.moeStatus}.</li>
            <li>n_eff {poll.measurement.nEff == null ? "—" : Math.round(poll.measurement.nEff)} ({poll.measurement.nEffStatus}). MOE status {poll.measurement.moeStatus}.</li>
            <li>{poll.measurement.note}</li>
          </ul>
        ) : <p>No measurement variance, because this poll is not in the model.</p>}
        {poll.impact ? <p>Removing this poll moves today's latent margin from {poll.impact.withPoll.toFixed(1)} to {poll.impact.withoutPoll == null ? "—" : poll.impact.withoutPoll.toFixed(1)}. Impact {poll.impact.impact == null ? "—" : poll.impact.impact.toFixed(2)}.</p> : null}
        <h3>Weight</h3>
        {poll.weights ? (
          <>
            <p className="poll-muted">{poll.weights.formula}</p>
            <p className="poll-muted">House effects, when enabled, change the margin used in the fit. They are not a weight. Applied house effect on this poll: {poll.weights.houseEffect == null ? "not estimated" : poll.weights.houseEffect.toFixed(1)}.</p>
            <ul>
              <li>Raw margin {poll.weights.rawMargin.toFixed(1)}. Adjusted margin {poll.weights.adjustedMargin == null ? "—" : poll.weights.adjustedMargin.toFixed(1)}.</li>
              <li>Reported N {poll.sampleSize ?? "missing"}. Reported MOE {poll.designEffectMoe ?? poll.moe ?? "not reported"}.</li>
              <li>Design effect {poll.weights.designEffect == null ? "not computed" : poll.weights.designEffect.toFixed(2)}{poll.weights.designEffectEstimated ? " (estimated)" : ""}.</li>
              <li>Effective N {poll.weights.nEff == null ? "—" : Math.round(poll.weights.nEff)}{poll.weights.nEffEstimated ? " (estimated)" : ""}. {poll.weights.precisionNote}</li>
              <li>Sampling variance {poll.weights.samplingVariance.toFixed(2)}. Variance floor {poll.weights.varianceFloor.toFixed(2)}. Total variance {poll.weights.totalVariance.toFixed(2)}.</li>
              <li>Raw inverse-variance precision {poll.weights.precision.toFixed(4)}. Normalized precision share {(poll.weights.precisionShare * 100).toFixed(1)}%.</li>
              <li>Recency {poll.weights.recency.toFixed(3)}. Age {poll.weights.ageDays.toFixed(1)} days. Base half-life {poll.weights.baseHalfLife}. Effective half-life {poll.weights.effectiveHalfLife}.</li>
              <li>Sample type × {poll.weights.sampleType.toFixed(2)}</li>
              <li>Source completeness × {poll.weights.sourceQuality.toFixed(2)} ({poll.sourceCompletenessLabel})</li>
              <li>Sponsor type is {poll.sponsorType}. Table factor {poll.weights.sponsorTable.toFixed(2)}. Applied factor {poll.weights.sponsorship.toFixed(2)}.</li>
              <li>Cluster × {poll.weights.cluster.toFixed(2)} across {poll.weights.clusterSize} poll{poll.weights.clusterSize === 1 ? "" : "s"}. Nearest same-pollster gap {poll.weights.nearestGapDays == null ? "none" : `${poll.weights.nearestGapDays.toFixed(1)} days`}.</li>
              <li>Outlier factor × {poll.weights.outlierFactor.toFixed(2)}</li>
              <li>Pre-normalized weight {poll.weights.raw.toFixed(4)}. Final contribution {(poll.weights.final * 100).toFixed(1)}%.</li>
            </ul>
          </>
        ) : <p>Not in the model, so it has no weight. Sponsor type remains {poll.sponsorType}. Source status: {poll.sourceCompletenessLabel}.</p>}
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
