import { defineConfig } from "@playwright/test";
import { getE2eBaseUrl } from "./support/environment";

export default defineConfig({
  testDir: ".",
  testMatch: "auth.setup.ts",
  outputDir: "../test-results/e2e-auth",
  timeout: 10 * 60_000,
  reporter: "list",
  use: {
    baseURL: getE2eBaseUrl(),
    headless: false,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
