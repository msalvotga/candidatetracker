import { getDb, closeDb, initDb } from "./db.mjs";
import { ensureBootstrapAdmin } from "./lib/bootstrapAdmin.mjs";

await initDb();
const db = getDb();
const result = await ensureBootstrapAdmin(db);

if (result.created) {
  console.log(`Created bootstrap admin: ${result.email}`);
} else if (result.skipped) {
  console.log("Skipped — set AUTH_BOOTSTRAP_ADMIN_PASSWORD to create the admin account.");
} else {
  console.log(`Admin already exists: ${result.email}`);
}

await closeDb();
