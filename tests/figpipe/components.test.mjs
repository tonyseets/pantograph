// Component sets behind a frame: which sets it uses, the states it does not show, the elements
// that have no component, the cache, and how figpipe passes all of it to a batch and its report.
// Runs on a recorded Contact page whose form shows every control at rest only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tempHome, ternConfig, figmaState, fakeClient, fakeFetch, clockAt, gitRepo, componentsState, componentsClient, LIVE, CONTACT, SETS, PNG } from "./helpers.mjs";

const home = tempHome();
const { kindOf, variantProps, componentUsage, plainElements, setDigest, setUsage, componentStore, collectComponents, componentsTable, interactionsOf } = await import("../../skills/figma-transpose/scripts/figma-components.mjs");
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject, addManual } = await import("../../figpipe/lib/reconcile.mjs");
const { planBatch, createBatch } = await import("../../figpipe/lib/batcher.mjs");
const { extractBatch, componentCacheDir } = await import("../../figpipe/lib/extract.mjs");
const { buildManifest } = await import("../../figpipe/lib/run.mjs");
const { recordResult, resultFromDb, stateQuestions } = await import("../../figpipe/lib/record.mjs");
const { componentsLine, renderBatch, reportData, batchLine } = await import("../../figpipe/lib/report.mjs");
const { statePaths, stateActions } = await import("../../figpipe/lib/capture.mjs");

const tmp = (name) => mkdtempSync(join(tmpdir(), `figpipe-${name}-`));
const noSleep = async () => {};
const fx = componentsState();
const frame = fx.contact.nodes[CONTACT];
const storeFor = (state, cacheDir, more = {}) => componentStore({ client: componentsClient(state), cacheDir, fetchImpl: fakeFetch, sleep: noSleep, ...more });
const collect = (state, store, outDir, more = {}) => collectComponents({ store, fileKey: LIVE, resp: state.contact, nodeId: CONTACT, outDir, ...more });
const byName = (index, name) => index.sets.filter((s) => s.name === name);

test("names give away what a layer is, and variant names their properties", () => {
  const kinds = { "Input field": "input", "Input dropdown": "dropdown", "Dropdown list item": "option", "Radio button card": "radio", "Nav Link": "link", "btn-primary": "button", searchBar: "input", "mobile_Nav menu item": "option", Toggle: "toggle", Tabs: "tab" };
  for (const [name, kind] of Object.entries(kinds)) assert.equal(kindOf(name)?.kind, kind, name);
  for (const name of ["Footer_links_column", "Logo", "check", "Card", "Stack"]) assert.equal(kindOf(name), null, name);
  assert.deepEqual(variantProps("Checked=False, State=Default, Size=sm"), { Checked: "False", State: "Default", Size: "sm" });
  assert.deepEqual(variantProps("Label=Yes, please, State=Hover"), { Label: "Yes, please", State: "Hover" });
  assert.deepEqual(variantProps("Plus"), {});
});

test("the frame's instances resolve to their sets and the variants shown", () => {
  const usage = componentUsage(frame.document, frame);
  assert.equal(usage.length, 9);
  const checkbox = usage.find((s) => s.id === SETS.checkbox);
  assert.equal(checkbox.name, "Checkbox");
  assert.deepEqual(checkbox.variants.map((v) => [v.name, v.count]), [["Checked=False, State=Default, Size=sm", 2]], "only the unchecked resting checkbox is on the page");
  const field = usage.find((s) => s.id === SETS.field);
  assert.deepEqual(field.variants.map((v) => [v.name, v.count]), [["State=Default, Filled=OFF, Destructive=False", 5]]);
  // Instances inside other instances count, hidden ones are kept apart.
  assert.equal(usage.find((s) => s.name === "Nav Link").visible, 8);
  const button = usage.find((s) => s.name === "Button");
  assert.ok(button.hidden > 0 && button.variants.some((v) => v.count === 0 && v.hidden > 0), "a button hidden inside each field is not on the page");
});

test("interactive elements with no component are found, and nothing inside a set's own layers", () => {
  const plain = plainElements(frame.document, frame);
  const prefix = plain.find((e) => e.kind === "dropdown");
  assert.equal(prefix.element, "Leading dropdown");
  assert.equal(prefix.where, "Input field");
  assert.match(prefix.why, /plain layers inside "Input field"/);
  assert.deepEqual(prefix.states, ["hover", "focus", "open", "disabled"]);
  const links = plain.filter((e) => e.kind === "link");
  assert.deepEqual(links.map((l) => `${l.element} in ${l.where}`).sort(), ['Text link "Privacy Policy" in Checkbox', 'Text link "Privacy Policy" in Footer', 'Text link "Terms & Conditions" in Footer', 'Text link "Terms of Service" in Checkbox']);
  assert.equal(plain.length, 5, "the frame named Checkbox inside the Checkbox instance is the set's own layer, not a finding");
});

