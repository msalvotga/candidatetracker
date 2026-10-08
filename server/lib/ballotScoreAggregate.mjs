import { parse } from "csv-parse";
import { openCsvStream } from "./ballotLookupStore.mjs";
import { DAY_DEFS, parseIsoDate, parseVotingDayNumber, rosterBucket, votingDayFromDate } from "./ballotScoreCalendar.mjs";

const REQUIRED = {
  lookup: ["VUID", "CountyName", "USHouse", "TXSenate", "TXHouse", "Score2022", "Score2026"],
  static2022: [
    "GeographyType",
    "Geography",
    "VotingDay",
    "VotingDate",
    "VotingDayLabel",
    "DailyVoters",
    "DailyVotersWith2022Score",
    "Daily2022Average",
    "DailyVotersWith2026Score",
    "Daily2026Average",
    "CumulativeVoters",
    "CumulativeVotersWith2022Score",
    "Cumulative2022Average",
    "CumulativeVotersWith2026Score",
    "Cumulative2026Average",
  ],
  roster2026: ["VUID", "VoteDate"],
};

/** Name, birth date, phone, registration date, and address columns kept on the voter-model lookup. Not required. */
export const LOOKUP_DETAIL_COLUMNS = [
  "FirstName",
  "MiddleName",
  "LastName",
  "NameSuffix",
  "Sex",
  "BirthYear",
  "BirthMonth",
  "BirthDay",
  "DateofBirth",
  "Cell",
  "Landline",
  "RegistrationDate",
  "RegistrationAddr1",
  "RegistrationAddr2",
  "RegHouseNum",
  "RegHouseSfx",
  "RegStPrefix",
  "RegStName",
  "RegStType",
  "RegStPost",
  "RegUnitType",
  "RegUnitNumber",
  "RegCity",
  "RegSta",
  "RegZip5",
];

const SUMMARY_GEO_TYPES = {
  statewide: "state",
  county: "county",
  "texas house district": "house",
  "texas senate district": "senate",
  "congressional district": "congress",
};

export function requiredColumns(kind) {
  return REQUIRED[kind] ? [...REQUIRED[kind]] : [];
}

function emptyBucket() {
  return { voters: 0, s22n: 0, s22sum: 0, s26n: 0, s26sum: 0 };
}

function addScore(bucket, score2022, score2026) {
  bucket.voters += 1;
  if (score2022 != null) {
    bucket.s22n += 1;
    bucket.s22sum += score2022;
  }
  if (score2026 != null) {
    bucket.s26n += 1;
    bucket.s26sum += score2026;
  }
}

function bumpDay(geo, day, score2022, score2026) {
  let bucket = geo.days.get(day);
  if (!bucket) {
    bucket = emptyBucket();
    geo.days.set(day, bucket);
  }
  addScore(bucket, score2022, score2026);
}

/** Mail enters the voting-day cumulative on the day of its vote date, not the daily in-person count. */
function bumpMailOnDay(geo, day, score2022, score2026) {
  if (!geo.mailOnDay) geo.mailOnDay = new Map();
  let bucket = geo.mailOnDay.get(day);
  if (!bucket) {
    bucket = emptyBucket();
    geo.mailOnDay.set(day, bucket);
  }
  addScore(bucket, score2022, score2026);
}

function recordRosterVote(geo, hit, score2022, score2026) {
  bumpDay(geo, hit.bucket, score2022, score2026);
  if (hit.bucket !== 0) return;
  const entered = votingDayFromDate(hit.iso, 2026);
  if (entered != null) bumpMailOnDay(geo, entered, score2022, score2026);
}

