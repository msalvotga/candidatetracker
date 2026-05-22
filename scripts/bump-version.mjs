/**
 * Updates APP_VERSION in src/lib/appVersion.ts and package.json from the current clock.
 * Format: 1.{daysSince2026-05-03}.{HHMM}
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const versionFile = path.join(root, "src", "lib", "appVersion.ts");
const pkgFile = path.join(root, "package.json");

const epoch = new Date(2026, 4, 3);
const now = new Date();
const ms = now.getTime() - epoch.getTime();
const days = Math.max(0, Math.floor(ms / 86_400_000));
const hh = String(now.getHours()).padStart(2, "0");
const mm = String(now.getMinutes()).padStart(2, "0");
const version = `1.${days}.${hh}${mm}`;

let ts = fs.readFileSync(versionFile, "utf8");
ts = ts.replace(/export const APP_VERSION = "[^"]+";/, `export const APP_VERSION = "${version}";`);
fs.writeFileSync(versionFile, ts, "utf8");

const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

console.log(`Version set to ${version} (${days} days since 2026-05-03, time ${hh}:${mm})`);
