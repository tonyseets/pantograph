// Reconcile against the recorded Tern responses: baseline, then simulated designer activity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome, ternConfig, figmaState, fakeClient, pageDoc, findIn, comment, clockAt, LIVE, PAGE } from "./helpers.mjs";

tempHome();
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject, mentionMatcher, addManual } = await import("../../figpipe/lib/reconcile.mjs");

const pending = (db) => db.all("SELECT key, kind, role, status, note FROM events WHERE status = 'pending' ORDER BY id");

async function setup(patch) {
  const db = openDb(":memory:");
  const config = await ternConfig("/tmp/tern", patch);
  const state = figmaState();
  const clock = clockAt("2026-10-02T16:00:00Z");
  const tick = (opts = {}) => reconcileProject({ db, config, client: fakeClient(state), clock, ...opts });
  return { db, config, state, clock, tick };
}

test("mention matching: handle and display names, word boundaries, accents", () => {
  const m = mentionMatcher({ handle: "tony", names: ["Tony", "Zoë B"] });
  assert.ok(m("@tony ok fixed"));
  assert.ok(m("@Mara @tony"));
  assert.ok(m("Hey @Tony, can you check"));
  assert.ok(m("@Zoë B please"));
  assert.ok(!m("@tonyx"));
  assert.ok(!m("mail tony@example.com"));
  assert.ok(!m("Tony did this"));
  assert.ok(!m("@@tony"));
});

test("first tick is a baseline: state recorded, no events", async () => {
  const { db, tick, state } = await setup();
  const s = await tick();
  assert.equal(s.events.length, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM nodes WHERE status = 'READY_FOR_DEV'").n, 10);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM comments").n, state.comments.comments.length);
  // The real "How it works" ready section sits at depth 2 under Membership.
  const hiw = db.get("SELECT * FROM nodes WHERE node_id = '40000210:73931'");
  assert.equal(hiw.name, "How it works");
  assert.deepEqual(JSON.parse(hiw.path), ["Membership"]);
  // Page name resolved to its id with one depth-1 file read.
  assert.ok(state.calls.includes(`file ${LIVE}`));
  assert.ok(state.calls.some((c) => c.startsWith(`nodes ${PAGE} depth=2`)));
});

test("no change, no events, and no nodes read when the file did not move", async () => {
  const { tick, state, clock } = await setup();
  await tick();
  state.calls.length = 0;
  clock.advance(10);
  const s = await tick();
  assert.equal(s.events.length, 0);
  assert.ok(!state.calls.some((c) => c.startsWith(`nodes ${PAGE}`)), "the page read is skipped while last_touched_at is unchanged");
  clock.advance(61);
  state.calls.length = 0;
  await tick();
  assert.ok(state.calls.some((c) => c.startsWith(`nodes ${PAGE}`)), "the hourly sweep reads it anyway");
});

test("designer activity becomes trigger and context events", async () => {
  const { db, tick, state, clock } = await setup();
  await tick();
  clock.advance(10);

  // A section marked ready for dev (a depth-2 frame inside Main_EN).
  const mainEn = findIn(pageDoc(state), "3618:25678");
  const target = mainEn.children[0];
  target.devStatus = { type: "READY_FOR_DEV", description: "Hero copy updated" };
  state.meta.file.last_touched_at = "2026-10-02T16:05:00Z";

  // Comments: a new mention, a reply in Tony's real "animation broke" thread, an unrelated
  // comment, and one by Tony himself.
  state.comments.comments.push(
    comment({ id: "9000000001", text: "@tony the spacing under the hero looks off on mobile", at: "2026-10-02T16:04:00Z" }),
    comment({ id: "9000000002", parent: "1951128253", text: "now it really is fixed", at: "2026-10-02T16:04:30Z" }),
    comment({ id: "9000000003", by: "Zoë", byId: "1000000000000000102", text: "@Mara do we keep this?", at: "2026-10-02T16:04:40Z", node: "7563:31558" }),
    comment({ id: "9000000004", by: "tony", byId: "1671667321998733279", text: "on it", at: "2026-10-02T16:04:50Z", node: "6708:48181" }),
  );
  const s = await tick();
  const keys = s.events.map((e) => `${e.kind}/${e.role}`).sort();
  assert.deepEqual(keys, ["comment/trigger", "comment/trigger", "ready/trigger"]);
  const ready = db.get("SELECT * FROM events WHERE kind = 'ready'");
  assert.equal(ready.node_id, target.id);
  assert.equal(JSON.parse(ready.payload).description, "Hero copy updated");
  const reply = db.get("SELECT * FROM events WHERE comment_id = '9000000002'");
  assert.equal(reply.thread_id, "1951128253");
  assert.equal(JSON.parse(reply.payload).why, "reply in your thread");
  assert.equal(reply.node_id, "40000210:73826", "a reply takes its pin from the thread root");
  assert.ok(!db.get("SELECT 1 FROM events WHERE comment_id IN ('9000000003', '9000000004')"));
});

