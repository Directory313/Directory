// Transparent export through the Export dialog + playback performance measurement.
const OUT = process.env.VEYRA_TEST_OUT;
export default async function ({ page, shot }) {
  // Playback performance on the current (workflow) composition at Half preview.
  await page.evaluate(() => { const s = window.__veyra.useEditor.getState(); s.set({ previewScale: 0.5, time: 0, playing: false }); });
  await page.waitForTimeout(800);
  await page.keyboard.press('Space');
  await page.waitForTimeout(6000);
  const perf = await page.evaluate(() => { const s = window.__veyra.useEditor.getState(); return { fps: s.playbackFps, dropped: s.droppedFrames, t: s.time }; });
  await page.keyboard.press('Space');
  console.log('playback (Half, workflow comp):', JSON.stringify(perf));

  // New transparent composition with an animated star.
  await page.evaluate(async () => {
    const v = window.__veyra;
    const s = v.useEditor.getState();
    const c = await v.api.newComposition(1280, 720, 30, 2, 'Alpha Test');
    c.transparent = true;
    s.edit('New Comp', (d) => { d.compositions.push(c); });
    v.useEditor.setState({ compId: c.id, time: 0, selectedLayers: [] });
    const l = await v.ops.addLayer({ kind: 'shape', variant: 'star', start: 0 });
    v.useEditor.getState().edit('Spin', (d) => { const x = d.compositions.find((k) => k.id === c.id).layers.find((y) => y.id === l.id); x.transform.rotation.keys = [{ t: 0, v: [0, 0, 0], interp: 'linear' }, { t: 2, v: [0, 0, 180], interp: 'linear' }]; });
  });
  await page.waitForTimeout(1500);
  await shot('07-alpha-comp');
  await page.keyboard.press('Control+m');
  await page.waitForSelector('.modal');
  await page.click('.modal .lib-item:has-text("Transparent — ProRes 4444")');
  await page.waitForTimeout(300);
  await page.fill('.modal input[placeholder="Choose where to save…"]', `${OUT}\\alpha_test.mov`);
  await page.waitForTimeout(600);
  const msgs = await page.locator('.modal .msg').allInnerTexts();
  console.log('validation:', JSON.stringify(msgs));
  await page.click('.modal-foot .btn.primary');
  const j = await (await page.waitForFunction(() => { const j = window.__veyra.useEditor.getState().jobs.at(-1); return j && (j.status === 'done' || j.status === 'failed') ? j : null; }, null, { timeout: 300000, polling: 500 })).jsonValue();
  console.log('alpha export:', j.status, j.error ?? JSON.stringify(j.report.validation), `${j.report?.seconds?.toFixed(1)}s`);
  // Alpha refusal: H.264 with alpha must not be offered.
  await page.keyboard.press('Control+m');
  await page.waitForSelector('.modal');
  await page.click('.modal .lib-item:has-text("YouTube 1080p")');
  await page.waitForTimeout(500);
  console.log('h264 on transparent comp:', JSON.stringify(await page.locator('.modal .msg').allInnerTexts()));
  await shot('08-export-warning');
  await page.keyboard.press('Escape');
}
