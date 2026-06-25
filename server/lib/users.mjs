import { hashPassword } from "./password.mjs";

export const USER_ROLES = new Set(["admin", "viewer"]);

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function publicUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: row.active === 1 || row.active === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listAppUsers(db) {
  const rows = await db
    .prepare(
      `SELECT id, username, display_name, role, active, created_at, updated_at
       FROM app_users
       ORDER BY username COLLATE NOCASE`
    )
    .all();
  return rows.map(publicUserRow);
}

export async function getAppUserById(db, userId) {
  const row = await db
    .prepare(
      `SELECT id, username, display_name, role, active, created_at, updated_at
       FROM app_users WHERE id = ?`
    )
    .get(userId);
  return publicUserRow(row);
}

export async function getAppUserByUsername(db, username) {
  const row = await db
    .prepare(`SELECT * FROM app_users WHERE LOWER(username) = LOWER(?)`)
    .get(normalizeUsername(username));
  return row ?? null;
}

export async function createAppUser(db, { username, display_name, role, password, active = true }) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) throw new Error("username is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedUsername)) {
    throw new Error("username must be a valid email address");
  }
  if (!USER_ROLES.has(role)) throw new Error("invalid role");
  if (!password || String(password).length < 8) {
    throw new Error("password must be at least 8 characters");
  }

  const name = String(display_name ?? username).trim() || normalizedUsername;
  const passwordHash = hashPassword(password);

  const result = await db
    .prepare(
      `INSERT INTO app_users (username, display_name, role, password_hash, active)
       VALUES (@username, @display_name, @role, @password_hash, @active)
       RETURNING id`
    )
    .run({
      username: normalizedUsername,
      display_name: name,
      role,
      password_hash: passwordHash,
      active: active ? 1 : 0,
    });

  return getAppUserById(db, result.lastInsertRowid);
}

export async function updateAppUser(db, userId, fields) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) throw new Error("invalid user id");

  const existing = await db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(id);
  if (!existing) throw new Error("user not found");

  const setParts = [];
  const params = { id };

  if (fields.display_name != null) {
    const name = String(fields.display_name).trim();
    if (!name) throw new Error("display_name cannot be empty");
    setParts.push("display_name = @display_name");
    params.display_name = name;
  }

  if (fields.role != null) {
    if (!USER_ROLES.has(fields.role)) throw new Error("invalid role");
    setParts.push("role = @role");
    params.role = fields.role;
  }

  if (fields.active != null) {
    setParts.push("active = @active");
    params.active = fields.active ? 1 : 0;
  }

  if (fields.password != null && String(fields.password).trim() !== "") {
    if (String(fields.password).length < 8) throw new Error("password must be at least 8 characters");
    setParts.push("password_hash = @password_hash");
    params.password_hash = hashPassword(fields.password);
  }

  if (setParts.length === 0) throw new Error("no fields to update");

  setParts.push("updated_at = NOW()");
  await db.prepare(`UPDATE app_users SET ${setParts.join(", ")} WHERE id = @id`).run(params);
  return getAppUserById(db, id);
}

export async function deleteAppUser(db, userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) throw new Error("invalid user id");

  const result = await db.prepare(`DELETE FROM app_users WHERE id = ?`).run(id);
  if (result.changes === 0) throw new Error("user not found");
  return { deleted: result.changes };
}
