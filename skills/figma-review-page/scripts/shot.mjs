// Full-page capture. Scrolls first so lazy images decode, then shoots fullPage.
// usage: node shot.mjs <url> <out.png> [width=1440] [height=900] [scale=1] [extraHideSelector]
import { chromium } from "playwright";

const [url, out, w = "1440", h = "900", scale = "1", extraHide = ""] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node shot.mjs <url> <out.png> [w] [h] [scale] [hideSelector]"); process.exit(1); }

const HIDE = [
  'nuxt-devtools-frame', '[id^="nuxt-devtools"]', '.nuxt-devtools-panel',
  '#__next-build-watcher', 'nextjs-portal', '[data-nextjs-toast]',
  '#vite-plugin-checker-error-overlay', 'vite-error-overlay',
  extraHide,
].filter(Boolean).join(", ");

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +scale });
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
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log("saved", out, "height", total);
