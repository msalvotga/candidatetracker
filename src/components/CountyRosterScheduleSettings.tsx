import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiBase";
import { SettingsCollapse } from "./SettingsCollapse";

type RosterSchedule = {
  enabled: boolean;
  intervalMinutes: number;
  startHour: number;
  endHour: number;
  timeZone: string;
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour: number) {
  const h = hour % 12 || 12;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${h}:00 ${suffix}`;
}

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
        Update trained county rosters on a schedule
      </label>
      <p className="enr-muted" style={{ marginTop: -4, marginBottom: 12 }}>
        Each trained county is pulled again when its last pull is older than the interval. That check runs during
        each hour from the first pull through the last pull, Central time. The default is every hour from 9:00 AM
        through 1:00 PM.
      </p>
      <label className="enr-field">
        Update interval (minutes)
        <input
          className="enr-input"
          type="number"
          min={15}
          max={1440}
          step={1}
          disabled={busy}
          value={schedule.intervalMinutes}
          onChange={(event) =>
            setSchedule((current) =>
              current ? { ...current, intervalMinutes: Math.max(15, Number(event.target.value) || 60) } : current,
            )
          }
          onBlur={() => void save(schedule)}
        />
      </label>
      <label className="enr-field">
        First pull
        <select
          className="enr-input"
          disabled={busy}
          value={schedule.startHour}
          onChange={(event) => {
            const next = { ...schedule, startHour: Number(event.target.value) };
            setSchedule(next);
            void save(next);
          }}
        >
          {HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {hourLabel(hour)}
            </option>
          ))}
        </select>
      </label>
      <label className="enr-field">
        Last pull
        <select
          className="enr-input"
          disabled={busy}
          value={schedule.endHour}
          onChange={(event) => {
            const next = { ...schedule, endHour: Number(event.target.value) };
            setSchedule(next);
            void save(next);
          }}
        >
          {HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {hourLabel(hour)}
            </option>
          ))}
        </select>
      </label>
      </SettingsCollapse>
    </section>
  );
}
