import { defineConfig } from "@playwright/test";
import { getBrowserExecutablePath, getE2eBaseUrl } from "./support/environment";

const executablePath = getBrowserExecutablePath();

export default defineConfig({
  testDir: ".",
  testMatch: "drive-visual-flow.spec.ts",
  outputDir: "../test-results/e2e-visual",
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "../playwright-report/drive-visual", open: "never" }]],
  use: {
    baseURL: getE2eBaseUrl(),
    headless: process.env.E2E_HEADED !== "true",
    launchOptions: executablePath ? { executablePath } : undefined,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
