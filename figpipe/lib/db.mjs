// SQLite state: what figpipe has seen in Figma, the events and batches built from it, and the
// report data each batch records. One file, readable with the sqlite3 CLI.
// Uses node:sqlite (Node 22.5+). figpipe.mjs hides its experimental warning.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.mjs";

export const SCHEMA_VERSION = 4;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Per watched (or stale-copy) file: identity evidence and polling cursors.
CREATE TABLE IF NOT EXISTS files (
  project TEXT NOT NULL, file_key TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'live',            -- live | stale
  name TEXT, last_touched_at TEXT, last_touched_by TEXT, version TEXT,
  touched_moved_at TEXT,                        -- when figpipe saw last_touched_at move
  page_ids TEXT,                                -- JSON {configured name or id: node id}
  nodes_baselined INTEGER NOT NULL DEFAULT 0,
  comments_baselined INTEGER NOT NULL DEFAULT 0,
  versions_baselined INTEGER NOT NULL DEFAULT 0,
  last_sweep_at TEXT, last_deep_check_at TEXT, last_watch_at TEXT, checked_at TEXT,
  warning TEXT,
  PRIMARY KEY (project, file_key)
);

-- Every node figpipe has seen with a devStatus, and its shallow fingerprint.
CREATE TABLE IF NOT EXISTS nodes (
  project TEXT NOT NULL, file_key TEXT NOT NULL, node_id TEXT NOT NULL,
  name TEXT, type TEXT, page_id TEXT, area_id TEXT, area_name TEXT, path TEXT,
  status TEXT NOT NULL,                         -- READY_FOR_DEV | COMPLETED | NONE
  description TEXT, fingerprint TEXT, deep_fingerprint TEXT,
  ready_since TEXT, last_seen_at TEXT,
  PRIMARY KEY (project, file_key, node_id)
);

-- Node id -> area (the page section a lane works on), learned from extractions.
CREATE TABLE IF NOT EXISTS node_areas (
  project TEXT NOT NULL, file_key TEXT NOT NULL, node_id TEXT NOT NULL,
  area_id TEXT NOT NULL, area_name TEXT,
  PRIMARY KEY (project, file_key, node_id)
);

CREATE TABLE IF NOT EXISTS comments (
  project TEXT NOT NULL, file_key TEXT NOT NULL, comment_id TEXT NOT NULL,
  root_id TEXT NOT NULL, parent_id TEXT, node_id TEXT,
  author_id TEXT, author TEXT, message TEXT, created_at TEXT, resolved_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  mentions_me INTEGER NOT NULL DEFAULT 0, by_me INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT,
  PRIMARY KEY (project, file_key, comment_id)
);

-- Ownership answers (figpipe own <name|url> mine|others): rules that outrank every inferred signal.
CREATE TABLE IF NOT EXISTS ownership (
  project TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT, file_key TEXT, node_id TEXT,
  owner TEXT NOT NULL,                          -- mine | others
  who TEXT NOT NULL DEFAULT '[]', answered_at TEXT,
  PRIMARY KEY (project, name_key)
);

CREATE TABLE IF NOT EXISTS versions (
  project TEXT NOT NULL, file_key TEXT NOT NULL, version_id TEXT NOT NULL,
  label TEXT, description TEXT, created_at TEXT, author TEXT,
  PRIMARY KEY (project, file_key, version_id)
);

