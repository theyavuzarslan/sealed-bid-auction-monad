// Renders the brand cards in brand.html to PNGs: node promo/brand/render.mjs (needs the repo served at 127.0.0.1:8765).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/0xatakan/open-design/node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core");
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1300 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:8765/promo/brand/brand.html", { waitUntil: "networkidle" });
await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load('96px "Jersey 10"'); await document.fonts.load("22px Silkscreen"); await document.fonts.load('700 30px "Schibsted Grotesk"'); });
for (const [id, out] of [["og", "web/assets/og-card.png"], ["banner", "promo/brand/x-banner.png"]]) {
  await page.locator("#" + id).screenshot({ path: out });
  console.log("wrote", out);
}
await browser.close();
