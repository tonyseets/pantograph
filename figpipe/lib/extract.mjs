// Extraction: every REST read a batch needs, done before any AI runs. Node JSON at full depth,
// verbatim copy, tree dump, structural diff against the last build, 2x renders, the component
// sets behind the node (every variant, the states the node does not show, 3x renders), whole
// comment threads and motion hints. Lands in <repo>/<extract_dir>/<area>/pipeline/<batch>/ so
// interactive sessions see the same files.
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { renderNodes } from "../../skills/figma-transpose/scripts/figma-rest.mjs";
import {
  docOf, treeLines, flatLines, unifiedDiff, changedLineCount, copyBySection, copyMarkdown, shapeFingerprint, nodeFileId, slugify,
} from "../../skills/figma-transpose/scripts/figma-nodes.mjs";
import { componentStore, collectComponents } from "../../skills/figma-transpose/scripts/figma-components.mjs";
import { nowIso } from "./db.mjs";
import { paths } from "./paths.mjs";
import { laneOf } from "./batcher.mjs";
import { watchOfItem, buildSnapshot, copyLines, isBaselineId, designFingerprint, portableFingerprint, snapshotDoc } from "./watch.mjs";

const MOTION_NAME = /anim|motion|scroll|sticky|hover|transition|carousel|marquee|loop|lottie|video|parallax|reveal/i;
const MOTION_TEXT = /animat|motion|transition|scroll|hover|easing|timing|sticky|parallax|video|loop/i;

// Nodes whose motion a still render cannot show. Prototype data in REST is often empty, so names
// and comment text count too; the session confirms with get_motion_context.
export function motionHints(root, threads = []) {
  const out = [];
  const walk = (n) => {
    if (out.length >= 20) return;
    const why = [];
    if (n.interactions?.length) why.push("prototype interactions");
    if (n.transitionNodeID) why.push("prototype transition");
    if (n.scrollBehavior && n.scrollBehavior !== "SCROLLS") why.push(`scroll behaviour ${n.scrollBehavior.toLowerCase()}`);
    if (n.overflowDirection && n.overflowDirection !== "NONE") why.push("scrolling frame");
    if (MOTION_NAME.test(n.name ?? "")) why.push(`named "${n.name}"`);
    if (why.length) out.push({ node_id: n.id, name: n.name, why: why.join(", ") });
    for (const c of n.children ?? []) walk(c);
  };
  if (root) walk(root);
  for (const t of threads)
    if (t.messages.some((m) => MOTION_TEXT.test(m.text ?? ""))) out.push({ node_id: t.node_id, name: null, why: "a comment talks about motion" });
  return out;
}

export function threadOf(db, project, fileKey, rootId) {
  const rows = db.all("SELECT * FROM comments WHERE project = ? AND file_key = ? AND root_id = ? AND deleted = 0 ORDER BY created_at", project, fileKey, rootId);
  if (!rows.length) return null;
  const root = rows.find((r) => r.comment_id === rootId) ?? rows[0];
  return {
    id: rootId,
    node_id: root.node_id,
    resolved: !!root.resolved_at,
    messages: rows.map((r) => ({ id: r.comment_id, by: r.author, at: r.created_at, text: r.message, mentions_me: !!r.mentions_me, by_me: !!r.by_me })),
  };
}

