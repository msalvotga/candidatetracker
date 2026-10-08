import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";
import { assertLikelyZip } from "./zipFetchUtils.mjs";

export const HAYS_ROSTER_PAGE = "https://www.hayscountytx.gov/873/November-3-2026-General-Election";

const FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/zip,*/*",
  "accept-language": "en-US,en;q=0.9",
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function decodeHtml(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The Excel and CSV zip under Absentee Ballots Received. The document id changes when the file is replaced. */
export function haysRosterLink(html) {
  const source = String(html ?? "");
  const absentee = source.search(/absentee ballots received/i);
  const region = absentee < 0 ? source : source.slice(absentee, absentee + 4000);
  for (const match of region.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeHtml(match[2]);
    if (!/excel and csv available here/i.test(text)) continue;
    return { href: new URL(decodeHtml(match[1]), HAYS_ROSTER_PAGE).href, text };
  }
  return null;
}

function columnKey(row, pattern) {
  return Object.keys(row ?? {}).find((key) => pattern.test(String(key).trim())) ?? null;
}

function votingMethod(status) {
  const text = String(status ?? "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ");
  if (text === "MAIL IN" || text === "MAIL" || text === "AB" || text === "ABB" || text === "BBM" || text === "ABSENTEE" || text === "UOCAVA") {
    return "AB";
  }
  if (text === "EV" || text === "EARLY" || text === "EARLY VOTING" || text === "IN PERSON") return "EV";
  if (text === "ED" || text === "ELECTION DAY") return "ED";
  return "";
}

function voteDate(value) {
  const iso = parseIsoDate(value);
  if (!iso) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return iso;
}

/**
 * Hays absentee CSV inside the zip. VUID is the voter id. Date is the vote date.
 * Mail-In and UOCAVA are mail.
 */
export function parseHaysRosterCsv(text) {
  const table = parse(String(text ?? ""), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  if (table.length && !columnKey(table[0], /^vuid$/i)) {
    throw new Error("Hays roster CSV did not include a VUID column.");
  }
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table) {
    const vuid = String(raw[columnKey(raw, /^vuid$/i)] ?? "")
      .trim()
      .replace(/\.0$/, "");
    const activityDate = voteDate(raw[columnKey(raw, /^date$/i)]);
    const method = votingMethod(raw[columnKey(raw, /^status$/i)]);
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      if (activityDate) missingByDate.set(activityDate, (missingByDate.get(activityDate) ?? 0) + 1);
      continue;
    }
    if (!activityDate || !method) {
      skippedMissingDate += 1;
      continue;
    }
    const key = `${vuid}|${activityDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ vuid, activityDate, votingMethod: method });
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}

export async function parseHaysRosterZip(buffer) {
  assertLikelyZip(buffer, {});
  const zip = await JSZip.loadAsync(buffer);
  const name = Object.keys(zip.files).find((entry) => !zip.files[entry].dir && /\.csv$/i.test(entry));
  if (!name) throw new Error("Hays roster ZIP did not contain a CSV file.");
  return parseHaysRosterCsv(await zip.files[name].async("string"));
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  return "";
}

async function readChromePort(dir) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const text = await readFile(path.join(dir, "DevToolsActivePort"), "utf8");
      const port = Number(text.split(/\r?\n/)[0]);
      if (port) return port;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("Chrome did not open a debugging port for the Hays roster.");
}

function stopProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill();
}

function openCdp(ws) {
  let next = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "Hays browser call failed."));
    else waiter.resolve(message.result);
  });
  return (method, params, timeoutMs = 60000) => {
    const id = next;
    next += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hays browser call timed out (${method}).`)), timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 90000);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(text || "Hays roster page could not be read.");
  }
  return result.result.value;
}

async function directBytes(url) {
  const response = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
  const bytes = Buffer.from(await response.arrayBuffer());
  const blocked = response.status === 403 || /you have been blocked|just a moment/i.test(bytes.subarray(0, 800).toString("utf8"));
  return { ok: response.ok && !blocked, status: response.status, bytes };
}

async function browserRoster(chrome) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hays-roster-"));
  const child = spawn(
    chrome,
    [
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=-32000,-32000",
      "--window-size=900,700",
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0",
      `--user-agent=${FETCH_HEADERS["user-agent"]}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let ws;
  try {
    const port = await readChromePort(dir);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page) throw new Error("Chrome did not open a page for the Hays roster.");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const cdp = openCdp(ws);
    await cdp("Page.navigate", { url: HAYS_ROSTER_PAGE });
    let html = "";
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        html = await evaluate(cdp, "document.documentElement.outerHTML");
      } catch {
        html = "";
      }
      if (/excel and csv available here|you have been blocked/i.test(html)) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (/you have been blocked/i.test(html)) {
      throw new Error(`Hays roster page was blocked. ${HAYS_ROSTER_PAGE}`);
    }
    const link = haysRosterLink(html);
    if (!link) throw new Error("The Excel and CSV link was not under Absentee Ballots Received.");
    const fileResult = JSON.parse(
      await evaluate(
        cdp,
        `(async () => {
          const file = await fetch(${JSON.stringify(link.href)});
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          return JSON.stringify({ status: file.status, body: btoa(binary) });
        })()`,
      ),
    );
    if (fileResult.status !== 200 || !fileResult.body) {
      throw new Error(`Hays roster file was not available (${fileResult.status}). ${link.href}`);
    }
    return { link, bytes: Buffer.from(fileResult.body, "base64") };
  } finally {
    ws?.close();
    stopProcess(child);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Page link and roster zip. A plain download is blocked, so Chrome reads the site. */
export async function fetchHaysRoster() {
  const probe = await directBytes(HAYS_ROSTER_PAGE);
  if (probe.ok) {
    const html = probe.bytes.toString("utf8");
    const link = haysRosterLink(html);
    if (!link) throw new Error("The Excel and CSV link was not under Absentee Ballots Received.");
    const file = await directBytes(link.href);
    if (file.ok) return { link, bytes: file.bytes };
  }
  const chrome = await findChrome();
  if (!chrome) throw new Error("Hays roster page was blocked, and Chrome is not installed to read it.");
  return browserRoster(chrome);
}
