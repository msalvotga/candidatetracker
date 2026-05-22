/**
 * @param {string | string[] | undefined} counties
 * @param {string | undefined} county legacy single county
 */
export function normalizeVoterCountyFilter(counties, county) {
  const raw = counties ?? county;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return [...new Set(list.map((c) => String(c).toUpperCase().trim()).filter(Boolean))];
}

/**
 * @param {string[]} counties
 * @param {"postgres" | "mssql"} dialect
 */
export function countyInClause(counties, dialect = "postgres") {
  if (!counties.length) return { sql: "", params: [] };
  if (dialect === "postgres" || dialect === "mssql") {
    const params = {};
    const parts = counties.map((name, i) => {
      const key = `county_${i}`;
      params[key] = name;
      return `@${key}`;
    });
    return { sql: ` AND county_name IN (${parts.join(", ")})`, params };
  }
  return {
    sql: ` AND county_name IN (${counties.map(() => "?").join(", ")})`,
    params: counties,
  };
}
