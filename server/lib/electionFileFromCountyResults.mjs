import { getLatestCountyRows } from "../db.mjs";

function slugPart(s) {
  return String(s)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 64);
}

/** Stable short id from full string — avoids duplicate React keys when slug prefixes collide after truncation. */
function fingerprint(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function emptyElectionFile(electionKey, navLabel) {
  return {
    schemaVersion: 1,
    source: { id: "county-feeds", label: "County feeds", type: "county" },
    election: { id: String(electionKey), label: navLabel, navTitle: navLabel },
    reporting: {
      counties: { reported: 0, total: 0 },
      pollingLocations: { reported: 0, total: 0 },
      lastUpdated: new Date().toISOString(),
      resultStatus: "No county results yet — run ingest after configuring feeds.",
    },
    races: [],
  };
}

/**
 * Build a dashboard {@link ElectionFile} from `county_results` only (no Civix SOS payload).
 * Used for configured elections where SOS/Civix ingest is off.
 */
export async function buildElectionFileFromCountyFeeds(electionKey, navLabel) {
  const byCounty = await getLatestCountyRows(String(electionKey));
  const countyNames = Object.keys(byCounty).sort((a, b) => a.localeCompare(b));

  if (!countyNames.length) return emptyElectionFile(electionKey, navLabel);

  /** @type {Map<string, Map<string, { choiceName: string, partyName: string, earlyVotes: number, electionDayVotes: number, totalVotes: number }>>} */
  const contestAgg = new Map();

  for (const countyName of countyNames) {
    for (const row of byCounty[countyName] ?? []) {
      const cn = String(row.contestName ?? "").trim();
      if (!cn) continue;
      const choiceName = String(row.choiceName ?? "").trim();
      const partyName = String(row.partyName ?? "").trim() || "—";
      const ck = `${choiceName}\u0000${partyName}`;
      if (!contestAgg.has(cn)) contestAgg.set(cn, new Map());
      const m = contestAgg.get(cn);
      const prev = m.get(ck) ?? {
        choiceName,
        partyName,
        earlyVotes: 0,
        electionDayVotes: 0,
        totalVotes: 0,
      };
      prev.earlyVotes += Number(row.earlyVotes ?? 0);
      prev.electionDayVotes += Number(row.electionDayVotes ?? 0);
      prev.totalVotes += Number(row.totalVotes ?? 0);
      m.set(ck, prev);
    }
  }

  const races = [];
  const ek = slugPart(String(electionKey));
  let raceIdx = 0;

  for (const [contestName, candMap] of contestAgg) {
    const fp = fingerprint(contestName);
    const raceId = `race-${raceIdx}-${fp}-${ek}`;
    /** @type {{ id: string, name: string, party: string, earlyVotes: number, totalVotes: number }[]} */
    const candidates = [];
    /** @type {Map<string, string>} */
    const candByKey = new Map();
    let ci = 0;
    for (const [ck, agg] of candMap) {
      ci++;
      const id = `cand-${raceIdx}-${ci}-${fp}-${ek}`;
      candByKey.set(ck, id);
      candidates.push({
        id,
        name: agg.choiceName,
        party: agg.partyName,
        earlyVotes: agg.earlyVotes,
        totalVotes: agg.totalVotes,
      });
    }

    const countyBlocks = [];
    let coIdx = 0;
    let reportedSum = 0;
    let totalSum = 0;

    for (const countyName of countyNames) {
      const rows = (byCounty[countyName] ?? []).filter((r) => String(r.contestName ?? "").trim() === contestName);
      if (!rows.length) continue;
      const pr = Number(rows[0]?.precinctReporting ?? 0);
      const pt = Number(rows[0]?.precinctTotal ?? 0);
      reportedSum += pr;
      totalSum += pt;
      const precinctsReporting = `${pr.toLocaleString()} of ${pt.toLocaleString()} precincts reporting`;

      /** @type {Record<string, { earlyVotes: number, electionDayVotes: number, totalVotes: number }>} */
      const candVotes = {};
      for (const row of rows) {
        const choiceName = String(row.choiceName ?? "").trim();
        const partyName = String(row.partyName ?? "").trim() || "—";
        const ck = `${choiceName}\u0000${partyName}`;
        const cid = candByKey.get(ck);
        if (!cid) continue;
        candVotes[cid] = {
          earlyVotes: Number(row.earlyVotes ?? 0),
          electionDayVotes: Number(row.electionDayVotes ?? 0),
          totalVotes: Number(row.totalVotes ?? 0),
        };
      }

      coIdx += 1;
      countyBlocks.push({
        id: `co-${raceIdx}-${coIdx}-${slugPart(countyName) || "x"}-${fp}`,
        name: countyName.replace(/\s+/g, " ").trim(),
        sourceTag: "CNTY",
        precinctsReporting,
        precinctReportingCount: pr,
        precinctTotalCount: pt,
        candidates: candVotes,
      });
    }

    const totalRow = {
      id: "_total",
      name: "ALL COUNTIES",
      sourceTag: "CNTY",
      isTotalRow: true,
      precinctsReporting: `${reportedSum.toLocaleString()} of ${totalSum.toLocaleString()} precincts reporting (rolled)`,
      candidates: Object.fromEntries(
        candidates.map((c) => [
          c.id,
          {
            earlyVotes: c.earlyVotes,
            electionDayVotes: Math.max(c.totalVotes - c.earlyVotes, 0),
            totalVotes: c.totalVotes,
          },
        ]),
      ),
    };

    races.push({
      id: raceId,
      officeType: "LOCAL",
      title: contestName,
      candidates,
      counties: [totalRow, ...countyBlocks],
    });
    raceIdx += 1;
  }

  const lastUpdated = new Date().toISOString();
  return {
    schemaVersion: 1,
    source: { id: "county-feeds", label: "County feeds", type: "county" },
    election: {
      id: String(electionKey),
      label: navLabel,
      navTitle: navLabel,
    },
    reporting: {
      counties: { reported: countyNames.length, total: countyNames.length },
      pollingLocations: { reported: 0, total: 0 },
      lastUpdated,
      resultStatus: "Unofficial results",
    },
    races,
  };
}
