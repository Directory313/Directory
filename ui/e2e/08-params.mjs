// Bug 1.1 repro: edit properties through the real inspector and measure the preview canvas.
const MEDIA = process.env.VEYRA_TEST_MEDIA;
const bbox = (page) => page.evaluate(() => {
  const cv = document.querySelector('.vw-canvas');
  const g = cv.getContext('2d'); const { width: w, height: h } = cv;
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; const v = d[i] + d[i + 1] + d[i + 2];
    if (v > 150) { n++; sum += v; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { w, h, box: [x0, y0, x1, y1], lit: n, mean: n ? Math.round(sum / n) : 0 };
});
async function setField(page, label, idx, value) {
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  const f = row.locator('.num').nth(idx);
  await f.click();
  const inp = row.locator('input.num-input');
  await inp.fill(String(value));
  await inp.press('Enter');
}
export default async function ({ page, shot }) {
  await page.reload();
  await page.waitForSelector('.home', { timeout: 20000 });
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell', { timeout: 15000 });
  await page.evaluate(async (dir) => { await window.__veyra.importPaths([`${dir}/pic.png`], 'timeline'); }, MEDIA);
  await page.waitForTimeout(2500);
  const id = await page.evaluate(() => { const s = window.__veyra.useEditor.getState(); const l = s.project.compositions[0].layers[0]; s.select([l.id]); s.setTime(1); return l.id; });
  await page.waitForTimeout(1500);
  const report = [];
  const step = async (name, fn) => {
    const before = await bbox(page);
    const t0 = Date.now();
    await fn();
    let after = before;
    for (let i = 0; i < 40; i++) { await page.waitForTimeout(100); after = await bbox(page); if (JSON.stringify(after) !== JSON.stringify(before)) break; }
    const ms = Date.now() - t0;
    await page.waitForTimeout(600);
    const settled = await bbox(page);
    const store = await page.evaluate((lid) => JSON.stringify(window.__veyra.useEditor.getState().project.compositions[0].layers.find((l) => l.id === lid).transform), id);
    report.push({ name, changed: JSON.stringify(before) !== JSON.stringify(settled), firstChangeMs: ms, before, settled });
    console.log(name, '| changed:', JSON.stringify(before) !== JSON.stringify(settled), `| ${ms} ms`, JSON.stringify(before.box), '->', JSON.stringify(settled.box), 'mean', before.mean, '->', settled.mean);
    void store;
  };
  await shot('08-start');
  await step('scale 50%', () => setField(page, 'Scale', 0, 50));
  await shot('08-scaled');
  await step('rotation 45', () => setField(page, 'Rotation', 0, 45));
  await step('opacity 40', () => setField(page, 'Opacity', 0, 40));
  await step('position x 300', () => setField(page, 'Position', 0, 300));
  // keyframes: stopwatch on scale at t=1, then change at t=2
  await step('keyframe scale', async () => {
    const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: /^Scale$/ }) }).first();
    await row.locator('button').first().click();
    await page.evaluate(() => window.__veyra.useEditor.getState().setTime(2));
    await page.waitForTimeout(400);
    await setField(page, 'Scale', 0, 120);
  });
  await step('scrub back to t=1', () => page.evaluate(() => window.__veyra.useEditor.getState().setTime(1)));
  await shot('08-end');
  const eng = await page.evaluate(async () => { const s = window.__veyra.useEditor.getState(); return { rev: s.revision, synced: s.syncedRevision }; });
  console.log('revisions', JSON.stringify(eng));
}
