/** Parsed bulk line: county_key, process_id, https://… (commas in URL preserved). */
export type BulkCountyFeedLine = {
  countyKey: string;
  vendorId: string;
  url: string;
};

export function parseBulkCountyFeedLines(text: string): BulkCountyFeedLine[] {
  const out: BulkCountyFeedLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const [countyKey, vendorId, ...rest] = parts;
    const url = rest.join(",").trim();
    if (!countyKey || !vendorId || !url) continue;
    out.push({
      countyKey: countyKey.toLowerCase(),
      vendorId,
      url,
    });
  }
  return out;
}
