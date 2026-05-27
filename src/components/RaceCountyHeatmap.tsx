import { useMemo, useRef, useState } from "react";
import type { RaceInput } from "../types/election";
import texasPaths from "../data/texasCountyPaths.json";
import { TEXAS_COUNTIES } from "../lib/texasCounties";
import {
  buildCountyHeatmapModel,
  countyFillColor,
  countyVotePercent,
  noDataCountyFill,
  type CountyHeatCell,
  type CandidateHeatColor,
} from "../lib/countyHeatmap";
import { formatNumber, formatPercent } from "../lib/voteMath";

const FIPS_TO_KEY = new Map(TEXAS_COUNTIES.map((c) => [c.fips, c.key]));
const KEY_TO_LABEL = new Map(TEXAS_COUNTIES.map((c) => [c.key, c.label.replace(/\s+County$/i, "")]));

const pathByFips = texasPaths.counties as Record<string, { path: string }>;
const ALL_COUNTY_KEYS = TEXAS_COUNTIES.map((c) => c.key);

interface TooltipState {
  countyKey: string;
  x: number;
  y: number;
}

function Legend({ candidates }: { candidates: CandidateHeatColor[] }) {
  const top = candidates.slice(0, 2);
  if (!top.length) return null;
  return (
    <div className="enr-heatmap__legend" aria-hidden>
      {top.map((c) => (
        <div key={c.id} className="enr-heatmap__legendCandidate">
          <span className="enr-heatmap__legendName">{c.name}</span>
          <div className="enr-heatmap__legendSwatches">
            {c.shades.map((color, i) => (
              <span
                key={i}
                className="enr-heatmap__legendSwatch"
                style={{ background: color }}
                title={i === 0 ? "+0%" : i === 1 ? "+10%" : "+20%"}
              />
            ))}
            <span className="enr-heatmap__legendTicks">
              <span>+0%</span>
              <span>+10%</span>
              <span>+20%</span>
            </span>
          </div>
        </div>
      ))}
      <div className="enr-heatmap__legendNoData">
        <span className="enr-heatmap__legendSwatch enr-heatmap__legendSwatch--nodata" />
        <span>No data</span>
      </div>
    </div>
  );
}

function CountyTooltip({
  cell,
  candidates,
  x,
  y,
  containerRef,
}: {
  cell: CountyHeatCell;
  candidates: CandidateHeatColor[];
  x: number;
  y: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ranked = [...candidates].sort(
    (a, b) => (cell.votesByCandidate[b.id] ?? 0) - (cell.votesByCandidate[a.id] ?? 0),
  );

  const rect = containerRef.current?.getBoundingClientRect();
  const tipW = 280;
  const tipH = 40 + ranked.length * 28;
  let left = x + 12;
  let top = y + 12;
  if (rect) {
    if (left + tipW > rect.width - 8) left = x - tipW - 12;
    if (top + tipH > rect.height - 8) top = y - tipH - 12;
    left = Math.max(8, left);
    top = Math.max(8, top);
  }

  return (
    <div className="enr-heatmap__tooltip" style={{ left, top }} role="tooltip">
      <div className="enr-heatmap__tooltipTitle">{cell.displayName}</div>
      {!cell.hasData || cell.totalVotes <= 0 ? (
        <p className="enr-heatmap__tooltipMuted">No results reported yet</p>
      ) : (
        <table className="enr-heatmap__tooltipTable">
          <thead>
            <tr>
              <th>Candidate</th>
              <th className="num">Votes</th>
              <th className="num">%</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((c) => {
              const votes = cell.votesByCandidate[c.id] ?? 0;
              const pct = countyVotePercent(cell, c.id);
              const isLeader = c.id === cell.leaderId;
              return (
                <tr key={c.id} className={isLeader ? "is-leader" : undefined}>
                  <td>
                    <span
                      className="enr-heatmap__tooltipDot"
                      style={{ background: c.base }}
                      aria-hidden
                    />
                    {c.name}
                  </td>
                  <td className="num">{formatNumber(votes)}</td>
                  <td className="num">{formatPercent(pct, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function RaceCountyHeatmap({ race, embedded = false }: { race: RaceInput; embedded?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const model = useMemo(
    () => buildCountyHeatmapModel(race, ALL_COUNTY_KEYS, KEY_TO_LABEL, texasPaths.viewBox),
    [race],
  );

  const fipsPaths = useMemo(() => {
    const out: Array<{ fips: string; countyKey: string; path: string }> = [];
    for (const [fips, entry] of Object.entries(pathByFips)) {
      const countyKey = FIPS_TO_KEY.get(fips);
      if (!countyKey || !entry?.path) continue;
      out.push({ fips, countyKey, path: entry.path });
    }
    return out;
  }, []);

  if (!model) return null;

  function onCountyPointer(countyKey: string, clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      countyKey,
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  }

  function onCountyEnter(countyKey: string, e: React.MouseEvent<SVGPathElement>) {
    onCountyPointer(countyKey, e.clientX, e.clientY);
  }

  function onCountyMove(countyKey: string, e: React.MouseEvent<SVGPathElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip((prev) =>
      prev?.countyKey === countyKey
        ? { countyKey, x: e.clientX - rect.left, y: e.clientY - rect.top }
        : prev,
    );
  }

  function onCountyFocus(countyKey: string, e: React.FocusEvent<SVGPathElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    onCountyPointer(countyKey, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  const hoveredCell = tooltip ? model.byKey.get(tooltip.countyKey) : null;

  return (
    <section className={`enr-heatmap${embedded ? " enr-heatmap--embedded" : ""}`} aria-label={`County map for ${race.title}`}>
      {!embedded ? <h3 className="enr-heatmap__heading">County map</h3> : null}
      <p className="enr-heatmap__hint enr-muted">
        Shading shows which candidate leads each county and the margin vs the runner-up. Gray counties have no
        data or zero votes.
      </p>
      <div className="enr-heatmap__frame" ref={containerRef}>
        <svg
          className="enr-heatmap__svg"
          viewBox={model.viewBox}
          role="img"
          aria-label="Texas county results map"
        >
          {fipsPaths.map(({ fips, countyKey, path }) => {
            const cell = model.byKey.get(countyKey);
            const fill = cell ? countyFillColor(cell, model.candidates) : noDataCountyFill();
            const isHovered = tooltip?.countyKey === countyKey;
            return (
              <path
                key={fips}
                d={path}
                fill={fill}
                stroke={isHovered ? "#fff" : "#1a1d24"}
                strokeWidth={isHovered ? 1.4 : 0.35}
                className="enr-heatmap__county"
                onMouseEnter={(e) => onCountyEnter(countyKey, e)}
                onMouseMove={(e) => onCountyMove(countyKey, e)}
                onMouseLeave={() => setTooltip(null)}
                onFocus={(e) => onCountyFocus(countyKey, e)}
                onBlur={() => setTooltip(null)}
                tabIndex={0}
                aria-label={`${KEY_TO_LABEL.get(countyKey) ?? countyKey} county`}
              />
            );
          })}
        </svg>
        {tooltip && hoveredCell ? (
          <CountyTooltip
            cell={hoveredCell}
            candidates={model.candidates}
            x={tooltip.x}
            y={tooltip.y}
            containerRef={containerRef}
          />
        ) : null}
      </div>
      <Legend candidates={model.candidates} />
    </section>
  );
}
