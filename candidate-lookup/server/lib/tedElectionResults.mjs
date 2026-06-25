import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marginFromGopShare } from "./benchmarkMargin.mjs";
import { computeContestStats, storedMarginForMetricKey } from "./electionMargin.mjs";
import { recomputeOfficeMetric } from "./contestMetrics.mjs";
import { buildLegVoteLookup, enrichContestVotesFromLookup } from "./legVoteBackfill.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");

const PARTY_MAP = { R: "R", D: "D", L: "L", G: "G", I: "I" };

export const STATEWIDE_TED_MAP = {
  2022: {
    Governor: "GOV",
    "Lt. Governor": "LTGOV",
    "Attorney General": "AG",
    Comptroller: "COMPT",
    "Land Commissioner": "GLO",
    "Agriculture Commissioner": "AGRI",
    "Justice Of The Supreme Court Place 3": "SCOTX-PL3",
    "Justice Of The Supreme Court Place 5": "SCOTX-PL5",
    "Justice Of The Supreme Court Place 9": "SCOTX-PL9",
    "Court Of Criminal Appeals Place 2": "CCA-PL2",
    "Court Of Criminal Appeals Place 5": "CCA-PL5",
    "Court Of Criminal Appeals Place 6": "CCA-PL6",
  },
  2024: {
    "Justice Of The Supreme Court Place 2": "SCOTX-PL2",
    "Justice Of The Supreme Court Place 4": "SCOTX-PL4",
    "Justice Of The Supreme Court Place 6": "SCOTX-PL6",
    "Court Of Criminal Appeals Presiding": "CCA-PRES",
    "Court Of Criminal Appeals Place 7": "CCA-PL7",
    "Court Of Criminal Appeals Place 8": "CCA-PL8",
  },
};

function padDistrict(n, width) {
  return String(n).padStart(width, "0");
}

export function officeCodeFromResourceName(name) {
  const text = String(name ?? "").trim();
  let match = text.match(/^State Representative District (\d+)$/i);
  if (match) return `HD-${padDistrict(Number(match[1]), 3)}`;

  match = text.match(/^State Senator District (\d+)$/i);
  if (match) return `SD-${padDistrict(Number(match[1]), 2)}`;

  match = text.match(/^U\.S\. Representative District (\d+)$/i);
  if (match) return `TX-${Number(match[1])}`;

  match = text.match(/^State Board Of Education District (\d+)$/i);
  if (match) return `SBOE-${padDistrict(Number(match[1]), 2)}`;

  return null;
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

export function parseCandidateFromHeader(header) {
  const match = String(header ?? "").match(/^(.+?)([RDLGI])_\d{2}G_(.+)$/);
  if (!match) return null;
  return {
    name: match[1],
    party: PARTY_MAP[match[2]] ?? match[2],
    contestName: match[3],
  };
}

function parsePartyFromHeader(header) {
  const match = String(header ?? "").match(/^.+?([RDLGI])_\d{2}G_/);
  if (!match) return null;
  return PARTY_MAP[match[1]] ?? null;
}

export function computeGopShare(totalsByParty, candidateTotals) {
  const R = totalsByParty.R ?? 0;
  const D = totalsByParty.D ?? 0;

  if (R > 0 && D > 0) return R / (R + D);
  if (R > 0 && D === 0) return 1.0;
  if (D > 0 && R === 0) return 0.0;

  const ranked = [...candidateTotals.entries()]
    .filter(([, votes]) => votes > 0)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length === 1) {
    const party = ranked[0][0];
    if (party === "R") return 1.0;
    if (party === "D") return 0.0;
    return null;
  }

  const [topParty, topVotes] = ranked[0];
  const [secondParty, secondVotes] = ranked[1];
  const twoWay = topVotes + secondVotes;
  if (twoWay <= 0) return null;

  if (topParty === "R") return topVotes / twoWay;
  if (topParty === "D") return 0;
  if (secondParty === "R") return secondVotes / twoWay;
  if (secondParty === "D") return 0;
  return null;
}

export function parseTedDistrictCsv(csvText) {
  const parsed = parseTedContest(csvText);
  return parsed?.gopShare ?? null;
}

