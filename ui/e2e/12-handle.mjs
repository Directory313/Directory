export default async function ({ page, shot }) {
  const k = 1 / (await page.evaluate(() => window.devicePixelRatio)); console.log("dpr", 1 / k);
  await page.mouse.move(1265 * k, 453 * k); await page.mouse.down();
  await page.mouse.move(1420 * k, 540 * k, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(400); await shot('12-after-400ms');
  await page.waitForTimeout(2500); await shot('12-after-3s');
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: /^Scale$/ }) }).first();
  console.log('scale field:', await row.locator('.num').allTextContents());
}
