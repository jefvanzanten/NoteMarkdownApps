import fs from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Response, type TestInfo } from "@playwright/test";
import { getAuthStatePath, getBoundedPositiveInteger, getE2eBaseUrl } from "./support/environment";

interface DriveTraffic {
  metadataRequests: number;
  contentDownloads: number;
  mutations: number;
}

interface DriveSyncMetrics {
  browserVersion: string;
  backgroundContentDeferred: boolean;
  exactContentMatch: boolean;
  writerActivationMs: number;
  readerActivationMs: number;
  writerMutationMs: number;
  readerVisibilityMs: number;
  visibilityAfterMutationMs: number;
  readerMutationMs: number;
  writerReturnVisibilityMs: number;
  returnVisibilityAfterMutationMs: number;
  writerTraffic: DriveTraffic;
  readerTraffic: DriveTraffic;
}

const mutationEnabled = process.env.E2E_REAL_DRIVE === "true";

test.skip(!mutationEnabled, "Set E2E_REAL_DRIVE=true to enable the protected real-Google-Drive test.");

/**
 * Dispatches the browser focus event used by foreground reconciliation.
 * @returns Nothing after the event is dispatched.
 */
function dispatchWindowFocus(): void {
  window.dispatchEvent(new Event("focus"));
}

/**
 * Reads text copied by the editor without exposing it through test output.
 * @returns Current clipboard text.
 */
function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

/**
 * Enables the app's existing metered-network path to isolate foreground sync measurements.
 * @returns Nothing after the connection capability is overridden for this context.
 */
function enableDataSaverMode(): void {
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: { effectiveType: "4g", saveData: true },
  });
}

/**
 * Identifies a successful Google Drive content mutation response.
 * @param response Browser network response.
 * @returns Whether this response confirms an uploaded file revision.
 */
function isSuccessfulDriveMutation(response: Response): boolean {
  const request = response.request();
  return response.ok()
    && /https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\//.test(response.url())
    && request.method() === "PATCH";
}

/**
 * Collects only path-free aggregate Google Drive traffic counts.
 * @param page Browser page whose direct Drive requests are observed.
 * @returns Mutable aggregate counters for the page lifetime.
 */
function observeDriveTraffic(page: Page): DriveTraffic {
  const traffic: DriveTraffic = { metadataRequests: 0, contentDownloads: 0, mutations: 0 };

  /**
   * Classifies one response without retaining its URL or payload.
   * @param response Browser network response.
   * @returns Nothing after aggregate counters update.
   */
  function recordResponse(response: Response): void {
    const url = response.url();
    if (!url.startsWith("https://www.googleapis.com/")) return;
    if (url.includes("/upload/drive/v3/")) traffic.mutations += 1;
    else if (url.includes("alt=media")) traffic.contentDownloads += 1;
    else if (url.includes("/drive/v3/")) traffic.metadataRequests += 1;
  }

  page.on("response", recordResponse);
  return traffic;
}

/**
 * Opens one already-linked Drive workspace.
 * @param page Fresh authenticated NoteMarkdown page.
 * @param workspaceName Visible linked workspace name.
 * @param timeoutMs Maximum cold workspace activation duration.
 * @returns Cold activation duration after the file tree is interactive.
 */
