import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const snapshotPath = path.join(root, "polling", "data", "public_snapshot.json");

function runTxpoll(args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-m", "txpoll.cli", ...args], {
      cwd: path.join(root, "polling"),
      env: {
        ...process.env,
        PYTHONPATH: path.join(root, "polling", "src"),
        POLLING_SCHEDULER: "0",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(stdin);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `txpoll exited ${code}`));
      else resolve(stdout);
    });
  });
}

function sendSnapshot(res) {
  res.setHeader("Cache-Control", "no-store");
  res.type("json");
  res.send(fs.readFileSync(snapshotPath));
}

export function registerPollingRoutes(app) {
  app.get("/api/polling/state", async (_req, res) => {
    try {
      if (!fs.existsSync(snapshotPath)) await runTxpoll(["init"]);
      sendSnapshot(res);
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/settings", async (req, res) => {
    try {
      await runTxpoll(["settings"], JSON.stringify(req.body ?? {}));
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/settings/reset", async (_req, res) => {
    try {
      await runTxpoll(["reset-settings"]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/polls/:id/approval", async (req, res) => {
    try {
      await runTxpoll(["approve", "--id", String(req.params.id), "--approved", req.body?.approved ? "yes" : "no"]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/polls/:id/exclusion", async (req, res) => {
    try {
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
      await runTxpoll(["merge", "--keep", String(req.body.keepId), "--drop", String(req.body.dropId)]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/polls/:id/unmerge", async (req, res) => {
    try {
      await runTxpoll(["unmerge", "--id", String(req.params.id)]);
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/manual", async (req, res) => {
    try {
      await runTxpoll(["manual"], JSON.stringify(req.body ?? {}));
      sendSnapshot(res);
    } catch (error) {
      res.status(400).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/discover", async (_req, res) => {
    try {
      const output = await runTxpoll(["discover"]);
      res.json({ log: output, snapshotReady: fs.existsSync(snapshotPath) });
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/polling/export", async (_req, res) => {
    try {
      const output = await runTxpoll(["export"]);
      res.type("json").send(output);
    } catch (error) {
      res.status(500).json({ error: String(error?.message || error) });
    }
  });
}
