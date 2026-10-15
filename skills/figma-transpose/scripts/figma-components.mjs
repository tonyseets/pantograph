// Component sets behind a frame: which sets its instances come from, every variant each set
// holds, the variants the frame never shows (the states a build still has to implement), the
// prototype interactions between them (trigger, target state, transition, duration, easing), and
// the interactive elements that have no component at all. Shared by figma-read.mjs and figpipe.
//
// Nothing here is required of a file. No sets, a set with half its states, detached copies and
// library sets the token cannot read are all ordinary: each is written down as what it is, so the
// build knows which states are designed and which need another source.
// No dependencies. Needs Node 18 or newer.
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { renderNodes } from "./figma-rest.mjs";
import { stateLines, diffLines, shapeFingerprint, nodeFileId, slugify, sha } from "./figma-nodes.mjs";

// The words designers use for each state, matched against variant axis names, variant values and
// boolean property names.
const WORDS = {
  hover: /hover|\bover\b/i,
  focus: /focus/i,
  pressed: /press|\bdown\b|click|active/i,
  disabled: /disabl|inactive|read.?only/i,
  checked: /check|select|\bon\b|active|toggled/i,
  filled: /fill|typed|typing|value|populated|entered/i,
  error: /error|invalid|destructive|danger|fail/i,
  open: /open|expand|active|shown/i,
  selected: /select|active|current|check|\bon\b/i,
};
// On a field, "Active" is the focused state.
const FIELD_FOCUS = /focus|active|typing|selected/i;

// Element kinds: the names that give them away, the states each one needs, and how tall a plain
// layer of that kind can be before it is a section rather than a control. Order matters: the
// first match wins ("Dropdown list item" is an option, "Input dropdown" a dropdown).
export const KINDS = [
  { kind: "checkbox", name: /check ?box|tick ?box/i, states: ["hover", "focus", "checked", "disabled"] },
  { kind: "radio", name: /\bradio/i, states: ["hover", "focus", "checked", "disabled"] },
  { kind: "toggle", name: /toggle|\bswitch\b/i, states: ["hover", "focus", "checked", "disabled"] },
  { kind: "option", name: /(list|menu|drop ?down|select) ?item|\boption\b/i, states: ["hover", "selected", "disabled"] },
  { kind: "dropdown", name: /drop ?down|\bselect\b|combo ?box/i, states: ["hover", "focus", "open", "disabled"], words: { focus: FIELD_FOCUS } },
  { kind: "input", name: /input|text ?field|text ?area|search ?(bar|field|box)|\bfield\b/i, states: ["hover", "focus", "filled", "error", "disabled"], words: { focus: FIELD_FOCUS }, max: 400 },
  { kind: "tab", name: /\btabs?\b|segment/i, states: ["hover", "focus", "selected"] },
  { kind: "accordion", name: /accordion|collaps|disclosure/i, states: ["hover", "focus", "open"], max: 400 },
  { kind: "link", name: /\blink\b/i, states: ["hover", "focus"] },
  { kind: "button", name: /button|\bbtn\b|\bcta\b/i, states: ["hover", "focus", "pressed", "disabled"] },
];
// A plain element of one kind may be designed as a set of another: a dropdown's list is options.
const ALSO = { dropdown: ["option"], option: ["dropdown"] };
const CONTROL_MAX = 120;

// "mobile_NavMenu-item" -> "mobile Nav Menu item", so word boundaries mean what they say.
const words = (s) => String(s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-/.]+/g, " ").replace(/\s+/g, " ").trim();
export const kindOf = (name) => {
  const s = words(name);
  return KINDS.find((k) => k.name.test(s)) ?? null;
};
const propName = (k) => String(k).split("#")[0];

