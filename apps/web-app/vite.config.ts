import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  server: { proxy: { "/api": "http://localhost:8787", "/openapi.json": "http://localhost:8787" } },
  plugins: [react()],
  worker: { format: "es" },
});
