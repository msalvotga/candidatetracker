import { parseMetricValue } from "./legesXlsx.mjs";

/** Benchmark keys store R% − D% as a decimal (0.4938 = R+49.38). */
export const BENCHMARK_METRIC_KEYS = new Set(["trump_2024", "cruz_2024", "abbott_2022"]);
export const LEG_METRIC_KEYS = new Set(["leg_2024", "leg_2022"]);

export function isLegMetricKey(key) {
  return LEG_METRIC_KEYS.has(key);
}

export function gopShareFromMargin(margin) {
  if (margin == null || Number.isNaN(margin)) return null;
  return 0.5 + margin / 2;
}

export function marginFromGopShare(gopShare) {
  if (gopShare == null || Number.isNaN(gopShare)) return null;
  return 2 * (gopShare - 0.5);
}

/** Parse spreadsheet / legacy leg result values to stored R−D margin decimal. */
export function parseLegMargin(raw) {
  const cleaned = String(raw ?? "")
    .replace(/%/g, "")
    .trim();
  const value = parseMetricValue(cleaned);
  if (value == null || Number.isNaN(value)) return null;

  // GOP two-party share as decimal (e.g. 0.568)
  if (value > 0 && value < 1) return marginFromGopShare(value);
  // GOP vote share as percent (e.g. 56.8)
  if (value > 1 && value <= 100) return marginFromGopShare(value / 100);
  // Margin in percentage points (e.g. 13.6 or -13.6)
  if (Math.abs(value) > 1) return value / 100;
  // Margin decimal (e.g. 0.136 or -0.136)
  return value;
}

export function isBenchmarkMetricKey(key) {
  return BENCHMARK_METRIC_KEYS.has(key);
}

/** Convert spreadsheet / legacy values to stored benchmark margin decimal. */
export function parseBenchmarkMargin(raw, { format = "auto" } = {}) {
  const cleaned = String(raw ?? "")
    .replace(/%/g, "")
    .trim();
  const value = parseMetricValue(cleaned);
  if (value == null || Number.isNaN(value)) return null;

  if (format === "margin") {
    return Math.abs(value) > 1 ? value / 100 : value;
  }

  if (format === "gop_share") {
    return 2 * (value - 0.5);
  }

  // auto: percent points or stored margin decimal (R% − D%)
  if (Math.abs(value) > 1) return value / 100;
  return value;
}

export function gopShareFromBenchmarkMargin(margin) {
  if (margin == null || Number.isNaN(margin)) return null;
  return 0.5 + margin / 2;
}

export function migrateGopShareToBenchmarkMargin(database) {
  const rows = database
    .prepare(
      `SELECT m.office_id, m.trump_2024, m.cruz_2024, m.abbott_2022, o.category
       FROM office_metrics m
       JOIN offices o ON o.id = m.office_id
       WHERE o.category IN ('house', 'senate', 'sboe')`
    )
    .all();

  const update = database.prepare(
    `UPDATE office_metrics
     SET trump_2024 = @trump_2024, cruz_2024 = @cruz_2024, abbott_2022 = @abbott_2022
     WHERE office_id = @officeId`
  );

  let changed = 0;
  for (const row of rows) {
    const convert = (value) => {
      if (value == null) return null;
      // Legacy rows stored GOP two-party share (roughly 0.35–0.65), not R−D margin.
      if (value > 0.25 && value < 0.75) return 2 * (value - 0.5);
      return value;
    };

    const trump = convert(row.trump_2024);
    const cruz = convert(row.cruz_2024);
    const abbott = convert(row.abbott_2022);

    if (trump !== row.trump_2024 || cruz !== row.cruz_2024 || abbott !== row.abbott_2022) {
      update.run({ officeId: row.office_id, trump_2024: trump, cruz_2024: cruz, abbott_2022: abbott });
      changed += 1;
    }
  }

  return changed;
}

export function migrateLegShareToMargin(database) {
  const rows = database.prepare(`SELECT office_id, leg_2024, leg_2022 FROM office_metrics`).all();
  const update = database.prepare(
    `UPDATE office_metrics SET leg_2024 = @leg_2024, leg_2022 = @leg_2022 WHERE office_id = @officeId`
  );

  let changed = 0;
  for (const row of rows) {
    const convert = (value) => {
      if (value == null) return null;
      // Legacy rows stored GOP two-party share (roughly 0.35–0.65).
      if (value > 0.25 && value < 0.75) return marginFromGopShare(value);
      return value;
    };

    const leg2024 = convert(row.leg_2024);
    const leg2022 = convert(row.leg_2022);
    if (leg2024 !== row.leg_2024 || leg2022 !== row.leg_2022) {
      update.run({ officeId: row.office_id, leg_2024: leg2024, leg_2022: leg2022 });
      changed += 1;
    }
  }

  return changed;
}
