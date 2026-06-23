/** Canonical statewide contests for district-composite metrics (no per-district vote breakdown stored). */

export const METRIC_LABELS = {
  trump_2024: "2024 President",
  cruz_2024: "2024 U.S. Senate",
  abbott_2022: "2022 Governor",
  leg_2024: "2024 race",
  leg_2022: "2022 race",
};

export const CANONICAL_CONTESTS = {
  trump_2024: {
    contestName: "2024 President",
    candidates: [
      { name: "Donald Trump", party: "R" },
      { name: "Kamala Harris", party: "D" },
    ],
  },
  cruz_2024: {
    contestName: "2024 U.S. Senate",
    candidates: [
      { name: "Ted Cruz", party: "R" },
      { name: "Colin Allred", party: "D" },
    ],
  },
  abbott_2022: {
    contestName: "2022 Governor",
    candidates: [
      { name: "Greg Abbott", party: "R" },
      { name: "Beto O'Rourke", party: "D" },
    ],
  },
};

export function detectUncontested(rows, gopShare) {
  if (rows.some((row) => row.unopposed)) {
    const winner = rows.find((row) => row.party === "R") ?? rows.find((row) => row.party === "D") ?? rows[0];
    return { uncontested: true, winning_party: winner?.party ?? null };
  }

  if (rows.length === 0) {
    return { uncontested: false, winning_party: null };
  }

  const parties = new Set(rows.map((row) => row.party));
  if (parties.has("R") && !parties.has("D")) {
    return { uncontested: true, winning_party: "R" };
  }
  if (parties.has("D") && !parties.has("R")) {
    return { uncontested: true, winning_party: "D" };
  }

  if (rows.length === 1 && (gopShare === 1 || gopShare === 0)) {
    return { uncontested: true, winning_party: rows[0].party };
  }

  return { uncontested: false, winning_party: null };
}

export function buildDerivedContest(metricKey, marginOrShare, label) {
  const canonical = CANONICAL_CONTESTS[metricKey];
  if (!canonical || marginOrShare == null) return null;

  const gopShare = 0.5 + marginOrShare / 2;
  const repPct = gopShare;
  const demPct = 1 - gopShare;

  return {
    metric_key: metricKey,
    label,
    contest_name: canonical.contestName,
    gop_share: marginOrShare,
    derived: true,
    note: "Two-party share for this district. Vote totals are not stored for this benchmark.",
    candidates: canonical.candidates.map((candidate) => ({
      candidate_name: candidate.name,
      party: candidate.party,
      votes: null,
      vote_pct: candidate.party === "R" ? repPct : demPct,
      unopposed: false,
    })),
  };
}

export function buildContestResponse(office, metricKey, label, gopShare, rows) {
  if (rows.length > 0) {
    const contestName = rows.find((r) => r.contest_name)?.contest_name ?? label;
    const { uncontested, winning_party } = detectUncontested(rows, gopShare);
    return {
      office_id: office.id,
      office_code: office.office_code,
      office_name: office.office_name,
      metric_key: metricKey,
      label,
      contest_name: contestName,
      gop_share: gopShare,
      uncontested,
      winning_party,
      derived: false,
      source: rows[0]?.source ?? "ted",
      candidates: rows.map((row) => ({
        candidate_name: row.candidate_name,
        party: row.party,
        votes: row.votes,
        vote_pct: row.vote_pct,
        unopposed: Boolean(row.unopposed),
      })),
    };
  }

  const derived = buildDerivedContest(metricKey, gopShare, label);
  if (!derived) return null;

  return {
    office_id: office.id,
    office_code: office.office_code,
    office_name: office.office_name,
    ...derived,
  };
}
