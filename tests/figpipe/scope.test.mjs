// Scope: whose handoffs these are. Pure rules, then end to end against the recorded Tern file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome, ternConfig, figmaState, fakeClient, clockAt } from "./helpers.mjs";

tempHome();
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject } = await import("../../figpipe/lib/reconcile.mjs");
const { planBatch, createBatch } = await import("../../figpipe/lib/batcher.mjs");
const { globToRegex, matchNames, othersMentioned, ownerOf, driftOf, verdictFor, scopeOfThread, applyScope, scopeSummary, scopeLine, askLines, recordOwnership, ownershipTable } = await import("../../figpipe/lib/scope.mjs");
const { parseConfig } = await import("../../figpipe/lib/config.mjs");
const { sameBase } = await import("../../figpipe/lib/names.mjs");

const ME = { handle: "tony", names: ["Tony"] };
const scope = (o = {}) => ({ include: [], exclude: [], others: [], ...o });
const c = (message, created_at = "2026-10-01T10:00:00Z") => ({ message, created_at });

test("globs are case-insensitive, anchored, and * and ? only", () => {
  assert.ok(globToRegex("*Funnel*").test("Booking funnel v2"));
  assert.ok(globToRegex("Offer Funnel*").test("offer funnel / step 2"));
  assert.ok(!globToRegex("Offer Funnel*").test("The Offer Funnel"));
  assert.ok(globToRegex("Hero ?").test("Hero 2"));
  assert.ok(!globToRegex("a.c").test("abc"), "dots are literal");
  assert.ok(globToRegex("(x)").test("(X)"), "regex characters are literal");
});

test("matchNames checks the node and its ancestors", () => {
  assert.deepEqual(matchNames(["*Funnel*"], ["Insulation", "Booking Funnel"]), { pattern: "*Funnel*", name: "Booking Funnel" });
  assert.equal(matchNames(["*Funnel*"], ["Insulation", "Membership"]), null);
});

test("others: full name, first name, word boundaries", () => {
  const o = ["Ada Brooks", "Arlo", "Kit Moreau"];
  assert.deepEqual(othersMentioned(o, "@Ada Brooks please check"), ["Ada Brooks"]);
  assert.deepEqual(othersMentioned(o, "@ada can you look"), ["Ada Brooks"]);
  assert.deepEqual(othersMentioned(o, "@Arlo @Kit"), ["Arlo", "Kit Moreau"]);
  assert.deepEqual(othersMentioned(o, "@Arloa hi"), []);
  assert.deepEqual(othersMentioned(o, "Arlo said"), []);
});

const own = (sc, o) => ownerOf({ scope: scope(sc), me: ME, ...o });

test("owner: exclude wins over include, include beats the others signal, reasons name the match", () => {
  const s = { include: ["Membership*"], exclude: ["*Funnel*"], others: ["Arlo"] };
  const x = own(s, { name: "Insulation", path: ["Booking Funnel"] });
  assert.equal(x.owner, "others");
  assert.match(x.why, /exclude "\*Funnel\*" \(in Booking Funnel\)/);
  assert.equal(own(s, { name: "Hero", path: ["Membership"], comments: [c("@Arlo")] }).owner, "mine");
  assert.equal(own(s, { name: "Hero", path: ["Membership Funnel"] }).owner, "others");
});

test("owner: comments decide when no rule does, and say who", () => {
  const s = { others: ["Arlo", "Lena"] };
  const o = own(s, { name: "Insulation", comments: [c("@Arlo check"), c("@Lena too")] });
  assert.deepEqual([o.owner, o.who, o.confidence, o.source], ["others", ["Arlo", "Lena"], "high", "comments"]);
  assert.equal(own(s, { name: "Insulation", comments: [c("@Arlo check")] }).confidence, "medium");
  assert.equal(own(s, { name: "Insulation", comments: [c("@Arlo and @tony")] }).owner, "mine");
  assert.equal(own(s, { name: "Insulation", comments: [c("looks good")] }).owner, "unknown");
  assert.equal(own({}, { name: "Anything" }).owner, "unknown");
});

test("owner: the tracker mapping assigns by section pattern; the user's own name means mine", () => {
  const s = { assign: { "Booking*": "Galina", "Homepage": "Tony" } };
  assert.deepEqual(own(s, { name: "Booking step 2" }).who, ["Galina"]);
  assert.equal(own(s, { name: "Booking step 2" }).owner, "others");
  assert.equal(own(s, { name: "Homepage" }).owner, "mine");
});

