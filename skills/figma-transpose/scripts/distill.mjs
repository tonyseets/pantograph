#!/usr/bin/env node
// Deterministic distiller: get_design_context JSX -> per-section spec (copy verbatim, image
// slots, icons, type tokens).
// Usage: node distill.mjs <breakpoint> <raw.full.txt> <out.md> <out.json> [assets-map.json]
// Run from .figma/<page>/ so the default assets map resolves, or pass it explicitly.
// No dependencies. Needs Node 18 or newer.
import { readFileSync, writeFileSync } from "node:fs";

const [bp, src, outMd, outJson, amapArg] = process.argv.slice(2);
if (!bp || !src || !outMd || !outJson) {
  console.error("usage: distill.mjs <breakpoint> <raw.full.txt> <out.md> <out.json> [assets-map.json]");
  process.exit(2);
}
const read = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
const code = read(src).split("\n\n=====\n\n")[0];
const amap = JSON.parse(read(amapArg ?? "assets-map.json"));
const consts = Object.fromEntries([...code.matchAll(/const (\w+) = "(https:\/\/[^"]+)";/g)].map((m) => [m[1], m[2]]));

// The entities Figma text actually carries. Numeric references cover everything else.
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•",
  middot: "·", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷", deg: "°",
  plusmn: "±", larr: "←", rarr: "→", uarr: "↑", darr: "↓", laquo: "«", raquo: "»", sect: "§",
};
const unescape = (t) =>
  t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, ref) => {
    if (ref[0] !== "#") return ENTITIES[ref] ?? all;
    const n = /^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });

