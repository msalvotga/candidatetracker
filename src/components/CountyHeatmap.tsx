import { useEffect, useMemo, useRef, useState } from "react";
import { PendingSaveBar, valuesEqual } from "./PendingSaveBar";
import texasPaths from "../data/texasCountyPaths.json";
import { saveCountyResult } from "../api";
import {
  formatMetricDisplay,
  gopShareToMarginPoints,
  marginFillColor,
  marginPointsToValue,
  metricDisplayClass,
  metricDisplayOptions,
  isBenchmarkMetricKey,
  metricGroupsForCategory,
} from "../lib/metrics";
import type { CountyElection, CountyResult, OfficeCategory, RaceMetric } from "../types";

function normalizeCountyKey(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface TooltipState {
  county: CountyResult;
  x: number;
  y: number;
}

export function CountyHeatmap({
  counties,
  title,
  editMode,
  election,
  onCountySaved,
}: {
  counties: CountyResult[];
  title: string;
  editMode?: boolean;
  election?: CountyElection;
  onCountySaved?: (county: CountyResult) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const byKey = useMemo(() => {
    const map = new Map<string, CountyResult>();
    for (const county of counties) {
      map.set(county.county_key, county);
    }
    return map;
  }, [counties]);

  const pathEntries = useMemo(
    () => Object.entries(texasPaths.counties as Record<string, { name: string; path: string }>),
    []
  );

  return (
    <div className="county-heatmap-wrap">
      <h3 className="county-heatmap-title">{title}</h3>
      <div className="county-heatmap-legend">
        <span className="legend-item metric-rep">Republican lead</span>
        <span className="legend-item metric-dem">Democratic lead</span>
        <span className="legend-item legend-nodata">No data</span>
      </div>
      <div className="county-heatmap" ref={containerRef}>
        <svg viewBox={texasPaths.viewBox} className="county-heatmap-svg" role="img" aria-label={title}>
          {pathEntries.map(([fips, entry]) => {
            const key = normalizeCountyKey(entry.name);
            const county = byKey.get(key);
            const margin = county?.margin ?? null;
            const fill = marginFillColor(margin);
            return (
              <path
                key={fips}
                d={entry.path}
                fill={fill}
                stroke="#1a2332"
                strokeWidth={0.5}
                onMouseEnter={(e) => {
                  if (!county) return;
                  const rect = containerRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  setTooltip({
                    county,
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                  });
                }}
                onMouseMove={(e) => {
                  if (!county) return;
                  const rect = containerRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  setTooltip({
                    county,
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            );
          })}
        </svg>
        {tooltip ? (
          <div
            className="county-heatmap-tooltip"
            style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
          >
            <strong>{tooltip.county.county_name}</strong>
            <div>
              Margin:{" "}
              <span className={tooltip.county.margin != null && tooltip.county.margin >= 0 ? "metric-rep" : "metric-dem"}>
                {tooltip.county.margin != null
                  ? tooltip.county.margin >= 0
                    ? `R+${(tooltip.county.margin * 100).toFixed(1)}`
                    : `D+${(-tooltip.county.margin * 100).toFixed(1)}`
                  : "—"}
              </span>
            </div>
            {tooltip.county.gop_pct != null ? (
              <div>GOP: {(tooltip.county.gop_pct * 100).toFixed(1)}%</div>
            ) : null}
            {tooltip.county.dem_pct != null ? (
              <div>DEM: {(tooltip.county.dem_pct * 100).toFixed(1)}%</div>
            ) : null}
          </div>
        ) : null}
      </div>
      {editMode && election ? (
        <CountyEditTable counties={counties} election={election} onCountySaved={onCountySaved} />
      ) : null}
    </div>
  );
}

function CountyEditTable({
  counties,
  election,
  onCountySaved,
}: {
  counties: CountyResult[];
  election: CountyElection;
  onCountySaved?: (county: CountyResult) => void;
}) {
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Partial<CountyResult>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return counties;
    return counties.filter((c) => c.county_name.toLowerCase().includes(query));
  }, [counties, filter]);

  const editableFields = ["margin", "gop_pct", "dem_pct", "gop_votes", "dem_votes"] as const;

  const hasPending = Object.keys(drafts).length > 0;

  useEffect(() => {
    setDrafts({});
    setSaved(false);
    setError("");
  }, [election]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  function fieldValue(county: CountyResult, field: (typeof editableFields)[number]) {
    const pending = drafts[county.county_key]?.[field];
    if (pending !== undefined) return pending === null ? "" : String(pending);
    return county[field] == null ? "" : String(county[field]);
  }

  function updateDraft(county: CountyResult, field: (typeof editableFields)[number], raw: string) {
    const parsed = raw.trim() === "" ? null : Number(raw);
    if (raw.trim() !== "" && !Number.isFinite(parsed)) return;

    const savedValue = county[field] ?? null;
    const isDirty = !valuesEqual(parsed, savedValue);

    setDrafts((prev) => {
      const next = { ...prev };
      const countyDraft = { ...(next[county.county_key] ?? {}) };

      if (!isDirty) {
        delete countyDraft[field];
        if (Object.keys(countyDraft).length === 0) {
          delete next[county.county_key];
        } else {
          next[county.county_key] = countyDraft;
        }
      } else {
        next[county.county_key] = { ...countyDraft, [field]: parsed };
      }

      return next;
    });
    setSaved(false);
    setError("");
  }

  function discardDrafts() {
    setDrafts({});
    setError("");
    setSaved(false);
  }

  async function saveAll() {
    if (!hasPending) return;
    setSaving(true);
    setError("");
    try {
      const tasks: Promise<void>[] = [];
      for (const [countyKey, patch] of Object.entries(drafts)) {
        const county = counties.find((c) => c.county_key === countyKey);
        if (!county) continue;
        for (const [field, value] of Object.entries(patch)) {
          tasks.push(
            saveCountyResult(election, countyKey, { [field]: value }).then((updated) => {
              onCountySaved?.(updated);
            })
          );
        }
      }
      await Promise.all(tasks);
      setDrafts({});
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="county-edit-table-wrap">
      <input
        className="race-search"
        type="search"
        placeholder="Filter counties…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="county-edit-table-scroll">
        <table className="county-edit-table">
          <thead>
            <tr>
              <th>County</th>
              <th>Margin</th>
              <th>GOP %</th>
              <th>DEM %</th>
              <th>GOP votes</th>
              <th>DEM votes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((county) => (
              <tr key={county.county_key}>
                <td>{county.county_name}</td>
                {editableFields.map((field) => (
                  <td key={field}>
                    <input
                      className="edit-input edit-input-sm"
                      type="number"
                      step={field.includes("votes") ? 1 : 0.001}
                      value={fieldValue(county, field)}
                      disabled={saving}
                      onChange={(e) => updateDraft(county, field, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PendingSaveBar
        visible={hasPending}
        saving={saving}
        saved={saved}
        error={error}
        onSave={() => void saveAll()}
        onDiscard={discardDrafts}
      />
    </div>
  );
}

export function RaceMetrics({
  metrics,
  category,
  editMode,
  onPendingMetricChange,
  onMetricClick,
}: {
  metrics?: RaceMetric[];
  category: OfficeCategory;
  editMode?: boolean;
  onPendingMetricChange?: (key: string, value: number | null | undefined) => void;
  onMetricClick?: (metric: RaceMetric) => void;
}) {
  const byKey = new Map((metrics ?? []).map((metric) => [metric.key, metric]));
  const groups = metricGroupsForCategory(category);

  function renderMetric(metric: RaceMetric) {
    if (editMode && isBenchmarkMetricKey(metric.key)) {
      return (
        <MetricEditor
          key={metric.key}
          metric={metric}
          onPendingChange={onPendingMetricChange}
        />
      );
    }

    if (isBenchmarkMetricKey(metric.key)) {
      return (
        <div
          key={metric.key}
          className={`race-metric ${metricDisplayClass(metric.value, metricDisplayOptions(metric))}`}
        >
          <span className="race-metric-label">{metric.label}</span>
          <span className="race-metric-value">
            {formatMetricDisplay(metric.value, metricDisplayOptions(metric))}
          </span>
        </div>
      );
    }

    return (
      <button
        key={metric.key}
        type="button"
        className={`race-metric race-metric-button ${metricDisplayClass(metric.value, metricDisplayOptions(metric))}`}
        onClick={() => onMetricClick?.(metric)}
        title="View contest details"
      >
        <span className="race-metric-label">{metric.label}</span>
        <span className="race-metric-value">
          {formatMetricDisplay(metric.value, metricDisplayOptions(metric))}
        </span>
      </button>
    );
  }

  const sections = groups
    .map((group) => {
      const groupMetrics = group.fields.map((field) => {
        const existing = byKey.get(field.key);
        return {
          key: field.key,
          label: field.label,
          value: existing?.value ?? null,
          uncontested: existing?.uncontested,
          winning_party: existing?.winning_party,
        };
      });
      const visible =
        group.id === "prior_elections"
          ? groupMetrics.filter((metric) => metric.value != null)
          : editMode
            ? groupMetrics
            : groupMetrics.filter((metric) => metric.value != null);
      if (visible.length === 0) return null;
      return { group, visible };
    })
    .filter((section): section is NonNullable<typeof section> => section != null);

  if (sections.length === 0) return null;

  return (
    <div className="race-metrics-groups">
      {sections.map(({ group, visible }) => (
        <section key={group.id} className="race-metrics-group">
          <h3 className="race-metrics-group-title">{group.title}</h3>
          <div className="race-metrics">{visible.map(renderMetric)}</div>
        </section>
      ))}
    </div>
  );
}

function MetricEditor({
  metric,
  onPendingChange,
}: {
  metric: RaceMetric;
  onPendingChange?: (key: string, value: number | null | undefined) => void;
}) {
  const [draft, setDraft] = useState(gopShareToMarginPoints(metric.value, metric.key));
  const preview = marginPointsToValue(draft, metric.key);

  useEffect(() => {
    setDraft(gopShareToMarginPoints(metric.value, metric.key));
  }, [metric.key, metric.value]);

  useEffect(() => {
    if (!onPendingChange) return;
    const parsed = marginPointsToValue(draft, metric.key);
    const isDirty = !valuesEqual(parsed, metric.value);
    onPendingChange(metric.key, isDirty ? parsed : undefined);
  }, [draft, metric.key, metric.value, onPendingChange]);

  return (
    <div className={`race-metric race-metric-edit ${metricDisplayClass(preview ?? metric.value, metricDisplayOptions(metric))}`}>
      <span className="race-metric-label">{metric.label}</span>
      <div className="metric-edit-row">
        <input
          className="edit-input"
          type="number"
          step={0.1}
          placeholder={isBenchmarkMetricKey(metric.key) ? "pts (+R / −D)" : "pts (+R / −D from 50%)"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <span className="race-metric-value">
          {formatMetricDisplay(preview ?? metric.value, metricDisplayOptions(metric))}
        </span>
      </div>
    </div>
  );
}
