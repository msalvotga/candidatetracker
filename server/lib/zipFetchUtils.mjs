/**
 * Validate bytes before JSZip; county hub URLs often return HTML error pages with HTTP 200.
 * @param {Buffer | Uint8Array} buffer
 * @param {{ url?: string, contentType?: string | null }} meta
 */
export function assertLikelyZip(buffer, meta = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 4) {
    throw new Error(`Response is too short to be a ZIP.${fmtMeta(meta)}`);
  }
  const sig = String.fromCharCode(u8[0], u8[1]);
  if (sig !== "PK") {
    const ct = meta.contentType ?? "";
    const hint =
      ct.includes("html") || peekAscii(u8, 80).toLowerCase().includes("<!doctype")
        ? " The URL returned HTML (wrong link, login page, or hub discovery picked a non-ZIP page)."
        : "";
    throw new Error(
      `Response is not a ZIP (expected PK header).${fmtMeta(meta)}${hint} Start: ${peekAscii(u8, 120)}`,
    );
  }
}

function fmtMeta(meta) {
  const parts = [];
  if (meta.url) parts.push(` URL: ${meta.url}`);
  if (meta.contentType) parts.push(` Content-Type: ${meta.contentType}`);
  return parts.length ? parts.join(".") : "";
}

function peekAscii(u8, maxLen) {
  const n = Math.min(maxLen, u8.length);
  let s = "";
  for (let i = 0; i < n; i++) {
    const c = u8[i];
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
    else if (c === 10 || c === 13) s += " ";
    else s += ".";
  }
  return s.replace(/\s+/g, " ").trim().slice(0, 180);
}
