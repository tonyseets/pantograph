// Setup and session helpers: probe (repo and Figma), doctor, partial records and the result
// rebuilt from state.db, capture URL rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tempHome, ternConfig, figmaState, fakeClient, gitRepo, load, LIVE, STALE, PAGE } from "./helpers.mjs";

tempHome();
const { probeRepo, probeFigma, doctor, guessBreakpoints } = await import("../../figpipe/lib/setup.mjs");
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { recordResult, resultFromDb, checkSchema, resultSchema } = await import("../../figpipe/lib/record.mjs");
const { checkLocalUrl, capturePaths } = await import("../../figpipe/lib/capture.mjs");

function nuxtRepo() {
  const root = mkdtempSync(join(tmpdir(), "probe-"));
  const w = gitRepo(root, { feature: "feat/pricing" });
  writeFileSync(join(w.repo, "package.json"), JSON.stringify({
    scripts: { dev: "nuxt dev --port 3001", "lint:quiet": "eslint . --quiet", lint: "eslint .", typecheck: "nuxt typecheck", test: "echo \"Error: no test specified\" && exit 1" },
    dependencies: { nuxt: "^3", "@storyblok/nuxt": "^6" },
  }));
  writeFileSync(join(w.repo, "package-lock.json"), "{}");
  mkdirSync(join(w.repo, "pages", "[lang]", "preview"), { recursive: true });
  writeFileSync(join(w.repo, "pages", "[lang]", "preview", "[slug].vue"), "<template/>");
  mkdirSync(join(w.repo, ".claude", "skills", "acme-figma-page"), { recursive: true });
  writeFileSync(join(w.repo, ".claude", "skills", "acme-figma-page", "SKILL.md"), `File: https://www.figma.com/design/${STALE}/Acme?node-id=1-2\n`);
  return w;
}

test("probe reads the repo: stack, port, checks, CMS, preview route, Figma traces", () => {
  const { repo } = nuxtRepo();
  const r = probeRepo(repo);
  assert.equal(r.stack.framework, "nuxt");
  assert.equal(r.stack.package_manager, "npm");
  assert.equal(r.stack.dev, "npx nuxt dev --port {port}");
  assert.equal(r.stack.user_port, 3001);
  assert.deepEqual(r.stack.gates, ["npm run lint:quiet", "npm run typecheck"], "lint:quiet over lint; the placeholder test script is skipped");
  assert.equal(r.stack.cms, "storyblok");
  assert.equal(r.stack.preview_route, "/{lang}/preview/{page}");
  assert.equal(r.git.base_branch, "main");
  assert.deepEqual(r.git.feature_branches, ["feat/pricing"]);
  assert.deepEqual(r.figma.overlay_skills, [".claude/skills/acme-figma-page/SKILL.md"]);
  assert.equal(r.figma.keys_in_repo[0].key, STALE);
  writeFileSync(join(repo, "pages", "[lang]", "preview", "pricing.vue"), "<template/>");
  assert.equal(probeRepo(repo).stack.preview_route, "/{lang}/preview/{page}", "one file per page reads as a {page} route");
});

test("probe reads Figma: identity across same-name copies, ready depth, breakpoints", async () => {
  const state = figmaState();
  const client = {
    ...fakeClient(state),
    info: { rate_limit_type: "high" },
    me: async () => load("me.json"),
    webhooks: async () => ({ webhooks: [] }),
  };
  const f = await probeFigma(client, [`https://www.figma.com/design/${LIVE}/x?node-id=${PAGE.replace(":", "-")}`], { repoKeys: [STALE] });
  assert.equal(f.me.handle, "tony");
  assert.equal(f.rate_limit_type, "high");
  const live = f.files.find((x) => x.key === LIVE);
  const stale = f.files.find((x) => x.key === STALE);
  assert.equal(live.verdict, "live");
  assert.equal(stale.verdict, "stale");
  assert.deepEqual(live.suggested_pages, ["Development Ready (Latest)"]);
  assert.equal(live.ready_depth, 2, "Tern's ready marks sit two levels under the page");
  assert.ok(live.page_scan[0].ready > 0);
  assert.deepEqual(f.webhooks, { readable: true, count: 0 });
  assert.deepEqual(guessBreakpoints([{ width: 1443, frames: 4 }, { width: 1440, frames: 9 }, { width: 375, frames: 3 }]), { desktop: 1440, tablet: 1024, mobile: 375 });
  assert.equal(guessBreakpoints([{ width: 440, frames: 12 }, { width: 390, frames: 9 }]).mobile, 390, "the standard width wins when the design has frames at it");
});

test("doctor: one line per check, failures carry a fix", async () => {
  const { repo } = nuxtRepo();
  const config = await ternConfig(repo, (t) => t.replace('base_branch = "main"', 'base_branch = "trunk"'));
  process.env.FIGPIPE_TEST_TOKEN = "t";
  process.env.FIGPIPE_CLAUDE_BIN = "/usr/bin/true";
  const db = openDb(":memory:");
  const state = figmaState();
  const client = { ...fakeClient(state), info: { rate_limit_type: "high" }, me: async () => load("me.json") };
  const lines = await doctor({ config, db, client, launchdPlist: "/nonexistent.plist" });
  const by = (c) => lines.find((l) => l.check === c);
  assert.equal(by("Figma token").status, "ok");
  assert.equal(by("Base branch").status, "fail");
  assert.match(by("Base branch").fix, /git\.base_branch/);
  assert.equal(by("Watched pages").status, "ok");
  assert.equal(by("Background check").status, "info");
  assert.ok(lines.every((l) => l.status !== "fail" || l.fix), "every failure says how to fix it");
});