test("a set's digest holds every variant, what each state changes and which states have no variant", () => {
  const checkbox = setDigest(fx.sets.nodes[SETS.checkbox].document, fx.sets.nodes[SETS.checkbox]);
  assert.deepEqual(checkbox.axes.map((a) => [a.name, a.values, a.state]), [["Checked", ["False", "True"], true], ["State", ["Disabled", "Default", "Hovered", "Focused"], true], ["Size", ["lg", "sm", "md"], false]]);
  assert.equal(checkbox.variants.length, 24);
  assert.deepEqual(checkbox.states_not_designed, []);
  // The checked state is a tick inside the box: the detail a build invents wrongly without the set.
  const checked = checkbox.variants.find((v) => v.name === "Checked=True, State=Default, Size=sm");
  assert.equal(checked.from, "Checked=False, State=Default, Size=sm");
  assert.ok(checked.changes.some((l) => /^\+INST "check"/.test(l)), "checked adds the tick icon");
  assert.ok(!checked.changes.some((l) => l.includes("(variant)")), "the variant's own name is not a change");
  assert.ok(checked.box.w > 0 && checked.box.x >= 0, "each variant says where it sits in the set render");

  const use = setUsage(checkbox, componentUsage(frame.document, frame).find((s) => s.id === SETS.checkbox).variants);
  assert.deepEqual(use.not_on_the_page, { Checked: ["True"], State: ["Disabled", "Hovered", "Focused"] });
  assert.deepEqual(use.other_axes, { Size: ["lg", "md"] });
  assert.equal(use.to_build.length, 7, "every other state at the size the page uses");
  assert.ok(use.to_build.every((n) => n.endsWith("Size=sm")));
  assert.equal(use.other_variants, 16);

  const field = setDigest(fx.sets.nodes[SETS.field].document, fx.sets.nodes[SETS.field]);
  assert.deepEqual(field.states_designed, ["hover", "focus", "filled", "error", "disabled"], "Active is a field's focus, Destructive its error");
  const dropdown = setDigest(fx.sets.nodes[SETS.dropdown].document, fx.sets.nodes[SETS.dropdown]);
  assert.deepEqual(dropdown.states_not_designed, ["hover"]);
  assert.ok(dropdown.variants.find((v) => v.name === "State=Open").sets.includes(SETS.listItem), "the open state shows list items");
  const item = setDigest(fx.sets.nodes[SETS.listItem].document, fx.sets.nodes[SETS.listItem]);
  assert.deepEqual(item.unnamed_values, ["State5"]);
});

