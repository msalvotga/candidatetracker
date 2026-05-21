/** @param {number} yy 0–99 */
function expandTwoDigitYear(yy) {
  return yy > 50 ? 1900 + yy : 2000 + yy;
}

/** Excel day serial (1900 date system) → YYYY-MM-DD UTC. */
function isoFromExcelSerial(n) {
  if (!Number.isFinite(n) || n < 20000 || n >= 1000000) return "";
  const utcMs = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(utcMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Normalize pull date or filename fragment to YYYY-MM-DD. */
export function toIsoDateKey(input) {
  const s = String(input ?? "").trim();
  if (!s) return "";

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const isoPrefix = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoPrefix) return `${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`;

  const civix = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\b|\s|T|$)/.exec(s);
  if (civix) {
    const mm = civix[1].padStart(2, "0");
    const dd = civix[2].padStart(2, "0");
    const yRaw = civix[3];
    const yyyy = yRaw.length === 2 ? String(expandTwoDigitYear(Number(yRaw))) : yRaw;
    return `${yyyy}-${mm}-${dd}`;
  }

  const civixWithTime = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+\d{1,2}:\d{2}/.exec(s);
  if (civixWithTime) {
    const mm = civixWithTime[1].padStart(2, "0");
    const dd = civixWithTime[2].padStart(2, "0");
    const yRaw = civixWithTime[3];
    const yyyy = yRaw.length === 2 ? String(expandTwoDigitYear(Number(yRaw))) : yRaw;
    return `${yyyy}-${mm}-${dd}`;
  }

  const excelIso = isoFromExcelSerial(Number(s));
  if (excelIso) return excelIso;

  return s.slice(0, 10);
}

/** Format a pull or activity date as YYYYMMDD for export/display. */
export function toYyyymmddKey(input) {
  const iso = toIsoDateKey(input);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[1]}${m[2]}${m[3]}` : "";
}

/**
 * True when a ZIP member name likely belongs to the pull's early-voting day.
 * @param {string} entryName
 * @param {string} votingDateIso YYYY-MM-DD
 */
/** @param {string} blob */
function blobContainsVotingDateIso(blob, iso) {
  const [y, m, d] = iso.split("-");
  const lower = blob.toLowerCase();
  const civixAnywhere = new RegExp(
    `(?:^|[^0-9])${Number(m)}/${Number(d)}/${y}(?:[^0-9]|$)`,
  );
  if (civixAnywhere.test(blob)) return true;
  if (lower.includes(`${m}/${d}/${y}`) || lower.includes(`${m}-${d}-${y}`)) return true;
  if (lower.includes(`${m}.${d}.${y}`) || lower.includes(`${m}_${d}_${y}`)) return true;
  return false;
}

export function entryMatchesVotingDate(entryName, votingDateIso) {
  const iso = toIsoDateKey(votingDateIso);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return true;
  const name = String(entryName ?? "");
  if (blobContainsVotingDateIso(name, iso)) return true;
  const [y, m, d] = iso.split("-");
  const lower = name.toLowerCase();
  const compact = [
    `${m}${d}${y}`,
    `${y}${m}${d}`,
    `${m}${d}${y.slice(2)}`,
    `${y.slice(2)}${m}${d}`,
  ];
  if (compact.some((c) => name.includes(c))) return true;
  if (name.includes(`${y}-${m}-${d}`) || name.includes(`${m}-${d}-${y}`)) return true;
  if (name.includes(`${m}-${d}-${y.slice(2)}`)) return true;
  if (name.includes(`${m}_${d}_${y}`) || name.includes(`${m}.${d}.${y}`)) return true;
  const mdY = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(name);
  if (mdY) {
    const fileIso = `${mdY[3]}-${mdY[1].padStart(2, "0")}-${mdY[2].padStart(2, "0")}`;
    if (fileIso === iso) return true;
  }
  const mdYy = /(?:^|[^0-9])(\d{2})\.(\d{2})\.(\d{2})(?:[^0-9]|$)/.exec(name);
  if (mdYy) {
    const yyyy = String(expandTwoDigitYear(Number(mdYy[3])));
    const fileIso = `${yyyy}-${mdYy[1]}-${mdYy[2]}`;
    if (fileIso === iso) return true;
  }
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const mi = Number(m) - 1;
  if (mi >= 0 && mi < 12) {
    const mon = monthNames[mi];
    if (name.includes(`${mon}_${d}`) || name.includes(`${mon}${d}`) || name.includes(`${mon} ${d}`)) {
      if (name.includes(y) || name.includes(y.slice(2))) return true;
    }
  }
  const mmdd = `${m}${d}`;
  if (new RegExp(`(?:^|[^0-9])${mmdd}(?:[^0-9]|$)`).test(name)) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} votingDateIso
 */
export function rowMatchesVotingDate(row, votingDateIso) {
  const iso = toIsoDateKey(votingDateIso);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return true;
  const candidates = [
    row.activityDate,
    row.activity_date,
    row.ActivityDate,
    row["Activity Date"],
    row["Return Date"],
    row.returnDate,
    row.DATE,
    row.Date,
    row.date,
    row.VOTING_DATE,
    row.VotingDate,
    row.voting_date,
    row.VOTE_DATE,
    row.EARLY_VOTING_DATE,
    row.VoteDate,
    row.VOTEDATE,
    row["Mail Date"],
    row["Received Date"],
    row["Return Date"],
  ];
  for (const c of candidates) {
    const v = String(c ?? "").trim();
    if (!v) continue;
    if (toIsoDateKey(v) === iso) return true;
  }
  return false;
}
