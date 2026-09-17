// DPR-2 capture in vertical chunks. Chrome refuses a screenshot taller than ~16k device px,
// so each clip stays under that (chunk CSS px * 2).
// usage: node shot2x.mjs <url> <out.png> [width=390] [height=844] [chunkCssPx=5000]
import { chromium } from "playwright";

const [url, out, w = "390", h = "844", chunk = "5000"] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node shot2x.mjs <url> <out.png> [w] [h] [chunk]"); process.exit(1); }

const HIDE = [
  'nuxt-devtools-frame', '[id^="nuxt-devtools"]', '.nuxt-devtools-panel',
  '#__next-build-watcher', 'nextjs-portal', '[data-nextjs-toast]',
  '#vite-plugin-checker-error-overlay', 'vite-error-overlay',
].join(", ");

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
await page.addStyleTag({ content: `${HIDE} { display:none !important }` });
const total = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < total; y += Math.floor(+h / 2)) {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(120);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1000);

const step = +chunk;
let i = 0;
for (let y = 0; y < total; y += step, i++) {
  const hh = Math.min(step, total - y);
  await page.screenshot({ path: out.replace(/\.png$/, `-${i}.png`), fullPage: true, clip: { x: 0, y, width: +w, height: hh } });
}
await browser.close();
console.log("chunks", i, "total", total);
