// Sections that move. The designer moves an in-progress section to the ready page under a new node
// id and a suffixed name ("About" becomes "About_EN", with "About_GER" beside it). figpipe follows
// it: the watch, its baseline and what waits for it move to the new node, the config entry is
// re-pointed, and nobody is asked "Is this yours?". Recorded Tern fixtures, then simulated moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tempHome, ternConfig, figmaState, fakeClient, fakeFetch, clockAt, load, pageDoc, findIn, FIX, LIVE, PAGE } from "./helpers.mjs";

tempHome();
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject } = await import("../../figpipe/lib/reconcile.mjs");
const { applyScope, scopeSummary, askLines, ownerOf, ownedSections, recordOwnership } = await import("../../figpipe/lib/scope.mjs");
const { planBatch, createBatch } = await import("../../figpipe/lib/batcher.mjs");
const { extractBatch } = await import("../../figpipe/lib/extract.mjs");
const { watchView, watchLine, watchesOf, buildSnapshot, portableFingerprint, designFingerprint, similarity, seedWatch } = await import("../../figpipe/lib/watch.mjs");
const { parseConfig, rewriteWatchNode } = await import("../../figpipe/lib/config.mjs");
const { nameParts, sameBase, sameSection } = await import("../../figpipe/lib/names.mjs");

const ABOUT = "7431:81091";
const TECH = "7431:81073";
const WATCH = `
[[figma.files.watch]]
node = "7431:81091"
name = "About"
branch = "feat/plans-r2"
route = "/en-gb/preview/about"
page = "Design In Progress"

# Frames empty so far.
[[figma.files.watch]]
node = "7431-81073"
name = "Technology"
branch = "feat/plans-r2"
page = "Design In Progress"
built = false
`;
const withWatch = (t) => t.replace('canonical_copy = "desktop"\n', `canonical_copy = "desktop"\n${WATCH}`);

const walk = (n, f) => {
  f(n);
  for (const c of n.children ?? []) walk(c, f);
};
const doc = (state, id) => state.nodes[id].nodes[id].document;
const texts = (n) => {
  const out = [];
  walk(n, (x) => x.type === "TEXT" && out.push(x));
  return out;
};
// The same design under new node ids, as a cut and paste or a copy to another page gives it.
const copyOf = (d, name, shift = 900000) => {
  const c = structuredClone(d);
  walk(c, (n) => (n.id = n.id.replace(/(\d+):(\d+)/g, (m, a, b) => `${shift + Number(a)}:${b}`)));
  c.name = name;
  return c;
};
// Put a section on the ready page, marked ready for dev: the page read sees it two levels deep.
const handOff = (state, d) => {
  d.devStatus = { type: "READY_FOR_DEV", description: "" };
  state.nodes[d.id] = { nodes: { [d.id]: { document: d } } };
  pageDoc(state).children.push({ id: d.id, name: d.name, type: d.type, devStatus: d.devStatus, absoluteBoundingBox: d.absoluteBoundingBox, children: (d.children ?? []).map((c) => ({ id: c.id, name: c.name, type: c.type })) });
  return d.id;
};
const events = (db, where = "status = 'pending'") => db.all(`SELECT * FROM events WHERE role = 'trigger' AND ${where} ORDER BY id`).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));

async function setup({ ask = false, file = false } = {}) {
  const db = openDb(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "tern-repo-"));
  let config = await ternConfig(repo, withWatch);
  if (file) {
    // A config on disk, the way a real project has one.
    const path = join(mkdtempSync(join(tmpdir(), "figpipe-cfg-")), "tern.toml");
    writeFileSync(path, withWatch(readFileSync(join(FIX, "tern.toml"), "utf8").replace("__REPO__", repo)));
    config = parseConfig(readFileSync(path, "utf8"), path);
  }
  if (ask) config.scope.unknown = "ask";
  const state = figmaState();
  const w = load("nodes-watch.json");
  state.nodes[ABOUT] = { nodes: { [ABOUT]: w.nodes[ABOUT] } };
  state.nodes[TECH] = { nodes: { [TECH]: w.nodes[TECH] } };
  const clock = clockAt("2026-10-06T14:00:00Z");
  const tick = (opts = {}) => reconcileProject({ db, config, client: fakeClient(state), clock, fetchImpl: fakeFetch, sleep: async () => {}, ...opts });
  const touch = (min = 5) => {
    clock.advance(min);
    state.meta.file.last_touched_at = new Date(clock() - 60000).toISOString();
  };
  await tick(); // baselines for About and Technology, and the ready page as it is
  const batch = async () => {
    const b = createBatch({ db, config, plan: planBatch({ db, config, clock, now: true }), clock });
    const ex = await extractBatch({ db, config, client: fakeClient(state), batchId: b.id, clock, fetchImpl: fakeFetch, sleep: async () => {} });
    return { id: b.id, ex, items: db.all("SELECT * FROM items WHERE batch_id = ? ORDER BY id", b.id) };
  };
  return { db, config, state, clock, tick, touch, repo, batch };
}

