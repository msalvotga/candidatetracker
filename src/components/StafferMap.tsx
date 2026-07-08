import { useEffect, useMemo, useRef, useState } from "react";
import texasPaths from "../data/texasCountyPaths.json";
import harrisPaths from "../data/harrisHouseDistrictPaths.json";
import { HarrisDistrictMap } from "./HarrisDistrictMap";
import { countyLabelFontSize, computeCountyCentroids } from "../lib/countyMapGeometry";
import {
  harrisDistrictStaffersForMap,
} from "../lib/harrisDistrictStaffers";
import {
  buildStafferColorMap,
  buildStafferColorOverrideMap,
  mergeStaffersForLegend,
  STAFFER_MAP_UNASSIGNED,
} from "../lib/stafferColors";
import { canonicalCountyKey } from "../lib/countyKeys";
import type { StafferDistrictEntry, StafferMapEntry, StafferOption } from "../types";

const HARRIS_COUNTY_KEY = canonicalCountyKey("Harris");

interface TooltipState {
  countyName: string;
  staffers: string[];
  x: number;
  y: number;
}

interface CountyPickerState {
  countyName: string;
  countyKey: string;
  assignedStafferIds: number[];
  x: number;
  y: number;
  saving: boolean;
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

export function StafferMap({
  staffers,
  districtStaffers,
  allStaffers = [],
  stafferColors,
  canEdit = false,
  onSaveCountyAssignments,
}: {
  staffers: StafferMapEntry[];
  districtStaffers: StafferDistrictEntry[];
  allStaffers?: StafferOption[];
  stafferColors?: Record<string, string>;
  canEdit?: boolean;
  onSaveCountyAssignments?: (
    countyName: string,
    stafferIds: number[]
  ) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [countyPicker, setCountyPicker] = useState<CountyPickerState | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [harrisView, setHarrisView] = useState(false);
  const [zoomingHarris, setZoomingHarris] = useState(false);

  const legendStaffers = useMemo(
    () => mergeStaffersForLegend(staffers, districtStaffers),
    [staffers, districtStaffers]
  );

  const colorByName = useMemo(() => {
    const names = new Set<string>();
    for (const staffer of legendStaffers) names.add(staffer.name);
    for (const staffer of harrisDistrictStaffersForMap(districtStaffers)) names.add(staffer.name);
    const overrides = buildStafferColorOverrideMap(stafferColors, staffers, districtStaffers);
    return buildStafferColorMap([...names], overrides);
  }, [legendStaffers, staffers, districtStaffers, stafferColors]);

  const stafferOptions = useMemo(() => (Array.isArray(allStaffers) ? allStaffers : []), [allStaffers]);

  const pickerColorByName = useMemo(() => {
    const names = new Set<string>();
    for (const staffer of stafferOptions) names.add(staffer.name);
    for (const staffer of legendStaffers) names.add(staffer.name);
    for (const staffer of harrisDistrictStaffersForMap(districtStaffers)) names.add(staffer.name);
    const overrides = {
      ...(stafferColors ?? {}),
      ...Object.fromEntries(
        stafferOptions
          .filter((staffer) => staffer.map_color)
          .map((staffer) => [staffer.name, staffer.map_color as string])
      ),
    };
    return buildStafferColorMap([...names], overrides);
  }, [stafferOptions, legendStaffers, districtStaffers, stafferColors]);

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

  const stafferIdsByCountyKey = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const staffer of staffers) {
      for (const county of staffer.counties) {
        const key = canonicalCountyKey(county);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(staffer.id);
      }
    }
    for (const ids of map.values()) {
      ids.sort((a, b) => a - b);
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

  const countyCentroids = useMemo(
    () => computeCountyCentroids(texasPaths.counties as Record<string, { path: string }>, texasPaths.viewBox),
    []
  );

  const assignedCount = useMemo(() => {
    let count = 0;
    for (const [, entry] of pathEntries) {
      if (staffersByCountyKey.has(canonicalCountyKey(entry.name))) count += 1;
    }
    return count;
  }, [pathEntries, staffersByCountyKey]);

  const sortedAllStaffers = useMemo(
    () => [...stafferOptions].sort((a, b) => a.name.localeCompare(b.name)),
    [stafferOptions]
  );

  useEffect(() => {
    if (!countyPicker) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target)) return;
      setCountyPicker(null);
    }
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [countyPicker]);

  function showTooltip(e: React.MouseEvent, countyName: string, stafferNames: string[]) {
    if (countyPicker) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      countyName,
      staffers: stafferNames,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }

