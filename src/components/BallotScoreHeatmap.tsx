import { useMemo, useRef, useState, type MouseEvent } from "react";
import texasPaths from "../data/texasCountyPaths.json";
import districtPaths from "../data/txDistrictPaths.json";
import { formatDelta } from "../lib/ballotScoreModel";

type MapLine = { label: string; value: string };

export type BallotMapCell = {
  key: string;
  label: string;
  value: number | null;
  lines: MapLine[];
};

type Geography = "county" | "house" | "senate" | "congress";

const COUNTY_PATHS = texasPaths as {
  viewBox: string;
  counties: Record<string, { path: string; name: string }>;
};

const DISTRICT_PATHS = districtPaths as {
  viewBox: string;
  house: Record<string, string>;
  senate: Record<string, string>;
  congress: Record<string, string>;
};

function hexToRgb(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function mix(from: string, to: string, t: number) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const clamped = Math.min(1, Math.max(0, t));
  const rgb = a.map((channel, index) => Math.round(channel + (b[index] - channel) * clamped));
  return `rgb(${rgb.join(",")})`;
}

function absoluteFill(score: number) {
  return mix("#d7e6f7", "#163e78", score / 100);
}

function compareFill(diff: number, maxAbs: number) {
  if (maxAbs <= 0) return "#f4f5f7";
  const t = Math.max(-1, Math.min(1, diff / maxAbs));
  if (t < 0) return mix("#2457a6", "#f4f5f7", 1 + t);
  return mix("#f4f5f7", "#b86a00", t);
}

function shapesFor(geography: Geography): { viewBox: string; shapes: { key: string; d: string }[] } | null {
  if (geography === "county") {
    return {
      viewBox: COUNTY_PATHS.viewBox,
      shapes: Object.values(COUNTY_PATHS.counties).map((county) => ({
        key: county.name.toUpperCase(),
        d: county.path,
      })),
    };
  }
  const paths = DISTRICT_PATHS[geography];
  const keys = Object.keys(paths ?? {});
  if (!keys.length) return null;
  return {
    viewBox: DISTRICT_PATHS.viewBox || "0 0 920 860",
    shapes: keys.map((key) => ({ key, d: paths[key] })),
  };
}

export function BallotScoreHeatmap({
  geography,
  mode,
  dayLabel,
  cells,
  query,
}: {
  geography: Geography;
  mode: "absolute" | "compare";
  dayLabel: string;
  cells: BallotMapCell[];
  query: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ cell: BallotMapCell; x: number; y: number } | null>(null);
  const byKey = useMemo(() => new Map(cells.map((cell) => [cell.key, cell])), [cells]);
  const shapes = shapesFor(geography);
  const maxAbs = useMemo(() => {
    if (mode !== "compare") return 1;
    const peak = cells.reduce((max, cell) => Math.max(max, Math.abs(cell.value ?? 0)), 0);
    return peak > 0 ? peak : 1;
  }, [cells, mode]);
  const q = query.trim().toLowerCase();

  const items = shapes
    ? shapes.shapes.map((shape) => ({
        ...shape,
        cell: byKey.get(shape.key) ?? { key: shape.key, label: shape.key, value: null, lines: [] },
      }))
    : cells.map((cell) => ({ key: cell.key, d: "", cell }));

  function fill(cell: BallotMapCell) {
    if (cell.value == null || Number.isNaN(cell.value)) return "#e6e9ef";
    return mode === "absolute" ? absoluteFill(cell.value) : compareFill(cell.value, maxAbs);
  }

  function moveTip(event: MouseEvent, cell: BallotMapCell) {
    const rect = frameRef.current?.getBoundingClientRect();
    setTip({
      cell,
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    });
  }

  const cols = Math.max(1, Math.ceil(Math.sqrt(items.length || 1)));
  const tile = 42;

  return (
    <div className="enr-ballot-map">
      <div className="enr-ballot-map__legend" aria-hidden>
        {mode === "absolute" ? (
          <>
            <div className="enr-ballot-map__ramp enr-ballot-map__ramp--absolute" />
            <div className="enr-ballot-map__ticks">
              <span>0</span>
              <span>50</span>
              <span>100</span>
            </div>
            <p>2026 model score for 2026 voters, cumulative through {dayLabel}. Higher is a higher modeled score.</p>
          </>
        ) : (
          <>
            <div className="enr-ballot-map__ramp enr-ballot-map__ramp--compare" />
            <div className="enr-ballot-map__ticks">
              <span>{formatDelta(-maxAbs)}</span>
              <span>0</span>
              <span>{formatDelta(maxAbs)}</span>
            </div>
            <p>
              2026 voters’ 2026-model average minus 2022 voters’ 2026-model average, cumulative through {dayLabel}.
              Negative means the 2026 electorate scores lower on the same model.
            </p>
          </>
        )}
      </div>
      <div className="enr-ballot-map__frame" ref={frameRef} onMouseLeave={() => setTip(null)}>
        {shapes ? (
          <svg className="enr-ballot-map__svg" viewBox={shapes.viewBox} role="img" aria-label={`${geography} ballot score map`}>
            {items.map((item) => {
              const hit = q && (item.cell.label.toLowerCase().includes(q) || item.cell.key.toLowerCase().includes(q));
              return (
                <path
                  key={item.key}
                  d={item.d}
                  fill={fill(item.cell)}
                  stroke={hit ? "#0b1f44" : "#ffffff"}
                  strokeWidth={hit ? 2.4 : 0.6}
                  onMouseMove={(event) => moveTip(event, item.cell)}
                >
                  <title>{item.cell.label}</title>
                </path>
              );
            })}
          </svg>
        ) : (
          <svg
            className="enr-ballot-map__svg"
            viewBox={`0 0 ${cols * tile} ${Math.ceil(items.length / cols) * tile}`}
            role="img"
            aria-label={`${geography} ballot score grid`}
          >
            {items.map((item, index) => {
              const x = (index % cols) * tile;
              const y = Math.floor(index / cols) * tile;
              const hit = q && (item.cell.label.toLowerCase().includes(q) || item.cell.key.toLowerCase().includes(q));
              return (
                <g key={item.key} onMouseMove={(event) => moveTip(event, item.cell)}>
                  <rect x={x + 2} y={y + 2} width={tile - 4} height={tile - 4} rx={4} fill={fill(item.cell)} stroke={hit ? "#0b1f44" : "#ffffff"} />
                  <text x={x + tile / 2} y={y + tile / 2 + 3} textAnchor="middle" fontSize="9" fill="#10233f">
                    {item.key}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        {tip ? (
          <div className="enr-ballot-map__tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
            <strong>{tip.cell.label}</strong>
            <div>{dayLabel}</div>
            {tip.cell.lines.map((line) => (
              <div key={line.label}>
                <span>{line.label}</span>
                <span>{line.value}</span>
              </div>
            ))}
            {tip.cell.value == null ? <div>No scored voters</div> : null}
          </div>
        ) : null}
      </div>
      {!shapes && geography !== "county" ? (
        <p className="enr-ballot__hint">
          District outlines are not loaded, so this view uses a numbered grid. County maps use the Texas county shapes.
        </p>
      ) : null}
    </div>
  );
}
