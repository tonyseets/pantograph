// figpipe command line. See figpipe/REFERENCE.md for the full surface.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { paths, FIGPIPE_DIR } from "./paths.mjs";
import { loadAllProjects, loadProject, parseConfig, displayName } from "./config.mjs";
import { openDb, nowIso, bumpBudget, budgetToday } from "./db.mjs";
import { createClient } from "../../skills/figma-transpose/scripts/figma-rest.mjs";
import { parseFigmaUrl } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";
import { reconcileProject, addManual } from "./reconcile.mjs";
import { applyScope, scopeSummary, scopeLine, askLines, recordOwnership, ownershipTable, ownedSections } from "./scope.mjs";
import { planBatch, createBatch, ACTIVE } from "./batcher.mjs";
import { extractBatch } from "./extract.mjs";
import { startBatch, supervise, notify, readPace, pidAlive, batchDirOf, blockUntil, viaBroker, dueForStart, cleanupLanes, batchLog } from "./run.mjs";
import { recordResult, resultFromDb } from "./record.mjs";
import { writeReport, writeIndex, stillShown, statusLabel, batchLine } from "./report.mjs";
import { runGuardHook } from "./guard.mjs";
import { plist, installPlan, label } from "./launchd.mjs";
import { WEEKDAYS, scheduleOf, dueState, nextCheck, describe as describeSchedule, describeDays, fmtAt, machineZone, wakeMinutes } from "./schedule.mjs";
import { fetchActivity, toEvents, analyse, suggestionToml, shiftBlock } from "./activity.mjs";
import { scheduleFor, needsRefresh, refreshBlocks, loadDerived, followView, wakeCommand, deriveBlocks } from "./follow.mjs";
import { capture, stateActions } from "./capture.mjs";
import { watchesOf, watchView, watchLine, seedWatch } from "./watch.mjs";
import { probeRepo, probeFigma, doctor, formatDoctor } from "./setup.mjs";
import { writeSample } from "./sample.mjs";
import { tmpdir } from "node:os";

const HELP = `figpipe: watch Figma, batch handoffs, run one guarded Claude session per batch.

You:
  figpipe status [--json]                                     projects, what waits and why, open batches, today's spend
  figpipe tick [--dry-run] [--backfill] [--project <slug>]   check Figma, batch, start what is ready (the background job runs this)
  figpipe own <name|figma-link> mine|others [--who "A, B"]     say whose a section is; answers become rules and are never asked twice
  figpipe own --list [--project <slug>] [--json]               every ready section with its inferred owner and why
  figpipe watch [<slug>] [--json]                             in-progress sections you pre-built that figpipe keeps in step, and the last change seen
  figpipe watch baseline <slug> [<name|node>...] | --all      record the current Figma design as what your build was made from (after a hand update);
                                                              --all takes every watched section and every ready section that is yours
  figpipe add <figma-link> [--note "..."] [--project <slug>]   queue a node or comment by hand
  figpipe run <project> [--now] [--dry-run] [--foreground]    batch and start now (--now skips the quiet window)
  figpipe run --batch <id> [--dry-run]                        start or retry one batch
  figpipe ack <batch> | reject <batch> [--note "..."]         mark a batch reviewed or rejected
  figpipe report --index | --sample [--out <dir>]             re-render the index, or render the sample report
  figpipe pause | resume                                      stop or restart new batches
  figpipe probe [<repo>] [<figma-link>...] [--pages "A,B"] [--json]   what setup can infer, read-only
  figpipe activity [<figma-link>] [--project <slug>] [--days 30] [--tz Zone] [--json]   when designers edit and comment, and a suggested schedule
  figpipe doctor [<slug>] [--json]                            re-check a configured project
  figpipe budget [--project <slug>]                           today's spend
  figpipe config check <slug|file> | example                  validate a config, or print an example
  figpipe launchd plist | install | uninstall [--minutes N]   print the background job and its commands

Used by batch sessions:
  figpipe record <batch> <result.json> [--partial]            store a result (or part of one) and render the report
  figpipe result <batch>                                      the result recorded so far, as result.schema.json
  figpipe capture <batch> --item <id> | --lane <l> --as <name>  --phase before|after --url <local url> [--selector css] [--widths ...]
  figpipe capture <batch> --item <id> --state <name> --url <local url> [--selector css] [--click css] [--fill css --text "..."]
                          [--focus css] [--hover css] [--press css]   one state of a built element, at the component render scale
  figpipe report <batch>                                      re-render one batch's report
  figpipe budget mcp --batch <id>                             yes or no before a Figma MCP call
  figpipe extract <batch>                                     redo the REST extraction for a batch
  figpipe guard --batch <id>                                  PreToolUse hook for batch sessions

State lives in ${paths().home} (FIGPIPE_HOME overrides).`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  const bools = new Set(["dry-run", "backfill", "now", "json", "foreground", "index", "help", "partial", "sample", "all"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (bools.has(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const out = (s) => process.stdout.write(s + "\n");
const ago = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

function logLine(s) {
  const dir = paths().logs;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "figpipe.log"), `${nowIso()} ${s}\n`);
}

function clientFor(db, config) {
  return createClient({
    tokenRef: config.figma.pat_ref,
    backoff: config.figma.backoff,
    onEvent: (e) => {
      if (e.type === "rate_limited") {
        bumpBudget(db, config.project.slug, "rest_429s");
        logLine(`${config.project.slug}: Figma rate limit on ${e.path}, waiting ${e.wait_s}s`);
      }
    },
  });
}

// A pid lock so a manual tick and the launchd tick never overlap.
function withLock(fn) {
  const lock = paths().lock;
  mkdirSync(paths().home, { recursive: true });
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pidAlive(pid) && pid !== process.pid) {
      out(`another tick is running (pid ${pid})`);
      return 0;
    }
  }
  writeFileSync(lock, String(process.pid));
  const release = () => rmSync(lock, { force: true });
  return Promise.resolve()
    .then(fn)
    .finally(release);
}

const projectName = (config) => displayName(config);
// The display name for a batch's project, from its config when it loads.
function nameOf(slug) {
  try {
    return displayName(loadProject(slug));
  } catch {
    return displayName(slug);
  }
}

// A finished batch with nothing built, failed or waiting on Tony's decision does not hold up new
// work: it is marked reviewed by figpipe, and its questions stay listed in the index.
export function autoReview(db, batchId) {
  const b = db.get("SELECT status FROM batches WHERE id = ?", batchId);
  if (b?.status !== "done") return false;
  const busy = db.get("SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND outcome IN ('applied', 'failed', 'needs_you', 'pending')", batchId).n;
  if (busy) return false;
  db.run("UPDATE batches SET status = 'reviewed', reviewed_by = 'auto', reviewed_at = ? WHERE id = ?", nowIso(), batchId);
  return true;
}

// The lanes a batch made, from its manifest; lanes that got no commit and hold no edits are removed.
function clearEmptyLanes(db, config, batchId) {
  const b = db.get("SELECT project, dir FROM batches WHERE id = ?", batchId);
  const dir = b?.dir ?? batchDirOf(config.project.slug, batchId);
  let lanes = [];
  try {
    lanes = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8")).lanes ?? [];
  } catch {}
  let removed = [];
  try {
    removed = cleanupLanes({ config, lanes });
  } catch {}
  if (removed.length) batchLog(dir, `removed ${removed.map((r) => r.branch).join(", ")}: no commits`);
  return removed;
}

