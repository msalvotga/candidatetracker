import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3850",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            const cookies = proxyRes.headers["set-cookie"];
            if (cookies) {
              proxyRes.headers["set-cookie"] = cookies.map((cookie) =>
                cookie.replace(/;\s*Domain=[^;]+/i, "").replace(/;\s*Secure/i, "")
              );
            }
          });
        },
      },
    },
  },
});