  function openCountyPicker(
    e: React.MouseEvent,
    countyName: string,
    countyKey: string
  ) {
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip(null);
    setCountyPicker({
      countyName,
      countyKey,
      assignedStafferIds: [...(stafferIdsByCountyKey.get(countyKey) ?? [])],
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      saving: false,
    });
  }

  useEffect(() => {
    if (!zoomingHarris) return;
    const timer = window.setTimeout(() => {
      setZoomingHarris(false);
      setHarrisView(true);
    }, 360);
    return () => window.clearTimeout(timer);
  }, [zoomingHarris]);

  function handleCountyClick(
    e: React.MouseEvent,
    countyName: string,
    countyKey: string
  ) {
    if (countyKey === HARRIS_COUNTY_KEY) {
      e.stopPropagation();
      setCountyPicker(null);
      setTooltip(null);
      setZoomingHarris(true);
      return;
    }
    openCountyPicker(e, countyName, countyKey);
  }

  function closeHarrisView() {
    setHarrisView(false);
    setZoomingHarris(false);
  }

  async function toggleStafferAssignment(stafferId: number) {
    if (!canEdit || !countyPicker || !onSaveCountyAssignments || countyPicker.saving) return;

    const previousIds = countyPicker.assignedStafferIds;
    const nextIds = previousIds.includes(stafferId)
      ? previousIds.filter((id) => id !== stafferId)
      : [...previousIds, stafferId].sort((a, b) => a - b);

    setCountyPicker((prev) =>
      prev ? { ...prev, assignedStafferIds: nextIds, saving: true } : prev
    );

    try {
      await onSaveCountyAssignments(countyPicker.countyName, nextIds);
      setCountyPicker((prev) => (prev ? { ...prev, saving: false } : prev));
    } catch (err) {
      setCountyPicker((prev) =>
        prev ? { ...prev, assignedStafferIds: previousIds, saving: false } : prev
      );
      window.alert(err instanceof Error ? err.message : "Failed to save county assignment");
    }
  }

  function countyFill(stafferNames: string[]) {
    if (stafferNames.length === 1) {
      return colorByName.get(stafferNames[0]) ?? STAFFER_MAP_UNASSIGNED;
    }
    if (stafferNames.length > 1) {
      return `url(#staffer-pattern-${patternKey(stafferNames).replace(/[^a-z0-9|]+/gi, "-")})`;
    }
    return STAFFER_MAP_UNASSIGNED;
  }

  async function handleExportPdf() {
    const svg = svgRef.current;
    if (!svg || exportingPdf) return;
    setCountyPicker(null);
    setTooltip(null);
    setExportingPdf(true);
    try {
      const { exportStafferMapPdf } = await import("../lib/stafferMapPdf");
      await exportStafferMapPdf({
        staffers,
        districtStaffers,
        stafferColors,
        svg,
        assignedCount,
        totalCounties: pathEntries.length,
        colorByName,
      });
    } catch (err) {
      console.error("Staffer map PDF export failed:", err);
      window.alert(err instanceof Error ? err.message : "Failed to create PDF");
    } finally {
      setExportingPdf(false);
    }
  }

  if (harrisView) {
    return (
      <div className="staffer-map-wrap">
        <header className="staffer-map-header">
          <h2 className="staffer-map-title">Harris County house districts</h2>
          <p className="staffer-map-subtitle">
            Texas House seats in Harris County, colored by assigned TGA staffer
          </p>
        </header>
        <HarrisDistrictMap
          districtStaffers={districtStaffers}
          colorByName={colorByName}
          onBack={closeHarrisView}
        />
      </div>
    );
  }

  const activeViewBox = zoomingHarris ? harrisPaths.countyViewBox : texasPaths.viewBox;