test("names: language tags, case and separators are set aside; a word that only looks like a tag is kept", () => {
  assert.deepEqual(nameParts("Location_EN"), { base: "location", lang: "en", bare: "Location" });
  assert.deepEqual(nameParts("What we check_EN"), { base: "what we check", lang: "en", bare: "What we check" });
  assert.deepEqual(nameParts("Solar-1_GER"), { base: "solar 1", lang: "de", bare: "Solar-1" });
  for (const n of ["Stories_DE", "stories-DE", "Stories (de)", "STORIES / GER", "Stories DE", "stories_deutsch"]) assert.deepEqual([nameParts(n).base, nameParts(n).lang], ["stories", "de"], n);
  assert.equal(nameParts("Über uns_FR").base, "uber uns");
  assert.equal(nameParts("Main_Assets_FR").base, "main assets");
  for (const n of ["Check it", "Sign-in", "Contact us", "Offer Funnel", "Stories regular section", "EN"]) assert.equal(nameParts(n).lang, null, n);
  assert.ok(sameBase("Location", "location_ger") && sameBase("What-we-check", "What we check_EN"));
  assert.ok(!sameBase("Location", "Locations_EN"));
  assert.ok(sameSection("Location", "Location_EN") && sameSection("Location_EN", "LOCATION EN"));
  assert.ok(!sameSection("Location_EN", "Location_GER"), "another language is another item");
  assert.ok(!sameSection("", "_EN"));
});

test("a moved copy is the same design: ids, ready marks, the name and the position are set aside", async () => {
  const about = load("nodes-watch.json").nodes[ABOUT].document;
  const moved = copyOf(about, "About_EN");
  moved.devStatus = { type: "READY_FOR_DEV" };
  walk(moved, (n) => {
    if (n.absoluteBoundingBox) n.absoluteBoundingBox = { ...n.absoluteBoundingBox, x: n.absoluteBoundingBox.x + 5000, y: n.absoluteBoundingBox.y - 300 };
    if (n.absoluteRenderBounds) n.absoluteRenderBounds = { ...n.absoluteRenderBounds, x: n.absoluteRenderBounds.x + 5000, y: n.absoluteRenderBounds.y - 300, width: n.absoluteRenderBounds.width + 0.004 };
  });
  assert.notEqual(designFingerprint(moved), designFingerprint(about), "every id differs");
  assert.equal(portableFingerprint(moved), portableFingerprint(about));
  assert.equal(similarity(about, moved), 1);
  const edited = structuredClone(moved);
  texts(edited)[0].characters = "A new headline";
  assert.notEqual(portableFingerprint(edited), portableFingerprint(about));
  assert.ok(similarity(about, edited) > 0.9, "an edited copy is still clearly the section");
  assert.ok(similarity(about, load("nodes-small.json").nodes["40000210:73780"].document) < 0.3, "another section is not");
});

