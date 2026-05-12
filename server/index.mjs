import dns from "node:dns";
import { createApiApp } from "./createApiApp.mjs";

/** Prefer A records — avoids broken IPv6 routes that make Node fetch fail while browsers work (Windows). */
dns.setDefaultResultOrder("ipv4first");

const PORT = Number(process.env.PORT || 3847);
const app = createApiApp();

app.listen(PORT, () => {
  console.log(`Election API http://127.0.0.1:${PORT}`);
  console.log(`  GET  /api/health /api/sources /api/catalog`);
  console.log(`  GET  /api/election?id=civix:53813 | manual:…`);
  console.log(`  GET  /api/compare/preview (stub)`);
  console.log(`  POST /api/manual-elections   DELETE /api/manual-elections/:id`);
});
