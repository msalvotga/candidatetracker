import { fetch as undiciFetch } from "undici";
import { buildCivixFetchHeaders } from "./civixCredentials.mjs";

const CIVIX_ORIGIN = "https://goelect.txelections.civixapps.com";

/**
 * Proxy /api-ivis-system/* to Texas Civix (same as Vite dev proxy).
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function civixProxyHandler(req, res) {
  const path = req.originalUrl || req.url || "";
  const targetUrl = `${CIVIX_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
  const requestCookie = req.headers["x-civix-cookie"];
  try {
    const civixHeaders = await buildCivixFetchHeaders(
      typeof requestCookie === "string" ? requestCookie : Array.isArray(requestCookie) ? requestCookie[0] : "",
    );
    const upstream = await undiciFetch(targetUrl, {
      method: req.method,
      headers: {
        ...civixHeaders,
        Accept: req.headers.accept ?? civixHeaders.Accept,
        "Accept-Language": req.headers["accept-language"] ?? "en-US,en;q=0.9",
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