function addBucket(target, source) {
  target.voters += source.voters;
  target.s22n += source.s22n;
  target.s22sum += source.s22sum;
  target.s26n += source.s26n;
  target.s26sum += source.s26sum;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function publish(bucket) {
  return {
    voters: bucket.voters,
    score2022: {
      n: bucket.s22n,
      sum: round4(bucket.s22sum),
      avg: bucket.s22n ? round4(bucket.s22sum / bucket.s22n) : null,
    },
    score2026: {
      n: bucket.s26n,
      sum: round4(bucket.s26sum),
      avg: bucket.s26n ? round4(bucket.s26sum / bucket.s26n) : null,
    },
  };
}

function scoreDayIds() {
  return [0, ...DAY_DEFS.map((day) => day.id)];
}

function emptyPublishedDays() {
  const zero = publish(emptyBucket());
  const byDay = {};
  for (const id of scoreDayIds()) {
    byDay[String(id)] = {
      y2022: { daily: zero, cumulative: zero },
      y2026: { daily: zero, cumulative: zero },
    };
  }
  return byDay;
}

function titleCounty(key) {
  return key
    .toLowerCase()
    .split(" ")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function geoLabel(kind, key) {
  if (kind === "state") return "Texas";
  if (kind === "county") return titleCounty(key);
  if (kind === "house") return `HD ${key}`;
  if (kind === "senate") return `SD ${key}`;
  if (kind === "congress") return `CD ${key}`;
  return key;
}

function cleanHeader(key) {
  return String(key ?? "")
    .trim()
    .replace(/^\[(.+)\]$/, "$1")
    .trim();
}

function field(row, name) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const want = name.toLowerCase();
  for (const key of Object.keys(row)) {
    if (cleanHeader(key).toLowerCase() === want) return row[key];
  }
  return undefined;
}

function headerNames(row) {
  return Object.keys(row).map((key) => cleanHeader(key).toLowerCase());
}

export function lookupDetailColumns(row) {
  const required = new Set(requiredColumns("lookup").map((column) => column.toLowerCase()));
  const seen = new Set();
  const names = [];
  for (const key of Object.keys(row)) {
    const name = cleanHeader(key);
    const token = name.toLowerCase();
    if (!name || required.has(token) || seen.has(token)) continue;
    seen.add(token);
    names.push(name);
  }
  return names;
}

export function missingColumns(row, kind) {
  const names = new Set(headerNames(row));
  return requiredColumns(kind).filter((column) => !names.has(column.toLowerCase()));
}

const ID_SHARDS = 8;

function shardIndex(key) {
  if (typeof key === "number" && Number.isFinite(key)) return Math.abs(key % ID_SHARDS);
  let hash = 0;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) >>> 0;
  return hash % ID_SHARDS;
}

function createIdSet() {
  const shards = Array.from({ length: ID_SHARDS }, () => new Set());
  return {
    has(key) {
      return shards[shardIndex(key)].has(key);
    },
    add(key) {
      shards[shardIndex(key)].add(key);
    },
    clear() {
      for (const shard of shards) shard.clear();
    },
    get size() {
      let total = 0;
      for (const shard of shards) total += shard.size;
      return total;
    },
  };
}

function createIdMap() {
  const shards = Array.from({ length: ID_SHARDS }, () => new Map());
  return {
    get(key) {
      return shards[shardIndex(key)].get(key);
    },
    set(key, value) {
      shards[shardIndex(key)].set(key, value);
    },
    clear() {
      for (const shard of shards) shard.clear();
    },
    get size() {
      let total = 0;
      for (const shard of shards) total += shard.size;
      return total;
    },
    *[Symbol.iterator]() {
      for (const shard of shards) yield* shard;
    },
  };
}

function vuidKey(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  return text;
}

function normCounty(raw) {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text || /^null$/i.test(text)) return null;
  return text.toUpperCase();
}

/** Ballot-score county key for the county that issued the roster, never the voter-file county. */
export function ballotCountyKey(row) {
  const slug = String(row?.sourceCounty ?? "").trim().toLowerCase();
  if (!slug) return null;
  if (slug === "dewitt") return "DE WITT";
  return slug.replace(/_/g, " ").toUpperCase();
}