function finishReport(db, config, batchId, status) {
  if (status === "done" && autoReview(db, batchId)) clearEmptyLanes(db, config, batchId);
  const file = writeReport(db, batchId, { projectName: projectName(config) });
  const line = batchLine(db, batchId);
  const msg = status === "waiting" ? `${db.get("SELECT error FROM batches WHERE id = ?", batchId)?.error ?? "Waiting for Claude"}. The items are kept.` : status === "stuck" ? "Stopped. Open the report." : line || "Nothing new to build.";
  notify({ title: `Figma: ${projectName(config)}`, message: msg, file, mode: config.report.notify });
  return file;
}

// Supervisors that died (Mac restarted mid-batch) leave "running" rows behind.
export function reapDead(db) {
  for (const b of db.all(`SELECT * FROM batches WHERE status IN (${ACTIVE.map(() => "?").join(",")})`, ...ACTIVE)) {
    if (b.status === "ready" || pidAlive(b.pid, b.pid_started)) continue;
    const status = b.attempts >= 2 ? "stuck" : "ready";
    db.run("UPDATE batches SET status = ?, error = COALESCE(error, 'the batch process stopped unexpectedly') WHERE id = ?", status, b.id);
    logLine(`batch ${b.id}: process gone, now ${status}`);
  }
}

async function launchNext(db, projects, { log }) {
  reapDead(db);
  if (db.get("SELECT id FROM batches WHERE status IN ('extracting', 'running')")) return null;
  // The oldest ready batch. One that waits for Claude (usage limit, signed out) is looked at again
  // once its wait is over, or hourly for a free check of whether it lifted early.
  const next = db.all("SELECT * FROM batches WHERE status = 'ready' ORDER BY created_at").find((b) => dueForStart(b));
  if (!next) return null;
  const p = projects.find((x) => x.slug === next.project);
  if (!p?.config) {
    db.run("UPDATE batches SET status = 'stuck', error = ? WHERE id = ?", `project ${next.project} has no valid config`, next.id);
    return null;
  }
  if (existsSync(paths().pause)) return null;
  const config = p.config;
  try {
    const r = await startBatch({ db, config, batchId: next.id, client: clientFor(db, config), extractFn: extractBatch, log });
    if (r.finished) finishReport(db, config, next.id, r.stuck ? "stuck" : "done");
    if (r.waiting && !next.wait_kind) finishReport(db, config, next.id, "waiting");
    else if (r.waiting) writeIndex(db);
    log(`batch ${next.id}: ${r.started ? `started (pid ${r.pid})` : r.finished ? "finished without a session" : r.why}`);
    return r;
  } catch (e) {
    log(`batch ${next.id}: ${e.message}`);
    return null;
  }
}

async function cmdTick(db, flags) {
  const projects = loadAllProjects().filter((p) => !flags.project || p.slug === flags.project);
  const dry = !!flags["dry-run"];
  const log = (s) => {
    out(s);
    if (!dry) logLine(s);
  };
  if (!projects.length) {
    out(`no projects in ${paths().projects}`);
    return 0;
  }
  // Finished batches with nothing built, failed or waiting on a decision stop holding up new work
  // (batches that finished before figpipe did this on its own included).
  if (!dry) {
    const swept = db.all("SELECT id, project FROM batches WHERE status = 'done' AND reviewed_by IS NULL").filter((b) => autoReview(db, b.id));
    for (const b of swept) {
      const cfg = projects.find((p) => p.slug === b.project)?.config;
      if (cfg) clearEmptyLanes(db, cfg, b.id);
    }
    if (swept.length) {
      log(`marked ${swept.map((b) => b.id).join(", ")} reviewed: nothing built; questions stay listed`);
      writeIndex(db);
    }
  }
  let checked = 0;
  for (const p of projects) {
    if (p.error) {
      log(`${p.slug}: config refused\n${p.error}`);
      continue;
    }
    const config = p.config;
    const state = db.get("SELECT * FROM project_state WHERE project = ?", p.slug);
    // Not due: say nothing (the background job wakes every few minutes). A named project or a dry
    // run always checks.
    const due = dueState({ sc: scheduleFor(db, config), last: state?.last_tick_at ? Date.parse(state.last_tick_at) : null, lastOk: state?.last_tick_ok !== 0, now: Date.now() });
    if (!due.due && !dry && !flags.project) continue;
    if (state?.blocked && !dry) {
      log(`${p.slug}: blocked (${state.blocked}); fix it, then figpipe status shows it cleared after the next good tick`);
    }
    if (due.why === "catch-up" && !dry) log(`${p.slug}: catching up on a check missed while the Mac was asleep`);
    if (state?.blocked_until && Date.parse(state.blocked_until) > Date.now()) {
      log(`${p.slug}: Figma asked to wait; next check after ${state.blocked_until}`);
      continue;
    }
    checked++;
    if (dry) db.exec("BEGIN");
    try {
      const client = clientFor(db, config);
      // Follow mode: derive the designers' working blocks when they are missing or old (version and comment lists only).
      if (needsRefresh({ row: loadDerived(db, p.slug), config, now: Date.now() })) {
        const r = await refreshBlocks({ db, config, client });
        const f = followView(scheduleFor(db, config));
        log(r.ok ? `${p.slug}: follow: ${r.fallback ? `${r.reason}; checking ${f.blocks.map((b) => b.designer).join(", ")} ${f.timezone} until there is more` : `working blocks ${f.blocks.map((b) => b.designer).join(", ")} ${f.timezone} from ${r.events} events on ${r.active_days} days`}` : `${p.slug}: follow: could not read the designers' activity (${r.error}); using ${f.fallback ? "the fallback blocks" : "the last blocks"}`);
      }
      const s = await reconcileProject({ db, config, client, backfill: !!flags.backfill, seed: !dry, log });
      for (const w of s.warnings) log(`${p.slug}: ${w}`);
      for (const n of s.unseeded) out(`  would record a baseline for watched section "${n}"`);
      if (dry) for (const m of s.moved) out(`  would re-point the watch "${m.name}" to "${m.to_name}" (${m.to}) and keep its baseline; nothing is changed in a dry run`);
      const scoped = new Map(applyScope({ db, config }).map((c) => [c.key, c]));
      if (dry)
        for (const e of s.events) {
          const c = scoped.get(e.key);
          out(c?.status === "out_of_scope" ? `  out of scope: ${c.name} (${c.reason})` : c?.status === "needs_owner" ? `  is this yours? ${c.name} (${c.reason})` : `  new ${e.role}: ${e.key}`);
        }
      if (!dry)
        db.run(
          "INSERT INTO project_state (project, last_tick_at, last_tick_ok, last_tick_summary, blocked, blocked_until, warnings) VALUES (?, ?, 1, ?, NULL, NULL, ?) ON CONFLICT (project) DO UPDATE SET last_tick_at = excluded.last_tick_at, last_tick_ok = 1, last_tick_summary = excluded.last_tick_summary, blocked = NULL, blocked_until = NULL, warnings = excluded.warnings",
          p.slug, nowIso(), `${s.events.length} new events`, s.warnings.length ? JSON.stringify(s.warnings) : null,
        );
      const plan = planBatch({ db, config, pace: () => readPace(db) });
      if (plan.go) {
        if (dry) out(`  would start a batch: ${plan.reason}; ${plan.triggers.length} trigger events`);
        else {
          const b = createBatch({ db, config, plan });
          log(`${p.slug}: batch ${b.id} with ${b.items} items (${plan.reason})${b.left ? `; ${b.left} wait for the next batch` : ""}`);
        }
      } else if (plan.triggers.length || dry) log(`${p.slug}: ${plan.triggers.length} waiting; ${plan.wait.join("; ")}`);
    } catch (e) {
      if (dry) {
        out(`${p.slug}: ${e.message}`);
      } else {
        const blocked = e.kind === "auth" || e.kind === "token" ? `Figma token problem: ${e.message}` : null;
        if (e.kind === "rate_limit" && e.retry_after_s) blockUntil(db, p.slug, Date.now() + e.retry_after_s * 1000);
        db.run("INSERT INTO project_state (project, last_tick_at, last_tick_ok, last_tick_summary) VALUES (?, ?, 0, ?) ON CONFLICT (project) DO UPDATE SET last_tick_at = excluded.last_tick_at, last_tick_ok = 0, last_tick_summary = excluded.last_tick_summary", p.slug, nowIso(), e.message);
        if (blocked && !state?.blocked) {
          db.run("UPDATE project_state SET blocked = ?, blocked_at = ? WHERE project = ?", blocked, nowIso(), p.slug);
          notify({ title: `Figma: ${projectName(config)}`, message: "Figma rejected the token. Checks are paused for this project.", file: paths().index, mode: config.report.notify });
        }
        log(`${p.slug}: ${e.message}`);
      }
    } finally {
      if (dry) db.exec("ROLLBACK");
    }
  }
  if (!dry) await launchNext(db, loadAllProjects(), { log });
  // Run by hand with nothing due: one line, so it does not look broken. The background job stays silent.
  if (!checked && process.stdout.isTTY) {
    const next = projects.filter((p) => p.config).map((p) => ({ slug: p.slug, ...scheduleView(db, p) })).sort((a, b) => (a.next_check_at ?? "9").localeCompare(b.next_check_at ?? "9"))[0];
    out(next ? `No checks due. Next: ${next.slug}, ${next.next_check_local}. figpipe tick --project ${next.slug} checks now.` : "No checks due.");
  }
  return 0;
}