export function parseTedContest(csvText) {
  const lines = String(csvText ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) return null;

  const headers = parseCsvLine(lines[0]);
  const candidateCols = [];
  for (let i = 2; i < headers.length; i += 1) {
    const party = parsePartyFromHeader(headers[i]);
    if (!party) continue;
    candidateCols.push({ index: i, party, header: headers[i] });
  }
  if (candidateCols.length === 0) return null;

  const votesByHeader = new Map();
  const totalsByParty = { R: 0, D: 0, L: 0, G: 0, I: 0 };
  const partyTotals = new Map();

  for (let rowIdx = 1; rowIdx < lines.length; rowIdx += 1) {
    const row = parseCsvLine(lines[rowIdx]);
    for (const col of candidateCols) {
      const votes = Number(row[col.index] ?? 0);
      if (!Number.isFinite(votes) || votes <= 0) continue;
      votesByHeader.set(col.header, (votesByHeader.get(col.header) ?? 0) + votes);
      totalsByParty[col.party] = (totalsByParty[col.party] ?? 0) + votes;
      partyTotals.set(col.party, (partyTotals.get(col.party) ?? 0) + votes);
    }
  }

  const contestName = parseCandidateFromHeader(candidateCols[0]?.header)?.contestName ?? null;
  const totalVotes = [...votesByHeader.values()].reduce((sum, n) => sum + n, 0);

  if (totalVotes > 0) {
    const candidates = candidateCols
      .map((col, sortOrder) => {
        const meta = parseCandidateFromHeader(col.header);
        const votes = Math.round(votesByHeader.get(col.header) ?? 0);
        return {
          name: meta?.name ?? col.header,
          party: col.party,
          votes,
          vote_pct: votes > 0 ? votes / totalVotes : null,
          sort_order: sortOrder,
          unopposed: false,
        };
      })
      .filter((candidate) => candidate.votes > 0)
      .sort((a, b) => b.votes - a.votes);

    return {
      gopShare: computeGopShare(totalsByParty, partyTotals),
      contestName,
      unopposed: false,
      candidates,
    };
  }

  const parties = new Set(candidateCols.map((col) => col.party));
  let gopShare = null;
  let unopposed = false;
  if (parties.has("R") && !parties.has("D")) {
    gopShare = 1.0;
    unopposed = true;
  } else if (parties.has("D") && !parties.has("R")) {
    gopShare = 0.0;
    unopposed = true;
  } else if (candidateCols.length === 1) {
    if (candidateCols[0].party === "R") {
      gopShare = 1.0;
      unopposed = true;
    } else if (candidateCols[0].party === "D") {
      gopShare = 0.0;
      unopposed = true;
    }
  }
  if (gopShare == null) return null;

  const candidates = candidateCols.map((col, sortOrder) => {
    const meta = parseCandidateFromHeader(col.header);
    return {
      name: meta?.name ?? col.header,
      party: col.party,
      votes: null,
      vote_pct: unopposed && candidateCols.length === 1 ? 1 : null,
      sort_order: sortOrder,
      unopposed,
    };
  });

  return { gopShare, contestName, unopposed, candidates };
}

