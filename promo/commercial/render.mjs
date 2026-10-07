// Render promo/commercial/index.html frame by frame to PNGs.
// Usage: node promo/commercial/render.mjs [comma-separated frame indices]
//   env URL  (default http://127.0.0.1:8777/promo/commercial/index.html)
//   env OUT  (default: scratchpad promo-frames dir)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/0xatakan/open-design/node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core');

const FPS = 30, TOTAL = 1350;
const URL = process.env.URL || 'http://127.0.0.1:8777/promo/commercial/index.html';
const OUT = process.env.OUT || '/private/tmp/claude-501/-Users-0xatakan-Claude-Code-Sealed-Bid-Auction-on-Monad/98bef2a8-d70a-409f-aa32-3c11fe8a461d/scratchpad/commercial-frames';
const frames = process.argv[2] ? process.argv[2].split(',').map(Number) : [...Array(TOTAL).keys()];

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('console', m => console.log('[page]', m.text()));
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 15000 });
const diag = await page.evaluate(() => window.__ready);
console.log('ready:', JSON.stringify(diag));
if (!diag || !diag.ok) { console.error('fonts or images failed to load; aborting'); await browser.close(); process.exit(1); }

const t0 = Date.now();
for (const i of frames) {
  const data = await page.evaluate(t => { window.__seek(t); return document.getElementById('c').toDataURL('image/png'); }, i / FPS);
  fs.writeFileSync(path.join(OUT, String(i).padStart(4, '0') + '.png'), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
  if (i % 60 === 0) console.log(`frame ${i} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(`done: ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}`);
await browser.close();
