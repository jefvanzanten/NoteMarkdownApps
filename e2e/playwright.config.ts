import { defineConfig } from "@playwright/test";
import { getBoundedPositiveInteger, getBrowserExecutablePath, getE2eBaseUrl } from "./support/environment";

const executablePath = getBrowserExecutablePath();

export default defineConfig({
  testDir: ".",
  testIgnore: "auth.setup.ts",
  outputDir: "../test-results/e2e",
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  repeatEach: getBoundedPositiveInteger(process.env.E2E_SYNC_RUNS, 1, 20),
  reporter: [["list"], ["html", { outputFolder: "../playwright-report", open: "never" }]],
  use: {
    baseURL: getE2eBaseUrl(),
    headless: process.env.E2E_HEADED !== "true",
    launchOptions: executablePath ? { executablePath } : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
