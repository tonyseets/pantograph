// Watched sections ([[figma.files.watch]]): designs still in progress that the user has already
// pre-built locally. figpipe keeps those builds in step with the designer. A real design change, a
// comment from someone else or a ready mark becomes a trigger, batched like ready items, and the
// batch updates the existing build on figma/<lane>, started from the watch's branch. Each change is
// diffed against the baseline the build was made from. Watched sections are always the user's.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderNodes } from "../../skills/figma-transpose/scripts/figma-rest.mjs";
import { docOf, devStatusNodes, shapeFingerprint, copyMarkdown, copyBySection, nodeFileId, slugify } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";
import { nowIso } from "./db.mjs";
import { paths } from "./paths.mjs";
import { watchLaneName, rewriteWatchNode } from "./config.mjs";

export const BASELINE = "baseline-";
export const isBaselineId = (id) => String(id ?? "").startsWith(BASELINE);

// Every watched section of a project (or of one file): [{ ...entry, file_key, lane }].
export function watchesOf(config, fileKey = null) {
  return config.figma.files.filter((f) => !fileKey || f.key === fileKey).flatMap((f) => (f.watch ?? []).map((w) => ({ ...w, file_key: f.key, lane: watchLaneName(w) })));
}

export const watchRows = (db, project, fileKey) => new Map(db.all("SELECT * FROM watches WHERE project = ? AND file_key = ?", project, fileKey).map((r) => [r.node_id, r]));

// Has a build been made from this section: configured as built, or a batch built it since.
export function isBuilt(db, project, w) {
  if (w.built) return true;
  return !!db.get("SELECT 1 AS x FROM ledger WHERE project = ? AND key = ? AND outcome IN ('applied', 'already_done') AND batch_id NOT LIKE 'baseline-%'", project, `node:${w.file_key}:${w.node}`);
}

// What an item carries in items.watch and batch.json: where the build lives and how to see it.
export function watchSpec(db, config, w) {
  return { node: w.node, name: w.name, lane: w.lane, branch: w.branch, route: w.route || null, page: w.page || null, notes: w.notes || null, built: isBuilt(db, config.project.slug, w) };
}

