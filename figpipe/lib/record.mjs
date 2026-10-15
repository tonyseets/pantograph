// Record a batch result (result.schema.json) into state.db: item outcomes, report data and the
// ledger later batches read so they never re-ask or re-apply.
//
// Two ways in. The session records each item as soon as it is settled (`figpipe record <batch>
// <part.json> --partial`), so a timeout or budget stop keeps every finished item. At the end the
// session returns `figpipe result <batch>` (rebuilt from these rows) as its final answer, and the
// supervisor records that in full, which also closes items the session never mentioned.
import { readFileSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { FIGPIPE_DIR } from "./paths.mjs";
import { nowIso, bumpBudget } from "./db.mjs";

export const RESULT_SCHEMA_PATH = join(FIGPIPE_DIR, "schema", "result.schema.json");
export const resultSchema = () => JSON.parse(readFileSync(RESULT_SCHEMA_PATH, "utf8"));
// A partial result: the same shape with every top-level field optional.
export const partialSchema = () => ({ ...resultSchema(), required: [] });

// JSON Schema subset: type, required, properties, additionalProperties: false, items, enum, minimum.
export function checkSchema(schema, v, path = "result", errors = []) {
  const t = Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v;
  const want = schema.type;
  if (want && !(want === t || (want === "number" && t === "integer"))) {
    errors.push(`${path}: expected ${want}, got ${t}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(v)) errors.push(`${path}: "${v}" is not one of ${schema.enum.join(", ")}`);
  if (schema.minimum !== undefined && typeof v === "number" && v < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  if (t === "object") {
    for (const k of schema.required ?? []) if (v[k] === undefined) errors.push(`${path}.${k}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties?.[k]) checkSchema(schema.properties[k], x, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not in the schema`);
    }
  }
  if (t === "array" && schema.items) v.forEach((x, i) => checkSchema(schema.items, x, `${path}[${i}]`, errors));
  return errors;
}

const NODE_OUTCOMES_DONE = new Set(["applied", "already_done"]);

// An element whose states the build proposed, for want of a design, becomes a question in the
// report: nobody could answer during the batch, so it asks afterwards whether those states are
// wanted. Each question says what the build used meanwhile. Written from the item's components.
const PROPOSED = { figma_elsewhere: "the same element elsewhere in the Figma file", project: "the project's existing component", platform_default: "the platform default" };
export function stateQuestions(rows = []) {
  return rows
    .filter((r) => PROPOSED[r.source])
    .map((r) => {
      const several = /,|\band\b/.test(r.states ?? "");
      const what = r.states ? `${r.states} ${several ? "states" : "state"}` : "states";
      const used = String(r.used || PROPOSED[r.source]).replace(/\.$/, "");
      if (r.source === "figma_elsewhere") return `${r.element} has no ${what} of its own in Figma; the build takes ${several || !r.states ? "them" : "it"} from ${used}. Is that right?`;
      return `${r.element} has no ${what} in Figma; the build uses ${used}. ${r.states ? `Should it have ${several ? "them" : "one"}?` : "Which states should it have?"}`;
    });
}

function writeItem(db, batch, it, r, abs, now) {
  db.run("DELETE FROM notes WHERE item_id = ? AND kind IN ('decision', 'question', 'flag')", it.id);
  db.run("DELETE FROM captures WHERE item_id = ?", it.id);
  db.run(
    `UPDATE items SET outcome = ?, change_kind = ?, verdict = ?, branch = ?, commits = ?, worktree = ?, preview = ?, text_diff = ?, reply = ?, components = ? WHERE id = ?`,
    r.outcome, r.change_kind, r.verdict, r.branch ?? it.branch, JSON.stringify(r.commits ?? []), r.worktree ?? it.worktree,
    JSON.stringify(r.preview ?? []), JSON.stringify(r.text_diff ?? []), r.reply ?? null, JSON.stringify(r.components ?? []), it.id,
  );
  for (const c of r.captures ?? [])
    db.run("INSERT INTO captures (item_id, width, label, before_path, after_path, figma_path) VALUES (?, ?, ?, ?, ?, ?)", it.id, c.width, c.label ?? null, abs(c.before), abs(c.after), abs(c.figma));
  for (const d of r.decisions ?? []) db.run("INSERT INTO notes (batch_id, item_id, kind, text, detail) VALUES (?, ?, 'decision', ?, ?)", batch.id, it.id, d.text, d.default_applied);
  const questions = [...(r.questions ?? [])];
  for (const text of stateQuestions(r.components)) if (!questions.some((q) => q.text === text)) questions.push({ text });
  for (const q of questions) db.run("INSERT INTO notes (batch_id, item_id, kind, text, section, detail) VALUES (?, ?, 'question', ?, ?, ?)", batch.id, it.id, q.text, q.section ?? null, q.layer ?? null);
  for (const f of r.flags ?? []) db.run("INSERT INTO notes (batch_id, item_id, kind, text) VALUES (?, ?, 'flag', ?)", batch.id, it.id, f);

  // Ledger: per node and per thread, what this batch did.
  const keys = [];
  if (it.node_id && it.kind !== "comment") keys.push(`node:${it.file_key}:${it.node_id}`);
  if (it.thread_id) keys.push(`thread:${it.file_key}:${it.thread_id}`);
  for (const k of keys)
    db.run(
      `INSERT OR REPLACE INTO ledger (project, key, batch_id, item_id, outcome, branch, commits, fingerprint, deep_fingerprint, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      batch.project, k, batch.id, it.id, r.outcome, r.branch ?? null, JSON.stringify(r.commits ?? []), it.fingerprint, NODE_OUTCOMES_DONE.has(r.outcome) ? it.deep_fingerprint : null, now,
    );
  db.run("UPDATE events SET status = 'done' WHERE item_id = ?", it.id);
}

// recordResult({ db, batchId, result, batchDir, usd, sessionId, partial }) -> { items }
export function recordResult({ db, batchId, result, batchDir, usd = null, sessionId = null, clock = Date.now, partial = false }) {
  const errors = checkSchema(partial ? partialSchema() : resultSchema(), result);
  if (errors.length) throw new Error(`result does not match result.schema.json:\n${errors.slice(0, 20).map((e) => `  - ${e}`).join("\n")}`);
  const batch = db.get("SELECT * FROM batches WHERE id = ?", batchId);
  if (!batch) throw new Error(`no batch ${batchId}`);
  const items = new Map(db.all("SELECT * FROM items WHERE batch_id = ?", batchId).map((i) => [i.id, i]));
  const named = result.items ?? [];
  const unknown = named.filter((r) => !items.has(r.item_id)).map((r) => r.item_id);
  if (unknown.length) throw new Error(`result names items that are not in batch ${batchId}: ${unknown.join(", ")}`);
  const abs = (p) => (!p ? null : isAbsolute(p) ? p : join(batchDir, p));
  const now = nowIso(clock);

  db.tx(() => {
    for (const r of named) writeItem(db, batch, items.get(r.item_id), r, abs, now);
    if (partial) {
      // Appends are idempotent: the same line recorded twice is stored once; a check is replaced by name.
      for (const n of result.not_done ?? []) {
        const detail = n.command ?? n.patch ?? null;
        if (!db.get("SELECT id FROM notes WHERE batch_id = ? AND kind = 'not_done' AND text = ? AND item_id IS ?", batchId, n.text, n.item_id ?? null))
          db.run("INSERT INTO notes (batch_id, item_id, kind, text, detail) VALUES (?, ?, 'not_done', ?, ?)", batchId, n.item_id ?? null, n.text, detail);
      }
      for (const c of result.checks ?? []) {
        db.run("DELETE FROM notes WHERE batch_id = ? AND kind = 'check' AND text = ?", batchId, c.name);
        db.run("INSERT INTO notes (batch_id, kind, text, status, detail) VALUES (?, 'check', ?, ?, ?)", batchId, c.name, c.status, c.detail ?? null);
      }
      if (result.summary) db.run("UPDATE batches SET summary = ? WHERE id = ?", result.summary, batchId);
      if (result.mcp_calls !== undefined) db.run("UPDATE batches SET mcp_calls = MAX(mcp_calls, ?) WHERE id = ?", result.mcp_calls, batchId);
      return;
    }
    db.run("DELETE FROM notes WHERE batch_id = ? AND kind IN ('not_done', 'check')", batchId);
    for (const n of result.not_done) db.run("INSERT INTO notes (batch_id, item_id, kind, text, detail) VALUES (?, ?, 'not_done', ?, ?)", batchId, n.item_id ?? null, n.text, n.command ?? n.patch ?? null);
    for (const c of result.checks) db.run("INSERT INTO notes (batch_id, kind, text, status, detail) VALUES (?, 'check', ?, ?, ?)", batchId, c.name, c.status, c.detail ?? null);
    // Items the session never settled are not silently dropped: they return to the queue.
    const settled = new Set(named.map((r) => r.item_id));
    for (const it of items.values())
      if (!settled.has(it.id) && db.get("SELECT outcome FROM items WHERE id = ?", it.id).outcome === "pending") {
        db.run("UPDATE items SET outcome = 'failed', verdict = 'The session returned no result for this item.' WHERE id = ?", it.id);
        db.run("INSERT INTO notes (batch_id, item_id, kind, text) VALUES (?, ?, 'not_done', 'No result came back for this item; it returns to the queue.')", batchId, it.id);
        db.run("UPDATE events SET status = 'pending', batch_id = NULL, item_id = NULL WHERE item_id = ?", it.id);
      }
    db.run("UPDATE batches SET summary = ?, result = ?, usd = COALESCE(?, usd), session_id = COALESCE(?, session_id), mcp_calls = MAX(mcp_calls, ?) WHERE id = ?", result.summary, JSON.stringify(result), usd, sessionId, result.mcp_calls ?? 0, batchId);
    if (usd) bumpBudget(db, batch.project, "usd", usd, clock());
  });
  return { items: named.length };
}

const j = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

// The batch result as recorded so far, in result.schema.json shape: what a session returns as its
// final answer, so the answer always matches the rows. Items still pending are left out.
export function resultFromDb(db, batchId, batchDir) {
  const batch = db.get("SELECT * FROM batches WHERE id = ?", batchId);
  if (!batch) throw new Error(`no batch ${batchId}`);
  const rel = (p) => (!p ? undefined : batchDir && p.startsWith(batchDir + "/") ? relative(batchDir, p) : p);
  const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));
  const items = db
    .all("SELECT * FROM items WHERE batch_id = ? AND outcome NOT IN ('pending', 'cancelled') ORDER BY id", batchId)
    .map((it) => {
      const notes = (kind) => db.all("SELECT * FROM notes WHERE item_id = ? AND kind = ? ORDER BY id", it.id, kind);
      return drop({
        item_id: it.id,
        outcome: it.outcome,
        change_kind: it.change_kind ?? "none",
        verdict: it.verdict ?? "",
        branch: it.branch,
        commits: j(it.commits, []),
        worktree: it.worktree,
        preview: j(it.preview, []),
        captures: db.all("SELECT * FROM captures WHERE item_id = ? ORDER BY id", it.id).map((c) => drop({ width: c.width, label: c.label, before: rel(c.before_path), after: rel(c.after_path), figma: rel(c.figma_path) })),
        text_diff: j(it.text_diff, []),
        decisions: notes("decision").map((n) => ({ text: n.text, default_applied: n.detail ?? "" })),
        questions: notes("question").map((n) => drop({ text: n.text, section: n.section, layer: n.detail })),
        flags: notes("flag").map((n) => n.text),
        components: j(it.components, []),
        reply: it.reply,
      });
    });
  const notDone = db.all("SELECT * FROM notes WHERE batch_id = ? AND kind = 'not_done' ORDER BY id", batchId).map((n) => {
    const isPatch = n.detail && /\.patch$/.test(n.detail);
    return drop({ item_id: n.item_id, text: n.text, ...(isPatch ? { patch: n.detail } : { command: n.detail }) });
  });
  const checks = db.all("SELECT * FROM notes WHERE batch_id = ? AND kind = 'check' ORDER BY id", batchId).map((c) => drop({ name: c.text, status: c.status, detail: c.detail }));
  const outcomes = items.reduce((a, i) => ((a[i.outcome] = (a[i.outcome] ?? 0) + 1), a), {});
  const summary =
    batch.summary ??
    ([outcomes.applied && `${outcomes.applied} built`, outcomes.question && `${outcomes.question} for the designer`, outcomes.needs_you && `${outcomes.needs_you} for you`, outcomes.failed && `${outcomes.failed} failed`].filter(Boolean).join(", ") || "Nothing built.");
  return { summary, items, not_done: notDone, checks, mcp_calls: batch.mcp_calls ?? 0 };
}
