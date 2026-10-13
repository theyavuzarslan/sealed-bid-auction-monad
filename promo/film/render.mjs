// Render promo/film/index.html frame by frame to PNGs (window.__seek(t) poses each frame).
// Usage: node promo/film/render.mjs [comma-separated times in seconds, for stills]
//   env FPS (default 60) · URL (default http://127.0.0.1:8765/promo/film/index.html) · OUT (frames dir)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// playwright-core from wherever it is installed on this machine (env PLAYWRIGHT_CORE overrides).
const PW = [process.env.PLAYWRIGHT_CORE, '/Users/0xatakan/.hermes/hermes-agent/node_modules/playwright-core',
  '/Users/0xatakan/open-design/node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core'].filter(Boolean).find(p => fs.existsSync(p));
const { chromium } = require(PW);

const FPS = +(process.env.FPS || 60), DURATION = 30;
const URL = process.env.URL || 'http://127.0.0.1:8765/promo/film/index.html';
const OUT = process.env.OUT || '/private/tmp/claude-501/-Users-0xatakan-Claude-Code-Sealed-Bid-Auction-on-Monad/98bef2a8-d70a-409f-aa32-3c11fe8a461d/scratchpad/film-frames';
const stills = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
const times = stills || [...Array(FPS * DURATION).keys()].map(i => i / FPS);

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 20000 });
const ready = await page.evaluate(() => window.__ready);
if (!ready.ok) { console.error('fonts or images failed to load'); await browser.close(); process.exit(1); }

const t0 = Date.now();
for (let k = 0; k < times.length; k++) {
  await page.evaluate(t => window.__seek(t), times[k]);
  const name = stills ? `still-${times[k].toFixed(2)}.png` : String(k).padStart(4, '0') + '.png';
  await page.screenshot({ path: path.join(OUT, name), type: 'png' });
  if (!stills && k % 120 === 0) console.log(`frame ${k} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(`done: ${times.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}`);
await browser.close();