async function openDriveWorkspace(page: Page, workspaceName: string, timeoutMs: number): Promise<number> {
  const startedAt = performance.now();
  await page.goto(getE2eBaseUrl());
  await page.getByRole("button", { name: /Google Drive/i }).click();
  const dialog = page.getByRole("dialog", { name: "Google Drive" });
  await expect(dialog).toBeVisible();
  const workspaceRow = dialog.getByRole("listitem").filter({ hasText: workspaceName });
  await expect(workspaceRow, `Linked Drive workspace "${workspaceName}" was not found.`).toHaveCount(1);
  await workspaceRow.getByRole("button", { name: /^(Open|Openen)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[role=tree]")).toBeVisible({ timeout: timeoutMs });
  return performance.now() - startedAt;
}

/**
 * Expands a document path and opens it in the editor.
 * @param page Active Drive workspace page.
 * @param documentPath Workspace-relative Markdown path.
 * @returns CodeMirror editable element.
 */
async function openDocument(page: Page, documentPath: string): Promise<Locator> {
  const segments = documentPath.split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    const directoryPath = segments.slice(0, index).join("/");
    const directory = page.getByTitle(directoryPath, { exact: true });
    if (await directory.locator("..").getAttribute("aria-expanded") === "false") await directory.click();
  }
  await page.getByTitle(documentPath, { exact: true }).click();
  const editor = page.locator(".cm-content[contenteditable=true]");
  await expect(editor).toBeVisible();
  await expect(page.locator("footer [data-state=clean]")).toBeVisible();
  return editor;
}

/**
 * Copies the complete CodeMirror document through the browser clipboard.
 * @param page Page containing the active editor.
 * @returns Exact editor text with normalized line endings.
 */
async function readEditorContent(page: Page): Promise<string> {
  const editor = page.locator(".cm-content[contenteditable=true]");
  await editor.focus();
  await editor.press("Control+A");
  await editor.press("Control+C");
  return page.evaluate(readClipboardText);
}

/**
 * Replaces the complete editor document without logging its content.
 * @param page Page containing the active editor.
 * @param content Exact replacement Markdown.
 * @returns Nothing after CodeMirror receives the replacement.
 */
async function replaceEditorContent(page: Page, content: string): Promise<void> {
  const editor = page.locator(".cm-content[contenteditable=true]");
  await editor.focus();
  await editor.press("Control+A");
  await page.keyboard.insertText(content);
  await expect(page.locator("footer [data-state=dirty-local]")).toBeVisible({ timeout: 5_000 });
}

/**
 * Saves the active editor and waits for Google to acknowledge the uploaded revision.
 * @param page Writer browser page.
 * @returns Mutation duration measured from the save shortcut.
 */
async function saveToDrive(page: Page): Promise<number> {
  const editor = page.locator(".cm-content[contenteditable=true]");
  const startedAt = performance.now();
  const mutation = page.waitForResponse(isSuccessfulDriveMutation, { timeout: 30_000 });
  await editor.press("Control+S", { timeout: 10_000 });
  await mutation;
  await expect(page.locator("footer [data-state=clean]")).toBeVisible();
  return performance.now() - startedAt;
}

/**
 * Creates one isolated authenticated device-like browser context.
 * @param browser Playwright browser process.
 * @returns Independent browser context sharing only the saved server session.
 */
async function createDeviceContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: getE2eBaseUrl(),
    storageState: getAuthStatePath(),
    permissions: ["clipboard-read", "clipboard-write"],
  });
  if (process.env.E2E_DEFER_BACKGROUND_CONTENT === "true") await context.addInitScript(enableDataSaverMode);
  return context;
}

/**
 * Runs the reversible two-browser real-Drive synchronization scenario.
 * @param fixtures Playwright browser fixture.
 * @param testInfo Current test artifact controller.
 * @returns Nothing after verification and rollback complete.
 */