function normDistrict(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return null;
  const n = Number(text.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.trunc(n));
}

function parseScore(raw) {
  if (raw == null) return { ok: true, score: null };
  const text = String(raw).trim();
  if (!text || /^null$/i.test(text)) return { ok: true, score: null };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, score: null };
  return { ok: true, score: n };
}

function blankDataset(kind, meta) {
  return {
    kind,
    fileName: meta?.fileName ?? null,
    uploadedAt: meta?.uploadedAt ?? null,
    rows: 0,
    uniqueVuids: 0,
    withScore2022: 0,
    withScore2026: 0,
    rejected: 0,
    rejectedSamples: [],
    duplicatesMerged: 0,
    geographies: 0,
    votingDays: 0,
    statewideRows: 0,
    countyRows: 0,
    houseRows: 0,
    senateRows: 0,
    congressRows: 0,
    validation: "missing",
    error: null,
    detailColumns: [],
  };
}

function reject(stats, rowNumber, reason) {
  stats.rejected += 1;
  if (stats.rejectedSamples.length < 25) {
    stats.rejectedSamples.push({ row: rowNumber, reason });
  }
}

function createGeoBook() {
  const geos = new Map();
  function ensure(kind, key) {
    const id = `${kind}|${key}`;
    let geo = geos.get(id);
    if (!geo) {
      geo = { kind, key, label: geoLabel(kind, key), days: new Map(), all: emptyBucket() };
      geos.set(id, geo);
    }
    return geo;
  }
  function places(county, congress, senate, house) {
    const list = [ensure("state", "TX")];
    if (county) list.push(ensure("county", county));
    if (congress) list.push(ensure("congress", congress));
    if (senate) list.push(ensure("senate", senate));
    if (house) list.push(ensure("house", house));
    return list;
  }
  return { geos, ensure, places };
}

async function streamRows(filePath, onRow) {
  if (!filePath) return;
  const parser = (await openCsvStream(filePath)).pipe(
      parse({
        columns: true,
        bom: true,
        relax_quotes: true,
        relax_column_count: true,
        skip_empty_lines: true,
        trim: true,
      }),
    );
    parser.on("data", (row) => {
      onRow(row);
    });
    await new Promise((resolve, rejectStream) => {
      parser.on("end", resolve);
      parser.on("error", rejectStream);
    });
}

function parseCount(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return { ok: true, value: 0 };
  const n = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: 0 };
  return { ok: true, value: Math.round(n) };
}

function parseAverage(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^null$/i.test(text)) return { ok: true, value: null };
  const n = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(n)) return { ok: false, value: null };
  return { ok: true, value: n };
}

function summarySide(voters, with2022, avg2022, with2026, avg2026) {
  return {
    voters,
    score2022: {
      n: with2022,
      sum: avg2022 == null ? 0 : round4(avg2022 * with2022),
      avg: with2022 > 0 ? avg2022 : null,
    },
    score2026: {
      n: with2026,
      sum: avg2026 == null ? 0 : round4(avg2026 * with2026),
      avg: with2026 > 0 ? avg2026 : null,
    },
  };
}

