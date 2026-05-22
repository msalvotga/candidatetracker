import crypto from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * @param {import("../db.mjs").getAppSettings} getAppSettings
 * @param {(key: string, value: string) => Promise<void>} upsertSetting
 */
export function createCivixConnectHelpers(getAppSettings, upsertSetting) {
  /** @returns {Promise<{ token: string, expiresAt: string }>} */
  async function issueConnectToken() {
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    await upsertSetting(
      "civix_connect_token",
      JSON.stringify({ token, expiresAt }),
    );
    return { token, expiresAt };
  }

  /** @param {string} token */
  async function verifyConnectToken(token) {
    const t = String(token ?? "").trim();
    if (!t) return false;
    const settings = await getAppSettings();
    const raw = String(settings.civixConnectTokenJson ?? "");
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.token !== t) return false;
      if (Date.parse(parsed.expiresAt) < Date.now()) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function clearConnectToken() {
    await upsertSetting("civix_connect_token", "");
  }

  return { issueConnectToken, verifyConnectToken, clearConnectToken };
}

/**
 * @param {string} apiBase e.g. https://electiontracker-ps11.onrender.com
 * @param {string} token
 */
export function buildCivixConnectBookmarklet(apiBase, token) {
  const base = String(apiBase ?? "").replace(/\/$/, "");
  const t = String(token).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const url = `${base}/api/settings/civix-cookie`;
  return (
    `javascript:(function(){var c=document.cookie;if(!c){alert('No cookies on this page. Open goelect.txelections.civixapps.com first.');return;}` +
    `fetch('${url}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${t}',civixCookie:c})})` +
    `.then(function(r){return r.json();}).then(function(d){alert(d.ok?'Civix linked to Election Night Tracker. You can close this tab.':('Failed: '+(d.error||'unknown')));})` +
    `.catch(function(e){alert('Request failed: '+e);});})();`
  );
}
