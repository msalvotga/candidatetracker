import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiBase";
import { SettingsCollapse } from "./SettingsCollapse";

type DatasetKind = "lookup" | "static2022" | "roster2026";

type DatasetStatus = {
  fileName: string | null;
  uploadedAt: string | null;
  rows: number;
  uniqueVuids: number;
  withScore2022: number;
  withScore2026: number;
  rejected: number;
  rejectedSamples: { row: number; reason: string }[];
  duplicatesMerged: number;
  geographies?: number;
  votingDays?: number;
  detailColumns?: string[];
  statewideRows?: number;
  countyRows?: number;
  houseRows?: number;
  senateRows?: number;
  congressRows?: number;
  validation: string;
  error: string | null;
};

type EvStatus = {
  status: string;
  phase: string | null;
  scanned: number;
  error: string | null;
  rosterNote?: string;
  datasets: Record<DatasetKind, DatasetStatus>;
};

const KINDS: { id: DatasetKind; title: string; required: string; optional?: string; detail: string }[] = [
  {
    id: "lookup",
    title: "Current voter model lookup",
    required: "VUID, CountyName, USHouse, TXSenate, TXHouse, Score2022, Score2026",
    optional:
      "FirstName, LastName, RegistrationDate, RegistrationAddr1, RegistrationAddr2, RegHouseNum, RegHouseSfx, RegStPrefix, RegStName, RegStType, RegStPost, RegUnitType, RegUnitNumber, RegCity, RegSta, RegZip5",
    detail:
      "One row per currently registered voter. Name, registration date, and address columns stay in the file and show on the voter roster when a VUID matches.",
  },
  {
    id: "static2022",
    title: "Static 2022 voting data",
    required:
      "GeographyType, Geography, VotingDay, VotingDate, VotingDayLabel, DailyVoters, DailyVotersWith2022Score, Daily2022Average, DailyVotersWith2026Score, Daily2026Average, CumulativeVoters, CumulativeVotersWith2022Score, Cumulative2022Average, CumulativeVotersWith2026Score, Cumulative2026Average",
    detail:
      "Precomputed 2022 general-election voting summaries by statewide, county, congressional district, state Senate district, and state House district. Includes daily and cumulative 2022 and 2026 model averages for each normalized voting day.",
  },
  {
    id: "roster2026",
    title: "2026 early voting roster",
    required: "VUID, VoteDate",
    detail: "Each upload replaces the current roster. The file should be the full cumulative list. A VUID is kept once.",
  },
];

function formatNum(n: number) {
  return (n || 0).toLocaleString("en-US");
}

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
}

function validationLabel(dataset: DatasetStatus | undefined, running: boolean) {
  if (running && dataset?.validation === "valid" && !dataset.rows) return "Reading";
  if (!dataset || dataset.validation === "missing") return "Not loaded";
  if (dataset.validation === "invalid") return "Invalid";
  return "Valid";
}

