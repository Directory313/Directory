export default async function ({ page }) {
  await page.reload();
  await page.waitForSelector('.home', { timeout: 30000 });
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell', { timeout: 15000 });
  await page.evaluate(async () => { await window.__veyra.ops.addLayer({ kind: 'shape', variant: 'rect' }, 'Add rect'); });
  await page.waitForTimeout(1500);
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: /^Opacity$/ }) }).first();
  const b = await row.locator('.num').first().boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5); await page.mouse.down(); await page.mouse.move(b.x - 60, b.y + 5, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(800);
}
