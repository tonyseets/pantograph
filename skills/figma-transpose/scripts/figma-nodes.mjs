// Pure helpers over Figma REST node JSON: tree dump, structural diff, verbatim copy,
// ready-for-dev scan, fingerprints and Figma URL parsing. Shared by figma-read.mjs,
// figma-components.mjs and figpipe.
// No dependencies. Needs Node 18 or newer.
import { createHash } from "node:crypto";

// The document of a /nodes response entry, or a bare node.
export const docOf = (resp, id) => {
  if (resp?.nodes) {
    const entry = id ? resp.nodes[id] : Object.values(resp.nodes)[0];
    return entry?.document ?? null;
  }
  return resp?.document ?? resp ?? null;
};

export function findNode(n, id) {
  if (!n) return null;
  if (n.id === id) return n;
  for (const c of n.children ?? []) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

const hex = (c) => "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
export function paintColor(p) {
  if (!p) return "";
  if (p.type !== "SOLID" || p.visible === false) return p.type;
  const a = Math.round((p.color.a ?? 1) * (p.opacity ?? 1) * 100) / 100;
  return a === 1 ? hex(p.color) : `${hex(p.color)}/${a}`;
}
const visiblePaints = (arr) => (arr ?? []).filter((p) => p.visible !== false).map(paintColor);
const r1 = (x) => Math.round((x ?? 0) * 10) / 10;

// One line per node: type, id, name, position relative to origin, size, layout, paints, text.
// ids: false leaves the node id out, so lines from two variants of a component compare.
export function describe(n, origin, { ids = true } = {}) {
  const b = n.absoluteBoundingBox ?? {};
  let s = `${n.type.slice(0, 4)} ${ids ? `${n.id} ` : ""}${JSON.stringify(n.name)} @${Math.round((b.x ?? 0) - origin[0])},${Math.round((b.y ?? 0) - origin[1])} ${Math.round(b.width ?? 0)}x${Math.round(b.height ?? 0)}`;
  if (n.visible === false) s += " HIDDEN";
  if (n.devStatus) s += ` DEV:${n.devStatus.type}`;
  if (n.layoutMode) {
    s += ` ${n.layoutMode[0]} gap${n.itemSpacing ?? 0} pad[${["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => n[k] ?? 0).join(",")}] ${n.primaryAxisAlignItems ?? ""}/${n.counterAxisAlignItems ?? ""}`;
    if (n.layoutWrap === "WRAP") s += " WRAP";
  }
  if (n.clipsContent) s += " clip";
  const f = visiblePaints(n.fills);
  if (f.length && n.type !== "TEXT") s += ` fill[${f.join(",")}]`;
  const st = visiblePaints(n.strokes);
  if (st.length) s += ` stroke[${st.join(",")}]w${n.strokeWeight}`;
  if (n.cornerRadius) s += ` r${n.cornerRadius}`;
  if ((n.opacity ?? 1) !== 1) s += ` op${Math.round(n.opacity * 100) / 100}`;
  for (const e of n.effects ?? []) if (e.visible !== false) s += ` fx:${e.type}${e.radius ?? ""}`;
  if (n.type === "INSTANCE") {
    s += ` comp=${n.componentId}`;
    if (n.componentProperties) s += " props=" + JSON.stringify(componentProps(n));
  }
  if (n.type === "TEXT") s += ` [${textStyle(n)}] ${JSON.stringify(n.characters)}`;
  if (n.interactions?.length) s += ` interactions:${n.interactions.length}`;
  return s;
}

const componentProps = (n) => Object.fromEntries(Object.entries(n.componentProperties ?? {}).map(([k, v]) => [k.split("#")[0], v?.value]));
export function textStyle(n) {
  const t = n.style ?? {};
  const fill = n.fills?.length ? paintColor(n.fills[0]) : "";
  return `${t.fontFamily ?? ""} ${t.fontWeight ?? ""} ${t.fontSize ?? ""}/${r1(t.lineHeightPx)} ls${Math.round((t.letterSpacing ?? 0) * 100) / 100} ${fill}`.replace(/\s+/g, " ").trim();
}

const leaf = (n) => n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION";
const originOf = (n) => [n.absoluteBoundingBox?.x ?? 0, n.absoluteBoundingBox?.y ?? 0];

// Full tree dump (hidden nodes included and marked), for reading a node without opening Figma.
export function treeLines(root, maxDepth = Infinity) {
  const out = [];
  const o = originOf(root);
  const walk = (n, d) => {
    out.push("  ".repeat(d) + describe(n, o));
    if (d < maxDepth && !leaf(n)) for (const c of n.children ?? []) walk(c, d + 1);
  };
  walk(root, 0);
  return out;
}

// Visible-only, id-free lines, so a diff shows design changes rather than node churn.
export function flatLines(root) {
  const out = [];
  const o = originOf(root);
  const walk = (n, d) => {
    if (n.visible === false) return;
    const b = n.absoluteBoundingBox ?? {};
    let s = `${"  ".repeat(d)}${n.type.slice(0, 4)} ${JSON.stringify(n.name)} @${Math.round((b.x ?? 0) - o[0])},${Math.round((b.y ?? 0) - o[1])} ${Math.round(b.width ?? 0)}x${Math.round(b.height ?? 0)}`;
    if (n.layoutMode) s += ` ${n.layoutMode[0]} gap${n.itemSpacing ?? 0} pad[${["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => n[k] ?? 0).join(",")}]`;
    const f = visiblePaints(n.fills);
    if (f.length) s += ` fill[${f.join(",")}]`;
    if (n.type === "TEXT") s += ` [${n.style?.fontSize ?? ""}/${r1(n.style?.lineHeightPx)}] ${JSON.stringify(n.characters)}`;
    if (n.componentProperties) s += " props=" + JSON.stringify(componentProps(n));
    out.push(s);
    if (!leaf(n)) for (const c of n.children ?? []) walk(c, d + 1);
  };
  walk(root, 0);
  return out;
}

// One state of a component: visible nodes only, no ids, with every stroke, radius, opacity, effect
// and text style, so a diff of two variants shows exactly what a state changes.
export function stateLines(root) {
  const out = [];
  const o = originOf(root);
  const walk = (n, d) => {
    if (n.visible === false) return;
    out.push("  ".repeat(d) + describe(n, o, { ids: false }));
    if (!leaf(n)) for (const c of n.children ?? []) walk(c, d + 1);
  };
  walk(root, 0);
  return out;
}

// Line diff (LCS). Returns [{ op: " " | "-" | "+", line }]. Inputs are a few thousand lines at most.
export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  // Trim the common head and tail so the table only covers the changed middle.
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail++;
  const A = a.slice(head, n - tail);
  const B = b.slice(head, m - tail);
  // Past ~20M cells the table costs too much memory; report the middle as replaced.
  if ((A.length + 1) * (B.length + 1) > 2e7)
    return [...a.slice(0, head).map((line) => ({ op: " ", line })), ...A.map((line) => ({ op: "-", line })), ...B.map((line) => ({ op: "+", line })), ...a.slice(n - tail).map((line) => ({ op: " ", line }))];
  const W = B.length + 1;
  const t = new Uint32Array((A.length + 1) * W);
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      t[i * W + j] = A[i] === B[j] ? t[(i + 1) * W + j + 1] + 1 : Math.max(t[(i + 1) * W + j], t[i * W + j + 1]);
  const mid = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      mid.push({ op: " ", line: A[i] });
      i++;
      j++;
    } else if (t[(i + 1) * W + j] >= t[i * W + j + 1]) mid.push({ op: "-", line: A[i++] });
    else mid.push({ op: "+", line: B[j++] });
  }
  while (i < A.length) mid.push({ op: "-", line: A[i++] });
  while (j < B.length) mid.push({ op: "+", line: B[j++] });
  return [...a.slice(0, head).map((line) => ({ op: " ", line })), ...mid, ...a.slice(n - tail).map((line) => ({ op: " ", line }))];
}

