// Reconcile Figma state with what figpipe saw last time, and record the difference as events.
// Compares state rather than deliveries, so a Mac that slept all weekend catches up on the
// next tick and nothing is lost. REST only, no AI.
import { devStatusNodes, docOf, shapeFingerprint, sha } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";
import { nowIso } from "./db.mjs";
import { watchesOf, watchRows, watchedAreas, watchForNode, watchNames, indexArea, readyNodesOf, seedWatch, designFingerprint, portableFingerprint, similarity, snapshotDoc, buildSnapshot, adoptNode, repointWatch } from "./watch.mjs";
import { nameParts, sameSection } from "./names.mjs";

const NODE_ID = /^I?\d+[:-]\d+(;\d+[:-]\d+)*$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mentions in REST comments are plain text ("@tony"), so match the handle and display names.
export function mentionMatcher(me) {
  const names = [me.handle, ...(me.names ?? [])].filter(Boolean).map((n) => esc(n.trim())).filter(Boolean);
  if (!names.length) return () => false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_@])@(${names.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
  return (text) => re.test(text ?? "");
}

export function isMe(me, user) {
  if (!user) return false;
  if (me.user_id && user.id === me.user_id) return true;
  return !me.user_id && !!me.handle && (user.handle ?? "").toLowerCase() === me.handle.toLowerCase();
}

function insertEvent(db, ev) {
  const r = db.run(
    `INSERT OR IGNORE INTO events (key, project, file_key, kind, role, node_id, comment_id, thread_id, payload, detected_at, source_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ev.key, ev.project, ev.file_key, ev.kind, ev.role, ev.node_id, ev.comment_id, ev.thread_id, JSON.stringify(ev.payload ?? {}), ev.detected_at, ev.source_at,
  );
  return r.changes > 0;
}

// Pending events are cancelled; ones already in a batch get a note the report shows.
function cancelEvents(db, where, args, reason) {
  const c = db.run(`UPDATE events SET status = 'cancelled', note = ? WHERE status = 'pending' AND ${where}`, reason, ...args).changes;
  db.run(`UPDATE events SET note = ? WHERE status = 'batched' AND note IS NULL AND ${where}`, `${reason} after the batch started`, ...args);
  return c;
}

const fileRow = (db, project, key) => db.get("SELECT * FROM files WHERE project = ? AND file_key = ?", project, key);
function upsertFile(db, project, key, fields) {
  db.run("INSERT INTO files (project, file_key) VALUES (?, ?) ON CONFLICT DO NOTHING", project, key);
  const cols = Object.keys(fields);
  if (cols.length) db.run(`UPDATE files SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE project = ? AND file_key = ?`, ...cols.map((c) => fields[c]), project, key);
}

// reconcileProject({ db, config, client, clock, backfill, seed, log }) -> summary
// seed = false (a dry run) lists watched sections without a baseline instead of recording one, and
// leaves the config file alone when a watched section moved.
export async function reconcileProject({ db, config, client, clock = Date.now, backfill = false, seed = true, log = () => {}, fetchImpl, sleep }) {
  const project = config.project.slug;
  const summary = { project, files: [], events: [], cancelled: 0, warnings: [], calls: 0, seeded: [], unseeded: [], moved: [] };
  const now = () => nowIso(clock);
  const me = config.figma.me;
  const mentions = mentionMatcher(me);
  const firstId = db.get("SELECT COALESCE(MAX(id), 0) AS m FROM events").m;

  for (const f of config.figma.files) {
    const fsum = { key: f.key, events: 0 };
    summary.files.push(fsum);
    const started = now();
    const prev = fileRow(db, project, f.key) ?? {};

    // 1. /meta: cheap change detector and the "designer paused" signal.
    const meta = (await client.meta(f.key)).file ?? {};
    summary.calls++;
    const touched = meta.last_touched_at ?? null;
    const moved = touched !== (prev.last_touched_at ?? null);
    upsertFile(db, project, f.key, {
      role: "live",
      name: meta.name ?? null,
      last_touched_at: touched,
      last_touched_by: meta.last_touched_by?.handle ?? null,
      version: meta.version ?? null,
      touched_moved_at: moved ? now() : prev.touched_moved_at ?? now(),
      checked_at: now(),
    });
    if (f.name && meta.name && f.name !== meta.name) summary.warnings.push(`${f.key} is named "${meta.name}" in Figma, config says "${f.name}"`);

    // 2. Page names -> node ids. Re-read on the hourly sweep too: a designer who renames the
    // watched page to "(Old)" and makes a new "(Latest)" moves the name to another page.
    const sweepDue = !prev.last_sweep_at || clock() - Date.parse(prev.last_sweep_at) >= 60 * 60 * 1000;
    let pageIds = prev.page_ids ? JSON.parse(prev.page_ids) : {};
    const named = f.pages.filter((p) => !NODE_ID.test(p));
    if (f.pages.some((p) => !(p in pageIds)) || (named.length && (sweepDue || backfill))) {
      const next = {};
      if (named.length) {
        const file = await client.file(f.key, { depth: 1 });
        summary.calls++;
        for (const page of file.document?.children ?? []) if (named.includes(page.name) && !(page.name in next)) next[page.name] = page.id;
        for (const p of named)
          if (pageIds[p] && next[p] && next[p] !== pageIds[p]) summary.warnings.push(`page "${p}" is now a different page in Figma (${next[p]}, was ${pageIds[p]}); figpipe watches the new one`);
      }
      for (const p of f.pages) if (NODE_ID.test(p)) next[p] = p.replace(/-/g, ":");
      pageIds = next;
      upsertFile(db, project, f.key, { page_ids: JSON.stringify(pageIds) });
    }
    for (const p of f.pages) if (!(p in pageIds)) summary.warnings.push(`page "${p}" is not in ${f.key}; check figma.files.pages`);
    const watched = f.pages.filter((p) => p in pageIds).map((p) => pageIds[p]);

    // 2b. Watched sections (in progress, pre-built): one full-depth read of all of them when the
    // file moved, hourly, on --backfill, or while one has no baseline yet. Before comments, so a
    // comment on a layer added in the same edit resolves to its section.
    const watches = watchesOf(config, f.key);
    const newlyGone = [];
    if (watches.length) {
      const rows = watchRows(db, project, f.key);
      const unseeded = watches.some((w) => !rows.get(w.node)?.baseline_id);
      const hourly = !prev.last_watch_at || clock() - Date.parse(prev.last_watch_at) >= 60 * 60 * 1000;
      if (moved || unseeded || hourly || backfill) {
        const resp = await client.nodes(f.key, watches.map((w) => w.node));
        summary.calls++;
        const handled = new Set(db.all("SELECT node_id FROM nodes WHERE project = ? AND file_key = ?", project, f.key).map((r) => r.node_id));
        const r = reconcileWatches({ db, project, fileKey: f.key, resp, watches, readyHandled: (id) => handled.has(id), now: now() });
        fsum.events += r.events;
        summary.cancelled += r.cancelled;
        summary.warnings.push(...r.warnings);
        for (const { watch } of r.unseeded) {
          if (!seed) {
            summary.unseeded.push(watch.name);
            continue;
          }
          const sd = await seedWatch({ db, config, client, fileKey: f.key, watch, resp, clock, fetchImpl, sleep });
          summary.calls += sd.calls;
          summary.warnings.push(...sd.warnings);
          summary.seeded.push(watch.name);
          log(`${project}: baseline recorded for watched section "${watch.name}"${sd.built ? "" : " (not built yet)"}`);
        }
        // A watched node id that vanished (cut and pasted, moved to the ready page, or deleted) is
        // looked for after the ready read below (4b), which knows the ready sections.
        newlyGone.push(...r.gone);
        upsertFile(db, project, f.key, { last_watch_at: now() });
      } else for (const w of watches) if (rows.get(w.node)?.status === "gone") summary.warnings.push(`watched section "${w.name}": ${rows.get(w.node).warning ?? `node ${w.node} is gone`}`);
    }

    // 3. Comments: new ids, threads, mentions, resolves and deletes; any comment inside a watched section.
    if (config.triggers.mentions || config.triggers.my_threads || watches.length) {
      const resp = await client.comments(f.key);
      summary.calls++;
      const watched = watchedAreas(db, project, f.key, watches);
      const r = reconcileComments({ db, project, fileKey: f.key, comments: resp.comments ?? [], me, mentions, triggers: config.triggers, watched, baseline: !prev.comments_baselined && !backfill, backfill, now: now() });
      fsum.events += r.events;
      summary.cancelled += r.cancelled;
      upsertFile(db, project, f.key, { comments_baselined: 1 });
    }

    // 4. Ready for dev: only when the file moved, on the first run, or on the hourly sweep.
    if (config.triggers.ready_for_dev && watched.length) {
      if (moved || !prev.nodes_baselined || sweepDue || backfill) {
        const resp = await client.nodes(f.key, watched, { depth: f.ready_depth });
        summary.calls++;
        const r = reconcileReady({ db, project, fileKey: f.key, resp, pageIds: watched, triggers: config.triggers, baseline: !prev.nodes_baselined && !backfill, backfill, now: now(), watchOf: (id, name) => watchForNode(db, config, f.key, id, name) });
        fsum.events += r.events;
        summary.cancelled += r.cancelled;
        summary.warnings.push(...r.warnings);
        upsertFile(db, project, f.key, { nodes_baselined: 1, last_sweep_at: now() });
      }
    }

    // 4b. Sections that moved. A watched section whose node is gone, or that still sits on an
    // in-progress page, is followed to the ready section that carries its name ("Location" is now
    // "Location_EN" on the ready page): the watch, its baseline and what waits for it move to the
    // new node, and the config entry is re-pointed. Only a section nothing matches stays "gone".
    if (watches.length) {
      const m = await followMoved({ db, config, client, f, pageIds, now: now(), since: started, write: seed, newlyGone });
      summary.calls += m.calls;
      fsum.events += m.events;
      summary.warnings.push(...m.warnings);
      for (const x of m.moved) {
        summary.moved.push(x);
        summary.warnings = summary.warnings.filter((w) => !w.startsWith(`watched section "${x.name}":`));
        if (seed) log(`${project}: watched section "${x.name}" moved in Figma: now "${x.to_name}"${x.page ? ` on "${x.page}"` : ""} (${x.to}, was ${x.from}). The watch follows it and keeps its baseline${x.changed ? "; the design differs from your build" : ""}`);
      }
      // Still gone: look for a layer with its name once, so the warning can say where it may be.
      const lost = newlyGone.filter((w) => watchesOf(config, f.key).some((x) => x.node === w.node));
      if (lost.length) {
        const rows = watchRows(db, project, f.key);
        const file = await client.file(f.key, { depth: 2 });
        summary.calls++;
        for (const w of lost) {
          const names = watchNames(w, rows.get(w.node));
          const hits = [];
          for (const page of file.document?.children ?? []) for (const n of page.children ?? []) if (names.some((x) => sameSection(x, n.name))) hits.push({ id: n.id, page: page.name });
          hits.sort((a, b) => (b.page === w.page) - (a.page === w.page));
          const warning = hits.length
            ? `node ${w.node} is gone; "${w.name}" may now be ${hits.map((h) => `${h.id} on "${h.page}"`).join(" or ")}. Update figma.files.watch.node, then figpipe watch baseline ${project} "${w.name}"`
            : `node ${w.node} is gone and no section named "${w.name}" was found; update or remove the watch`;
          db.run("UPDATE watches SET warning = ? WHERE project = ? AND file_key = ? AND node_id = ?", warning, project, f.key, w.node);
          summary.warnings.push(`watched section "${w.name}": ${warning}`);
        }
      }
    }

    // 5. Built nodes that are still marked ready: a deep re-read catches the designer's later edits.
    if (config.triggers.ready_for_dev && config.triggers.changed_after_build) {
      const due = !prev.last_deep_check_at || clock() - Date.parse(prev.last_deep_check_at) >= config.triggers.deep_check_minutes * 60 * 1000;
      const movedSinceDeep = !prev.last_deep_check_at || (touched && touched > prev.last_deep_check_at);
      if (due && movedSinceDeep) {
        const r = await deepCheck({ db, client, project, fileKey: f.key, now: now() });
        summary.calls += r.calls;
        fsum.events += r.events;
        upsertFile(db, project, f.key, { last_deep_check_at: now() });
      }
    }

    // 6. Named versions: a "designer paused" signal, or a trigger if configured.
    if (config.triggers.named_versions !== "ignore") {
      const resp = await client.versions(f.key);
      summary.calls++;
      fsum.events += reconcileVersions({ db, project, fileKey: f.key, versions: resp.versions ?? [], mode: config.triggers.named_versions, baseline: !prev.versions_baselined, now: now() });
      upsertFile(db, project, f.key, { versions_baselined: 1 });
    }

    // 7. Identity: a same-name stale copy edited after the live file is a warning, never a build.
    for (const stale of f.stale_copies) {
      const sm = (await client.meta(stale)).file ?? {};
      summary.calls++;
      const st = sm.last_touched_at ?? null;
      let warning = null;
      if (st && touched && st > touched) {
        warning = `"${sm.name}" (${stale}) was edited at ${st} by ${sm.last_touched_by?.handle ?? "someone"}, after the watched file (${touched}). The designer may be working in the wrong copy.`;
        if (insertEvent(db, { key: `identity:${f.key}:${stale}:${st}`, project, file_key: f.key, kind: "identity", role: "context", payload: { stale, name: sm.name, stale_touched_at: st, by: sm.last_touched_by?.handle, live_touched_at: touched }, detected_at: now(), source_at: st }))
          fsum.events++;
        summary.warnings.push(warning);
      }
      db.run("INSERT INTO files (project, file_key) VALUES (?, ?) ON CONFLICT DO NOTHING", project, stale);
      db.run("UPDATE files SET role = 'stale', name = ?, last_touched_at = ?, last_touched_by = ?, checked_at = ?, warning = ? WHERE project = ? AND file_key = ?", sm.name, st, sm.last_touched_by?.handle, now(), warning, project, stale);
    }
  }
  summary.events = db.all("SELECT key, kind, role FROM events WHERE project = ? AND id > ? ORDER BY id", project, firstId);
  log(`${project}: ${summary.events.length} new events, ${summary.cancelled} cancelled, ${summary.calls} Figma calls`);
  return summary;
}

// How sure a match must be when the name does not settle it.
const LAYER_NAME_MIN = 0.5; // matched only by the layer's Figma name, not the name in the config
const STRUCTURE_MIN = 0.8; // no name match at all: the structure alone has to say it
const STRUCTURE_LEAD = 0.1; // and say it clearly ahead of the next candidate

// Follow watched sections to where the designer moved them. Candidates are ready sections on the
// watched pages that no watch points at. A candidate is the section when its name matches after
// language tag, case and separators are set aside, and no other language is named ("Location" may
// be "Location_EN", never "Location_GER" once it is "Location_EN"); among several, the one closest
// to the baseline wins. A section whose node is gone and that no name matches is followed by
// structure alone, when one ready section that appeared since is clearly it. One full-depth read
// for all candidates. -> { moved: [{ name, from, to, to_name, page, changed }], events, calls, warnings }
export async function followMoved({ db, config, client, f, pageIds, now, since = now, write = true, newlyGone = [] }) {
  const project = config.project.slug;
  const out = { moved: [], events: 0, calls: 0, warnings: [] };
  const watches = watchesOf(config, f.key);
  const rows = watchRows(db, project, f.key);
  const ids = Object.values(pageIds);
  const pageName = (id) => Object.entries(pageIds).find(([, v]) => v === id)?.[0] ?? null;
  const nodes = new Map(db.all("SELECT node_id, name, page_id, status, ready_since FROM nodes WHERE project = ? AND file_key = ?", project, f.key).map((n) => [n.node_id, n]));
  const pointed = new Set(watches.map((w) => w.node));
  const pool = [...nodes.values()].filter((n) => n.status === "READY_FOR_DEV" && ids.includes(n.page_id) && !pointed.has(n.node_id));
  if (!pool.length) return out;
  const builtKeys = new Set(db.all("SELECT key FROM ledger WHERE project = ? AND key LIKE ? AND outcome IN ('applied', 'already_done')", project, `node:${f.key}:%`).map((r) => r.key));

  // Who is looking: a watch with a baseline whose node is gone, or is not on a watched page yet.
  const speaks = (w, row, c) => watchNames(w, row).some((n) => nameParts(n).base === nameParts(c.name).base && nameParts(n).lang === nameParts(c.name).lang);
  const seekers = [];
  for (const w of watches) {
    const row = rows.get(w.node);
    if (!row?.baseline_id) continue;
    const gone = row.status === "gone";
    const settled = ids.includes(nodes.get(w.node)?.page_id) || f.pages.includes(w.page);
    if (!gone && settled) continue;
    // A match that needs the structure to confirm it is weighed once, when the section vanishes or
    // the candidate appears, so a section that stays gone costs no read on later checks.
    const fresh = (c) => (c.ready_since ?? "") >= since || newlyGone.some((x) => x.node === w.node);
    const byConfigName = (c) => sameSection(w.name, c.name);
    // "Location_GER" belongs to the watch that names that language, when there is one.
    const others = (c) => watches.some((o) => o !== w && speaks(o, rows.get(o.node), c)) && !speaks(w, row, c);
    // Once the section is "Location_EN" in Figma, "Location_GER" is its sibling, whatever the config calls it.
    const sibling = (c) => sameSection(w.name, row.figma_name ?? "") && !sameSection(row.figma_name, c.name);
    const named = pool.filter((c) => !others(c) && !sibling(c) && (byConfigName(c) || (fresh(c) && watchNames(w, row).some((n) => sameSection(n, c.name)))));
    seekers.push({ w, row, gone, named, byConfigName, fresh });
  }
  // By structure: only for a gone section no name matches, among ready sections that appeared
  // since it was last seen and that nothing else accounts for.
  const claimed = new Set(seekers.flatMap((s) => s.named.map((c) => c.node_id)));
  for (const s of seekers.filter((x) => x.gone && !x.named.length))
    s.unnamed = pool
      .filter((c) => s.fresh(c) && !claimed.has(c.node_id) && !builtKeys.has(`node:${f.key}:${c.node_id}`) && (c.ready_since ?? "") > (s.row.last_seen_at ?? ""))
      .sort((a, b) => b.ready_since.localeCompare(a.ready_since))
      .slice(0, 4);
  const want = [...new Set(seekers.flatMap((s) => [...s.named, ...(s.unnamed ?? [])].map((c) => c.node_id)))].slice(0, 12);
  if (!want.length) return out;
  const resp = await client.nodes(f.key, want);
  out.calls++;

  const taken = new Set();
  for (const s of seekers) {
    const { w, row } = s;
    const built = buildSnapshot(db, project, f.key, w.node);
    const base = snapshotDoc(built);
    const score = (c) => {
      const doc = docOf(resp, c.node_id);
      return { c, doc, sim: base && doc ? similarity(base, doc) : null };
    };
    let pick = null;
    const named = s.named.filter((c) => !taken.has(c.node_id)).map(score).filter((x) => x.doc && (s.byConfigName(x.c) || (x.sim ?? 0) >= LAYER_NAME_MIN));
    if (named.length > 1 && named.some((x) => x.sim === null)) {
      out.warnings.push(`watched section "${w.name}": ${named.map((x) => `"${x.c.name}"`).join(" and ")} both carry its name and there is no baseline to tell them apart; set figma.files.watch.node`);
      continue;
    }
    named.sort((a, b) => (b.sim ?? 0) - (a.sim ?? 0));
    pick = named[0] ?? null;
    if (!pick && s.unnamed) {
      const close = s.unnamed.filter((c) => !taken.has(c.node_id)).map(score).filter((x) => x.doc && x.sim !== null).sort((a, b) => b.sim - a.sim);
      if (close[0] && close[0].sim >= STRUCTURE_MIN && close[0].sim - (close[1]?.sim ?? 0) >= STRUCTURE_LEAD) pick = close[0];
    }
    if (!pick) continue;
    const to = { id: pick.c.node_id, name: pick.c.name, page: pageName(pick.c.page_id) };
    const from = w.node;
    db.exec("SAVEPOINT follow_moved");
    try {
      repointWatch({ db, config, fileKey: f.key, watch: w, to, now, write });
      db.exec("RELEASE follow_moved");
    } catch (e) {
      db.exec("ROLLBACK TO follow_moved");
      db.exec("RELEASE follow_moved");
      out.warnings.push(`watched section "${w.name}": it is now "${to.name}" (${to.id})${to.page ? ` on "${to.page}"` : ""}, but the config could not be updated (${e.message}). Set figma.files.watch.node = "${to.id}"`);
      continue;
    }
    taken.add(to.id);
    // Moved only, or moved and changed since the build? Ids differ either way, so compare the
    // designs with ids set aside. A changed design waits as a change against the kept baseline.
    const moved = { ...w, node: to.id };
    const fp = designFingerprint(pick.doc);
    const changed = !base || portableFingerprint(base) !== portableFingerprint(pick.doc);
    if (changed && insertEvent(db, { key: `changed:${f.key}:${to.id}:${fp}`, project, file_key: f.key, kind: "changed", role: "trigger", node_id: to.id, payload: { name: w.name, watch: to.id, lane: w.lane, figma_name: to.name, moved_from: from, why: "moved in Figma, and the design differs from the one your build was made from" }, detected_at: now, source_at: null }))
      out.events++;
    // Unchanged: the build is this node's design too, so the checks of built nodes stay quiet.
    if (!changed) db.run("UPDATE ledger SET deep_fingerprint = ? WHERE project = ? AND key = ? AND batch_id = ?", shapeFingerprint(pick.doc), project, `node:${f.key}:${to.id}`, built.batch_id);
    db.run(
      "UPDATE watches SET status = ?, fingerprint = ?, last_seen_at = ?, last_change_at = ?, last_change = ? WHERE project = ? AND file_key = ? AND node_id = ?",
      readyNodesOf(pick.doc).length ? "ready" : "watching", fp, now, now, `moved${to.page ? ` to "${to.page}"` : ""} as "${to.name}"${changed ? ", design changed" : ""}`, project, f.key, to.id,
    );
    indexArea(db, project, f.key, moved, pick.doc);
    out.moved.push({ name: w.name, from, to: to.id, to_name: to.name, page: to.page, changed, similarity: pick.sim });
  }
  return out;
}

export function reconcileComments({ db, project, fileKey, comments, me, mentions, triggers, watched = new Map(), baseline, backfill = false, now }) {
  let events = 0;
  let cancelled = 0;
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c) => c.parent_id || c.id;
  const threads = new Map();
  for (const c of comments) {
    const r = rootOf(c);
    if (!threads.has(r)) threads.set(r, []);
    threads.get(r).push(c);
  }
  for (const list of threads.values()) list.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

  // A thread is Tony's when he started it, was mentioned in it, replied in it, or a past batch
  // left a question or answer on it.
  const ledgerThreads = new Set(db.all("SELECT key FROM ledger WHERE project = ? AND key LIKE ?", project, `thread:${fileKey}:%`).map((r) => r.key.split(":").pop()));
  const mine = (root) => ledgerThreads.has(root) || (threads.get(root) ?? []).some((c) => isMe(me, c.user) || mentions(c.message));

  const seen = new Map(db.all("SELECT comment_id, resolved_at, deleted, message FROM comments WHERE project = ? AND file_key = ?", project, fileKey).map((r) => [r.comment_id, r]));
  const readyNodes = new Set(db.all("SELECT node_id FROM nodes WHERE project = ? AND file_key = ? AND status = 'READY_FOR_DEV'", project, fileKey).map((r) => r.node_id));

  for (const c of comments) {
    const root = rootOf(c);
    const rootC = byId.get(root) ?? c;
    const pin = rootC.client_meta?.node_id ?? null;
    const old = seen.get(c.id);
    const byMe = isMe(me, c.user);
    const mentionsMe = mentions(c.message);
    if (!old) {
      db.run(
        `INSERT INTO comments (project, file_key, comment_id, root_id, parent_id, node_id, author_id, author, message, created_at, resolved_at, mentions_me, by_me, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        project, fileKey, c.id, root, c.parent_id || null, pin, c.user?.id, c.user?.handle, c.message, c.created_at, c.resolved_at, mentionsMe, byMe, now,
      );
    } else {
      if ((old.resolved_at ?? null) !== (c.resolved_at ?? null)) db.run("UPDATE comments SET resolved_at = ? WHERE project = ? AND file_key = ? AND comment_id = ?", c.resolved_at, project, fileKey, c.id);
      // Edited in Figma: the latest wording is what gets built, copied verbatim.
      if ((c.message ?? "") !== (old.message ?? "")) editedComment(db, { project, fileKey, c, mentionsMe });
    }
    const threadResolved = !!rootC.resolved_at;
    if (threadResolved && c.id === root && old && !old.resolved_at)
      cancelled += cancelEvents(db, "project = ? AND file_key = ? AND thread_id = ?", [project, fileKey, root], "resolved in Figma");

    // New comments become events; at baseline only state is recorded. Backfill replays open
    // threads whose latest message is not Tony's.
    const isNew = !old;
    const thread = threads.get(root) ?? [c];
    const latest = thread[thread.length - 1];
    // Backfill replays each open thread once, through its latest message.
    const replay = backfill && !isNew && latest?.id === c.id;
    if ((!isNew && !replay) || baseline || byMe || threadResolved) continue;
    let role = null;
    let why = null;
    // A comment on or inside a section Tony pre-built, from anyone else, keeps the build in step.
    const w = pin ? watched.get(pin) ?? null : null;
    if (mentionsMe && triggers.mentions) [role, why] = ["trigger", "mentions you"];
    else if (replay && triggers.mentions && thread.some((m) => mentions(m.message))) [role, why] = ["trigger", "open thread that mentions you"];
    else if (triggers.my_threads && mine(root)) [role, why] = ["trigger", ledgerThreads.has(root) ? "reply on a thread a batch handled" : "reply in your thread"];
    else if (w) [role, why] = ["trigger", `comment on "${w.name}", which you pre-built`];
    else if (pin && readyNodes.has(pin)) [role, why] = ["context", "comment on a ready node"];
    if (!role) continue;
    if (latest && isMe(me, latest.user)) continue; // Tony already answered
    if (
      insertEvent(db, {
        key: `comment:${fileKey}:${c.id}`,
        project,
        file_key: fileKey,
        kind: "comment",
        role,
        node_id: pin,
        comment_id: c.id,
        thread_id: root,
        payload: { why, by: c.user?.handle, text: c.message, pin, reply: !!c.parent_id, ...(w ? { watch: w.node, addressed_to: addressedTo(c.message) } : {}) },
        detected_at: now,
        source_at: c.created_at,
      })
    ) {
      events++;
      if (w) db.run("UPDATE watches SET last_change_at = ?, last_change = ? WHERE project = ? AND file_key = ? AND node_id = ?", now, `comment from ${c.user?.handle ?? "someone"}`, project, fileKey, w.node);
    }
  }

  // Deleted in Figma: gone from the list.
  for (const [id, row] of seen) {
    if (row.deleted || byId.has(id)) continue;
    db.run("UPDATE comments SET deleted = 1 WHERE project = ? AND file_key = ? AND comment_id = ?", project, fileKey, id);
    cancelled += cancelEvents(db, "project = ? AND file_key = ? AND (comment_id = ? OR thread_id = ?)", [project, fileKey, id, id], "deleted in Figma");
  }
  return { events, cancelled };
}

