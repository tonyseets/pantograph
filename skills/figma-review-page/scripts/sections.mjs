// Full-page capture + bounding boxes for the children of a wrapper, plus header and footer.
// Writes <out>.json next to <out>.png. Build crops are cut from the PNG by these boxes.
// usage: node sections.mjs <url> <out.png> [width=1440] [height=900] [wrapper="main > div"] [header="header"] [footer="footer"]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [url, out, w = "1440", h = "900", wrapper = "main > div", headerSel = "header", footerSel = "footer"] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node sections.mjs <url> <out.png> [w] [h] [wrapper] [header] [footer]"); process.exit(1); }

const HIDE = [
  'nuxt-devtools-frame', '[id^="nuxt-devtools"]', '.nuxt-devtools-panel',
  '#__next-build-watcher', 'nextjs-portal', '[data-nextjs-toast]',
  '#vite-plugin-checker-error-overlay', 'vite-error-overlay',
].join(", ");

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
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

const rects = await page.evaluate(([wrapper, headerSel, footerSel]) => {
  const box = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top + window.scrollY), height: Math.round(b.height) }; };
  const wrap = document.querySelector(wrapper);
  const kids = wrap ? Array.from(wrap.children) : [];
  const sections = kids.map((el, i) => ({ i, tag: el.tagName, id: el.id || null, cls: el.className?.toString?.().slice(0, 80) || null, ...box(el) }));
  const header = document.querySelector(headerSel);
  const footer = document.querySelector(footerSel);
  return {
    wrapper, sections,
    header: header ? box(header) : null,
    footer: footer ? box(footer) : null,
    total: document.body.scrollHeight,
  };
}, [wrapper, headerSel, footerSel]);

writeFileSync(out.replace(/\.png$/, ".json"), JSON.stringify(rects, null, 1));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log("saved", out, "sections:", rects.sections.length, "total:", rects.total);