// Unified-style text with `context` unchanged lines around each change.
export function unifiedDiff(a, b, { context = 1, from = "old", to = "new" } = {}) {
  const d = diffLines(a, b);
  const keep = new Set();
  d.forEach((x, k) => {
    if (x.op !== " ") for (let c = k - context; c <= k + context; c++) keep.add(c);
  });
  if (!keep.size) return "";
  const out = [`--- ${from}`, `+++ ${to}`];
  let last = -2;
  d.forEach((x, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1) out.push("@@");
    out.push(x.op + x.line);
    last = k;
  });
  return out.join("\n");
}

export const changedLineCount = (diffText) =>
  diffText.split("\n").filter((l) => (l[0] === "+" || l[0] === "-") && !l.startsWith("+++") && !l.startsWith("---")).length;

// Every visible TEXT node in document order, verbatim. Hidden subtrees are skipped.
export function extractCopy(root) {
  const out = [];
  const walk = (n, hidden) => {
    const h = hidden || n.visible === false;
    if (n.type === "TEXT" && !h) out.push({ id: n.id, name: n.name, text: n.characters ?? "", style: textStyle(n) });
    for (const c of n.children ?? []) walk(c, h);
  };
  walk(root, false);
  return out;
}

// Group copy by the root's direct children (sections or breakpoint frames).
export function copyBySection(root) {
  const o = originOf(root);
  return (root.children ?? []).map((c) => {
    const b = c.absoluteBoundingBox ?? {};
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      y: Math.round((b.y ?? 0) - o[1]),
      width: Math.round(b.width ?? 0),
      height: Math.round(b.height ?? 0),
      hidden: c.visible === false,
      copy: c.visible === false ? [] : extractCopy(c),
    };
  });
}