// A comment's text changed: store it, refresh a waiting event, and note it on one already in a batch.
function editedComment(db, { project, fileKey, c, mentionsMe }) {
  db.run("UPDATE comments SET message = ?, mentions_me = ? WHERE project = ? AND file_key = ? AND comment_id = ?", c.message, mentionsMe, project, fileKey, c.id);
  for (const e of db.all("SELECT id, status, payload FROM events WHERE project = ? AND file_key = ? AND comment_id = ? AND status IN ('pending', 'batched')", project, fileKey, c.id)) {
    const payload = { ...JSON.parse(e.payload || "{}"), text: c.message, edited: true };
    if (e.status === "pending") db.run("UPDATE events SET payload = ? WHERE id = ?", JSON.stringify(payload), e.id);
    else db.run("UPDATE events SET note = ? WHERE id = ?", `Edited in Figma after the batch started; it now reads: "${String(c.message).replace(/\s+/g, " ").slice(0, 200)}"`, e.id);
  }
}

// The @names a comment addresses ("@Zoë can you…"), so a session can tell feedback meant for the
// designer from a request for the build.
export const addressedTo = (text) => [...new Set([...String(text ?? "").matchAll(/(?:^|[^\p{L}\p{N}_@])@([\p{L}][\p{L}\p{N}_.-]*)/gu)].map((m) => m[1].replace(/[.-]+$/, "")))];

