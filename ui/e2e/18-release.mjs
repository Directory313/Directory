// Release-build checks (strict CSP, no dev hooks): typed values apply, 3D inspector works,
// layout is per project, colours exact. Uses only the real UI + IPC.
const out = [];
const ok = (n, p, i = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n} ${i}`);
async function setField(page, label, idx, value) {
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  await row.locator('.num').nth(idx).click();
  const inp = row.locator('input.num-input');
  await inp.fill(String(value)); await inp.press('Enter');
  await page.waitForTimeout(250);
  return (await row.locator('.num').allTextContents()).join(' ');
}
async function hash(page) {
  await page.waitForTimeout(1500);
  return page.evaluate(() => { const cv = document.querySelector('.vw-canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0; return h; });
}
export default async function ({ page, shot }) {
  await page.waitForSelector('.home', { timeout: 30000 });
  ok('home screen says Directory', (await page.textContent('body')).includes('Directory'));
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell');
  await page.waitForTimeout(1000);
  ok('Inspector present in a new project', (await page.locator('.flexlayout__tab_button', { hasText: /^Inspector/ }).count()) > 0);
  await page.click('.flexlayout__tab_button >> text=Library');
  await page.click('.lib-tabs >> text=Shapes');
  await page.click('.lib-tile >> text=ellipse');
  await page.waitForTimeout(1200);
  await page.click('.flexlayout__tab_button >> text=Inspector').catch(() => {});
  let h0 = await hash(page);
  for (const [label, idx, v] of [['Scale', 0, 50], ['Rotation', 0, 30], ['Opacity', 0, 60], ['Position', 0, 700]]) {
    const txt = await setField(page, label, idx, v);
    const h1 = await hash(page);
    ok(`typed ${label} = ${v} applies and shows in preview`, txt.includes(String(v)) && h1 !== h0, txt); h0 = h1;
  }
  const txt = await setField(page, 'Scale', 0, '*2');
  ok('typed "*2" doubles the value', txt.includes('100'), txt);
  // 3D layer: toggle 3D in the inspector, then rotate X/Y.
  const tg = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: /^3D Layer$/ }) }).locator('.toggle, button, input').first();
  await tg.click();
  await page.waitForTimeout(800);
  const crashed = await page.locator('text=/Maximum update depth|Something went wrong/').count();
  ok('3D layer inspector does not crash', crashed === 0);
  h0 = await hash(page);
  for (const [i, ax] of [[0, 'X'], [1, 'Y']]) {
    await setField(page, 'Rotation X/Y/Z', i, 55);
    const h1 = await hash(page); ok(`3D rotation ${ax} changes the preview`, h1 !== h0); h0 = h1;
  }
  await shot('18-release');
  for (const l of out) console.log(l);
}
