// Screenshots for the proof packet: one page (or one section of it) at each review width, saved
// under the batch folder with predictable names. Playwright's own headless browser, never the
// user's Chrome, and only local URLs. Playwright is not a figpipe dependency: it is resolved from
// FIGPIPE_PLAYWRIGHT, figpipe's home (~/.figpipe, one install for every project), the project repo,
// or Pantograph itself, in that order. Never from a lane worktree: captures run outside the session
// sandbox, and a worktree is the session's to write.
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { FIGPIPE_DIR, paths } from "./paths.mjs";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

// Dev overlays that would otherwise show up in every capture.
const HIDE = [
  "nuxt-devtools-frame", '[id^="nuxt-devtools"]', ".nuxt-devtools-panel", "#__next-build-watcher", "nextjs-portal", "[data-nextjs-toast]",
  "#vite-plugin-checker-error-overlay", "vite-error-overlay", "astro-dev-toolbar", "#svelte-announcer",
].join(", ");

export function checkLocalUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (!["http:", "https:"].includes(u.protocol) || !LOCAL.has(u.hostname)) return `captures only open local URLs (localhost); got ${u.host || url}`;
  return null;
}

export function capturePaths(batchDir, itemId, phase, widths) {
  if (!["before", "after"].includes(phase)) throw new Error(`phase must be before or after, not ${phase}`);
  const dir = join(batchDir, "captures", String(itemId));
  return widths.map((w) => ({ width: w, path: join(dir, `${phase}-${w}.png`), rel: join("captures", String(itemId), `${phase}-${w}.png`) }));
}

// One state of a built element (hovered, focused, checked, open), to set beside its component
// set's render: <batch>/captures/<item>/states/<state>-<width>.png
export function statePaths(batchDir, itemId, state, widths) {
  const name = String(state).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("--state needs a name, such as checkbox-checked-hover");
  const dir = join("captures", String(itemId), "states");
  return widths.map((w) => ({ width: w, state: name, path: join(batchDir, dir, `${name}-${w}.png`), rel: join(dir, `${name}-${w}.png`) }));
}

// What puts an element into a state, in the order a person would do it.
export const STATE_ACTIONS = ["click", "fill", "focus", "hover", "press"];
export function stateActions(flags) {
  return STATE_ACTIONS.filter((k) => typeof flags[k] === "string" && flags[k]).map((k) => ({ do: k, selector: flags[k], ...(k === "fill" ? { text: String(flags.text ?? "") } : {}) }));
}
async function act(page, a) {
  const el = page.locator(a.selector).first();
  if (!(await el.count())) throw new Error(`no element matches ${a.selector} for --${a.do}`);
  if (a.do === "click") await el.click();
  else if (a.do === "fill") await el.fill(a.text ?? "");
  else if (a.do === "focus") {
    // A key press first, so the focus ring shows as it does for someone using the keyboard.
    await page.keyboard.press("Shift");
    await el.focus();
  } else if (a.do === "hover") await el.hover();
  else if (a.do === "press") {
    await el.hover();
    await page.mouse.down();
  }
}

export const PLAYWRIGHT_INSTALL = "npm i --prefix ~/.figpipe playwright && npx --prefix ~/.figpipe playwright install chromium";
export function resolvePlaywright(dirs = []) {
  const tries = [process.env.FIGPIPE_PLAYWRIGHT, paths().home, ...dirs, FIGPIPE_DIR].filter(Boolean);
  for (const d of tries) {
    try {
      return createRequire(join(d, "noop.js")).resolve("playwright");
    } catch {}
  }
  return null;
}

// capture({ url, batchDir, itemId, phase, widths, selector, dirs }) -> [{ width, path, rel, height }]
// With `state` (and the actions that reach it) the shot is one state of an element, not a phase.
export async function capture({ url, batchDir, itemId, phase, widths, selector = null, dirs = [], height = 900, scale = 1, waitMs = 800, state = null, actions = [] }) {
  const bad = checkLocalUrl(url);
  if (bad) throw new Error(bad);
  const shots = state ? statePaths(batchDir, itemId, state, widths) : capturePaths(batchDir, itemId, phase, widths);
  const pw = resolvePlaywright(dirs);
  if (!pw) throw new Error(`Playwright is not installed where figpipe can find it. Install it once for every project: ${PLAYWRIGHT_INSTALL}`);
  const mod = await import(pathToFileURL(pw).href);
  const chromium = mod.chromium ?? mod.default?.chromium; // playwright is CommonJS
  if (!chromium) throw new Error(`${pw} does not export chromium`);
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  for (const s of shots) mkdirSync(dirname(s.path), { recursive: true });
  try {
    for (const s of shots) {
      const ctx = await browser.newContext({ viewport: { width: s.width, height }, deviceScaleFactor: scale, reducedMotion: "reduce", serviceWorkers: "block" });
      // The page comes from the session's dev server and runs outside the sandbox: it may load
      // anything, but may only send data (POST, PUT, ...) to localhost.
      await ctx.route("**/*", (route) => {
        const r = route.request();
        let host = "";
        try {
          host = new URL(r.url()).hostname;
        } catch {}
        const local = LOCAL.has(host) || LOCAL.has(`[${host}]`) || /^(data|blob|about):/.test(r.url());
        return local || ["GET", "HEAD", "OPTIONS"].includes(r.method()) ? route.continue() : route.abort("blockedbyclient");
      });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
      await page.addStyleTag({ content: `${HIDE} { display: none !important }` });
      // Scroll once so lazy images load, then settle at the top.
      const total = await page.evaluate(() => document.body.scrollHeight);
      for (let y = 0; y < total; y += Math.floor(height / 2)) await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(waitMs);
      for (const a of actions) await act(page, a);
      if (actions.length) await page.waitForTimeout(300);
      if (selector) {
        const el = page.locator(selector).first();
        if (!(await el.count())) throw new Error(`no element matches ${selector} at ${s.width}px`);
        await el.screenshot({ path: s.path });
        s.height = Math.round((await el.boundingBox())?.height ?? 0);
      } else {
        // A state without a selector is what the viewport shows (an open list may sit outside its field).
        await page.screenshot({ path: s.path, fullPage: !state });
        s.height = state ? height : total;
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return shots.filter((s) => existsSync(s.path));
}
