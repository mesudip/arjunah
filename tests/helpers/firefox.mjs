import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Builder, Browser, By, Key } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { CONSENT_ARM_WAIT } from "./consent.mjs";
import {
  getInstalledBrowsers,
  detectBrowserPlatform,
} from "@puppeteer/browsers";

/**
 * The Firefox harness the browser suites share: the newest Firefox that
 * `npx puppeteer browsers install firefox@stable` left in the cache (or
 * FIREFOX_PATH), driven headless over WebDriver with the test extension
 * installed as a temporary add-on.
 */
export async function findFirefox() {
  if (process.env.FIREFOX_PATH) {
    if (existsSync(process.env.FIREFOX_PATH)) return process.env.FIREFOX_PATH;
    throw new Error("FIREFOX_PATH does not exist.");
  }
  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
  const installed = await getInstalledBrowsers({ cacheDir });
  const candidates = installed.filter(
    (item) =>
      item.browser === "firefox" &&
      item.platform === detectBrowserPlatform() &&
      existsSync(item.executablePath),
  );
  candidates.sort((a, b) =>
    b.buildId.localeCompare(a.buildId, undefined, { numeric: true }),
  );
  if (candidates.length) return candidates[0].executablePath;
  throw new Error(
    "Firefox was not found. Run: npx puppeteer browsers install firefox@stable, or set FIREFOX_PATH.",
  );
}

/** A headless Firefox with the add-on at `addonPath` installed. */
export async function launchFirefox(addonPath) {
  const firefoxPath = await findFirefox();
  const options = new firefox.Options()
    .setBinary(firefoxPath)
    .addArguments("-headless");
  options.setPreference("browser.tabs.warnOnClose", false);
  options.setPreference("browser.shell.checkDefaultBrowser", false);
  const driver = await new Builder()
    .forBrowser(Browser.FIREFOX)
    .setFirefoxOptions(options)
    .build();
  try {
    const addonId = await driver.installAddon(addonPath, true);
    return { driver, addonId, firefoxPath };
  } catch (error) {
    await driver.quit();
    throw error;
  }
}

/**
 * Opens a settings view the way a person does: the sidebar link for its
 * section, then a provider's row for that provider's own view. WebDriver will
 * not run scripts in extension pages, so it cannot set the address hash, and
 * rows redraw on every state change, so a click on a replaced one is retried.
 */
export async function openSettingsView(activeDriver, view) {
  const [section, provider] = view.split("/");
  const click = (css) =>
    activeDriver.wait(
      async () => {
        try {
          await activeDriver.findElement(By.css(css)).click();
          return true;
        } catch {
          return false;
        }
      },
      10000,
      `the settings link ${css}`,
    );
  await click(`a[data-nav="${section}"]`);
  if (provider) await click(`#provider-list a[data-provider="${provider}"]`);
  await activeDriver.wait(
    async () =>
      (await activeDriver
        .findElement(By.css(`main > [data-view="${view}"]`))
        .getProperty("hidden")) === false,
    10000,
    `the ${view} settings view`,
  );
}

/** The tab the add-on opened its options page in on install. */
export async function waitForExtensionOptions(activeDriver) {
  return activeDriver.wait(async () => {
    for (const handle of await activeDriver.getAllWindowHandles()) {
      await activeDriver.switchTo().window(handle);
      if ((await activeDriver.getCurrentUrl()).startsWith("moz-extension://"))
        return handle;
    }
    return false;
  }, 10000);
}

/**
 * Answer the consent sheet as a keyboard user does: it focuses itself and arms
 * Allow only after it has been visible a while (tests/helpers/consent.mjs).
 */
export async function approveFirefoxConsent(activeDriver) {
  await activeDriver.sleep(CONSENT_ARM_WAIT);
  await activeDriver
    .actions()
    .keyDown(Key.SHIFT)
    .sendKeys(Key.TAB)
    .keyUp(Key.SHIFT)
    .sendKeys(Key.ENTER)
    .perform();
}

export async function denyFirefoxConsent(activeDriver) {
  await activeDriver.sleep(200);
  await activeDriver
    .actions()
    .keyDown(Key.SHIFT)
    .sendKeys(Key.TAB, Key.TAB)
    .keyUp(Key.SHIFT)
    .sendKeys(Key.ENTER)
    .perform();
}
