import tls from "node:tls";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import { Agent, fetch as undiciFetch } from "undici";
import { assertLikelyZip } from "./zipFetchUtils.mjs";

export const MONTGOMERY_ROSTER_PAGE = "https://elections.mctx.org/evRoster.asp?ELID=97&curLang=English";

const GODADDY_ROOT = readFileSync(new URL("./certs/godaddy-tls-root-r1.pem", import.meta.url), "utf8");

/** Node's CA list does not include GoDaddy TLS Root CA - R1, which this site uses. */
const montgomeryAgent = new Agent({
  connect: { ca: [...tls.rootCertificates, GODADDY_ROOT] },
});

export function montgomeryFetch(url) {
  return undiciFetch(url, {
    dispatcher: montgomeryAgent,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "*/*",
      referer: MONTGOMERY_ROSTER_PAGE,
    },
  });
}

/** Vote date is MM.DD.YYYY in the zip or csv name. The CSV DateVoted field is a receipt note. */
export function montgomeryVoteDateFromName(name) {
  const match = String(name ?? "").match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

/** A is ballot by mail. E is early voting in person. Both are in the same daily file. */
export function montgomeryVotingMethod(voteType, dateVoted) {
  const type = String(voteType ?? "").trim().toUpperCase();
  if (type === "A" || type === "AB") return "AB";
  if (type === "E" || type === "EV") return "EV";
  const note = String(dateVoted ?? "");
  if (/\bBBM\b|by mail|absentee/i.test(note)) return "AB";
  if (/early|in person|personal appearance/i.test(note)) return "EV";
  return "other";
}

export function montgomeryRosterLinks(html) {
  const found = [];
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/myDays\.push\(\s*'([^']+\.zip)'\s*\)/gi)) {
    const fileName = match[1];
    const voteDate = montgomeryVoteDateFromName(fileName);
    if (!voteDate) continue;
    const href = new URL(`EVHistoryFiles/${fileName}`, MONTGOMERY_ROSTER_PAGE).href;
    if (seen.has(href)) continue;
    seen.add(href);
    found.push({ href, fileName, voteDate });
  }
  found.sort((a, b) => a.voteDate.localeCompare(b.voteDate) || a.href.localeCompare(b.href));
  return found;
}

/** Newest file-name day, plus any earlier day that does not already have stored voters. */
export function montgomeryRosterFilesToPull(files, datesWithVoters) {
  const have = new Set(datesWithVoters ?? []);
  if (!files?.length) return [];
  const latest = files.reduce((max, file) => (file.voteDate > max ? file.voteDate : max), "");
  return files.filter((file) => file.voteDate === latest || !have.has(file.voteDate));
}

function columnKey(row, pattern) {
  return Object.keys(row ?? {}).find((key) => pattern.test(String(key).trim())) ?? null;
}

/**
 * Montgomery daily roster CSV. VUID is the voter id. The vote date comes from the file name.
 * One person is repeated once per race, so each VUID is kept once.
 */
export function parseMontgomeryRosterCsv(text, voteDate) {
  const date = montgomeryVoteDateFromName(voteDate) || (/^\d{4}-\d{2}-\d{2}$/.test(String(voteDate ?? "")) ? voteDate : null);
  const table = parse(String(text ?? ""), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  const byVuid = new Map();
  const missingPeople = new Set();
  for (const raw of table) {
    const vuidKey = columnKey(raw, /^vuid$/i);
    const typeKey = columnKey(raw, /vote\s*type/i);
    const noteKey = columnKey(raw, /date\s*voted/i);
    const vuid = String(raw[vuidKey] ?? "").trim();
    const method = montgomeryVotingMethod(raw[typeKey], raw[noteKey]);
    if (!/^\d{8,}$/.test(vuid)) {
      const person = ["LastName", "FirstName", "MiddleName", "Voting_Precinct"]
        .map((key) => String(raw[columnKey(raw, new RegExp(`^${key}$`, "i"))] ?? "").trim().toLowerCase())
        .join("|");
      missingPeople.add(person.replace(/\|/g, "") ? person : `blank-${missingPeople.size}`);
      continue;
    }
    if (!date) continue;
    const existing = byVuid.get(vuid);
    if (!existing || (existing === "other" && method !== "other")) byVuid.set(vuid, method);
  }
  const rows = [...byVuid.entries()].map(([vuid, votingMethod]) => ({
    vuid,
    activityDate: date,
    votingMethod,
  }));
  const missingVuidDays = date && missingPeople.size ? [{ date, missingVuid: missingPeople.size }] : [];
  return { rows, skippedMissingVuid: missingPeople.size, missingVuidDays };
}

export async function parseMontgomeryRosterZip(buffer, voteDate) {
  assertLikelyZip(buffer, {});
  const zip = await JSZip.loadAsync(buffer);
  const name = Object.keys(zip.files).find((entry) => !zip.files[entry].dir && /\.csv$/i.test(entry));
  if (!name) throw new Error("Montgomery roster ZIP did not contain a CSV.");
  const text = await zip.files[name].async("string");
  return parseMontgomeryRosterCsv(text, voteDate || montgomeryVoteDateFromName(name));
}