test("resolve, delete and un-mark cancel pending events", async () => {
  const { db, tick, state, clock } = await setup();
  await tick();
  clock.advance(10);
  const target = findIn(pageDoc(state), "3618:25678").children[0];
  target.devStatus = { type: "READY_FOR_DEV", description: "" };
  state.meta.file.last_touched_at = "2026-10-02T16:05:00Z";
  state.comments.comments.push(
    comment({ id: "9000000011", text: "@tony first", at: "2026-10-02T16:04:00Z" }),
    comment({ id: "9000000012", text: "@tony second", at: "2026-10-02T16:04:10Z" }),
  );
  await tick();
  assert.equal(pending(db).length, 3);

  clock.advance(10);
  state.comments.comments.find((c) => c.id === "9000000011").resolved_at = "2026-10-02T16:12:00Z";
  state.comments.comments = state.comments.comments.filter((c) => c.id !== "9000000012");
  delete target.devStatus;
  state.meta.file.last_touched_at = "2026-10-02T16:12:00Z";
  const s = await tick();
  assert.equal(s.cancelled, 3);
  assert.equal(pending(db).length, 0);
  const notes = db.all("SELECT note FROM events ORDER BY id").map((r) => r.note).sort();
  assert.deepEqual(notes, ["deleted in Figma", "no longer marked ready in Figma", "resolved in Figma"]);
});

test("a node marked ready again after un-marking is a new event", async () => {
  const { db, tick, state, clock } = await setup();
  await tick();
  const hiw = findIn(pageDoc(state), "40000210:73931");
  const move = (iso) => (state.meta.file.last_touched_at = iso);
  delete hiw.devStatus;
  move("2026-10-02T16:10:00Z");
  clock.advance(10);
  await tick();
  hiw.devStatus = { type: "READY_FOR_DEV", description: "" };
  move("2026-10-02T16:20:00Z");
  clock.advance(10);
  const s = await tick();
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].kind, "ready");
  assert.equal(db.get("SELECT ready_since FROM nodes WHERE node_id = '40000210:73931'").ready_since, "2026-10-02T16:20:00.000Z");
});

test("moving a ready section on the canvas is not a change; editing a built one is", async () => {
  const { db, tick, state, clock } = await setup();
  await tick();
  const hiw = findIn(pageDoc(state), "40000210:73931");
  db.run("INSERT INTO ledger (project, key, batch_id, outcome, at) VALUES ('tern', ?, 'b1', 'applied', '2026-10-02T15:00:00Z')", `node:${LIVE}:40000210:73931`);
  // Move the whole section: every absolute box shifts.
  const shift = (n) => {
    if (n.absoluteBoundingBox) n.absoluteBoundingBox.x += 500;
    if (n.absoluteRenderBounds) n.absoluteRenderBounds.x += 500;
    (n.children ?? []).forEach(shift);
  };
  shift(hiw);
  state.meta.file.last_touched_at = "2026-10-02T16:10:00Z";
  clock.advance(10);
  assert.equal((await tick()).events.length, 0);
  // Resize it: a real change on a built node.
  hiw.absoluteBoundingBox.height += 120;
  state.meta.file.last_touched_at = "2026-10-02T16:20:00Z";
  clock.advance(10);
  const s = await tick();
  assert.deepEqual(s.events.map((e) => e.kind), ["changed"]);
});

test("named versions: context by default, trigger when configured; autosaves ignored", async () => {
  const { db, tick, state, clock } = await setup();
  await tick();
  state.versions.versions.unshift(
    { id: "9100", created_at: "2026-10-02T16:08:00Z", label: "Ready for dev: nav", description: "", user: { handle: "Zoë" } },
    { id: "9101", created_at: "2026-10-02T16:09:00Z", label: null, description: null, user: { handle: "Mara" } },
  );
  clock.advance(10);
  await tick();
  const v = db.all("SELECT kind, role FROM events").map((r) => ({ ...r }));
  assert.deepEqual(v, [{ kind: "version", role: "context" }]);

  const t = await setup((txt) => txt.replace('named_versions = "close_batch"', 'named_versions = "trigger"'));
  await t.tick();
  t.state.versions.versions.unshift({ id: "9200", created_at: "2026-10-02T16:08:00Z", label: "Hand-off", user: { handle: "Zoë" } });
  t.clock.advance(10);
  await t.tick();
  assert.equal(t.db.get("SELECT role FROM events WHERE kind = 'version'").role, "trigger");
});

test("a stale same-name copy edited after the live file is flagged, never built", async () => {
  const { db, tick, state, clock } = await setup();
  state.metaStale.file.last_touched_at = "2026-10-02T17:00:00Z";
  const s = await tick();
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].kind, "identity");
  assert.equal(s.events[0].role, "context");
  assert.match(s.warnings.join("\n"), /wrong copy/);
  assert.equal(db.get("SELECT role FROM files WHERE file_key = 'Tn7OldDemoKey8r3Vu5Ka1'").role, "stale");
  clock.advance(10);
  assert.equal((await tick()).events.length, 0, "the same stale edit is reported once");
});

