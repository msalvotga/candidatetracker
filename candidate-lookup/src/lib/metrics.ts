import type { OfficeCategory } from "../types";

export const BENCHMARK_METRIC_KEYS = new Set(["trump_2024", "cruz_2024", "abbott_2022"]);
export const LEG_METRIC_KEYS = new Set(["leg_2024", "leg_2022"]);

export function isBenchmarkMetricKey(key?: string) {
  return key != null && BENCHMARK_METRIC_KEYS.has(key);
}

export function isLegMetricKey(key?: string) {
  return key != null && LEG_METRIC_KEYS.has(key);
}

export function usesMarginStorage(metricKey?: string) {
  return metricKey != null && (isBenchmarkMetricKey(metricKey) || isLegMetricKey(metricKey));
}

export function normalizeCountyKey(name: string) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseMetricValue(value: unknown) {
  if (value === "" || value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const num = Number(String(value).replace(/[$,%\s]/g, ""));
  return Number.isFinite(num) ? num : null;
}

/** Convert stored or legacy GOP two-party share to R−D margin decimal. */
export function marginFromGopShare(gopShare: number | null) {
  if (gopShare == null || Number.isNaN(gopShare)) return null;
  return 2 * (gopShare - 0.5);
}

/** Normalize metric DB / API values to R−D margin for display. */
export function metricAsMargin(value: number | null, metricKey?: string) {
  if (value == null || Number.isNaN(value)) return null;
  if (metricKey && isLegMetricKey(metricKey) && value > 0.25 && value < 0.75) {
    return marginFromGopShare(value);
  }
  return value;
}

export function formatMetricDisplay(
  value: number | null,
  options?: { uncontested?: boolean; winningParty?: string | null; metricKey?: string }
) {
  if (options?.uncontested) return "Uncontested";
  if (value == null || Number.isNaN(value)) return "—";

  const margin = usesMarginStorage(options?.metricKey)
    ? metricAsMargin(value, options?.metricKey)
    : marginFromGopShare(value);
  if (margin == null) return "—";

  const pts = Math.abs(margin * 100);
  return margin >= 0 ? `R+${pts.toFixed(1)}` : `D+${pts.toFixed(1)}`;
}

export function metricPartyClass(gopShare: number | null) {
  if (gopShare == null || Number.isNaN(gopShare)) return "metric-neutral";
  return gopShare >= 0.5 ? "metric-rep" : "metric-dem";
}

export function metricDisplayClass(
  value: number | null,
  options?: { uncontested?: boolean; winningParty?: string | null; metricKey?: string }
) {
  if (options?.uncontested && options.winningParty) {
    if (options.winningParty === "R") return "metric-rep";
    if (options.winningParty === "D") return "metric-dem";
  }
  if (usesMarginStorage(options?.metricKey)) {
    const margin = metricAsMargin(value, options?.metricKey);
    if (margin == null || Number.isNaN(margin)) return "metric-neutral";
    return margin >= 0 ? "metric-rep" : "metric-dem";
  }
  return metricPartyClass(value);
}

export function metricDisplayOptions(metric: {
  key: string;
  value: number | null;
  uncontested?: boolean;
  winning_party?: string | null;
}) {
  return {
    uncontested: metric.uncontested,
    winningParty: metric.winning_party,
    metricKey: metric.key,
  };
}

export function marginFillColor(margin: number | null) {
  if (margin == null || Number.isNaN(margin)) return "#2e3038";
  const intensity = Math.min(Math.abs(margin) / 0.35, 1);
  if (margin >= 0) {
    const r = Math.round(190 - intensity * 90);
    const g = Math.round(95 - intensity * 55);
    const b = Math.round(95 - intensity * 55);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const r = Math.round(95 - intensity * 55);
  const g = Math.round(110 - intensity * 50);
  const b = Math.round(200 - intensity * 90);
  return `rgb(${r}, ${g}, ${b})`;
}

export function legMetricFieldsForCategory(category: OfficeCategory) {
  if (category === "house") {
    return [
      { key: "leg_2024", label: "2024 TX House" },
      { key: "leg_2022", label: "2022 TX House" },
    ];
  }
  if (category === "senate") {
    return [
      { key: "leg_2024", label: "2024 TX Senate" },
      { key: "leg_2022", label: "2022 TX Senate" },
    ];
  }
  if (category === "sboe") {
    return [
      { key: "leg_2024", label: "2024 SBOE" },
      { key: "leg_2022", label: "2022 SBOE" },
    ];
  }
  if (category === "congressional") {
    return [
      { key: "leg_2024", label: "2024 TX CD" },
      { key: "leg_2022", label: "2022 TX CD" },
    ];
  }
  if (category === "statewide") {
    return [
      { key: "leg_2024", label: "2024 result" },
      { key: "leg_2022", label: "2022 result" },
    ];
  }
  return [];
}

const BENCHMARK_METRIC_FIELDS = [
  { key: "trump_2024", label: "2024 Trump" },
  { key: "cruz_2024", label: "2024 Cruz" },
  { key: "abbott_2022", label: "2022 Abbott" },
] as const;

export function metricGroupsForCategory(category: OfficeCategory) {
  const groups: { id: string; title: string; fields: { key: string; label: string }[] }[] = [
    {
      id: "statewide_benchmarks",
      title: "Historical statewide performance in district",
      fields: [...BENCHMARK_METRIC_FIELDS],
    },
  ];

  const legFields = legMetricFieldsForCategory(category);
  if (legFields.length > 0) {
    groups.push({
      id: "prior_elections",
      title: "Prior election results",
      fields: legFields,
    });
  }

  return groups;
}

export function metricFieldsForCategory(category: OfficeCategory) {
  return metricGroupsForCategory(category).flatMap((group) => group.fields);
}

export function gopShareToMarginPoints(value: number | null, metricKey?: string) {
  if (value == null || Number.isNaN(value)) return "";
  const margin = usesMarginStorage(metricKey) ? metricAsMargin(value, metricKey) : marginFromGopShare(value);
  if (margin == null) return "";
  return String(Math.round(margin * 1000) / 10);
}

export function marginPointsToValue(points: string, metricKey?: string) {
  const trimmed = points.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  if (usesMarginStorage(metricKey)) {
    return num / 100;
  }
  return 0.5 + num / 100;
}

/** @deprecated use marginPointsToValue */
export function marginPointsToGopShare(points: string, metricKey?: string) {
  return marginPointsToValue(points, metricKey);
}

/** @deprecated use marginFromGopShare */
export function metricMargin(gopShare: number | null) {
  return marginFromGopShare(gopShare);
}