// Follow mode's working blocks, when they were derived and what they came from.
function followLine(f) {
  const when = f.derived_at ? `derived ${ago(f.derived_at)} from ${f.events} events on ${f.active_days} days` : "not derived yet";
  if (f.fallback) return `blocks: ${f.blocks.map((b) => b.designer).join(", ")} ${f.timezone}, a fallback (${f.reason}${f.derived_at ? `; tried ${ago(f.derived_at)}` : ""})`;
  return `blocks: ${f.text}, ${when}${f.pre_day ? `; ${f.pre_day.extra_check ? `extra check at ${f.pre_day.time}` : `check at ${f.pre_day.time}`} before your ${f.pre_day.my_day_starts} start` : ""}`;
}

// A project's schedule in words, and its next check in the Mac's time and the project's time.
export function scheduleView(db, p, now = Date.now()) {
  const sc = scheduleFor(db, p.config);
  const state = db.get("SELECT last_tick_at, last_tick_ok FROM project_state WHERE project = ?", p.slug);
  const local = machineZone();
  const nc = nextCheck({ sc, last: state?.last_tick_at ? Date.parse(state.last_tick_at) : null, lastOk: state?.last_tick_ok !== 0, now });
  const both = (ms) => (local === sc.timezone ? `${fmtAt(ms, local)} (${local}, your Mac and the project)` : `${fmtAt(ms, local)} (${local}, your Mac) · ${fmtAt(ms, sc.timezone)} (${sc.timezone})`);
  const follow = sc.mode === "follow" ? followView(sc, now) : null;
  return {
    mode: sc.mode,
    description: describeSchedule(sc),
    timezone: sc.timezone,
    local_timezone: local,
    days: sc.days,
    times: sc.times,
    windows: sc.windows,
    poll_minutes: sc.mode === "interval" ? sc.poll_minutes : null,
    follow,
    wake_command: follow ? wakeCommand(sc, now) : null,
    due_now: nc.now,
    next_check_at: nc.at == null ? null : new Date(nc.at).toISOString(),
    next_check_local: nc.at == null ? "no check is scheduled" : nc.now ? "due now (at the next wake of the background job)" : both(nc.at),
  };
}

function findProjectForFile(fileKey, slug) {
  const all = loadAllProjects().filter((p) => p.config && (!slug || p.slug === slug));
  const live = all.filter((p) => p.config.figma.files.some((f) => f.key === fileKey));
  const stale = all.filter((p) => p.config.figma.files.some((f) => f.stale_copies.includes(fileKey)));
  return { live, stale };
}

function cmdAdd(db, flags, pos) {
  const ref = parseFigmaUrl(pos[0] ?? "");
  if (!ref) {
    out("Paste a Figma link (figma.com/design/<file>/...?node-id=...).");
    return 2;
  }
  if (!ref.nodeId && !ref.commentId) {
    out("The link has no node-id. Right-click the layer in Figma, Copy link, and paste that.");
    return 2;
  }
  const { live, stale } = findProjectForFile(ref.fileKey, flags.project);
  if (!live.length) {
    if (stale.length) out(`That link is in a stale copy (${ref.fileKey}) that ${stale[0].slug} watches for drift only. Use the link from the live file.`);
    else out(`No project watches file ${ref.fileKey}. Add it to a project config first.`);
    return 1;
  }
  if (live.length > 1) {
    out(`Several projects watch this file: ${live.map((p) => p.slug).join(", ")}. Pass --project.`);
    return 1;
  }
  const config = live[0].config;
  const r = addManual({ db, project: config.project.slug, fileKey: ref.fileKey, nodeId: ref.nodeId, commentId: ref.commentId, note: flags.note });
  out(r.inserted ? `Queued for ${config.project.slug}. It runs after the quiet window, or now with: figpipe run ${config.project.slug} --now` : "Already queued.");
  return 0;
}

function projectFor(slug) {
  const all = loadAllProjects().filter((p) => p.config);
  const hit = slug ? all.filter((p) => p.slug === slug) : all;
  if (hit.length !== 1) throw new Error(hit.length ? `Several projects: ${hit.map((p) => p.slug).join(", ")}. Pass --project.` : slug ? `no project "${slug}"` : "no project is configured");
  return hit[0].config;
}