export function reconcileReady({ db, project, fileKey, resp, pageIds, triggers, baseline, backfill = false, now, watchOf = () => null }) {
  let events = 0;
  let cancelled = 0;
  const warnings = [];
  const current = new Map();
  // A page that did not come back (or came back empty) says nothing about its marks: its nodes
  // keep their state until a read that does come back.
  const missing = new Set();
  for (const pid of pageIds) {
    const root = docOf(resp, pid);
    if (!root || !(root.children ?? []).length) {
      warnings.push(`page ${pid} did not come back from Figma; its ready marks are left as they were`);
      missing.add(pid);
      continue;
    }
    for (const r of devStatusNodes(root)) current.set(r.id, { ...r, page_id: pid });
  }
  const old = new Map(db.all("SELECT * FROM nodes WHERE project = ? AND file_key = ?", project, fileKey).map((r) => [r.node_id, r]));
  const built = new Set(db.all("SELECT key FROM ledger WHERE project = ? AND key LIKE ? AND outcome IN ('applied', 'already_done')", project, `node:${fileKey}:%`).map((r) => r.key.split(":").slice(2).join(":")));

  // A built section that came back under a new node id (cut and pasted, or its page was replaced by
  // a "(Latest)" one): the new node takes over the build history, so it is diffed against what was
  // built instead of built again. Matched by name, language included, under the same parents; one
  // to one only.
  const movedFrom = new Map();
  const exact = (a, b) => nameParts(a).base === nameParts(b).base && nameParts(a).lang === nameParts(b).lang;
  const samePath = (a, b) => a.length === b.length && a.every((n, i) => sameSection(n, b[i]));
  const lostBuilt = [...old.values()].filter((p) => built.has(p.node_id) && !current.has(p.node_id) && !missing.has(p.page_id));
  const arrived = [...current].filter(([id, r]) => !old.has(id) && r.status === "READY_FOR_DEV");
  for (const [id, r] of lostBuilt.length ? arrived : []) {
    const twin = (p) => exact(p.name, r.name) && samePath(JSON.parse(p.path || "[]"), r.path);
    const from = lostBuilt.filter(twin);
    if (from.length !== 1 || arrived.filter(([, c]) => exact(c.name, r.name) && samePath(c.path, r.path)).length !== 1) continue;
    adoptNode(db, project, fileKey, from[0].node_id, id);
    built.add(id);
    movedFrom.set(id, from[0].node_id);
  }

  for (const [id, r] of current) {
    const fp = shapeFingerprint(r.node);
    const prev = old.get(id);
    const ready = r.status === "READY_FOR_DEV";
    const wasReady = prev?.status === "READY_FOR_DEV";
    const since = ready ? (wasReady ? prev.ready_since : now) : null;
    db.run(
      `INSERT INTO nodes (project, file_key, node_id, name, type, page_id, area_id, area_name, path, status, description, fingerprint, ready_since, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, file_key, node_id) DO UPDATE SET name = excluded.name, type = excluded.type, page_id = excluded.page_id,
         area_id = excluded.area_id, area_name = excluded.area_name, path = excluded.path, status = excluded.status,
         description = excluded.description, fingerprint = excluded.fingerprint, ready_since = excluded.ready_since, last_seen_at = excluded.last_seen_at`,
      project, fileKey, id, r.name, r.type, r.page_id, id, r.name, JSON.stringify(r.path), r.status, r.description, fp, since, now,
    );
    if (!ready) {
      if (wasReady) cancelled += cancelEvents(db, "project = ? AND file_key = ? AND node_id = ? AND kind IN ('ready', 'changed')", [project, fileKey, id], `marked ${r.status.toLowerCase().replace(/_/g, " ")} in Figma`);
      continue;
    }
    if (baseline) continue;
    // A section Tony pre-built while it was in progress: the batch updates that build.
    const w = watchOf(id, r.name);
    const payload = { name: r.name, path: r.path, description: r.description, type: r.type, page_id: r.page_id, ...(w ? { watch: w.node, prebuilt: true } : {}), ...(movedFrom.has(id) ? { moved_from: movedFrom.get(id) } : {}) };
    if (!wasReady || (backfill && !built.has(id))) {
      if (insertEvent(db, { key: `ready:${fileKey}:${id}:${since}`, project, file_key: fileKey, kind: "ready", role: "trigger", node_id: id, payload, detected_at: now, source_at: null })) events++;
    } else if (prev.fingerprint && prev.fingerprint !== fp && built.has(id) && triggers.changed_after_build) {
      if (insertEvent(db, { key: `changed:${fileKey}:${id}:${fp}`, project, file_key: fileKey, kind: "changed", role: "trigger", node_id: id, payload: { ...payload, why: "changed after it was built" }, detected_at: now, source_at: null })) events++;
    }
  }
  // Ready before, absent now: the mark was removed (or the node deleted or moved off the page).
  for (const [id, prev] of old) {
    if (current.has(id) || prev.status !== "READY_FOR_DEV" || !pageIds.includes(prev.page_id) || missing.has(prev.page_id)) continue;
    db.run("UPDATE nodes SET status = 'NONE', ready_since = NULL, last_seen_at = ? WHERE project = ? AND file_key = ? AND node_id = ?", now, project, fileKey, id);
    cancelled += cancelEvents(db, "project = ? AND file_key = ? AND node_id = ? AND kind IN ('ready', 'changed')", [project, fileKey, id], "no longer marked ready in Figma");
  }
  return { events, cancelled, warnings };
}

