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
        const url = req.url ?? "";
        if (url === "/api" || url.startsWith("/api/")) {
          void api(req, res, next);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), electionApiDevPlugin()],
  server: {
    proxy: {
      "/api-ivis-system": {
        target: "https://goelect.txelections.civixapps.com",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
