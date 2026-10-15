// Watched sections: in-progress designs the user pre-built. Recorded Tern fixtures (the About section
// with content, the empty Technology section), then simulated designer activity: moves, edits,
// comments, ready marks, a node that disappears. Checks the triggers, the baseline and the batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tempHome, ternConfig, figmaState, fakeClient, fakeFetch, comment, clockAt, load, LIVE } from "./helpers.mjs";

tempHome();
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject } = await import("../../figpipe/lib/reconcile.mjs");
const { applyScope } = await import("../../figpipe/lib/scope.mjs");
const { planBatch, createBatch, laneOf } = await import("../../figpipe/lib/batcher.mjs");
const { extractBatch } = await import("../../figpipe/lib/extract.mjs");
const { planLane } = await import("../../figpipe/lib/run.mjs");
const { watchView, watchLine, watchForNode, buildSnapshot } = await import("../../figpipe/lib/watch.mjs");
const { parseConfig } = await import("../../figpipe/lib/config.mjs");

const ABOUT = "7431:81091";
const TECH = "7431:81073";
const WATCH = `
[[figma.files.watch]]
node = "7431:81091"
name = "About"
branch = "feat/plans-r2"
route = "/en-gb/preview/about"
page = "Design In Progress"

[[figma.files.watch]]
node = "7431-81073"
name = "Technology"
branch = "feat/plans-r2"
built = false
`;
const withWatch = (extra = "") => (t) => t.replace('canonical_copy = "desktop"\n', `canonical_copy = "desktop"\n${WATCH}${extra}`);

const walk = (n, f) => {
  f(n);
  for (const c of n.children ?? []) walk(c, f);
};
const doc = (state, id) => state.nodes[id].nodes[id].document;
const firstText = (n) => {
  let t = null;
  walk(n, (x) => (t ??= x.type === "TEXT" ? x : null));
  return t;
};
const pending = (db, kind) => db.all(`SELECT * FROM events WHERE status = 'pending' AND role = 'trigger'${kind ? " AND kind = ?" : ""} ORDER BY id`, ...(kind ? [kind] : []));

async function setup(patch = withWatch()) {
  const db = openDb(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "tern-repo-"));
  const config = await ternConfig(repo, patch);
  const state = figmaState();
  const w = load("nodes-watch.json");
  state.nodes[ABOUT] = { nodes: { [ABOUT]: w.nodes[ABOUT] } };
  state.nodes[TECH] = { nodes: { [TECH]: w.nodes[TECH] } };
  const clock = clockAt("2026-10-06T14:00:00Z");
  const tick = (opts = {}) => reconcileProject({ db, config, client: fakeClient(state), clock, fetchImpl: fakeFetch, sleep: async () => {}, ...opts });
  // The designer edits the file: last_touched_at moves, so the next check reads the sections.
  const touch = (min = 5) => {
    clock.advance(min);
    state.meta.file.last_touched_at = new Date(clock() - 60000).toISOString();
  };
  return { db, config, state, clock, tick, touch, repo };
}

