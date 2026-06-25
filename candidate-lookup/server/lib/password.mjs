import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !String(stored).includes(":")) return false;
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = scryptSync(String(password), salt, KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  if (test.length !== expected.length) return false;
  return timingSafeEqual(test, expected);
}
