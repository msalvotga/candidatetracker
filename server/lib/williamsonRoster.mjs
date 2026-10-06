import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { parseIsoDate } from "./ballotScoreCalendar.mjs";

export const WILLIAMSON_ROSTER_PAGE = "https://www.wilcotx.gov/elections";

const FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

/** Daily Voting Roster on the elections page. The document id changes when the county posts a new file. */
export function williamsonRosterLink(html) {
  for (const match of String(html ?? "").matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const text = decodeHtml(match[2]);
    const href = decodeHtml(match[1]);
    const daily = /daily voting roster/i.test(text);
    const turnout = /voter turnout/i.test(`${text} ${href}`) && /november|2026|jgse/i.test(`${text} ${href}`);
    if (!daily && !turnout) continue;
    return { href: new URL(href, WILLIAMSON_ROSTER_PAGE).href, text: text || "Daily Voting Roster" };
  }
  return null;
}

function ballotDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  }
  const text = String(value ?? "").trim();
  const iso = parseIsoDate(text);
  if (iso) return iso;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) return null;
  const year = 2000 + Number(match[3]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function columnIndex(header, pattern) {
  return (header ?? []).findIndex((cell) => pattern.test(String(cell ?? "").trim()));
}

function thisElection(name) {
  const text = String(name ?? "").trim();
  if (!text) return true;
  return /2026/.test(text) && /november|joint general/i.test(text);
}

/**
 * Williamson turnout workbook. VUID is the voter id. Ballot Date is the vote date.
 * AV is a mail ballot. EV is in-person early voting.
 */
export function williamsonRosterRows(matrix) {
  const table = matrix ?? [];
  let header = -1;
  let vuidColumn = -1;
  let dateColumn = -1;
  let methodColumn = -1;
  let electionColumn = -1;
  for (let index = 0; index < table.length; index += 1) {
    const row = table[index] ?? [];
    const vuid = columnIndex(row, /^vuid$/i);
    const date = columnIndex(row, /^ballot date$/i);
    if (vuid >= 0 && date >= 0) {
      header = index;
      vuidColumn = vuid;
      dateColumn = date;
      methodColumn = columnIndex(row, /^voting method$/i);
      electionColumn = columnIndex(row, /^election name$/i);
      break;
    }
  }
  if (vuidColumn < 0 && table.some((row) => (row ?? []).some((value) => String(value ?? "").trim()))) {
    throw new Error("Williamson roster did not include a VUID and Ballot Date.");
  }
  const rows = [];
  const seen = new Set();
  const missingByDate = new Map();
  let skippedMissingVuid = 0;
  let skippedMissingDate = 0;
  for (const raw of table.slice(header + 1)) {
    const values = raw ?? [];
    if (!values.some((value) => String(value ?? "").trim())) continue;
    if (electionColumn >= 0 && !thisElection(values[electionColumn])) continue;
    const vuid = String(values[vuidColumn] ?? "").trim();
    const voteDate = ballotDate(values[dateColumn]);
    if (!/^\d{8,}$/.test(vuid)) {
      skippedMissingVuid += 1;
      if (voteDate) missingByDate.set(voteDate, (missingByDate.get(voteDate) ?? 0) + 1);
      continue;
    }
    if (!voteDate) {
      skippedMissingDate += 1;
      continue;
    }
    const key = `${vuid}|${voteDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const method = votingMethod(methodColumn >= 0 ? values[methodColumn] : "");
    rows.push({ vuid, activityDate: voteDate, votingMethod: method });
  }
  const missingVuidDays = [...missingByDate.entries()]
    .map(([date, missingVuid]) => ({ date, missingVuid }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, skippedMissingVuid, skippedMissingDate, missingVuidDays };
}

export function parseWilliamsonRosterXlsx(buffer) {
  const book = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error("Williamson roster workbook did not include a sheet.");
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  return williamsonRosterRows(matrix);
}

function votingMethod(raw) {
  const text = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ");
  if (text === "AV" || text === "AB" || text === "ABB" || text === "BBM" || text === "MAIL" || text === "ABSENTEE") return "AB";
  if (text === "EV" || text === "EARLY" || text === "EARLY VOTING" || text === "IN PERSON") return "EV";
  if (text === "ED" || text === "ELECTION DAY") return "ED";
  return "";
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
      // Chrome writes this file after the debugging port is open.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Chrome did not open a debugging port for the Williamson roster.");
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
    if (message.error) waiter.reject(new Error(message.error.message || "Williamson browser call failed."));
    else waiter.resolve(message.result);
  });
  return (method, params, timeoutMs = 30000) => {
    const id = next;
    next += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Williamson browser call timed out (${method}).`)), timeoutMs);
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
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 60000);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(text || "Williamson roster page could not be read.");
  }
  return result.result.value;
}

async function browserRoster(chrome) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wilco-roster-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
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
    if (!page) throw new Error("Chrome did not open a page for the Williamson roster.");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const cdp = openCdp(ws);
    await cdp("Page.navigate", { url: WILLIAMSON_ROSTER_PAGE });
    let html = "";
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        html = await evaluate(cdp, "document.documentElement.outerHTML");
      } catch {
        html = "";
      }
      if (/Daily Voting Roster|you have been blocked/i.test(html)) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (/you have been blocked/i.test(html)) {
      throw new Error(`Williamson roster page was blocked. ${WILLIAMSON_ROSTER_PAGE}`);
    }
    const link = williamsonRosterLink(html);
    if (!link) throw new Error("The Daily Voting Roster link was not on the Williamson elections page.");
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
      throw new Error(`Williamson roster file was not available (${fileResult.status}). ${link.href}`);
    }
    const bytes = Buffer.from(fileResult.body, "base64");
    if (bytes.subarray(0, 2).toString("utf8") !== "PK") {
      throw new Error(`Williamson roster file was not a spreadsheet. ${link.href}`);
    }
    return { html, link, bytes };
  } finally {
    ws?.close();
    stopProcess(child);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function directBytes(url) {
  const response = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
  const bytes = Buffer.from(await response.arrayBuffer());
  const blocked = response.status === 403 || /you have been blocked/i.test(bytes.subarray(0, 500).toString("utf8"));
  return { ok: response.ok && !blocked, status: response.status, bytes };
}

/** Page HTML and roster workbook. A direct download is blocked, so Chrome reads the site. */
export async function fetchWilliamsonRoster() {
  const probe = await directBytes(WILLIAMSON_ROSTER_PAGE);
  if (probe.ok) {
    const html = probe.bytes.toString("utf8");
    const link = williamsonRosterLink(html);
    if (!link) throw new Error("The Daily Voting Roster link was not on the Williamson elections page.");
    const file = await directBytes(link.href);
    if (!file.ok) throw new Error(`Williamson roster file was not available (${file.status}). ${link.href}`);
    return { html, link, bytes: file.bytes };
  }
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error("Williamson roster page was blocked, and Chrome is not installed to read it.");
  }
  return browserRoster(chrome);
}