// figpipe own --list: read the watched pages (rolled back, nothing kept) and show every ready section's owner.
// figpipe own <name|link> mine|others: record the answer as a rule and re-judge what waits.
async function cmdOwn(db, flags, pos) {
  if (flags.list) {
    const config = projectFor(flags.project);
    db.exec("BEGIN");
    try {
      await reconcileProject({ db, config, client: clientFor(db, config), backfill: true, log: () => {} });
      const rows = ownershipTable({ db, config });
      if (flags.json) out(JSON.stringify(rows, null, 1));
      else {
        for (const r of rows) out(`${r.owner.padEnd(7)} ${r.confidence.padEnd(8)} ${r.name}${r.path.length ? ` (in ${r.path.join(" / ")})` : ""}: ${r.why}${r.drift ? `\n        drift: ${r.drift.why}` : ""}`);
        if (!rows.length) out("No ready sections found on the watched pages.");
      }
    } finally {
      db.exec("ROLLBACK");
    }
    return 0;
  }
  const [target, owner] = pos;
  if (!target || !["mine", "others"].includes(owner)) {
    out('usage: figpipe own <section name | figma link> mine|others [--who "Name, Name"] [--project <slug>]  |  figpipe own --list');
    return 2;
  }
  let name = target;
  let nodeId = null;
  let fileKey = null;
  let config;
  const ref = parseFigmaUrl(target);
  if (ref) {
    if (!ref.nodeId) {
      out("The link has no node-id. Right-click the section in Figma, Copy link, and paste that.");
      return 2;
    }
    const { live } = findProjectForFile(ref.fileKey, flags.project);
    if (live.length !== 1) {
      out(live.length ? `Several projects watch this file: ${live.map((p) => p.slug).join(", ")}. Pass --project.` : `No project watches file ${ref.fileKey}.`);
      return 1;
    }
    config = live[0].config;
    nodeId = ref.nodeId.replace(/-/g, ":");
    fileKey = ref.fileKey;
    const n = db.get("SELECT name FROM nodes WHERE project = ? AND file_key = ? AND node_id = ?", config.project.slug, fileKey, nodeId);
    if (!n) {
      out("figpipe has not seen that section as ready for dev yet. Use its name instead, or run a check first.");
      return 1;
    }
    name = n.name;
  } else {
    config = projectFor(flags.project);
    const hit = db.all("SELECT node_id, file_key, name FROM nodes WHERE project = ? AND lower(name) = lower(?)", config.project.slug, name);
    if (hit.length === 1) ({ node_id: nodeId, file_key: fileKey } = hit[0]);
    else if (!hit.length) out(`No section named "${name}" has been seen yet; the answer is saved by name and applies when it shows up.`);
  }
  const who = flags.who ? flags.who.split(",").map((x) => x.trim()).filter(Boolean) : [];
  recordOwnership({ db, project: config.project.slug, name, nodeId, fileKey, owner, who });
  const changed = applyScope({ db, config });
  out(`${name}: ${owner}${who.length ? ` (${who.join(", ")})` : ""}. ${owner === "mine" ? "It is built from the next batch." : "It is skipped."}`);
  const back = changed.filter((c) => c.status === "pending").length;
  if (back) out(`${back} waiting item${back === 1 ? "" : "s"} now count${back === 1 ? "s" : ""} as yours.`);
  return 0;
}

