// The consent sheet takes focus itself and arms Allow only after it has been
// visible for CONSENT_ARM_MS (src/content.js), so a test answers it the way a
// keyboard user does: wait, then Shift+Tab to the last button (Allow) or the
// one before it (Deny), then Enter.
export const CONSENT_ARM_WAIT = 1300;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function shiftTab(page) {
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
}

export async function approveConsent(page) {
  await pause(CONSENT_ARM_WAIT);
  await shiftTab(page);
  await page.keyboard.press("Enter");
}

export async function denyConsent(page) {
  await pause(200);
  await shiftTab(page);
  await shiftTab(page);
  await page.keyboard.press("Enter");
}
