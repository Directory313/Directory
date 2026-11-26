// The spec's end-to-end workflow, executed against the real desktop app.
const MEDIA = process.env.VEYRA_TEST_MEDIA;
const OUT = process.env.VEYRA_TEST_OUT;

const st = (page, fn) => page.evaluate(fn);
const layers = (page) => st(page, () => window.__veyra.useEditor.getState().project.compositions.find((c) => c.id === window.__veyra.useEditor.getState().compId).layers.map((l) => ({ id: l.id, name: l.name, type: l.kind.type, start: +l.start.toFixed(3), dur: +l.duration.toFixed(3), parent: l.parent, is3d: l.is3d, fx: l.effects.map((e) => e.kind), masks: l.masks.length, posKeys: l.transform.position.keys?.length ?? 0 })));
const step = (n, msg) => console.log(`STEP ${n}: ${msg}`);

export default async function ({ page, shot }) {
  await page.reload();
  await page.waitForSelector('.home');
  // 1-2. Open VEYRA, create a project.
  await page.fill('.home-card input.input >> nth=0', 'E2E Workflow');
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell');
  step(2, 'project created');
  // 3-4. Drop footage (same handler as an Explorer drop) onto the timeline.
  await page.evaluate(async (dir) => { await window.__veyra.importPaths([`${dir}\\clip_a.mp4`, `${dir}\\clip_b.mp4`], 'timeline'); }, MEDIA);
  await page.waitForTimeout(1500);
  step(4, JSON.stringify(await layers(page)));

  // 5. Trim clip_a's out point to 6s with the keyboard (select + Alt+]).
  await st(page, () => { const s = window.__veyra.useEditor.getState(); const l = s.project.compositions[0].layers.find((x) => x.name === 'clip_a.mp4'); s.select([l.id]); s.setTime(6); });
  await page.keyboard.press('Alt+BracketRight');
  await page.waitForTimeout(300);
  step(5, JSON.stringify((await layers(page)).find((l) => l.name === 'clip_a.mp4')));

  // 6. Add a text layer with the Text tool: click in the viewer and type.
  await st(page, () => window.__veyra.useEditor.getState().setTime(1));
  await page.keyboard.press('t');
  const canvas = page.locator('[data-drop="viewer"] canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.waitForTimeout(500);
  await page.keyboard.type('HELLO VEYRA');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('v');
  const textLayer = (await layers(page)).find((l) => l.type === 'text');
  step(6, `text layer: ${JSON.stringify(textLayer)}`);

  // 7. Animate the text: stopwatch on Position at 1s, then move it at 2.5s.
  await st(page, () => { const s = window.__veyra.useEditor.getState(); const l = s.project.compositions[0].layers.find((x) => x.kind.type === 'text'); s.select([l.id]); s.setTime(1); });
  await page.waitForTimeout(300);
  await page.locator('.prop-row:has-text("Position") .kf-btn').first().click();
  await st(page, () => { const s = window.__veyra.useEditor.getState(); s.setTime(2.5); const l = s.project.compositions[0].layers.find((x) => x.kind.type === 'text'); window.__veyra.ops.setProp(l.id, 'transform.position', [1400, 300, 0], 'Move'); });
  step(7, `position keys: ${(await layers(page)).find((l) => l.type === 'text').posKeys}`);

  // 8. Apply an effect from the Library.
  await page.click('.flexlayout__tab_button:has-text("Library")');
  await page.click('.lib-item:has-text("Glow") >> nth=0');
  await page.waitForTimeout(500);
  step(8, `text effects: ${(await layers(page)).find((l) => l.type === 'text').fx}`);

  // 9. Compound clip from the text + clip_b (Ctrl+G).
  await st(page, () => { const s = window.__veyra.useEditor.getState(); const ls = s.project.compositions[0].layers.filter((x) => x.kind.type === 'text' || x.name === 'clip_b.mp4'); s.select(ls.map((l) => l.id)); });
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(800);
  step(9, JSON.stringify(await layers(page)));

  // 10-11. Add a null and parent the compound clip to it.
  await page.evaluate(() => window.__veyra.runAction('layer.newNull'));
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const s = window.__veyra.useEditor.getState();
    const ls = s.project.compositions[0].layers;
    const nul = ls.find((l) => l.kind.type === 'null');
    const comp = ls.find((l) => l.kind.type === 'comp');
    await window.__veyra.ops.setParent([comp.id], nul.id);
    window.__veyra.useEditor.getState().setTime(0);
    window.__veyra.ops.toggleKey(nul.id, 'transform.rotation');
    window.__veyra.useEditor.getState().setTime(3);
    window.__veyra.ops.setProp(nul.id, 'transform.rotation', [0, 0, 15], 'Rotate');
  });
  step(11, JSON.stringify((await layers(page)).filter((l) => l.type === 'comp' || l.type === 'null')));

  // 12. Ellipse mask on clip_a by dragging with the mask tool.
  await st(page, () => { const s = window.__veyra.useEditor.getState(); const l = s.project.compositions[0].layers.find((x) => x.name === 'clip_a.mp4'); s.select([l.id]); s.set({ tool: 'maskEllipse' }); s.setTime(2); });
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.75, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await st(page, () => window.__veyra.useEditor.getState().set({ tool: 'select' }));
  step(12, `clip_a masks: ${(await layers(page)).find((l) => l.name === 'clip_a.mp4').masks}`);

  // 13. Convert the compound clip into a 3D layer (inspector 3D switch path).
  await st(page, () => { const s = window.__veyra.useEditor.getState(); s.edit('3D', (d) => { const l = d.compositions[0].layers.find((x) => x.kind.type === 'comp'); l.is3d = true; l.transform.rotation.value = [0, 25, 0]; }); s.setTime(2.5); });
  await page.waitForTimeout(2500);
  await shot('03-workflow-built');

  // 14. Save (projectPath preset so Ctrl+S saves without the native dialog).
  const savePath = `${OUT}\\workflow.veyra`;
  await st(page, () => window.__veyra.useEditor.setState({ projectPath: null }));
  await page.evaluate((p) => window.__veyra.useEditor.setState({ projectPath: p }), savePath);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
  const before = await st(page, () => JSON.stringify(window.__veyra.useEditor.getState().project.compositions));
  step(14, `saved: dirty=${await st(page, () => window.__veyra.useEditor.getState().dirty)}`);

  // 15. Close (home) and reopen.
  await page.evaluate(async (p) => {
    const v = window.__veyra;
    v.useEditor.setState({ screen: 'home', project: null });
    const r = await v.api.openProject(p);
    v.useEditor.getState().loadProject(r.project, r.path);
  }, savePath);
  await page.waitForTimeout(1500);
  const after = await st(page, () => JSON.stringify(window.__veyra.useEditor.getState().project.compositions));
  step(15, `reopened; compositions identical: ${before === after}`);

  // 16. Export via the Export dialog.
  await page.keyboard.press('Control+m');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[placeholder="Choose where to save…"]', `${OUT}\\workflow.mp4`);
  await page.waitForTimeout(500);
  await shot('04-export-dialog');
  await page.click('.modal-foot .btn.primary');
  const job = await page.waitForFunction(() => {
    const j = window.__veyra.useEditor.getState().jobs[0];
    return j && (j.status === 'done' || j.status === 'failed') ? j : null;
  }, null, { timeout: 600000, polling: 1000 });
  const j = await job.jsonValue();
  step(16, `export ${j.status}: ${j.error ?? JSON.stringify(j.report?.validation)} in ${j.report?.seconds?.toFixed(1)}s`);
  await shot('05-after-export');
}