function summaryPlace(typeRaw, geoRaw) {
  const kind = SUMMARY_GEO_TYPES[String(typeRaw ?? "").trim().toLowerCase().replace(/\s+/g, " ")];
  if (!kind) return null;
  const geo = String(geoRaw ?? "").trim().replace(/\s+/g, " ");
  if (!geo || /^null$/i.test(geo)) return null;
  if (kind === "state") return { kind, key: "TX", label: "Texas" };
  if (kind === "county") {
    const key = geo.toUpperCase();
    return { kind, key, label: titleCounty(key) };
  }
  const n = Number(geo.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const key = String(Math.trunc(n));
  return { kind, key, label: geoLabel(kind, key) };
}

function emptySummaryGeo(place) {
  const byDay = {};
  for (const id of scoreDayIds()) {
    const zero = publish(emptyBucket());
    byDay[String(id)] = { daily: zero, cumulative: zero };
  }
  return { kind: place.kind, key: place.key, label: place.label, all: publish(emptyBucket()), byDay };
}

function finalizeSeries(geos) {
  const out = new Map();
  for (const geo of geos.values()) {
    const byDay = {};
    const mail = geo.days.get(0) || emptyBucket();
    byDay["0"] = {
      daily: publish(mail),
      cumulative: publish({ ...mail }),
    };
    const running = emptyBucket();
    const mailRunning = emptyBucket();
    for (const day of DAY_DEFS) {
      const daily = geo.days.get(day.id) || emptyBucket();
      addBucket(running, daily);
      addBucket(mailRunning, geo.mailOnDay?.get(day.id) || emptyBucket());
      const cumulative = emptyBucket();
      addBucket(cumulative, running);
      addBucket(cumulative, mailRunning);
      byDay[String(day.id)] = {
        daily: publish(daily),
        cumulative: publish(cumulative),
      };
    }
    out.set(`${geo.kind}|${geo.key}`, {
      kind: geo.kind,
      key: geo.key,
      label: geo.label,
      all: publish(geo.all),
      byDay,
    });
  }
  return out;
}

function mergeGroups(lookupGeos, y2022Geos, y2026Geos) {
  const keys = new Set([...lookupGeos.keys(), ...y2022Geos.keys(), ...y2026Geos.keys()]);
  const groups = { county: [], house: [], senate: [], congress: [] };
  let statewide = null;
  for (const id of keys) {
    const lookup = lookupGeos.get(id);
    const y2022 = y2022Geos.get(id);
    const y2026 = y2026Geos.get(id);
    const sample = lookup || y2022 || y2026;
    const byDay = {};
    for (const id of scoreDayIds()) {
      const key = String(id);
      byDay[key] = {
        y2022: y2022?.byDay[key] ?? { daily: publish(emptyBucket()), cumulative: publish(emptyBucket()) },
        y2026: y2026?.byDay[key] ?? { daily: publish(emptyBucket()), cumulative: publish(emptyBucket()) },
      };
    }
    const row = {
      key: sample.key,
      label: sample.label,
      allCurrent: lookup?.all ?? publish(emptyBucket()),
      byDay,
    };
    if (sample.kind === "state") statewide = row;
    else if (groups[sample.kind]) groups[sample.kind].push(row);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => {
      const an = Number(a.key);
      const bn = Number(b.key);
      if (Number.isFinite(an) && Number.isFinite(bn) && String(an) === a.key && String(bn) === b.key) return an - bn;
      return a.label.localeCompare(b.label);
    });
  }
  if (!statewide) {
    statewide = {
      key: "TX",
      label: "Texas",
      allCurrent: publish(emptyBucket()),
      byDay: emptyPublishedDays(),
    };
  }
  return { statewide, groups };
}

/**
 * Each 2026 roster file replaces the previous roster. Rows are one vote per VUID.
 * A repeated VUID in the same file keeps the earliest voting day and is not counted twice.
 */
