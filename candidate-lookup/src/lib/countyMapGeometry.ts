/** Approximate label anchor from an SVG path bounding box. */
export function computeCountyCentroids(
  counties: Record<string, { path: string }>,
  viewBox: string
): Map<string, { x: number; y: number; width: number; height: number }> {
  const map = new Map<string, { x: number; y: number; width: number; height: number }>();
  if (typeof document === "undefined") return map;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", "920");
  svg.setAttribute("height", "860");
  svg.style.position = "absolute";
  svg.style.visibility = "hidden";
  svg.style.pointerEvents = "none";
  document.body.appendChild(svg);

  try {
    for (const [fips, entry] of Object.entries(counties)) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", entry.path);
      svg.appendChild(path);
      const box = path.getBBox();
      map.set(fips, {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        width: box.width,
        height: box.height,
      });
      svg.removeChild(path);
    }
  } finally {
    document.body.removeChild(svg);
  }

  return map;
}

interface LabelPoint {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Label anchors for districts clipped to a county outline.
 * House district paths span the whole state; only the county intersection is visible.
 */
export function computeClippedDistrictLabelPoints(
  districts: Record<string, { path: string }>,
  countyPath: string,
  viewBox: string,
  gridStep = 1.1
): Map<string, LabelPoint> {
  const map = new Map<string, LabelPoint>();
  if (typeof document === "undefined") return map;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", "920");
  svg.setAttribute("height", "860");
  svg.style.position = "absolute";
  svg.style.visibility = "hidden";
  svg.style.pointerEvents = "none";
  document.body.appendChild(svg);

  const county = document.createElementNS("http://www.w3.org/2000/svg", "path");
  county.setAttribute("d", countyPath);
  svg.appendChild(county);
  const countyBox = county.getBBox();

  const districtPaths = new Map<string, SVGPathElement>();
  for (const [key, entry] of Object.entries(districts)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", entry.path);
    svg.appendChild(path);
    districtPaths.set(key, path);
  }

  const samples = new Map<string, Array<{ x: number; y: number }>>();
  for (const key of districtPaths.keys()) {
    samples.set(key, []);
  }

  const point = svg.createSVGPoint();

  try {
    for (let y = countyBox.y; y <= countyBox.y + countyBox.height; y += gridStep) {
      for (let x = countyBox.x; x <= countyBox.x + countyBox.width; x += gridStep) {
        point.x = x;
        point.y = y;
        if (!county.isPointInFill(point)) continue;

        for (const [key, path] of districtPaths) {
          if (!path.isPointInFill(point)) continue;
          samples.get(key)!.push({ x, y });
        }
      }
    }

    for (const [key, pts] of samples) {
      if (!pts.length) continue;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let sumX = 0;
      let sumY = 0;

      for (const pt of pts) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
        sumX += pt.x;
        sumY += pt.y;
      }

      map.set(key, {
        x: sumX / pts.length,
        y: sumY / pts.length,
        width: maxX - minX + gridStep,
        height: maxY - minY + gridStep,
      });
    }
  } finally {
    document.body.removeChild(svg);
  }

  return map;
}

export function countyLabelFontSize(centroid: { width: number; height: number }) {
  const minDim = Math.min(centroid.width, centroid.height);
  if (minDim < 8) return 0;
  if (minDim < 14) return 4;
  if (minDim < 24) return 5;
  return 6;
}

/** Label size for zoomed house-district maps (viewBox ~80 units, not full-state ~920). */
export function houseDistrictLabelFontSize(centroid: { width: number; height: number }) {
  const minDim = Math.min(centroid.width, centroid.height);
  if (minDim < 1.2) return 0;
  return Math.min(2.4, Math.max(1, minDim * 0.16));
}
