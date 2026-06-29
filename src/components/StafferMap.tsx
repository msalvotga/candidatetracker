import { useMemo, useRef, useState } from "react";
import texasPaths from "../data/texasCountyPaths.json";
import { canonicalCountyKey } from "../lib/countyKeys";
import { buildStafferColorMap, splitLabel, STAFFER_MAP_UNASSIGNED } from "../lib/stafferColors";
import type { StafferMapEntry } from "../types";

interface TooltipState {
  countyName: string;
  staffers: string[];
  x: number;
  y: number;
}

function patternKey(stafferNames: string[]) {
  return stafferNames.join("|");
}

function CountyPattern({
  id,
  colors,
}: {
  id: string;
  colors: string[];
}) {
  const stripe = 12 / colors.length;
  return (
    <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      {colors.map((color, index) => (
        <rect
          key={index}
          x={index * stripe}
          y={0}
          width={stripe}
          height="12"
          fill={color}
        />
      ))}
    </pattern>
  );
}

export function StafferMap({ staffers }: { staffers: StafferMapEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const colorByName = useMemo(() => buildStafferColorMap(staffers.map((s) => s.name)), [staffers]);

  const staffersByCountyKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const staffer of staffers) {
      for (const county of staffer.counties) {
        const key = canonicalCountyKey(county);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(staffer.name);
      }
    }
    for (const names of map.values()) {
      names.sort((a, b) => a.localeCompare(b));
    }
    return map;
  }, [staffers]);

  const overlapPairs = useMemo(() => {
    const pairs = new Map<string, string[]>();
    for (const names of staffersByCountyKey.values()) {
      if (names.length < 2) continue;
      pairs.set(patternKey(names), names);
    }
    return [...pairs.entries()];
  }, [staffersByCountyKey]);

  const pathEntries = useMemo(
    () => Object.entries(texasPaths.counties as Record<string, { name: string; path: string }>),
    []
  );

  const assignedCount = useMemo(() => {
    let count = 0;
    for (const [, entry] of pathEntries) {
      if (staffersByCountyKey.has(canonicalCountyKey(entry.name))) count += 1;
    }
    return count;
  }, [pathEntries, staffersByCountyKey]);

  function showTooltip(e: React.MouseEvent, countyName: string, stafferNames: string[]) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      countyName,
      staffers: stafferNames,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }

  return (
    <div className="staffer-map-wrap">
      <header className="staffer-map-header">
        <h2 className="staffer-map-title">TGA staffer territories</h2>
        <p className="staffer-map-subtitle">
          {assignedCount} of {pathEntries.length} counties assigned · county-based staffers only
        </p>
      </header>

      <div className="staffer-map-legend" aria-label="Staffer legend">
        {staffers.map((staffer) => {
          const color = colorByName.get(staffer.name)!;
          return (
            <span key={staffer.id} className="staffer-map-legend-item">
              <span className="staffer-map-legend-swatch" style={{ background: color }} />
              {staffer.name}
            </span>
          );
        })}
        {overlapPairs.map(([key, names]) => (
          <span key={key} className="staffer-map-legend-item staffer-map-legend-overlap">
            <span
              className="staffer-map-legend-swatch staffer-map-legend-swatch-split"
              style={{
                background: `linear-gradient(135deg, ${colorByName.get(names[0])} 50%, ${colorByName.get(names[1] ?? names[0])} 50%)`,
              }}
            />
            {splitLabel(names)}
          </span>
        ))}
        <span className="staffer-map-legend-item">
          <span className="staffer-map-legend-swatch" style={{ background: STAFFER_MAP_UNASSIGNED }} />
          Unassigned
        </span>
      </div>

      <div className="staffer-map-canvas county-heatmap" ref={containerRef}>
        <svg viewBox={texasPaths.viewBox} className="county-heatmap-svg" role="img" aria-label="Texas TGA staffer map">
          <defs>
            {overlapPairs.map(([key, names]) => (
              <CountyPattern
                key={key}
                id={`staffer-pattern-${key.replace(/[^a-z0-9|]+/gi, "-")}`}
                colors={names.map((name) => colorByName.get(name)!)}
              />
            ))}
          </defs>
          {pathEntries.map(([fips, entry]) => {
            const key = canonicalCountyKey(entry.name);
            const stafferNames = staffersByCountyKey.get(key) ?? [];
            let fill = STAFFER_MAP_UNASSIGNED;
            if (stafferNames.length === 1) {
              fill = colorByName.get(stafferNames[0])!;
            } else if (stafferNames.length > 1) {
              fill = `url(#staffer-pattern-${patternKey(stafferNames).replace(/[^a-z0-9|]+/gi, "-")})`;
            }

            return (
              <path
                key={fips}
                d={entry.path}
                fill={fill}
                stroke="#1a2332"
                strokeWidth={0.5}
                onMouseEnter={(e) => showTooltip(e, entry.name, stafferNames)}
                onMouseMove={(e) => showTooltip(e, entry.name, stafferNames)}
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
            <strong>{tooltip.countyName}</strong>
            {tooltip.staffers.length ? (
              <div>{tooltip.staffers.join(", ")}</div>
            ) : (
              <div className="staffer-map-tooltip-empty">No staffer assigned</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