test("collecting writes each set under components/, with a table of what is and is not on the page", async () => {
  const state = componentsState();
  const out = join(tmp("comp"), "components");
  const store = storeFor(state, tmp("cache"));
  const index = await collect(state, store, out);

  for (const dir of ["checkbox", "input-field"]) for (const f of ["set.json", "node.json", "render@3x.png"]) assert.ok(existsSync(join(out, dir, f)), `${dir}/${f}`);
  assert.deepEqual(readFileSync(join(out, "checkbox", "render@3x.png")), PNG);
  const set = JSON.parse(readFileSync(join(out, "checkbox", "set.json"), "utf8"));
  assert.equal(set.role, "used");
  assert.deepEqual(set.on_the_page, [{ id: "40000284:101354", name: "Checked=False, State=Default, Size=sm", count: 2 }]);
  assert.equal(set.to_build.length, 7);
  assert.equal(set.variants.length, 24);
  assert.equal(JSON.parse(readFileSync(join(out, "checkbox", "node.json"), "utf8")).nodes[SETS.checkbox].document.type, "COMPONENT_SET", "the verbatim node sits beside the digest");

  // The prefix dropdown has no component on the page; the file's own dropdown sets are found by name.
  const dropdown = byName(index, "Input dropdown").find((s) => s.id === SETS.dropdown);
  assert.equal(dropdown.role, "candidate");
  assert.deepEqual(dropdown.for, ["Leading dropdown"]);
  assert.deepEqual(dropdown.not_on_the_page, { State: ["Default", "Active", "Open", "Disabled"] });
  assert.equal(byName(index, "Dropdown list item")[0].role, "candidate");
  const prefix = index.no_component.find((e) => e.element === "Leading dropdown");
  assert.ok(prefix.candidates.some((c) => c.id === SETS.dropdown) && prefix.candidates.some((c) => c.id === SETS.listItem));
  assert.equal(index.catalogue.sets, 66);
  assert.deepEqual(index.catalogue.pages, ["❖ Components"]);

  // Sets the recording does not hold are listed with what the page shows of them, not dropped.
  const link = byName(index, "Link")[0];
  assert.match(link.unreadable, /no longer in the file/);
  assert.deepEqual(link.on_the_page.map((u) => u.name), ["State=Default, Size=md, Colour=Transparent Light"]);
  assert.deepEqual(link.axes.map((a) => a.name), ["State", "Size", "Colour"]);

  const table = readFileSync(join(out, "components.md"), "utf8");
  assert.match(table, /\| Checkbox \| Checked: False, True; State: Disabled, Default, Hovered, Focused; Size: lg, sm, md \| Checked=False, State=Default, Size=sm ×2 \| Checked: True; State: Disabled, Hovered, Focused<br>7 variants to build<br>other designs: Size: lg, md \| `checkbox\/set\.json`<br>`checkbox\/render@3x\.png` \|/);
  assert.match(table, /## No component: states not designed/);
  assert.match(table, /\| Leading dropdown \| Input field \|.*\| hover, focus, open, disabled \|.*Input dropdown/);
  assert.equal(table, componentsTable(JSON.parse(readFileSync(join(out, "index.json"), "utf8"))));
  assert.match(index.line, /^Input field, Checkbox, Dropdown list item: component in Figma; Input dropdown: component in Figma, no hover state; /);
  assert.match(index.line, /; Leading dropdown, 4 text links: no component in Figma$/);
});

test("node ids are batched per request, and a set is fetched once per file version", async () => {
  const state = componentsState();
  const cache = tmp("cache");
  const store = storeFor(state, cache);
  const index = await collect(state, store, join(tmp("comp"), "components"));
  const nodeCalls = state.calls.filter((c) => c.startsWith("nodes") && c.endsWith("depth=full"));
  const asked = nodeCalls.flatMap((c) => c.split(" ")[1].split(","));
  assert.ok(nodeCalls.length <= 2 && asked.length >= 12, `${asked.length} sets in ${nodeCalls.length} requests`);
  assert.equal(new Set(asked).size, asked.length, "no set is asked for twice");
  assert.ok(nodeCalls.every((c) => c.split(" ")[1].split(",").length <= 8));
  assert.ok(state.calls.filter((c) => c.startsWith("images")).every((c) => c.endsWith("scale=3") && c.split(" ")[1].split(",").length <= 6), "renders at 3x, a few per request");
  assert.equal(index.calls, state.calls.length);

  // A second item in the same run: nothing is read again.
  const before = state.calls.length;
  const again = await collect(state, store, join(tmp("comp"), "components"));
  assert.equal(state.calls.length, before);
  assert.equal(again.calls, 0);
  assert.equal(again.sets.length, index.sets.length);

  // A later run on the same file version: the readable sets come from disk. Only the ones Figma
  // could not find are asked for again.
  const next = componentsState();
  const store2 = storeFor(next, cache);
  const out2 = join(tmp("comp"), "components");
  await collect(next, store2, out2);
  assert.equal(store2.stats.cached, 4);
  assert.ok(next.calls.every((c) => !c.startsWith("images") && !c.startsWith("file")), "no renders, and the list of the file's sets is kept too");
  assert.ok(!next.calls.join(" ").includes(SETS.checkbox));
  assert.ok(existsSync(join(out2, "checkbox", "render@3x.png")));

  // The file moved on but the sets did not change: one read to check, the renders are kept.
  const moved = componentsState();
  moved.version = "9999";
  moved.contact.version = "9999";
  const store3 = storeFor(moved, cache);
  await collect(moved, store3, join(tmp("comp"), "components"));
  assert.ok(moved.calls.some((c) => c.startsWith("nodes") && c.includes(SETS.checkbox)));
  assert.equal(moved.calls.filter((c) => c.startsWith("images")).length, 0, "an unchanged set keeps its render");

  // The designer changed the checkbox: it is rendered again, alone.
  const edited = componentsState();
  edited.version = edited.contact.version = "10000";
  edited.sets.nodes[SETS.checkbox].document.children[0].cornerRadius = 12;
  const store4 = storeFor(edited, cache);
  await collect(edited, store4, join(tmp("comp"), "components"));
  assert.deepEqual(edited.calls.filter((c) => c.startsWith("images")), [`images ${SETS.checkbox} scale=3`]);
});

test("the cap keeps the sets with states and says what it left out", async () => {
  const state = componentsState();
  const index = await collect(state, storeFor(state, tmp("cache")), join(tmp("comp"), "components"), { maxSets: 6 });
  const read = index.sets.filter((s) => !/left out/.test(s.unreadable ?? ""));
  assert.equal(read.length, 6);
  assert.ok(read.some((s) => s.name === "Checkbox") && read.some((s) => s.name === "Input field"));
  assert.ok(index.sets.filter((s) => /left out/.test(s.unreadable ?? "")).some((s) => s.name === "Footer"), "layout sets go last");
  assert.match(index.warnings.join("\n"), /component sets were not read \(more than 6 behind this frame\)/);
});

// Small made-up frames: files differ, and none of these shapes is an error.
const box = (x, y, w, h) => ({ absoluteBoundingBox: { x, y, width: w, height: h } });
const node = (type, id, name, more = {}) => ({ id, name, type, ...box(0, 0, 100, 40), children: [], ...more });
const respOf = (document, more = {}) => ({ name: "File", version: "1", nodes: { [document.id]: { document, components: {}, componentSets: {}, styles: {}, ...more } } });
const emptyClient = (calls, more = {}) => ({
  file: async () => (calls.push("file"), { document: { children: [{ id: "0:1", name: "Page 1", type: "CANVAS" }] } }),
  nodes: async (k, ids) => (calls.push(`nodes ${k} ${ids.join(",")}`), { version: "1", nodes: Object.fromEntries(ids.map((i) => [i, null])) }),
  images: async () => (calls.push("images"), { images: {} }),
  ...more,
});

test("a frame with no components at all is an ordinary result with no Figma calls", async () => {
  const calls = [];
  const doc = node("FRAME", "1:1", "Hero", { children: [node("TEXT", "1:2", "Title", { characters: "Hello", style: {} }), node("RECTANGLE", "1:3", "Image")] });
  const out = join(tmp("comp"), "components");
  const index = await collectComponents({ store: componentStore({ client: emptyClient(calls), cacheDir: tmp("cache") }), fileKey: "F", resp: respOf(doc), outDir: out });
  assert.deepEqual([index.sets, index.no_component, index.warnings, index.calls, calls], [[], [], [], 0, []]);
  assert.equal(index.line, "");
  assert.match(readFileSync(join(out, "components.md"), "utf8"), /No component sets behind this frame\./);
});

test("detached copies and plain controls are named as having no component, with any set of the same name", async () => {
  const calls = [];
  const doc = node("FRAME", "1:1", "Signup", {
    children: [
      node("FRAME", "1:2", "Checkbox", box(0, 0, 20, 20)),
      node("FRAME", "1:3", "Checkbox", { ...box(0, 40, 20, 20), strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }], strokeWeight: 1 }),
      node("FRAME", "1:4", "Buttons", { ...box(0, 80, 300, 48), children: [node("FRAME", "1:5", "Button / Primary", box(0, 80, 120, 48)), node("FRAME", "1:6", "Button / Primary", box(140, 80, 120, 48))] }),
      node("FRAME", "1:7", "CTA section", box(0, 200, 1440, 600)),
    ],
  });
  const page = { document: node("CANVAS", "9:1", "Design system", { children: [node("COMPONENT_SET", "9:2", "Checkbox"), node("COMPONENT_SET", "9:3", "Card")] }) };
  const client = emptyClient(calls, {
    file: async () => ({ document: { children: [{ id: "0:1", name: "Pages" }, { id: "9:1", name: "Design system" }] } }),
    nodes: async (k, ids, opts = {}) => (calls.push(`nodes ${ids.join(",")} depth=${opts.depth ?? "full"}`), { version: "1", nodes: Object.fromEntries(ids.map((i) => [i, i === "9:1" ? page : null])) }),
  });
  const index = await collectComponents({ store: componentStore({ client, cacheDir: tmp("cache") }), fileKey: "F", resp: respOf(doc), outDir: join(tmp("comp"), "components") });
  const checkbox = index.no_component.find((e) => e.element === "Checkbox");
  assert.equal(checkbox.count, 2);
  assert.deepEqual(checkbox.looks, ["1:2", "1:3"], "two looks on the page: the same element in another state, a source before any fallback");
  assert.deepEqual(checkbox.candidates, [{ id: "9:2", name: "Checkbox", same_name: true }]);
  const button = index.no_component.find((e) => e.kind === "button");
  assert.deepEqual([button.element, button.count, button.where], ["Button / Primary", 2, "Buttons"], "the row of buttons is not itself a button, and a section named CTA is too tall to be one");
  assert.equal(index.no_component.length, 2);
  // The set of the same name is read (here Figma no longer has it): still a plain row, never a throw.
  assert.equal(index.sets.find((s) => s.name === "Checkbox").role, "candidate");
});

