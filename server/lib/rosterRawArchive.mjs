import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getNativePool } from "./pgPool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = path.join(HERE, "../data/county-rosters/raw");

let tableReady = null;

/**
 * Folder name for one pull: local Central Time, `YYYYMMDD_HHMM` (for example `20261005_1109`).
 * @param {Date} [at]
 */
export function rosterPullStamp(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}_${get("hour")}${get("minute")}`;
}

function safeCounty(countyKey) {
  const county = String(countyKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "");
  return county || "unknown";
}

export function rosterRawFileName(fileName, fallback = "roster.bin") {
  let name = "";
  const raw = String(fileName ?? "").trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      name = decodeURIComponent(new URL(raw).pathname.split("/").pop() ?? "");
    } catch {
      name = "";
    }
  } else {
    name = raw.split(/[\\/]/).pop() ?? "";
  }
  name = name.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "");
  return name || fallback;
}

async function database() {
  const pool = getNativePool();
  if (!pool) return null;
  if (!tableReady) {
    tableReady = pool.query(
      `CREATE TABLE IF NOT EXISTS county_roster_raw_files (
         county_key TEXT NOT NULL,
         pulled_stamp TEXT NOT NULL,
         file_name TEXT NOT NULL,
         byte_size INTEGER NOT NULL,
         body BYTEA NOT NULL,
         saved_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
         PRIMARY KEY (county_key, pulled_stamp, file_name)
       )`,
    );
  }
  await tableReady;
  return pool;
}

async function unusedPath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  for (let n = 2; n < 1000; n += 1) {
    const dest = path.join(dir, candidate);
    try {
      await access(dest);
    } catch {
      return dest;
    }
    candidate = `${base}-${n}${ext}`;
  }
  throw new Error(`Could not store ${fileName} without replacing an existing raw file`);
}

/**
 * Keep the original county download. Files are stored by county, then by pull time,
 * and an existing file is never replaced or removed.
 * @param {string} countyKey
 * @param {Date} [at]
 */
export function openRosterRawArchive(countyKey, at = new Date()) {
  const county = safeCounty(countyKey);
  const stamp = rosterPullStamp(at);
  const dir = path.join(RAW_ROOT, county, stamp);
  let dirReady = null;
  return {
    county,
    stamp,
    dir,
    /**
     * @param {string} fileName original name or source URL
     * @param {Buffer | Uint8Array | string} bytes
     */
    async save(fileName, bytes) {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const safeName = rosterRawFileName(fileName);
      if (!dirReady) dirReady = mkdir(dir, { recursive: true });
      await dirReady;
      const dest = await unusedPath(dir, safeName);
      await writeFile(dest, body);
      const pool = await database();
      if (pool) {
        await pool.query(
          `INSERT INTO county_roster_raw_files (county_key, pulled_stamp, file_name, byte_size, body)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (county_key, pulled_stamp, file_name) DO NOTHING`,
          [county, stamp, path.basename(dest), body.length, body],
        );
      }
      return dest;
    },
  };
}
