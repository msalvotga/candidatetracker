import XLSX from "xlsx";

const EXPORT_CATEGORIES = [
  { category: "house", sheetName: "Texas House" },
  { category: "senate", sheetName: "Texas Senate" },
  { category: "sboe", sheetName: "SBOE" },
  { category: "statewide", sheetName: "Statewide" },
  { category: "congressional", sheetName: "Congressional" },
];

const HEADERS = [
  "Seat",
  "Incumbent Name",
  "Incumbent Party",
  "Incumbent On Ballot?",
  "Democrat Candidate on Ballot",
  "Republican Candidate on Ballot",
];

function partyLabel(party) {
  const code = String(party ?? "").trim().toUpperCase();
  if (code === "R") return "Republican";
  if (code === "D") return "Democrat";
  if (code === "I") return "Independent";
  if (code === "L") return "Libertarian";
  if (code === "G") return "Green";
  if (code === "O") return "Other";
  return code || "";
}

function groupByOffice(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.office_id)) map.set(row.office_id, []);
    map.get(row.office_id).push(row);
  }
  return map;
}

function activeCandidates(rows) {
  return rows
    .filter((row) => !row.withdrew)
    .map((row) => ({
      name: String(row.name ?? "").trim(),
      party: String(row.party ?? "").trim(),
      is_incumbent: Boolean(row.is_incumbent),
      running_for_reelection: row.running_for_reelection ?? null,
    }))
    .filter((candidate) => candidate.name && candidate.party);
}

function incumbentOnBallot(candidates) {
  const incumbentCandidate = candidates.find((candidate) => candidate.is_incumbent);
  if (incumbentCandidate) {
    const running = String(incumbentCandidate.running_for_reelection ?? "").trim().toLowerCase();
    if (running === "no") return "No";
    if (running === "yes") return "Yes";
    return "Yes";
  }

  return "No";
}

function partyBallotNames(candidates, party, onBallot, seatHolderName, seatHolderParty) {
  const names = new Set();

  for (const candidate of candidates) {
    if (candidate.party !== party) continue;
    if (candidate.is_incumbent && onBallot === "No") continue;
    names.add(candidate.name);
  }

  if (onBallot === "Yes" && seatHolderParty === party) {
    const holder = String(seatHolderName ?? "").trim();
    if (holder) names.add(holder);
  }

  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .join("; ");
}

export async function buildBallotRowsForCategory(database, category, cycleYear) {
  const offices = await database
    .prepare(
      `SELECT id, office_name, seat_holder_name, seat_holder_party
       FROM offices
       WHERE category = ?
       ORDER BY sort_order, district, office_code`
    )
    .all(category);

  const dbCandidates = await database
    .prepare(
      `SELECT c.office_id, c.name, c.party, c.is_incumbent, c.withdrew, c.running_for_reelection
       FROM candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE o.category = ? AND c.cycle_year = ?`
    )
    .all(category, cycleYear);

  const candidatesByOffice = groupByOffice(dbCandidates);

  return offices.map((office) => {
    const officeCandidates = activeCandidates(candidatesByOffice.get(office.id) ?? []);
    const onBallot = incumbentOnBallot(officeCandidates);
    const holderName = String(office.seat_holder_name ?? "").trim();
    const holderParty = String(office.seat_holder_party ?? "").trim();

    return {
      Seat: office.office_name,
      "Incumbent Name": holderName,
      "Incumbent Party": partyLabel(holderParty),
      "Incumbent On Ballot?": onBallot,
      "Democrat Candidate on Ballot": partyBallotNames(
        officeCandidates,
        "D",
        onBallot,
        holderName,
        holderParty
      ),
      "Republican Candidate on Ballot": partyBallotNames(
        officeCandidates,
        "R",
        onBallot,
        holderName,
        holderParty
      ),
    };
  });
}

export async function buildBallotSummaryWorkbook(database, cycleYear) {
  const workbook = XLSX.utils.book_new();

  for (const { category, sheetName } of EXPORT_CATEGORIES) {
    const rows = await buildBallotRowsForCategory(database, category, cycleYear);
    const sheet = XLSX.utils.json_to_sheet(rows, { header: HEADERS });
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  }

  return workbook;
}
