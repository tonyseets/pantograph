#!/usr/bin/env node
// Assemble a Figma-vs-build review page from a JSON config.
//
//   node build_page.mjs config.json [-o out.html] [--template template.html]
//
// Single page:  the config IS the page.
// Multi page:   {"title": …, "pages": [{"id": …, "label": …, …page config…}, …]}
//               renders one artifact with a tab switcher; ids are prefixed per page.
//
// Crops build sections out of the full-page capture by bounding box, crops Figma references
// from crisp per-section renders when they exist and from the whole-frame render otherwise,
// encodes everything as progressive JPEG data URIs at native width, and fills template.html.
// Re-running it after a fresh capture rebuilds the page.
//
// Needs Node 18 or newer and `npm i sharp` in the working directory.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WARN_MB = 14.0;

function die(msg) {
  console.error(`build_page: ${msg}`);
  process.exit(1);
}

// sharp is looked up from the working directory first, where `npm i sharp` puts it, and then
// from beside this script. A bare import would only ever look beside the script.
async function load(name) {
  for (const from of [join(process.cwd(), "_.js"), fileURLToPath(import.meta.url)]) {
    try {
      const mod = await import(pathToFileURL(createRequire(from).resolve(name)).href);
      return mod.default ?? mod;
    } catch {}
  }
  die(`${name} is not installed. Run \`npm i ${name}\` in the working directory.`);
}
const sharp = await load("sharp");

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

// An image is its source file plus an optional crop. Pixels are only read when it is encoded.
async function openImage(path) {
  const { width, height } = await sharp(path, { limitInputPixels: false }).metadata();
  return { path, width, height, region: null };
}

// Crop by (left, top, right, bottom), clamped to the image.
function crop(im, left, top, right, bottom) {
  const base = im.region ?? { left: 0, top: 0 };
  const l = Math.max(0, Math.min(left, im.width));
  const t = Math.max(0, Math.min(top, im.height));
  const w = Math.max(1, Math.min(right, im.width) - l);
  const h = Math.max(1, Math.min(bottom, im.height) - t);
  return { path: im.path, width: w, height: h, region: { left: base.left + l, top: base.top + t, width: w, height: h } };
}

async function uri(im, width = null, quality = 85) {
  let pipe = sharp(im.path, { limitInputPixels: false });
  if (im.region) pipe = pipe.extract(im.region);
  if (width && im.width !== width) {
    pipe = pipe.resize(width, Math.max(1, Math.trunc((im.height * width) / im.width)), { kernel: "lanczos3", fit: "fill" });
  }
  const buf = await pipe.removeAlpha().jpeg({ quality, progressive: true, optimiseCoding: true }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function imgTag(im, alt, width = null, quality = 85, lazy = true) {
  const lz = lazy ? ' loading="lazy"' : "";
  return `<img${lz} src="${await uri(im, width, quality)}" alt="${esc(alt)}">`;
}

async function figure(caption, im, alt, width = null, quality = 85, lazy = true) {
  return `<figure><figcaption>${esc(caption)}</figcaption>${await imgTag(im, alt, width, quality, lazy)}</figure>`;
}

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Shallow-merge dict-of-dicts defaults under a page config.
function merge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isDict(v) && isDict(out[k]) ? { ...out[k], ...v } : v;
  }
  return out;
}

// Remove a whole <h3 id="…anchor">…</h3> block up to the next <h3 or the end.
const dropBlock = (page, anchor) => page.replace(new RegExp(`<h3 id="[^"]*${anchor}">[\\s\\S]*?(?=<h3|$)`, "g"), "");

