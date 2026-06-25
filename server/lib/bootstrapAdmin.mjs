import { createAppUser, getAppUserByUsername } from "./users.mjs";

export async function ensureBootstrapAdmin(db) {
  const email = (process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL || "msalvo@gregabbott.com").trim().toLowerCase();
  const password = process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD?.trim();
  if (!password) return { created: false, skipped: true, reason: "AUTH_BOOTSTRAP_ADMIN_PASSWORD not set" };

  const existing = await getAppUserByUsername(db, email);
  if (existing) return { created: false, email, reason: "already exists" };

  await createAppUser(db, {
    username: email,
    display_name: email,
    role: "admin",
    password,
    active: true,
  });

  return { created: true, email };
}
