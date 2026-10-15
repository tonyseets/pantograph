#!/usr/bin/env node
// Record real Figma REST responses for the figpipe tests. Read-only: GET requests only,
// through the shared client. Scrubs signed URLs, avatar URLs and emails before writing.
// usage: node tests/figpipe/record-fixtures.mjs <file-key> <page-id> <small-node-id> [stale-key] [out-dir]
//        node tests/figpipe/record-fixtures.mjs <file-key> --watch <node-id,node-id> [out-dir]
//        (watched sections at full depth, for the watch tests: nodes-watch.json)
//        node tests/figpipe/record-fixtures.mjs <file-key> --components <frame-id> <set-id,set-id> <components-page-id> [out-dir]
//        (a frame, some of the component sets behind it and the page that lists the file's sets,
//        for the components tests: nodes-contact.json, nodes-contact-sets.json, file-pages.json,
//        nodes-components-page-d2.json)
// The token comes from FIGMA_TOKEN_REF (default file:~/.config/figma/pat) and is never written.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../../skills/figma-transpose/scripts/figma-rest.mjs";

const argv = process.argv.slice(2);
const watchAt = argv.indexOf("--watch");
const watchIds = watchAt >= 0 ? argv.splice(watchAt, 2)[1]?.split(",").filter(Boolean) : null;
const compAt = argv.indexOf("--components");
const comp = compAt >= 0 ? argv.splice(compAt, 4).slice(1) : null;
const [key, page, small, stale, outArg] = watchIds || comp ? [argv[0], null, null, null, argv[1]] : argv;
if (!key || (comp && comp.length < 3) || (!watchIds && !comp && (!page || !small))) {
  console.error("usage: record-fixtures.mjs <file-key> <page-id> <small-node-id> [stale-key] [out-dir]");
  process.exit(2);
}
const out = outArg ?? new URL("./fixtures/tern/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const client = createClient({ tokenRef: process.env.FIGMA_TOKEN_REF, onEvent: (e) => e.type === "rate_limited" && console.error(`429, waiting ${e.wait_s}s`) });

// Signed storage URLs carry credentials in the query string; avatars and emails are personal.
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "email") o[k] = "user@example.invalid";
      else if (k === "img_url") o[k] = "https://example.invalid/avatar.png";
      else o[k] = scrub(x);
    }
    return o;
  }
  // Any URL outside figma.com (S3 renders, thumbnails, signed links) is replaced.
  if (typeof v === "string" && /^https?:\/\//.test(v) && !/^https:\/\/(api|www)\.figma\.com\//.test(v)) return "https://example.invalid/scrubbed";
  return v;
}
const save = (name, data) => {
  const s = JSON.stringify(scrub(data));
  if (/figd_[A-Za-z0-9_-]{8,}/.test(s)) throw new Error(`refusing to write ${name}: it looks like it holds a token`);
  writeFileSync(join(out, name), s);
  console.log(`${name} ${s.length} bytes`);
};

if (watchIds) {
  save("nodes-watch.json", await client.nodes(key, watchIds));
  process.exit(0);
}
if (comp) {
  const [frame, sets, compPage] = comp;
  save("nodes-contact.json", await client.nodes(key, [frame]));
  save("nodes-contact-sets.json", await client.nodes(key, sets.split(",").filter(Boolean)));
  // The page list only: ids, names and types, as the component catalogue reads it.
  const file = await client.file(key, { depth: 1 });
  save("file-pages.json", { name: file.name, version: file.version, document: { id: file.document.id, name: file.document.name, type: file.document.type, children: file.document.children.map((p) => ({ id: p.id, name: p.name, type: p.type })) } });
  save("nodes-components-page-d2.json", await client.nodes(key, [compPage], { depth: 2 }));
  process.exit(0);
}
save("me.json", await client.me());
save("meta.json", await client.meta(key));
if (stale) save("meta-stale.json", await client.meta(stale));
save("nodes-page-d2.json", await client.nodes(key, [page], { depth: 2 }));
save("comments.json", await client.comments(key));
save("versions.json", await client.versions(key));
save("nodes-small.json", await client.nodes(key, [small]));
save("images-small.json", await client.images(key, [small], { scale: 2 }));
console.log(`rate limit type: ${client.info.rate_limit_type ?? "unknown"}, plan tier: ${client.info.plan_tier ?? "unknown"}`);