export async function fetchTedCsv(url) {
  const res = await fetch(url, {
    headers: { Accept: "text/csv,text/plain,*/*" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

function loadCapitolMetadata(year) {
  const file = path.join(DATA_DIR, `capitol-${year}-general.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run npm run db:fetch-ted-meta first.`);
  }
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!body?.result?.resources) throw new Error(`Invalid metadata in ${file}`);
  return body.result.resources;
}

function buildDistrictJobs(year) {
  const resources = loadCapitolMetadata(year);
  const field = year === 2024 ? "leg_2024" : "leg_2022";
  const jobs = [];

  for (const resource of resources) {
    if (!resource.url?.includes("ted.capitol.texas.gov")) continue;
    const officeCode = officeCodeFromResourceName(resource.name);
    if (!officeCode) continue;
    jobs.push({ officeCode, year, field, url: resource.url, name: resource.name });
  }

  const statewideMap = STATEWIDE_TED_MAP[year] ?? {};
  for (const resource of resources) {
    const officeCode = statewideMap[resource.name];
    if (!officeCode || !resource.url?.includes("ted.capitol.texas.gov")) continue;
    jobs.push({ officeCode, year, field, url: resource.url, name: resource.name });
  }

  return jobs;
}

export async function fetchCapitolMetadata(year) {
  const res = await fetch(`https://data.capitol.texas.gov/api/3/action/package_show?id=${year}_general`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch ${year} general metadata (${res.status})`);
  const body = await res.json();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `capitol-${year}-general.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

export async function saveContestCandidates(database, officeCode, metricKey, contest) {
  const office = await database.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(officeCode);
  if (!office) return false;

  await database
    .prepare(`DELETE FROM metric_contest_candidates WHERE office_id = ? AND metric_key = ?`)
    .run(office.id, metricKey);

  const insert = database.prepare(
    `INSERT INTO metric_contest_candidates (
       office_id, metric_key, candidate_name, party, votes, vote_pct, sort_order, unopposed, contest_name, source
     ) VALUES (
       @officeId, @metricKey, @name, @party, @votes, @vote_pct, @sort_order, @unopposed, @contest_name, 'ted'
     )`
  );

  for (let index = 0; index < contest.candidates.length; index += 1) {
    const candidate = contest.candidates[index];
    await insert.run({
      officeId: office.id,
      metricKey,
      name: candidate.name,
      party: candidate.party,
      votes: candidate.votes,
      vote_pct: candidate.vote_pct,
      sort_order: index,
      unopposed: contest.unopposed ? 1 : 0,
      contest_name: contest.contestName,
    });
  }

  return true;
}

export async function upsertLegMetric(database, officeCode, field, gopShare, contest = null) {
  const office = await database.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(officeCode);
  if (!office) return false;

  if (contest) {
    await saveContestCandidates(database, officeCode, field, contest);
    await recomputeOfficeMetric(database, office.id, field);
    return true;
  }

  if (gopShare == null) return false;
  const margin = marginFromGopShare(gopShare);
  await database
    .prepare(
      `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
       VALUES (@officeId, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(office_id) DO NOTHING`
    )
    .run({ officeId: office.id });

  await database.prepare(`UPDATE office_metrics SET ${field} = @value WHERE office_id = @officeId`).run({
    officeId: office.id,
    value: margin,
  });

  return true;
}

export async function importTedElectionResults(database, options = {}) {
  const years = options.years ?? [2024, 2022];
  const concurrency = options.concurrency ?? 6;
  const summary = { imported: 0, skipped: 0, errors: [], byYear: {} };

  for (const year of years) {
    const jobs = buildDistrictJobs(year);
    summary.byYear[year] = { jobs: jobs.length, imported: 0, skipped: 0 };
    const voteLookup = year === 2022 ? await buildLegVoteLookup() : null;

    const results = await mapWithConcurrency(jobs, concurrency, async (job) => {
      try {
        const csv = await fetchTedCsv(job.url);
        let contest = parseTedContest(csv);
        if (contest && voteLookup) {
          contest = enrichContestVotesFromLookup(contest, job.officeCode, voteLookup);
        }
        if (contest?.gopShare == null) {
          summary.skipped += 1;
          summary.byYear[year].skipped += 1;
          return { job, ok: false, reason: "no votes" };
        }
        const saved = await upsertLegMetric(database, job.officeCode, job.field, contest.gopShare, contest);
        if (!saved) {
          summary.skipped += 1;
          summary.byYear[year].skipped += 1;
          return { job, ok: false, reason: "office not found" };
        }
        summary.imported += 1;
        summary.byYear[year].imported += 1;
        return { job, ok: true, gopShare: contest.gopShare };
      } catch (err) {
        summary.errors.push({ job: job.name, error: err instanceof Error ? err.message : String(err) });
        summary.skipped += 1;
        summary.byYear[year].skipped += 1;
        return { job, ok: false, reason: "error" };
      }
    });

    if (options.verbose) {
      const sample = results.filter((r) => r.ok).slice(0, 3);
      for (const row of sample) {
        console.log(`  ${row.job.officeCode} ${jobFieldLabel(row.job)}: ${formatShare(row.gopShare)}`);
      }
    }
  }

  return summary;
}

function jobFieldLabel(job) {
  return job.field === "leg_2024" ? "2024" : "2022";
}

function formatShare(gopShare) {
  const margin = marginFromGopShare(gopShare);
  if (margin == null) return "—";
  const pts = Math.abs(margin * 100);
  return margin >= 0 ? `R+${pts.toFixed(1)}` : `D+${pts.toFixed(1)}`;
}
