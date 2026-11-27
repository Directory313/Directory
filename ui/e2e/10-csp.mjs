export default async function ({ page }) {
  const r = await page.evaluate(() => { try { return String(Function('"use strict";return (1+2)')()); } catch (e) { return 'BLOCKED: ' + e.message; } });
  console.log('Function() in this build:', r);
}
