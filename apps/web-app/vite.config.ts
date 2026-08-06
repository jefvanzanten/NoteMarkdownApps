import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  server: { proxy: { "/api": "http://localhost:8787", "/openapi.json": "http://localhost:8787" } },
  plugins: [react()],
  worker: { format: "es" },
});
