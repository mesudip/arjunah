import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import puppeteer from "puppeteer";

const output = resolve(
  process.argv[2] || "docs/store-assets/settings-1280x800.png",
);
const profile = await mkdtemp(join(tmpdir(), "arjunah-store-shot-"));
let browser;

try {
  const extensionPath = resolve("src");
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: profile,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === "service_worker" &&
      target.url().startsWith("chrome-extension://"),
    { timeout: 15000 },
  );
  const extensionId = new URL(workerTarget.url()).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`chrome-extension://${extensionId}/options.html`, {
    waitUntil: "networkidle0",
  });
  await mkdir(dirname(output), { recursive: true });
  await page.screenshot({ path: output, type: "png" });
} finally {
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
}