// Copy as Markdown, JSON-quoted so trailing spaces and line breaks stay visible.
export function copyMarkdown(root, title) {
  const out = [`# ${title ?? root.name} (verbatim copy)`, "", `Node \`${root.id}\`. Every visible TEXT node, in document order. Strings are JSON-quoted.`, ""];
  for (const s of copyBySection(root)) {
    if (!s.copy.length) continue;
    out.push(`## ${s.name.trim() || "(unnamed)"} \`${s.id}\` (y ${s.y}, ${s.width}x${s.height})`, "");
    for (const t of s.copy) out.push(`- ${JSON.stringify(t.text)}  <sub>${t.style} \`${t.id}\`</sub>`);
    out.push("");
  }
  return out.join("\n");
}

// Nodes with a devStatus, with their ancestry under the scanned root.
// Returns [{ id, name, type, status, description, depth, path: [names], top: { id, name } }].
export function devStatusNodes(root) {
  const out = [];
  const walk = (n, depth, path, top) => {
    const t = depth === 1 ? { id: n.id, name: n.name } : top;
    if (n.devStatus && depth > 0)
      out.push({ id: n.id, name: n.name, type: n.type, status: n.devStatus.type, description: n.devStatus.description ?? "", depth, path, top: t, node: n });
    for (const c of n.children ?? []) walk(c, depth + 1, depth === 0 ? [] : [...path, n.name], t);
  };
  walk(root, 0, [], null);
  return out;
}

// Map every node id in a tree to its depth-1 ancestor (the "area" a lane works on).
export function areaIndex(root) {
  const idx = new Map();
  const walk = (n, top) => {
    if (top) idx.set(n.id, top);
    for (const c of n.children ?? []) walk(c, top ?? { id: c.id, name: c.name });
  };
  walk(root, null);
  return idx;
}

// Stable JSON (sorted keys) so the same node always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
export const sha = (s, len = 16) => createHash("sha256").update(s).digest("hex").slice(0, len);
export const fingerprint = (node) => sha(canonical(node ?? null));

// Figma links: /design/<key>/..., /file/<key>/..., /proto/<key>/..., /board/<key>/...
// node-id comes as 1-2 in URLs and 1:2 in the API. A #<digits> fragment is a comment id.
export function parseFigmaUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:design|file|proto|board|make)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (!m) return null;
  const raw = u.searchParams.get("node-id");
  const nodeId = raw ? raw.replace(/-/g, ":") : null;
  const frag = u.hash.replace(/^#/, "");
  const commentId = /^\d+$/.test(frag) ? frag : null;
  return { fileKey: m[2] ?? m[1], mainKey: m[1], branchKey: m[2] ?? null, nodeId, commentId };
}

export const nodeFileId = (id) => id.replace(/:/g, "-");

export const slugify = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";

// Fingerprint that ignores where the node sits on the canvas: absolute boxes are made relative
// to the node's own origin, so moving a section does not count as a design change.
export function shapeFingerprint(node) {
  if (!node) return fingerprint(null);
  const ox = node.absoluteBoundingBox?.x ?? 0;
  const oy = node.absoluteBoundingBox?.y ?? 0;
  const rel = (v) => {
    if (Array.isArray(v)) return v.map(rel);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if ((k === "absoluteBoundingBox" || k === "absoluteRenderBounds") && x && typeof x === "object")
          o[k] = { ...x, x: Math.round(((x.x ?? 0) - ox) * 100) / 100, y: Math.round(((x.y ?? 0) - oy) * 100) / 100 };
        else o[k] = rel(x);
      }
      return o;
    }
    return v;
  };
  return sha(canonical(rel(node)));
}
