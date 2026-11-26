export default async function ({ page, shot }) {
  await page.reload();
  await page.waitForSelector('.home', { timeout: 15000 });
  await page.waitForTimeout(3000); // GPU + capability probe
  await shot('01-home');
  console.log('home text:', (await page.locator('.home-sys').innerText()).replace(/\n/g, ' | '));
}