// Watched sections against their last full-depth read. A changed design fingerprint (moves and ready
// marks ignored) is a
// 'changed' trigger; a ready mark on the section or inside it is a 'ready' trigger (unless the node
// sits on a watched page, where reconcileReady raises it); an un-mark cancels a waiting ready event.
// A section with no baseline yet raises nothing and is returned for seeding; a missing one as gone.
export function reconcileWatches({ db, project, fileKey, resp, watches, readyHandled = () => false, now }) {
  let events = 0;
  let cancelled = 0;
  const warnings = [];
  const unseeded = [];
  const gone = [];
  const rows = watchRows(db, project, fileKey);
  for (const w of watches) {
    const row = rows.get(w.node);
    const doc = docOf(resp, w.node);
    if (!doc) {
      if (!row) db.run("INSERT INTO watches (project, file_key, node_id, name, status) VALUES (?, ?, ?, ?, 'watching')", project, fileKey, w.node, w.name);
      if (row?.status !== "gone") gone.push(w);
      else warnings.push(`watched section "${w.name}": ${row.warning ?? `node ${w.node} is gone`}`);
      db.run("UPDATE watches SET status = 'gone', last_seen_at = last_seen_at WHERE project = ? AND file_key = ? AND node_id = ?", project, fileKey, w.node);
      continue;
    }
    if (!row?.baseline_id) {
      unseeded.push({ watch: w, doc });
      continue;
    }
    const fp = designFingerprint(doc);
    const ready = readyNodesOf(doc);
    const payload = { name: w.name, watch: w.node, lane: w.lane, figma_name: doc.name };
    let change = null;
    if (row.fingerprint && row.fingerprint !== fp) {
      if (insertEvent(db, { key: `changed:${fileKey}:${w.node}:${fp}`, project, file_key: fileKey, kind: "changed", role: "trigger", node_id: w.node, payload: { ...payload, why: "the in-progress design changed" }, detected_at: now, source_at: null })) {
        events++;
        change = "design changed";
      }
      indexArea(db, project, fileKey, w, doc);
    }
    if (ready.length && row.status !== "ready" && !readyHandled(w.node)) {
      const p = { ...payload, why: "marked ready for dev", ready_nodes: ready.map((r) => ({ id: r.id, name: r.name })), description: ready[0].description, prebuilt: true };
      if (insertEvent(db, { key: `ready:${fileKey}:${w.node}:${now}`, project, file_key: fileKey, kind: "ready", role: "trigger", node_id: w.node, payload: p, detected_at: now, source_at: null })) {
        events++;
        change = "marked ready for dev";
      }
    } else if (!ready.length && row.status === "ready") {
      cancelled += cancelEvents(db, "project = ? AND file_key = ? AND node_id = ? AND kind = 'ready'", [project, fileKey, w.node], "no longer marked ready in Figma");
      change ??= "ready mark removed";
    }
    db.run(
      `UPDATE watches SET name = ?, figma_name = ?, status = ?, fingerprint = ?, last_seen_at = ?, warning = NULL,
         last_change_at = COALESCE(?, last_change_at), last_change = COALESCE(?, last_change) WHERE project = ? AND file_key = ? AND node_id = ?`,
      w.name, doc.name, ready.length ? "ready" : "watching", fp, now, change ? now : null, change, project, fileKey, w.node,
    );
  }
  return { events, cancelled, warnings, unseeded, gone };
}