function cmdStatus(db, flags) {
  const projects = loadAllProjects();
  const data = projects.map((p) => {
    const state = db.get("SELECT * FROM project_state WHERE project = ?", p.slug) ?? {};
    const pending = db.all("SELECT kind, role, COUNT(*) AS n FROM events WHERE project = ? AND status = 'pending' GROUP BY kind, role", p.slug);
    const batches = db.all("SELECT id, status, reviewed_by, summary, dir, created_at, error, wait_kind, retry_after, account FROM batches WHERE project = ? ORDER BY created_at DESC LIMIT 200", p.slug).filter((b) => stillShown(db, b));
    const plan = p.config ? planBatch({ db, config: p.config }) : null;
    const scope = scopeSummary(db, p.slug);
    return { scope, slug: p.slug, error: p.error ?? null, autonomy: p.config?.project.autonomy, state, pending, batches, wait: plan?.wait ?? [], budget: budgetToday(db, p.slug), share: p.config?.figma.mcp.pipeline_share, schedule: p.config ? scheduleView(db, p) : null, watches: p.config ? watchView(db, p.config) : [] };
  });
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label()}.plist`);
  const runner = existsSync(plistPath) ? "installed" : "not installed (figpipe launchd install)";
  if (flags.json) {
    out(JSON.stringify({ home: paths().home, paused: existsSync(paths().pause), runner, projects: data }, null, 1));
    return 0;
  }
  out(`figpipe · ${paths().home} · background check ${runner}${existsSync(paths().pause) ? " · PAUSED" : ""}`);
  if (!data.length) out(`No projects. Add one at ${paths().projects}/<slug>.toml (figpipe config example).`);
  for (const d of data) {
    out("");
    if (d.error) {
      out(`${d.slug}: config refused`);
      out(d.error.replace(/^/gm, "  "));
      continue;
    }
    const triggers = d.pending.filter((x) => x.role === "trigger").reduce((a, x) => a + x.n, 0);
    out(`${d.slug} · ${d.autonomy} · last check ${ago(d.state.last_tick_at)}${d.state.last_tick_ok === 0 ? ` (failed: ${d.state.last_tick_summary})` : ""}`);
    out(`  schedule: ${d.schedule.description}`);
    if (d.schedule.follow) out(`  ${followLine(d.schedule.follow)}`);
    out(`  next check: ${d.schedule.next_check_local}`);
    if (d.state.blocked) out(`  blocked: ${d.state.blocked}`);
    if (d.state.blocked_until && Date.parse(d.state.blocked_until) > Date.now()) out(`  Figma rate limit: no checks until ${new Date(d.state.blocked_until).toLocaleString()}`);
    for (const w of JSON.parse(d.state.warnings || "[]")) out(`  warning: ${w}`);
    out(`  waiting: ${triggers}${triggers ? ` (${d.wait.join("; ")})` : ""}`);
    if (d.watches.length) {
      out(`  watching ${d.watches.length} in-progress section${d.watches.length === 1 ? "" : "s"} you pre-built:`);
      for (const v of d.watches) out(`    ${watchLine(v, ago)}`);
    }
    if (d.scope.n) out(`  ${scopeLine(d.scope)}`);
    for (const l of askLines(d.scope)) out(`  ${l}`);
    for (const b of d.batches) out(`  ${b.id} · ${statusLabel(b)}${b.summary ? ` · ${b.summary}` : ""}${b.error ? ` · ${b.error}` : ""}${b.dir && existsSync(join(b.dir, "report.html")) ? `\n    ${join(b.dir, "report.html")}` : ""}`);
    out(`  today: ${d.budget.batches} batches · $${Number(d.budget.usd).toFixed(2)} · ${d.budget.mcp_calls}/${d.share} Figma MCP calls${d.budget.rest_429s ? ` · ${d.budget.rest_429s} rate limits` : ""}`);
  }
  return 0;
}

// figpipe watch [<slug>] lists the watched sections; figpipe watch baseline <slug> [<name|node>...]
// records the current design as what the local build was made from (Figma reads only).
async function cmdWatch(db, flags, pos) {
  if (pos[0] === "baseline") {
    const config = loadProject(pos[1] ?? flags.project ?? "");
    const want = pos.slice(2).map((x) => x.trim().toLowerCase());
    const watched = watchesOf(config);
    // Ready sections that are yours and not watched count as built from this design too: named, or
    // every one of them with --all.
    const owned = flags.all || want.length ? ownedSections({ db, config }).map((r) => ({ node: r.node_id, name: r.name, file_key: r.file_key, branch: config.git.base_branch, built: true, owned: true })) : [];
    const all = [...watched, ...owned];
    const is = (w, x) => w.name.toLowerCase() === x || w.node === x.replace(/-/g, ":");
    const chosen = want.length ? all.filter((w) => want.some((x) => is(w, x))) : flags.all ? all : watched;
    const unknown = want.filter((x) => !all.some((w) => is(w, x)));
    if (unknown.length) {
      out(`Not watched or yours in ${config.project.slug}: ${unknown.join(", ")}. Watched: ${watched.map((w) => w.name).join(", ") || "none"}.${owned.length ? ` Yours and ready: ${owned.map((w) => w.name).join(", ")}.` : ""}`);
      return 1;
    }
    if (!chosen.length) {
      out(`${config.project.slug} watches no sections. Add [[figma.files.watch]] entries to ${config._file}.`);
      return 1;
    }
    const client = clientFor(db, config);
    let failed = 0;
    // Full-depth reads, a few sections at a time: a whole page of sections in one answer is too much.
    const groups = [];
    for (const fileKey of [...new Set(chosen.map((w) => w.file_key))]) {
      const ws = chosen.filter((w) => w.file_key === fileKey);
      for (let i = 0; i < ws.length; i += 3) groups.push({ fileKey, ws: ws.slice(i, i + 3) });
    }
    for (const { fileKey, ws } of groups) {
      const resp = await client.nodes(fileKey, ws.map((w) => w.node));
      for (const w of ws) {
        try {
          const r = await seedWatch({ db, config, client, fileKey, watch: w, resp, owned: !!w.owned });
          out(`${w.name}: baseline recorded (${r.renders} renders${r.built ? "" : ", not built yet"}${r.settled ? `, ${r.settled} waiting change${r.settled === 1 ? "" : "s"} settled` : ""}) in ${r.dir}`);
          for (const x of r.warnings) out(`  ${x}`);
        } catch (e) {
          failed++;
          out(`${w.name}: ${e.message}`);
        }
      }
    }
    return failed ? 1 : 0;
  }
  const projects = loadAllProjects().filter((p) => p.config && (!pos[0] || p.slug === pos[0]));
  const data = projects.map((p) => ({ slug: p.slug, watches: watchView(db, p.config) }));
  if (flags.json) {
    out(JSON.stringify(data, null, 1));
    return 0;
  }
  for (const d of data) {
    out(`${d.slug}: ${d.watches.length ? `${d.watches.length} watched` : "no watched sections"}`);
    for (const v of d.watches) out(`  ${watchLine(v, ago)}`);
  }
  return 0;
}

async function cmdRun(db, flags, pos) {
  reapDead(db);
  let config;
  let batchId = flags.batch;
  if (batchId) {
    const b = db.get("SELECT * FROM batches WHERE id = ?", batchId);
    if (!b) throw new Error(`no batch ${batchId}`);
    config = loadProject(b.project);
    if (["stuck", "failed"].includes(b.status) && !flags["dry-run"]) db.run("UPDATE batches SET status = 'ready', attempts = 0 WHERE id = ?", batchId);
  } else {
    if (!pos[0]) throw new Error("usage: figpipe run <project> [--now] [--dry-run]");
    config = loadProject(pos[0]);
    const existing = db.get(`SELECT id FROM batches WHERE project = ? AND status = 'ready' ORDER BY created_at LIMIT 1`, config.project.slug);
    if (existing) batchId = existing.id;
    else {
      const plan = planBatch({ db, config, now: !!flags.now, pace: flags.now ? null : () => readPace(db) });
      if (!plan.go) {
        out(`Not starting: ${plan.wait.join("; ")}`);
        return 1;
      }
      if (flags["dry-run"]) {
        out(`Would batch ${plan.triggers.length} trigger events (${plan.reason}).`);
        return 0;
      }
      batchId = createBatch({ db, config, plan }).id;
    }
  }
  const r = await startBatch({ db, config, batchId, client: clientFor(db, config), extractFn: extractBatch, dryRun: !!flags["dry-run"], foreground: !!flags.foreground, force: true, log: out });
  if (r.dryRun) {
    out(`Manifest: ${r.manifest}`);
    if (r.command) out(`Command: ${join(batchDirOf(config.project.slug, batchId), "session", "command.json")}`);
    for (const l of r.lanes) out(`  lane ${l.lane}: ${l.branch} from ${l.base} in ${l.worktree}${l.blocked ? ` (blocked: ${l.blocked})` : ""}`);
    return 0;
  }
  if (r.finished) {
    out(finishReport(db, config, batchId, r.stuck ? "stuck" : "done"));
    return 0;
  }
  if (!r.started) {
    if (r.waiting) writeReport(db, batchId, { projectName: projectName(config) });
    out(r.why);
    return 1;
  }
  if (r.foreground) {
    const res = await supervise({ db, config, batchId, after: ({ status }) => status !== "ready" && finishReport(db, config, batchId, status) });
    out(`${batchId}: ${res.status}${res.error ? ` (${res.error})` : ""}`);
    return res.status === "done" ? 0 : 1;
  }
  out(`Started ${batchId} (pid ${r.pid}). Report: ${join(batchDirOf(config.project.slug, batchId), "report.html")} when it finishes.`);
  return 0;
}

async function cmdSupervise(db, pos) {
  const b = db.get("SELECT * FROM batches WHERE id = ?", pos[0]);
  if (!b) throw new Error(`no batch ${pos[0]}`);
  const config = loadProject(b.project);
  const res = await supervise({ db, config, batchId: b.id, after: ({ status }) => status !== "ready" && finishReport(db, config, b.id, status) });
  logLine(`batch ${b.id}: ${res.status}${res.error ? ` (${res.error})` : ""}`);
  return res.status === "done" ? 0 : 1;
}

function cmdBudget(db, flags, pos) {
  let project = flags.project;
  if (flags.batch) project = db.get("SELECT project FROM batches WHERE id = ?", flags.batch)?.project;
  if (!project && process.env.FIGPIPE_BATCH) project = db.get("SELECT project FROM batches WHERE id = ?", process.env.FIGPIPE_BATCH)?.project;
  const projects = loadAllProjects().filter((p) => p.config && (!project || p.slug === project));
  if (pos[0] === "mcp") {
    if (projects.length !== 1) throw new Error("pass --batch or --project");
    const c = projects[0].config;
    const used = budgetToday(db, c.project.slug).mcp_calls;
    const left = c.figma.mcp.pipeline_share - used;
    const general = left - c.figma.mcp.reserve_for_motion;
    if (left <= 0) {
      out(`no: ${used} of ${c.figma.mcp.pipeline_share} Figma MCP calls used today`);
      return 1;
    }
    out(`yes: ${left} left today (${Math.max(0, general)} for anything, the last ${Math.min(left, c.figma.mcp.reserve_for_motion)} held for motion)`);
    return 0;
  }
  for (const p of projects) {
    const b = budgetToday(db, p.slug);
    out(`${p.slug}: ${b.batches} batches · $${Number(b.usd).toFixed(2)} · ${b.mcp_calls}/${p.config.figma.mcp.pipeline_share} MCP calls · ${b.rest_429s} REST rate limits`);
  }
  return 0;
}

async function cmdGuard(db, flags) {
  const batchId = flags.batch ?? process.env.FIGPIPE_BATCH;
  let stdinText = "";
  for await (const chunk of process.stdin) stdinText += chunk;
  const b = batchId ? db.get("SELECT * FROM batches WHERE id = ?", batchId) : null;
  if (!b) {
    process.stderr.write("figpipe guard: unknown batch; denied\n");
    return 2;
  }
  const g = JSON.parse(readFileSync(join(b.dir ?? batchDirOf(b.project, b.id), "session", "guard.json"), "utf8"));
  const config = loadProject(b.project);
  return runGuardHook({ db, config, batch: b.id, writeRoots: g.writeRoots, protect: g.protect ?? [], stdinText });
}

// figpipe ack | reject <batch> [--note "..."]. The batch is closed: its queued items never run.
// Lanes it made that got no commit and hold no edits are removed; branches with work stay.
function setStatus(db, id, status, note = null) {
  const b = db.get("SELECT * FROM batches WHERE id = ?", id);
  if (!b) throw new Error(`no batch ${id}`);
  if (["extracting", "running"].includes(b.status) && pidAlive(b.pid, b.pid_started)) throw new Error(`batch ${id} is ${b.status} (pid ${b.pid}); wait for it to finish`);
  db.run("UPDATE batches SET status = ?, reviewed_at = ?, reviewed_by = 'you', review_note = COALESCE(?, review_note), wait_kind = NULL, wait_source = NULL, retry_after = NULL WHERE id = ?", status, nowIso(), typeof note === "string" && note.trim() ? note.trim() : null, id);
  let removed = [];
  try {
    removed = clearEmptyLanes(db, loadProject(b.project), id);
  } catch {}
  if (b.dir && existsSync(join(b.dir, "batch.json"))) writeReport(db, id, { projectName: nameOf(b.project) });
  else writeIndex(db);
  const branches = db.all("SELECT DISTINCT branch FROM items WHERE batch_id = ? AND branch IS NOT NULL", id).map((r) => r.branch);
  out(`${id}: ${status}.${branches.length ? ` Branches: ${branches.join(", ")}` : ""}`);
  if (removed.length) out(`Removed ${removed.length} empty lane${removed.length === 1 ? "" : "s"} (no commits): ${removed.map((r) => r.branch).join(", ")}.`);
  if (status === "rejected" && branches.length) out("The branches stay as they are; delete them yourself if you don't want them.");
  return 0;
}

// Inside a batch session figpipe answers only what the session needs, and only for its own batch.
const SESSION_COMMANDS = new Set(["budget", "record", "result", "capture", "report", "status", "guard", "help"]);
function sessionRefusal(cmd, flags, rest) {
  if (process.env.FIGPIPE_SESSION !== "1") return null;
  if (!SESSION_COMMANDS.has(cmd)) return `figpipe ${cmd} is not available inside a batch session`;
  const own = process.env.FIGPIPE_BATCH;
  if (["record", "result", "capture", "report"].includes(cmd) && (flags.index || flags.sample || rest[0] !== own)) return `inside a batch session figpipe ${cmd} works only on batch ${own}`;
  if (cmd === "record" && !flags.partial) return "inside a batch session, record with --partial; figpipe records the final result itself";
  return null;
}

async function cmdCapture(db, flags, pos) {
  const b = db.get("SELECT * FROM batches WHERE id = ?", pos[0]);
  if (!b) throw new Error(`no batch ${pos[0]}`);
  // --item <id> files the shots under that item; --as <name> (with --lane) keeps other shots, such
  // as regression routes, apart from any item.
  const itemId = flags.item !== undefined ? Number(flags.item) : null;
  const name = flags.as ? String(flags.as).replace(/[^A-Za-z0-9._-]+/g, "-") : null;
  if (itemId === null && !name) throw new Error("usage: figpipe capture <batch> (--item <id> | --lane <lane> --as <name>) --phase before|after --url <local url>");
  if (itemId !== null && !db.get("SELECT id FROM items WHERE id = ? AND batch_id = ?", itemId, b.id)) throw new Error(`item ${itemId} is not in batch ${b.id}`);
  if (!flags.url || (!flags.phase && !flags.state)) throw new Error("pass --phase before|after (or --state <name>) and --url http://localhost:<port>/<route>");
  const config = loadProject(b.project);
  const dir = b.dir ?? batchDirOf(b.project, b.id);
  let lanes = [];
  try {
    lanes = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8")).lanes ?? [];
  } catch {}
  const lane = lanes.find((l) => l.lane === flags.lane) ?? lanes.find((l) => (l.items ?? []).includes(itemId));
  const given = flags.widths ? String(flags.widths).split(",").map(Number).filter((w) => w >= 200) : null;
  if (flags.state) {
    // One state of a built element (hover, focus, checked, open), at the scale of the component
    // set renders so the two can be set side by side. One width unless more are asked for.
    const shots = await capture({ url: flags.url, batchDir: dir, itemId: name ?? itemId, state: flags.state, actions: stateActions(flags), widths: given ?? config.review.widths.slice(0, 1), selector: flags.selector ?? null, scale: config.extract.component_render_scale, dirs: [config.project.repo] });
    out(JSON.stringify(shots.map((s) => ({ width: s.width, state: s.state, path: s.rel, height: s.height }))));
    return 0;
  }
  const widths = given ?? [...config.review.widths, ...config.review.extra_widths];
  const shots = await capture({ url: flags.url, batchDir: dir, itemId: name ?? itemId, phase: flags.phase, widths, selector: flags.selector ?? null, dirs: [config.project.repo] });
  out(JSON.stringify(shots.map((s) => ({ width: s.width, [flags.phase]: s.rel, height: s.height }))));
  return 0;
}

async function cmdProbe(pos, flags) {
  const [first, ...more] = pos;
  const repoArg = first && !/figma\.com/.test(first) ? first : process.cwd();
  const links = [first, ...more].filter((x) => x && /figma\.com|^[A-Za-z0-9]{20,}$/.test(x));
  const repo = probeRepo(repoArg);
  const tokenRef = flags["token-ref"] ?? (repo.tools.figma_pat ?? "file:~/.config/figma/pat");
  const client = createClient({ tokenRef });
  const figma = await probeFigma(client, links, { pages: flags.pages ? String(flags.pages).split(",").map((x) => x.trim()) : [], repoKeys: repo.figma.keys_in_repo.map((k) => k.key) });
  const res = { repo, figma, token_ref: tokenRef };
  if (flags.json) {
    out(JSON.stringify(res, null, 1));
    return 0;
  }
  const r = repo;
  out(`Repo ${r.repo}`);
  if (r.git) out(`  git: base ${r.git.base_branch}, on ${r.git.current}${r.git.dirty ? " (uncommitted edits)" : ""}, ${r.git.feature_branches.length} feature branches, .figma/ ${r.git.figma_dir_hidden ? "ignored" : "not ignored"}`);
  out(`  stack: ${r.stack.framework || "unknown"} / ${r.stack.package_manager || "?"}; dev: ${r.stack.dev || "?"}; your port ${r.stack.user_port ?? "?"}`);
  out(`  checks: ${r.stack.gates.join(", ") || "none"}; CMS: ${r.stack.cms || "none"}; preview route: ${r.stack.preview_route ?? "none"}`);
  if (r.figma.keys_in_repo.length) out(`  Figma files named in the repo: ${r.figma.keys_in_repo.map((k) => `${k.key} (${k.where[0]})`).join(", ")}`);
  if (figma.me) out(`Figma: ${figma.me.handle} (${figma.me.user_id})${figma.rate_limit_type ? `, rate tier ${figma.rate_limit_type}` : ""}`);
  for (const f of figma.files) {
    if (f.error) {
      out(`  ${f.key}: ${f.error}`);
      continue;
    }
    out(`  ${f.key} "${f.name}" ${f.verdict}${f.linked ? "" : " (named in the repo)"}, role ${f.role}, last edit ${f.last_touched_at?.slice(0, 16).replace("T", " ")} by ${f.last_touched_by}`);
    for (const p of f.page_scan ?? []) out(`    page "${p.page}": ${p.error ?? `${p.ready} ready, marks at depth ${p.ready_depth ?? "-"}`}`);
    if (f.breakpoints) out(`    breakpoints: ${Object.entries(f.breakpoints).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  for (const o of [...r.open, ...figma.open]) out(`open: ${o}`);
  return 0;
}

