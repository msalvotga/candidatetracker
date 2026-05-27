/**
 * Build simplified Texas county SVG paths keyed by 3-digit FIPS (matches texasCounties.ts).
 * Run: node scripts/genTexasCountyPaths.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEOJSON_URL =
  "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";

const WIDTH = 920;
const HEIGHT = 860;
const PAD = 18;

function ringsToPath(rings, project) {
  return rings
    .map((ring) => {
      const pts = ring.map((c) => project(c));
      return (
        pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + " Z"
      );
    })
    .join(" ");
}

function featureToPath(feature, project) {
  const { type, coordinates } = feature.geometry;
  if (type === "Polygon") return ringsToPath(coordinates, project);
  if (type === "MultiPolygon") {
    return coordinates.map((poly) => ringsToPath(poly, project)).join(" ");
  }
  return "";
}

function collectCoords(feature, out) {
  const { type, coordinates } = feature.geometry;
  const polys = type === "Polygon" ? [coordinates] : type === "MultiPolygon" ? coordinates : [];
  for (const poly of polys) {
    for (const ring of poly) {
      for (const c of ring) out.push(c);
    }
  }
}

const res = await fetch(GEOJSON_URL);
if (!res.ok) throw new Error(`GeoJSON fetch failed: ${res.status}`);
const geo = await res.json();
const txFeatures = geo.features.filter((f) => String(f.id ?? "").startsWith("48"));

let minLon = Infinity;
let minLat = Infinity;
let maxLon = -Infinity;
let maxLat = -Infinity;
const coords = [];
for (const f of txFeatures) collectCoords(f, coords);
for (const [lon, lat] of coords) {
  minLon = Math.min(minLon, lon);
  minLat = Math.min(minLat, lat);
  maxLon = Math.max(maxLon, lon);
  maxLat = Math.max(maxLat, lat);
}

function project([lon, lat]) {
  const x = PAD + ((lon - minLon) / (maxLon - minLon)) * (WIDTH - PAD * 2);
  const y = PAD + ((maxLat - lat) / (maxLat - minLat)) * (HEIGHT - PAD * 2);
  return [x, y];
}

/** @type {Record<string, { fips: string; name: string; path: string }>} */
const byFips = {};
for (const f of txFeatures) {
  const fips = String(f.properties?.COUNTY ?? "").padStart(3, "0");
  const name = String(f.properties?.NAME ?? "").trim();
  if (!fips || fips === "000") continue;
  byFips[fips] = { fips, name, path: featureToPath(f, project) };
}

const outPath = path.join(__dirname, "..", "src", "data", "texasCountyPaths.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify({ viewBox: `0 0 ${WIDTH} ${HEIGHT}`, counties: byFips }),
  "utf8",
);
console.error("Wrote", outPath, Object.keys(byFips).length, "counties");
