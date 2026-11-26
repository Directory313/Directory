export default async function ({ page, shot, invoke }) {
  const s = await page.evaluate(() => { const st = window.__veyra.useEditor.getState(); return { compId: st.compId, time: st.time, scale: st.previewScale, synced: st.syncedRevision, rev: st.revision, screen: st.screen }; });
  console.log('state', JSON.stringify(s));
  // Render directly through the command the viewer uses.
  const r = await page.evaluate(async ({ compId }) => {
    const f = await window.__veyra.api.renderFrame(compId, 2.5, 0.5, false);
    let nonBlack = 0;
    for (let i = 0; i < f.data.length; i += 4) if (f.data[i] + f.data[i + 1] + f.data[i + 2] > 60) nonBlack++;
    return { w: f.width, h: f.height, nonBlack };
  }, s);
  console.log('direct render', JSON.stringify(r));
  console.log('warnings', JSON.stringify(await invoke('render_warnings')));
  await page.evaluate(() => window.__veyra.useEditor.getState().setTime(2.5));
  await page.waitForTimeout(4000);
  await shot('06-viewer-now');
  // Text layer content
  const txt = await page.evaluate(() => window.__veyra.useEditor.getState().project.compositions.flatMap((c) => c.layers).filter((l) => l.kind.type === 'text').map((l) => ({ name: l.name, text: l.kind.text.value })));
  console.log('text layers', JSON.stringify(txt));
}
