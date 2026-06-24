import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBenchmarkMargin, parseLegMargin } from "./benchmarkMargin.mjs";
import { parseMetricValue, resolveOfficeCode } from "./legesXlsx.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mergeMetrics(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value != null && target[key] == null) target[key] = value;
  }
}

function upsertOfficeMetrics(database, officeCode, metrics) {
  const office = database.prepare(`SELECT id FROM offices WHERE office_code = ?`).get(officeCode);
  if (!office) return;

  database
    .prepare(
      `INSERT INTO office_metrics (office_id, trump_2024, cruz_2024, abbott_2022, leg_2024, leg_2022)
       VALUES (@officeId, @trump_2024, @cruz_2024, @abbott_2022, @leg_2024, @leg_2022)
       ON CONFLICT(office_id) DO UPDATE SET
         trump_2024 = COALESCE(excluded.trump_2024, office_metrics.trump_2024),
         cruz_2024 = COALESCE(excluded.cruz_2024, office_metrics.cruz_2024),
         abbott_2022 = COALESCE(excluded.abbott_2022, office_metrics.abbott_2022),
         leg_2024 = COALESCE(excluded.leg_2024, office_metrics.leg_2024),
         leg_2022 = COALESCE(excluded.leg_2022, office_metrics.leg_2022)`
    )
    .run({
      officeId: office.id,
      trump_2024: metrics.trump_2024 ?? null,
      cruz_2024: metrics.cruz_2024 ?? null,
      abbott_2022: metrics.abbott_2022 ?? null,
      leg_2024: metrics.leg_2024 ?? null,
      leg_2022: metrics.leg_2022 ?? null,
    });
}

export function ensureMetricsSchema(database) {
  const schemaPath = path.join(__dirname, "..", "..", "schema-metrics.sql");
  database.exec(fs.readFileSync(schemaPath, "utf8"));
}

export function importDataSheetMetrics(database, rows) {
  const byOffice = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const hd = parseMetricValue(row[0]);
    if (hd != null) {
      const code = `HD-${String(Math.round(hd)).padStart(3, "0")}`;
      if (!byOffice.has(code)) byOffice.set(code, {});
      mergeMetrics(byOffice.get(code), {
        trump_2024: parseBenchmarkMargin(row[1], { format: "margin" }),
        cruz_2024: parseBenchmarkMargin(row[2], { format: "margin" }),
        abbott_2022: parseBenchmarkMargin(row[3], { format: "margin" }),
      });
    }

    const sd = parseMetricValue(row[5]);
    if (sd != null) {
      const code = `SD-${String(Math.round(sd)).padStart(2, "0")}`;
      if (!byOffice.has(code)) byOffice.set(code, {});
      mergeMetrics(byOffice.get(code), {
        trump_2024: parseBenchmarkMargin(row[6], { format: "margin" }),
        cruz_2024: parseBenchmarkMargin(row[7], { format: "margin" }),
        abbott_2022: parseBenchmarkMargin(row[8], { format: "margin" }),
      });
    }
  }

  for (const [code, metrics] of byOffice) {
    upsertOfficeMetrics(database, code, metrics);
  }

  return byOffice.size;
}

export function importSheetRowMetrics(database, sheetRows, config) {
  const byOffice = new Map();

  for (let i = 1; i < sheetRows.length; i += 1) {
    const row = sheetRows[i];
    const c = config.metricCols;
    if (!c) continue;

    const districtLabel = String(row[config.cols.district] ?? "").trim();
    const office = resolveOfficeCode(config.category, districtLabel);
    if (!office) continue;

    const benchmarkFormat = "margin";

    const metrics = {
      trump_2024:
        c.trump2024 != null ? parseBenchmarkMargin(row[c.trump2024], { format: benchmarkFormat }) : null,
      cruz_2024:
        c.cruz2024 != null ? parseBenchmarkMargin(row[c.cruz2024], { format: benchmarkFormat }) : null,
      abbott_2022:
        c.abbott2022 != null ? parseBenchmarkMargin(row[c.abbott2022], { format: benchmarkFormat }) : null,
      leg_2024: c.leg2024 != null ? parseLegMargin(row[c.leg2024]) : null,
      leg_2022: c.leg2022 != null ? parseLegMargin(row[c.leg2022]) : null,
    };

    if (Object.values(metrics).every((v) => v == null)) continue;

    const existing = byOffice.get(office.code) ?? {};
    mergeMetrics(existing, metrics);
    byOffice.set(office.code, existing);
  }

  for (const [code, metrics] of byOffice) {
    upsertOfficeMetrics(database, code, metrics);
  }

  return byOffice.size;
}

export function clearAllOfficeMetrics(database) {
  database.prepare(`DELETE FROM office_metrics`).run();
}