-- Raw signals. key dedupes: ready:<file>:<node>:<since>, comment:<file>:<id>, version:<file>:<id>,
-- changed:<file>:<node>:<fp>, manual:<file>:<node>:<hash>, identity:<file>:<stale>:<touched>.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL, file_key TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- ready | changed | comment | version | manual | identity
  role TEXT NOT NULL,                           -- trigger | context
  node_id TEXT, comment_id TEXT, thread_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL, source_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | batched | done | cancelled
  batch_id TEXT, item_id INTEGER, note TEXT
);
CREATE INDEX IF NOT EXISTS events_pending ON events (project, status);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, project TEXT NOT NULL,
  status TEXT NOT NULL,                         -- ready | extracting | running | done | failed | stuck | reviewed | rejected
  reason TEXT, autonomy TEXT, dir TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, reviewed_at TEXT,
  session_id TEXT, pid INTEGER, pid_started TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  usd REAL, mcp_calls INTEGER NOT NULL DEFAULT 0,
  summary TEXT, error TEXT, result TEXT,
  figma_mcp TEXT,                               -- the session's Figma MCP status (connected, needs-auth, missing)
  reviewed_by TEXT,                             -- you | auto (nothing built or failed; questions stay listed)
  review_note TEXT,                             -- what the user said when closing it (figpipe ack <batch> --note)
  wait_kind TEXT,                               -- usage | auth | credit: Claude could not run the session; the batch stays ready
  wait_source TEXT,                             -- meter (the free check saw it) | session (a session was refused)
  retry_after TEXT, wait_note TEXT,             -- when figpipe tries again, and what Claude said
  probed_at TEXT,                               -- the last free check of whether the wait is over
  account TEXT                                  -- the Claude login the background session ran under
);

-- Units of work and, after the run, the report data per item.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL, project TEXT NOT NULL, file_key TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- ready | changed | comment | manual
  node_id TEXT, thread_id TEXT, area_id TEXT, area_name TEXT, title TEXT,
  fingerprint TEXT, deep_fingerprint TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending',      -- pending | applied | already_done | question | needs_you | fyi | failed | skipped | cancelled
  change_kind TEXT,                             -- copy | redesign | new_page | fix | motion | none
  verdict TEXT, branch TEXT, commits TEXT, worktree TEXT,
  preview TEXT, text_diff TEXT, reply TEXT, source TEXT, figma_render TEXT, motion TEXT, note TEXT,
  watch TEXT,                                   -- JSON: the watched section this item updates (node, name, lane, branch, route, built)
  figma_before TEXT,                            -- JSON renders of the design the build was made from
  components TEXT                               -- JSON: where each interactive element's states came from (result.schema.json)
);
CREATE INDEX IF NOT EXISTS items_batch ON items (batch_id);

CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
  width INTEGER NOT NULL, label TEXT, before_path TEXT, after_path TEXT, figma_path TEXT
);

-- Report lines: decision | question | flag | not_done | check.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, item_id INTEGER,
  kind TEXT NOT NULL, text TEXT NOT NULL, detail TEXT, section TEXT, status TEXT
);

-- What was done per comment thread and per node, read by later batches so they never re-ask
-- or re-apply. key: thread:<file>:<root id> | node:<file>:<node id>.
CREATE TABLE IF NOT EXISTS ledger (
  project TEXT NOT NULL, key TEXT NOT NULL, batch_id TEXT NOT NULL, item_id INTEGER,
  outcome TEXT NOT NULL, branch TEXT, commits TEXT, fingerprint TEXT, deep_fingerprint TEXT, at TEXT NOT NULL,
  PRIMARY KEY (project, key, batch_id)
);

-- Node JSON per build (batch_id) or per watch baseline (batch_id 'baseline-...'), and its renders
-- (JSON [{ node_id, name, width, path }]), for structural diffs and Figma before/after.
CREATE TABLE IF NOT EXISTS snapshots (
  project TEXT NOT NULL, file_key TEXT NOT NULL, node_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  deep_fingerprint TEXT, path TEXT, at TEXT NOT NULL, renders TEXT,
  PRIMARY KEY (project, file_key, node_id, batch_id)
);

-- Watched sections ([[figma.files.watch]]): in-progress designs the user pre-built. fingerprint is
-- the last full-depth one seen; baseline_id names the snapshot the local build was made from.
CREATE TABLE IF NOT EXISTS watches (
  project TEXT NOT NULL, file_key TEXT NOT NULL, node_id TEXT NOT NULL,
  name TEXT, figma_name TEXT,
  status TEXT NOT NULL DEFAULT 'watching',      -- watching | ready | gone
  fingerprint TEXT, baseline_id TEXT, baseline_at TEXT,
  last_seen_at TEXT, last_change_at TEXT, last_change TEXT,
  warning TEXT,
  moved_from TEXT, moved_at TEXT,               -- the node id it had before the designer moved it, and when figpipe followed
  page_name TEXT,                               -- the page it sits on, when known
  PRIMARY KEY (project, file_key, node_id)
);

