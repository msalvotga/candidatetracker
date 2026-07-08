/**
 * Build Harris County Texas House district SVG paths in the same projection as texasCountyPaths.json.
 * Run: node server/scripts/gen-harris-hd-paths.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COUNTY_GEOJSON_URL =
  "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
const HD_QUERY_URL =
  "https://gis.lja.com/arcgis/rest/services/AWBD/TLC_Congressional_Senate_House/FeatureServer/0/query?where=DISTRICT%3E%3D126+AND+DISTRICT%3C%3D150&outFields=DISTRICT&f=geojson&outSR=4326";

const WIDTH = 920;
const HEIGHT = 860;
const PAD = 18;
const HARRIS_FIPS = "201";

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

function pathBBox(path) {
  const nums = path.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

const [countyRes, hdRes] = await Promise.all([fetch(COUNTY_GEOJSON_URL), fetch(HD_QUERY_URL)]);
if (!countyRes.ok) throw new Error(`County GeoJSON fetch failed: ${countyRes.status}`);
if (!hdRes.ok) throw new Error(`HD GeoJSON fetch failed: ${hdRes.status}`);

const countyGeo = await countyRes.json();
const hdGeo = await hdRes.json();
const txFeatures = countyGeo.features.filter((f) => String(f.id ?? "").startsWith("48"));

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

const harrisFeature = txFeatures.find((f) => String(f.properties?.COUNTY ?? "").padStart(3, "0") === HARRIS_FIPS);
if (!harrisFeature) throw new Error("Harris county feature not found");

const harrisPath = featureToPath(harrisFeature, project);
const harrisBBox = pathBBox(harrisPath);

/** @type {Record<string, { district: number; path: string }>} */
const districts = {};
for (const feature of hdGeo.features ?? []) {
  const district = Number(feature.properties?.DISTRICT);
  if (!Number.isInteger(district)) continue;
  districts[String(district)] = {
    district,
    path: featureToPath(feature, project),
  };
}

const out = {
  county: "Harris",
  countyFips: HARRIS_FIPS,
  countyPath: harrisPath,
  countyViewBox: [
    harrisBBox.minX - 4,
    harrisBBox.minY - 4,
    harrisBBox.width + 8,
    harrisBBox.height + 8,
  ].join(" "),
  stateViewBox: `0 0 ${WIDTH} ${HEIGHT}`,
  districts,
};

const outPath = path.join(__dirname, "../../src/data/harrisHouseDistrictPaths.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
console.log(`Wrote ${outPath} (${Object.keys(districts).length} districts)`);