test("owner: answers outrank rules and comments, by name or node id", () => {
  const answers = [{ name_key: "insulation", node_id: null, owner: "mine", who: [] }, { name_key: "x", node_id: "1:2", owner: "others", who: ["Arlo"] }];
  const s = { exclude: ["*"], others: ["Arlo"] };
  assert.equal(own(s, { name: "Insulation", answers, comments: [c("@Arlo")] }).owner, "mine");
  const o = own({}, { name: "Other name", nodeId: "1:2", answers });
  assert.deepEqual([o.owner, o.who, o.confidence], ["others", ["Arlo"], "answered"]);
});

test("verdict: others are skipped, unknown is held only when unknown = ask", () => {
  const unk = { owner: "unknown", who: [], why: "no signal" };
  assert.equal(verdictFor(unk, scope({ unknown: "mine" })).status, "pending");
  assert.equal(verdictFor(unk, scope({ unknown: "ask" })).status, "needs_owner");
  assert.equal(verdictFor({ owner: "others", who: [], why: "r" }, scope()).status, "out_of_scope");
  assert.equal(verdictFor({ owner: "mine", who: [], why: "r" }, scope({ unknown: "ask" })).status, "pending");
});

test("drift: a rule or answer that the comments now contradict", () => {
  const a = { scope: scope({ include: ["Insulation"], others: ["Arlo"] }), me: ME, name: "Insulation" };
  assert.match(driftOf({ ...a, comments: [c("@Arlo"), c("@Arlo")] }).why, /comments tag only Arlo/);
  assert.equal(driftOf({ ...a, comments: [c("@Arlo")] }), null, "one mention is not drift");
  assert.equal(driftOf({ ...a, comments: [c("@tony")] }), null);
  const b = { scope: scope({ exclude: ["Insulation"] }), me: ME, name: "Insulation" };
  assert.match(driftOf({ ...b, comments: [c("@tony a"), c("@tony b")] }).why, /comments tag you/);
  assert.equal(driftOf({ scope: scope(), me: ME, name: "Insulation", comments: [c("@Arlo"), c("@Arlo")] }), null, "no explicit owner, nothing to drift from");
});

test("thread: only the last three comments count", () => {
  const s = scope({ others: ["Arlo"] });
  const thread = [c("@tony look", "2026-10-01T10:00:00Z"), c("ok", "2026-10-01T11:00:00Z"), c("@Arlo", "2026-10-01T12:00:00Z"), c("@Arlo again", "2026-10-01T13:00:00Z"), c("@Arlo", "2026-10-01T14:00:00Z")];
  assert.equal(scopeOfThread({ scope: s, me: ME, comments: thread }).in, false);
  assert.equal(scopeOfThread({ scope: s, me: ME, comments: thread.slice(0, 3) }).in, true, "the user is tagged in the window");
  assert.equal(scopeOfThread({ scope: s, me: ME, comments: [c("@tony ok")] }).in, true);
});

test("config: [scope] validates and unknown keys fail", async () => {
  const cfg = await ternConfig("/tmp/tern", (t) => `${t}\n[scope]\nexclude = ["*Funnel*"]\nothers = ["Arlo"]\n`);
  assert.deepEqual(cfg.scope, { include: [], exclude: ["*Funnel*"], others: ["Arlo"], assign: {}, tracker: "", unknown: "mine" });
  assert.equal((await ternConfig()).scope.unknown, "mine");
  const t = await ternConfig("/tmp/tern", (t) => `${t}\n[scope]\nunknown = "ask"\ntracker = "https://notion.so/x"\n[scope.assign]\n"Booking*" = "Galina"\n`);
  assert.deepEqual([t.scope.unknown, t.scope.assign["Booking*"]], ["ask", "Galina"]);
  await assert.rejects(ternConfig("/tmp/tern", (t) => `${t}\n[scope]\nunknown = "maybe"\n`), /scope\.unknown/);
  await assert.rejects(ternConfig("/tmp/tern", (t) => `${t}\n[scope]\nexcludes = []\n`), /scope\.excludes: unknown setting/);
  await assert.rejects(ternConfig("/tmp/tern", (t) => `${t}\n[scope]\nexclude = [" "]\n`), /empty pattern/);
});

async function backfilled(patch) {
  const db = openDb(":memory:");
  const config = await ternConfig("/tmp/tern", patch);
  const state = figmaState();
  const clock = clockAt("2026-10-02T16:00:00Z");
  await reconcileProject({ db, config, client: fakeClient(state), clock });
  clock.advance(30);
  await reconcileProject({ db, config, client: fakeClient(state), clock, backfill: true });
  return { db, config, clock };
}

