import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { DAY_DEFS } from "./ballotScoreCalendar.mjs";
import { missingColumns, requiredColumns } from "./ballotScoreAggregate.mjs";
import { readRosterDocument, writeRosterDocument } from "./countyRosterDocuments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BALLOT_EV_DIR = path.join(HERE, "../data/ballot-score-ev");
const LOCK_PATH = path.join(BALLOT_EV_DIR, "rebuild.lock");
const STATUS_PATH = path.join(BALLOT_EV_DIR, "status.json");
const UPLOADS_PATH = path.join(BALLOT_EV_DIR, "uploads.json");
const MODEL_PATH = path.join(BALLOT_EV_DIR, "model.json");
const SCRIPT_PATH = path.join(HERE, "../scripts/build-ballot-score-ev.mjs");

export const DATASET_KINDS = ["lookup", "static2022", "roster2026"];

const ROSTER_NOTE =
  "Each 2026 early-voting upload replaces the current roster. The file is treated as the full cumulative list. A VUID is stored once; uploading again does not append a second vote for the same voter.";

function emptyStatus() {
  return {
    status: "idle",
    phase: null,
    scanned: 0,
    error: null,
    updatedAt: null,
    days: DAY_DEFS,
    rosterMode: "replace",
    rosterNote: ROSTER_NOTE,
    datasets: {
      lookup: emptyDataset("lookup"),
      static2022: emptyDataset("static2022"),
      roster2026: emptyDataset("roster2026"),
    },
  };
}

function emptyDataset(kind) {
  return {
    kind,
    fileName: null,
    uploadedAt: null,
    rows: 0,
    uniqueVuids: 0,
    withScore2022: 0,
    withScore2026: 0,
    rejected: 0,
    rejectedSamples: [],
    duplicatesMerged: 0,
    validation: "missing",
    error: null,
    detailColumns: [],
  };
}

async function ensureDir() {
  await mkdir(BALLOT_EV_DIR, { recursive: true });
}

export function datasetPath(kind) {
  return path.join(BALLOT_EV_DIR, `${kind}.csv`);
}

