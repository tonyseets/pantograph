// The report template: predictable structure, copy vs visual blocks, escaping, no external assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tempHome, PNG } from "./helpers.mjs";

tempHome();
const { renderBatch } = await import("../../figpipe/lib/report.mjs");

const dir = mkdtempSync(join(tmpdir(), "report-"));
writeFileSync(join(dir, "a.png"), PNG);
const base = { thread: [], events: [], late: [], preview: [], commits: [], text_diff: [], motion: [], captures: [], decisions: [], questions: [], flags: [] };
const item = (o) => ({ ...base, id: 1, kind: "ready", title: "Hero", area_name: "Home", file_key: "K", node_id: "1:2", outcome: "applied", change_kind: "redesign", verdict: "Built the hero.", ...o });
const captions = (html) => [...html.matchAll(/<figcaption>([^<]+)<\/figcaption>/g)].map((m) => m[1]);
const data = (items, batch = {}) => ({ batch: { id: "p-1", project: "p", status: "done", created_at: "2026-10-02T16:00:00Z", mcp_calls: 0, ...batch }, items, notDone: [], checks: [], context: [], denials: [], budget: { mcp_calls: 0, rest_429s: 0 } });

test("redesigns show before/after rows per width; copy changes show a text diff instead", () => {
  const caps = [1440, 1024, 390].map((w) => ({ width: w, before_path: join(dir, "a.png"), after_path: join(dir, "a.png"), figma_path: null }));
  const html = renderBatch(data([item({ captures: caps }), item({ id: 2, change_kind: "copy", captures: caps, text_diff: [{ before: "Old <b>", after: "New", where: "H1" }] })]), dir);
  assert.equal((html.match(/class="grid"/g) ?? []).length, 1, "only the redesign gets the screenshot grid");
  assert.equal((html.match(/class="shots( phone)?"/g) ?? []).length, 3);
  assert.match(html, /class="shots phone"/, "phone-width captures are shown narrower");
  assert.deepEqual(captions(html).slice(0, 2), ["Before", "After"]);
  assert.match(html, /<a class="frame[^"]*" style="aspect-ratio:[^"]+" href="[^"]+" title="Open full size"[^>]*><img src=/, "every screenshot opens full size");
  assert.match(html, /alt="Hero: After at 1440 px"/, "alt text names the item");
  assert.match(html, /<del>Old &lt;b&gt;<\/del>/, "escaped");
  assert.doesNotMatch(html, /score|%\s*match/i, "visual comparison is shown, never scored");
});

test("new pages have no Before column", () => {
  const html = renderBatch(data([item({ change_kind: "new_page", captures: [{ width: 1440, after_path: join(dir, "a.png"), figma_path: join(dir, "a.png") }] })]), dir);
  assert.deepEqual(captions(html), ["Figma", "After"]);
});