test("a watched section that moves to the ready page under a new id and name is followed: baseline kept, nobody asked", async () => {
  const { db, config, state, tick, touch, batch } = await setup({ ask: true });
  const baseline = db.get("SELECT baseline_id, baseline_at FROM watches WHERE node_id = ?", ABOUT);
  // Zoë moves About to the ready page as "About_EN": new ids, same design.
  touch();
  const to = handOff(state, copyOf(doc(state, ABOUT), "About_EN"));
  delete state.nodes[ABOUT];
  const s = await tick();
  assert.deepEqual(s.moved.map((m) => [m.name, m.from, m.to, m.to_name, m.page, m.changed]), [["About", ABOUT, to, "About_EN", "Development Ready (Latest)", false]]);
  assert.deepEqual(s.warnings.filter((w) => /About/.test(w)), [], "not reported as gone");
  // The watch points at the new node, in the config and in state, with the baseline it had.
  const about = watchesOf(config).find((w) => w.name === "About");
  assert.deepEqual([about.node, about.page], [to, "Development Ready (Latest)"]);
  const row = db.get("SELECT * FROM watches WHERE name = 'About'");
  assert.deepEqual([row.node_id, row.figma_name, row.status, row.moved_from, row.baseline_id, row.page_name], [to, "About_EN", "ready", ABOUT, baseline.baseline_id, "Development Ready (Latest)"]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM watches").n, 2);
  assert.equal(buildSnapshot(db, "tern", LIVE, to).batch_id, baseline.baseline_id, "the next change is a diff against the pre-built design");
  // The ready mark is a pre-built handoff, and yours: no question.
  applyScope({ db, config });
  const ready = events(db).filter((e) => e.node_id === to);
  assert.deepEqual(ready.map((e) => [e.kind, e.payload.watch, e.payload.prebuilt]), [["ready", to, true]]);
  assert.deepEqual(askLines(scopeSummary(db, "tern")).filter((l) => /About/.test(l)), []);
  // Status says so.
  const line = watchLine(watchView(db, config)[0]);
  assert.match(line, /^About \(\/en-gb\/preview\/about from feat\/plans-r2\): now "About_EN" on "Development Ready \(Latest\)" \(moved in Figma, followed .+; the baseline is kept\); marked ready for dev/);
  // Same design as the build: the batch closes it before any AI runs.
  const b = await batch();
  const it = b.items.find((i) => i.node_id === to);
  assert.equal(it.outcome, "already_done");
  assert.match(it.verdict, /No design change since the design your pre-built page was made from/);
  assert.equal(JSON.parse(it.watch).lane, "about", "the lane and branch stay the watch's");
  // The next checks leave it alone: one move, followed once.
  touch();
  const again = await tick();
  assert.deepEqual(again.moved, []);
});

test("moved and changed: what waited follows the section, and the change is diffed against the kept baseline", async () => {
  const { db, config, state, tick, touch, batch } = await setup({ ask: true });
  // A change on the in-progress section waits; then the section moves with one more edit.
  touch();
  texts(doc(state, ABOUT))[0].characters = "First edit";
  await tick();
  assert.deepEqual(events(db).map((e) => [e.kind, e.node_id]), [["changed", ABOUT]]);
  touch();
  const moved = copyOf(doc(state, ABOUT), "About_EN");
  texts(moved)[1].characters = "Second edit, made on the ready page";
  const to = handOff(state, moved);
  delete state.nodes[ABOUT];
  const s = await tick();
  assert.equal(s.moved[0].changed, true);
  applyScope({ db, config });
  const waiting = events(db);
  assert.deepEqual(waiting.map((e) => e.node_id), [to, to, to], "the earlier change, the ready mark and the new change all wait on the new node");
  assert.deepEqual(waiting.map((e) => e.kind).sort(), ["changed", "changed", "ready"]);
  assert.ok(waiting.every((e) => e.payload.watch === to));
  assert.match(waiting.at(-1).payload.why, /moved in Figma, and the design differs/);
  const b = await batch();
  assert.equal(b.items.length, 1, "one item for the section");
  const rec = b.ex.items[b.items[0].id];
  assert.equal(b.items[0].outcome, "pending");
  assert.match(rec.sdiff.since_batch, /^baseline-/);
  const diff = readFileSync(rec.copy_diff.path, "utf8");
  assert.match(diff, /\+.*First edit/);
  assert.match(diff, /\+.*Second edit, made on the ready page/);
  assert.ok(rec.copy_diff.changed_lines >= 4 && rec.copy_diff.changed_lines < 20, "a diff of the two edits, not a rebuild of the page");
  assert.ok(rec.baseline.renders.length, "the Figma before is the baseline's render");
});

test("a ready copy beside the in-progress original is followed too", async () => {
  const { db, config, state, tick, touch } = await setup();
  touch();
  const to = handOff(state, copyOf(doc(state, ABOUT), "ABOUT - EN"));
  const s = await tick();
  assert.equal(s.moved[0].to, to, "the ready page is where the handoff lives");
  assert.equal(watchesOf(config)[0].node, to);
  assert.ok(state.nodes[ABOUT], "the original is still in Figma");
  // A section already on the ready page is not moved again by a variant that shows up later.
  touch();
  const ger = handOff(state, copyOf(doc(state, to), "About_GER", 1800000));
  const next = await tick();
  assert.deepEqual(next.moved, []);
  assert.equal(watchesOf(config)[0].node, to);
  assert.equal(events(db).find((e) => e.node_id === ger).payload.watch, undefined, "the variant is its own item");
});

test("language variants: the watch follows the one that matches its build; the other is a separate item and yours", async () => {
  const { db, config, state, tick, touch, batch } = await setup({ ask: true });
  touch();
  const german = copyOf(doc(state, ABOUT), "About_GER", 1800000);
  for (const t of texts(german)) t.characters = `DE ${t.characters}`;
  const ger = handOff(state, german);
  const en = handOff(state, copyOf(doc(state, ABOUT), "About_EN"));
  delete state.nodes[ABOUT];
  const s = await tick();
  assert.deepEqual(s.moved.map((m) => m.to), [en], "the copy with the same text as the baseline");
  const changed = applyScope({ db, config });
  assert.deepEqual(changed.filter((c) => /About/.test(c.name)), [], "neither is asked about");
  const g = events(db).find((e) => e.node_id === ger);
  assert.deepEqual([g.status, g.payload.watch, g.payload.prebuilt], ["pending", undefined, undefined]);
  const why = ownerOf({ scope: config.scope, me: config.figma.me, name: "About_GER", watched: ["About", "Technology"] });
  assert.deepEqual([why.owner, why.why], ["mine", 'the same section as "About", which you pre-built']);
  const b = await batch();
  const items = b.items.filter((i) => [en, ger].includes(i.node_id));
  assert.deepEqual(items.map((i) => [i.title, i.outcome, !!i.watch]).sort(), [["About_EN", "already_done", true], ["About_GER", "pending", false]]);
  // The English section is deleted later: the German one is its sibling, not where it went.
  touch();
  delete state.nodes[en];
  pageDoc(state).children = pageDoc(state).children.filter((c) => c.id !== en);
  const later = await tick();
  assert.deepEqual(later.moved, []);
  assert.equal(watchesOf(config)[0].node, en);
  assert.ok(later.warnings.some((w) => /"About": node 907431:81091 is gone/.test(w)), later.warnings.join("\n"));
});

test("an answer or a rule for a section covers its language variants; an explicit answer for one wins", () => {
  const me = { handle: "tony", names: ["Tony"] };
  const scope = { include: ["Contact"], exclude: ["Checkout"], others: [], assign: {}, unknown: "ask" };
  const own = (name, answers = []) => ownerOf({ scope, me, name, answers });
  assert.deepEqual([own("Contact_EN").owner, own("Contact_EN").why], ["mine", 'matches include "Contact"']);
  assert.equal(own("Checkout_GER").owner, "others");
  assert.equal(own("Contacts_EN").owner, "unknown");
  const answers = [{ name: "Main_EN", name_key: "main_en", owner: "mine", who: [], answered_at: "2026-10-06T16:22:40Z" }];
  assert.deepEqual([own("Main_FR", answers).owner, own("Main_FR", answers).why], ["mine", 'you answered mine for "Main_EN", the same section']);
  answers.push({ name: "Main_FR", name_key: "main_fr", owner: "others", who: ["Arlo"], answered_at: "2026-10-07T10:00:00Z" });
  assert.equal(own("Main_FR", answers).why, "you answered others (Arlo)");
  assert.equal(own("Main_EN", answers).owner, "mine");
});

test("only a section nothing matches is reported gone, and only then is a new section asked about", async () => {
  const { db, config, state, tick, touch } = await setup({ ask: true });
  touch();
  // About is deleted; an unrelated section becomes ready.
  const other = copyOf(load("nodes-small.json").nodes["40000210:73780"].document, "Pricing_EN");
  const id = handOff(state, other);
  delete state.nodes[ABOUT];
  const s = await tick();
  assert.deepEqual(s.moved, []);
  assert.ok(s.warnings.some((w) => /"About": node 7431:81091 is gone and no section named "About" was found/.test(w)), s.warnings.join("\n"));
  assert.equal(watchesOf(config)[0].node, ABOUT);
  applyScope({ db, config });
  assert.deepEqual(askLines(scopeSummary(db, "tern")).filter((l) => /Pricing/.test(l)), ['Is this yours? Pricing_EN: no rule, assignment or comment says who builds it. Answer: figpipe own "Pricing_EN" mine|others']);
  assert.equal(events(db, "status = 'needs_owner'").find((e) => e.node_id === id).payload.watch, undefined);
  // A section that stays gone costs no extra full-depth reads on later checks.
  touch();
  const before = state.calls.length;
  await tick();
  assert.deepEqual(state.calls.slice(before).filter((c) => c.includes(id)), [], "the unrelated section is not read again");
});

test("renamed as well as moved: the structure alone identifies it, when one new ready section is clearly it", async () => {
  const { db, config, state, tick, touch } = await setup({ ask: true });
  touch();
  const moved = copyOf(doc(state, ABOUT), "Wer wir sind");
  texts(moved)[0].characters = "Edited on the way";
  const to = handOff(state, moved);
  handOff(state, copyOf(load("nodes-small.json").nodes["40000210:73780"].document, "Pricing_EN", 1800000));
  delete state.nodes[ABOUT];
  const s = await tick();
  assert.deepEqual(s.moved.map((m) => [m.name, m.to, m.changed]), [["About", to, true]]);
  assert.ok(s.moved[0].similarity > 0.9);
  assert.equal(db.get("SELECT figma_name FROM watches WHERE name = 'About'").figma_name, "Wer wir sind");
});

test("the config file is re-pointed in place: only that entry's node and page change, with a note; a dry run changes nothing", async () => {
  const { config, state, tick, touch, db } = await setup({ file: true });
  const before = readFileSync(config._file, "utf8");
  touch();
  const to = handOff(state, copyOf(doc(state, ABOUT), "About_EN"));
  delete state.nodes[ABOUT];
  // A dry run (seed = false, inside a transaction the tick rolls back) says what it would do.
  db.exec("BEGIN");
  const dry = await tick({ seed: false });
  db.exec("ROLLBACK");
  assert.equal(dry.moved[0].to, to);
  assert.equal(readFileSync(config._file, "utf8"), before, "a dry run leaves the config alone");
  assert.equal(db.get("SELECT node_id FROM watches WHERE name = 'About'").node_id, ABOUT, "and the state");
  // The real check re-points it.
  const real = parseConfig(before, config._file);
  await reconcileProject({ db, config: real, client: fakeClient(state), clock: clockAt("2026-10-06T15:00:00Z"), fetchImpl: fakeFetch, sleep: async () => {} });
  const after = readFileSync(config._file, "utf8");
  const expected = before
    .replace('node = "7431:81091"', `# figpipe 2026-10-06: "About" moved in Figma, from 7431:81091 to "About_EN" on "Development Ready (Latest)". The baseline is kept.\nnode = "${to}"`)
    .replace('route = "/en-gb/preview/about"\npage = "Design In Progress"', 'route = "/en-gb/preview/about"\npage = "Development Ready (Latest)"');
  assert.equal(after, expected, "comments, order and the other watch are untouched");
  const reloaded = parseConfig(after, config._file);
  assert.deepEqual(reloaded.figma.files[0].watch.map((w) => [w.name, w.node, w.page]), [["About", to, "Development Ready (Latest)"], ["Technology", TECH, "Design In Progress"]]);
  assert.equal(rewriteWatchNode(config._file, "1:2", "3:4"), false, "an entry that is not there is not invented");
  // The next check, from the file as it is now, has nothing left to follow.
  const next = await reconcileProject({ db, config: reloaded, client: fakeClient(state), clock: clockAt("2026-10-06T16:30:00Z"), fetchImpl: fakeFetch, sleep: async () => {} });
  assert.deepEqual([next.moved, next.warnings.filter((w) => /About/.test(w))], [[], []]);
});

test("a built section of yours that comes back under a new id keeps its build history: unchanged, it is not built again", async () => {
  const { db, config, state, clock, tick, touch, batch } = await setup();
  // Main_EN is ready on the ready page; record it as built from the design as it is.
  const MAIN = "3618:25678";
  const main = { ...structuredClone(findIn(pageDoc(state), MAIN)) };
  state.nodes[MAIN] = { nodes: { [MAIN]: { document: main } } };
  recordOwnership({ db, project: "tern", name: "Main_EN", nodeId: MAIN, fileKey: LIVE, owner: "mine" });
  await seedWatch({ db, config, client: fakeClient(state), fileKey: LIVE, watch: { node: MAIN, name: "Main_EN", file_key: LIVE, branch: "main", built: true }, resp: state.nodes[MAIN], clock, fetchImpl: fakeFetch, sleep: async () => {}, owned: true });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM watches").n, 2, "an owned section is not a watch");
  // The designer cuts and pastes it: the same section under a new id, same name.
  touch();
  const page = pageDoc(state);
  const moved = copyOf(main, "Main_EN");
  page.children.splice(page.children.findIndex((c) => c.id === MAIN), 1, { ...moved, children: (moved.children ?? []).map((c) => ({ ...c, children: undefined })) });
  state.nodes[moved.id] = { nodes: { [moved.id]: { document: moved } } };
  delete state.nodes[MAIN];
  const s = await tick();
  const ready = events(db).filter((e) => e.node_id === moved.id);
  assert.deepEqual(ready.map((e) => [e.kind, e.payload.moved_from]), [["ready", MAIN]]);
  assert.match(buildSnapshot(db, "tern", LIVE, moved.id).batch_id, /^baseline-/, "the build history moved with it");
  assert.equal(db.get("SELECT node_id FROM ownership WHERE name_key = 'main_en'").node_id, moved.id);
  const b = await batch();
  const it = b.items.find((i) => i.node_id === moved.id);
  assert.equal(it.outcome, "already_done");
  assert.match(it.verdict, /No design change since the design your build was made from/);
  assert.equal(s.moved.length, 0, "no watch was involved");
});

test("baseline for every section that is yours: watched ones and ready ones, and what waited for them is settled", async () => {
  const { db, config, state, clock, tick, touch } = await setup({ ask: true });
  config.scope.include = ["Main*"];
  touch();
  const en = handOff(state, copyOf(doc(state, ABOUT), "About_EN"));
  delete state.nodes[ABOUT];
  texts(doc(state, TECH)).length || doc(state, TECH).children[0].children?.push({ id: "7431:99999", name: "Headline", type: "TEXT", characters: "Technology", style: {}, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } });
  await tick({ backfill: true });
  applyScope({ db, config });
  const owned = ownedSections({ db, config });
  assert.deepEqual(owned.map((o) => o.name), ["How it works", "Main_EN", "Main_GER"], "ready, yours by rule (a section inside Main_EN too), and not a watch");
  const waitingFor = (id) => events(db).filter((e) => e.node_id === id).map((e) => e.kind);
  assert.deepEqual(waitingFor(en), ["ready"]);
  assert.deepEqual(waitingFor("3618:25678"), ["ready"]);
  // What `figpipe watch baseline <slug> --all` does: every watched section, then every owned one.
  const seed = (watch, extra = {}) => seedWatch({ db, config, client: fakeClient(state), fileKey: LIVE, watch, resp: state.nodes[watch.node], clock, fetchImpl: fakeFetch, sleep: async () => {}, ...extra });
  for (const w of watchesOf(config)) await seed(w);
  for (const o of owned) {
    state.nodes[o.node_id] = { nodes: { [o.node_id]: { document: structuredClone(findIn(pageDoc(state), o.node_id)) } } };
    const r = await seed({ node: o.node_id, name: o.name, file_key: LIVE, branch: config.git.base_branch, built: true }, { owned: true });
    assert.equal(r.settled, 1);
  }
  assert.deepEqual(events(db).filter((e) => [en, TECH, "3618:25678", "3619:46598"].includes(e.node_id)), [], "nothing waits for a section whose build is up to date");
  assert.match(db.get("SELECT note FROM events WHERE node_id = ? AND kind = 'ready'", "3618:25678").note, /a baseline was recorded: the build already has this design/);
  // They count as built from this design: a later check raises nothing until the design changes.
  touch();
  const quiet = await tick();
  assert.deepEqual(quiet.events, []);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM ledger WHERE key = ? AND outcome = 'already_done'", `node:${LIVE}:3618:25678`).n, 1);
});
