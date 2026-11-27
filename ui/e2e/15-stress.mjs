// Simulates a fast drag: many edits a few ms apart, then checks the preview still follows.
export default async function ({ page }) {
  const res = await page.evaluate(async () => {
    const v = window.__veyra, st = () => v.useEditor.getState();
    const lid = st().project.compositions[0].layers[0].id;
    const setScale = (s) => st().edit('Scale', (d) => { const l = d.compositions[0].layers.find((x) => x.id === lid); l.transform.scale.value = [s, s, 100]; l.transform.opacity.value = 100; }, 'drag');
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 80; i++) { setScale(40 + ((i * 7 + round * 13) % 160)); await new Promise((r) => setTimeout(r, Math.random() * 4)); }
    }
    setScale(25);
    await new Promise((r) => setTimeout(r, 2500));
    // Bounding box of lit pixels in the viewer canvas
    const cv = document.querySelector('.vw-canvas'); const g = cv.getContext('2d'); const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width, x1 = -1; for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; if (d[i] > 150) { if (x < x0) x0 = x; if (x > x1) x1 = x; } }
    return { width: x1 - x0 + 1, canvas: cv.width, rev: st().revision, synced: st().syncedRevision };
  });
  // Rect is 480 px wide at 100% in a 1920 comp; at Half preview and 25% scale expect ~60 px.
  console.log(JSON.stringify(res), res.width >= 70 && res.width <= 74 ? 'PREVIEW FOLLOWS EDITS' : 'PREVIEW FROZEN/STALE');
}
