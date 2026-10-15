#!/usr/bin/env node
// Figma REST read tools: the one copy used by interactive sessions and by figpipe.
// Read-only (GET), with 429 backoff (Retry-After, default 30 s, capped at 120 s).
//
// usage: node figma-read.mjs <command> [args]
//   meta <file-key>                                 file name, last edit, editor, your role
//   identity <file-key> [<other-key>...]            which same-name file was edited last
//   ready <file-key> <page-id> [--depth 2]          nodes marked ready for dev under a page
//   nodes <file-key> <id,id> [--depth N] --out f    save /nodes JSON verbatim (full depth by default)
//   tree <nodes.json> [node-id] [max-depth]         one line per node: geometry, layout, paints, text
//   copy <nodes.json> [node-id] [--out copy.md]     every visible text node, verbatim, JSON-quoted
//   sdiff <old.json> <new.json> [old-id] [new-id]   structural diff of two pulls (visible nodes only)
//   render <file-key> <id,id> <out-dir> [--scale 2] [--format png]   2x renders, named by node id
//   comments <file-key> [--node <id>] [--out f]     comments with pins and whole threads
//   versions <file-key>                             version history, named versions marked
//   components <file-key> <node-id> <out-dir> [--from nodes.json] [--pages "A,B"] [--scale 3] [--cache dir]
//                                                   the component sets behind a frame: every variant, the ones
//                                                   the frame does not show, 3x renders, elements with no component
//   find <nodes.json> <text> [node-id]              nodes whose name or text holds <text>, with where they sit
//
// The token comes from --token-ref or FIGMA_TOKEN_REF (file:, keychain:, op:, env:),
// default file:~/.config/figma/pat. It is never printed.
// Component sets are kept per file version in --cache or FIGMA_COMPONENTS_CACHE, default ~/.cache/figma-read/components.
// No dependencies. Needs Node 18 or newer.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createClient, renderNodes } from "./figma-rest.mjs";
import { docOf, findNode, treeLines, flatLines, unifiedDiff, changedLineCount, copyMarkdown, devStatusNodes, nodeFileId, describe } from "./figma-nodes.mjs";
import { componentStore, collectComponents, componentsTable } from "./figma-components.mjs";

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  else pos.push(argv[i]);
}
const [cmd, ...args] = pos;
const usage = () => {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(3, 23).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
};
if (!cmd) usage();

const client = createClient({
  tokenRef: flags["token-ref"] ?? process.env.FIGMA_TOKEN_REF,
  onEvent: (e) => e.type === "rate_limited" && console.error(`rate limited on ${e.path}, waiting ${e.wait_s}s`),
});
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const save = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 1));
  console.error(`wrote ${p}`);
};
const pick = (p, id) => {
  const d = loadJson(p);
  const root = docOf(d);
  const n = id ? findNode(root, id) : root;
  if (!n) throw new Error(`node ${id} is not in ${p}`);
  return n;
};