export function BallotScoreDataSettings() {
  const [status, setStatus] = useState<EvStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<DatasetKind | "rebuild" | null>(null);

  async function refresh() {
    const response = await apiFetch("/api/ballot-score/ev/status", { cache: "no-store" });
    const body = (await response.json()) as EvStatus;
    setStatus(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    void refresh().catch(() => {
      if (!cancelled) setMessage("Could not load ballot score data status.");
    });
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function upload(kind: DatasetKind, file: File) {
    setBusyKind(kind);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/ballot-score/ev/upload/${kind}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `Upload failed (${response.status})`);
      setStatus(body as EvStatus);
      setMessage(
        kind === "static2022"
          ? `${file.name} is loaded. The 2022 summary is ready to show by voting day.`
          : `${file.name} is loaded. Scores are rebuilding from the voter rows.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusyKind(null);
    }
  }

  async function rebuild() {
    setBusyKind("rebuild");
    setMessage(null);
    try {
      const response = await apiFetch("/api/ballot-score/ev/rebuild", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `Rebuild failed (${response.status})`);
      setStatus(body as EvStatus);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rebuild failed");
    } finally {
      setBusyKind(null);
    }
  }

  const running = status?.status === "running" || busyKind != null;

  return (
    <section className="enr-panel enr-settings__section">
      <SettingsCollapse title="Ballot score data">
      <p className="enr-muted">
        The current voter lookup and the 2026 roster are one row per voter. The 2022 file is an already summarized table
        by geography and voting day. 2026 early-voting averages are calculated from individual scores. Blank scores are
        left out of those averages and are not treated as zero.
      </p>
      {status?.rosterNote ? <p className="enr-muted">{status.rosterNote}</p> : null}
      {running ? (
        <p className="enr-saveOk">
          Import running{status?.phase ? ` (${status.phase})` : ""}
          {status?.scanned ? ` — ${formatNum(status.scanned)} rows read` : ""}.
        </p>
      ) : null}
      {status?.status === "error" && status.error ? <p className="enr-errorInline">{status.error}</p> : null}
      {message ? <p className={message.includes("fail") || message.includes("Missing") || message.includes("Could") ? "enr-errorInline" : "enr-saveOk"}>{message}</p> : null}
      <div className="enr-ballot-uploads">
        {KINDS.map((kind) => {
          const dataset = status?.datasets?.[kind.id];
          return (
            <article key={kind.id} className="enr-ballot-uploads__card">
              <h3>{kind.title}</h3>
              <p className="enr-muted">{kind.detail}</p>
              <p className="enr-muted">Required columns: {kind.required}</p>
              {kind.optional ? <p className="enr-muted">Also accepted: {kind.optional}</p> : null}
              {kind.id === "lookup" && dataset?.detailColumns?.length ? (
                <p className="enr-muted">Detail columns in this file: {dataset.detailColumns.join(", ")}</p>
              ) : null}
              <dl className="enr-ballot-uploads__stats">
                <div>
                  <dt>File</dt>
                  <dd>{dataset?.fileName || "—"}</dd>
                </div>
                <div>
                  <dt>Uploaded</dt>
                  <dd>{formatWhen(dataset?.uploadedAt ?? null)}</dd>
                </div>
                <div>
                  <dt>Rows loaded</dt>
                  <dd>{formatNum(dataset?.rows || 0)}</dd>
                </div>
                {kind.id === "static2022" ? (
                  <>
                    <div>
                      <dt>Geographies</dt>
                      <dd>{formatNum(dataset?.geographies || 0)}</dd>
                    </div>
                    <div>
                      <dt>Voting days</dt>
                      <dd>{formatNum(dataset?.votingDays || 0)}</dd>
                    </div>
                    <div>
                      <dt>Statewide rows</dt>
                      <dd>{formatNum(dataset?.statewideRows || 0)}</dd>
                    </div>
                    <div>
                      <dt>County rows</dt>
                      <dd>{formatNum(dataset?.countyRows || 0)}</dd>
                    </div>
                    <div>
                      <dt>State House rows</dt>
                      <dd>{formatNum(dataset?.houseRows || 0)}</dd>
                    </div>
                    <div>
                      <dt>State Senate rows</dt>
                      <dd>{formatNum(dataset?.senateRows || 0)}</dd>
                    </div>
                    <div>
                      <dt>Congressional rows</dt>
                      <dd>{formatNum(dataset?.congressRows || 0)}</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <dt>Unique VUIDs</dt>
                      <dd>{formatNum(dataset?.uniqueVuids || 0)}</dd>
                    </div>
                    <div>
                      <dt>With Score2022</dt>
                      <dd>{formatNum(dataset?.withScore2022 || 0)}</dd>
                    </div>
                    <div>
                      <dt>With Score2026</dt>
                      <dd>{formatNum(dataset?.withScore2026 || 0)}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Validation</dt>
                  <dd>{validationLabel(dataset, status?.status === "running")}</dd>
                </div>
                <div>
                  <dt>Rejected rows</dt>
                  <dd>{formatNum(dataset?.rejected || 0)}</dd>
                </div>
              </dl>
              {dataset?.error ? <p className="enr-errorInline">{dataset.error}</p> : null}
              {dataset?.rejectedSamples?.length ? (
                <ul className="enr-ballot-uploads__rejects">
                  {dataset.rejectedSamples.slice(0, 8).map((sample) => (
                    <li key={`${sample.row}-${sample.reason}`}>
                      Row {sample.row}: {sample.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              <label className="enr-secondaryBtn enr-ballot-uploads__pick">
                {busyKind === kind.id ? "Uploading…" : "Upload CSV"}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={running}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void upload(kind.id, file);
                  }}
                />
              </label>
            </article>
          );
        })}
      </div>
      <div className="enr-settings__actions">
        <button type="button" className="enr-secondaryBtn" disabled={running} onClick={() => void rebuild()}>
          {busyKind === "rebuild" ? "Rebuilding…" : "Rebuild scores"}
        </button>
      </div>
      </SettingsCollapse>
    </section>
  );
}
