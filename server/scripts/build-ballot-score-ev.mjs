import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { aggregateBallotFiles } from "../lib/ballotScoreAggregate.mjs";
import { writeRosterDocument } from "../lib/countyRosterDocuments.mjs";
import { lookupStoredInDatabase } from "../lib/ballotLookupStore.mjs";
import { ensureDb } from "../db.mjs";
import {
  BALLOT_EV_DIR,
  datasetPath,
  readEvStatus,
  readUploads,
  statusFilePath,
} from "../lib/ballotScoreEv.mjs";

const LOCK_PATH = path.join(BALLOT_EV_DIR, "rebuild.lock");
const MODEL_PATH = path.join(BALLOT_EV_DIR, "model.json");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  if (filePath === MODEL_PATH) await writeRosterDocument("ballot-ev-model", value);
  if (filePath === statusFilePath()) await writeRosterDocument("ballot-ev-status", value);
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rm(filePath, { force: true });
  await rename(tmp, filePath);
}

async function main() {
  await ensureDb();
  await mkdir(BALLOT_EV_DIR, { recursive: true });
  await writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const uploads = await readUploads();
    const files = {};
    for (const kind of ["lookup", "static2022", "roster2026"]) {
      const filePath = datasetPath(kind);
      files[kind] = (await exists(filePath) || (kind === "lookup" && (await lookupStoredInDatabase()))) ? filePath : null;
    }
    const runningStatus = await readEvStatus();
    const { datasets, model } = await aggregateBallotFiles({
      files,
      uploads,
      onProgress: ({ phase, scanned }) => {
        runningStatus.status = "running";
        runningStatus.phase = phase;
        runningStatus.scanned = scanned;
        runningStatus.error = null;
        runningStatus.updatedAt = new Date().toISOString();
        writeFileSync(statusFilePath(), JSON.stringify(runningStatus));
      },
    });
    await writeJson(MODEL_PATH, model);
    const status = await readEvStatus();
    status.status = "ready";
    status.phase = "ready";
    status.scanned = 0;
    status.error = null;
    status.updatedAt = new Date().toISOString();
    status.datasets = datasets;
    await writeJson(statusFilePath(), status);
  } catch (error) {
    const status = await readEvStatus();
    status.status = "error";
    status.error = error instanceof Error ? error.message : String(error);
    status.updatedAt = new Date().toISOString();
    await writeJson(statusFilePath(), status);
    process.exitCode = 1;
  } finally {
    await rm(LOCK_PATH, { force: true });
  }
}

await main();