test("end to end: excluded sections are recorded out of scope and never batched", async () => {
  const { db, config } = await backfilled();
  const all = db.all("SELECT node_id, payload FROM events WHERE kind = 'ready'");
  assert.ok(all.length >= 2);
  const victim = JSON.parse(all[0].payload).name;
  const scoped = { ...config, scope: { ...config.scope, exclude: [victim] } };
  const changed = applyScope({ db, config: scoped });
  assert.ok(changed.some((x) => x.name === victim && x.status === "out_of_scope"));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE status = 'out_of_scope'").n, changed.length);
  const plan = planBatch({ db, config: scoped, now: true });
  assert.ok(plan.triggers.every((e) => JSON.parse(e.payload).name !== victim));
  if (plan.go) {
    const b = createBatch({ db, config: scoped, plan });
    assert.equal(db.get("SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND title = ?", b.id, victim).n, 0);
  }
  const sum = scopeSummary(db, config.project.slug);
  assert.equal(sum.n, changed.length);
  assert.match(scopeLine(sum), new RegExp(`^${changed.length} out of scope \\(latest: .+, matches exclude`));
});

test("loosening the rules brings out-of-scope events back; planBatch applies the rules itself", async () => {
  const { db, config } = await backfilled();
  const tight = { ...config, scope: { ...config.scope, exclude: ["*"] } };
  planBatch({ db, config: tight });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE role = 'trigger' AND kind = 'ready' AND status = 'pending'").n, 0);
  assert.ok(scopeSummary(db, config.project.slug).n > 0);
  const back = applyScope({ db, config });
  assert.ok(back.length > 0 && back.every((x) => x.status === "pending"));
  assert.equal(scopeSummary(db, config.project.slug).n, 0);
});

test("manual adds ignore scope", async () => {
  const { db, config } = await backfilled();
  const { addManual } = await import("../../figpipe/lib/reconcile.mjs");
  const node = db.get("SELECT node_id FROM nodes WHERE status = 'READY_FOR_DEV'").node_id;
  addManual({ db, project: config.project.slug, fileKey: config.figma.files[0].key, nodeId: node, note: "mine" });
  const tight = { ...config, scope: { ...config.scope, exclude: ["*"] } };
  applyScope({ db, config: tight });
  assert.equal(db.get("SELECT status FROM events WHERE kind = 'manual'").status, "pending");
});

test("unknown = ask holds new sections as questions with the command to answer; answers settle them for good", async () => {
  const { db, config } = await backfilled();
  const ask = { ...config, scope: { ...config.scope, include: [], unknown: "ask" } };
  const changed = applyScope({ db, config: ask });
  const held = changed.filter((x) => x.status === "needs_owner");
  assert.ok(held.length >= 2);
  const heldKeys = new Set(held.map((x) => x.key));
  assert.ok(planBatch({ db, config: ask, now: true }).triggers.every((e) => !heldKeys.has(e.key)), "sections with an unknown owner are not built");
  const sum = scopeSummary(db, config.project.slug);
  assert.equal(sum.ask.length, held.length);
  assert.match(askLines(sum)[0], /^Is this yours\? .+\. Answer: figpipe own ".+" mine\|others$/);
  // Answer two: one mine, one others.
  recordOwnership({ db, project: config.project.slug, name: held[0].name, owner: "mine" });
  recordOwnership({ db, project: config.project.slug, name: held[1].name, owner: "others", who: ["Arlo"] });
  applyScope({ db, config: ask });
  assert.equal(db.get("SELECT status FROM events WHERE key = ?", held[0].key).status, "pending");
  const second = db.get("SELECT status, note FROM events WHERE key = ?", held[1].key);
  assert.equal(second.status, "out_of_scope");
  assert.match(second.note, /you answered others \(Arlo\)/);
  // The same section in another language takes the answer too ("Main_GER" follows "Main_EN"), so
  // it is not asked about either.
  const kin = held.slice(2).filter((h) => sameBase(h.name, held[0].name) || sameBase(h.name, held[1].name));
  assert.deepEqual(kin.map((h) => h.name), ["Main_GER"]);
  const third = db.get("SELECT status, note FROM events WHERE key = ?", kin[0].key);
  assert.equal(third.status, "out_of_scope");
  assert.match(third.note, /you answered others for "Main_EN", the same section/);
  assert.equal(scopeSummary(db, config.project.slug).ask.length, held.length - 2 - kin.length);
  // Asked once: re-judging changes nothing.
  assert.deepEqual(applyScope({ db, config: ask }), []);
  assert.equal(scopeSummary(db, config.project.slug).n, 1 + kin.length + changed.filter((x) => x.status === "out_of_scope").length);
});

test("ownershipTable lists every ready section with owner, why and drift", async () => {
  const { db, config } = await backfilled();
  const rows = ownershipTable({ db, config: { ...config, scope: { ...config.scope, exclude: [] } } });
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => ["mine", "others", "unknown"].includes(r.owner) && r.why));
});