// Re-read built, still-ready nodes at full depth and compare with the build's fingerprint.
// At most `limit` nodes per tick, oldest check first, so a large page never floods Tier 1.
export async function deepCheck({ db, client, project, fileKey, now, limit = 4 }) {
  let calls = 0;
  let events = 0;
  const rows = db.all(
    `SELECT n.node_id, n.name, n.deep_fingerprint AS checked_fp,
            (SELECT l.deep_fingerprint FROM ledger l WHERE l.project = n.project AND l.key = 'node:' || n.file_key || ':' || n.node_id
               AND l.outcome IN ('applied', 'already_done') ORDER BY l.at DESC LIMIT 1) AS built_fp
     FROM nodes n WHERE n.project = ? AND n.file_key = ? AND n.status = 'READY_FOR_DEV' ORDER BY n.last_seen_at`,
    project, fileKey,
  ).filter((r) => r.built_fp);
  for (const r of rows.slice(0, limit)) {
    const resp = await client.nodes(fileKey, [r.node_id]);
    calls++;
    const doc = docOf(resp, r.node_id);
    if (!doc) continue;
    const fp = shapeFingerprint(doc);
    db.run("UPDATE nodes SET deep_fingerprint = ? WHERE project = ? AND file_key = ? AND node_id = ?", fp, project, fileKey, r.node_id);
    if (fp !== r.built_fp && insertEvent(db, { key: `changed:${fileKey}:${r.node_id}:${fp}`, project, file_key: fileKey, kind: "changed", role: "trigger", node_id: r.node_id, payload: { name: r.name, why: "changed after it was built" }, detected_at: now, source_at: null }))
      events++;
  }
  return { calls, events };
}

