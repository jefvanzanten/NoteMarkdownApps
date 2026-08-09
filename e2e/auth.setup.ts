import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { getAuthStatePath, getE2eBaseUrl } from "./support/environment";

interface AuthenticationBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Connects to a normally launched Chrome browser without automation launch flags.
 * @returns Existing CDP browser, default context, and an available page.
 */
async function connectToAuthenticationBrowser(): Promise<AuthenticationBrowser> {
  const cdpUrl = process.env.E2E_AUTH_CDP_URL;
  if (!cdpUrl) throw new Error("E2E_AUTH_CDP_URL is required. Launch normal Chrome with remote debugging before authentication.");
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("The connected Chrome browser has no default context.");
  const page = context.pages()[0] ?? await context.newPage();
  return { browser, context, page };
}

/**
 * Opens the account and Drive workspace dialog from the welcome screen.
 * @param page Active NoteMarkdown page.
 * @returns The visible Google Drive dialog.
 */
async function openDriveDialog(page: Page) {
  await page.getByRole("button", { name: /Google Drive/i }).click();
  const dialog = page.getByRole("dialog", { name: "Google Drive" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Performs the one-time interactive Google login and saves only browser session state.
 * @returns Nothing after the ignored authentication file is written.
 */
async function saveDriveAuthentication(): Promise<void> {
  const { context, page } = await connectToAuthenticationBrowser();
  const baseUrl = getE2eBaseUrl();
  const applicationUrl = new URL(baseUrl);
  await page.goto(baseUrl);
  let dialog = await openDriveDialog(page);
  const signIn = dialog.getByRole("button", { name: /Google|Inloggen/i });

  if (await signIn.isVisible()) {
    await signIn.click();
    console.log("Complete the Google login in normal Chrome. Playwright will continue after NoteMarkdown returns.");

    /**
     * Recognizes the OAuth return navigation to the configured application.
     * @param url Current page URL candidate.
     * @returns Whether Google returned to NoteMarkdown.
     */
    function isApplicationReturn(url: URL): boolean {
      return url.origin === applicationUrl.origin && url.pathname.startsWith(applicationUrl.pathname);
    }

    await page.waitForURL(isApplicationReturn, { timeout: 9 * 60_000 });
    dialog = await openDriveDialog(page);
  }

  await expect(dialog.locator("small").filter({ hasText: "@" })).toBeVisible();
  await context.storageState({ path: getAuthStatePath() });
}

test("save authenticated Drive session", saveDriveAuthentication);
