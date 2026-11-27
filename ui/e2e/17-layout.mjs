// Bug 1.3: layouts are per project; closed panels can be reopened from the Window menu.
const DIR = process.env.VEYRA_TEST_OUT;
const out = [];
const ok = (n, p, i = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n} ${i}`);
const hasInspector = (page) => page.locator('.flexlayout__tab_button', { hasText: /^Inspector/ }).count();
export default async function ({ page }) {
  await page.reload();
  await page.waitForSelector('.home', { timeout: 30000 });
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell');
  await page.waitForTimeout(800);
  ok('new project starts with the Inspector', (await hasInspector(page)) > 0);
  // Close the Inspector panel via its tab close button.
  await page.locator('.flexlayout__tab_button', { hasText: /^Inspector/ }).locator('.flexlayout__tab_button_trailing').click();
  await page.waitForTimeout(500);
  ok('Inspector closed', (await hasInspector(page)) === 0);
  // Save project A (same steps the Save command performs, without the native dialog).
  const pathA = `${DIR}\Project A\Project A.directory`;
  await page.evaluate(async (p) => { const v = window.__veyra; const s = v.useEditor.getState(); await v.api.saveProject(s.project, p); v.useEditor.setState({ projectPath: p, dirty: false }); }, pathA);
  await page.waitForTimeout(1500);
  const saved = await page.evaluate((p) => window.__veyra.api.readProjectLayout(p), pathA);
  ok('layout.json written in the project folder', !!saved && saved.includes('"workspace"'), saved ? `${saved.length} bytes` : 'missing');
  // New project B must NOT inherit the closed Inspector.
  await page.evaluate(() => window.__veyra.runAction('file.home'));
  await page.waitForSelector('.home', { timeout: 10000 });
  await page.click('text=Create project');
  await page.waitForSelector('.editor-shell');
  await page.waitForTimeout(1000);
  ok('new project B has the Inspector (no cross-project leak)', (await hasInspector(page)) > 0);
  // Reopen project A: its own layout (Inspector closed) comes back.
  await page.evaluate(async (p) => { const v = window.__veyra; const r = await v.api.openProject(p); v.useEditor.getState().loadProject(r.project, r.path); }, pathA);
  await page.waitForTimeout(1500);
  ok('project A reopens with its own layout (Inspector closed)', (await hasInspector(page)) === 0);
  // Window menu shows the panel unchecked and reopens it.
  await page.click('.menubar-item:has-text("Window")');
  const item = page.locator('.menu-item, button', { hasText: /^Inspector$/ }).first();
  await item.click();
  await page.waitForTimeout(600);
  ok('Window → Inspector reopens the closed panel', (await hasInspector(page)) > 0);
  for (const l of out) console.log(l);
}
