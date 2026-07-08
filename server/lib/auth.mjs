import { verifyPassword } from "./password.mjs";
import { getAppUserById, getAppUserByUsername } from "./users.mjs";
import {
  SESSION_COOKIE,
  createSession,
  deleteSessionByToken,
  getSessionByToken,
  parseCookies,
  purgeExpiredSessions,
  setSessionCookie,
  clearSessionCookie,
} from "./sessions.mjs";

const DEFAULT_GUEST_IPS = ["12.42.214.58", "127.0.0.1", "::1"];

export function permissionsForRole(role) {
  const isAdmin = role === "admin";
  const canEditStafferMap = isAdmin || role === "staff_edit";
  return {
    isAdmin,
    canAccessData: isAdmin,
    canEdit: isAdmin,
    canEditStafferMap,
    canManageUsers: isAdmin,
  };
}

function stripPort(ip) {
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    return end > 0 ? ip.slice(1, end) : ip;
  }
  const colonCount = (ip.match(/:/g) ?? []).length;
  if (colonCount === 1 && ip.includes(".")) {
    return ip.split(":")[0] ?? ip;
  }
  return ip;
}

function normalizeClientIp(raw) {
  let ip = String(raw ?? "").trim();
  if (!ip) return "";
  ip = stripPort(ip);
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function addIpCandidate(raw, seen, candidates) {
  const ip = normalizeClientIp(raw);
  if (!ip || seen.has(ip)) return;
  seen.add(ip);
  candidates.push(ip);
}

/** All plausible client IPs from proxy headers (office NAT may appear after an internal hop). */
export function clientIpCandidates(req) {
  const seen = new Set();
  const candidates = [];

  if (req.ip) addIpCandidate(req.ip, seen, candidates);
  if (Array.isArray(req.ips)) {
    for (const ip of req.ips) addIpCandidate(ip, seen, candidates);
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    for (const part of String(forwarded).split(",")) {
      addIpCandidate(part, seen, candidates);
    }
  }

  for (const header of ["x-real-ip", "cf-connecting-ip", "true-client-ip", "fastly-client-ip"]) {
    const value = req.headers[header];
    if (value) addIpCandidate(String(value).split(",")[0], seen, candidates);
  }

  addIpCandidate(req.socket?.remoteAddress ?? "", seen, candidates);
  return candidates;
}

export function clientIp(req) {
  return clientIpCandidates(req)[0] ?? "";
}

function guestIpAllowlist() {
  const raw = process.env.AUTH_GUEST_IPS;
  const source =
    raw != null && String(raw).trim() !== "" ? String(raw) : DEFAULT_GUEST_IPS.join(",");
  const configured = source
    .split(/[,;\s]+/)
    .map((ip) => normalizeClientIp(ip))
    .filter(Boolean);
  return new Set(configured);
}

export function isGuestIp(req) {
  const allowlist = guestIpAllowlist();
  if (allowlist.size === 0) return false;
  return clientIpCandidates(req).some((ip) => allowlist.has(ip));
}

const DEV_ADMIN_USER = {
  id: 0,
  username: "dev",
  display_name: "Dev Admin",
  role: "admin",
  active: true,
};

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    active: user.active === 1 || user.active === true,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function resolveAuth(req, db) {
  if (process.env.AUTH_DEV_BYPASS === "admin") {
    return {
      user: DEV_ADMIN_USER,
      permissions: permissionsForRole("admin"),
      authenticated: true,
      devBypass: true,
    };
  }

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const session = await getSessionByToken(db, token);
    if (session) {
      const user = await getAppUserById(db, session.user_id);
      if (user?.active) {
        return {
          user,
          permissions: permissionsForRole(user.role),
          authenticated: true,
          sessionToken: token,
        };
      }
      await deleteSessionByToken(db, token);
    }
  }

  if (isGuestIp(req)) {
    return {
      user: null,
      permissions: permissionsForRole("viewer"),
      authenticated: true,
      guestAccess: true,
    };
  }

  return {
    user: null,
    permissions: permissionsForRole("viewer"),
    authenticated: false,
    guestAccess: false,
  };
}

export function requireAdmin(req, res, next) {
  if (req.auth?.permissions?.isAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: "admin access required" });
}

export function requireStafferMapEdit(req, res, next) {
  if (req.auth?.permissions?.canEditStafferMap) {
    next();
    return;
  }
  res.status(403).json({ error: "staffer map edit access required" });
}

export function requireAuth(req, res, next) {
  if (process.env.AUTH_DEV_BYPASS === "admin") {
    next();
    return;
  }
  if (req.auth?.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: "login required" });
}

export async function loginUser(db, res, { email, password, rememberMe = false }) {
  const username = String(email ?? "").trim().toLowerCase();
  if (!username || !password) throw new Error("email and password are required");

  const row = await getAppUserByUsername(db, username);
  if (!row || !row.active) throw new Error("invalid email or password");
  if (!verifyPassword(password, row.password_hash)) throw new Error("invalid email or password");

  const session = await createSession(db, row.id, { rememberMe: Boolean(rememberMe) });
  setSessionCookie(res, session.token, Boolean(rememberMe));

  return {
    user: publicUser(row),
    permissions: permissionsForRole(row.role),
    authenticated: true,
    remember_me: Boolean(rememberMe),
    expires_at: session.expiresAt.toISOString(),
  };
}

export async function logoutUser(db, req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) await deleteSessionByToken(db, token);
  clearSessionCookie(res);
  return { ok: true };
}

export async function initAuth(db) {
  await purgeExpiredSessions(db);
}
