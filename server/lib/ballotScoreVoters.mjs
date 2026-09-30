import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";

/** Statewide voter extract. Override with BALLOT_VOTER_FILE. */
export const BALLOT_VOTER_FILE =
  process.env.BALLOT_VOTER_FILE?.trim() || "C:\\Users\\TGAData\\Documents\\fulldata1.csv";

const exportDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "voter-exports");

/** @type {Map<string, { status: string, file: string | null, scanned: number, written: number, bytes: number, error: string | null }>} */
const jobs = new Map();

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function jobKey(countyKey) {
  const raw = String(countyKey ?? "").trim();
  if (!raw || raw.toLowerCase() === "all") return "all";
  return raw.toUpperCase();
}

export function exportFileName(countyKey) {
  const key = jobKey(countyKey);
  const slug = key === "all" ? "all-counties" : key.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `voters-${slug}.csv`;
}

export function publicExportJob(job) {
  if (!job) return { status: "idle", scanned: 0, written: 0, bytes: 0, error: null };
  return {
    status: job.status,
    scanned: job.scanned,
    written: job.written,
    bytes: job.bytes,
    error: job.error,
  };
}

export function getVoterExport(countyKey) {
  return jobs.get(jobKey(countyKey)) ?? null;
}

export function startVoterExport(countyKey) {
  const key = jobKey(countyKey);
  const existing = jobs.get(key);
  if (existing && (existing.status === "running" || existing.status === "ready")) return existing;

  if (!fs.existsSync(BALLOT_VOTER_FILE)) {
    const missing = {
      status: "error",
      file: null,
      scanned: 0,
      written: 0,
      bytes: 0,
      error: `Voter file not found: ${BALLOT_VOTER_FILE}`,
    };
    jobs.set(key, missing);
    return missing;
  }

  if (key === "all") {
    const ready = {
      status: "ready",
      file: BALLOT_VOTER_FILE,
      scanned: 0,
      written: 0,
      bytes: fs.statSync(BALLOT_VOTER_FILE).size,
      error: null,
    };
    jobs.set(key, ready);
    return ready;
  }

  const file = path.join(exportDir, exportFileName(key));
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const ready = {
      status: "ready",
      file,
      scanned: 0,
      written: 0,
      bytes: fs.statSync(file).size,
      error: null,
    };
    jobs.set(key, ready);
    return ready;
  }

  const job = {
    status: "running",
    file,
    scanned: 0,
    written: 0,
    bytes: 0,
    error: null,
  };
  jobs.set(key, job);
  void runCountyExport(key, job);
  return job;
}

async function runCountyExport(county, job) {
  await fs.promises.mkdir(exportDir, { recursive: true });
  const tempFile = `${job.file}.partial`;
  const input = fs.createReadStream(BALLOT_VOTER_FILE);
  const output = fs.createWriteStream(tempFile);
  const parser = input.pipe(
    parse({
      columns: true,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
    }),
  );

  let columns = null;
  try {
    for await (const row of parser) {
      job.scanned += 1;
      if (!columns) {
        columns = Object.keys(row);
        if (!output.write(`${columns.join(",")}\n`)) await once(output, "drain");
      }
      if (String(row.CountyName ?? "").trim().toUpperCase() !== county) continue;
      const line = `${columns.map((column) => csvCell(row[column])).join(",")}\n`;
      job.written += 1;
      if (!output.write(line)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
    await fs.promises.rm(job.file, { force: true });
    await fs.promises.rename(tempFile, job.file);
    job.bytes = (await fs.promises.stat(job.file)).size;
    job.status = "ready";
  } catch (error) {
    job.status = "error";
    job.error = String(error?.message || error);
    input.destroy();
    output.destroy();
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
  }
}