test("backfill turns what is open right now into events", async () => {
  const { tick } = await setup();
  const s = await tick({ backfill: true });
  const ready = s.events.filter((e) => e.kind === "ready");
  assert.equal(ready.length, 10);
  const mentions = s.events.filter((e) => e.kind === "comment" && e.role === "trigger");
  assert.ok(mentions.length > 0);
  // The resolved "@Mara" threads and Tony's own comments never become triggers.
  assert.ok(mentions.every((e) => !e.key.includes("1949381319")));
});

test("manual add dedupes and resolves the comment thread", async () => {
  const { db, tick } = await setup();
  await tick();
  const a = addManual({ db, project: "tern", fileKey: LIVE, nodeId: null, commentId: "1951152739", note: "re-check" });
  const b = addManual({ db, project: "tern", fileKey: LIVE, nodeId: null, commentId: "1951152739", note: "re-check" });
  assert.ok(a.inserted && !b.inserted);
  const e = db.get("SELECT * FROM events WHERE key = ?", a.key);
  assert.equal(e.thread_id, "1951128253");
  assert.equal(e.role, "trigger");
});

test("an edited comment is built from its latest wording", async () => {
  const { db, state, clock, tick } = await setup();
  await tick();
  state.comments.comments.push(comment({ id: "9100", text: "@tony headline should read Alpha", at: "2026-10-02T16:01:00Z" }));
  clock.advance(10);
  await tick();
  state.comments.comments.find((c) => c.id === "9100").message = "@tony headline should read Beta";
  clock.advance(10);
  await tick();
  assert.equal(db.get("SELECT message FROM comments WHERE comment_id = '9100'").message, "@tony headline should read Beta");
  assert.equal(JSON.parse(db.get("SELECT payload FROM events WHERE comment_id = '9100'").payload).text, "@tony headline should read Beta", "the waiting event carries the new text");
  // Already in a batch: the item gets a note the report shows.
  db.run("UPDATE events SET status = 'batched', batch_id = 'b1' WHERE comment_id = '9100'");
  state.comments.comments.find((c) => c.id === "9100").message = "@tony headline should read Gamma";
  clock.advance(10);
  await tick();
  assert.match(db.get("SELECT note FROM events WHERE comment_id = '9100'").note, /Edited in Figma after the batch started; it now reads: "@tony headline should read Gamma"/);
});

test("a page that does not come back once leaves its ready marks alone", async () => {
  const { db, state, clock, tick } = await setup();
  await tick();
  const ready = db.get("SELECT COUNT(*) AS n FROM nodes WHERE status = 'READY_FOR_DEV'").n;
  const saved = state.page;
  state.page = { nodes: { [PAGE]: null } };
  state.meta.file.last_touched_at = "2026-10-02T16:05:00Z";
  clock.advance(10);
  const s = await tick();
  assert.match(s.warnings.join("\n"), /did not come back from Figma; its ready marks are left as they were/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM nodes WHERE status = 'READY_FOR_DEV'").n, ready);
  state.page = saved;
  state.meta.file.last_touched_at = "2026-10-02T16:15:00Z";
  clock.advance(10);
  await tick();
  assert.equal(pending(db).filter((e) => e.kind === "ready").length, 0, "no burst of ready items when the page comes back");
});

test("a watched page renamed away is noticed on the hourly sweep, with a warning", async () => {
  const { db, state, clock, tick } = await setup();
  await tick();
  const name = pageDoc(state).name;
  const client = fakeClient(state);
  client.file = async () => ({ document: { children: [{ id: PAGE, name: name.replace("(Latest)", "(Old)") || `${name} old`, type: "CANVAS" }, { id: "9999:1", name, type: "CANVAS" }] } });
  client.nodes = async (k, ids) => (state.calls.push(`nodes ${ids.join(",")}`), { nodes: Object.fromEntries(ids.map((i) => [i, i === PAGE ? state.page.nodes[PAGE] : { document: { id: i, name, type: "CANVAS", children: [{ id: "9999:2", name: "Frame", type: "FRAME", children: [] }] } }])) });
  state.meta.file.last_touched_at = "2026-10-02T16:30:00Z";
  clock.advance(70);
  state.calls.length = 0;
  const { config } = await setup();
  const s = await reconcileProject({ db, config, client, clock });
  assert.match(s.warnings.join("\n"), /is now a different page in Figma \(9999:1, was 3618:15687\)/);
  assert.ok(state.calls.some((c) => c.startsWith("nodes 9999:1")), "the new page is read");
  assert.equal(JSON.parse(db.get("SELECT page_ids FROM files WHERE file_key = ?", LIVE).page_ids)[name], "9999:1");
});
