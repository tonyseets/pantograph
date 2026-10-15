// Batching rules: quiet window, max wait, named versions, review backlog, caps, grouping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempHome, ternConfig, figmaState, fakeClient, pageDoc, findIn, comment, clockAt } from "./helpers.mjs";

const home = tempHome();
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject } = await import("../../figpipe/lib/reconcile.mjs");
const { planBatch, createBatch, inActiveHours, groupItems } = await import("../../figpipe/lib/batcher.mjs");

// Baseline at 16:00, then at 16:10 the designer marks a section ready and mentions Tony twice.
async function scenario(patch) {
  const db = openDb(":memory:");
  const config = await ternConfig("/tmp/tern", patch);
  const state = figmaState();
  const clock = clockAt("2026-10-02T16:00:00Z");
  const tick = () => reconcileProject({ db, config, client: fakeClient(state), clock });
  state.meta.file.last_touched_at = "2026-10-02T15:50:00Z";
  await tick();
  clock.advance(10);
  findIn(pageDoc(state), "3618:25678").children[0].devStatus = { type: "READY_FOR_DEV", description: "" };
  state.meta.file.last_touched_at = "2026-10-02T16:09:00Z";
  state.comments.comments.push(
    comment({ id: "9000000001", text: "@tony spacing", at: "2026-10-02T16:08:00Z" }),
    comment({ id: "9000000002", parent: "9000000001", text: "@tony and the button", at: "2026-10-02T16:08:30Z" }),
  );
  await tick();
  const plan = (o = {}) => planBatch({ db, config, clock, ...o });
  return { db, config, state, clock, tick, plan };
}

test("waits for the quiet window, then batches", async () => {
  const { plan, clock } = await scenario();
  let p = plan();
  assert.equal(p.go, false);
  assert.match(p.wait[0], /designer active; quiet window ends in 20 min/);
  clock.advance(19);
  assert.equal(plan().go, false);
  clock.advance(1);
  p = plan();
  assert.equal(p.go, true);
  assert.equal(p.reason, "designer quiet for 20 min");
});

test("an edit in Figma restarts the quiet window", async () => {
  const { plan, clock, state, tick } = await scenario();
  clock.advance(15);
  state.meta.file.last_touched_at = "2026-10-02T16:24:00Z";
  await tick();
  clock.advance(10);
  assert.equal(plan().go, false);
  clock.advance(10);
  assert.equal(plan().go, true);
});

test("max wait runs the batch while the designer keeps working", async () => {
  const { plan, clock, state, tick } = await scenario();
  for (let i = 0; i < 12; i++) {
    clock.advance(10);
    state.meta.file.last_touched_at = new Date(clock()).toISOString();
    await tick();
  }
  const p = plan();
  assert.equal(p.go, true);
  assert.equal(p.reason, "oldest item waited 120 min");
});

test("a named version closes the window early", async () => {
  const { plan, clock, state, tick } = await scenario();
  clock.advance(5);
  state.versions.versions.unshift({ id: "v-1", created_at: "2026-10-02T16:14:00Z", label: "Hand-off", user: { handle: "Zoë" } });
  await tick();
  const p = plan();
  assert.equal(p.go, true);
  assert.equal(p.reason, "the designer saved a named version");
});

test("an unreviewed batch holds the next one; --now overrides; ack releases", async () => {
  const { db, config, plan, clock } = await scenario();
  clock.advance(20);
  createBatch({ db, config, plan: plan() });
  db.run("UPDATE batches SET status = 'done'");
  // New work arrives.
  db.run("INSERT INTO events (key, project, file_key, kind, role, node_id, detected_at) VALUES ('manual:x', 'tern', 'Tn7LiveDemoKey0q2Wx4Yz', 'manual', 'trigger', '1:2', ?)", new Date(clock()).toISOString());
  clock.advance(30);
  let p = plan();
  assert.equal(p.go, false);
  assert.match(p.wait.join(), /1 batch waiting for your review/);
  assert.equal(plan({ now: true }).go, true);
  db.run("UPDATE batches SET status = 'reviewed'");
  assert.equal(plan().go, true);
});

test("hard stops: pause file, daily cap, blocked project, active batch", async () => {
  const { db, config, plan, clock } = await scenario((t) => t.replace("batches_per_day = 4", "batches_per_day = 1"));
  clock.advance(20);
  writeFileSync(join(home, "PAUSE"), "x");
  assert.match(plan({ now: true }).wait.join(), /paused/);
  rmSync(join(home, "PAUSE"));
  createBatch({ db, config, plan: plan(), clock });
  db.run("INSERT INTO events (key, project, file_key, kind, role, node_id, detected_at) VALUES ('manual:y', 'tern', 'Tn7LiveDemoKey0q2Wx4Yz', 'manual', 'trigger', '1:3', ?)", new Date(clock()).toISOString());
  assert.match(plan({ now: true }).wait.join(), /is ready/);
  db.run("UPDATE batches SET status = 'reviewed'");
  assert.match(plan({ now: true }).wait.join(), /daily cap of 1 batches reached/);
  db.run("INSERT INTO project_state (project, blocked) VALUES ('tern', 'Figma token problem')");
  assert.match(plan({ now: true }).wait.join(), /blocked: Figma token problem/);
});

test("pacing holds non-urgent batches, never ones at max wait", async () => {
  const { plan, clock } = await scenario((t) => t.replace("pace_with_usage_meter = false", "pace_with_usage_meter = true"));
  clock.advance(20);
  const ahead = () => ({ ahead: true, text: "60% used, 30% of the week gone" });
  assert.match(plan({ pace: ahead }).wait.join(), /usage ahead of pace/);
  clock.advance(100);
  assert.equal(plan({ pace: ahead }).go, true);
});

test("grouping: one item per node, one per thread; context rides along; caps leave the rest", async () => {
  const { db, config, plan, clock } = await scenario((t) => t.replace("max_items = 10", "max_items = 1"));
  clock.advance(20);
  const p = plan();
  const groups = groupItems(db, "tern", [...p.triggers, ...p.context]);
  assert.equal(groups.length, 2, "two comments in one thread are one item");
  const thread = groups.find((g) => g.kind === "comment");
  assert.equal(thread.events.length, 2);
  assert.match(thread.title, /^Mara: @tony spacing/);
  const b = createBatch({ db, config, plan: p });
  assert.equal(b.items, 1);
  assert.equal(b.left, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE status = 'pending' AND role = 'trigger'").n > 0, true);
  const item = db.get("SELECT * FROM items");
  assert.equal(item.outcome, "pending");
});

test("active hours, including a window across midnight", () => {
  const at = (h, m = 0) => new Date(2026, 9, 2, h, m).getTime();
  assert.ok(inActiveHours("", at(3)));
  assert.ok(inActiveHours("08:00-22:00", at(8)));
  assert.ok(!inActiveHours("08:00-22:00", at(22)));
  assert.ok(inActiveHours("22:00-06:00", at(23)));
  assert.ok(inActiveHours("22:00-06:00", at(5, 59)));
  assert.ok(!inActiveHours("22:00-06:00", at(12)));
});