test("doctor: a schedule that misses when designers work is named, with their hours in both zones", async () => {
  const { repo } = nuxtRepo();
  process.env.FIGPIPE_TEST_TOKEN = "t";
  process.env.FIGPIPE_CLAUDE_BIN = "/usr/bin/true";
  const NOW = Date.parse("2026-10-02T12:00:00Z");
  // Designers in Berlin save a version every hour from 09:20 to 17:20 on weekdays.
  const versions = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(NOW - i * 86400000);
    if ((d.getUTCDay() + 6) % 7 > 4) continue;
    for (let h = 9; h <= 17; h++) versions.push({ id: `${i}-${h}`, created_at: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 2, 20)).toISOString(), user: { id: "1", handle: "Mara" } });
  }
  const mk = async (schedule) => {
    const config = await ternConfig(repo, (t) => t + schedule);
    const client = { ...fakeClient(figmaState()), info: { rate_limit_type: "high" }, me: async () => load("me.json"), get: async () => ({ versions }), comments: async () => ({ comments: [] }) };
    return doctor({ config, db: openDb(":memory:"), client, clock: () => NOW, launchdPlist: "/nonexistent.plist" });
  };
  // Three checks a day on the designers' own clock, none inside their working day: most edits wait for the next one.
  const late = await mk('\n[schedule]\ntimezone = "Europe/Berlin"\ntimes = ["06:00", "22:00"]\n');
  const warn = late.find((l) => l.check === "Schedule vs activity");
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, /waited over 4 h/);
  assert.match(warn.detail, /09:00-18:00 Europe\/Berlin/);
  assert.match(warn.fix, /figpipe activity --project tern/);
  const fine = await mk('\n[schedule]\ntimezone = "Europe/Berlin"\nwindows = [{ start = "08:00", end = "19:00", every = 60 }]\n');
  assert.equal(fine.find((l) => l.check === "Schedule vs activity").status, "ok");
  assert.match(fine.find((l) => l.check === "Schedule").detail, /every 60 min 08:00-19:00 every day, Europe\/Berlin time/);
  // Every 10 minutes (no [schedule]): nothing to compare.
  assert.equal((await mk("")).find((l) => l.check === "Schedule vs activity"), undefined);
});

test("partial records keep finished items; the rebuilt result passes the schema", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO batches (id, project, status, created_at) VALUES ('b1', 'p', 'running', '2026-10-02T16:00:00Z')");
  for (const k of ["ready", "comment"]) db.run("INSERT INTO items (batch_id, project, file_key, kind, node_id, thread_id, title) VALUES ('b1', 'p', 'K', ?, '1:2', ?, 'Hero')", k, k === "comment" ? "77" : null);
  const dir = "/tmp/b1";
  const one = { item_id: 1, outcome: "applied", change_kind: "redesign", verdict: "Built.", captures: [{ width: 1440, after: "captures/1/after-1440.png" }], decisions: [{ text: "A or B", default_applied: "A" }] };
  recordResult({ db, batchId: "b1", result: { items: [one] }, batchDir: dir, partial: true });
  recordResult({ db, batchId: "b1", result: { items: [one], checks: [{ name: "lint", status: "fail" }] }, batchDir: dir, partial: true });
  recordResult({ db, batchId: "b1", result: { checks: [{ name: "lint", status: "pass" }], not_done: [{ text: "x" }, { text: "x" }] }, batchDir: dir, partial: true });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM notes WHERE kind = 'decision'").n, 1, "recording an item again replaces it");
  assert.equal(db.get("SELECT status FROM notes WHERE kind = 'check'").status, "pass", "a check is replaced by name");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM notes WHERE kind = 'not_done'").n, 1);
  assert.equal(db.get("SELECT outcome FROM items WHERE id = 2").outcome, "pending", "partial records leave other items alone");
  assert.throws(() => recordResult({ db, batchId: "b1", result: { items: [{ item_id: 1 }] }, batchDir: dir, partial: true }), /outcome: required/);

  const r = resultFromDb(db, "b1", dir);
  assert.deepEqual(checkSchema(resultSchema(), r), []);
  assert.deepEqual(r.items.map((i) => i.item_id), [1]);
  assert.equal(r.items[0].captures[0].after, "captures/1/after-1440.png", "paths come back relative to the batch folder");
  // The final full record (what the supervisor stores) closes the unmentioned item.
  recordResult({ db, batchId: "b1", result: r, batchDir: dir });
  assert.equal(db.get("SELECT outcome FROM items WHERE id = 2").outcome, "failed");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM notes WHERE kind = 'decision'").n, 1, "item 1 kept its notes");
});

test("captures open local URLs only, with predictable names", () => {
  assert.equal(checkLocalUrl("http://localhost:3011/en-gb/preview/x"), null);
  assert.equal(checkLocalUrl("http://127.0.0.1:3011/"), null);
  assert.match(checkLocalUrl("https://www.figma.com/design/x"), /local URLs/);
  assert.match(checkLocalUrl("https://example.com"), /local URLs/);
  assert.deepEqual(capturePaths("/b", 7, "before", [1440, 390]).map((p) => p.rel), ["captures/7/before-1440.png", "captures/7/before-390.png"]);
  assert.throws(() => capturePaths("/b", 7, "during", [1440]), /before or after/);
});