test("config: watched sections parse, share a lane only on one branch, and a file may watch only sections", async () => {
  const c = await ternConfig("/tmp/tern", withWatch());
  const ws = c.figma.files[0].watch;
  assert.deepEqual(ws.map((w) => [w.node, w.built, w.route]), [[ABOUT, true, "/en-gb/preview/about"], [TECH, false, ""]], "node ids with a dash are normalised");
  const text = readFileSync(new URL("./fixtures/tern/tern.toml", import.meta.url), "utf8").replace("__REPO__", "/tmp/x");
  const parse = (extra) => parseConfig(withWatch(extra)(text));
  assert.throws(() => parse(`\n[[figma.files.watch]]\nnode = "7431:81091"\nname = "Again"\nbranch = "main"\n`), /7431:81091 is already watched as "About"/);
  assert.throws(() => parse(`\n[[figma.files.watch]]\nnode = "1:2"\nname = "About regular"\nlane = "about"\nbranch = "main"\n`), /lane "about" is built from feat\/plans-r2/);
  assert.throws(() => parse(`\n[[figma.files.watch]]\nnode = "1:2"\nname = "X"\nbranch = "main"\nroute = "en-gb/x"\n`), /route.*a path starting with \//);
  assert.throws(() => parseConfig(text.replace('pages = ["Development Ready (Latest)"]', "pages = []")), /name at least one page/);
  assert.doesNotThrow(() => parse("").figma && parseConfig(withWatch()(text.replace('pages = ["Development Ready (Latest)"]', "pages = []"))));
});

test("the first read records a baseline per section, raises nothing, and a built one counts as built from it", async () => {
  const { db, tick, config } = await setup();
  const s = await tick();
  assert.equal(s.events.length, 0);
  assert.deepEqual(s.seeded, ["About", "Technology"]);
  const about = db.get("SELECT * FROM watches WHERE node_id = ?", ABOUT);
  assert.equal(about.figma_name, "About");
  assert.match(about.baseline_id, /^baseline-20261006-1400/);
  const snap = buildSnapshot(db, "tern", LIVE, ABOUT);
  assert.ok(existsSync(snap.path), "node JSON saved");
  assert.ok(JSON.parse(snap.renders).some((r) => r.role === "child" && existsSync(r.path)), "renders of the breakpoint frames saved");
  assert.equal(db.get("SELECT outcome FROM ledger WHERE key = ?", `node:${LIVE}:${ABOUT}`).outcome, "already_done", "About is pre-built from this design");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM ledger WHERE key = ?", `node:${LIVE}:${TECH}`).n, 0, "Technology is not built");
  assert.ok(db.get("SELECT 1 AS x FROM node_areas WHERE area_id = ? AND node_id = '40000404:131383'", ABOUT), "layers inside map to the section");
  const v = watchView(db, config);
  assert.match(watchLine(v[0]), /^About \(\/en-gb\/preview\/about from feat\/plans-r2\): no change since the baseline/);
  assert.match(watchLine(v[1]), /not built yet/);
});

test("a dry run lists sections without a baseline instead of recording one", async () => {
  const { db, tick } = await setup();
  const s = await tick({ seed: false });
  assert.deepEqual(s.unseeded, ["About", "Technology"]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM snapshots").n, 0);
});

test("moving a section is not a change; editing copy deep inside is, once per new design", async () => {
  const { db, state, tick, touch } = await setup();
  await tick();
  touch();
  walk(doc(state, ABOUT), (n) => {
    for (const k of ["absoluteBoundingBox", "absoluteRenderBounds"]) if (n[k]) n[k] = { ...n[k], x: n[k].x + 900, y: n[k].y - 300 };
  });
  assert.equal((await tick()).events.length, 0, "moved on the canvas");
  touch();
  firstText(doc(state, ABOUT)).characters = "About Tern, rewritten";
  const s = await tick();
  assert.deepEqual(s.events.map((e) => [e.kind, e.role]), [["changed", "trigger"]]);
  const e = pending(db, "changed")[0];
  assert.equal(e.node_id, ABOUT);
  assert.deepEqual(JSON.parse(e.payload).watch, ABOUT);
  assert.match(db.get("SELECT last_change FROM watches WHERE node_id = ?", ABOUT).last_change, /design changed/);
  touch();
  assert.equal((await tick()).events.length, 0, "the same design again raises nothing");
});

test("no read while the file has not moved; the hourly read still catches up", async () => {
  const { state, tick, clock } = await setup();
  await tick();
  state.calls.length = 0;
  clock.advance(10);
  await tick();
  assert.ok(!state.calls.some((c) => c.includes(ABOUT)), "the watched sections are not read");
  firstText(doc(state, ABOUT)).characters = "Changed without a touch";
  clock.advance(61);
  const s = await tick();
  assert.equal(s.events.filter((e) => e.kind === "changed").length, 1);
});

test("a comment on or inside a watched section from anyone but you is a trigger, and always yours", async () => {
  const { db, state, tick, touch, config } = await setup();
  // The thread tags only Ada, which would make a normal thread someone else's.
  config.scope.others = ["Ada Brooks"];
  await tick();
  touch();
  state.comments.comments.push(
    comment({ id: "9100000001", text: "@Ada can the intro be shorter?", node: "40000404:131354", at: "2026-10-06T14:04:00Z" }),
    comment({ id: "9100000002", by: "tony", byId: "1671667321998733279", text: "noted", node: ABOUT, at: "2026-10-06T14:04:30Z" }),
    comment({ id: "9100000003", text: "unrelated", node: "40000210:73932", at: "2026-10-06T14:04:40Z" }),
  );
  const s = await tick();
  assert.deepEqual(s.events.map((e) => e.key), ["comment:Tn7LiveDemoKey0q2Wx4Yz:9100000001"], "only Mara's comment inside About; yours and the unrelated one raise nothing");
  const p = JSON.parse(pending(db, "comment")[0].payload);
  assert.equal(p.watch, ABOUT);
  assert.deepEqual(p.addressed_to, ["Ada"]);
  applyScope({ db, config });
  assert.equal(pending(db, "comment").length, 1, "a watched section is yours by definition");
  assert.match(db.get("SELECT last_change FROM watches WHERE node_id = ?", ABOUT).last_change, /comment from Mara/);
});

test("a ready mark on the section or a frame inside it is a ready trigger; un-marking cancels it", async () => {
  const { db, state, tick, touch } = await setup();
  await tick();
  touch();
  doc(state, ABOUT).children[0].devStatus = { type: "READY_FOR_DEV", description: "About, desktop" };
  const s = await tick();
  assert.deepEqual(s.events.map((e) => e.kind), ["ready"]);
  const p = JSON.parse(pending(db, "ready")[0].payload);
  assert.equal(p.prebuilt, true);
  assert.equal(p.ready_nodes[0].name, "Desktop");
  assert.equal(db.get("SELECT status FROM watches WHERE node_id = ?", ABOUT).status, "ready");
  touch();
  delete doc(state, ABOUT).children[0].devStatus;
  await tick();
  assert.equal(pending(db, "ready").length, 0);
  assert.match(db.get("SELECT note FROM events WHERE kind = 'ready'").note, /no longer marked ready/);
});

test("a ready node with a watched section's name (copied to the ready page) is matched to it", async () => {
  const { db, tick, config } = await setup();
  await tick();
  assert.equal(watchForNode(db, config, LIVE, "999:1", "about")?.node, ABOUT);
  assert.equal(watchForNode(db, config, LIVE, "999:1", "Home"), null);
});

test("a watched node that disappears is a warning that names where a section with its name went", async () => {
  const { db, state, tick, touch, config } = await setup();
  await tick();
  touch();
  delete state.nodes[TECH];
  const s = await tick();
  assert.ok(s.warnings.some((w) => /"Technology": node 7431:81073 is gone/.test(w)), s.warnings.join("\n"));
  assert.equal(db.get("SELECT status FROM watches WHERE node_id = ?", TECH).status, "gone");
  assert.match(watchLine(watchView(db, config)[1]), /not in Figma/);
});

test("the batch updates the pre-built page: lane from the watch, its branch as base, its route as preview, diffs against the baseline", async () => {
  const { db, state, tick, touch, clock, config } = await setup();
  await tick();
  touch();
  firstText(doc(state, ABOUT)).characters = "About Tern, rewritten";
  await tick();
  clock.advance(30);
  const plan = planBatch({ db, config, clock });
  assert.equal(plan.go, true, plan.wait.join("; "));
  const b = createBatch({ db, config, plan, clock });
  const it = db.get("SELECT * FROM items WHERE batch_id = ?", b.id);
  assert.equal(it.kind, "changed");
  assert.equal(it.area_name, "About");
  assert.equal(laneOf(it), "about");
  const w = JSON.parse(it.watch);
  assert.deepEqual([w.branch, w.route, w.built], ["feat/plans-r2", "/en-gb/preview/about", true]);
  const lane = planLane(config, "about", [], { base: w.branch });
  assert.deepEqual([lane.branch, lane.base], ["figma/about", "feat/plans-r2"]);

  const ex = await extractBatch({ db, config, client: fakeClient(state), batchId: b.id, clock, fetchImpl: fakeFetch, sleep: async () => {} });
  const rec = ex.items[it.id];
  assert.match(rec.baseline.snapshot, /^baseline-/);
  assert.match(readFileSync(rec.copy_diff.path, "utf8"), /\+.*About Tern, rewritten/);
  assert.ok(rec.sdiff.changed_lines > 0);
  assert.ok(JSON.parse(db.get("SELECT figma_before FROM items WHERE id = ?", it.id).figma_before).length, "the Figma before renders ride along to the report");
  assert.equal(db.get("SELECT outcome FROM items WHERE id = ?", it.id).outcome, "pending");
});

test("a change that goes back to the baseline closes before any AI runs", async () => {
  const { db, state, tick, touch, clock, config } = await setup();
  await tick();
  const t = firstText(doc(state, ABOUT));
  const was = t.characters;
  touch();
  t.characters = "Draft";
  await tick();
  t.characters = was;
  clock.advance(30);
  const b = createBatch({ db, config, plan: planBatch({ db, config, clock }), clock });
  await extractBatch({ db, config, client: fakeClient(state), batchId: b.id, clock, fetchImpl: fakeFetch, sleep: async () => {} });
  const it = db.get("SELECT * FROM items WHERE batch_id = ?", b.id);
  assert.equal(it.outcome, "already_done");
  assert.match(it.verdict, /No design change since the design your pre-built page was made from/);
});

test("an empty section that gets content is a new page for the batch: not built, diffed against the empty baseline", async () => {
  const { db, state, tick, touch, clock, config } = await setup();
  await tick();
  touch();
  const frame = doc(state, TECH).children[0];
  frame.children = [{ id: "9:1", name: "Heading", type: "TEXT", characters: "Technology", visible: true, absoluteBoundingBox: { ...frame.absoluteBoundingBox, height: 80 }, style: { fontSize: 64 } }];
  await tick();
  clock.advance(30);
  const b = createBatch({ db, config, plan: planBatch({ db, config, clock }), clock });
  const it = db.get("SELECT * FROM items WHERE batch_id = ?", b.id);
  assert.equal(JSON.parse(it.watch).built, false);
  assert.equal(laneOf(it), "technology");
  const ex = await extractBatch({ db, config, client: fakeClient(state), batchId: b.id, clock, fetchImpl: fakeFetch, sleep: async () => {} });
  assert.match(readFileSync(ex.items[it.id].copy_diff.path, "utf8"), /\+.*"Technology"/);
});

test("marked ready with no design change since the pre-built page: a ready item, closed as already built before any AI runs", async () => {
  const { db, state, tick, touch, clock, config } = await setup();
  await tick();
  touch();
  doc(state, ABOUT).devStatus = { type: "READY_FOR_DEV", description: "" };
  await tick();
  clock.advance(30);
  const b = createBatch({ db, config, plan: planBatch({ db, config, clock }), clock });
  const it = db.get("SELECT * FROM items WHERE batch_id = ?", b.id);
  assert.equal(it.kind, "ready");
  assert.equal(JSON.parse(it.watch).built, true);
  await extractBatch({ db, config, client: fakeClient(state), batchId: b.id, clock, fetchImpl: fakeFetch, sleep: async () => {} });
  const after = db.get("SELECT * FROM items WHERE id = ?", it.id);
  assert.equal(after.outcome, "already_done");
  assert.match(after.verdict, /pre-built page was made from/);
  assert.equal(after.branch, "feat/plans-r2");
});
