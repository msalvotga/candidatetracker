/**
 * Install the Python packages the polling archive needs.
 * Exits 0 when they are already importable, or when this process is the static frontend.
 * The API service on Render has Python but does not install polling/requirements.txt.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirements = path.join(root, "polling", "requirements-runtime.txt");
const check = "import sqlalchemy, numpy, pandas, yaml, httpx, bs4, dotenv, psycopg, curl_cffi";
const service = String(process.env.RENDER_SERVICE_NAME || "");

if (service.toLowerCase().includes("frontend")) process.exit(0);

function pythonBin() {
  for (const bin of ["python", "python3"]) {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return bin;
  }
  return null;
}

const bin = pythonBin();
if (!bin) process.exit(0);

if (spawnSync(bin, ["-c", check], { encoding: "utf8" }).status === 0) process.exit(0);

console.log("Installing polling Python packages…");
const args = ["-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir"];
let install = spawnSync(bin, [...args, "--break-system-packages", "-r", requirements], { stdio: "inherit" });
if (install.status !== 0) {
  install = spawnSync(bin, [...args, "-r", requirements], { stdio: "inherit" });
}
if (install.status !== 0) process.exit(install.status ?? 1);
process.exit(spawnSync(bin, ["-c", check], { encoding: "utf8" }).status ?? 1);