async function verifyTwoBrowserDriveSync({ browser }: { browser: Browser }, testInfo: TestInfo): Promise<void> {
  const workspaceName = process.env.E2E_DRIVE_WORKSPACE ?? "vault";
  const documentPath = process.env.E2E_DRIVE_DOCUMENT ?? "working-memory.md";
  const requiredAcknowledgement = `${workspaceName}/${documentPath}`;
  const authStatePath = getAuthStatePath();
  const syncTimeoutMs = getBoundedPositiveInteger(process.env.E2E_SYNC_TIMEOUT_MS, 45_000, 180_000);
  const workspaceTimeoutMs = getBoundedPositiveInteger(process.env.E2E_WORKSPACE_TIMEOUT_MS, 90_000, 180_000);

  expect(process.env.E2E_DRIVE_MUTATION_ACK, `Set E2E_DRIVE_MUTATION_ACK=${requiredAcknowledgement} after confirming this is dedicated, test-safe Drive data.`).toBe(requiredAcknowledgement);
  expect(fs.existsSync(authStatePath), `Authentication state is missing. Run "pnpm test:e2e:drive:auth" first.`).toBe(true);

  const writerContext = await createDeviceContext(browser);
  const readerContext = await createDeviceContext(browser);
  const writerPage = await writerContext.newPage();
  const readerPage = await readerContext.newPage();
  const writerTraffic = observeDriveTraffic(writerPage);
  const readerTraffic = observeDriveTraffic(readerPage);
  const outboundMarker = `notemarkdown-e2e-outbound-${crypto.randomUUID()}`;
  const returnMarker = `notemarkdown-e2e-return-${crypto.randomUUID()}`;
  let originalContent = "";
  let mutated = false;
  let cleanupPage = writerPage;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;

  try {
    const [writerActivationMs, readerActivationMs] = await Promise.all([
      openDriveWorkspace(writerPage, workspaceName, workspaceTimeoutMs),
      openDriveWorkspace(readerPage, workspaceName, workspaceTimeoutMs),
    ]);
    await Promise.all([
      openDocument(writerPage, documentPath),
      openDocument(readerPage, documentPath),
    ]);

    const [writerOriginal, readerOriginal] = await Promise.all([
      readEditorContent(writerPage),
      readEditorContent(readerPage),
    ]);
    expect(writerOriginal === readerOriginal, "Both browsers must begin at the same exact revision.").toBe(true);
    originalContent = writerOriginal;
    const separator = originalContent.length === 0 || originalContent.endsWith("\n") ? "" : "\n";
    const outboundContent = `${originalContent}${separator}${outboundMarker}`;
    const outboundEditStartedAt = performance.now();

    await replaceEditorContent(writerPage, outboundContent);
    mutated = true;
    const writerMutationMs = await saveToDrive(writerPage);
    const outboundMutationCompletedAt = performance.now();

    await readerPage.bringToFront();
    await readerPage.evaluate(dispatchWindowFocus);

    /**
     * Checks one page for exact content without returning document bytes to reports.
     * @param page Browser page to inspect.
     * @param expectedContent Complete expected editor content.
     * @returns Whether the page has the complete expected revision.
     */
    async function pageHasExactContent(page: Page, expectedContent: string): Promise<boolean> {
      return await readEditorContent(page) === expectedContent;
    }

    await expect.poll(() => pageHasExactContent(readerPage, outboundContent), {
      message: "The second isolated browser did not receive the exact outbound Drive revision.",
      timeout: syncTimeoutMs,
      intervals: [50, 100, 100, 200, 250],
    }).toBe(true);

    const readerObservedAt = performance.now();
    const returnContent = `${outboundContent}\n${returnMarker}`;
    const returnEditStartedAt = performance.now();
    await replaceEditorContent(readerPage, returnContent);
    const readerMutationMs = await saveToDrive(readerPage);
    cleanupPage = readerPage;
    const returnMutationCompletedAt = performance.now();

    await writerPage.bringToFront();
    await writerPage.evaluate(dispatchWindowFocus);
    await expect.poll(() => pageHasExactContent(writerPage, returnContent), {
      message: "The original writer did not receive the exact return Drive revision after handoff.",
      timeout: syncTimeoutMs,
      intervals: [50, 100, 100, 200, 250],
    }).toBe(true);

    const writerObservedAt = performance.now();
    cleanupPage = writerPage;
    const metrics: DriveSyncMetrics = {
      browserVersion: browser.version(),
      backgroundContentDeferred: process.env.E2E_DEFER_BACKGROUND_CONTENT === "true",
      exactContentMatch: true,
      writerActivationMs: Math.round(writerActivationMs),
      readerActivationMs: Math.round(readerActivationMs),
      writerMutationMs: Math.round(writerMutationMs),
      readerVisibilityMs: Math.round(readerObservedAt - outboundEditStartedAt),
      visibilityAfterMutationMs: Math.round(readerObservedAt - outboundMutationCompletedAt),
      readerMutationMs: Math.round(readerMutationMs),
      writerReturnVisibilityMs: Math.round(writerObservedAt - returnEditStartedAt),
      returnVisibilityAfterMutationMs: Math.round(writerObservedAt - returnMutationCompletedAt),
      writerTraffic,
      readerTraffic,
    };
    await testInfo.attach("drive-sync-metrics.json", {
      body: Buffer.from(JSON.stringify(metrics, null, 2)),
      contentType: "application/json",
    });
  } catch (error) {
    primaryFailure = error;
  }

  if (mutated) {
    try {
      await cleanupPage.bringToFront();
      await replaceEditorContent(cleanupPage, originalContent);
      await saveToDrive(cleanupPage);
    } catch (error) {
      cleanupFailure = error;
    }
  }

  await Promise.all([writerContext.close(), readerContext.close()]);
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw new Error("Drive verification passed, but restoring the original document failed.", { cause: cleanupFailure });
}

test("an exact Drive edit survives a bidirectional isolated-browser handoff", verifyTwoBrowserDriveSync);

