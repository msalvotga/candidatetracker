import type { LoadedElection } from "../../types/election";
import { fetchCivixElectionPayload } from "./api";
import { mapCivixPayloadToElectionFile } from "./mapCivixElection";

export type CivixElectionPick = {
  civixElectionId: number;
  catalogId: string;
  catalogLabel: string;
};

export async function loadCivixElectionBundle(item: CivixElectionPick): Promise<LoadedElection> {
  const { election, county } = await fetchCivixElectionPayload(item.civixElectionId);
  const file = mapCivixPayloadToElectionFile(item.civixElectionId, item.catalogLabel, election, county);
  return {
    catalogId: item.catalogId,
    catalogLabel: item.catalogLabel,
    file,
  };
}
