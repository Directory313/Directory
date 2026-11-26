// Drive the real VEYRA desktop window (WebView2) over CDP.
// Launch the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.
// Usage: node e2e/cdp.mjs <script.mjs> [outDir]
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const [, , scriptPath, outDir = path.resolve('e2e-out')] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith('devtools')) ?? browser.contexts()[0].pages()[0];
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const shot = async (name) => { const f = path.join(outDir, `${name}.png`); await page.screenshot({ path: f }); console.log('shot', f); };
const invoke = (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
try {
  const mod = await import(pathToFileURL(path.resolve(scriptPath)).href);
  await mod.default({ page, shot, invoke, outDir, logs });
} catch (e) {
  console.error('SCRIPT ERROR', e);
  await shot('error').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log('--- console errors/warnings ---');
  for (const l of logs.slice(0, 40)) console.log(l);
  await browser.close().catch(() => {}); // detaches; does not close the app
}