const attr = (a, k) => a.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? null;
const cls = (a) => a.match(/className="([^"]*)"/)?.[1] ?? "";
const STYLE = /^(text-\[\d|font-\[|leading-\[|tracking-\[|text-\[color|text-white|text-\[#|text-\[rgba|uppercase)/;

// Tokenizer over JSX tags and text.
const tok = /<(\/?)([\w.]+)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g;
const stack = [];
const sections = [];
let cur = null;
let depth = 0;

for (const m of code.matchAll(tok)) {
  const [, close, tag, attrs = "", selfc, text] = m;
  if (text !== undefined) {
    // Unwrap JSX expressions {`...`}, {'...'} and {"..."}.
    let t = text
      .replace(/\{`([^`]*)`\}/g, "$1")
      .replace(/\{'([^']*)'\}/g, "$1")
      .replace(/\{"([^"]*)"\}/g, "$1");
    t = unescape(t);
    if (/^\s*$/.test(t) || (t.includes("{") && t.includes("}") && t.includes("src"))) continue;
    t = t.replace(/\s+/g, " ").trim();
    if (t && cur !== null && depth >= 2) {
      const top = stack[stack.length - 1];
      cur.copy.push({ text: t, in: top ? top.name : "", node: top ? top.id : "", style: top ? top.style : "" });
    }
    continue;
  }
  if (tag === "React.Fragment") continue;
  if (close) {
    depth -= 1;
    if (stack.length) stack.pop();
    if (depth === 1 && cur !== null) {
      sections.push(cur);
      cur = null;
    }
    continue;
  }
  const nid = attr(attrs, "data-node-id");
  const name = attr(attrs, "data-name");
  const c = cls(attrs);
  const ann = attr(attrs, "data-annotations");
  const style = c.split(/\s+/).filter((x) => x && STYLE.test(x)).join(" ");
  const node = { id: nid, name: name || "", style };
  if (depth === 1) {
    // Top-level section.
    cur = {
      index: sections.length + 1, id: nid, name: name || "", classes: c, copy: [], images: [], icons: [],
      annotations: [], colors: new Set(), fonts: new Set(),
    };
  }
  if (cur !== null && depth >= 1) {
    if (ann) cur.annotations.push({ node: nid, name, text: ann });
    for (const v of c.matchAll(/var\(--([^,)]+)/g)) cur.colors.add(v[1]);
    for (const f of c.matchAll(/font-\['([^']+)'\]/g)) cur.fonts.add(f[1]);
    for (const s of c.matchAll(/text-\[(\d+(?:\.\d+)?px)\]/g)) cur.fonts.add(`size:${s[1]}`);
    if (tag === "img") {
      const ref = attrs.match(/src=\{(\w+)\}/)?.[1];
      const u = ref ? (consts[ref] ?? null) : null;
      const f = u ? (amap[u] ?? "?") : "?";
      const parent = stack[stack.length - 1] ?? { id: "", name: "", style: "" };
      const pc = parent.classes ?? "";
      const w = pc.match(/\bw-\[(\d+(?:\.\d+)?)px\]/)?.[1];
      const h = pc.match(/\bh-\[(\d+(?:\.\d+)?)px\]/)?.[1];
      const sz = pc.match(/\bsize-\[(\d+(?:\.\d+)?)px\]/)?.[1];
      const dims = sz ? `${sz}x${sz}` : `${w ?? "?"}x${h ?? "?"}`;
      const entry = { node: parent.id, name: parent.name, dims, file: f, url: u };
      (f.endsWith(".svg") ? cur.icons : cur.images).push(entry);
    }
  }
  node.classes = c;
  if (!selfc) {
    stack.push(node);
    depth += 1;
  }
}

// Sort by code point, not by UTF-16 unit.
const byCodePoint = (a, b) => {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i].codePointAt(0) - y[i].codePointAt(0);
  }
  return x.length - y.length;
};
for (const s of sections) {
  s.colors = [...s.colors].sort(byCodePoint);
  s.fonts = [...s.fonts].sort(byCodePoint);
}

// ASCII-only JSON with one-space indent.
const asciiJson = (v) =>
  JSON.stringify(v, null, 1).replace(/[-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
writeFileSync(outJson, asciiJson(sections));

// A quoted section name: single quotes unless the name has one and no double quote.
const quoted = (s) => {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(new RegExp(q, "g"), `\\${q}`);
  return q + body + q;
};

// A node with no id prints as None in the Markdown, as it always has.
const id = (v) => v ?? "None";

const L = [`# ${bp} spec — auto-distilled from raw get_design_context (verbatim copy, in document order)\n`];
for (const s of sections) {
  const box = s.classes.match(/\bh-\[(\d+(?:\.\d+)?)px\]/)?.[1] ?? "?";
  const top = s.classes.match(/\btop-\[(\d+(?:\.\d+)?)px\]/)?.[1] ?? "?";
  L.push(`\n## ${String(s.index).padStart(2, "0")}. \`${id(s.id)}\` ${quoted(s.name)}  (h=${box} top=${top})\n`);
  if (s.annotations.length) {
    L.push(`**Annotations:** ${s.annotations.map((a) => `[${id(a.name || a.node)}] ${a.text}`).join(" | ")}\n`);
  }
  L.push("**Copy:**");
  for (const c of s.copy) L.push(`- ${c.text}  ⟨${id(c.node)} ${c.style}⟩`);
  if (s.images.length) {
    L.push("\n**Image slots:**");
    for (const i of s.images) L.push(`- ${id(i.name || i.node)} ${i.dims} → ${i.file}`);
  }
  if (s.icons.length) {
    L.push("\n**Icons/vectors:**");
    for (const i of s.icons) L.push(`- ${id(i.name || i.node)} ${i.dims} → ${i.file}`);
  }
  L.push(`\n**Type sizes:** ${s.fonts.join(", ")}`);
  L.push(`**Color vars:** ${s.colors.join(", ")}`);
}
writeFileSync(outMd, L.join("\n"));

const sum = (k) => sections.reduce((n, s) => n + s[k].length, 0);
console.log(`${bp}: ${sections.length} sections; copy lines=${sum("copy")}; images=${sum("images")}; icons=${sum("icons")}`);
