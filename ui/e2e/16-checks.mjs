// Real-app checks for the beta bug report: ellipse tool, exact colour, layer order,
// 3D rotation (inspector), easing presets (no added keys), per-project layout.
const out = [];
const ok = (name, pass, info = '') => { out.push(`${pass ? 'PASS' : 'FAIL'}  ${name} ${info}`); };
async function pixel(page, fx, fy) { // fx, fy = fraction of the comp
  await page.waitForTimeout(1200);
  return page.evaluate(([fx, fy]) => { const cv = document.querySelector('.vw-canvas'); const d = cv.getContext('2d').getImageData(Math.floor(cv.width * fx), Math.floor(cv.height * fy), 1, 1).data; return [d[0], d[1], d[2]]; }, [fx, fy]);
}
async function canvasHash(page) {
  await page.waitForTimeout(1500);
  return page.evaluate(() => { const cv = document.querySelector('.vw-canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0; return h; });
}
async function setField(page, label, idx, value) {
  const row = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  await row.locator('.num').nth(idx).click();
  const inp = row.locator('input.num-input');
  await inp.fill(String(value)); await inp.press('Enter');
}
const S = (page, fn, arg) => page.evaluate(fn, arg);
export default async function ({ page, shot }) {
  await page.reload();
  await page.waitForSelector('.home', { timeout: 30000 });
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // 1. Ellipse tool: draw in the viewer.
  await page.click('.vw-tools button[title^="Ellipse"]');
  const fr = await page.locator('.vw-frame').boundingBox();
  await page.mouse.move(fr.x + fr.width * 0.35, fr.y + fr.height * 0.3); await page.mouse.down();
  await page.mouse.move(fr.x + fr.width * 0.65, fr.y + fr.height * 0.7, { steps: 8 }); await page.mouse.up();
  const px = await pixel(page, 0.5, 0.5);
  const n = await S(page, () => window.__veyra.useEditor.getState().project.compositions[0].layers.length);
  ok('ellipse tool draws a visible ellipse', n === 1 && px[0] > 240 && px[1] > 240, JSON.stringify({ layers: n, centre: px }));
  const corner = await pixel(page, 0.36, 0.31);
  ok('ellipse is round (bounding-box corner empty)', corner[0] < 40, JSON.stringify(corner));

  // 2. Exact colour through the colour picker hex box.
  await page.click('.vw-tools button[title^="Select"]');
  const fillRow = page.locator('.prop-row', { has: page.locator('.prop-label', { hasText: /^Colour$/ }) }).first();
  await fillRow.locator('.swatch').click();
  const hex = page.locator('.popover input.input.mono, input.input.mono.grow').last();
  await hex.fill('#3a7bd5');
  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(fr.x + 5, fr.y - 20);
  const c = await pixel(page, 0.5, 0.5);
  ok('picked colour #3A7BD5 appears exactly', c[0] === 0x3a && c[1] === 0x7b && c[2] === 0xd5, JSON.stringify(c));

  // 3. Layer order: add a full-frame solid (goes on top), then drag the ellipse above it.
  await S(page, async () => { await window.__veyra.ops.addLayer({ kind: 'solid', color: [1, 0, 0, 1] }, 'Add Solid'); });
  const top1 = await pixel(page, 0.5, 0.5);
  const list = page.locator('.tl-left-list');
  const ell = list.getByText('Ellipse', { exact: true }).first();
  const sol = list.getByText(/^Solid/).first();
  const eb = await ell.boundingBox(), sb = await sol.boundingBox();
  await page.mouse.move(eb.x + 10, eb.y + eb.height / 2); await page.mouse.down();
  await page.mouse.move(sb.x + 10, sb.y + 2, { steps: 10 }); await page.mouse.up();
  const top2 = await pixel(page, 0.5, 0.5);
  const order = await S(page, () => window.__veyra.useEditor.getState().project.compositions[0].layers.map((l) => l.name));
  ok('dragging a layer to the top brings it to the front', top1[0] === 255 && top1[2] === 0 && top2[2] === 0xd5, JSON.stringify({ before: top1, after: top2, order }));

  // 4. 3D rotation from the inspector (solid made 3D) and a mesh.
  await S(page, () => { const s = window.__veyra.useEditor.getState(); const l = s.project.compositions[0].layers.find((x) => x.name.startsWith('Solid')); s.edit('scale', (d) => { const y = d.compositions[0].layers.find((q) => q.id === l.id); y.is3d = true; y.transform.scale.value = [40, 40, 100]; }); s.select([l.id]); });
  let h0 = await canvasHash(page);
  for (const [i, axis] of [[0, 'X'], [1, 'Y'], [2, 'Z']]) {
    await setField(page, 'Rotation X/Y/Z', i, 50);
    const h1 = await canvasHash(page);
    ok(`3D layer rotation ${axis} changes the image`, h1 !== h0); h0 = h1;
  }
  await S(page, async () => { const s = window.__veyra.useEditor.getState(); s.edit('hide', (d) => { d.compositions[0].layers.forEach((l) => { l.visible = false; }); }); const l = await window.__veyra.ops.addLayer({ kind: 'mesh', variant: 'cube' }, 'Add cube'); if (l) s.select([l.id]); });
  h0 = await canvasHash(page);
  for (const [i, axis] of [[0, 'X'], [1, 'Y'], [2, 'Z']]) {
    await setField(page, 'Rotation X/Y/Z', i, 70 + i * 10);
    const h1 = await canvasHash(page);
    ok(`3D cube rotation ${axis} changes the image`, h1 !== h0); h0 = h1;
  }
  await shot('16-cube');

  // 5. Easing preset: two keys, apply Bounce Out from the Library -> still two keys, curve changed.
  const res = await S(page, async () => {
    const v = window.__veyra, s = v.useEditor.getState();
    const id = s.selectedLayers[0];
    s.edit('keys', (d) => { const l = d.compositions[0].layers.find((x) => x.id === id); l.transform.position.keys = [{ t: 0, v: [600, 540, 0], interp: 'linear' }, { t: 1, v: [1300, 540, 0], interp: 'linear' }]; });
    return id;
  });
  void res;
  await page.click('.flexlayout__tab_button >> text=Library').catch(() => {});
  await page.click('.lib-tabs >> text=Animate');
  await page.click('.ease-tile >> text=Bounce Out');
  await page.waitForTimeout(500);
  const k = await S(page, () => { const s = window.__veyra.useEditor.getState(); const l = s.project.compositions[0].layers.find((x) => x.id === s.selectedLayers[0]); return l.transform.position.keys.map((q) => q.interp); });
  ok('Bounce Out keeps 2 keyframes and sets the curve', k.length === 2 && k[0] === 'bounceOut', JSON.stringify(k));
  await page.click('.ease-tile >> text=Back Out (overshoot)');
  await page.waitForTimeout(400);
  const k2 = await S(page, () => { const s = window.__veyra.useEditor.getState(); const l = s.project.compositions[0].layers.find((x) => x.id === s.selectedLayers[0]); return l.transform.position.keys.map((q) => ({ i: q.interp, o: q.outH, n: q.inH })); });
  ok('Back Out sets overshooting bezier handles', k2.length === 2 && k2[0].i === 'bezier' && k2[1].n.y === 1 && k2[0].o.y > 1, JSON.stringify(k2));
  for (const l of out) console.log(l);
}