export async function aggregateBallotFiles({ files, uploads, onProgress }) {
  const datasets = {
    lookup: blankDataset("lookup", uploads?.lookup),
    static2022: blankDataset("static2022", uploads?.static2022),
    roster2026: blankDataset("roster2026", uploads?.roster2026),
  };
  const lookupBook = createGeoBook();
  const y2022Geos = new Map();
  const y2026Book = createGeoBook();
  const roster = createIdMap();

  if (files.roster2026) {
    datasets.roster2026.validation = "valid";
    let scanned = 0;
    let rowNumber = 1;
    let headerError = null;
    await streamRows(files.roster2026, (row) => {
      rowNumber += 1;
      scanned += 1;
      if (scanned === 1) {
        const missing = missingColumns(row, "roster2026");
        if (missing.length) headerError = `Missing columns: ${missing.join(", ")}`;
      }
      if (headerError) return;
      if (scanned % 200000 === 0) onProgress?.({ phase: "roster2026", scanned });
      const vuid = vuidKey(field(row, "VUID"));
      const iso = parseIsoDate(field(row, "VoteDate"));
      const bucket = rosterBucket(iso, field(row, "VotingMethod"), 2026);
      if (vuid == null) {
        reject(datasets.roster2026, rowNumber, "Missing VUID");
        return;
      }
      if (bucket == null) {
        reject(datasets.roster2026, rowNumber, "VoteDate is missing or not a date");
        return;
      }
      datasets.roster2026.rows += 1;
      const previous = roster.get(vuid);
      if (previous == null) roster.set(vuid, { iso, bucket });
      else {
        datasets.roster2026.duplicatesMerged += 1;
        if (iso < previous.iso) roster.set(vuid, { iso, bucket });
      }
    });
    if (headerError) {
      datasets.roster2026.validation = "invalid";
      datasets.roster2026.error = headerError;
      roster.clear();
    } else if (datasets.roster2026.rows === 0) {
      datasets.roster2026.validation = "invalid";
      datasets.roster2026.error = "No usable roster rows";
    }
    datasets.roster2026.uniqueVuids = roster.size;
  }

  const matched = createIdSet();
  if (files.lookup) {
    datasets.lookup.validation = "valid";
    const seen = createIdSet();
    let scanned = 0;
    let rowNumber = 1;
    let headerError = null;
    await streamRows(files.lookup, (row) => {
      rowNumber += 1;
      scanned += 1;
      if (scanned === 1) {
        const missing = missingColumns(row, "lookup");
        if (missing.length) headerError = `Missing columns: ${missing.join(", ")}`;
        else datasets.lookup.detailColumns = lookupDetailColumns(row);
      }
      if (headerError) return;
      if (scanned % 200000 === 0) onProgress?.({ phase: "lookup", scanned });
      const vuid = vuidKey(field(row, "VUID"));
      if (vuid == null) {
        reject(datasets.lookup, rowNumber, "Missing VUID");
        return;
      }
      if (seen.has(vuid)) {
        reject(datasets.lookup, rowNumber, "Duplicate VUID");
        return;
      }
      const score2022 = parseScore(field(row, "Score2022"));
      const score2026 = parseScore(field(row, "Score2026"));
      if (!score2022.ok || !score2026.ok) {
        reject(datasets.lookup, rowNumber, "Score is not a number or blank");
        return;
      }
      seen.add(vuid);
      datasets.lookup.rows += 1;
      if (score2022.score != null) datasets.lookup.withScore2022 += 1;
      if (score2026.score != null) datasets.lookup.withScore2026 += 1;
      const county = normCounty(field(row, "CountyName"));
      const congress = normDistrict(field(row, "USHouse"));
      const senate = normDistrict(field(row, "TXSenate"));
      const house = normDistrict(field(row, "TXHouse"));
      for (const geo of lookupBook.places(county, congress, senate, house)) {
        addScore(geo.all, score2022.score, score2026.score);
      }
      const hit = roster.get(vuid);
      if (hit != null) {
        matched.add(vuid);
        if (score2022.score != null) datasets.roster2026.withScore2022 += 1;
        if (score2026.score != null) datasets.roster2026.withScore2026 += 1;
        for (const geo of y2026Book.places(county, congress, senate, house)) {
          recordRosterVote(geo, hit, score2022.score, score2026.score);
        }
      }
    });
    if (headerError) {
      datasets.lookup.validation = "invalid";
      datasets.lookup.error = headerError;
      datasets.lookup.rows = 0;
      datasets.lookup.withScore2022 = 0;
      datasets.lookup.withScore2026 = 0;
      datasets.lookup.detailColumns = [];
    } else if (datasets.lookup.rows === 0) {
      datasets.lookup.validation = "invalid";
      datasets.lookup.error = "No usable lookup rows";
    }
    datasets.lookup.uniqueVuids = datasets.lookup.validation === "valid" ? seen.size : 0;
  }

  if (datasets.lookup.validation === "invalid") {
    lookupBook.geos.clear();
    y2026Book.geos.clear();
    matched.clear();
    datasets.roster2026.withScore2022 = 0;
    datasets.roster2026.withScore2026 = 0;
  }

  const unmatchedRoster = [];
  if (datasets.roster2026.validation === "valid") {
    for (const [vuid, hit] of roster) {
      if (matched.has(vuid)) continue;
      unmatchedRoster.push(vuid);
      recordRosterVote(y2026Book.ensure("state", "TX"), hit, null, null);
    }
    if (!files.lookup) {
      datasets.roster2026.error = "Current voter lookup is not loaded, so 2026 voters have no geography or scores yet.";
    }
  }

  if (files.static2022) {
    datasets.static2022.validation = "valid";
    const seen = new Set();
    const places = new Set();
    const days = new Set();
    let scanned = 0;
    let rowNumber = 1;
    let headerError = null;
    await streamRows(files.static2022, (row) => {
      rowNumber += 1;
      scanned += 1;
      if (scanned === 1) {
        const missing = missingColumns(row, "static2022");
        if (missing.length) headerError = `Missing columns: ${missing.join(", ")}`;
      }
      if (headerError) return;
      if (scanned % 200000 === 0) onProgress?.({ phase: "static2022", scanned });
      const place = summaryPlace(field(row, "GeographyType"), field(row, "Geography"));
      const day = parseVotingDayNumber(field(row, "VotingDay"));
      if (!place) {
        reject(datasets.static2022, rowNumber, "GeographyType or Geography is not recognized");
        return;
      }
      if (day == null) {
        reject(datasets.static2022, rowNumber, "VotingDay must be 0 through 12");
        return;
      }
      const counts = [
        parseCount(field(row, "DailyVoters")),
        parseCount(field(row, "DailyVotersWith2022Score")),
        parseCount(field(row, "DailyVotersWith2026Score")),
        parseCount(field(row, "CumulativeVoters")),
        parseCount(field(row, "CumulativeVotersWith2022Score")),
        parseCount(field(row, "CumulativeVotersWith2026Score")),
      ];
      const averages = [
        parseAverage(field(row, "Daily2022Average")),
        parseAverage(field(row, "Daily2026Average")),
        parseAverage(field(row, "Cumulative2022Average")),
        parseAverage(field(row, "Cumulative2026Average")),
      ];
      if (counts.some((item) => !item.ok) || averages.some((item) => !item.ok)) {
        reject(datasets.static2022, rowNumber, "A voter count or average is not a number");
        return;
      }
      const slot = `${place.kind}|${place.key}|${day}`;
      if (seen.has(slot)) {
        reject(datasets.static2022, rowNumber, "Duplicate geography and voting day");
        return;
      }
      seen.add(slot);
      places.add(`${place.kind}|${place.key}`);
      days.add(day);
      datasets.static2022.rows += 1;
      if (place.kind === "state") datasets.static2022.statewideRows += 1;
      if (place.kind === "county") datasets.static2022.countyRows += 1;
      if (place.kind === "house") datasets.static2022.houseRows += 1;
      if (place.kind === "senate") datasets.static2022.senateRows += 1;
      if (place.kind === "congress") datasets.static2022.congressRows += 1;
      const id = `${place.kind}|${place.key}`;
      const geo = y2022Geos.get(id) ?? emptySummaryGeo(place);
      y2022Geos.set(id, geo);
      let [dailyVoters, daily2022n, daily2026n, cumVoters, cum2022n, cum2026n] = counts.map((item) => item.value);
      let [daily2022, daily2026, cum2022, cum2026] = averages.map((item) => item.value);
      if (day === 0 && cumVoters === 0) {
        cumVoters = dailyVoters;
        cum2022n = daily2022n;
        cum2026n = daily2026n;
        cum2022 = daily2022;
        cum2026 = daily2026;
      }
      geo.byDay[String(day)] = {
        daily: summarySide(dailyVoters, daily2022n, daily2022, daily2026n, daily2026),
        cumulative: summarySide(cumVoters, cum2022n, cum2022, cum2026n, cum2026),
      };
    });
    if (headerError) {
      datasets.static2022.validation = "invalid";
      datasets.static2022.error = headerError;
      datasets.static2022.rows = 0;
      y2022Geos.clear();
    } else if (datasets.static2022.rows === 0) {
      datasets.static2022.validation = "invalid";
      datasets.static2022.error = "No usable 2022 summary rows";
    }
    datasets.static2022.geographies = places.size;
    datasets.static2022.votingDays = days.size;
  }

  onProgress?.({ phase: "finalize", scanned: 0 });
  const { statewide, groups } = mergeGroups(
    datasets.lookup.validation === "valid" ? finalizeSeries(lookupBook.geos) : new Map(),
    datasets.static2022.validation === "valid" ? y2022Geos : new Map(),
    datasets.roster2026.validation === "valid" ? finalizeSeries(y2026Book.geos) : new Map(),
  );

  return {
    datasets,
    model: {
      generatedAt: new Date().toISOString(),
      rosterMode: "replace",
      days: DAY_DEFS,
      rosterJoin: {
        uniqueVuids: roster.size,
        matched: matched.size,
        unmatched: unmatchedRoster.length,
      },
      statewide,
      groups,
    },
  };
}

