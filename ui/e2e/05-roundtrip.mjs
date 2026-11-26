// Save → reopen → save again; the two saved files must be identical (no data loss), and
// differences between the in-memory document and the reopened one are listed.
const OUT = process.env.VEYRA_TEST_OUT;
function diff(a, b, path = '', out = []) {
  if (out.length > 25) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) { out.push(`${path}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`); return out; }
  if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b ?? {})])) diff(a[k], b?.[k], `${path}.${k}`, out);
  } else if (a !== b && !(typeof a === 'number' && Math.abs(a - b) < 1e-9)) out.push(`${path}: ${a} -> ${b}`);
  return out;
}
export default async function ({ page }) {
  const p1 = `${OUT}\\rt1.veyra`, p2 = `${OUT}\\rt2.veyra`;
  const before = await page.evaluate(() => window.__veyra.useEditor.getState().project);
  await page.evaluate(async ([a]) => { const v = window.__veyra; await v.api.saveProject(v.useEditor.getState().project, a); }, [p1]);
  const reopened = await page.evaluate(async ([a]) => (await window.__veyra.api.openProject(a)).project, [p1]);
  await page.evaluate(async ([b, p]) => { await window.__veyra.api.saveProject(p, b); }, [p2, reopened]);
  const re2 = await page.evaluate(async ([b]) => (await window.__veyra.api.openProject(b)).project, [p2]);
  const d1 = diff(before.compositions, reopened.compositions);
  const d2 = diff(reopened.compositions, re2.compositions);
  console.log(`memory→file differences (${d1.length}):`);
  d1.slice(0, 15).forEach((x) => console.log('  ', x));
  console.log(`file→file differences after second save: ${d2.length}`);
  d2.slice(0, 10).forEach((x) => console.log('  ', x));
}
