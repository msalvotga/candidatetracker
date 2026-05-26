import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * In dev, mount the election API on the same origin as Vite (no separate process required).
 * Civix is still proxied from /api-ivis-system for any client-side fallback paths.
 */
function electionApiDevPlugin() {
  return {
    name: "election-api-dev",
    async configureServer(server) {
      const { createApiApp } = await import("./server/createApiApp.mjs");
      const api = createApiApp();
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        if (pathname === "/api" || pathname.startsWith("/api/")) {
          api(req, res, (err: unknown) => {
            if (err) {
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
              }
              return;
            }
            if (!res.headersSent) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: `No API route for ${pathname}` }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

/** `vite --mode proxy` (used by dev:all): one API on :3847 — avoid a second in-process DB. */
export default defineConfig(({ mode }) => {
  const proxyApiToServer = mode === "proxy";
  return {
    plugins: [react(), ...(proxyApiToServer ? [] : [electionApiDevPlugin()])],
    server: {
      proxy: {
        ...(proxyApiToServer
          ? {
              "/api": {
                target: "http://127.0.0.1:3847",
                changeOrigin: true,
                /** Force update ingest can run several minutes; default proxy timeouts cause HTTP 500. */
                timeout: 600_000,
                proxyTimeout: 600_000,
              },
            }
          : {}),
        "/api-ivis-system": {
          target: "https://goelect.txelections.civixapps.com",
          changeOrigin: true,
          secure: true,
        },
      },
    },
  };
});
