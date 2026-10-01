import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiBase";
import { SettingsCollapse } from "./SettingsCollapse";

type RosterSchedule = {
  enabled: boolean;
  timeZone: string;
};

export function CountyRosterScheduleSettings() {
  const [schedule, setSchedule] = useState<RosterSchedule | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch("/api/county-rosters/schedule", { cache: "no-store" });
        const body = (await response.json()) as RosterSchedule & { error?: string };
        if (!response.ok) throw new Error(body.error || "Could not load the roster schedule");
        if (!cancelled) setSchedule(body);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not load the roster schedule");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: RosterSchedule) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/county-rosters/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await response.json()) as RosterSchedule & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not save the roster schedule");
      setSchedule(body);
      setMessage("County roster schedule saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the roster schedule");
    } finally {
      setBusy(false);
    }
  }

  if (!schedule) {
    return (
      <section className="enr-panel enr-settings__section">
        <SettingsCollapse title="County roster pulls">
          <p className="enr-muted">{message || "Loading roster schedule…"}</p>
        </SettingsCollapse>
      </section>
    );
  }

  return (
    <section className="enr-panel enr-settings__section">
      <SettingsCollapse title="County roster pulls">
      {message ? (
        <p className={message.includes("saved") ? "enr-saveOk" : "enr-errorInline"}>{message}</p>
      ) : null}
      <label className="enr-field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={schedule.enabled}
          disabled={busy}
          onChange={(event) => {
            const next = { ...schedule, enabled: event.target.checked };
            setSchedule(next);
            void save(next);
          }}
        />
        Update trained county rosters automatically
      </label>
      <p className="enr-muted" style={{ marginTop: -4, marginBottom: 12 }}>
        Automatic pulls run in the background at 9:00 AM, 10:00 AM, 11:00 AM, and 12:00 PM Central, Monday through
        Saturday, whether or not County rosters is open. A county is skipped once its roster already includes a ballot
        from the day before. On October 1, a September 30 vote date means that county posted its updated roster.
      </p>
      </SettingsCollapse>
    </section>
  );
}