// Keep .figma/ out of commits through .git/info/exclude, never a committed .gitignore.
export function ensureExcluded(repo, dir) {
  try {
    execFileSync("git", ["-C", repo, "check-ignore", "-q", `${dir}/x`], { stdio: "ignore" });
    return false;
  } catch {}
  const common = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  const file = join(common.startsWith("/") ? common : join(repo, common), "info", "exclude");
  mkdirSync(join(file, ".."), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# figpipe: Figma extractions stay local\n/${dir}/\n`);
  return true;
}

// Component sets are kept outside every batch, per file and set, so a set shared by many items
// and batches is read and rendered once (see componentStore).
export const componentCacheDir = () => join(paths().home, "components");

// What the manifest says about an item's components: the table, and per set what the page shows,
// what it leaves out and its prototype interactions. The variants themselves stay in each set.json.
function componentsRecord(index, dir) {
  const at = (p) => (p ? join(dir, p) : null);
  return {
    table: join(dir, "components.md"),
    index: join(dir, "index.json"),
    line: index.line,
    render_scale: index.render_scale,
    sets: index.sets.map((s) => ({
      name: s.name,
      role: s.role,
      ...(s.for ? { for: s.for } : {}),
      ...(s.in ? { in: s.in } : {}),
      ...(s.library ? { library: true } : {}),
      axes: Object.fromEntries(s.axes.map((a) => [a.name, a.values])),
      on_the_page: s.on_the_page.map((u) => u.name),
      ...(s.unreadable
        ? { unreadable: s.unreadable }
        : { not_on_the_page: s.not_on_the_page, to_build: s.to_build, states_not_designed: s.states_not_designed, json: at(s.json), node_json: at(s.node_json), render: at(s.render) }),
      // Prototype interactions, one line each; the values sit in the set's json.
      ...(s.interaction_lines?.length || s.instance_interaction_lines?.length ? { interactions: [...(s.interaction_lines ?? []), ...(s.instance_interaction_lines ?? [])] } : {}),
    })),
    no_component: index.no_component.map((e) => ({ element: e.element, kind: e.kind, where: e.where, why: e.why, count: e.count, looks: e.looks, states_not_designed: e.states, sets_named_like_it: e.candidates.map((c) => c.name) })),
  };
}

export const figmaLink = (fileKey, nodeId) => `https://www.figma.com/design/${fileKey}/?node-id=${(nodeId ?? "").replace(/:/g, "-")}`;

// extractBatch({ db, config, client, batchId, clock, fetchImpl }) -> extract.json contents
export async function extractBatch({ db, config, client, batchId, clock = Date.now, fetchImpl, sleep, log = () => {} }) {
  const project = config.project.slug;
  const repo = config.project.repo;
  const exDir = config.git.extract_dir;
  const batchDir = join(paths().batches, project, batchId);
  mkdirSync(batchDir, { recursive: true });
  if (config.git.figma_dir_hidden_by === "info/exclude" && existsSync(join(repo, ".git"))) ensureExcluded(repo, exDir);

  // Node items first, so comment pins inside them resolve to their area afterwards.
  const items = db.all("SELECT * FROM items WHERE batch_id = ? ORDER BY CASE WHEN kind = 'comment' THEN 1 ELSE 0 END, id", batchId);
  const out = { batch: batchId, extracted_at: nowIso(clock), items: {}, warnings: [], calls: 0 };
  const renderJobs = new Map(); // file_key -> [{ id, path, item }]
  const queueRender = (fileKey, job) => {
    if (!renderJobs.has(fileKey)) renderJobs.set(fileKey, []);
    if (!renderJobs.get(fileKey).some((j) => j.id === job.id)) renderJobs.get(fileKey).push(job);
  };
  const maxRenders = config.extract.max_renders_per_item;
  const store = componentStore({ client, cacheDir: componentCacheDir(), scale: config.extract.component_render_scale, fetchImpl, sleep, clock });
  const reread = (id) => db.get("SELECT * FROM items WHERE id = ?", id);

  for (let it of items) {
    const isNodeItem = it.kind !== "comment";
    let resp = null;
    let doc = null;
    let readError = null;
    if (isNodeItem && it.node_id) {
      // Node item: full-depth JSON, saved verbatim below.
      try {
        resp = await client.nodes(it.file_key, [it.node_id]);
        out.calls++;
        doc = docOf(resp, it.node_id);
      } catch (e) {
        if (e.kind === "rate_limit" || e.kind === "auth") throw e;
        readError = e;
      }
      if (doc) {
        // A node added by hand has no area yet: it is its own area.
        db.run(
          "UPDATE items SET title = CASE WHEN title IS NULL OR title LIKE 'Node %' THEN ? ELSE title END, area_id = COALESCE(area_id, ?), area_name = COALESCE(area_name, ?) WHERE id = ?",
          doc.name, doc.id, doc.name, it.id,
        );
        it = reread(it.id);
      }
    } else if (it.node_id && !it.area_name) {
      const a = db.get("SELECT area_id, area_name FROM node_areas WHERE project = ? AND file_key = ? AND node_id = ?", project, it.file_key, it.node_id);
      if (a) {
        db.run("UPDATE items SET area_id = ?, area_name = ? WHERE id = ?", a.area_id, a.area_name, it.id);
        it = reread(it.id);
      }
    }
    const lane = laneOf(it);
    const dir = join(repo, exDir, lane, "pipeline", batchId);
    mkdirSync(dir, { recursive: true });
    const rec = { item_id: it.id, kind: it.kind, lane, dir, figma_url: it.node_id ? figmaLink(it.file_key, it.node_id) : null, renders: [], threads: [], motion: [] };
    out.items[it.id] = rec;

    if (it.thread_id) {
      const th = threadOf(db, project, it.file_key, it.thread_id);
      if (th) rec.threads.push(th);
      if (th?.resolved) rec.note = "thread resolved in Figma after it was picked up";
    }
    const manual = JSON.parse(it.source || "{}").events?.find((e) => e.payload?.manual);
    if (manual?.payload?.note) rec.note = manual.payload.note;

    if (!it.node_id) continue;
    if (!isNodeItem) {
      // Comment: render the pinned node so the report shows what the comment points at.
      if (maxRenders > 0) {
        const p = join(dir, "render", `pin__${nodeFileId(it.node_id)}@${config.extract.render_scale}x.png`);
        queueRender(it.file_key, { id: it.node_id, path: p, item: it.id, role: "pin" });
      }
      continue;
    }
    if (readError) {
      out.warnings.push(`item ${it.id}: could not read node ${it.node_id}: ${readError.message}`);
      continue;
    }
    if (!doc) {
      out.warnings.push(`item ${it.id}: node ${it.node_id} no longer exists in ${it.file_key}`);
      db.run("UPDATE items SET outcome = 'cancelled', verdict = ? WHERE id = ?", "The node no longer exists in Figma.", it.id);
      continue;
    }
    const base = nodeFileId(it.node_id);
    const nodePath = join(dir, `node-${base}.json`);
    writeFileSync(nodePath, JSON.stringify(resp));
    const deep = shapeFingerprint(doc);
    db.run("UPDATE items SET deep_fingerprint = ? WHERE id = ?", deep, it.id);
    rec.node = { id: doc.id, name: doc.name, type: doc.type, width: Math.round(doc.absoluteBoundingBox?.width ?? 0), height: Math.round(doc.absoluteBoundingBox?.height ?? 0), json: nodePath, deep_fingerprint: deep };
    const watch = watchOfItem(it);
    if (watch) rec.watch = watch;

    // Already built with this exact design: done before any AI runs.
    const last = db.get(
      "SELECT * FROM ledger WHERE project = ? AND key = ? AND outcome IN ('applied', 'already_done') ORDER BY at DESC LIMIT 1",
      project, `node:${it.file_key}:${it.node_id}`,
    );
    if (last && last.deep_fingerprint === deep) {
      rec.already_done = { batch: last.batch_id, branch: last.branch, commits: JSON.parse(last.commits || "[]") };
      const verdict = isBaselineId(last.batch_id) ? `No design change since the design your pre-built page was made from (${last.at.slice(0, 10)}).` : `No design change since batch ${last.batch_id} built it.`;
      db.run("UPDATE items SET outcome = 'already_done', verdict = ?, branch = ?, commits = ? WHERE id = ?", verdict, last.branch, last.commits, it.id);
      continue;
    }

    // The design the build was made from: the snapshot of its last build, or the watched section's
    // baseline (a ready copy of a watched section uses the section's); else the last snapshot seen.
    const built = buildSnapshot(db, project, it.file_key, it.node_id, batchId) ?? (watch && watch.node !== it.node_id ? buildSnapshot(db, project, it.file_key, watch.node, batchId) : null);
    const snap = built ?? db.get("SELECT * FROM snapshots WHERE project = ? AND file_key = ? AND node_id = ? AND batch_id != ? ORDER BY at DESC LIMIT 1", project, it.file_key, it.node_id, batchId);
    const old = snapshotDoc(snap);
    // The same design as the build was made from: a ready mark alone, an edit that went back, or a
    // section the designer moved (new node ids, nothing else). Compared with ids set aside too.
    const same = !!old && (designFingerprint(old) === designFingerprint(doc) || portableFingerprint(old) === portableFingerprint(doc));
    if (watch && same) {
      const verdict = watch.built ? `No design change since the design your pre-built page was made from (${snap.at.slice(0, 10)}).` : "No design change since the baseline; nothing to build yet.";
      db.run("UPDATE items SET outcome = ?, verdict = ?, branch = COALESCE(branch, ?) WHERE id = ?", watch.built ? "already_done" : "fyi", verdict, watch.built ? watch.branch : null, it.id);
      continue;
    }
    if (!watch && same && built && last) {
      rec.already_done = { batch: last.batch_id, branch: last.branch, commits: JSON.parse(last.commits || "[]") };
      const verdict = isBaselineId(built.batch_id) ? `No design change since the design your build was made from (${built.at.slice(0, 10)}).` : `No design change since batch ${built.batch_id} built it.`;
      db.run("UPDATE items SET outcome = 'already_done', verdict = ?, branch = ?, commits = ? WHERE id = ?", verdict, last.branch, last.commits, it.id);
      continue;
    }

    writeFileSync(join(dir, `tree-${base}.txt`), treeLines(doc).join("\n"));
    const sections = copyBySection(doc);
    writeFileSync(join(dir, `copy-${base}.json`), JSON.stringify(sections, null, 1));
    writeFileSync(join(dir, `copy-${base}.md`), copyMarkdown(doc));
    rec.copy = { md: join(dir, `copy-${base}.md`), json: join(dir, `copy-${base}.json`) };

    // Breakpoint frames: direct children whose width matches a configured breakpoint.
    const bps = Object.entries(config.figma.files.find((f) => f.key === it.file_key)?.breakpoints ?? {});
    rec.breakpoint_frames = sections
      .filter((s) => !s.hidden)
      .map((s) => ({ id: s.id, name: s.name, width: s.width, breakpoint: bps.find(([, w]) => Math.abs(w - s.width) <= 2)?.[0] ?? null }))
      .filter((s) => s.breakpoint);
    rec.hidden_children = sections.filter((s) => s.hidden).map((s) => ({ id: s.id, name: s.name }));

    // Structural and copy diffs against that design, and its renders for Figma before/after.
    if (old) {
      const from = isBaselineId(snap.batch_id) ? `baseline ${snap.at.slice(0, 16).replace("T", " ")}` : `batch ${snap.batch_id}`;
      const d = unifiedDiff(flatLines(old), flatLines(doc), { from, to: `batch ${batchId}` });
      writeFileSync(join(dir, `sdiff-${base}.diff`), d || "no structural changes\n");
      rec.sdiff = { path: join(dir, `sdiff-${base}.diff`), since_batch: snap.batch_id, changed_lines: changedLineCount(d) };
      const cd = unifiedDiff(copyLines(old), copyLines(doc), { from, to: `batch ${batchId}` });
      writeFileSync(join(dir, `copy-diff-${base}.diff`), cd || "no copy changes\n");
      rec.copy_diff = { path: join(dir, `copy-diff-${base}.diff`), changed_lines: changedLineCount(cd) };
      const renders = JSON.parse(snap.renders || "[]");
      rec.baseline = { snapshot: snap.batch_id, at: snap.at, node_json: snap.path, renders };
      if (renders.length) db.run("UPDATE items SET figma_before = ? WHERE id = ?", JSON.stringify(renders), it.id);
    }
    db.run("INSERT OR REPLACE INTO snapshots (project, file_key, node_id, batch_id, deep_fingerprint, path, at) VALUES (?, ?, ?, ?, ?, ?, ?)", project, it.file_key, it.node_id, batchId, deep, nodePath, nowIso(clock));

    // Remember which area every node in this subtree belongs to, so later comment pins resolve.
    const area = { id: it.area_id ?? it.node_id, name: it.area_name ?? doc.name };
    const ids = [];
    const collect = (n) => {
      ids.push(n.id);
      for (const c of n.children ?? []) collect(c);
    };
    collect(doc);
    db.tx(() => {
      for (const id of ids)
        db.run("INSERT OR REPLACE INTO node_areas (project, file_key, node_id, area_id, area_name) VALUES (?, ?, ?, ?, ?)", project, it.file_key, id, area.id, area.name);
    });

    // Open threads pinned anywhere inside this node are context for the lane.
    const idSet = new Set(ids);
    const roots = db.all("SELECT DISTINCT root_id, node_id FROM comments WHERE project = ? AND file_key = ? AND deleted = 0 AND parent_id IS NULL AND resolved_at IS NULL", project, it.file_key).filter((r) => r.node_id && idSet.has(r.node_id));
    for (const r of roots.slice(0, 30)) {
      if (rec.threads.some((t) => t.id === r.root_id)) continue;
      const th = threadOf(db, project, it.file_key, r.root_id);
      if (th) rec.threads.push(th);
    }
    rec.motion = motionHints(doc, rec.threads);

    // Component sets behind the node: the states the frame does not show. A file without sets,
    // or with sets the token cannot read, is ordinary and is written down as such.
    if (config.extract.component_sets) {
      try {
        const fileCfg = config.figma.files.find((f) => f.key === it.file_key);
        const index = await collectComponents({ store, fileKey: it.file_key, resp, nodeId: it.node_id, outDir: join(dir, "components"), maxSets: config.extract.max_component_sets, pages: fileCfg?.component_pages ?? [], clock });
        if (index) {
          out.calls += index.calls;
          rec.components = componentsRecord(index, join(dir, "components"));
          for (const w of index.warnings) out.warnings.push(`item ${it.id}: ${w}`);
        }
      } catch (e) {
        if (e.kind === "rate_limit" || e.kind === "auth") throw e;
        out.warnings.push(`item ${it.id}: the component sets were not read: ${e.message}`);
      }
    }

    // Renders: the node, then its visible child frames, up to the cap.
    if (maxRenders > 0) {
      queueRender(it.file_key, { id: doc.id, path: join(dir, "render", `00-${slugify(doc.name)}__${base}@${config.extract.render_scale}x.png`), item: it.id, role: "node" });
      const kids = (doc.children ?? []).filter((c) => c.visible !== false && ["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(c.type));
      kids.slice(0, maxRenders - 1).forEach((c, i) =>
        queueRender(it.file_key, { id: c.id, path: join(dir, "render", `${String(i + 1).padStart(2, "0")}-${slugify(c.name)}__${nodeFileId(c.id)}@${config.extract.render_scale}x.png`), item: it.id, role: "child", name: c.name, width: Math.round(c.absoluteBoundingBox?.width ?? 0) }),
      );
      if (kids.length > maxRenders - 1) out.warnings.push(`item ${it.id}: rendered ${maxRenders - 1} of ${kids.length} child frames (extract.max_renders_per_item)`);
    }
  }

  for (const [fileKey, jobs] of renderJobs) {
    let res = {};
    try {
      res = await renderNodes(client, fileKey, jobs, { scale: config.extract.render_scale, fetchImpl, sleep });
      out.calls += Math.ceil(jobs.length / 6);
    } catch (e) {
      if (e.kind === "rate_limit" || e.kind === "auth") throw e;
      out.warnings.push(`renders for ${fileKey} failed: ${e.message}`);
    }
    for (const j of jobs) {
      const rec = out.items[j.item];
      const p = res[j.id] ?? null;
      if (!p) {
        if (Object.keys(res).length) out.warnings.push(`item ${j.item}: Figma returned no image for ${j.id} (hidden, empty or too large)`);
        continue;
      }
      rec.renders.push({ node_id: j.id, role: j.role, name: j.name ?? null, width: j.width ?? null, path: p });
      if (j.role !== "child") db.run("UPDATE items SET figma_render = ? WHERE id = ?", p, j.item);
    }
  }

  for (const rec of Object.values(out.items)) {
    if (rec.motion?.length) db.run("UPDATE items SET motion = ? WHERE id = ?", JSON.stringify(rec.motion), rec.item_id);
    // The renders belong to this batch's snapshot: the Figma "before" of the next change.
    if (rec.node && rec.renders.length)
      db.run("UPDATE snapshots SET renders = ? WHERE project = ? AND file_key = ? AND node_id = ? AND batch_id = ?", JSON.stringify(rec.renders.filter((r) => r.role !== "pin")), project, db.get("SELECT file_key FROM items WHERE id = ?", rec.item_id).file_key, rec.node.id, batchId);
  }
  writeFileSync(join(batchDir, "extract.json"), JSON.stringify(out, null, 1));
  log(`extracted ${Object.keys(out.items).length} items with ${out.calls} Figma calls${out.warnings.length ? `, ${out.warnings.length} warnings` : ""}`);
  return out;
}

export const relTo = (from, p) => (p ? relative(from, p) : p);
