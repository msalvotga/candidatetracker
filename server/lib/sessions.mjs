import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "ct_session";
export const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MS = 24 * 60 * 60 * 1000;

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function createSessionToken() {
  return randomBytes(32).toString("hex");
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const cookies = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function sessionCookieOptions(rememberMe) {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "Lax",
    path: "/",
    maxAge: rememberMe ? REMEMBER_MS : undefined,
  };
}

export function setSessionCookie(res, token, rememberMe) {
  const opts = sessionCookieOptions(rememberMe);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isProduction) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export async function createSession(db, userId, { rememberMe = false } = {}) {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const ms = rememberMe ? REMEMBER_MS : SESSION_MS;
  const expiresAt = new Date(Date.now() + ms);

  await db
    .prepare(
      `INSERT INTO app_sessions (user_id, token_hash, expires_at, remember_me)
       VALUES (@userId, @tokenHash, @expiresAt, @rememberMe)`
    )
    .run({
      userId,
      tokenHash,
      expiresAt: expiresAt.toISOString(),
      rememberMe: rememberMe ? 1 : 0,
    });

  return { token, expiresAt, rememberMe };
}

export async function getSessionByToken(db, token) {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.remember_me
       FROM app_sessions s
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.prepare(`DELETE FROM app_sessions WHERE id = ?`).run(row.id);
    return null;
  }
  return row;
}

export async function deleteSessionByToken(db, token) {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  await db.prepare(`DELETE FROM app_sessions WHERE token_hash = ?`).run(tokenHash);
}

export async function deleteSessionsForUser(db, userId) {
  await db.prepare(`DELETE FROM app_sessions WHERE user_id = ?`).run(userId);
}

export async function purgeExpiredSessions(db) {
  await db.prepare(`DELETE FROM app_sessions WHERE expires_at <= NOW()`).run();
}