// When the designers of a watched file work: versions, comments and ready marks of the last N days,
// per person, in their time and yours, with a suggested [schedule]. Read-only.
async function cmdActivity(db, flags, pos) {
  const config = flags.project ? loadProject(flags.project) : null;
  // A project's watched files and their stale copies: the same designers worked in the older copy before.
  const keys = pos[0] ? [parseFigmaUrl(pos[0])?.fileKey ?? pos[0]] : (config?.figma.files ?? []).flatMap((f) => [f.key, ...f.stale_copies]);
  if (!keys.length) throw new Error("usage: figpipe activity <figma-link or file key> | --project <slug> [--days 30] [--tz Europe/Berlin] [--user-tz America/Los_Angeles] [--user-start 08:00] [--every 60] [--json]");
  const client = createClient({ tokenRef: flags["token-ref"] ?? config?.figma.pat_ref ?? "file:~/.config/figma/pat" });
  const me = await client.me();
  const days = Number(flags.days ?? 30);
  const userTz = flags["user-tz"] ?? machineZone();
  const versions = [];
  const comments = [];
  for (const k of keys) {
    const a = await fetchActivity(client, k, { days });
    versions.push(...a.versions);
    comments.push(...a.comments);
  }
  const ready = config ? db.all("SELECT COALESCE(source_at, detected_at) AS at FROM events WHERE project = ? AND kind = 'ready'", config.project.slug) : [];
  const { events, own } = toEvents({ versions, comments, ready, me: { id: me.id, handle: me.handle }, days });
  const r = analyse({ events, own, userTz, tz: flags.tz ?? null, userStart: flags["user-start"] ?? "08:00", every: Number(flags.every ?? 60) });
  r.window_days = days;
  r.files = keys;
  // What follow mode would do with this activity, derived the way a check derives it.
  const every = Number(flags.every ?? 60);
  const userStart = flags["user-start"] ?? "08:00";
  const derived = deriveBlocks({ events, pinnedTz: flags.tz ?? "", userTz, days });
  const fv = followView(scheduleOf({ schedule: { mode: "follow", timezone: flags.tz ?? "", days: [...WEEKDAYS], times: [], windows: [], every, my_day_starts: userStart, my_timezone: userTz, refresh_days: 7 }, batching: {} }, { ...derived, derived_at: nowIso() }));
  r.follow = fv;
  const followText = fv.fallback
    ? `Too little activity to follow the designers yet (${fv.reason}). Follow mode would check every ${every} min ${fv.blocks.map((b) => b.designer).join(", ")} ${fv.timezone} until there is more.`
    : `Follow the designers (recommended): every ${every} min ${fv.blocks.map((b) => b.designer).join(", ")} ${fv.timezone}${fv.timezone === userTz ? "" : ` = ${fv.blocks.map((b) => b.yours).join(", ")} ${userTz}`}, ${describeDays(fv.days)}${fv.pre_day?.extra_check ? `, plus one check at ${fv.pre_day.time} ${userTz} before your ${userStart} start` : `; a check already falls before your ${userStart} start`}.`;
  if (flags.json) {
    out(JSON.stringify(r, null, 1));
    return 0;
  }
  const k = r.kinds;
  out(`Activity in the last ${days} days: ${k.edit ?? 0} edits (saved versions), ${k.comment ?? 0} comments${k.ready ? `, ${k.ready} ready marks` : ""}. Yours are left out (${own}).`);
  if (!events.length) {
    out(`Nothing from other people in that time, so there is nothing to suggest.\n${followText}`);
    return 0;
  }
  const g = r.zone_guess;
  out(`Designers' zone: ${r.timezone}${flags.tz ? " (given)" : g ? ` (a guess from when they work${g.confident ? "" : ", not certain"}${g.also_fits.length ? `; ${g.also_fits.join(", ")} fit as well` : ""})` : " (too little activity to guess; using yours)"}. Your zone: ${userTz}.`);
  for (const p of r.people) {
    const pz = p.guess && !flags.tz ? `, looks like ${p.guess.tz}` : "";
    out(`\n${p.who}: ${p.events} events on ${p.active_days} days, ${p.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(" ")}${pz}`);
    for (const b of p.blocks) out(`  ${b.own} ${p.timezone}  =  ${b.yours} ${userTz}`);
  }
  out(`\nBy hour, days active (${r.timezone} | ${userTz}):`);
  const peak = Math.max(...r.combined.hours);
  r.combined.hours.forEach((n, h) => {
    if (!n) return;
    const yours = shiftBlock({ start: h * 60, end: h * 60 }, r.timezone, userTz).start;
    out(`  ${String(h).padStart(2, "0")}:00 | ${String(Math.floor(yours / 60)).padStart(2, "0")}:00  ${"#".repeat(Math.max(1, Math.round((n / peak) * 30)))} ${n}`);
  });
  out(`\n${followText}`);
  if (r.suggestion) {
    out(`\nFixed alternative (not applied):\n${suggestionToml(r.suggestion)}`);
    for (const n of r.suggestion.notes) out(`note: ${n}`);
  } else out("\nToo little activity to suggest a schedule.");
  return 0;
}