try {
  switch (cmd) {
    case "meta": {
      const m = (await client.meta(args[0])).file;
      console.log(JSON.stringify({ name: m.name, folder: m.folder_name, last_touched_at: m.last_touched_at, last_touched_by: m.last_touched_by?.handle, role: m.role, link_access: m.link_access, version: m.version }, null, 1));
      break;
    }
    case "identity": {
      const rows = [];
      for (const k of args) {
        const m = (await client.meta(k)).file;
        rows.push({ key: k, name: m.name, folder: m.folder_name, last_touched_at: m.last_touched_at, last_touched_by: m.last_touched_by?.handle, role: m.role });
      }
      rows.sort((a, b) => String(b.last_touched_at).localeCompare(String(a.last_touched_at)));
      rows.forEach((r, i) => (r.verdict = i === 0 ? "edited most recently" : "older"));
      console.log(JSON.stringify(rows, null, 1));
      break;
    }
    case "ready": {
      const [key, page] = args;
      const resp = await client.nodes(key, [page], { depth: Number(flags.depth ?? 2) });
      for (const r of devStatusNodes(docOf(resp, page))) console.log(`${r.status}\t${r.id}\t${[...r.path, r.name].join(" > ")}${r.description ? `\t${JSON.stringify(r.description)}` : ""}`);
      break;
    }
    case "nodes": {
      const [key, ids] = args;
      if (!flags.out) usage();
      const resp = await client.nodes(key, ids.split(","), { depth: flags.depth ? Number(flags.depth) : undefined, geometry: flags.geometry });
      save(flags.out, resp);
      break;
    }
    case "tree":
      console.log(treeLines(pick(args[0], args[1]), args[2] ? Number(args[2]) : Infinity).join("\n"));
      break;
    case "copy": {
      const md = copyMarkdown(pick(args[0], args[1]));
      if (flags.out) save(flags.out, md);
      else console.log(md);
      break;
    }
    case "sdiff": {
      const [a, b, ida, idb] = args;
      const d = unifiedDiff(flatLines(pick(a, ida)), flatLines(pick(b, idb ?? ida)), { from: a, to: b });
      console.log(d || "no structural changes");
      console.error(`${changedLineCount(d)} changed lines`);
      break;
    }
    case "render": {
      const [key, ids, outDir] = args;
      const jobs = ids.split(",").map((id) => ({ id, path: join(outDir, `${nodeFileId(id)}@${flags.scale ?? 2}x.${flags.format ?? "png"}`) }));
      const res = await renderNodes(client, key, jobs, { scale: Number(flags.scale ?? 2), format: flags.format ?? "png" });
      for (const [id, p] of Object.entries(res)) console.log(`${id}\t${p ?? "no image (hidden, empty or too large)"}`);
      break;
    }
    case "comments": {
      const all = (await client.comments(args[0])).comments ?? [];
      const roots = new Map();
      for (const c of all) if (!c.parent_id) roots.set(c.id, { ...c, replies: [] });
      for (const c of all) if (c.parent_id) roots.get(c.parent_id)?.replies.push(c);
      let threads = [...roots.values()];
      if (flags.node) threads = threads.filter((t) => t.client_meta?.node_id === flags.node);
      const out = threads.map((t) => ({
        id: t.id,
        node_id: t.client_meta?.node_id ?? null,
        resolved: !!t.resolved_at,
        messages: [t, ...t.replies.sort((x, y) => x.created_at.localeCompare(y.created_at))].map((m) => ({ id: m.id, by: m.user?.handle, at: m.created_at, text: m.message })),
      }));
      if (flags.out) save(flags.out, out);
      else console.log(JSON.stringify(out, null, 1));
      break;
    }
    case "versions": {
      const v = (await client.versions(args[0])).versions ?? [];
      for (const x of v) console.log(`${x.created_at}\t${x.id}\t${x.user?.handle ?? ""}\t${x.label ? `named: ${JSON.stringify(x.label)}` : "autosave"}`);
      break;
    }
    case "components": {
      const [key, id, outDir] = args;
      if (!key || !id || !outDir) usage();
      // --from reuses a pull already on disk; without it the frame is read once, at full depth.
      const resp = flags.from ? loadJson(flags.from) : await client.nodes(key, [id]);
      if (!resp?.nodes?.[id]?.document) throw new Error(`node ${id} is not in ${flags.from ?? key}`);
      const store = componentStore({ client, scale: Number(flags.scale ?? 3), ...(flags.cache ? { cacheDir: flags.cache } : {}) });
      const index = await collectComponents({ store, fileKey: key, resp, nodeId: id, outDir, pages: flags.pages ? String(flags.pages).split(",").map((x) => x.trim()).filter(Boolean) : [] });
      console.log(componentsTable(index));
      console.error(`wrote ${join(outDir, "index.json")} and ${join(outDir, "components.md")} (${index.calls} Figma calls, ${store.stats.cached} sets from the cache)`);
      break;
    }
    case "find": {
      const [file, text, id] = args;
      if (!file || !text) usage();
      const root = pick(file, id);
      const want = text.toLowerCase();
      const o = [root.absoluteBoundingBox?.x ?? 0, root.absoluteBoundingBox?.y ?? 0];
      const walk = (n, path) => {
        if (`${n.name ?? ""}\n${n.characters ?? ""}`.toLowerCase().includes(want)) console.log(`${describe(n, o)}\n    in ${path.join(" > ") || "(top)"}`);
        for (const c of n.children ?? []) walk(c, [...path, n.name]);
      };
      walk(root, []);
      break;
    }
    default:
      usage();
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
