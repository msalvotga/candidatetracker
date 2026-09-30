/**
 * Build simplified statewide district SVG paths for the ballot-score maps.
 * Writes src/data/txDistrictPaths.json. Safe to re-run.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/data/txDistrictPaths.json");
const SERVICE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer";

const WANTED = [
  { group: "congress", match: /congressional districts$/i, idField: ["BASENAME", "GEOID"] },
  { group: "senate", match: /state legislative districts.*upper/i, idField: ["SLDU", "BASENAME", "GEOID"] },
  { group: "house", match: /state legislative districts.*lower/i, idField: ["SLDL", "BASENAME", "GEOID"] },
];

function project(lon, lat, bounds) {
  const x = ((lon - bounds.minX) / (bounds.maxX - bounds.minX)) * 900 + 10;
  const y = ((bounds.maxY - lat) / (bounds.maxY - bounds.minY)) * 840 + 10;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

function ringPath(ring, bounds) {
  let d = "";
  const step = Math.max(1, Math.ceil(ring.length / 180));
  for (let i = 0; i < ring.length; i += step) {
    const [x, y] = project(ring[i][0], ring[i][1], bounds);
    d += `${i === 0 ? "M" : "L"}${x},${y} `;
  }
  const last = ring[ring.length - 1];
  const [x, y] = project(last[0], last[1], bounds);
  d += `L${x},${y} Z`;
  return d;
}

function geometryPath(geometry, bounds) {
  if (!geometry) return "";
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.map((polygon) => polygon.map((ring) => ringPath(ring, bounds)).join(" ")).join(" ");
}

function districtKey(props, fields) {
  for (const field of fields) {
    const raw = props?.[field];
    if (raw == null || raw === "") continue;
    const text = String(raw).trim();
    const fromEnd = text.match(/(\d+)$/);
    const n = Number(fromEnd ? fromEnd[1] : text);
    if (Number.isFinite(n) && n > 0 && n < 500) return String(n);
  }
  return null;
}

function boundsOf(features) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (lon, lat) => {
    if (lon < minX) minX = lon;
    if (lat < minY) minY = lat;
    if (lon > maxX) maxX = lon;
    if (lat > maxY) maxY = lat;
  };
  for (const feature of features) {
    const geometry = feature.geometry;
    const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const pair of ring) visit(pair[0], pair[1]);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

async function queryLayer(id) {
  const features = [];
  let offset = 0;
  for (;;) {
    const url = new URL(`${SERVICE}/${id}/query`);
    url.searchParams.set("where", "STATE='48'");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("geometryPrecision", "3");
    url.searchParams.set("maxAllowableOffset", "0.08");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("f", "geojson");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", "40");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Layer ${id} query failed (${response.status})`);
    const body = await response.json();
    const page = body.features ?? [];
    features.push(...page);
    if (!body.exceededTransferLimit && page.length < 40) break;
    if (!page.length) break;
    offset += page.length;
    if (offset > 400) break;
  }
  return features;
}

async function main() {
  const catalog = await fetch(`${SERVICE}?f=pjson`).then((response) => response.json());
  const layers = catalog.layers ?? [];
  const out = { viewBox: "0 0 920 860", house: {}, senate: {}, congress: {} };
  for (const wanted of WANTED) {
    const layer = layers.find((item) => wanted.match.test(item.name ?? ""));
    if (!layer) {
      console.log("missing layer", wanted.group, layers.map((item) => item.name));
      continue;
    }
    console.log("fetch", wanted.group, layer.id, layer.name);
    const features = await queryLayer(layer.id);
    console.log(" features", features.length);
    if (!features.length) continue;
    const bounds = boundsOf(features);
    for (const feature of features) {
      const key = districtKey(feature.properties, wanted.idField);
      if (!key) continue;
      const d = geometryPath(feature.geometry, bounds);
      if (d) out[wanted.group][key] = d;
    }
    console.log(" paths", Object.keys(out[wanted.group]).length);
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log("wrote", OUT);
}

await main();
