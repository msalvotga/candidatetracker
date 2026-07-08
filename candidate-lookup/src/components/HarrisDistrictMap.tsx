import { useMemo, useRef, useState } from "react";

import harrisPaths from "../data/harrisHouseDistrictPaths.json";

import { computeClippedDistrictLabelPoints, houseDistrictLabelFontSize } from "../lib/countyMapGeometry";

import {

  harrisDistrictStaffersForMap,

  staffersByHouseDistrict,

} from "../lib/harrisDistrictStaffers";

import { splitLabel, STAFFER_MAP_UNASSIGNED } from "../lib/stafferColors";

import type { StafferDistrictEntry } from "../types";



interface TooltipState {

  district: number;

  staffers: string[];

  x: number;

  y: number;

}



function patternKey(stafferNames: string[]) {

  return stafferNames.join("|");

}



function DistrictPattern({ id, colors }: { id: string; colors: string[] }) {

  const stripe = 12 / colors.length;

  return (

    <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">

      {colors.map((color, index) => (

        <rect key={index} x={index * stripe} y={0} width={stripe} height="12" fill={color} />

      ))}

    </pattern>

  );

}



export function HarrisDistrictMap({

  districtStaffers,

  colorByName,

  onBack,

}: {

  districtStaffers: StafferDistrictEntry[];

  colorByName: Map<string, string>;

  onBack: () => void;

}) {

  const containerRef = useRef<HTMLDivElement>(null);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);



  const harrisStafferSource = useMemo(

    () => harrisDistrictStaffersForMap(districtStaffers),

    [districtStaffers]

  );



  const staffersByDistrict = useMemo(

    () => staffersByHouseDistrict(harrisStafferSource),

    [harrisStafferSource]

  );



  const districtEntries = useMemo(

    () =>

      Object.entries(harrisPaths.districts as Record<string, { district: number; path: string }>).sort(

        ([a], [b]) => Number(a) - Number(b)

      ),

    []

  );



  const overlapPairs = useMemo(() => {

    const pairs = new Map<string, string[]>();

    for (const names of staffersByDistrict.values()) {

      if (names.length < 2) continue;

      pairs.set(patternKey(names), names);

    }

    return [...pairs.entries()];

  }, [staffersByDistrict]);



  const districtLabelPoints = useMemo(
    () =>
      computeClippedDistrictLabelPoints(
        Object.fromEntries(districtEntries.map(([key, entry]) => [key, { path: entry.path }])),
        harrisPaths.countyPath,
        harrisPaths.stateViewBox
      ),
    [districtEntries]
  );



  const harrisStaffers = useMemo(() => {

    const names = new Set<string>();

    for (const [districtKey] of districtEntries) {

      for (const name of staffersByDistrict.get(Number(districtKey)) ?? []) {

        names.add(name);

      }

    }

    return [...names].sort((a, b) => a.localeCompare(b));

  }, [districtEntries, staffersByDistrict]);



  const assignedCount = useMemo(() => {
    let count = 0;
    for (const [districtKey] of districtEntries) {
      if ((staffersByDistrict.get(Number(districtKey)) ?? []).length) count += 1;
    }
    return count;
  }, [districtEntries, staffersByDistrict]);

  const harrisLabelFontSize = useMemo(() => {
    const hd133 = districtLabelPoints.get("133");
    if (hd133) return houseDistrictLabelFontSize(hd133);
    return 1.4;
  }, [districtLabelPoints]);



  function districtFill(stafferNames: string[]) {

    if (stafferNames.length === 1) {

      return colorByName.get(stafferNames[0]) ?? STAFFER_MAP_UNASSIGNED;

    }

    if (stafferNames.length > 1) {

      return `url(#harris-staffer-pattern-${patternKey(stafferNames).replace(/[^a-z0-9|]+/gi, "-")})`;

    }

    return STAFFER_MAP_UNASSIGNED;

  }



  function showTooltip(e: React.MouseEvent, district: number, stafferNames: string[]) {

    const rect = containerRef.current?.getBoundingClientRect();

    if (!rect) return;

    setTooltip({

      district,

      staffers: stafferNames,

      x: e.clientX - rect.left,

      y: e.clientY - rect.top,

    });

  }



  return (

    <div className="staffer-map-harris">

      <div className="staffer-map-harris-toolbar">

        <button type="button" className="staffer-map-harris-back" onClick={onBack}>

          ← Back to Texas map

        </button>

        <p className="staffer-map-harris-summary">

          {assignedCount} of {districtEntries.length} Harris County house districts assigned

        </p>

      </div>



      <div className="staffer-map-legend" aria-label="Harris house district staffer legend">

        {harrisStaffers.map((name) => (

          <span key={name} className="staffer-map-legend-item">

            <span className="staffer-map-legend-swatch" style={{ background: colorByName.get(name) ?? STAFFER_MAP_UNASSIGNED }} />

            {name}

          </span>

        ))}

        {overlapPairs.map(([key, names]) => (

          <span key={key} className="staffer-map-legend-item staffer-map-legend-overlap">

            <span

              className="staffer-map-legend-swatch staffer-map-legend-swatch-split"

              style={{

                background: `linear-gradient(135deg, ${colorByName.get(names[0]) ?? STAFFER_MAP_UNASSIGNED} 50%, ${colorByName.get(names[1] ?? names[0]) ?? STAFFER_MAP_UNASSIGNED} 50%)`,

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



      <div className="staffer-map-canvas county-heatmap staffer-map-harris-canvas" ref={containerRef}>

        <svg

          viewBox={harrisPaths.countyViewBox}

          className="county-heatmap-svg staffer-map-svg staffer-map-harris-svg"

          role="img"

          aria-label="Harris County Texas House districts by TGA staffer"

        >

          <defs>

            <clipPath id="harris-county-clip">

              <path d={harrisPaths.countyPath} />

            </clipPath>

            {overlapPairs.map(([key, names]) => (

              <DistrictPattern

                key={key}

                id={`harris-staffer-pattern-${key.replace(/[^a-z0-9|]+/gi, "-")}`}

                colors={names.map((name) => colorByName.get(name) ?? STAFFER_MAP_UNASSIGNED)}

              />

            ))}

          </defs>

          <g clipPath="url(#harris-county-clip)">

            {districtEntries.map(([districtKey, entry]) => {

              const district = Number(districtKey);

              const stafferNames = staffersByDistrict.get(district) ?? [];

              return (

                <path

                  key={districtKey}

                  d={entry.path}

                  fill={districtFill(stafferNames)}
                  stroke="#1a2332"
                  strokeWidth={0.1}
                  className="staffer-map-hd"

                  onMouseEnter={(e) => showTooltip(e, district, stafferNames)}

                  onMouseMove={(e) => showTooltip(e, district, stafferNames)}

                  onMouseLeave={() => setTooltip(null)}

                />

              );

            })}

          </g>

          <path

            d={harrisPaths.countyPath}

            fill="none"

            stroke="#e8edf4"
            strokeWidth={0.5}

            pointerEvents="none"

          />

          {districtEntries.map(([districtKey, entry]) => {

            const labelPoint = districtLabelPoints.get(districtKey);

            if (!labelPoint) return null;

            return (
              <text
                key={`label-${districtKey}`}
                x={labelPoint.x}
                y={labelPoint.y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="staffer-map-county-label staffer-map-hd-label"
                fontSize={harrisLabelFontSize}
                pointerEvents="none"
              >
                {entry.district}
              </text>
            );

          })}

        </svg>

        {tooltip ? (

          <div

            className="county-heatmap-tooltip"

            style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}

          >

            <strong>HD-{String(tooltip.district).padStart(3, "0")}</strong>

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


