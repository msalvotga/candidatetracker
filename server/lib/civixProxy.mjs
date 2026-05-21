import { fetch as undiciFetch } from "undici";

const CIVIX_ORIGIN = "https://goelect.txelections.civixapps.com";

/**
 * Proxy /api-ivis-system/* to Texas Civix (same as Vite dev proxy).
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function civixProxyHandler(req, res) {
  const path = req.originalUrl || req.url || "";
  const targetUrl = `${CIVIX_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const upstream = await undiciFetch(targetUrl, {
      method: req.method,
      headers: {
        Accept: req.headers.accept ?? "application/json, text/plain, */*",
        "Accept-Language": req.headers["accept-language"] ?? "en-US,en;q=0.9",
        "User-Agent": req.headers["user-agent"] ?? "electionnighttracker/1.0",
      },
      redirect: "follow",
    });
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.status(upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({
      error: "Civix proxy failed",
      message: String(err?.message ?? err),
      target: targetUrl,
    });
  }
}
