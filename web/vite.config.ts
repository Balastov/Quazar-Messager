/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https: wss: http://localhost:* ws://localhost:*; frame-ancestors 'none'; base-uri 'self'";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": csp,
    },
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/media": {
        target: "http://localhost:8000",
      },
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
  preview: {
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": csp,
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
