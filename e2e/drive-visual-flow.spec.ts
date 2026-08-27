import crypto from "node:crypto";
import fs from "node:fs";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { getAuthStatePath, getBoundedPositiveInteger, getE2eBaseUrl } from "./support/environment";

interface CapturedFrame {
  file: string;
  elapsedMs: number;
  phase: string;
}

interface FrameRecorder {
  setPhase: (phase: string) => void;
  capture: () => Promise<void>;
  stop: () => Promise<CapturedFrame[]>;
}

/**
 * Creates a screenshot recorder that keeps only consecutive pixel changes.
 * @param page Browser page to capture.
 * @param testInfo Playwright artifact path provider.
 * @param intervalMs Delay between screenshot attempts.
 * @returns Recorder controls and the final frame manifest.
 */
async function createFrameRecorder(page: Page, testInfo: TestInfo, intervalMs: number): Promise<FrameRecorder> {
  const outputDirectory = testInfo.outputPath("drive-visual-flow");
  fs.mkdirSync(outputDirectory, { recursive: true });

  const session = await page.context().newCDPSession(page);
  const startedAt = performance.now();
  const frames: CapturedFrame[] = [];
  let phase = "browser-open";
  let previousHash: string | null = null;
  let stopped = false;

  /**
   * Stores one JPEG frame unless it equals the immediately preceding frame.
   * @param image Encoded JPEG bytes.
   * @returns Nothing after the optional file write completes.
   */
  const storeFrame = (image: Buffer): void => {
    if (stopped) return;
    const hash = crypto.createHash("sha256").update(image).digest("hex");
    if (hash === previousHash) return;

    previousHash = hash;
    const sequence = String(frames.length + 1).padStart(4, "0");
    const file = `${sequence}-${phase.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}.jpeg`;
    fs.writeFileSync(`${outputDirectory}/${file}`, image);
    frames.push({ file, elapsedMs: Math.round(performance.now() - startedAt), phase });
  };

  /**
   * Stores and acknowledges one browser-pushed screencast frame.
   * @param event Encoded frame and Chrome screencast session identifier.
   * @returns Nothing after acknowledgement is sent.
   */
  const receiveFrame = async (event: { data: string; sessionId: number }): Promise<void> => {
    storeFrame(Buffer.from(event.data, "base64"));
    await session.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  };

  session.on("Page.screencastFrame", receiveFrame);
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 90,
    maxWidth: 1440,
    maxHeight: 1000,
    everyNthFrame: Math.max(1, Math.round(intervalMs / (1_000 / 60))),
  });

  return {
    /** @param nextPhase Human-readable phase for subsequent file names. @returns Nothing. */
    setPhase: (nextPhase: string): void => { phase = nextPhase; },
    /** @returns Nothing after one immediate milestone frame is captured. */
    capture: async (): Promise<void> => {
      const result = await session.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
      storeFrame(Buffer.from(result.data, "base64"));
    },
    /** @returns Captured frame metadata after the recorder has stopped. */
    stop: async (): Promise<CapturedFrame[]> => {
      await session.send("Page.stopScreencast");
      stopped = true;
      session.off("Page.screencastFrame", receiveFrame);
      fs.writeFileSync(`${outputDirectory}/manifest.json`, JSON.stringify({ intervalMs, frames }, null, 2));
      return frames;
    },
  };
}

/**
 * Records the complete read-only journey from a blank browser to a loaded Drive workspace.
 * @param fixtures Playwright browser fixture.
 * @param testInfo Playwright artifact controller.
 * @returns Nothing after screenshots and their manifest have been written.
 */
async function recordDriveWorkspaceJourney(
  { browser }: { browser: Browser },
  testInfo: TestInfo,
): Promise<void> {
  const authStatePath = getAuthStatePath();
  const workspaceName = process.env.E2E_DRIVE_WORKSPACE;
  const intervalMs = getBoundedPositiveInteger(process.env.E2E_VISUAL_FRAME_INTERVAL_MS, 200, 2_000);

  expect(fs.existsSync(authStatePath), "Authentication state is missing. Run `pnpm test:e2e:drive:auth` first.").toBe(true);

  const context = await browser.newContext({
    baseURL: getE2eBaseUrl(),
    storageState: authStatePath,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const recorder = await createFrameRecorder(page, testInfo, intervalMs);
  let frames: CapturedFrame[] = [];

  try {
    await recorder.capture();
    recorder.setPhase("application-loading");
    await page.goto(getE2eBaseUrl(), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Google Drive/i })).toBeVisible();
    await recorder.capture();

    recorder.setPhase("drive-dialog-opening");
    await page.getByRole("button", { name: /Google Drive/i }).click();
    const dialog = page.getByRole("dialog", { name: "Google Drive" });
    await expect(dialog).toBeVisible();
    await recorder.capture();

    recorder.setPhase("workspace-list-loading");
    const workspaceRows = dialog.getByRole("listitem");
    const workspaceRow = workspaceName ? workspaceRows.filter({ hasText: workspaceName }) : workspaceRows.first();
    if (workspaceName) {
      await expect(workspaceRow, `Linked Drive workspace "${workspaceName}" was not found.`).toHaveCount(1);
    } else {
      await expect(workspaceRow, "No linked Google Drive workspace was found.").toBeVisible();
    }
    await expect(workspaceRow.getByRole("button", { name: /^(Open|Openen)$/ })).toBeVisible();
    await recorder.capture();

    recorder.setPhase("workspace-opening");
    await workspaceRow.getByRole("button", { name: /^(Open|Openen)$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[role=tree]")).toBeVisible({ timeout: 120_000 });

    recorder.setPhase("workspace-loaded");
    await recorder.capture();
  } finally {
    frames = await recorder.stop();
    await context.close();
  }

  expect(frames.length, "The visual flow should produce more than one distinct frame.").toBeGreaterThan(1);
}

test("records opening a linked Google Drive workspace as distinct screenshots", recordDriveWorkspaceJourney);