export function reconcileVersions({ db, project, fileKey, versions, mode, baseline, now }) {
  let events = 0;
  const seen = new Set(db.all("SELECT version_id FROM versions WHERE project = ? AND file_key = ?", project, fileKey).map((r) => r.version_id));
  for (const v of versions) {
    if (seen.has(v.id)) continue;
    db.run("INSERT INTO versions (project, file_key, version_id, label, description, created_at, author) VALUES (?, ?, ?, ?, ?, ?, ?)", project, fileKey, v.id, v.label, v.description, v.created_at, v.user?.handle);
    if (baseline || !v.label) continue; // autosaves carry no label
    const role = mode === "trigger" ? "trigger" : "context";
    if (insertEvent(db, { key: `version:${fileKey}:${v.id}`, project, file_key: fileKey, kind: "version", role, payload: { label: v.label, description: v.description, by: v.user?.handle }, detected_at: now, source_at: v.created_at })) events++;
  }
  return events;
}

// Manual enqueue from a Figma link. Dedupe on file, node, comment and note so the same
// request twice is one event.
export function addManual({ db, project, fileKey, nodeId, commentId, note, clock = Date.now }) {
  const now = nowIso(clock);
  const thread = commentId ? db.get("SELECT root_id FROM comments WHERE project = ? AND file_key = ? AND comment_id = ?", project, fileKey, commentId)?.root_id ?? commentId : null;
  const key = `manual:${fileKey}:${nodeId ?? ""}:${commentId ?? ""}:${sha(note ?? "", 8)}`;
  const inserted = insertEvent(db, {
    key,
    project,
    file_key: fileKey,
    kind: commentId ? "comment" : "manual",
    role: "trigger",
    node_id: nodeId,
    comment_id: commentId,
    thread_id: thread,
    payload: { note: note ?? "", manual: true },
    detected_at: now,
    source_at: now,
  });
  return { key, inserted };
}