test("a library set the token cannot read is listed with what the page shows; one it can read is used", async () => {
  const doc = node("FRAME", "1:1", "Form", { children: [node("INSTANCE", "1:2", "Switch", { componentId: "L:1" }), node("INSTANCE", "1:3", "Switch", { componentId: "L:2" })] });
  const maps = {
    components: { "L:1": { key: "c1", name: "On=False, State=Default", remote: true, componentSetId: "L:9" }, "L:2": { key: "c2", name: "On=True, State=Default", remote: true, componentSetId: "L:9" } },
    componentSets: { "L:9": { key: "setkey", name: "Switch", remote: true } },
  };
  // No access: Figma answers 404 for the library set.
  const calls = [];
  const closed = emptyClient(calls, { componentSet: async () => { throw Object.assign(new Error("Figma answered 404"), { status: 404, kind: "http" }); } });
  const a = await collectComponents({ store: componentStore({ client: closed, cacheDir: tmp("cache") }), fileKey: "F", resp: respOf(doc, maps), outDir: join(tmp("comp"), "components") });
  assert.equal(a.sets.length, 1);
  assert.match(a.sets[0].unreadable, /not published, or this token cannot see it/);
  assert.deepEqual(a.sets[0].on_the_page.map((u) => u.name), ["On=False, State=Default", "On=True, State=Default"]);
  assert.deepEqual(a.sets[0].axes, [{ name: "On", values: ["False", "True"] }, { name: "State", values: ["Default"] }]);
  assert.deepEqual(a.warnings, [], "an unreadable library is a fact about the file, not a warning");
  assert.match(a.line, /Switch: library component, not readable/);
  assert.ok(!calls.some((c) => c.startsWith("nodes")), "nothing is asked of a file the token cannot find");

  // Access: the set is read from the library file, and its variants pair with the page's by name.
  const variant = (id, name) => node("COMPONENT", id, name, box(0, 0, 40, 24));
  const set = node("COMPONENT_SET", "77:1", "Switch", { ...box(0, 0, 200, 100), children: [variant("77:2", "On=False, State=Default"), variant("77:3", "On=True, State=Default"), variant("77:4", "On=False, State=Hover"), variant("77:5", "On=True, State=Hover")] });
  const calls2 = [];
  const open = emptyClient(calls2, {
    componentSet: async (key) => ({ meta: { key, file_key: "LIB", node_id: "77:1" } }),
    nodes: async (k, ids) => (calls2.push(`nodes ${k} ${ids.join(",")}`), { version: "7", nodes: { "77:1": { document: set, components: {}, componentSets: {} } } }),
    images: async (k, ids) => (calls2.push(`images ${k}`), { images: Object.fromEntries(ids.map((i) => [i, "https://example.invalid/r"])) }),
  });
  const out = join(tmp("comp"), "components");
  const b = await collectComponents({ store: componentStore({ client: open, cacheDir: tmp("cache"), fetchImpl: fakeFetch, sleep: noSleep }), fileKey: "F", resp: respOf(doc, maps), outDir: out });
  assert.deepEqual(calls2, ["nodes LIB 77:1", "images LIB"]);
  assert.equal(b.sets[0].library, "LIB");
  assert.deepEqual(b.sets[0].to_build, ["On=False, State=Hover", "On=True, State=Hover"]);
  assert.deepEqual(b.sets[0].states_not_designed, ["focus", "disabled"], "a set with half its states says which half");
  assert.ok(existsSync(join(out, "switch", "render@3x.png")));
});