/**
 * Verifies that an expired NoteMarkdown session remains distinguishable from Drive transfer failure.
 * @param fixtures Playwright browser fixture.
 * @returns Nothing after a blocked local-only edit reports its actionable reason.
 */
async function verifyExpiredSessionDiagnostic({ browser }: { browser: Browser }): Promise<void> {
  const workspaceName = process.env.E2E_DRIVE_WORKSPACE ?? "vault";
  const documentPath = process.env.E2E_DRIVE_DOCUMENT ?? "working-memory.md";
  const workspaceTimeoutMs = getBoundedPositiveInteger(process.env.E2E_WORKSPACE_TIMEOUT_MS, 90_000, 180_000);
  const context = await createDeviceContext(browser);
  const page = await context.newPage();
  const traffic = observeDriveTraffic(page);

  try {
    await openDriveWorkspace(page, workspaceName, workspaceTimeoutMs);
    await openDocument(page, documentPath);
    const originalContent = await readEditorContent(page);

    await page.route("**/api/v1/drive/token", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unauthorized", message: "The session expired or was revoked." } }),
      });
    });
    await page.route("https://www.googleapis.com/**", async (route) => {
      await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
    });

    const separator = originalContent.length === 0 || originalContent.endsWith("\n") ? "" : "\n";
    const localContent = `${originalContent}${separator}notemarkdown-e2e-expired-session-${crypto.randomUUID()}`;
    await replaceEditorContent(page, localContent);
    await page.locator(".cm-content[contenteditable=true]").press("Control+S");

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("session expired or was revoked", { timeout: 15_000 });
    await expect(alert).toContainText("Sign in again before Google Drive can synchronize");
    await expect(alert).toContainText("draft remains stored locally");
    await expect(page.locator("footer [data-state=queued]")).toBeVisible();
    expect(await readEditorContent(page)).toBe(localContent);
    expect(traffic.mutations, "A simulated expired session must not reach a Drive mutation.").toBe(0);
  } finally {
    await context.close();
  }
}

test("an expired server session reports an actionable local-draft diagnostic", verifyExpiredSessionDiagnostic);

/**
 * Verifies that an auto-restored workspace with a removed connected account fails promptly instead of retrying for minutes.
 * @param fixtures Playwright browser fixture.
 * @returns Nothing after the warm workspace reports one blocking token failure.
 */
async function verifyRemovedConnectedAccountStopsPromptly({ browser }: { browser: Browser }): Promise<void> {
  const workspaceName = process.env.E2E_DRIVE_WORKSPACE ?? "vault";
  const workspaceTimeoutMs = getBoundedPositiveInteger(process.env.E2E_WORKSPACE_TIMEOUT_MS, 90_000, 180_000);
  const context = await createDeviceContext(browser);
  await context.addInitScript(enableDataSaverMode);
  const seedPage = await context.newPage();

  try {
    const initialReconciliation = seedPage.waitForResponse((response) => response.ok() && response.url().includes("/drive/v3/changes"), { timeout: workspaceTimeoutMs });
    await openDriveWorkspace(seedPage, workspaceName, workspaceTimeoutMs);
    await initialReconciliation;
    await seedPage.close();

    const restoredPage = await context.newPage();
    let tokenRequests = 0;
    let driveRequests = 0;
    await restoredPage.route("**/api/v1/drive/token", async (route) => {
      tokenRequests += 1;
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not-found", message: "Connected account was not found." } }) });
    });
    await restoredPage.route("https://www.googleapis.com/**", async (route) => {
      driveRequests += 1;
      await route.abort();
    });

    const startedAt = performance.now();
    await restoredPage.goto(getE2eBaseUrl());
    await expect(restoredPage.locator("[role=tree]")).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => tokenRequests, { message: "The restored workspace never attempted token acquisition.", timeout: 12_000 }).toBe(1);
    await expect(restoredPage.getByRole("alert")).toContainText("saved workspace is no longer available", { timeout: 3_000 });
    expect(performance.now() - startedAt, "A removed connected account must fail before exponential provider retries accumulate.").toBeLessThan(15_000);
    expect(tokenRequests, "The blocking missing-account response must not be retried.").toBe(1);
    expect(driveRequests, "No direct Drive request is possible without a valid connected account.").toBe(0);
  } finally {
    await context.close();
  }
}

test("a removed connected account does not trap an old workspace in retries", verifyRemovedConnectedAccountStopsPromptly);
