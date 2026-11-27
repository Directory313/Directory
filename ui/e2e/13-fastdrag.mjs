// Rapid handle drags, then check whether the preview still follows the edits.
export default async function ({ page, shot }) {
  const k = 1 / (await page.evaluate(() => window.devicePixelRatio));
  for (let r = 0; r < 6; r++) {
    const h = await page.locator('.ov-handle, [data-handle]').count().catch(() => 0);
    // bottom-right handle from the overlay
    const box = await page.evaluate(() => { const el = [...document.querySelectorAll('.viewer svg rect, .viewer .ov-h')].pop(); const b = el?.getBoundingClientRect(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; });
    if (!box) break;
    await page.mouse.move(box.x, box.y); await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(box.x + (r % 2 ? -1 : 1) * i * 2, box.y + (r % 2 ? -1 : 1) * i, { steps: 1 });
    await page.mouse.up();
    void h;
  }
  await page.waitForTimeout(3000);
  await shot('13-after-fast-drags');
  // One more slow, definite edit: drag opacity scrubber; if preview is frozen it won't change.
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: /^Opacity$/ }) }).first();
  const b = await row.locator('.num').first().boundingBox();
  await page.mouse.move(b.x + 5, b.y + 5); await page.mouse.down(); await page.mouse.move(b.x + 120, b.y + 5, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(2500);
  await shot('13-after-opacity');
  console.log('opacity now', await row.locator('.num').first().textContent(), 'k', k);
}
