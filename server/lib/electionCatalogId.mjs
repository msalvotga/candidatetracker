/**
 * Map a Settings election row to the main-page catalog dropdown id.
 * @param {{ electionId?: string, usesCivixSos?: boolean }} cfg
 */
export function catalogIdForSourceConfig(cfg) {
  const rawId = String(cfg.electionId ?? "").trim();
  const num = Number(rawId);
  const isPureNumericId = Number.isFinite(num) && rawId === String(num);
  if (isPureNumericId && cfg.usesCivixSos !== false) return `civix:${num}`;
  return `election:${encodeURIComponent(rawId)}`;
}

/**
 * @param {Array<{ electionId?: string, usesCivixSos?: boolean, isDefaultCatalog?: boolean }>} cfgs
 */
export function resolveDefaultCatalogId(cfgs) {
  const marked = (cfgs ?? []).find((c) => c.isDefaultCatalog);
  if (marked) return catalogIdForSourceConfig(marked);
  const fallback = (cfgs ?? []).find((c) => String(c.electionId) === "56181") ?? cfgs?.[0];
  return fallback ? catalogIdForSourceConfig(fallback) : null;
}