// A team card like the About page's: Default grows its photo on hover with a smart animate, and
// opens a page outside the set on click; Hovered goes back on mouse leave; Focused has nothing.
const nodeAction = (to, navigation, transition) => ({ type: "NODE", destinationId: to, navigation, transition });
const profileSet = () =>
  node("COMPONENT_SET", "40:1", "Profile", {
    ...box(0, 0, 900, 400),
    children: [
      node("COMPONENT", "40:2", "State=Default", {
        ...box(0, 0, 280, 360),
        interactions: [
          { trigger: { type: "ON_HOVER" }, actions: [nodeAction("40:3", "CHANGE_TO", { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.20000000298023224 })] },
          { trigger: { type: "ON_CLICK" }, actions: [null, nodeAction("50:1", "NAVIGATE", { type: "DISSOLVE", easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.3, y1: 0, x2: 0.2, y2: 1 } }, duration: 0.3 })] },
        ],
        transitionNodeID: "40:3",
        transitionDuration: 200,
        transitionEasing: "EASE_OUT",
      }),
      node("COMPONENT", "40:3", "State=Hovered", {
        ...box(300, 0, 280, 360),
        interactions: [{ trigger: { type: "MOUSE_LEAVE", delay: 0.1 }, actions: [nodeAction("40:2", "CHANGE_TO", { type: "SMART_ANIMATE", easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { mass: 1, stiffness: 200, damping: 20 } }, duration: 0.4 })] }],
      }),
      node("COMPONENT", "40:4", "State=Focused", box(600, 0, 280, 360)),
    ],
  });
const profileClient = (calls) =>
  emptyClient(calls, {
    nodes: async (k, ids) => (calls.push(`nodes ${ids.join(",")}`), { version: "1", nodes: { "40:1": { document: profileSet(), components: {}, componentSets: {} } } }),
    images: async (k, ids) => (calls.push("images"), { images: Object.fromEntries(ids.map((i) => [i, "https://example.invalid/r"])) }),
  });

test("prototype interactions are read per variant, with the state each one changes to and its timing", () => {
  const d = setDigest(profileSet(), {});
  const v = (name) => d.variants.find((x) => x.name === name).interactions;
  assert.deepEqual(v("State=Default"), [
    { trigger: "hover", to: "State=Hovered", to_id: "40:3", navigation: "change to", transition: "smart animate", duration_ms: 200, easing: "ease-out" },
    { trigger: "click", to: null, outside_set: true, to_id: "50:1", navigation: "navigate", transition: "dissolve", duration_ms: 300, easing: "cubic-bezier(0.3, 0, 0.2, 1)", bezier: [0.3, 0, 0.2, 1] },
  ]);
  assert.deepEqual(v("State=Hovered"), [
    { trigger: "mouse leave", delay_ms: 100, to: "State=Default", to_id: "40:2", navigation: "change to", transition: "smart animate", duration_ms: 400, easing: "spring (mass 1, stiffness 200, damping 20)", spring: { mass: 1, stiffness: 200, damping: 20 } },
  ]);
  assert.deepEqual(v("State=Focused"), [], "a variant without interactions says so");
  assert.deepEqual(d.interaction_lines, [
    "Default -> Hovered on hover, smart animate 200 ms ease-out",
    "Default -> node 50:1 (outside the set) on click, navigate, dissolve 300 ms cubic-bezier(0.3, 0, 0.2, 1)",
    "Hovered -> Default on mouse leave after 100 ms, smart animate 400 ms spring (mass 1, stiffness 200, damping 20)",
  ]);

  // Older files keep only the legacy fields; a link and a back action go nowhere in the file.
  assert.deepEqual(interactionsOf({ transitionNodeID: "1:9", transitionDuration: 300, transitionEasing: "EASE_IN_AND_OUT" }), [{ trigger: "unknown", to_id: "1:9", navigation: "navigate", transition: "unknown", duration_ms: 300, easing: "ease-in-out" }]);
  assert.deepEqual(interactionsOf({ interactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "URL", url: "https://example.com" }, { type: "BACK" }] }] }), [{ trigger: "click", action: "open link", url: "https://example.com" }, { trigger: "click", action: "back" }]);
  assert.deepEqual(interactionsOf({ name: "Plain" }), []);
});