function nextPath(kind) {
  return path.join(BALLOT_EV_DIR, `${kind}.csv.next`);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function promoteQueuedUploads() {
  let promoted = false;
  for (const kind of DATASET_KINDS) {
    const queued = nextPath(kind);
    if (!(await fileExists(queued))) continue;
    const finalPath = datasetPath(kind);
    await rm(finalPath, { force: true });
    await rename(queued, finalPath);
    promoted = true;
  }
  return promoted;
}

function documentKey(filePath) {
  if (filePath === STATUS_PATH) return "ballot-ev-status";
  if (filePath === UPLOADS_PATH) return "ballot-ev-uploads";
  if (filePath === MODEL_PATH) return "ballot-ev-model";
  return null;
}

async function readJson(filePath) {
  const key = documentKey(filePath);
  if (key) {
    const saved = await readRosterDocument(key);
    if (saved) return saved;
  }
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (key) await writeRosterDocument(key, value);
    return value;
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  const key = documentKey(filePath);
  if (key) await writeRosterDocument(key, value);
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rm(filePath, { force: true });
  await rename(tmp, filePath);
}

export async function readUploads() {
  return (await readJson(UPLOADS_PATH)) ?? {};
}

export async function readEvStatus() {
  const status = (await readJson(STATUS_PATH)) ?? emptyStatus();
  const uploads = await readUploads();
  for (const kind of DATASET_KINDS) {
    const dataset = status.datasets?.[kind] ?? emptyDataset(kind);
    if (uploads[kind]) {
      dataset.fileName = uploads[kind].fileName ?? dataset.fileName;
      dataset.uploadedAt = uploads[kind].uploadedAt ?? dataset.uploadedAt;
    }
    status.datasets[kind] = dataset;
  }
  status.days = DAY_DEFS;
  status.rosterMode = "replace";
  status.rosterNote = ROSTER_NOTE;
  return status;
}

function incomingPath(kind) {
  return path.join(BALLOT_EV_DIR, `${kind}.csv.incoming`);
}

let activeRebuild = null;

export async function readEvModel() {
  return readJson(MODEL_PATH);
}

export async function readEvPayload() {
  const [status, model] = await Promise.all([readEvStatus(), readEvModel()]);
  return { ...status, model };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function rebuildBusy() {
  const lock = await readJson(LOCK_PATH);
  if (!lock?.pid) return false;
  if (pidAlive(lock.pid)) return true;
  await rm(LOCK_PATH, { force: true });
  return false;
}

async function readHeaderColumns(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const line = text.split(/\r?\n/, 1)[0] ?? "";
    const [header] = parse(line, { bom: true, relax_column_count: true });
    return header ?? [];
  } finally {
    await handle.close();
  }
}

export async function saveDatasetUpload(kind, filename, req) {
  if (!DATASET_KINDS.includes(kind)) {
    const error = new Error("Unknown ballot score dataset");
    error.statusCode = 400;
    throw error;
  }
  await ensureDir();
  const dest = incomingPath(kind);
  await rm(dest, { force: true });
  await new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    const fail = (error) => {
      out.destroy();
      reject(error);
    };
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("Upload aborted")));
    out.on("error", fail);
    out.on("finish", resolve);
    req.pipe(out);
  });
  const info = await stat(dest);
  if (!info.size) {
    await rm(dest, { force: true });
    const error = new Error("The uploaded file is empty.");
    error.statusCode = 400;
    throw error;
  }
  let header = [];
  try {
    header = await readHeaderColumns(dest);
  } catch {
    await rm(dest, { force: true });
    const error = new Error(`Could not read the CSV header. Required: ${requiredColumns(kind).join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  const probe = Object.fromEntries(header.map((name) => [name, ""]));
  const missing = missingColumns(probe, kind);
  if (missing.length) {
    await rm(dest, { force: true });
    const error = new Error(`Missing columns: ${missing.join(", ")}. Required: ${requiredColumns(kind).join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  const uploads = await readUploads();
  uploads[kind] = {
    fileName: path.basename(String(filename || `${kind}.csv`)),
    uploadedAt: new Date().toISOString(),
  };
  await writeJson(UPLOADS_PATH, uploads);
  if (await rebuildBusy() || activeRebuild) {
    const queued = nextPath(kind);
    await rm(queued, { force: true });
    await rename(dest, queued);
    const status = await readEvStatus();
    status.datasets[kind].fileName = uploads[kind].fileName;
    status.datasets[kind].uploadedAt = uploads[kind].uploadedAt;
    status.datasets[kind].error = "Queued. This file will import when the current pass finishes.";
    await writeJson(STATUS_PATH, status);
    return status;
  }
  const finalPath = datasetPath(kind);
  await rm(finalPath, { force: true });
  await rename(dest, finalPath);
  const status = await readEvStatus();
  status.status = "running";
  status.phase = "starting";
  status.scanned = 0;
  status.error = null;
  status.updatedAt = new Date().toISOString();
  status.datasets[kind].fileName = uploads[kind].fileName;
  status.datasets[kind].uploadedAt = uploads[kind].uploadedAt;
  status.datasets[kind].validation = "valid";
  status.datasets[kind].error = null;
  await writeJson(STATUS_PATH, status);
  await startRebuild();
  return readEvStatus();
}

export async function startRebuild() {
  if (activeRebuild || (await rebuildBusy())) return readEvStatus();
  await ensureDir();
  const status = await readEvStatus();
  status.status = "running";
  status.phase = "starting";
  status.scanned = 0;
  status.error = null;
  status.updatedAt = new Date().toISOString();
  await writeJson(STATUS_PATH, status);
  const child = spawn(process.execPath, ["--max-old-space-size=8192", SCRIPT_PATH], {
    cwd: path.join(HERE, "../.."),
    windowsHide: true,
    stdio: "ignore",
  });
  activeRebuild = child;
  await writeJson(LOCK_PATH, { pid: child.pid, startedAt: new Date().toISOString() });
  child.on("error", async (error) => {
    activeRebuild = null;
    const next = await readEvStatus();
    next.status = "error";
    next.error = error.message;
    next.updatedAt = new Date().toISOString();
    await writeJson(STATUS_PATH, next);
  });
  child.on("exit", async () => {
    activeRebuild = null;
    if (await promoteQueuedUploads()) await startRebuild();
  });
  return readEvStatus();
}

export function modelFilePath() {
  return MODEL_PATH;
}

export function statusFilePath() {
  return STATUS_PATH;
}