// items.watch as an object, or null.
export function watchOfItem(item) {
  const v = item?.watch;
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// The watched section a node is: its own id, or a node with the watched section's Figma name (the
// designer copied the finished section to the ready page, which gives it a new id). A copy under
// another spelling or with a language tag ("Location_EN") is followed by followMoved in reconcile.
export function watchForNode(db, config, fileKey, nodeId, name = null) {
  const ws = watchesOf(config, fileKey);
  const byId = ws.find((w) => w.node === nodeId);
  if (byId || !name) return byId ?? null;
  const rows = watchRows(db, config.project.slug, fileKey);
  const key = String(name).trim().toLowerCase();
  return ws.find((w) => (rows.get(w.node)?.figma_name ?? "").trim().toLowerCase() === key) ?? null;
}

// The names a watched section answers to: the one in the config and the layer's name in Figma.
export const watchNames = (w, row) => [...new Set([w.name, row?.figma_name].filter(Boolean))];

// Node id -> the watched section it sits in, from node_areas (filled at every watch read and seed).
export function watchedAreas(db, project, fileKey, watches) {
  const out = new Map(watches.map((w) => [w.node, w]));
  if (!watches.length) return out;
  const byNode = new Map(watches.map((w) => [w.node, w]));
  const rows = db.all(`SELECT node_id, area_id FROM node_areas WHERE project = ? AND file_key = ? AND area_id IN (${watches.map(() => "?").join(",")})`, project, fileKey, ...watches.map((w) => w.node));
  for (const r of rows) if (!out.has(r.node_id)) out.set(r.node_id, byNode.get(r.area_id));
  return out;
}

// Map every node inside the section to it, so a comment pinned anywhere inside resolves. A savepoint,
// not a transaction: a dry-run tick already holds one.
export function indexArea(db, project, fileKey, w, doc) {
  const ids = [];
  const collect = (n) => {
    ids.push(n.id);
    for (const c of n.children ?? []) collect(c);
  };
  collect(doc);
  db.exec("SAVEPOINT watch_area");
  try {
    for (const id of ids) db.run("INSERT OR REPLACE INTO node_areas (project, file_key, node_id, area_id, area_name) VALUES (?, ?, ?, ?, ?)", project, fileKey, id, w.node, w.name);
    db.exec("RELEASE watch_area");
  } catch (e) {
    db.exec("ROLLBACK TO watch_area");
    db.exec("RELEASE watch_area");
    throw e;
  }
  return ids.length;
}

// The design of a section, ignoring where it sits on the canvas and its ready marks: a ready mark
// is a handoff, not a design change.
export function designFingerprint(doc) {
  const strip = (n) => {
    if (Array.isArray(n)) return n.map(strip);
    if (!n || typeof n !== "object") return n;
    const o = {};
    for (const [k, v] of Object.entries(n)) if (k !== "devStatus") o[k] = strip(v);
    return o;
  };
  return shapeFingerprint(strip(doc));
}

// The design without what a move changes: node ids and references to them, ready marks, the
// section's own name, where it sits, and render bounds (they shift by fractions of a pixel with the
// canvas position). Two sections with the same portable fingerprint are one design under two ids.
const MOVES_WITH_IT = new Set(["id", "devStatus", "transitionNodeID", "destinationId", "guid", "absoluteRenderBounds"]);
export function portableFingerprint(doc) {
  const strip = (n, top) => {
    if (Array.isArray(n)) return n.map((x) => strip(x, false));
    if (!n || typeof n !== "object") return n;
    const o = {};
    for (const [k, v] of Object.entries(n)) if (!MOVES_WITH_IT.has(k) && !(top && k === "name")) o[k] = strip(v, false);
    return o;
  };
  return shapeFingerprint(strip(doc, true));
}

// How alike two sections are, 0 to 1: the share of visible layers (type and name) and texts they
// have in common. A moved section scores near 1 even after edits; another section scores low.
export function similarity(a, b) {
  const bag = (doc) => {
    const m = new Map();
    const add = (k) => m.set(k, (m.get(k) ?? 0) + 1);
    const walk = (n, top) => {
      if (n.visible === false) return;
      if (!top) add(`${n.type}:${n.name}`);
      if (n.type === "TEXT") add(`T:${n.characters ?? ""}`);
      for (const c of n.children ?? []) walk(c, false);
    };
    if (doc) walk(doc, true);
    return m;
  };
  const x = bag(a);
  const y = bag(b);
  let both = 0;
  let either = 0;
  for (const k of new Set([...x.keys(), ...y.keys()])) {
    both += Math.min(x.get(k) ?? 0, y.get(k) ?? 0);
    either += Math.max(x.get(k) ?? 0, y.get(k) ?? 0);
  }
  return either ? both / either : 0;
}

// The node a snapshot holds. A snapshot carried over to a section's new id still holds the node
// under its old one.
export function snapshotDoc(snap) {
  if (!snap?.path || !existsSync(snap.path)) return null;
  try {
    const json = JSON.parse(readFileSync(snap.path, "utf8"));
    return docOf(json, snap.node_id) ?? docOf(json);
  } catch {
    return null;
  }
}

// A section came back under a new node id: the new node takes over the old one's build history
// (ledger rows and snapshots), so the next change is a diff against what was built, and an
// ownership answer given for the old node. Nothing is removed from the old id.
export function adoptNode(db, project, fileKey, from, to) {
  db.run("INSERT OR IGNORE INTO snapshots (project, file_key, node_id, batch_id, deep_fingerprint, path, at, renders) SELECT project, file_key, ?, batch_id, deep_fingerprint, path, at, renders FROM snapshots WHERE project = ? AND file_key = ? AND node_id = ?", to, project, fileKey, from);
  db.run(
    "INSERT OR IGNORE INTO ledger (project, key, batch_id, item_id, outcome, branch, commits, fingerprint, deep_fingerprint, at) SELECT project, ?, batch_id, item_id, outcome, branch, commits, fingerprint, deep_fingerprint, at FROM ledger WHERE project = ? AND key = ?",
    `node:${fileKey}:${to}`, project, `node:${fileKey}:${from}`,
  );
  db.run("UPDATE ownership SET node_id = ? WHERE project = ? AND file_key = ? AND node_id = ?", to, project, fileKey, from);
}

// Follow a watched section to its new node: the watch row, the baseline, everything waiting for it
// and the config entry now point at `to` ({ id, name, page }). The config file is rewritten last
// (write = false in a dry run, where state rolls back too) and a failure there throws, so the
// caller can undo the state changes: config and state never disagree. The config object in memory
// is updated too.
export function repointWatch({ db, config, fileKey, watch, to, now, write = true }) {
  const project = config.project.slug;
  const from = watch.node;
  adoptNode(db, project, fileKey, from, to.id);
  db.run("DELETE FROM watches WHERE project = ? AND file_key = ? AND node_id = ?", project, fileKey, to.id);
  db.run(
    "UPDATE watches SET node_id = ?, figma_name = ?, moved_from = ?, moved_at = ?, page_name = ?, status = 'watching', warning = NULL WHERE project = ? AND file_key = ? AND node_id = ?",
    to.id, to.name, from, now, to.page ?? null, project, fileKey, from,
  );
  // What waits for the section follows it: changes seen on the old node, comments inside it, and a
  // ready mark already seen on the new one (now a pre-built handoff, and yours).
  for (const e of db.all("SELECT id, node_id, kind, payload FROM events WHERE project = ? AND file_key = ? AND status IN ('pending', 'needs_owner', 'out_of_scope') AND (node_id IN (?, ?) OR json_extract(payload, '$.watch') = ?)", project, fileKey, from, to.id, from)) {
    const p = JSON.parse(e.payload || "{}");
    if (p.manual) continue;
    const payload = { ...p, watch: to.id, ...(e.kind === "ready" ? { prebuilt: true } : {}), ...(e.kind === "comment" ? {} : { name: p.name ?? watch.name, figma_name: to.name, lane: watch.lane }) };
    db.run("UPDATE events SET node_id = ?, payload = ? WHERE id = ?", e.kind !== "comment" && e.node_id === from ? to.id : e.node_id, JSON.stringify(payload), e.id);
  }
  if (write && config._file && existsSync(config._file)) {
    const note = `figpipe ${now.slice(0, 10)}: "${watch.name}" moved in Figma, from ${from} to "${to.name}"${to.page ? ` on "${to.page}"` : ""}. The baseline is kept.`;
    if (!rewriteWatchNode(config._file, from, to.id, { page: to.page, note })) throw new Error(`no watch with node ${from} in ${config._file}`);
  }
  for (const f of config.figma.files.filter((x) => x.key === fileKey)) for (const w of f.watch ?? []) if (w.node === from) Object.assign(w, { node: to.id, ...(to.page ? { page: to.page } : {}) });
  return { from, to: to.id };
}

// Ready marks on the section itself or anywhere inside it.
export function readyNodesOf(doc) {
  const out = [];
  if (doc?.devStatus?.type === "READY_FOR_DEV") out.push({ id: doc.id, name: doc.name, description: doc.devStatus.description ?? "" });
  for (const r of devStatusNodes(doc ?? {})) if (r.status === "READY_FOR_DEV") out.push({ id: r.id, name: r.name, description: r.description });
  return out;
}

// Copy as diffable lines: one per visible text, prefixed with its breakpoint frame.
export function copyLines(doc) {
  if (!doc) return [];
  return copyBySection(doc).flatMap((s) => s.copy.map((t) => `${s.name}: ${JSON.stringify(t.text)}`));
}

// The snapshot a node's build was made from: the snapshot of the latest build in the ledger (a
// batch, or a watch baseline), else the latest watch baseline. null when there is neither.
export function buildSnapshot(db, project, fileKey, nodeId, excludeBatch = "") {
  const get = (batchId) => db.get("SELECT * FROM snapshots WHERE project = ? AND file_key = ? AND node_id = ? AND batch_id = ?", project, fileKey, nodeId, batchId);
  for (const l of db.all("SELECT batch_id FROM ledger WHERE project = ? AND key = ? AND outcome IN ('applied', 'already_done') AND batch_id != ? ORDER BY at DESC LIMIT 5", project, `node:${fileKey}:${nodeId}`, excludeBatch)) {
    const s = get(l.batch_id);
    if (s) return s;
  }
  return db.get("SELECT * FROM snapshots WHERE project = ? AND file_key = ? AND node_id = ? AND batch_id LIKE 'baseline-%' ORDER BY at DESC LIMIT 1", project, fileKey, nodeId) ?? null;
}

// Render jobs for a section: the node, then its visible child frames (the breakpoints), up to the cap.
export function renderJobs(doc, dir, { render_scale: scale, max_renders_per_item: max }) {
  if (!max) return [];
  const base = nodeFileId(doc.id);
  const jobs = [{ id: doc.id, role: "node", name: doc.name, width: Math.round(doc.absoluteBoundingBox?.width ?? 0), path: join(dir, "render", `00-${slugify(doc.name)}__${base}@${scale}x.png`) }];
  const kids = (doc.children ?? []).filter((c) => c.visible !== false && ["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(c.type));
  kids.slice(0, max - 1).forEach((c, i) =>
    jobs.push({ id: c.id, role: "child", name: c.name, width: Math.round(c.absoluteBoundingBox?.width ?? 0), path: join(dir, "render", `${String(i + 1).padStart(2, "0")}-${slugify(c.name)}__${nodeFileId(c.id)}@${scale}x.png`) }),
  );
  return jobs;
}

const stamp = (iso) => iso.replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");

// Record the design a watched section's build was made from: node JSON, verbatim copy and renders
// under ~/.figpipe/watch/<project>/<node>/<baseline id>/, a snapshot row, and (when it is built) a
// ledger row, so the next real change is a diff against it rather than a full rebuild. Figma reads
// only. Waiting changes for the section are cancelled: they are measured against this baseline now.
// owned: a ready section that is yours but not watched (figpipe watch baseline --all). It gets the
// snapshot and the ledger row, so it counts as built from this design; no watch row.
export async function seedWatch({ db, config, client, fileKey, watch, resp, clock = Date.now, fetchImpl, sleep, render = true, owned = false }) {
  const project = config.project.slug;
  const doc = docOf(resp, watch.node);
  if (!doc) throw new Error(`"${watch.name}" (${watch.node}) is not in Figma`);
  const at = nowIso(clock);
  let id = `${BASELINE}${stamp(at)}`;
  while (db.get("SELECT 1 AS x FROM snapshots WHERE project = ? AND file_key = ? AND node_id = ? AND batch_id = ?", project, fileKey, watch.node, id)) id += "b";
  const dir = join(paths().home, "watch", project, nodeFileId(watch.node), id);
  mkdirSync(dir, { recursive: true });
  const nodePath = join(dir, `node-${nodeFileId(watch.node)}.json`);
  writeFileSync(nodePath, JSON.stringify({ nodes: { [watch.node]: resp.nodes[watch.node] } }));
  writeFileSync(join(dir, "copy.md"), copyMarkdown(doc));
  const fp = shapeFingerprint(doc);
  const warnings = [];
  let calls = 0;
  let renders = [];
  const jobs = render ? renderJobs(doc, dir, config.extract) : [];
  if (jobs.length) {
    try {
      const res = await renderNodes(client, fileKey, jobs, { scale: config.extract.render_scale, fetchImpl, sleep });
      calls += Math.ceil(jobs.length / 6);
      renders = jobs.filter((j) => res[j.id]).map((j) => ({ node_id: j.id, role: j.role, name: j.name, width: j.width, path: res[j.id] }));
      if (renders.length < jobs.length) warnings.push(`"${watch.name}": Figma returned no image for ${jobs.length - renders.length} of ${jobs.length} frames (hidden, empty or too large)`);
    } catch (e) {
      if (e.kind === "rate_limit" || e.kind === "auth") throw e;
      warnings.push(`"${watch.name}": renders failed (${e.message}); the baseline has node JSON and copy only`);
    }
  }
  db.run("INSERT OR REPLACE INTO snapshots (project, file_key, node_id, batch_id, deep_fingerprint, path, at, renders) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", project, fileKey, watch.node, id, fp, nodePath, at, JSON.stringify(renders));
  const built = isBuilt(db, project, watch);
  if (built)
    db.run(
      "INSERT OR REPLACE INTO ledger (project, key, batch_id, item_id, outcome, branch, commits, fingerprint, deep_fingerprint, at) VALUES (?, ?, ?, NULL, 'already_done', ?, '[]', NULL, ?, ?)",
      project, `node:${fileKey}:${watch.node}`, id, watch.branch, fp, at,
    );
  // What waited for the section is measured against this baseline now: changes and ready marks seen
  // before it are settled. Comments stay.
  const settled = db.run(
    "UPDATE events SET status = 'cancelled', note = ? WHERE project = ? AND file_key = ? AND kind IN ('changed', 'ready') AND status IN ('pending', 'needs_owner') AND (node_id = ? OR json_extract(payload, '$.watch') = ?)",
    owned ? "a baseline was recorded: the build already has this design" : "a new baseline was recorded for the watched section", project, fileKey, watch.node, watch.node,
  ).changes;
  if (owned) {
    db.run("UPDATE nodes SET deep_fingerprint = ? WHERE project = ? AND file_key = ? AND node_id = ?", fp, project, fileKey, watch.node);
    return { id, fingerprint: fp, built, renders: renders.length, warnings, calls, dir, settled };
  }
  const status = readyNodesOf(doc).length ? "ready" : "watching";
  db.run(
    `INSERT INTO watches (project, file_key, node_id, name, figma_name, status, fingerprint, baseline_id, baseline_at, last_seen_at, warning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (project, file_key, node_id) DO UPDATE SET name = excluded.name, figma_name = excluded.figma_name, status = excluded.status, fingerprint = excluded.fingerprint,
       baseline_id = excluded.baseline_id, baseline_at = excluded.baseline_at, last_seen_at = excluded.last_seen_at, warning = NULL`,
    project, fileKey, watch.node, watch.name, doc.name, status, designFingerprint(doc), id, at, at,
  );
  indexArea(db, project, fileKey, watch, doc);
  return { id, fingerprint: fp, built, renders: renders.length, warnings, calls, dir, settled };
}

const fmtShort = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : null);

// What status shows per watched section: where it builds, its state, the last change figpipe saw,
// what waits and which batch has it.
export function watchView(db, config) {
  const project = config.project.slug;
  return watchesOf(config).map((w) => {
    const r = db.get("SELECT * FROM watches WHERE project = ? AND file_key = ? AND node_id = ?", project, w.file_key, w.node) ?? {};
    const waiting = db.get(
      "SELECT COUNT(*) AS n FROM events WHERE project = ? AND file_key = ? AND status = 'pending' AND role = 'trigger' AND (node_id = ? OR json_extract(payload, '$.watch') = ?)",
      project, w.file_key, w.node, w.node,
    ).n;
    const batch = db.get(
      `SELECT b.id, b.status FROM events e JOIN batches b ON b.id = e.batch_id
       WHERE e.project = ? AND e.file_key = ? AND (e.node_id = ? OR json_extract(e.payload, '$.watch') = ?) AND b.status IN ('ready', 'extracting', 'running', 'done', 'stuck')
       ORDER BY e.id DESC LIMIT 1`,
      project, w.file_key, w.node, w.node,
    );
    return {
      name: w.name, node: w.node, file_key: w.file_key, lane: w.lane, branch: w.branch, route: w.route || null, page: w.page || null,
      built: isBuilt(db, project, w),
      status: r.status ?? "not read yet",
      figma_name: r.figma_name ?? null,
      baseline_at: r.baseline_at ?? null,
      last_seen_at: r.last_seen_at ?? null,
      last_change_at: r.last_change_at ?? null,
      last_change: r.last_change ?? null,
      warning: r.warning ?? null,
      moved_from: r.moved_from ?? null,
      moved_at: r.moved_at ?? null,
      page_name: r.page_name ?? null,
      waiting,
      batch: batch ?? null,
    };
  });
}

// One line per watched section for status and tick.
export function watchLine(v, ago = fmtShort) {
  const where = [v.route ?? `lane ${v.lane}`, `from ${v.branch}`].join(" ");
  const state =
    v.status === "gone" ? `not in Figma: ${v.warning ?? "the node id is gone"}`
    : v.status === "not read yet" ? "no baseline yet (the next check records it)"
    : [
        v.moved_at && `now "${v.figma_name}"${v.page_name ? ` on "${v.page_name}"` : ""} (moved in Figma, followed ${ago(v.moved_at)}; the baseline is kept)`,
        v.status === "ready" && "marked ready for dev",
        !v.built && "not built yet",
        v.last_change_at ? `last change ${ago(v.last_change_at)} (${v.last_change})` : `no change since the baseline (${fmtShort(v.baseline_at)})`,
        v.waiting && `${v.waiting} waiting`,
        v.batch && `in batch ${v.batch.id} (${v.batch.status})`,
      ].filter(Boolean).join("; ");
  return `${v.name} (${where}): ${state}`;
}