test("interactions reach set.json and components.md, with an instance's own when it differs", async () => {
  const same = setDigest(profileSet(), {}).variants[0];
  const doc = node("FRAME", "1:1", "Team", {
    children: [
      // Carries the variant's interactions as they are: nothing to add.
      node("INSTANCE", "1:2", "Profile", { componentId: "40:2", interactions: profileSet().children[0].interactions }),
      // Placed on the frame with a click that changes state instantly: an override.
      node("INSTANCE", "1:3", "Profile", { componentId: "40:2", interactions: [{ trigger: { type: "ON_CLICK" }, actions: [nodeAction("40:3", "CHANGE_TO", null)] }] }),
    ],
  });
  const maps = { components: { "40:2": { key: "c", name: "State=Default", componentSetId: "40:1" } }, componentSets: { "40:1": { key: "s", name: "Profile" } } };
  const calls = [];
  const cache = tmp("cache");
  const out = join(tmp("comp"), "components");
  const index = await collectComponents({ store: componentStore({ client: profileClient(calls), cacheDir: cache, fetchImpl: fakeFetch, sleep: noSleep }), fileKey: "F", resp: respOf(doc, maps), outDir: out });

  const set = JSON.parse(readFileSync(join(out, "profile", "set.json"), "utf8"));
  assert.deepEqual(set.variants.find((x) => x.name === "State=Default").interactions, same.interactions);
  assert.deepEqual(set.instance_interactions, [{ variant: "State=Default", count: 1, nodes: ["1:3"], interactions: [{ trigger: "click", to: "State=Hovered", to_id: "40:3", navigation: "change to", transition: "instant" }] }]);
  assert.deepEqual(index.sets[0].instance_interaction_lines, ["On this frame: Default -> Hovered on click, instant"]);
  const table = readFileSync(join(out, "components.md"), "utf8");
  assert.match(table, /## Interactions\n\n.*Under reduced motion the state still changes, without the animation\.\n\n- Profile: Default -> Hovered on hover, smart animate 200 ms ease-out\n/);
  assert.match(table, /\n- Profile: On this frame: Default -> Hovered on click, instant\n/);

  // A set cached before interactions were read is read again once; its render is kept.
  const metaFile = join(cache, "F", "40-1", "meta.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  delete meta.shape;
  writeFileSync(metaFile, JSON.stringify(meta));
  const again = [];
  await collectComponents({ store: componentStore({ client: profileClient(again), cacheDir: cache, fetchImpl: fakeFetch, sleep: noSleep }), fileKey: "F", resp: respOf(doc, maps), outDir: join(tmp("comp"), "components") });
  assert.deepEqual(again, ["nodes 40:1"]);
  const later = [];
  await collectComponents({ store: componentStore({ client: profileClient(later), cacheDir: cache }), fileKey: "F", resp: respOf(doc, maps), outDir: join(tmp("comp"), "components") });
  assert.deepEqual(later, [], "then it comes from the cache again");
});

test("a set that cannot be read still shows the interactions its instances carry", async () => {
  const fx2 = componentsState();
  const index = await collect(fx2, storeFor(fx2, tmp("cache")), join(tmp("comp"), "components"));
  const arrow = byName(index, "Button-arrow")[0];
  assert.ok(arrow.unreadable);
  assert.ok(arrow.instance_interaction_lines.includes("On this frame: State=Default, Size=md, Color=Dark -> another variant (node 6404:37558) on hover, smart animate 1250 ms slow spring (2 instances)"), arrow.instance_interaction_lines.join("\n"));
  assert.ok(!arrow.instance_interactions.some((g) => g.interactions.some((x) => x.outside_set)), "a change-to always stays inside its set");
});

test("a Figma rate limit is passed on; any other failure to read a set is a note", async () => {
  const doc = node("FRAME", "1:1", "Form", { children: [node("INSTANCE", "1:2", "Toggle", { componentId: "2:1" })] });
  const maps = { components: { "2:1": { name: "State=Off", componentSetId: "2:9" } }, componentSets: { "2:9": { key: "k", name: "Toggle" } } };
  const failing = (err) => componentStore({ client: emptyClient([], { nodes: async () => { throw err; } }), cacheDir: tmp("cache") });
  await assert.rejects(collectComponents({ store: failing(Object.assign(new Error("slow down"), { kind: "rate_limit", status: 429 })), fileKey: "F", resp: respOf(doc, maps), outDir: join(tmp("comp"), "c") }), /slow down/);
  const index = await collectComponents({ store: failing(Object.assign(new Error("Figma answered 500"), { kind: "http", status: 500 })), fileKey: "F", resp: respOf(doc, maps), outDir: join(tmp("comp"), "c") });
  assert.equal(index.sets[0].unreadable, "Figma answered 500");
});

async function batchWorld(patch) {
  const root = tmp("ext");
  const { repo } = gitRepo(root);
  const db = openDb(join(tempHome(), "state.db"));
  const config = await ternConfig(repo, patch);
  const clock = clockAt("2026-10-02T16:00:00Z");
  const base = fakeClient(figmaState());
  await reconcileProject({ db, config, client: base, clock });
  addManual({ db, project: "tern", fileKey: LIVE, nodeId: CONTACT, note: "contact form", clock });
  const b = createBatch({ db, config, plan: planBatch({ db, config, clock, now: true }), clock });
  const state = componentsState();
  const comp = componentsClient(state);
  const client = { ...base, ...comp, nodes: (k, ids, o) => (ids.includes(CONTACT) || !state.contact.nodes[ids[0]] ? comp.nodes(k, ids, o) : base.nodes(k, ids, o)) };
  const extract = () => extractBatch({ db, config, client, batchId: b.id, clock, fetchImpl: fakeFetch, sleep: noSleep });
  return { db, config, repo, state, batch: b, extract, clock };
}

test("figpipe extract lists the components in the manifest and keeps the sets for the next batch", async () => {
  const w = await batchWorld();
  const ex = await w.extract();
  const rec = Object.values(ex.items)[0];
  const dir = join(rec.dir, "components");
  assert.ok(rec.dir.startsWith(join(w.repo, ".figma")), "under the item's extraction folder");
  assert.equal(rec.components.table, join(dir, "components.md"));
  assert.equal(rec.components.render_scale, 3);
  const checkbox = rec.components.sets.find((s) => s.name === "Checkbox");
  assert.deepEqual(checkbox, {
    name: "Checkbox",
    role: "used",
    axes: { Checked: ["False", "True"], State: ["Disabled", "Default", "Hovered", "Focused"], Size: ["lg", "sm", "md"] },
    on_the_page: ["Checked=False, State=Default, Size=sm"],
    not_on_the_page: { Checked: ["True"], State: ["Disabled", "Hovered", "Focused"] },
    to_build: checkbox.to_build,
    states_not_designed: [],
    json: join(dir, "checkbox", "set.json"),
    node_json: join(dir, "checkbox", "node.json"),
    render: join(dir, "checkbox", "render@3x.png"),
  });
  assert.equal(checkbox.to_build.length, 7);
  assert.ok(existsSync(checkbox.json) && existsSync(checkbox.render));
  assert.deepEqual(rec.components.no_component.find((e) => e.element === "Leading dropdown").states_not_designed, ["hover", "focus", "open", "disabled"]);
  assert.ok(rec.components.no_component.find((e) => e.element === "Leading dropdown").sets_named_like_it.includes("Input dropdown"));
  assert.ok(rec.components.sets.find((s) => s.name === "Button-arrow").interactions.some((l) => /on hover, smart animate 1250 ms slow spring/.test(l)), "the hover the frame's arrows carry reaches the session");
  assert.equal(checkbox.interactions, undefined);
  assert.ok(!ex.warnings.some((x) => /component/.test(x)), "sets Figma cannot return are rows in the table, not warnings");
  assert.ok(existsSync(join(componentCacheDir(), LIVE, "7300-89958", "set.json")), "kept outside the batch, per file and set");

  const manifest = buildManifest({ db: w.db, config: w.config, batch: w.db.get("SELECT * FROM batches WHERE id = ?", w.batch.id), lanes: [], extract: ex, batchDir: "/b", model: "opus" });
  assert.equal(manifest.items[0].extraction.components.sets.find((s) => s.name === "Input field").to_build.length, 11);

  // Extracting again (a retry, or the next batch on the same file version) reads no set twice.
  const before = w.state.calls.length;
  await w.extract();
  const later = w.state.calls.slice(before);
  assert.ok(!later.some((c) => c.startsWith("images") && c.includes(SETS.checkbox)) && !later.some((c) => c.startsWith("nodes") && c.includes(SETS.checkbox)), later.join(" | "));
});

test("component extraction can be switched off per project", async () => {
  const w = await batchWorld((t) => `${t}\n[extract]\ncomponent_sets = false\n`);
  const ex = await w.extract();
  assert.equal(Object.values(ex.items)[0].components, undefined);
  assert.ok(!w.state.calls.some((c) => c.startsWith("file")));
});

test("the report says where each element's states came from, and asks about each state the build proposed", async () => {
  const rows = [
    { element: "Checkbox", source: "figma_component" },
    { element: "Input field", source: "figma_component" },
    { element: "Phone list", states: "open", source: "project", used: "the site's existing dropdown" },
  ];
  assert.equal(componentsLine(rows), "Checkbox, Input field: states from Figma component; Phone list open state: not designed, used the site's existing dropdown");
  assert.deepEqual(stateQuestions(rows), ["Phone list has no open state in Figma; the build uses the site's existing dropdown. Should it have one?"]);
  assert.deepEqual(
    stateQuestions([{ element: "Radio", states: "hover and focus", source: "figma_elsewhere", used: "the Booking form frame." }, { element: "Text link", source: "platform_default" }, { element: "Tab", source: "figma_component" }]),
    ["Radio has no hover and focus states of its own in Figma; the build takes them from the Booking form frame. Is that right?", "Text link has no states in Figma; the build uses the platform default. Which states should it have?"],
  );
  assert.equal(
    componentsLine([{ element: "Radio", states: "hover and focus", source: "figma_elsewhere", used: "the Booking form frame" }, { element: "Text link", source: "platform_default" }, { element: "Tab", states: "selected", source: "figma_component" }]),
    "Radio hover and focus states: from the Booking form frame; Text link: not designed, used the platform default; Tab selected state: from Figma component",
  );
  assert.equal(componentsLine([]), "");

  // Recorded by the session, stored, returned in the result and shown on the item.
  const w = await batchWorld();
  await w.extract();
  const item = w.db.get("SELECT * FROM items WHERE batch_id = ?", w.batch.id);
  const dir = tmp("batch");
  w.db.run("UPDATE batches SET dir = ? WHERE id = ?", dir, w.batch.id);
  const before = renderBatch(reportData(w.db, w.batch.id), dir);
  assert.doesNotMatch(before, /<h3>Components<\/h3>/, "this batch folder holds no extract.json, so there is nothing to show yet");
  recordResult({ db: w.db, batchId: w.batch.id, batchDir: dir, partial: true, result: { items: [{ item_id: item.id, outcome: "applied", change_kind: "new_page", verdict: "Contact page built.", flags: ["No empty state for the form."], components: rows }] } });
  const back = resultFromDb(w.db, w.batch.id, dir);
  assert.deepEqual(back.items[0].components, rows);
  assert.deepEqual(back.items[0].questions, [{ text: "Phone list has no open state in Figma; the build uses the site's existing dropdown. Should it have one?" }], "the proposed state is a question for the user");
  // The session returns that result as its final answer: recording it again asks once, not twice.
  recordResult({ db: w.db, batchId: w.batch.id, batchDir: dir, result: back });
  assert.equal(resultFromDb(w.db, w.batch.id, dir).items[0].questions.length, 1);
  assert.match(batchLine(w.db, w.batch.id), /1 question/, "it counts in the notification like any question");
  const html = renderBatch(reportData(w.db, w.batch.id), dir);
  assert.match(html, /<h3>Components<\/h3><p>Checkbox, Input field: states from Figma component; Phone list open state: not designed, used the site&#39;s existing dropdown<\/p>/);
  assert.match(html, /<h3>Questions for the designer<\/h3>.*Phone list has no open state in Figma; the build uses the site&#39;s existing dropdown\. Should it have one\?/s);
  assert.match(html, /<ul class="rows bullets"><li>No empty state for the form\.<\/li><\/ul>/, "said once, as a question, not again as a gap");
  assert.throws(() => recordResult({ db: w.db, batchId: w.batch.id, batchDir: dir, partial: true, result: { items: [{ item_id: item.id, outcome: "applied", change_kind: "new_page", verdict: "x", components: [{ element: "Checkbox", source: "guessed" }] }] } }), /"guessed" is not one of/);

  // A session that recorded no sources: the report falls back to what the extraction found in Figma.
  const base = { thread: [], events: [], late: [], preview: [], commits: [], text_diff: [], motion: [], captures: [], decisions: [], questions: [], flags: [], components: [] };
  const data = (it) => ({ batch: { id: "p-1", project: "p", status: "done", created_at: "2026-10-02T16:00:00Z", mcp_calls: 0 }, items: [{ ...base, id: 1, kind: "ready", title: "Contact", file_key: "K", node_id: "1:2", verdict: "Built.", design: { renders: [], components_line: "Checkbox: component in Figma; Leading dropdown: no component in Figma" }, ...it }], notDone: [], checks: [], context: [], denials: [], budget: { mcp_calls: 0, rest_429s: 0 } });
  const fallback = renderBatch(data({ outcome: "applied", change_kind: "new_page" }), dir);
  assert.match(fallback, /<h3>Components<\/h3><p>Checkbox: component in Figma; Leading dropdown: no component in Figma<\/p><p class="muted">The session did not record where each state came from\.<\/p>/);
  assert.doesNotMatch(renderBatch(data({ outcome: "applied", change_kind: "copy" }), dir), /<h3>Components<\/h3>/, "a copy change builds no states");
  assert.doesNotMatch(renderBatch(data({ outcome: "already_done", change_kind: "none" }), dir), /<h3>Components<\/h3>/);
});

test("state captures have their own names, and actions run in the order a person would do them", () => {
  assert.deepEqual(statePaths("/b", 7, "Checkbox checked / hover", [1440]).map((p) => p.rel), ["captures/7/states/Checkbox-checked-hover-1440.png"]);
  assert.throws(() => statePaths("/b", 7, "//", [1440]), /needs a name/);
  assert.deepEqual(stateActions({ hover: "label", click: "input", fill: "#name", text: "Jane", url: "http://localhost:1" }), [{ do: "click", selector: "input" }, { do: "fill", selector: "#name", text: "Jane" }, { do: "hover", selector: "label" }]);
  assert.deepEqual(stateActions({ state: "rest" }), []);
});
