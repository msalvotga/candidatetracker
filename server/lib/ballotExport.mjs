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

function mergeCandidatesForOffice(sheetRows, dbCandidates) {
  const map = new Map();

  const add = (name, party, isIncumbent, withdrew) => {
    const trimmedName = String(name ?? "").trim();
    const trimmedParty = String(party ?? "").trim();
    if (!trimmedName || !trimmedParty) return;
    const key = `${trimmedName.toLowerCase()}|${trimmedParty}|${isIncumbent ? 1 : 0}`;
    const existing = map.get(key);
    const next = {
      name: trimmedName,
      party: trimmedParty,
      is_incumbent: Boolean(isIncumbent),
      withdrew: Boolean(withdrew),
    };
    if (!existing || next.withdrew === false) {
      map.set(key, next);
    }
  };

  for (const row of sheetRows) {
    add(row.incumbent_name, row.incumbent_party, true, false);
    add(row.candidate_name, row.candidate_party, false, false);
  }

  for (const row of dbCandidates) {
    add(row.name, row.party, row.is_incumbent, row.withdrew);
  }

  return [...map.values()].filter((candidate) => !candidate.withdrew);
}

function incumbentOnBallot(sheetRows, candidates) {
  const sheetIncumbent = sheetRows.find((row) => String(row.incumbent_name ?? "").trim());
  if (sheetIncumbent) {
    const running = String(sheetIncumbent.running_for_reelection ?? "").trim().toLowerCase();
    if (running === "no") return "No";
    if (running === "yes") return "Yes";
  }

  const incumbentCandidate = candidates.find((candidate) => candidate.is_incumbent);
  if (incumbentCandidate) return "Yes";

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

export function buildBallotRowsForCategory(database, category, cycleYear) {
  const offices = database
    .prepare(
      `SELECT id, office_name, seat_holder_name, seat_holder_party
       FROM offices
       WHERE category = ?
       ORDER BY sort_order, district, office_code`
    )
    .all(category);

  const sheetRows = database
    .prepare(
      `SELECT office_id, incumbent_name, incumbent_party, running_for_reelection,
              candidate_name, candidate_party
       FROM race_sheet_rows
       WHERE category = ? AND cycle_year = ?`
    )
    .all(category, cycleYear);

  const dbCandidates = database
    .prepare(
      `SELECT c.office_id, c.name, c.party, c.is_incumbent, c.withdrew
       FROM candidates c
       JOIN offices o ON o.id = c.office_id
       WHERE o.category = ? AND c.cycle_year = ?`
    )
    .all(category, cycleYear);

  const sheetByOffice = groupByOffice(sheetRows);
  const candidatesByOffice = groupByOffice(dbCandidates);

  return offices.map((office) => {
    const officeSheetRows = sheetByOffice.get(office.id) ?? [];
    const officeCandidates = mergeCandidatesForOffice(
      officeSheetRows,
      candidatesByOffice.get(office.id) ?? []
    );

    const onBallot = incumbentOnBallot(officeSheetRows, officeCandidates);
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

export function buildBallotWorkbookBuffer(database, cycleYear) {
  const workbook = XLSX.utils.book_new();

  for (const { category, sheetName } of EXPORT_CATEGORIES) {
    const rows = buildBallotRowsForCategory(database, category, cycleYear);
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: HEADERS });
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