CREATE TABLE IF NOT EXISTS budget (
  day TEXT NOT NULL, project TEXT NOT NULL,
  mcp_calls INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0, rest_429s INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project)
);

CREATE TABLE IF NOT EXISTS project_state (
  project TEXT PRIMARY KEY, blocked TEXT, blocked_at TEXT,
  blocked_until TEXT,                           -- Figma asked for a long rate-limit wait; checks resume after it
  last_tick_at TEXT, last_tick_ok INTEGER, last_tick_summary TEXT,
  warnings TEXT                                 -- JSON list from the last check, shown by status and the index
);

-- Follow mode: the designers' working blocks derived from their activity, and when figpipe last tried.
-- blocks: JSON [{ start, end }] in minutes of the designers' day; fallback = too little activity.
CREATE TABLE IF NOT EXISTS follow_blocks (
  project TEXT PRIMARY KEY,
  derived_at TEXT,                              -- the last successful derivation
  attempted_at TEXT, ok INTEGER, error TEXT,    -- the last attempt, successful or not
  timezone TEXT, days TEXT, blocks TEXT, fallback INTEGER NOT NULL DEFAULT 0, reason TEXT,
  events INTEGER NOT NULL DEFAULT 0, active_days INTEGER NOT NULL DEFAULT 0
);

-- Commands the guard refused during a batch, for the report.
CREATE TABLE IF NOT EXISTS denials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, at TEXT NOT NULL, tool TEXT, input TEXT, reason TEXT
);
`;

export function openDb(file = paths().db) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
  db.exec(DDL);
  const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (v && Number(v.value) > SCHEMA_VERSION) throw new Error(`state.db is schema ${v.value}; this figpipe knows ${SCHEMA_VERSION}. Update Pantograph.`);
  migrate(db);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return wrap(db);
}

// Columns added after schema 1. CREATE TABLE IF NOT EXISTS leaves an older table as it is.
const ADDED = {
  batches: { pid_started: "TEXT", figma_mcp: "TEXT", reviewed_by: "TEXT", review_note: "TEXT", wait_kind: "TEXT", wait_source: "TEXT", retry_after: "TEXT", wait_note: "TEXT", probed_at: "TEXT", account: "TEXT" },
  watches: { moved_from: "TEXT", moved_at: "TEXT", page_name: "TEXT" },
  project_state: { blocked_until: "TEXT", warnings: "TEXT" },
  files: { last_watch_at: "TEXT" },
  items: { watch: "TEXT", figma_before: "TEXT", components: "TEXT" },
  snapshots: { renders: "TEXT" },
};
function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

// Small conveniences over DatabaseSync.
function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  // node:sqlite rejects undefined; map it to null.
  const clean = (args) => args.map((a) => (a === undefined ? null : typeof a === "boolean" ? Number(a) : a));
  return {
    raw: db,
    all: (sql, ...a) => stmt(sql).all(...clean(a)),
    get: (sql, ...a) => stmt(sql).get(...clean(a)),
    run: (sql, ...a) => stmt(sql).run(...clean(a)),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}

export const nowIso = (clock) => new Date(clock ? clock() : Date.now()).toISOString();
export const dayOf = (iso) => iso.slice(0, 10);

// Budget rows are per local day so "today" matches what Tony sees.
export function localDay(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function bumpBudget(db, project, field, by = 1, ms = Date.now()) {
  const day = localDay(ms);
  db.run("INSERT INTO budget (day, project) VALUES (?, ?) ON CONFLICT DO NOTHING", day, project);
  db.run(`UPDATE budget SET ${field} = ${field} + ? WHERE day = ? AND project = ?`, by, day, project);
}

export function budgetToday(db, project, ms = Date.now()) {
  return db.get("SELECT * FROM budget WHERE day = ? AND project = ?", localDay(ms), project) ?? { mcp_calls: 0, usd: 0, batches: 0, rest_429s: 0 };
}
