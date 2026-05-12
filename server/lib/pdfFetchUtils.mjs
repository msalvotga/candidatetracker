/**
 * Validate bytes before pdf-parse; remote URLs often return HTML (403/404/WAF) despite 200 OK.
 * @param {Buffer | Uint8Array} buffer
 * @param {{ url?: string, contentType?: string | null }} meta
 */
export function assertLikelyPdf(buffer, meta = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 5) {
    throw new Error(
      `Response body is empty or too short to be a PDF.${fmtMeta(meta)}`,
    );
  }
  const head = String.fromCharCode(u8[0], u8[1], u8[2], u8[3], u8[4]);
  if (!head.startsWith("%PDF")) {
    const peek = peekAscii(u8, 280);
    throw new Error(
      `Response is not a PDF (expected %PDF header).${fmtMeta(meta)} Start of body: ${peek}`,
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
  return s.replace(/\s+/g, " ").trim().slice(0, 220);
}
