import path from "node:path";

/**
 * Resolves the application URL used by protected browser tests.
 * @returns Absolute NoteMarkdown application URL.
 */
export function getE2eBaseUrl(): string {
  return process.env.E2E_BASE_URL ?? "http://localhost:5173/";
}

/**
 * Resolves the ignored Playwright authentication-state file.
 * @returns Absolute path to the stored API session state.
 */
export function getAuthStatePath(): string {
  return path.resolve(process.env.E2E_AUTH_STATE ?? "playwright/.auth/drive-user.json");
}

/**
 * Returns an optional locally installed Chromium-compatible browser path.
 * @returns Browser executable path or undefined for Playwright Chromium.
 */
export function getBrowserExecutablePath(): string | undefined {
  return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
}

/**
 * Parses a bounded positive integer from an environment variable.
 * @param value Raw environment value.
 * @param fallback Value used when parsing fails.
 * @param maximum Maximum accepted value.
 * @returns Safe positive integer.
 */
export function getBoundedPositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
