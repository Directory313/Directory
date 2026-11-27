export default async function ({ page, shot, logs }) {
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: /^Opacity$/ }) }).first();
  const num = row.locator('.num').first();
  console.log('num text before:', await num.textContent());
  await num.click();
  await page.waitForTimeout(300);
  const inp = row.locator('input.num-input');
  console.log('input visible:', await inp.count());
  if (await inp.count()) { await inp.fill('55'); await inp.press('Enter'); }
  await page.waitForTimeout(800);
  console.log('num text after:', await row.locator('.num').first().textContent());
  // try scrubbing by drag
  const b = await row.locator('.num').first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 - 60, b.y + b.height / 2, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(800);
  console.log('after drag:', await row.locator('.num').first().textContent());
  await shot('11');
}
