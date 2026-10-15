// Batching: when do a project's pending events become one batch, and which items does it hold.
// One batch per project at a time, never one session per pin.
import { existsSync } from "node:fs";
import { nowIso, localDay, budgetToday } from "./db.mjs";
import { paths } from "./paths.mjs";
import { applyScope } from "./scope.mjs";
import { watchesOf, watchSpec, watchOfItem } from "./watch.mjs";
import { slugify } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";

const MIN = 60 * 1000;
export const ACTIVE = ["ready", "extracting", "running"];
export const UNREVIEWED = ["ready", "extracting", "running", "done", "stuck"];

export function inActiveHours(spec, ms) {
  if (!spec) return true;
  const [a, b] = spec.split("-").map((t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  });
  const d = new Date(ms);
  const cur = d.getHours() * 60 + d.getMinutes();
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b; // "22:00-06:00" wraps midnight
}

// planBatch -> { go, reason, wait: [why not yet], triggers, context }
// opts.now skips the waiting rules (quiet window, unreviewed backlog, active hours, pacing,
// min gap). PAUSE, a blocked project, the daily batch cap and an active batch still apply.
export function planBatch({ db, config, clock = Date.now, now: force = false, pace = null }) {
  const project = config.project.slug;
  const t = clock();
  const b = config.batching;
  const wait = [];
  applyScope({ db, config }); // out-of-scope events never reach a batch
  const triggers = db.all("SELECT * FROM events WHERE project = ? AND status = 'pending' AND role = 'trigger' ORDER BY detected_at, id", project);
  const context = db.all("SELECT * FROM events WHERE project = ? AND status = 'pending' AND role = 'context' ORDER BY detected_at, id", project);
  const out = { go: false, reason: null, wait, triggers, context };
  if (!triggers.length) {
    wait.push("nothing to build");
    return out;
  }

  // Hard stops.
  if (existsSync(paths().pause)) wait.push("paused (figpipe resume to continue)");
  const ps = db.get("SELECT blocked, blocked_until FROM project_state WHERE project = ?", project);
  if (ps?.blocked) wait.push(`blocked: ${ps.blocked}`);
  if (ps?.blocked_until && Date.parse(ps.blocked_until) > t) wait.push(`Figma rate limit until ${new Date(ps.blocked_until).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`);
  const active = db.get(`SELECT id, status, wait_kind, error FROM batches WHERE project = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`, project, ...ACTIVE);
  if (active) wait.push(active.status === "ready" && active.wait_kind ? `batch ${active.id} waits: ${active.error}` : `batch ${active.id} is ${active.status}`);
  const madeToday = db.all("SELECT created_at FROM batches WHERE project = ?", project).filter((r) => localDay(Date.parse(r.created_at)) === localDay(t)).length;
  if (config.limits.batches_per_day && madeToday >= config.limits.batches_per_day) wait.push(`daily cap of ${config.limits.batches_per_day} batches reached`);
  const spent = Number(budgetToday(db, project, t).usd ?? 0);
  if (config.limits.usd_per_day && spent >= config.limits.usd_per_day) wait.push(`$${spent.toFixed(2)} of today's $${config.limits.usd_per_day} spent`);
  if (wait.length) return out;

  const oldest = Date.parse(triggers[0].detected_at);
  const atMaxWait = t - oldest >= b.max_wait_minutes * MIN;

  if (!force) {
    const unreviewed = db.get(`SELECT COUNT(*) AS n FROM batches WHERE project = ? AND status IN (${UNREVIEWED.map(() => "?").join(",")})`, project, ...UNREVIEWED).n;
    if (config.project.max_unreviewed_batches > 0 && unreviewed >= config.project.max_unreviewed_batches)
      wait.push(`${unreviewed} batch${unreviewed === 1 ? "" : "es"} waiting for your review (figpipe ack <batch>)`);
    if (!inActiveHours(b.active_hours, t)) wait.push(`outside active hours ${b.active_hours}`);
    const last = db.get("SELECT MAX(created_at) AS at FROM batches WHERE project = ?", project).at;
    if (b.min_gap_minutes && last && t - Date.parse(last) < b.min_gap_minutes * MIN) wait.push(`less than ${b.min_gap_minutes} min since the last batch`);
    if (wait.length) return out;

    // Quiet window: no new events and no edits in the file for quiet_minutes.
    const lastEvent = Math.max(...[...triggers, ...context].map((e) => Date.parse(e.detected_at)));
    const touched = db
      .all("SELECT last_touched_at FROM files WHERE project = ? AND role = 'live'", project)
      .map((r) => Date.parse(r.last_touched_at ?? ""))
      .filter(Number.isFinite);
    const lastActivity = Math.max(lastEvent, ...touched);
    const quiet = t - lastActivity >= b.quiet_minutes * MIN;
    const namedVersion =
      config.triggers.named_versions === "close_batch" && context.some((e) => e.kind === "version" && Date.parse(e.detected_at) >= oldest);
    if (atMaxWait) out.reason = `oldest item waited ${b.max_wait_minutes} min`;
    else if (namedVersion) out.reason = "the designer saved a named version";
    else if (quiet) out.reason = `designer quiet for ${b.quiet_minutes} min`;
    else {
      const left = Math.ceil((lastActivity + b.quiet_minutes * MIN - t) / MIN);
      wait.push(`designer active; quiet window ends in ${left} min`);
      return out;
    }
    // Pacing against the weekly usage meter: non-urgent batches wait.
    if (pace && config.limits.pace_with_usage_meter && !atMaxWait) {
      const p = pace();
      if (p?.ahead) {
        wait.push(`usage ahead of pace (${p.text}); waiting up to ${b.max_wait_minutes} min`);
        return out;
      }
    }
  } else out.reason = "run --now";
  out.go = true;
  return out;
}