async function cmdDoctor(db, flags, pos) {
  const projects = loadAllProjects().filter((p) => !pos[0] || p.slug === pos[0]);
  if (!projects.length) {
    out(pos[0] ? `no project "${pos[0]}" in ${paths().projects}` : `no projects in ${paths().projects}; the figma-setup skill writes one`);
    return 1;
  }
  let bad = 0;
  const all = {};
  for (const p of projects) {
    if (p.error) {
      bad++;
      all[p.slug] = [{ status: "fail", check: "Config", detail: p.error, fix: "Fix the named fields; `figpipe config example` shows every setting." }];
    } else all[p.slug] = await doctor({ config: p.config, db, client: clientFor(db, p.config) });
    if (all[p.slug].some((l) => l.status === "fail")) bad++;
  }
  if (flags.json) out(JSON.stringify(all, null, 1));
  else for (const [slug, lines] of Object.entries(all)) out(`${slug}\n${formatDoctor(lines)}\n`);
  return bad ? 1 : 0;
}

export async function main(argv) {
  const { flags, pos } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || flags.help || cmd === "help") {
    out(HELP);
    return cmd ? 0 : 2;
  }
  // In a batch session figpipe runs as a messenger: the supervisor does the work outside the sandbox.
  if (process.env.FIGPIPE_BROKER && !process.env.FIGPIPE_BROKERED && !["guard", "supervise"].includes(cmd)) {
    const res = await viaBroker(process.env.FIGPIPE_BROKER, argv);
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    return res.code;
  }
  const refused = sessionRefusal(cmd, flags, rest);
  if (refused) {
    process.stderr.write(`figpipe: ${refused}\n`);
    return 2;
  }
  if (cmd === "report" && flags.sample) {
    const r = writeSample(flags.out ?? join(tmpdir(), "figpipe-sample"));
    out(r.report);
    return 0;
  }
  if (cmd === "probe") return await cmdProbe(rest, flags);
  if (cmd === "config") {
    if (rest[0] === "example") {
      out(readFileSync(join(FIGPIPE_DIR, "templates", "project.example.toml"), "utf8"));
      return 0;
    }
    if (rest[0] === "check" && rest[1]) {
      const c = rest[1].endsWith(".toml") ? parseConfig(readFileSync(rest[1], "utf8"), rest[1]) : loadProject(rest[1]);
      const nw = c.figma.files.reduce((n, f) => n + f.watch.length, 0);
      out(`${c._file}: valid (${c.project.slug}, ${c.project.autonomy}, ${c.figma.files.length} file${c.figma.files.length === 1 ? "" : "s"}${nw ? `, ${nw} watched section${nw === 1 ? "" : "s"}` : ""})`);
      return 0;
    }
    out("usage: figpipe config check <slug|file> | example");
    return 2;
  }
  if (cmd === "launchd") {
    // Wakes every 15 minutes, or as often as the busiest project needs; tick decides what is due.
    const minutes = Number(flags.minutes ?? wakeMinutes(loadAllProjects().filter((p) => p.config).map((p) => p.config)));
    if (rest[0] === "plist") out(plist({ minutes }));
    else if (rest[0] === "install" || rest[0] === "uninstall") {
      const p = installPlan({ minutes });
      out(rest[0] === "install" ? `Plist written to ${p.file}. It wakes figpipe every ${minutes} minutes; each project's [schedule] decides when it is checked (figpipe status shows the next check). To install the background check, run:\n\n  ${p.install.join("\n  ")}` : `To remove the background check, run:\n\n  ${p.uninstall.join("\n  ")}`);
    } else out("usage: figpipe launchd plist | install | uninstall [--minutes N]");
    return 0;
  }
  if (cmd === "pause") {
    mkdirSync(paths().home, { recursive: true });
    writeFileSync(paths().pause, nowIso());
    out("Paused. Checks keep recording what changes in Figma; no new batches start. figpipe resume to continue.");
    return 0;
  }
  if (cmd === "resume") {
    rmSync(paths().pause, { force: true });
    out("Resumed.");
    return 0;
  }

  const db = openDb();
  try {
    switch (cmd) {
      case "tick":
        return await withLock(() => cmdTick(db, flags));
      case "add":
        return cmdAdd(db, flags, rest);
      case "own":
        return await cmdOwn(db, flags, rest);
      case "watch":
        return rest[0] === "baseline" ? await withLock(() => cmdWatch(db, flags, rest)) : await cmdWatch(db, flags, rest);
      case "status":
        return cmdStatus(db, flags);
      case "run":
        return await cmdRun(db, flags, rest);
      case "supervise":
        return await cmdSupervise(db, rest);
      case "extract": {
        const b = db.get("SELECT * FROM batches WHERE id = ?", rest[0]);
        if (!b) throw new Error(`no batch ${rest[0]}`);
        const config = loadProject(b.project);
        const r = await extractBatch({ db, config, client: clientFor(db, config), batchId: b.id, log: out });
        out(join(batchDirOf(b.project, b.id), "extract.json"));
        return r.warnings.length ? 1 : 0;
      }
      case "record": {
        const b = db.get("SELECT * FROM batches WHERE id = ?", rest[0]);
        if (!b || !rest[1]) throw new Error("usage: figpipe record <batch> <result.json> [--partial]");
        const dir = b.dir ?? batchDirOf(b.project, b.id);
        const file = rest[1].startsWith("/") ? rest[1] : join(process.cwd(), rest[1]);
        if (process.env.FIGPIPE_BROKERED) {
          const real = realpathSync(file);
          if (!real.startsWith(realpathSync(dir) + "/")) throw new Error(`inside a batch session, record files from the batch folder (${dir})`);
        }
        const partial = !!flags.partial;
        const r = recordResult({ db, batchId: b.id, result: JSON.parse(readFileSync(file, "utf8")), batchDir: dir, partial });
        if (!partial) db.run("UPDATE batches SET status = 'done', dir = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?", dir, nowIso(), b.id);
        else if (!b.dir) db.run("UPDATE batches SET dir = ? WHERE id = ?", dir, b.id);
        const report = writeReport(db, b.id, { projectName: nameOf(b.project) });
        out(partial ? `recorded ${r.items} item${r.items === 1 ? "" : "s"}; report: ${report}` : report);
        return 0;
      }
      case "result": {
        const b = db.get("SELECT * FROM batches WHERE id = ?", rest[0]);
        if (!b) throw new Error(`no batch ${rest[0]}`);
        out(JSON.stringify(resultFromDb(db, b.id, b.dir ?? batchDirOf(b.project, b.id)), null, 1));
        return 0;
      }
      case "capture":
        return await cmdCapture(db, flags, rest);
      case "doctor":
        return await cmdDoctor(db, flags, rest);
      case "activity":
        return await cmdActivity(db, flags, rest);
      case "report": {
        if (flags.index) {
          out(writeIndex(db));
          return 0;
        }
        const b = db.get("SELECT * FROM batches WHERE id = ?", rest[0]);
        if (!b) throw new Error(`no batch ${rest[0]}`);
        out(writeReport(db, b.id, { projectName: nameOf(b.project) }));
        return 0;
      }
      case "ack":
        return setStatus(db, rest[0], "reviewed", flags.note);
      case "reject":
        return setStatus(db, rest[0], "rejected", flags.note);
      case "budget":
        return cmdBudget(db, flags, rest);
      case "guard":
        return await cmdGuard(db, flags);
      default:
        out(HELP);
        return 2;
    }
  } finally {
    db.close();
  }
}