// "Checked=False, State=Default" -> { Checked: "False", State: "Default" }
export function variantProps(name) {
  const out = {};
  for (const part of String(name ?? "").split(/,\s*(?=[^,=]+=)/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const STATE_AXIS = /state|status|interaction|check|select|active|open|expand|fill|disabl|hover|focus|press|error|destructive|invalid|danger|loading|toggle|current|^on$/i;
const STATE_VALUE = /^(hover(ed)?|focus(ed)?|pressed|active|inactive|disabled|open(ed)?|closed?|selected|unselected|checked|unchecked|error|invalid|loading|filled|empty|expanded|collapsed|current)$/i;
const REST_VALUE = /^(default|rest|resting|idle|normal|enabled|off|false|no|unchecked|unselected|closed?|collapsed|empty)$/i;
const UNNAMED = /^(state|variant|property|type|option)\s*\d+$/i;
// An axis is a state when its name says so, or when any value is a state word. Size, colour and
// breakpoint axes are not: their unused values are other designs, not states still to build.
export const isStateAxis = (a) => STATE_AXIS.test(words(a.name)) || (a.values ?? []).some((v) => STATE_VALUE.test(words(v)));

// Prototype interactions, in plain values. Figma gives each node `interactions`: a trigger and its
// actions, each action a destination, a navigation and a transition (duration in seconds, easing
// by name or as custom bezier or spring values). Older files carry only transitionNodeID,
// transitionDuration (ms) and transitionEasing. One entry per action:
// { trigger, delay_ms?, to_id, navigation, transition, direction?, duration_ms?, easing?, bezier?, spring? }
// or { trigger, action, url? } for an action that goes nowhere in the file (back, close, a link).
const TRIGGERS = { ON_CLICK: "click", ON_HOVER: "hover", ON_PRESS: "press", ON_DRAG: "drag", AFTER_TIMEOUT: "after delay", MOUSE_ENTER: "mouse enter", MOUSE_LEAVE: "mouse leave", MOUSE_UP: "mouse up", MOUSE_DOWN: "mouse down", ON_KEY_DOWN: "key down", ON_MEDIA_HIT: "media hit", ON_MEDIA_END: "media end" };
const EASINGS = { EASE_IN: "ease-in", EASE_OUT: "ease-out", EASE_IN_AND_OUT: "ease-in-out", LINEAR: "linear", EASE_IN_BACK: "ease-in back", EASE_OUT_BACK: "ease-out back", EASE_IN_AND_OUT_BACK: "ease-in-out back", GENTLE: "gentle spring", QUICK: "quick spring", BOUNCY: "bouncy spring", SLOW: "slow spring" };
const plainWord = (s) => String(s ?? "").toLowerCase().replace(/^on_/, "").replace(/_/g, " ");
const toMs = (s) => Math.round(Number(s) * 1000);
const num = (x) => Math.round(Number(x) * 1000) / 1000;
function easingOf(e) {
  if (!e) return {};
  if (typeof e === "string") return { easing: EASINGS[e] ?? plainWord(e) };
  const b = e.easingFunctionCubicBezier;
  if (b && (e.type === "CUSTOM_CUBIC_BEZIER" || !EASINGS[e.type])) {
    const v = [b.x1, b.y1, b.x2, b.y2].map(num);
    return { easing: `cubic-bezier(${v.join(", ")})`, bezier: v };
  }
  const sp = e.easingFunctionSpring;
  if (sp && (e.type === "CUSTOM_SPRING" || !EASINGS[e.type])) {
    const spring = { mass: num(sp.mass), stiffness: num(sp.stiffness), damping: num(sp.damping) };
    return { easing: `spring (mass ${spring.mass}, stiffness ${spring.stiffness}, damping ${spring.damping})`, spring };
  }
  return { easing: EASINGS[e.type] ?? plainWord(e.type) };
}
function actionOf(a) {
  if (a.type === "NODE") {
    const t = a.transition;
    return {
      to_id: a.destinationId ?? null,
      navigation: plainWord(a.navigation ?? "NAVIGATE"),
      transition: t ? plainWord(t.type) : "instant",
      ...(t?.direction ? { direction: plainWord(t.direction) } : {}),
      ...(t && t.duration != null ? { duration_ms: toMs(t.duration) } : {}),
      ...easingOf(t?.easing),
    };
  }
  if (a.type === "URL") return { action: "open link", url: a.url ?? null };
  return { action: plainWord(a.type) };
}
export function interactionsOf(n) {
  const out = [];
  for (const x of n?.interactions ?? []) {
    const t = x?.trigger ?? {};
    const trigger = TRIGGERS[t.type] ?? plainWord(t.type || "unknown");
    const wait = t.timeout ?? t.delay;
    const head = { trigger, ...(wait ? { delay_ms: toMs(wait) } : {}) };
    for (const a of x?.actions ?? []) if (a) out.push({ ...head, ...actionOf(a) });
  }
  if (!out.length && n?.transitionNodeID)
    out.push({
      trigger: "unknown",
      to_id: n.transitionNodeID,
      navigation: "navigate",
      transition: "unknown",
      ...(n.transitionDuration != null ? { duration_ms: Math.round(n.transitionDuration) } : {}),
      ...easingOf(n.transitionEasing),
    });
  return out;
}

// Names each destination: a variant of the set (`to`), or a node outside it (`outside_set`, with
// `to` when its name is known). byId: variant id -> name; names: every variant name; known: other
// component ids -> names from the same response. "Change to" only ever targets a variant of the
// same set. A library set's variants carry the library's ids, so a destination named like a
// variant is in the set. Without the set's variants (it could not be read) nothing else is known.
function resolveInteractions(list, { byId = new Map(), names = new Set(), known = {}, read = true } = {}) {
  return list.map(({ to_name, ...x }) => {
    if (!("to_id" in x)) return x;
    const name = byId.get(x.to_id) ?? to_name ?? known[x.to_id]?.name ?? null;
    const inSet = !read || x.navigation === "change to" || byId.has(x.to_id) || (name != null && names.has(name));
    const { trigger, delay_ms, to_id, ...rest } = x;
    return { trigger, ...(delay_ms ? { delay_ms } : {}), to: name, ...(inSet ? {} : { outside_set: true }), to_id, ...rest };
  });
}
// The part that says what the interaction does, for comparing an instance with its variant.
const interactionKey = (list) => JSON.stringify(list.map(({ to_id, ...x }) => (x.to ? x : { ...x, to_id })));

// "Default -> Hovered on hover, smart animate 200 ms ease-out". from and to are variant names;
// only the values that change are named.
export function interactionLine(from, x) {
  const timing = x.transition === "instant" ? "instant" : [x.transition, x.duration_ms != null ? `${x.duration_ms} ms` : null, x.easing].filter(Boolean).join(" ");
  const when = `on ${x.trigger === "unknown" ? "a trigger Figma does not give" : x.trigger}${x.delay_ms ? ` after ${x.delay_ms} ms` : ""}`;
  if (!("to_id" in x)) return `${from ? `${shortName(from)} ` : ""}${when}: ${x.action}${x.url ? ` ${x.url}` : ""}`;
  const a = variantProps(from);
  const b = x.outside_set ? {} : variantProps(x.to);
  const diff = Object.keys(a).filter((k) => k in b && a[k] !== b[k]);
  const left = diff.length ? diff.map((k) => a[k]).join(", ") : shortName(from);
  const right = x.outside_set ? `${x.to ? `"${x.to}"` : `node ${x.to_id}`} (outside the set)` : diff.length ? diff.map((k) => b[k]).join(", ") : x.to ? shortName(x.to) : `another variant (node ${x.to_id})`;
  const nav = x.navigation && x.navigation !== "change to" ? `, ${x.navigation}` : "";
  return `${left} -> ${right} ${when}${nav}${timing ? `, ${timing}` : ""}`;
}
const shortName = (name) => {
  const p = Object.values(variantProps(name));
  return p.length === 1 ? p[0] : String(name ?? "");
};
// One line per distinct interaction, with how many variants or instances carry it.
function interactionLines(rows, prefix = "") {
  const m = new Map();
  for (const r of rows) for (const x of r.interactions) {
    const l = interactionLine(r.name, x);
    m.set(l, (m.get(l) ?? 0) + (r.count ?? 1));
  }
  return [...m].map(([l, n]) => `${prefix}${l}${n > 1 ? ` (${n} ${prefix ? "instances" : "variants"})` : ""}`);
}

// Which sets a frame's instances come from, and which variants of each it shows.
// entry is the /nodes response entry: { document, components, componentSets }.
// Instances of a component that has no set are not listed: they have no variants to read.
// A visible instance's own prototype interactions are kept per variant (`on_instances`), so
// setUsage can name the ones that differ from the variant's.
// -> [{ id, name, key, remote, visible, hidden, variants: [{ id, name, count, hidden, nodes, on_instances }] }]
export function componentUsage(root, entry = {}) {
  const comps = entry.components ?? {};
  const meta = entry.componentSets ?? {};
  const sets = new Map();
  const walk = (n, hidden) => {
    const h = hidden || n.visible === false;
    const c = n.type === "INSTANCE" ? comps[n.componentId] : null;
    if (c?.componentSetId) {
      const sid = c.componentSetId;
      const m = meta[sid] ?? {};
      if (!sets.has(sid)) sets.set(sid, { id: sid, name: m.name ?? n.name, key: m.key ?? null, remote: !!(m.remote ?? c.remote), visible: 0, hidden: 0, variants: new Map() });
      const s = sets.get(sid);
      s[h ? "hidden" : "visible"]++;
      if (!s.variants.has(n.componentId)) s.variants.set(n.componentId, { id: n.componentId, name: c.name ?? "", count: 0, hidden: 0, nodes: [], on_instances: [] });
      const v = s.variants.get(n.componentId);
      v[h ? "hidden" : "count"]++;
      if (!h && v.nodes.length < 5) v.nodes.push(n.id);
      // Destinations keep the name the response gives them; setUsage places them in the set.
      const own = h ? [] : interactionsOf(n).map((x) => (comps[x.to_id]?.name ? { ...x, to_name: comps[x.to_id].name } : x));
      if (own.length) {
        const key = JSON.stringify(own);
        const g = v.on_instances.find((x) => x.key === key) ?? v.on_instances[v.on_instances.push({ key, interactions: own, count: 0, nodes: [] }) - 1];
        g.count++;
        if (g.nodes.length < 5) g.nodes.push(n.id);
      }
    }
    for (const k of n.children ?? []) walk(k, h);
  };
  if (root) walk(root, false);
  return [...sets.values()].map((s) => ({ ...s, variants: [...s.variants.values()] }));
}

// The linked parts of a text node: a hyperlink, an underline, or a text style named like a link.
function linkRuns(n, styles) {
  const t = n.characters ?? "";
  const isLink = (s) => !!s && (!!s.hyperlink || s.textDecoration === "UNDERLINE");
  if (isLink(n.style) || /\blink\b/i.test(words(styles[n.styles?.text]?.name))) return [t.trim()].filter(Boolean);
  const table = n.styleOverrideTable ?? {};
  const ov = n.characterStyleOverrides ?? [];
  const runs = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (isLink(table[ov[i]])) cur += t[i];
    else if (cur) {
      runs.push(cur);
      cur = "";
    }
  }
  if (cur) runs.push(cur);
  return runs.map((s) => s.trim()).filter(Boolean);
}

// How a node looks with its place and its words set aside: two copies of one element in different
// states have different looks, two copies in the same state share one.
const lookOf = (n) => sha(stateLines(n).map((l) => l.replace(/@-?\d+,-?\d+ \d+x\d+/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""')).join("\n"), 8);

const PLAIN = new Set(["FRAME", "GROUP", "RECTANGLE"]);
const COVERS_LINKS = new Set(["link", "button", "tab", "option"]);

// Interactive elements that are not instances of a component set: plain layers named like a
// control, a part of an instance switched on by a property (a field's "Leading dropdown"), a
// component that has no variants, and text styled as a link. Their states are not designed here.
// -> [{ kind, element, where, why, count, nodes, looks, states }]
export function plainElements(root, entry = {}) {
  const comps = entry.components ?? {};
  const meta = entry.componentSets ?? {};
  const styles = entry.styles ?? {};
  const found = new Map();
  const add = (kind, element, where, why, n) => {
    const k = `${kind}|${element}|${where ?? ""}|${why}`;
    if (!found.has(k)) found.set(k, { kind, element, where: where ?? null, why, count: 0, nodes: [], looks: new Map() });
    const e = found.get(k);
    e.count++;
    if (e.nodes.length < 6) e.nodes.push(n.id);
    const look = lookOf(n);
    if (!e.looks.has(look)) e.looks.set(look, n.id);
  };
  const refTo = (n, key) => {
    for (const c of n.children ?? []) {
      if (c.componentPropertyReferences?.visible === key) return c;
      const r = refTo(c, key);
      if (r) return r;
    }
    return null;
  };
  // Returns the kinds found at or below n, so a "Buttons" row that holds button instances is not
  // itself reported as a button.
  const walk = (n, inst, parent, depth) => {
    if (n.visible === false) return new Set();
    const below = new Set();
    let here = inst;
    if (n.type === "INSTANCE") {
      const c = comps[n.componentId] ?? {};
      const set = meta[c.componentSetId];
      const name = set?.name ?? c.name ?? n.name;
      const kind = kindOf(name)?.kind ?? null;
      here = { name, kind };
      if (kind) below.add(kind);
      if (!set && kind) add(kind, name, inst?.name ?? parent?.name, "a component without variants", n);
      for (const [key, p] of Object.entries(n.componentProperties ?? {})) {
        if (p?.type !== "BOOLEAN" || p.value !== true) continue;
        const pk = kindOf(propName(key));
        if (!pk || pk.kind === kind) continue;
        const part = refTo(n, key);
        if (part && part.type !== "INSTANCE") add(pk.kind, propName(key), name, `plain layers inside "${name}", shown by its "${propName(key)}" property`, part);
      }
    }
    for (const c of n.children ?? []) for (const k of walk(c, here, n, depth + 1)) below.add(k);
    if (n.type === "TEXT") {
      if (!COVERS_LINKS.has(here?.kind)) for (const run of linkRuns(n, styles)) add("link", `Text link ${JSON.stringify(run.length > 60 ? `${run.slice(0, 57)}...` : run)}`, here?.name ?? parent?.name, "text styled as a link", n);
    } else if (!here && depth > 0 && PLAIN.has(n.type)) {
      const k = kindOf(n.name);
      const h = n.absoluteBoundingBox?.height ?? 0;
      if (k && !below.has(k.kind) && h <= (k.max ?? CONTROL_MAX)) {
        add(k.kind, n.name, parent?.name, "plain layers named like a control", n);
        below.add(k.kind);
      }
    }
    return below;
  };
  if (root) walk(root, null, null, 0);
  return [...found.values()].map((e) => ({ ...e, looks: [...e.looks.values()], states: KINDS.find((k) => k.kind === e.kind).states }));
}

// Everything one component set holds: its variant axes, its other properties, and per variant
// its size, where it sits in the set's render and what it looks like, line by line.
// A variant's `changes` are its lines against the same variant at rest (`from`); its `sets` are
// the other component sets it shows (a dropdown's open variant shows list items).
export function setDigest(doc, entry = {}) {
  const defs = doc.componentPropertyDefinitions ?? {};
  const comps = entry.components ?? {};
  const setsIn = (n, out = new Set()) => {
    if (n.visible === false) return out;
    const sid = n.type === "INSTANCE" ? comps[n.componentId]?.componentSetId : null;
    if (sid && sid !== doc.id) out.add(sid);
    for (const c of n.children ?? []) setsIn(c, out);
    return out;
  };
  const kids = (doc.children ?? []).filter((c) => c.type === "COMPONENT");
  const rb = doc.absoluteRenderBounds ?? doc.absoluteBoundingBox ?? {};
  const variants = kids.map((v) => {
    const b = v.absoluteBoundingBox ?? {};
    return {
      id: v.id,
      name: v.name,
      props: variantProps(v.name),
      width: Math.round(b.width ?? 0),
      height: Math.round(b.height ?? 0),
      // Where it sits in the render of the whole set, in design pixels: multiply by the render scale.
      box: { x: Math.round((b.x ?? 0) - (rb.x ?? 0)), y: Math.round((b.y ?? 0) - (rb.y ?? 0)), w: Math.round(b.width ?? 0), h: Math.round(b.height ?? 0) },
      // The variant's own line goes without its name, so it only shows in `changes` when its style does.
      lines: stateLines(v).map((l, i) => (i ? l : l.replace(JSON.stringify(v.name), '"(variant)"'))),
      sets: [...setsIn(v)],
      interactions: interactionsOf(v),
    };
  });
  // Each destination named: a variant of this set, or a node outside it.
  const byId = new Map(variants.map((v) => [v.id, v.name]));
  const names = new Set(variants.map((v) => v.name));
  for (const v of variants) v.interactions = resolveInteractions(v.interactions, { byId, names, known: comps });
  let axes = Object.entries(defs).filter(([, d]) => d.type === "VARIANT").map(([k, d]) => ({ name: k, values: d.variantOptions ?? [], default: d.defaultValue ?? null }));
  if (!axes.length) {
    // Older files carry no definitions: the variant names hold the axes.
    const m = new Map();
    for (const v of variants) for (const [k, x] of Object.entries(v.props)) m.set(k, [...new Set([...(m.get(k) ?? []), x])]);
    axes = [...m].map(([name, values]) => ({ name, values, default: values[0] ?? null }));
  }
  for (const a of axes) {
    a.state = isStateAxis(a);
    a.rest = a.state ? (a.values.find((v) => REST_VALUE.test(words(v))) ?? a.default) : null;
  }
  const properties = Object.entries(defs).filter(([, d]) => d.type !== "VARIANT").map(([k, d]) => ({ name: propName(k), type: d.type, default: d.type === "INSTANCE_SWAP" ? null : (d.defaultValue ?? null) }));
  const stateAxes = axes.filter((a) => a.state);
  for (const v of variants) {
    const rest = variants.find((x) => axes.every((a) => x.props[a.name] === (a.state ? a.rest : v.props[a.name])));
    if (!rest || rest === v) continue;
    v.from = rest.name;
    v.changes = diffLines(rest.lines, v.lines).filter((d) => d.op !== " ").map((d) => d.op + d.line.trim());
  }
  const def = variants.find((v) => axes.every((a) => v.props[a.name] === a.default)) ?? variants[0] ?? null;
  const kind = kindOf(doc.name);
  const interactive = !!kind && (stateAxes.length > 0 || (!!def && def.height <= (kind.max ?? CONTROL_MAX)));
  const tokens = [...stateAxes.flatMap((a) => [a.name, ...a.values]), ...properties.filter((p) => p.type === "BOOLEAN").map((p) => p.name)].map(words);
  const has = (s) => tokens.some((t) => (kind.words?.[s] ?? WORDS[s]).test(t));
  return {
    id: doc.id,
    name: doc.name,
    kind: kind?.kind ?? null,
    interactive,
    axes,
    properties,
    default_variant: def?.name ?? null,
    // By name only: a state the set names differently is still that variant, the build says which.
    states_designed: interactive ? kind.states.filter(has) : [],
    states_not_designed: interactive ? kind.states.filter((s) => !has(s)) : [],
    unnamed_values: axes.flatMap((a) => a.values.filter((v) => UNNAMED.test(v))),
    // The prototype interactions of every variant, one readable line each: "Default -> Hovered on
    // hover, smart animate 200 ms ease-out". The values sit in variants[].interactions.
    interaction_lines: interactionLines(variants),
    variants,
  };
}

// What a frame shows of a set and what it leaves out. used: [{ id, name, count }] from componentUsage.
// to_build are the variants the frame does not show at the sizes and colours it does use.
export function setUsage(digest, used = []) {
  const byId = new Map(digest.variants.map((v) => [v.id, v]));
  const on = used.filter((u) => u.count > 0).map((u) => ({ id: u.id, name: u.name, count: u.count, props: byId.get(u.id)?.props ?? variantProps(u.name) }));
  // A library set's variants carry the library's ids, so the name counts too.
  const shown = (v) => on.some((u) => u.id === v.id || u.name === v.name);
  const state = digest.axes.filter((a) => a.state);
  const other = digest.axes.filter((a) => !a.state);
  const combo = (p) => JSON.stringify(other.map((a) => p[a.name] ?? null));
  const combos = new Set(on.map((u) => combo(u.props)));
  const rest = digest.variants.filter((v) => !shown(v));
  const toBuild = on.length ? rest.filter((v) => combos.has(combo(v.props))) : rest;
  const unseen = (list) => Object.fromEntries(list.map((a) => [a.name, a.values.filter((v) => !on.some((u) => u.props[a.name] === v))]).filter(([, v]) => v.length));
  const instances = instanceInteractions(used, digest);
  return {
    on_the_page: on.map(({ id, name, count }) => ({ id, name, count })),
    not_on_the_page: unseen(state),
    other_axes: on.length ? unseen(other) : {},
    to_build: toBuild.map((v) => v.name),
    other_variants: rest.length - toBuild.length,
    instance_interactions: instances,
    instance_interaction_lines: interactionLines(instances.map((g) => ({ ...g, name: g.variant })), "On this frame: "),
  };
}

// Interactions placed on the frame's instances that differ from their variant's: an override the
// build follows for those instances. Without a digest (a set that could not be read) every
// instance's interactions are listed, since they are all that is known of the design's.
// -> [{ variant, count, nodes, interactions }]
export function instanceInteractions(used = [], digest = null) {
  const vs = digest?.variants ?? [];
  const byId = new Map(vs.map((v) => [v.id, v.name]));
  const names = new Set(vs.map((v) => v.name));
  const out = [];
  for (const u of used)
    for (const g of u.on_instances ?? []) {
      const list = resolveInteractions(g.interactions, { byId, names, read: !!digest });
      const own = vs.find((v) => v.id === u.id) ?? vs.find((v) => v.name === u.name);
      if (own && interactionKey(own.interactions) === interactionKey(list)) continue;
      out.push({ variant: u.name, count: g.count, nodes: g.nodes, interactions: list });
    }
  return out;
}

const DAY = 86400000;
// The shape of set.json. A cached set written in another shape is read again, its render kept.
const DIGEST = 2;
const COMPONENT_PAGE = /component|librar|design ?system|ui ?kit|style ?guide|symbols|\batoms\b|\bpatterns\b/i;
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const copyFile = (from, to) => {
  try {
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
    return true;
  } catch {
    return false;
  }
};
const whyUnreadable = (e) => (e?.status === 404 ? "it is not published, or this token cannot see it" : e?.status === 403 ? "this token cannot read it" : (e?.message ?? "it could not be read"));
// FIGMA_COMPONENTS_CACHE moves it, for a shell that may only write in its own folders.
export const defaultCacheDir = () => process.env.FIGMA_COMPONENTS_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "figma-read", "components");

// Fetches and keeps component sets, so a set shared by many frames is read once.
//   Across items of one run: an in-memory memo.
//   Across runs: <cacheDir>/<file>/<set id>/{ meta.json, set.json, node.json, render@<scale>x.png },
//   reused as it is while the file version is the same. When the version moved the set is read
//   again (ids batched per request) and its render is kept if the set itself did not change.
// Every read goes through the shared client, one request at a time, so its 429 backoff applies.
// A rate limit is thrown to the caller; anything else about a set that cannot be read is a note.
export function componentStore({ client, cacheDir = defaultCacheDir(), scale = 3, fetchImpl, sleep, clock = Date.now, chunk = 8 } = {}) {
  const memo = new Map(); // "<file>:<set id>" -> record
  const cats = new Map();
  const libs = new Map();
  const stats = { calls: 0, cached: 0, fetched: 0, rendered: 0 };
  const dirOf = (fileKey, id) => join(cacheDir, fileKey, nodeFileId(id));

  // -> one record per id: { id, name, dir, digest, render, refs } or { id, error }
  async function ensure(fileKey, ids, { version = null, own = true } = {}) {
    const need = [];
    for (const id of ids) {
      const k = `${fileKey}:${id}`;
      if (memo.has(k)) continue;
      const dir = dirOf(fileKey, id);
      const meta = readJson(join(dir, "meta.json"));
      const digest = meta && meta.scale === scale && meta.shape === DIGEST && (version ? meta.version === version : clock() - Date.parse(meta.fetched_at) < DAY) ? readJson(join(dir, "set.json")) : null;
      if (digest) {
        memo.set(k, { ...meta, dir, digest, render: meta.render ? join(dir, `render@${scale}x.png`) : null });
        stats.cached++;
      } else need.push(id);
    }
    for (let i = 0; i < need.length; i += chunk) {
      const part = need.slice(i, i + chunk);
      let resp;
      try {
        resp = await client.nodes(fileKey, part);
        stats.calls++;
      } catch (e) {
        if (e.kind === "rate_limit" || (own && e.kind === "auth")) throw e;
        for (const id of part) memo.set(`${fileKey}:${id}`, { id, error: whyUnreadable(e) });
        continue;
      }
      const jobs = [];
      const fresh = [];
      for (const id of part) {
        const entry = resp?.nodes?.[id];
        const doc = entry?.document;
        if (!doc || doc.type !== "COMPONENT_SET") {
          memo.set(`${fileKey}:${id}`, { id, error: doc ? `it is a ${doc.type.toLowerCase().replace(/_/g, " ")}, not a component set` : "it is no longer in the file" });
          continue;
        }
        const dir = dirOf(fileKey, id);
        mkdirSync(dir, { recursive: true });
        const old = readJson(join(dir, "meta.json"));
        const fingerprint = shapeFingerprint(doc);
        const render = join(dir, `render@${scale}x.png`);
        const keep = old?.fingerprint === fingerprint && old.scale === scale && !!old.render && existsSync(render);
        // Saved in /nodes shape, so `figma-read.mjs tree` and `copy` read it like any other pull.
        writeFileSync(join(dir, "node.json"), JSON.stringify({ name: resp.name, lastModified: resp.lastModified, version: resp.version, nodes: { [id]: entry } }));
        const digest = setDigest(doc, entry);
        writeFileSync(join(dir, "set.json"), JSON.stringify(digest, null, 1));
        const sample = (sid) => Object.values(entry.components ?? {}).find((c) => c.componentSetId === sid)?.name ?? "";
        const refs = Object.entries(entry.componentSets ?? {}).filter(([k]) => k !== id).map(([k, m]) => ({ id: k, name: m.name, key: m.key ?? null, remote: !!m.remote, variant: sample(k) }));
        fresh.push({ id, name: doc.name, file_key: fileKey, version: resp.version ?? version, shape: DIGEST, fingerprint, scale, fetched_at: new Date(clock()).toISOString(), render: keep, refs, dir, digest });
        if (!keep) jobs.push({ id, path: render });
        stats.fetched++;
      }
      let res = {};
      if (jobs.length) {
        try {
          res = await renderNodes(client, fileKey, jobs, { scale, fetchImpl, sleep });
          stats.calls += Math.ceil(jobs.length / 6);
          stats.rendered += jobs.filter((j) => res[j.id]).length;
        } catch (e) {
          if (e.kind === "rate_limit") throw e;
        }
      }
      // meta.json is written last: a run stopped by a rate limit reads the set again next time.
      for (const r of fresh) {
        const { dir, digest, ...meta } = r;
        meta.render = meta.render || !!res[r.id];
        writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 1));
        memo.set(`${fileKey}:${r.id}`, { ...meta, dir, digest, render: meta.render ? join(dir, `render@${scale}x.png`) : null });
      }
    }
    return ids.map((id) => memo.get(`${fileKey}:${id}`));
  }

  // Every component set on the file's component pages (named like "Components", "Library",
  // "Design system", or the pages given), so an element with no component on the frame can be
  // matched to a set that sits elsewhere in the file. Two or three reads, kept for a day per file.
  async function catalogue(fileKey, { version = null, pages = [] } = {}) {
    if (cats.has(fileKey)) return cats.get(fileKey);
    const file = join(cacheDir, fileKey, "catalogue.json");
    const wanted = pages.join("|");
    const old = readJson(file);
    let cat = old && old.wanted === wanted && ((version && old.version === version) || clock() - Date.parse(old.at) < DAY) ? old : null;
    if (!cat) {
      cat = { version, at: new Date(clock()).toISOString(), wanted, pages: [], sets: [] };
      try {
        const f = await client.file(fileKey, { depth: 1 });
        stats.calls++;
        const all = f?.document?.children ?? [];
        const lower = pages.map((p) => String(p).toLowerCase());
        const picked = pages.length ? all.filter((p) => lower.includes(p.id) || lower.includes(String(p.name).toLowerCase())) : all.filter((p) => COMPONENT_PAGE.test(p.name ?? ""));
        cat.pages = picked.map((p) => p.name);
        // Depth 2 reaches the sets inside a page's sections; sections inside sections get one more read.
        let ids = picked.map((p) => ({ id: p.id, page: p.name }));
        for (let round = 0; ids.length && round < 2; round++) {
          const resp = await client.nodes(fileKey, ids.map((x) => x.id), { depth: 2 });
          stats.calls++;
          const next = [];
          for (const top of ids) {
            const walk = (n, d, path) => {
              if (n.type === "COMPONENT_SET") return void cat.sets.push({ id: n.id, name: n.name, page: top.page, in: path.join(" > ") || null });
              if (d === 2 && n.type === "SECTION" && next.length < 20) next.push({ id: n.id, page: top.page });
              for (const c of n.children ?? []) walk(c, d + 1, d === 0 && round === 0 ? path : [...path, n.name]);
            };
            const doc = resp?.nodes?.[top.id]?.document;
            if (doc) walk(doc, 0, []);
          }
          ids = next;
        }
        mkdirSync(join(cacheDir, fileKey), { recursive: true });
        writeFileSync(file, JSON.stringify(cat, null, 1));
      } catch (e) {
        if (e.kind === "rate_limit") throw e;
        cat.note = `the file's pages could not be listed: ${e.message}`;
      }
    }
    cats.set(fileKey, cat);
    return cat;
  }

  // A library set, by the key an instance carries: where it lives, when the token may know.
  async function library(key) {
    if (libs.has(key)) return libs.get(key);
    let r;
    if (!key || !client.componentSet) r = { error: "it has no key to look it up by" };
    else
      try {
        const m = (await client.componentSet(key))?.meta;
        stats.calls++;
        r = m?.file_key && m?.node_id ? { file_key: m.file_key, node_id: m.node_id } : { error: "Figma gave no location for it" };
      } catch (e) {
        if (e.kind === "rate_limit") throw e;
        r = { error: whyUnreadable(e) };
      }
    libs.set(key, r);
    return r;
  }

  return { ensure, catalogue, library, stats, scale, cacheDir };
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const axisList = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ");
const ROLE_NOTE = {
  candidate: (s) => `not on this frame; named like ${s.for.map((x) => `"${x}"`).join(", ")}`,
  nested: (s) => `not on this frame; inside ${s.in.map((x) => `"${x}"`).join(", ")}`,
};

// The compact table a build reads first.
export function componentsTable(index) {
  const out = [`# Components behind "${index.node?.name ?? index.node?.id ?? "the frame"}"`, ""];
  const sets = index.sets ?? [];
  if (!sets.length) out.push("No component sets behind this frame.", "");
  else {
    out.push(
      "States come from these sets: build every interactive element state by state from its set.json and compare with its render. A state that has no variant here is not designed in this set.",
      "",
      "| Set | Variant axes | On the page | Not on the page | Files |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const s of sets) {
      const note = [ROLE_NOTE[s.role]?.(s), s.library && "library"].filter(Boolean).join("; ");
      const name = `${cell(s.name)}${note ? ` (${cell(note)})` : ""}`;
      const on = s.on_the_page.map((u) => `${u.name}${u.count > 1 ? ` ×${u.count}` : ""}`).join("<br>") || "none";
      if (s.unreadable) {
        out.push(`| ${name} | ${cell(s.axes.map((a) => a.name).join(", ")) || "unknown"} | ${cell(on)} | not read: ${cell(s.unreadable)} | |`);
        continue;
      }
      const not = [
        axisList(s.not_on_the_page),
        s.to_build.length ? `${s.to_build.length} ${s.to_build.length === 1 ? "variant" : "variants"} to build` : "",
        axisList(s.other_axes) && `other designs: ${axisList(s.other_axes)}`,
        s.states_not_designed.length ? `no variant named for: ${s.states_not_designed.join(", ")}` : "",
        s.unnamed_values.length ? `unnamed: ${s.unnamed_values.join(", ")}` : "",
      ].filter(Boolean);
      out.push(`| ${name} | ${cell(axisList(Object.fromEntries(s.axes.map((a) => [a.name, a.values]))))} | ${cell(on)} | ${cell(not.join("<br>")) || "nothing"} | ${[s.json, s.render].filter(Boolean).map((p) => `\`${p}\``).join("<br>")} |`);
    }
    out.push("");
  }
  const moves = sets.filter((s) => s.interaction_lines?.length || s.instance_interaction_lines?.length);
  if (moves.length) {
    out.push(
      "## Interactions",
      "",
      "Prototype interactions on the variants and on this frame's instances. Build each as designed: the trigger, the state it changes to, the transition, its duration and easing. Under reduced motion the state still changes, without the animation.",
      "",
    );
    for (const s of moves) for (const l of [...(s.interaction_lines ?? []), ...(s.instance_interaction_lines ?? [])]) out.push(`- ${cell(s.name)}: ${l}`);
    out.push("");
  }
  if (index.hidden_only?.length) out.push(`Only in hidden layers, not read: ${index.hidden_only.map((s) => s.name).join(", ")}.`, "");
  if (index.no_component?.length) {
    out.push("## No component: states not designed", "", "| Element | Where | What it is | On the page | States without a design | Sets in the file named like it |", "| --- | --- | --- | --- | --- | --- |");
    for (const e of index.no_component)
      out.push(
        `| ${cell(e.element)} | ${cell(e.where ?? "")} | ${cell(e.why)} | ${e.count}${e.looks.length > 1 ? `, in ${e.looks.length} looks (\`${e.looks.join("`, `")}\`)` : ""} | ${e.states.join(", ")} | ${cell(e.candidates.map((c) => `${c.name}${c.same_name ? " (same name)" : ""}`).join(", ")) || "none"} |`,
      );
    out.push("");
  }
  if (index.catalogue?.note) out.push(`Component pages: ${index.catalogue.note}.`, "");
  for (const w of index.warnings ?? []) out.push(`- ${w}`);
  return out.join("\n");
}

// One line for a report that has nothing better: what Figma holds, before any build.
export function componentsLine(index) {
  const some = (names, n = 6) => (names.length > n ? `${names.slice(0, n).join(", ")} and ${names.length - n} more` : names.join(", "));
  const sets = (index?.sets ?? []).filter((s) => s.interactive || s.unreadable);
  const full = sets.filter((s) => !s.unreadable && !s.states_not_designed.length).map((s) => s.name);
  const parts = [];
  if (full.length) parts.push(`${some([...new Set(full)])}: component in Figma`);
  for (const s of sets.filter((x) => !x.unreadable && x.states_not_designed.length)) parts.push(`${s.name}: component in Figma, no ${s.states_not_designed.join(", ")} state`);
  const closed = (lib) => [...new Set(sets.filter((s) => s.unreadable && !!s.library === lib).map((s) => s.name))];
  if (closed(true).length) parts.push(`${some(closed(true))}: library component, not readable`);
  if (closed(false).length) parts.push(`${some(closed(false))}: component in Figma, not read`);
  const plain = index?.no_component ?? [];
  const links = plain.filter((e) => e.kind === "link").length;
  const none = [...plain.filter((e) => e.kind !== "link").map((e) => e.element), ...(links ? [`${links} text ${links === 1 ? "link" : "links"}`] : [])];
  if (none.length) parts.push(`${some(none, 4)}: no component in Figma`);
  return parts.join("; ");
}

// collectComponents({ store, fileKey, resp, nodeId, outDir, maxSets, pages }) -> the index, also
// written to <outDir>/index.json and <outDir>/components.md, with one folder per set:
// <outDir>/<set name>/{ set.json, node.json, render@<scale>x.png }.
// resp is the /nodes response that holds the frame; nothing is fetched for a frame without instances.
export async function collectComponents({ store, fileKey, resp, nodeId = null, outDir, maxSets = 30, pages = [], clock = Date.now }) {
  const entry = nodeId ? resp?.nodes?.[nodeId] : Object.values(resp?.nodes ?? {})[0];
  const root = entry?.document;
  if (!root) return null;
  const before = store.stats.calls;
  const version = resp.version ?? null;
  const usage = componentUsage(root, entry);
  const plain = plainElements(root, entry);
  const warnings = [];
  const shown = usage.filter((s) => s.visible > 0);
  // Known before a set is read: its name, and the axis names every one of its variants carries.
  const stateful = (name, variant) => !!kindOf(name) || Object.keys(variantProps(variant)).some((a) => STATE_AXIS.test(words(a)));
  const first = (s) => stateful(s.name, s.variants[0]?.name);
  // Sets with states first, so the cap never drops one of them for a layout set.
  const rows = [...shown.filter(first), ...shown.filter((s) => !first(s))].map((s) => ({ id: s.id, name: s.name, key: s.key, remote: s.remote, role: "used", used: s.variants }));
  const known = new Map(rows.map((r) => [r.id, r]));

  // Sets elsewhere in the file for the elements that have no component on this frame.
  let cat = null;
  for (const e of plain) e.candidates = [];
  if (plain.length) {
    cat = await store.catalogue(fileKey, { version, pages });
    for (const e of plain) {
      const kinds = [e.kind, ...(ALSO[e.kind] ?? [])];
      const same = (s) => words(s.name).toLowerCase() === words(e.element).toLowerCase();
      const match = cat.sets.filter((s) => same(s) || kinds.includes(kindOf(s.name)?.kind)).sort((a, b) => same(b) - same(a));
      e.candidates = match.map((s) => ({ id: s.id, name: s.name, same_name: same(s) }));
      for (const s of match.slice(0, 4)) {
        if (!known.has(s.id)) known.set(s.id, rows[rows.push({ id: s.id, name: s.name, key: null, remote: false, role: "candidate", used: [], for: [] }) - 1]);
        const r = known.get(s.id);
        if (r.role === "candidate" && !r.for.includes(e.element)) r.for.push(e.element);
      }
    }
  }

  const read = async (list) => {
    const local = list.filter((r) => !r.remote);
    const recs = await store.ensure(fileKey, local.map((r) => r.id), { version });
    local.forEach((r, i) => (r.rec = recs[i]));
    for (const r of list.filter((x) => x.remote)) {
      const at = await store.library(r.key);
      r.library = at.file_key ?? null;
      r.rec = at.error ? { error: at.error } : (await store.ensure(at.file_key, [at.node_id], { own: false }))[0];
    }
  };
  const capped = (list) => {
    const room = Math.max(0, maxSets - rows.filter((r) => r.rec).length);
    for (const r of list.slice(room)) r.rec = { error: `left out, more than ${maxSets} sets behind this frame` };
    if (list.length > room) warnings.push(`${list.length - room} component sets were not read (more than ${maxSets} behind this frame): ${list.slice(room).map((r) => r.name).join(", ")}`);
    return list.slice(0, room);
  };
  await read(capped(rows.slice()));
  // Sets with states that only show inside the variants still to build (the list items of a
  // dropdown's open state), one step deep. Icons and layout pieces are left alone.
  const nested = [];
  for (const r of rows.filter((x) => x.rec?.digest?.interactive)) {
    const build = new Set(setUsage(r.rec.digest, r.used).to_build);
    const ids = new Set(r.rec.digest.variants.filter((v) => build.has(v.name)).flatMap((v) => v.sets ?? []));
    for (const ref of (r.rec.refs ?? []).filter((x) => ids.has(x.id) && stateful(x.name, x.variant))) {
      if (!known.has(ref.id)) {
        known.set(ref.id, { id: ref.id, name: ref.name, key: ref.key, remote: ref.remote, role: "nested", used: [], in: [] });
        nested.push(known.get(ref.id));
      }
      const n = known.get(ref.id);
      if (n.role === "nested" && !n.in.includes(r.name)) n.in.push(r.name);
    }
  }
  const hiddenOnly = usage.filter((s) => !s.visible);
  rows.push(...nested);
  await read(capped(nested));

  mkdirSync(outDir, { recursive: true });
  const taken = new Set();
  const sets = rows.map((r) => {
    let dir = slugify(r.name);
    if (taken.has(dir)) dir = `${dir}__${nodeFileId(r.id)}`;
    taken.add(dir);
    const base = { id: r.id, name: r.name, role: r.role, ...(r.for ? { for: r.for } : {}), ...(r.in ? { in: r.in } : {}), ...(r.remote ? { library: r.library ?? true } : {}) };
    const rec = r.rec ?? {};
    if (!rec.digest) {
      // Not readable: the variants the frame uses are still known from its own instances.
      const on = r.used.filter((u) => u.count > 0).map(({ id, name, count }) => ({ id, name, count }));
      const axes = Object.keys(variantProps(r.used[0]?.name)).map((name) => ({ name, values: [...new Set(r.used.map((u) => variantProps(u.name)[name]).filter(Boolean))] }));
      const ii = instanceInteractions(r.used, null);
      const prototype = ii.length ? { instance_interactions: ii, instance_interaction_lines: interactionLines(ii.map((g) => ({ ...g, name: g.variant })), "On this frame: ") } : {};
      return { ...base, kind: kindOf(r.name)?.kind ?? null, interactive: !!kindOf(r.name), unreadable: rec.error ?? "it could not be read", axes, on_the_page: on, ...prototype };
    }
    const d = rec.digest;
    const u = setUsage(d, r.used);
    mkdirSync(join(outDir, dir), { recursive: true });
    const full = { schema: 1, file_key: rec.file_key, version: rec.version, role: r.role, ...base, ...u, ...d };
    writeFileSync(join(outDir, dir, "set.json"), JSON.stringify(full, null, 1));
    copyFile(join(rec.dir, "node.json"), join(outDir, dir, "node.json"));
    const png = `render@${store.scale}x.png`;
    const render = rec.render && copyFile(rec.render, join(outDir, dir, png)) ? join(dir, png) : null;
    if (!render) warnings.push(`no render for the set "${r.name}" (Figma returned no image)`);
    const { variants, properties, ...head } = d;
    return { ...base, ...head, variants: variants.length, ...u, dir, json: join(dir, "set.json"), node_json: join(dir, "node.json"), render };
  });
  const index = {
    schema: 1,
    file_key: fileKey,
    node: { id: root.id, name: root.name },
    version,
    at: new Date(clock()).toISOString(),
    render_scale: store.scale,
    sets,
    hidden_only: hiddenOnly.filter((s) => !sets.some((x) => x.id === s.id)).map((s) => ({ id: s.id, name: s.name })),
    no_component: plain,
    catalogue: cat ? { pages: cat.pages, sets: cat.sets.length, ...(cat.note ? { note: cat.note } : cat.pages.length ? {} : { note: "no page named like Components, Library or Design system; sets elsewhere in the file were not looked for" }) } : null,
    warnings,
    calls: store.stats.calls - before,
  };
  index.line = componentsLine(index);
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 1));
  writeFileSync(join(outDir, "components.md"), componentsTable(index));
  return index;
}
