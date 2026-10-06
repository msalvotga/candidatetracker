/** Pull new governor polls on the hour from 7 a.m. through 4 p.m. Central. */

const TIME_ZONE = "America/Chicago";

export function chicagoClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let hour = Number(value.hour);
  if (hour === 24) hour = 0;
  return {
    day: `${value.year}-${value.month}-${value.day}`,
    hour,
    minute: Number(value.minute),
  };
}

export function pullSlotKey(clock) {
  if (clock.hour < 7 || clock.hour > 16 || clock.minute !== 0) return null;
  return `${clock.day}-${String(clock.hour).padStart(2, "0")}`;
}

export function startPollingSchedule(runPull) {
  let lastKey = null;
  let running = false;

  async function tick() {
    const key = pullSlotKey(chicagoClock());
    if (!key || key === lastKey || running) return;
    lastKey = key;
    running = true;
    console.log(`Scheduled governor poll pull ${key} America/Chicago`);
    try {
      const summary = await runPull();
      const added = summary?.added?.length ?? 0;
      console.log(`Scheduled governor poll pull finished. ${added} new poll${added === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("Scheduled governor poll pull failed:", error?.message || error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, 15_000);
  if (typeof timer.unref === "function") timer.unref();
  void tick();
  return () => clearInterval(timer);
}
