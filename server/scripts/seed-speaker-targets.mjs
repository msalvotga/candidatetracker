import pg from "pg";

const districts = [
  14, 20, 26, 28, 29, 34, 37, 52, 54, 55, 61, 63, 66, 80, 89, 94, 96, 97, 108, 112, 118, 121, 122, 126,
  127, 129, 132, 133, 138, 150,
];
const cycleYear = Number(process.env.CYCLE_YEAR ?? 2026);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

try {
  const orgs = await pool.query(`SELECT org_key, name FROM targeting_organizations ORDER BY name`);
  const speaker = orgs.rows.find(
    (row) => row.name.trim().toLowerCase() === "speaker" || row.org_key.toUpperCase() === "SPEAKER"
  );
  if (!speaker) throw new Error("Speaker targeting organization not found");

  const codes = districts.map((district) => `HD-${String(district).padStart(3, "0")}`);
  const offices = await pool.query(
    `SELECT id, district, office_code FROM offices WHERE category = 'house' AND office_code = ANY($1) ORDER BY district`,
    [codes]
  );

  const foundCodes = new Set(offices.rows.map((row) => row.office_code));
  const missing = codes.filter((code) => !foundCodes.has(code));
  if (missing.length) {
    console.warn("Missing offices:", missing.join(", "));
  }

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const office of offices.rows) {
      const result = await client.query(
        `INSERT INTO office_targets (office_id, cycle_year, org_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (office_id, cycle_year, org_key) DO NOTHING`,
        [office.id, cycleYear, speaker.org_key]
      );
      inserted += result.rowCount;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const verify = await pool.query(
    `SELECT o.district, o.office_code
     FROM office_targets t
     JOIN offices o ON o.id = t.office_id
     WHERE t.org_key = $1 AND t.cycle_year = $2
     ORDER BY o.district`,
    [speaker.org_key, cycleYear]
  );

  console.log(`Org: ${speaker.org_key} (${speaker.name})`);
  console.log(`Inserted ${inserted} new rows for cycle ${cycleYear}`);
  console.log(`Total Speaker targets: ${verify.rows.length}`);
  console.log(verify.rows.map((row) => row.district).join(", "));
} finally {
  await pool.end();
}
