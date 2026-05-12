import type {
  CandidateInput,
  CountyRowInput,
  ElectionFile,
  RaceInput,
  ReportingSnapshot,
} from "../../types/election";
import type { CivixCountyBlock } from "./api";
import { decodeCountyIndex, decodeElectionSection } from "./api";

interface CivixHome {
  ElecDate: string;
  CountiesReporting: { CR: number; CT: number };
  LastUpdatedTime: string;
  RefreshTime: number;
  PrecinctsReporting: { PR: number; PT: number };
  PollingReporting: { PLR: number; PLT: number };
}

interface CivixRace {
  id: number;
  N: string;
  Candidates?: CivixCand[];
}

interface CivixCand {
  ID: number | null;
  N: string;
  P: string | null;
  V: number;
  EV: number;
  O?: number;
}

interface CivixSection {
  OffType: string;
  OffTypeID: number;
  Races: CivixRace[];
}

const SECTION_KEYS = ["Federal", "StateWide", "Districted", "StateWideQ"] as const;

function mapCandidates(race: CivixRace): CandidateInput[] {
  const list = race.Candidates ?? [];
  return list.map((c, idx) => ({
    id: c.ID != null ? String(c.ID) : `synth-${race.id}-${idx}-${slug(c.N)}`,
    name: c.N,
    party: c.P ?? "—",
    incumbent: /\([iI]\)/.test(c.N),
    earlyVotes: Number(c.EV ?? 0),
    totalVotes: Number(c.V ?? 0),
  }));
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);
}

function findCountyCell(
  raceBlock: CivixCountyBlock["Races"][string],
  sc: CandidateInput,
): { earlyVotes: number; electionDayVotes: number; totalVotes: number } {
  const direct = raceBlock.C[sc.id];
  if (direct) {
    const earlyVotes = Number(direct.EV ?? 0);
    const totalVotes = Number(direct.V ?? 0);
    const electionDayVotes = Number(direct.ED ?? Math.max(totalVotes - earlyVotes, 0));
    return { earlyVotes, electionDayVotes, totalVotes };
  }
  const byName = Object.values(raceBlock.C).find((x) => x.N === sc.name);
  if (byName) {
    const earlyVotes = Number(byName.EV ?? 0);
    const totalVotes = Number(byName.V ?? 0);
    const electionDayVotes = Number(byName.ED ?? Math.max(totalVotes - earlyVotes, 0));
    return { earlyVotes, electionDayVotes, totalVotes };
  }
  return { earlyVotes: 0, electionDayVotes: 0, totalVotes: 0 };
}

function buildCountyRows(
  raceOid: number,
  stateCandidates: CandidateInput[],
  countyRoot: Record<string, CivixCountyBlock>,
  home: CivixHome,
): CountyRowInput[] {
  const oid = String(raceOid);
  const poll = home.PollingReporting;
  const pollLine = `${poll.PLR.toLocaleString()} of ${poll.PLT.toLocaleString()} polling locations reporting`;

  const total: CountyRowInput = {
    id: "_total",
    name: "ALL COUNTIES",
    sourceTag: "MIX",
    isTotalRow: true,
    precinctsReporting: pollLine,
    candidates: Object.fromEntries(
      stateCandidates.map((c) => [
        c.id,
        { earlyVotes: c.earlyVotes, electionDayVotes: Math.max(c.totalVotes - c.earlyVotes, 0), totalVotes: c.totalVotes },
      ]),
    ),
  };

  const countyIds = Object.keys(countyRoot).sort((a, b) =>
    countyRoot[a]!.N.localeCompare(countyRoot[b]!.N, "en"),
  );

  const rows: CountyRowInput[] = [total];
  for (const cid of countyIds) {
    const block = countyRoot[cid]!;
    const rr = block.Races?.[oid];
    if (!rr) continue;
    const pr = block.Summary;
    const prr = Number(pr?.PRR ?? 0);
    const prp = Number(pr?.PRP ?? 0);
    const precinctsReporting = `${prr} of ${prp} polling locations reporting`;
    const candidates: Record<string, { earlyVotes: number; electionDayVotes: number; totalVotes: number }> = {};
    for (const sc of stateCandidates) {
      candidates[sc.id] = findCountyCell(rr, sc);
    }
    rows.push({
      id: cid,
      name: block.N,
      sourceTag: block.Summary?.SRC === "CNTY" ? "CNTY" : "SOS",
      precinctsReporting,
      precinctReportingCount: prr,
      precinctTotalCount: prp,
      candidates,
    });
  }
  return rows;
}

function reportingFromHome(home: CivixHome): ReportingSnapshot {
  const isoGuess = Date.parse(home.LastUpdatedTime.replace(",", ""));
  const lastUpdated = Number.isFinite(isoGuess) ? new Date(isoGuess).toISOString() : new Date().toISOString();
  return {
    counties: { reported: home.CountiesReporting.CR, total: home.CountiesReporting.CT },
    pollingLocations: { reported: home.PollingReporting.PLR, total: home.PollingReporting.PLT },
    lastUpdated,
    lastUpdatedDisplay: home.LastUpdatedTime,
    resultStatus: undefined,
    nextUpdateNote: "Next update",
  };
}

export function mapCivixPayloadToElectionFile(
  civixElectionId: number,
  catalogLabel: string,
  electionPayload: Record<string, unknown>,
  countyDoc: Record<string, unknown>,
): ElectionFile {
  const home = decodeElectionSection<CivixHome>(electionPayload, "Home");
  if (!home) throw new Error("Civix election payload missing Home section");

  const countyRoot = decodeCountyIndex(countyDoc);

  const races: RaceInput[] = [];
  for (const key of SECTION_KEYS) {
    const section = decodeElectionSection<CivixSection>(electionPayload, key);
    if (!section?.Races?.length) continue;
    const officeType = section.OffType;
    for (const r of section.Races) {
      const candidates = mapCandidates(r);
      const counties = buildCountyRows(r.id, candidates, countyRoot, home);
      races.push({
        id: String(r.id),
        officeType,
        title: r.N.trim(),
        candidates,
        counties,
      });
    }
  }

  return {
    schemaVersion: 1,
    source: {
      id: "tx-sos-civix-enr",
      label: "Texas Secretary of State (Civix ENR)",
      type: "sos",
    },
    election: {
      id: String(civixElectionId),
      label: catalogLabel,
      navTitle: catalogLabel.replace(/\s*\(\d{4}\)\s*$/, "").toUpperCase(),
    },
    reporting: reportingFromHome(home),
    races,
  };
}