// Files matching a pattern with * and ? in its last path segment.
function glob(pattern) {
  const dir = dirname(pattern);
  const rx = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => rx.test(f)).map((f) => join(dir, f));
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Return the filled per-page HTML for one page config.
async function renderPage(cfg, rel, tpl, prefix = "", eagerWhole = true) {
  const q = cfg.quality ?? 85;
  const d = cfg.desktop ?? {}, fg = cfg.figma ?? {}, mb = cfg.mobile ?? {};

  const buildPng = rel(d.png) || die("desktop.png is required");
  const rectsPath = rel(d.rects) || die("desktop.rects is required");
  const build = await openImage(buildPng);
  const rects = JSON.parse(readFileSync(rectsPath, "utf8"));
  const desktopWidth = d.width ?? build.width;

  const tag = d.sectionTag;
  const kids = rects.sections.filter((s) => !tag || s.tag === tag);

  const wholeRender = rel(fg.wholeRender);
  const figfull = wholeRender ? await openImage(wholeRender) : null;
  const frameW = fg.frameWidth ?? desktopWidth;
  const fscale = figfull ? figfull.width / frameW : 1.0;
  const secDir = rel(fg.sectionDir);
  const fq = fg.quality ?? q;
  const buildOnly = cfg.buildOnly ?? false;

  const cards = [], toc = [];
  let auto = 0;
  for (const s of cfg.sections ?? []) {
    const sid = s.id;
    const name = s.name ?? sid;
    const anchor = `${prefix}${sid}`;

    const r = s.rect ?? null;
    let br;
    if (r === "footer") br = rects.footer;
    else if (r === "header") br = rects.header;
    else if (Number.isInteger(r)) br = kids.at(r);
    else {
      if (auto >= kids.length) die(`section "${sid}" has no build rect left; give it an explicit "rect"`);
      br = kids[auto];
      auto += 1;
    }
    if (!br) die(`section "${sid}" resolved to no build rect`);
    const top = Math.max(0, br.top);
    const bim = crop(build, 0, top, build.width, top + br.height);

    const render = s.render;
    const cand =
      render && isAbsolute(String(render))
        ? rel(render)
        : secDir
          ? join(secDir, render || `${sid}.png`)
          : render
            ? rel(render)
            : null;
    let fim = null, flabel = "", fwidth = null;
    if (cand && existsSync(cand)) {
      fim = await openImage(cand);
      flabel = "Figma";
      fwidth = Math.min(frameW, fim.width);
    } else if (figfull !== null && has(s, "y") && has(s, "h")) {
      fim = crop(figfull, 0, Math.trunc(s.y * fscale), figfull.width, Math.trunc((s.y + s.h) * fscale));
      flabel = "Figma · low-res render";
    } else if (!buildOnly) {
      die(
        `section "${sid}" has neither a render on disk nor figma y/h to crop ` +
          '(set "buildOnly": true for a page with no Figma references)',
      );
    }

    const fh = s.h;
    const dims = fh ? `${fh}px → ${br.height}px` : `${br.height}px`;
    const body =
      fim === null
        ? `<div class="pair one">${await figure("Build", bim, `${name}, build`, null, q)}</div>`
        : `<div class="pair">${await figure(flabel, fim, `${name}, Figma`, fwidth, fq)}\n` +
          `${await figure("Build", bim, `${name}, build`, null, q)}</div>`;

    const notes = (s.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("");
    const status = s.status ? `<span class="pill">${esc(s.status)}</span>` : "";
    cards.push(
      `<section class="card" id="${esc(anchor)}">\n` +
        `<header><h2>${esc(name)}</h2>${status}` +
        `<span class="dim">${dims}</span></header>\n` +
        `${body}\n` +
        `<ul>${notes}</ul></section>`,
    );
    toc.push(`<a href="#${esc(anchor)}">${esc(s.short ?? name)}</a>`);
  }

  const wholeW = d.wholeWidth ?? 720;
  const wholeQ = d.wholeQuality ?? 78;
  let pair = "", fullMod = "";
  if (figfull !== null) {
    pair += await figure("Figma", figfull, "Figma frame", Math.min(wholeW, figfull.width), wholeQ, !eagerWhole);
  } else {
    fullMod = " one";
  }
  pair += await figure("Build", build, `Build at ${desktopWidth}`, wholeW, wholeQ, !eagerWhole);

  const mobW = mb.width ?? 390;
  const mobQ = mb.quality ?? 80;
  let strip = "";
  const trailing = (p) => parseInt(p.match(/(\d+)\.png$/)[1], 10);
  const chunks = mb.chunks ? glob(rel(mb.chunks)).sort((a, b) => trailing(a) - trailing(b)) : [];
  if (chunks.length) {
    for (const [i, c] of chunks.entries()) {
      strip += await imgTag(await openImage(c), `Build at ${mobW}, part ${i + 1}`, null, mobQ);
    }
  } else if (mb.png) {
    const mob = await openImage(rel(mb.png));
    const n = mb.split ?? 3;
    const step = Math.floor(mob.height / n);
    for (let i = 0; i < n; i++) {
      const piece = crop(mob, 0, i * step, mob.width, i < n - 1 ? (i + 1) * step : mob.height);
      strip += await imgTag(piece, `Build at ${mobW}, part ${i + 1}`, mobW, mobQ);
    }
  }
  if (strip) toc.push(`<a href="#${prefix}mobile">Mobile</a>`);
  toc.push(`<a href="#${prefix}findings">Findings</a>`);

  const pills = (cfg.pills ?? []).map((p) => `<span class="pill${p.tone ? ` ${p.tone}` : ""}">${esc(p.text)}</span>`).join("");
  const findings = (cfg.findings ?? []).map((f) => `<tr><td>${f.area}</td><td>${f.state}</td></tr>`).join("\n");
  const questions = (cfg.questions ?? []).map((x) => `<li>${x}</li>`).join("\n");
  const nxt = (cfg.next ?? []).map((x) => `<li>${x}</li>`).join("\n");
  let note = cfg.sectionNote ?? "";
  if (buildOnly && !note) note = "No Figma renders on disk for this page, so each card shows the build alone.";

  let page = tpl;
  const fills = {
    "{{PREFIX}}": prefix,
    "{{LEAD}}": cfg.lead ?? "",
    "{{PILLS}}": pills,
    "{{TOC}}": toc.join(""),
    "{{DESKTOP_WIDTH}}": String(desktopWidth),
    "{{MOBILE_WIDTH}}": String(mobW),
    "{{WHOLE_PAIR}}": pair,
    "{{FULL_MOD}}": fullMod,
    "{{SECTION_NOTE}}": note,
    "{{CARDS}}": cards.join("\n"),
    "{{MOBILE_NOTE}}": cfg.mobileNote ?? "",
    "{{MOBILE_STRIP}}": strip,
    "{{FINDINGS}}": findings,
    "{{QUESTIONS}}": questions,
    "{{NEXT}}": nxt,
  };
  for (const [k, v] of Object.entries(fills)) page = page.replaceAll(k, () => v);

  if (!strip) page = page.replace(new RegExp(`<h3 id="${prefix}mobile">[\\s\\S]*?(?=<h3)`, "g"), "");
  if (!questions) page = dropBlock(page, "questions");
  if (!nxt) page = dropBlock(page, "next");
  if (!findings) page = page.replace(/<h3 id="[^"]*findings">[\s\S]*?<\/table><\/div>/g, "");
  return page.replace(/<p class="lead">\s*<\/p>/g, "");
}

async function main() {
  const argv = process.argv.slice(2);
  const args = { config: null, out: null, template: join(HERE, "template.html") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a.startsWith("--out=")) args.out = a.slice(6);
    else if (a === "--template") args.template = argv[++i];
    else if (a.startsWith("--template=")) args.template = a.slice(11);
    else if (a === "-h" || a === "--help") {
      console.log("usage: build_page.mjs [-h] [-o OUT] [--template TEMPLATE] config");
      process.exit(0);
    } else if (args.config === null) args.config = a;
    else die(`unrecognized argument: ${a}`);
  }
  if (!args.config) die("usage: build_page.mjs [-h] [-o OUT] [--template TEMPLATE] config");

  const cfg = JSON.parse(readFileSync(args.config, "utf8"));
  const base = dirname(resolve(args.config));
  const rel = (p) => (!p ? p : isAbsolute(p) ? p : join(base, p));

  const raw = readFileSync(args.template, "utf8");
  const m = raw.match(/<!--PAGE-->([\s\S]*?)<!--\/PAGE-->/);
  if (!m) die("template.html is missing its <!--PAGE--> partial");
  const pageTpl = m[1].trim();
  const shell = raw.slice(0, m.index).trimEnd() + raw.slice(m.index + m[0].length);

  const multi = has(cfg, "pages");
  const defaults = cfg.defaults ?? {};
  let pages;
  if (multi) {
    pages = cfg.pages.map((p) => merge(defaults, p));
    pages.forEach((p, i) => {
      p.id ??= `page${i + 1}`;
      p.label ??= p.title ?? p.id;
    });
  } else {
    const one = merge(defaults, cfg);
    one.id = cfg.id ?? "page";
    one.label = cfg.title ?? "Page";
    one.lead = ""; // the lead lives in the shell for a single page
    pages = [one];
  }

  const bodies = [], tabs = [], sizes = [];
  for (const [i, p] of pages.entries()) {
    const pid = String(p.id).replace(/[^A-Za-z0-9_-]/g, "-");
    const prefix = multi ? `${pid}-` : "";
    let body = await renderPage(p, rel, pageTpl, prefix, i === 0);
    if (multi) {
      const hid = i === 0 ? "" : " hidden";
      body = `<section class="page" id="page-${pid}" role="tabpanel" aria-labelledby="tab-${pid}"${hid}>\n${body}\n</section>`;
      tabs.push(
        `<button class="tab" type="button" role="tab" id="tab-${pid}" data-page="${pid}" ` +
          `aria-controls="page-${pid}" aria-selected="${i === 0 ? "true" : "false"}" ` +
          `tabindex="${i === 0 ? 0 : -1}">${esc(p.label)}</button>`,
      );
    }
    bodies.push(body);
    sizes.push([p.label, Buffer.byteLength(body)]);
  }

  const mobWidths = pages.map((p) => p.mobile?.width ?? 390);
  let page = shell;
  const fills = {
    "{{MOBILE_WIDTH}}": String(mobWidths.length ? Math.max(...mobWidths) : 390),
    "{{TITLE}}": esc(cfg.title ?? pages[0].label),
    "{{LEAD}}": cfg.lead ?? "",
    "{{TABS}}": multi ? `<div class="tabs" role="tablist" aria-label="Pages">${tabs.join("")}</div>` : "",
    "{{PAGES}}": bodies.join("\n"),
  };
  for (const [k, v] of Object.entries(fills)) page = page.replaceAll(k, () => v);
  page = page.replace(/<p class="lead">\s*<\/p>/g, "");
  if (!multi) page = page.replace(/<script data-tabs>[\s\S]*?<\/script>/g, "");

  const out = args.out || rel(cfg.out ?? "review.html");
  writeFileSync(out, page);

  const total = statSync(out).size / 1e6;
  if (multi) {
    for (const [label, n] of sizes) console.log(`  ${String(label).padEnd(24)} ${(n / 1e6).toFixed(1).padStart(5)} MB`);
  }
  const cardCount = bodies.reduce((n, b) => n + b.split('class="card"').length - 1, 0);
  console.log(`wrote ${out}  ${total.toFixed(1)} MB  pages ${pages.length}  sections ${cardCount}`);
  if (total > WARN_MB) {
    console.error(
      `WARNING: ${total.toFixed(1)} MB, over the ${WARN_MB.toFixed(0)} MB line and near the 16 MB Artifact cap — ` +
        "narrow the whole-page pairs or drop a mobile strip to 1x",
    );
  }
}

await main();