function storedScore(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function emptySide() {
  return publish(emptyBucket());
}

function countyLetters(raw) {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
}

/** Voter-file CD, SD, and HD count only when the ballot county matches that file. */
function ballotDistricts(row) {
  const voted = countyLetters(row?.sourceCounty);
  const registered = countyLetters(row?.registeredCounty);
  const stored = countyLetters(row?.county);
  const fileCounty = registered || (voted && stored && stored !== voted ? stored : "");
  if (voted && fileCounty && voted !== fileCounty) return { congress: null, senate: null, house: null };
  return {
    congress: normDistrict(row?.usHouse),
    senate: normDistrict(row?.txSenate),
    house: normDistrict(row?.txHouse),
  };
}

/**
 * County roster pulls are the live 2026 vote list. Each VUID counts once, on the
 * earliest vote date. The county total uses the county that published the roster.
 * Congressional, senate, and house totals use the voter file only when that county matches.
 * Mail ballots count together as voting day 0, and each one also enters the
 * cumulative on the voting day of its vote date.
 */
export function liveRosterSeries(voters) {
  const book = createGeoBook();
  const seen = new Map();
  for (const row of voters ?? []) {
    const vuid = vuidKey(row.vuid);
    const iso = parseIsoDate(row.voteDate);
    const bucket = rosterBucket(iso, row.votingMethod, 2026);
    if (vuid == null || bucket == null) continue;
    const hit = {
      bucket,
      iso,
      matched: row.matched === 1,
      county: ballotCountyKey(row) ?? normCounty(row.county),
      ...ballotDistricts(row),
      score2022: storedScore(row.score2022),
      score2026: storedScore(row.score2026),
    };
    const previous = seen.get(vuid);
    if (!previous || iso < previous.iso || (iso === previous.iso && hit.matched && !previous.matched)) {
      seen.set(vuid, hit);
    }
  }
  let matched = 0;
  let unmatched = 0;
  for (const hit of seen.values()) {
    if (hit.matched) {
      matched += 1;
      for (const geo of book.places(hit.county, hit.congress, hit.senate, hit.house)) {
        recordRosterVote(geo, hit, hit.score2022, hit.score2026);
      }
    } else {
      unmatched += 1;
      recordRosterVote(book.ensure("state", "TX"), hit, null, null);
    }
  }
  return {
    geos: finalizeSeries(book.geos),
    uniqueVuids: seen.size,
    matched,
    unmatched,
  };
}

function emptyYearSide() {
  return { daily: emptySide(), cumulative: emptySide() };
}

function clearY2026(row) {
  if (!row) return;
  row.byDay = row.byDay ?? {};
  for (const key of Object.keys(row.byDay)) {
    if (key.startsWith("mail:")) delete row.byDay[key];
  }
  for (const id of scoreDayIds()) {
    const key = String(id);
    const slot = row.byDay[key] ?? { y2022: emptyYearSide() };
    slot.y2026 = emptyYearSide();
    row.byDay[key] = slot;
  }
}

function paintY2026(row, source) {
  for (const id of scoreDayIds()) {
    const key = String(id);
    if (!row.byDay[key]) row.byDay[key] = { y2022: emptyYearSide(), y2026: emptyYearSide() };
    row.byDay[key].y2026 = source.byDay[key] ?? emptyYearSide();
  }
}

function rowFromLive(source) {
  const byDay = {};
  for (const id of scoreDayIds()) {
    const key = String(id);
    byDay[key] = {
      y2022: emptyYearSide(),
      y2026: source.byDay[key] ?? emptyYearSide(),
    };
  }
  return {
    key: source.key,
    label: source.label,
    allCurrent: emptySide(),
    byDay,
  };
}

function addPublished(target, extra) {
  if (!extra?.voters) return target;
  const combine = (left, right) => {
    const n = (left?.n ?? 0) + (right?.n ?? 0);
    const sum = (left?.sum ?? 0) + (right?.sum ?? 0);
    return { n, sum, avg: n ? round4(sum / n) : null };
  };
  return {
    voters: (target?.voters ?? 0) + extra.voters,
    score2022: combine(target?.score2022, extra.score2022),
    score2026: combine(target?.score2026, extra.score2026),
  };
}

/** 2022 mail is one total in the static file, so it counts in every voting-day cumulative. */
export function includeStaticMailInCumulative(model) {
  if (!model) return model;
  const rows = [
    model.statewide,
    ...(model.groups?.county ?? []),
    ...(model.groups?.house ?? []),
    ...(model.groups?.senate ?? []),
    ...(model.groups?.congress ?? []),
  ];
  for (const row of rows) {
    const mail = row?.byDay?.["0"]?.y2022?.cumulative;
    if (!mail?.voters) continue;
    for (const day of DAY_DEFS) {
      const slot = row.byDay[String(day.id)]?.y2022;
      if (!slot?.cumulative) continue;
      slot.cumulative = addPublished(slot.cumulative, mail);
    }
  }
  return model;
}

export function applyLiveRosterToModel(model, voters) {
  if (!model || !Array.isArray(voters) || voters.length === 0) return model;
  const series = liveRosterSeries(voters);
  if (!series.uniqueVuids) return model;
  if (model.statewide) {
    clearY2026(model.statewide);
    const state = series.geos.get("state|TX");
    if (state) paintY2026(model.statewide, state);
  }
  model.groups = model.groups ?? { county: [], house: [], senate: [], congress: [] };
  for (const kind of ["county", "house", "senate", "congress"]) {
    const list = model.groups[kind] ?? [];
    model.groups[kind] = list;
    for (const row of list) clearY2026(row);
    for (const source of series.geos.values()) {
      if (source.kind !== kind) continue;
      const existing = list.find((row) => row.key === source.key);
      if (existing) paintY2026(existing, source);
      else list.push(rowFromLive(source));
    }
  }
  model.rosterJoin = {
    uniqueVuids: series.uniqueVuids,
    matched: series.matched,
    unmatched: series.unmatched,
  };
  model.rosterSource = "county-roster";
  return model;
}