// Group pending events into items. Node events (ready, changed, manual) are one item per node;
// comment events are one item per thread. Versions and identity warnings stay batch context.
export function groupItems(db, project, events) {
  const items = new Map();
  for (const e of events) {
    if (e.kind === "version" || e.kind === "identity") continue;
    const k = e.kind === "comment" ? `thread:${e.file_key}:${e.thread_id ?? e.comment_id}` : `node:${e.file_key}:${e.node_id ?? ""}`;
    let it = items.get(k);
    if (!it) {
      it = { key: k, file_key: e.file_key, kind: e.kind, node_id: e.node_id, thread_id: e.kind === "comment" ? e.thread_id ?? e.comment_id : null, events: [], role: e.role };
      items.set(k, it);
    }
    it.events.push(e);
    // Precedence when several events hit one node: changed beats ready, ready beats manual.
    const rank = { manual: 0, ready: 1, changed: 2, comment: 0 };
    if ((rank[e.kind] ?? 0) > (rank[it.kind] ?? 0)) it.kind = e.kind;
    if (e.role === "trigger") it.role = "trigger";
  }
  for (const it of items.values()) {
    const pin = it.node_id;
    const n = pin ? db.get("SELECT name, area_id, area_name FROM nodes WHERE project = ? AND file_key = ? AND node_id = ?", project, it.file_key, pin) : null;
    const a = !n && pin ? db.get("SELECT area_id, area_name FROM node_areas WHERE project = ? AND file_key = ? AND node_id = ?", project, it.file_key, pin) : null;
    it.area_id = n?.area_id ?? a?.area_id ?? null;
    it.area_name = n?.area_name ?? a?.area_name ?? null;
    const first = JSON.parse(it.events[0].payload || "{}");
    it.title =
      it.kind === "comment"
        ? `${first.by ?? "Comment"}: ${String(first.text ?? first.note ?? "").replace(/\s+/g, " ").slice(0, 80)}`
        : n?.name ?? first.name ?? (it.node_id ? `Node ${it.node_id}` : "Whole file");
  }
  return [...items.values()];
}

export function batchId(project, ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${project}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Create the batch: trigger items up to max_items (oldest first), plus every pending context
// event that touches them or the batch as a whole. Leftover triggers wait for the next batch.
export function createBatch({ db, config, plan, clock = Date.now }) {
  const project = config.project.slug;
  return db.tx(() => {
    const all = groupItems(db, project, [...plan.triggers, ...plan.context]);
    const triggerItems = all.filter((i) => i.role === "trigger").slice(0, config.batching.max_items);
    const nodes = new Set(triggerItems.map((i) => `${i.file_key}:${i.node_id}`));
    const contextItems = all.filter((i) => i.role !== "trigger" && nodes.has(`${i.file_key}:${i.node_id}`));
    const chosen = [...triggerItems, ...contextItems];
    // Items on a watched section update its pre-built page: they carry the watch, and its section is their area.
    const watches = watchesOf(config);
    for (const it of chosen) {
      const ref = it.events.map((e) => JSON.parse(e.payload || "{}").watch).find(Boolean) ?? (it.kind !== "comment" ? it.node_id : null);
      const w = ref ? watches.find((x) => x.file_key === it.file_key && x.node === ref) : null;
      if (!w) continue;
      it.watch = watchSpec(db, config, w);
      it.area_id = w.node;
      it.area_name = w.name;
    }
    let id = batchId(project, clock());
    while (db.get("SELECT 1 FROM batches WHERE id = ?", id)) id += "b";
    const now = nowIso(clock);
    db.run("INSERT INTO batches (id, project, status, reason, autonomy, created_at) VALUES (?, ?, 'ready', ?, ?, ?)", id, project, plan.reason, config.project.autonomy, now);
    for (const it of chosen) {
      const r = db.run(
        `INSERT INTO items (batch_id, project, file_key, kind, node_id, thread_id, area_id, area_name, title, outcome, source, watch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, project, it.file_key, it.kind, it.node_id, it.thread_id, it.area_id, it.area_name, it.title, it.role === "trigger" ? "pending" : "fyi",
        JSON.stringify({ events: it.events.map((e) => ({ key: e.key, kind: e.kind, role: e.role, payload: JSON.parse(e.payload || "{}") })) }),
        it.watch ? JSON.stringify(it.watch) : null,
      );
      for (const e of it.events) db.run("UPDATE events SET status = 'batched', batch_id = ?, item_id = ? WHERE id = ?", id, Number(r.lastInsertRowid), e.id);
    }
    for (const e of plan.context.filter((e) => e.kind === "version" || e.kind === "identity"))
      db.run("UPDATE events SET status = 'batched', batch_id = ? WHERE id = ?", id, e.id);
    return { id, items: chosen.length, left: all.filter((i) => i.role === "trigger").length - triggerItems.length };
  });
}

// Lane key for an item: its watched section's lane, else its area (the ready node it sits in), else "comments".
export const laneOf = (item) => watchOfItem(item)?.lane ?? (item.area_name ? slugify(item.area_name) : item.kind === "comment" ? "comments" : slugify(item.title));