test("same section order every time; empty sections are left out", () => {
  const html = renderBatch(data([item({ outcome: "question", questions: [{ text: "Which copy?" }] }), item({ id: 2 })], { summary: "1 built" }), dir);
  const order = ["<h1>", 'class="summary"', 'class="stats"', 'class="toc"', 'class="item"', 'id="session"'].map((s) => html.indexOf(s));
  assert.ok(order.every((i) => i > 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(html.indexOf('id="item-1"') < html.indexOf('id="item-2"'), "items needing Tony come first");
  // The index links to every item, in page order.
  assert.deepEqual([...html.matchAll(/href="#item-(\d+)"/g)].map((m) => m[1]), ["1", "2"]);
  // Every count has a fixed slot, zero or not.
  for (const l of ["Built", "Needs you", "Questions", "Failed", "Cost"]) assert.match(html, new RegExp(`${l}</dt><dd>`));
  assert.doesNotMatch(html, /<h2>Not done<\/h2>|<h2>Checks<\/h2>/);
  assert.match(html, /aria-label="Copy all questions"/);
});

test("light and dark tokens, phone width, no em dashes in the template copy", () => {
  const html = renderBatch(data([item({})]), dir);
  assert.match(html, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /@media \(max-width:719px\)/);
  assert.ok(!html.includes("—"), "no em dashes");
  assert.match(html, /--measure:640px/, "text has one measure, in px, so every block ends at the same edge");
  assert.doesNotMatch(html, /border-left/, "no coloured side borders");
  assert.doesNotMatch(html, /gradient/);
});

test("the sample batch renders from state.db with every block, offline", async () => {
  const { writeSample } = await import("../../figpipe/lib/sample.mjs");
  const { existsSync: ex, readFileSync: rd } = await import("node:fs");
  const out = mkdtempSync(join(tmpdir(), "sample-"));
  const r = writeSample(join(out, "s"));
  const html = rd(r.report, "utf8");
  // Items needing Tony first, then failures, then built work.
  const order = ["Needs you", "Question", "Failed", "Built", "No change needed"].map((l) => html.indexOf(`<span>${l}</span></span>`, html.indexOf('class="item"')));
  assert.ok(order.every((i) => i > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal((html.match(/class="grid"/g) ?? []).length, 4, "redesign and new page show captures, the watched section its design change and its build; copy, motion and comments do not");
  // A section pre-built from an in-progress design: Figma before and now per frame, then the build before and after.
  const about = html.slice(html.indexOf('<h2 id="item-'), html.length).split('<article class="item"').find((x) => x.includes(">About</h2>"));
  assert.match(about, /The in-progress design changed since your pre-built page/);
  assert.match(about, /<h3>Design change in Figma<\/h3><p class="muted">1 copy line and 14 layout lines changed since the design your page was built from\.<\/p>/);
  assert.match(captions(about)[0], /^Before \(\d+ \w+, \d\d:\d\d\)$/, "the date of the design the build was made from");
  assert.equal(captions(about)[1], "Now");
  assert.match(about, /<h3>Build before and after<\/h3>/);
  assert.match(about, /<del>We build booking tools\.<\/del>/);
  assert.deepEqual(captions(html).slice(0, 3), ["Figma", "Before", "After"]);
  assert.match(html, /<del>Start free trial<\/del>/);
  assert.match(html, /aria-label="Copy all questions"/);
  assert.match(html, /cd ~\/Projects\/acme-site-fp-pricing &amp;&amp; npx nuxt dev --port 3011/, "how to start the preview");
  assert.match(html, /Blocked: network access to cdn\.example\.com/);
  assert.match(html, /patches\/faq\.patch/);
  assert.match(html, /claude --resume 5f0c2a9e/);
  for (const s of [...html.matchAll(/<img src="([^"]+)"/g)].map((x) => x[1])) assert.ok(ex(join(r.dir, s)), s);
  assert.doesNotMatch(html, /(src|href)="https:\/\/(?!www\.figma\.com\/design\/)/, "nothing external except Figma links");
  assert.ok(!html.includes("—"));
  assert.ok(ex(r.index));
  // Re-running replaces the folder; a folder that is not a sample is refused.
  writeSample(join(out, "s"));
  writeFileSync(join(out, "other.txt"), "x");
  assert.throws(() => writeSample(out), /not a figpipe sample folder/);
});

test("every item's subsections come in the same order; empty ones are left out", async () => {
  const { writeSample } = await import("../../figpipe/lib/sample.mjs");
  const { readFileSync: rd } = await import("node:fs");
  const r = writeSample(join(mkdtempSync(join(tmpdir(), "sample-")), "s"));
  const html = rd(r.report, "utf8");
  const ORDER = ["Source", "Design change in Figma", "Changes", "Build before and after", "Preview", "Code", "Decided for you", "Questions for the designer", "Components", "Gaps in the design", "Motion to check", "Reply"];
  const items = html.split('<article class="item"').slice(1);
  assert.equal(items.length, 8);
  for (const it of items) {
    const subs = [...it.matchAll(/<section class="sub[^"]*"><h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    assert.ok(subs.length, "every item has at least one subsection");
    assert.deepEqual([...subs].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), subs);
    assert.doesNotMatch(it, /<section class="sub[^"]*"><h3>[^<]+<\/h3><\/section>/, "no empty subsection");
  }
});

test("a node item shows the open comments pinned inside it; repeated motion hints collapse", () => {
  const inside = [{ id: "c1", resolved: false, messages: [{ by: "Mara", at: "2026-10-02T08:09:39Z", text: "Tern spends more time on your data" }] }];
  const motion = Array.from({ length: 6 }, () => ({ name: "Button-arrow", why: "prototype interactions" }));
  const html = renderBatch(data([item({ outcome: "already_done", change_kind: "none", inside, motion })]), dir);
  assert.match(html, /<b>Mara<\/b> <time>[^<]*<\/time><\/p><p>Tern spends more time on your data/);
  assert.equal((html.match(/Button-arrow: prototype interactions/g) ?? []).length, 1);
  assert.match(html, /×6/);
});

test("questions show in the counts and mark their item, whatever its outcome", () => {
  const html = renderBatch(data([item({ outcome: "already_done", change_kind: "none", questions: [{ text: "Which wording?" }, { text: "Which image?" }] })]), dir);
  assert.match(html, /Questions<\/dt><dd>2<button/, "an already-built item's questions are counted");
  assert.match(html, /<span>No change needed<\/span><\/span><span class="status tone-warn">.*<span>2 questions<\/span>/, "its status line says so");
  assert.match(html, /href="#item-1"><span class="tone-muted">.*?class="q tone-warn"/, "and the item index marks it, next to the same status the item shows");
});

test("a redesign without screenshots says why; motion hints stay when nobody read the motion", () => {
  const caps = [{ width: 1440, after_path: join(dir, "a.png") }];
  const motion = [{ name: "Hero image", why: "prototype transition" }];
  const notDone = [{ item_id: 2, text: "Capture failed: Playwright is not installed." }];
  const d = data([item({ captures: caps, motion }), item({ id: 2, title: "Pricing" }), item({ id: 3, title: "Footer", change_kind: "new_page" })], { figma_mcp: "needs-auth" });
  d.notDone = notDone;
  const html = renderBatch(d, dir);
  assert.match(html, /No screenshots: Capture failed: Playwright is not installed\./);
  assert.match(html, /No screenshots: none were recorded for this item\./);
  assert.match(html, /Hero image: prototype transition/, "motion list shows next to screenshots when the batch had no Figma MCP");
  const withMcp = renderBatch(data([item({ captures: caps, motion })], { figma_mcp: "connected" }), dir);
  assert.doesNotMatch(withMcp, /Hero image: prototype transition/);
});

test("the header says new work waits until the batch is reviewed", () => {
  assert.match(renderBatch(data([item({})]), dir), /New Figma work waits until you mark this reviewed\./);
  assert.doesNotMatch(renderBatch(data([item({})], { status: "reviewed" }), dir), /New Figma work waits/);
});

test("a batch with nothing built is marked reviewed by figpipe and keeps its questions listed", async () => {
  const { openDb } = await import("../../figpipe/lib/db.mjs");
  const { autoReview } = await import("../../figpipe/lib/cli.mjs");
  const { batchLine, writeIndex } = await import("../../figpipe/lib/report.mjs");
  const { readFileSync } = await import("node:fs");
  const db = openDb(join(mkdtempSync(join(tmpdir(), "auto-")), "state.db"));
  db.run("INSERT INTO batches (id, project, status, created_at) VALUES ('p-1', 'p', 'done', '2026-10-02T16:00:00Z')");
  db.run("INSERT INTO items (batch_id, project, file_key, kind, outcome) VALUES ('p-1', 'p', 'K', 'comment', 'already_done')");
  for (const q of ["One?", "Two?", "Three?"]) db.run("INSERT INTO notes (batch_id, item_id, kind, text) VALUES ('p-1', 1, 'question', ?)", q);
  assert.equal(batchLine(db, "p-1"), "3 questions", "the notification never says nothing to do when there are questions");
  assert.equal(autoReview(db, "p-1"), true);
  assert.equal(db.get("SELECT reviewed_by FROM batches WHERE id = 'p-1'").reviewed_by, "auto");
  const index = readFileSync(writeIndex(db), "utf8");
  const row = index.indexOf('<th scope="row">p</th>');
  assert.ok(row > index.indexOf("<h2>To review</h2>") && row < (index.indexOf("<h2>Reviewed</h2>") >>> 0), "still at the top of the index");
  assert.match(index, /<th scope="row">p<\/th><td class="date">[^<]*<\/td><td class="num"><span class="muted">0<\/span><\/td><td class="num"><span class="muted">0<\/span><\/td><td class="num">3<\/td>/, "with its questions counted");
  assert.match(index, /Nothing to review/);
  db.run("INSERT INTO batches (id, project, status, created_at) VALUES ('p-2', 'p', 'done', '2026-10-02T17:00:00Z')");
  db.run("INSERT INTO items (batch_id, project, file_key, kind, outcome) VALUES ('p-2', 'p', 'K', 'ready', 'applied')");
  assert.equal(autoReview(db, "p-2"), false, "built work always waits for Tony");
});

test("why an item is here sits under Source, never next to its status", () => {
  const html = renderBatch(data([item({ kind: "changed", outcome: "already_done", change_kind: "none", verdict: "No design change." }), item({ id: 2 })]), dir);
  const head = html.slice(html.indexOf('<p class="statusline">'), html.indexOf("</header>", html.indexOf('<p class="statusline">')));
  assert.doesNotMatch(head, /Edited in Figma/);
  assert.match(html, /<h3>Source<\/h3><div class="source"><div class="source-text"><p class="muted">Edited in Figma after the last build · Home<\/p>/);
});

test("decisions say what was chosen; a one-item batch does not repeat its verdict as the summary", () => {
  const one = renderBatch(data([item({ decisions: [{ text: "Two headings.", detail: "Desktop one" }] })], { summary: "Built the hero." }), dir);
  assert.match(one, /<p class="chose">Chose: Desktop one<\/p>/);
  assert.doesNotMatch(one, /class="summary"/);
  assert.match(renderBatch(data([item({}), item({ id: 2 })], { summary: "Two built." }), dir), /<p class="summary">Two built\.<\/p>/);
});

test("screenshot rows share one window size; taller images say they are cropped", () => {
  const tall = join(dir, "tall.svg");
  const short = join(dir, "short.svg");
  writeFileSync(tall, '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="4000"></svg>');
  writeFileSync(short, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900"></svg>');
  const html = renderBatch(data([item({ captures: [{ width: 1440, before_path: short, after_path: tall }, { width: 390, before_path: short, after_path: short }] })]), dir);
  const row = html.slice(html.indexOf('<div class="shots">'), html.indexOf('<div class="shots phone">'));
  const ratios = [...row.matchAll(/aspect-ratio:1\/([\d.]+)/g)].map((m) => m[1]);
  assert.deepEqual(ratios, ["1.250", "1.250"], "both frames in a row get the same window, capped");
  assert.equal((row.match(/class="frame cropped"/g) ?? []).length, 1, "only the tall image is marked cropped");
  assert.match(row, /width="1440" height="4000"/, "image sizes are known up front");
  assert.match(html, /<dialog class="viewer" id="viewer"/, "screenshots open in a viewer that flips between Figma, Before and After");
});
