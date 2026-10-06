import "dotenv/config";
import dns from "node:dns";
import { createApiApp } from "./createApiApp.mjs";
import { ensureDb, getDbInfo } from "./db.mjs";

/** Prefer A records — avoids broken IPv6 routes that make Node fetch fail while browsers work (Windows). */
dns.setDefaultResultOrder("ipv4first");

const PORT = Number(process.env.PORT || 3847);

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection", error instanceof Error ? error.message : error);
});

const app = createApiApp();

app.listen(PORT, () => {
  console.log(`Election API http://127.0.0.1:${PORT}`);
  console.log(`  GET  / /health /api/health /api/sources /api/catalog`);
  console.log(`  GET  /api/election?id=civix:53813 | manual:…`);
  console.log(`  GET  /api/compare/preview (stub)`);
  console.log(`  POST /api/manual-elections   DELETE /api/manual-elections/:id`);
});

async function connectDatabase() {
  const started = Date.now();
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await ensureDb();
      console.log(`Database ready in ${((Date.now() - started) / 1000).toFixed(1)}s`, getDbInfo());
      return;
    } catch (error) {
      console.error(
        `Database not ready (attempt ${attempt})`,
        error instanceof Error ? error.message : error,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2_000 * attempt)));
    }
  }
}

void connectDatabase();