  return (
    <div className="staffer-map-wrap">
      <header className="staffer-map-header">
        <div className="staffer-map-header-row">
          <div>
            <h2 className="staffer-map-title">TGA staffer territories</h2>
            <p className="staffer-map-subtitle">
              {assignedCount} of {pathEntries.length} counties assigned · county-based staffers only
              {canEdit
                ? " · click a county to assign staffers"
                : " · click a county to view assignments"}
              · click Harris for house districts
            </p>
          </div>
          <button
            type="button"
            className="filter-chip staffer-map-pdf-btn"
            onClick={() => void handleExportPdf()}
            disabled={exportingPdf || zoomingHarris}
          >
            {exportingPdf ? "Creating PDF…" : "Download PDF"}
          </button>
        </div>
      </header>

      <div className="staffer-map-legend" aria-label="Staffer legend">
        {legendStaffers.map((staffer) => {
          const color = colorByName.get(staffer.name) ?? STAFFER_MAP_UNASSIGNED;
          return (
            <span key={`${staffer.id}-${staffer.name}`} className="staffer-map-legend-item">
              <span className="staffer-map-legend-swatch" style={{ background: color }} />
              {staffer.name}
            </span>
          );
        })}
        <span className="staffer-map-legend-item">
          <span className="staffer-map-legend-swatch" style={{ background: STAFFER_MAP_UNASSIGNED }} />
          Unassigned
        </span>
      </div>

      <div className={`staffer-map-canvas county-heatmap${zoomingHarris ? " staffer-map-canvas-zooming" : ""}`} ref={containerRef}>
        <svg
          ref={svgRef}
          viewBox={activeViewBox}
          className={`county-heatmap-svg staffer-map-svg${zoomingHarris ? " staffer-map-svg-zooming" : ""}`}
          role="img"
          aria-label="Texas TGA staffer map"
        >
          <defs>
            {overlapPairs.map(([key, names]) => (
              <CountyPattern
                key={key}
                id={`staffer-pattern-${key.replace(/[^a-z0-9|]+/gi, "-")}`}
                colors={names.map((name) => colorByName.get(name) ?? STAFFER_MAP_UNASSIGNED)}
              />
            ))}
          </defs>
          {pathEntries.map(([fips, entry]) => {
            const key = canonicalCountyKey(entry.name);
            const stafferNames = staffersByCountyKey.get(key) ?? [];
            const fill = countyFill(stafferNames);
            const isPickerTarget = countyPicker?.countyKey === key;

            return (
              <path
                key={fips}
                d={entry.path}
                fill={fill}
                stroke={isPickerTarget ? "#ffffff" : "#1a2332"}
                strokeWidth={isPickerTarget ? 1.2 : 0.5}
                className={`staffer-map-county${key !== HARRIS_COUNTY_KEY ? " staffer-map-county-editable" : ""}${key === HARRIS_COUNTY_KEY ? " staffer-map-county-harris" : ""}`}
                onMouseEnter={(e) => showTooltip(e, entry.name, stafferNames)}
                onMouseMove={(e) => showTooltip(e, entry.name, stafferNames)}
                onMouseLeave={() => setTooltip(null)}
                onClick={(e) => handleCountyClick(e, entry.name, key)}
              />
            );
          })}
          {pathEntries.map(([fips, entry]) => {
            const centroid = countyCentroids.get(fips);
            if (!centroid) return null;
            const fontSize = countyLabelFontSize(centroid);
            if (!fontSize) return null;
            return (
              <text
                key={`label-${fips}`}
                x={centroid.x}
                y={centroid.y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="staffer-map-county-label"
                fontSize={fontSize}
                pointerEvents="none"
              >
                {entry.name}
              </text>
            );
          })}
        </svg>
        {tooltip && !countyPicker ? (
          <div
            className="county-heatmap-tooltip"
            style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
          >
            <strong>{tooltip.countyName}</strong>
            {tooltip.countyName === "Harris" ? (
              <div className="staffer-map-tooltip-hint">Click to view house districts</div>
            ) : (
              <div className="staffer-map-tooltip-hint">Click to view staffer assignments</div>
            )}
            {tooltip.staffers.length ? (
              <div>{tooltip.staffers.join(", ")}</div>
            ) : (
              <div className="staffer-map-tooltip-empty">No staffer assigned</div>
            )}
          </div>
        ) : null}
        {countyPicker ? (
          <div
            ref={pickerRef}
            className="staffer-map-assign-picker"
            style={{ left: countyPicker.x + 12, top: countyPicker.y + 12 }}
            role="dialog"
            aria-label={`Assign staffers to ${countyPicker.countyName}`}
          >
            <strong>{countyPicker.countyName}</strong>
            <p className="staffer-map-assign-picker-hint">
              {countyPicker.saving
                ? "Saving…"
                : canEdit
                  ? "Assign staffers to this county"
                  : "Staff edit or admin login required to edit"}
            </p>
            <div className="staffer-map-assign-options">
              {sortedAllStaffers.map((staffer) => {
                const checked = countyPicker.assignedStafferIds.includes(staffer.id);
                const color = pickerColorByName.get(staffer.name) ?? STAFFER_MAP_UNASSIGNED;
                return (
                  <label
                    key={staffer.id}
                    className={`staffer-map-assign-option${checked ? " staffer-map-assign-option-checked" : ""}${canEdit ? "" : " staffer-map-assign-option-readonly"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canEdit || countyPicker.saving}
                      onChange={() => void toggleStafferAssignment(staffer.id)}
                    />
                    <span className="staffer-map-legend-swatch" style={{ background: color }} />
                    <span>{staffer.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
