import { spawn } from "node:child_process";
import { startPollingSchedule } from "./pollingSchedule.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const snapshotPath = path.join(root, "polling", "data", "public_snapshot.json");
const pythonInstaller = path.join(root, "scripts", "ensure-polling-python.mjs");

function runCommand(command, args, env, cwd = root, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `${command} exited ${code}`));
      else resolve(stdout);
    });
  });
}

function pollingEnv() {
  const env = {
    ...process.env,
    PYTHONPATH: path.join(root, "polling", "src"),
    POLLING_SCHEDULER: "0",
  };
  // The live service has no copy of the local sqlite file. On Render only,
  // keep that service's archive in its own Postgres schema. Local development
  // does not set RENDER, so it keeps using polling/data/txpoll.sqlite.
  if (env.RENDER === "true" && !env.POLLING_DATABASE_URL) {
    const url = String(env.DATABASE_URL || "").trim();
    if (url.startsWith("postgres")) env.POLLING_DATABASE_URL = url;
  }
  return env;
}

let pythonBin = null;

async function resolvePython(env) {
  if (pythonBin) return pythonBin;
  let lastError = null;
  for (const bin of ["python", "python3"]) {
    try {
      await runCommand(bin, ["--version"], env);
      pythonBin = bin;
      return bin;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Python is not installed on the API service.");
}

function runTxpoll(args, stdin = "") {
  const env = pollingEnv();
  return runCommand(process.execPath, [pythonInstaller], env).then(() =>
    resolvePython(env).then((bin) => runCommand(bin, ["-m", "txpoll.cli", ...args], env, path.join(root, "polling"), stdin)),
  );
}

let ready = null;

function ensurePolling() {
  if (!ready) {
    ready = runTxpoll(["ensure"]).catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

function sendSnapshot(res) {
  res.setHeader("Cache-Control", "no-store");
  res.type("json");
  res.send(fs.readFileSync(snapshotPath));
}

let scheduleStarted = false;

async function runScheduledPull() {
  await ensurePolling();
  const output = await runTxpoll(["pull"]);
  return JSON.parse(output);
}

export function registerPollingRoutes(app) {
  void ensurePolling().catch((error) => {
    console.error("Polling archive did not initialize:", error?.message || error);
  });
  if (!scheduleStarted) {
    scheduleStarted = true;
    startPollingSchedule(runScheduledPull);
  }

  app.get("/api/polling/state", async (_req, res) => {
    try {
      if (fs.existsSync(snapshotPath)) {
        void ensurePolling().catch((error) => {
          console.error("Polling archive did not initialize:", error?.message || error);
        });
        sendSnapshot(res);
        return;
      }
      await ensurePolling();
      if (!fs.existsSync(snapshotPath)) await runTxpoll(["init"]);
      sendSnapshot(res);
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/settings", async (req, res) => {
    try {
      await ensurePolling();
      await runTxpoll(["settings"], JSON.stringify(req.body ?? {}));
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/settings/reset", async (_req, res) => {
    try {
      await ensurePolling();
      await runTxpoll(["reset-settings"]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/polls/:id/approval", async (req, res) => {
    try {
      await ensurePolling();
      await runTxpoll(["approve", "--id", String(req.params.id), "--approved", req.body?.approved ? "yes" : "no"]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/polls/:id/exclusion", async (req, res) => {
    try {
      await ensurePolling();
      if (req.body?.excluded) {
        await runTxpoll(["exclude", "--id", String(req.params.id), "--reason", String(req.body.reason || "")]);
      } else {
        await runTxpoll(["include", "--id", String(req.params.id)]);
      }
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/merge", async (req, res) => {
    try {
      await ensurePolling();
      await runTxpoll(["merge", "--keep", String(req.body.keepId), "--drop", String(req.body.dropId)]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/polls/:id/unmerge", async (req, res) => {
    try {
      await ensurePolling();
      await runTxpoll(["unmerge", "--id", String(req.params.id)]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/manual", async (req, res) => {
    try {
      await ensurePolling();
      await runTxpoll(["manual"], JSON.stringify(req.body ?? {}));
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/pull", async (_req, res) => {
    try {
      await ensurePolling();
      const output = await runTxpoll(["pull"]);
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      snapshot.pull = JSON.parse(output);
      res.setHeader("Cache-Control", "no-store");
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/discover", async (_req, res) => {
    try {
      await ensurePolling();
      const output = await runTxpoll(["discover"]);
      res.json({ log: output, snapshotReady: fs.existsSync(snapshotPath) });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/export", async (_req, res) => {
    try {
      await ensurePolling();
      const output = await runTxpoll(["export"]);
      res.type("json").send(output);
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });
}
