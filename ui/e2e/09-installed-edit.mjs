// Bug 1.1 on the INSTALLED release build (no dev hooks): new solid via shortcut, edit in inspector,
// screenshot the viewer after each edit.
async function setField(page, label, idx, value) {
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  await row.locator('.num').nth(idx).click();
  const inp = row.locator('input.num-input');
  await inp.fill(String(value));
  await inp.press('Enter');
}
export default async function ({ page, shot }) {
  await page.waitForSelector('.home, .editor-shell', { timeout: 30000 });
  if (await page.locator('.home').count()) await page.click('text=Create project');
  await page.waitForSelector('.editor-shell', { timeout: 15000 });
  await page.waitForTimeout(1500);
  if (!(await page.locator('.home').count())) { /* already in editor */ }
  await page.click('.lib-tabs >> text=Shapes').catch(async () => { await page.click('text=Library'); await page.click('.lib-tabs >> text=Shapes'); });
  await page.click('.lib-tile >> nth=0');
  await page.waitForTimeout(800);
  if (!(await page.locator('.prop-row').count())) {
    await page.click('.menubar-item:has-text("Window")');
    await page.click('text=Show Inspector');
  }
  await page.waitForTimeout(2000);
  await shot('09-a-new');
  await setField(page, 'Scale', 0, 40);
  await page.waitForTimeout(2000);
  await shot('09-b-scale40');
  await setField(page, 'Rotation', 0, 30);
  await page.waitForTimeout(2000);
  await shot('09-c-rot30');
}
