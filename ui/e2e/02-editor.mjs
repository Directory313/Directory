// Steps 1-4: create a project, import footage through the drop handler, place it on the timeline.
const MEDIA = process.env.VEYRA_TEST_MEDIA;
export default async function ({ page, shot }) {
  await page.reload();
  await page.waitForSelector('.home');
  await page.fill('.home-card input.input >> nth=0', 'E2E Workflow');
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell', { timeout: 15000 });
  await page.evaluate(async (dir) => {
    const v = window.__veyra;
    await v.importPaths([`${dir}\\clip_a.mp4`, `${dir}\\clip_b.mp4`], 'timeline');
  }, MEDIA);
  await page.waitForTimeout(4000);
  const s = await page.evaluate(() => {
    const st = window.__veyra.useEditor.getState();
    const c = st.project.compositions[0];
    return { assets: st.project.assets.map((a) => `${a.name} ${a.info.width}x${a.info.height}@${a.info.fps} ${a.info.duration.toFixed(2)}s audio=${a.info.hasAudio}`), layers: c.layers.map((l) => `${l.name} [${l.start.toFixed(2)}-${(l.start + l.duration).toFixed(2)}]`), comp: `${c.width}x${c.height}@${c.fps} ${c.duration}s` };
  });
  console.log(JSON.stringify(s, null, 1));
  await page.evaluate(() => window.__veyra.useEditor.getState().setTime(2));
  await page.waitForTimeout(2500);
  await shot('02-editor');
}
