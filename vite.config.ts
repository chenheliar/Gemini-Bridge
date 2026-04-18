import path from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve(__dirname, "web"),
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/admin": "http://127.0.0.1:3100",
      "/v1": "http://127.0.0.1:3100",
      "/health": "http://127.0.0.1:3100",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist", "web"),
    emptyOutDir: true,
  },
});
