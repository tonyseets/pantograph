// Run a batch: lanes and worktrees, the batch manifest, a guarded claude -p session, and the
// supervisor that enforces the wall clock, records the result, renders the report and notifies.
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, openSync, rmSync, symlinkSync, realpathSync, readdirSync, renameSync, appendFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { paths, FIGPIPE_BIN, FIGPIPE_DIR, READ_TOOLS, realish } from "./paths.mjs";
import { fill, parseModel } from "./config.mjs";
import { nowIso, budgetToday, bumpBudget, localDay } from "./db.mjs";
import { laneOf } from "./batcher.mjs";
import { FIGMA_MCP_READS, SHIMS, PRE_PUSH, passThroughHook, HOOK_NAMES } from "./guard.mjs";
import { RESULT_SCHEMA_PATH, recordResult } from "./record.mjs";
import { figmaLink } from "./extract.mjs";
import { watchOfItem } from "./watch.mjs";
import { zonedParts, zonedToUtc, addDays, validZone, machineZone, fmtAt } from "./schedule.mjs";

const git = (cwd, args, opts = {}) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const tryGit = (cwd, args) => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};
export const batchDirOf = (project, id) => join(paths().batches, project, id);
const BLOCKED_URL = "figpipe-blocked://push-disabled";

// The first free TCP port at or after `from`.
export async function freePort(from, taken = new Set()) {
  for (let p = from; p < from + 200; p++) {
    if (taken.has(p)) continue;
    const ok = await new Promise((res) => {
      const s = createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new Error(`no free port near ${from}`);
}

function worktreeList(repo) {
  const out = tryGit(repo, ["worktree", "list", "--porcelain"]) ?? "";
  return out
    .split("\n\n")
    .map((b) => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null }))
    .filter((w) => w.path)
    .map((w) => ({ ...w, path: realish(w.path) }));
}
const branchExists = (repo, b) => tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== null;

// Where a lane builds: its branch, folder, and the branch it starts from. A watched section's lane
// starts from the watch's branch, where the pre-built page lives (opts.base).
export function planLane(config, lane, list = worktreeList(config.project.repo), opts = {}) {
  const repo = config.project.repo;
  const branch = fill(config.git.branch_pattern, { page: lane });
  const worktree = realish(fill(config.git.worktree_pattern, { page: lane, repo }));
  let base = opts.base ?? config.git.base_branch;
  let stacked = null;
  if (config.git.stack_on_feature_branch && !opts.base) {
    const named = config.git.feature_branches[lane];
    const guess = list.find((w) => w.branch && w.branch !== branch && new RegExp(`(^|/)${lane}$`).test(w.branch));
    stacked = named && branchExists(repo, named) ? named : guess?.branch ?? (branchExists(repo, `feat/${lane}`) ? `feat/${lane}` : null);
    if (stacked) base = stacked;
  }
  return { lane, branch, worktree, base, stacked, existing_branch: branchExists(repo, branch) };
}

// Hooks for a pipeline worktree: pre-push refuses, every other hook runs the repo's own.
function installGuards(repo, wt, hooksDir) {
  const ext = tryGit(repo, ["config", "--get", "extensions.worktreeConfig"]);
  if (ext !== "true") {
    if (tryGit(repo, ["config", "--get", "core.worktree"])) throw new Error(`${repo} sets core.worktree; figpipe cannot give its worktrees their own hooks safely`);
    if (tryGit(repo, ["config", "--get", "core.bare"]) === "true") throw new Error(`${repo} is a bare repository`);
    git(repo, ["config", "extensions.worktreeConfig", "true"]);
  }
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const own = tryGit(repo, ["config", "--get", "core.hooksPath"]);
  const original = own ? (own.startsWith("/") ? own : join(repo, own)) : join(common, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "pre-push"), PRE_PUSH);
  chmodSync(join(hooksDir, "pre-push"), 0o755);
  for (const h of HOOK_NAMES) {
    writeFileSync(join(hooksDir, h), passThroughHook(h, original));
    chmodSync(join(hooksDir, h), 0o755);
  }
  git(wt, ["config", "--worktree", "core.hooksPath", hooksDir]);
  // Even git push --no-verify fails: every push URL in this worktree is rewritten to nowhere.
  git(wt, ["config", "--worktree", "url.figpipe-blocked://.pushInsteadOf", ""]);
  for (const r of (tryGit(repo, ["remote"]) ?? "").split("\n").filter(Boolean)) git(wt, ["config", "--worktree", `remote.${r}.pushurl`, BLOCKED_URL]);
}

// Create or reuse the lane's worktree. Never touches a folder with someone's uncommitted work.
// carry: the uncommitted edits are this batch's own, left by an attempt that stopped; the retry
// continues from them instead of refusing the folder.
export function prepareWorktree(config, plan, { carry = false } = {}) {
  const repo = config.project.repo;
  const list = worktreeList(repo);
  const at = list.find((w) => w.path === plan.worktree);
  const holder = list.find((w) => w.branch === plan.branch);
  if (holder && holder.path !== plan.worktree) return { ...plan, blocked: `${plan.branch} is checked out in ${holder.path}; figpipe builds only in its own folder` };
  if (at) {
    if (at.branch !== plan.branch) return { ...plan, blocked: `${plan.worktree} is on ${at.branch ?? "a detached HEAD"}, not ${plan.branch}` };
    const dirty = tryGit(plan.worktree, ["status", "--porcelain"]);
    if (dirty && !carry) return { ...plan, blocked: `${plan.worktree} has uncommitted edits; commit or stash them and the next batch builds there` };
    if (dirty) plan = { ...plan, carried: true };
  } else if (existsSync(plan.worktree)) {
    return { ...plan, blocked: `${plan.worktree} exists and is not a worktree of ${repo}` };
  } else if (plan.existing_branch) {
    git(repo, ["worktree", "add", plan.worktree, plan.branch]);
  } else {
    git(repo, ["worktree", "add", "-b", plan.branch, plan.worktree, plan.base]);
  }
  installGuards(repo, plan.worktree, join(paths().home, "hooks", config.project.slug, plan.lane));
  const copied = copyWorktreeFiles(config, plan.worktree);
  return { ...plan, head: git(plan.worktree, ["rev-parse", "HEAD"]), ...(copied.length ? { copied } : {}) };
}

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

// Copy the ignored files a fresh worktree needs (git.worktree_files, e.g. .env) from the repo.
// Only files git ignores, only when the worktree lacks them; dotenv keys matching
// git.worktree_env_omit are dropped. Returns [{ file, omitted: [keys] }], never values.
export function copyWorktreeFiles(config, wt) {
  const repo = config.project.repo;
  const omit = config.git.worktree_env_omit.map(globRe);
  const done = [];
  for (const rel of config.git.worktree_files) {
    const src = join(repo, rel);
    const dest = join(wt, rel);
    if (!existsSync(src) || existsSync(dest)) continue;
    if (tryGit(repo, ["check-ignore", "-q", "--", rel]) === null) continue; // tracked or not ignored: git already has it
    const name = basename(rel);
    const omitted = [];
    let body = readFileSync(src);
    if (/^\.env(\.|$)|\.vars$/.test(name)) {
      body = body
        .toString("utf8")
        .split("\n")
        .filter((line) => {
          const k = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/)?.[1];
          if (k && omit.some((re) => re.test(k))) {
            omitted.push(k);
            return false;
          }
          return true;
        })
        .join("\n");
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body, { mode: 0o600 });
    done.push({ file: rel, omitted });
  }
  return done;
}

// Remove the lane worktrees and branches of a batch that hold nothing: no commit of their own (every
// commit on the branch is on the branch it started from) and no uncommitted edits. A lane with work
// in it is left alone, and so is anything figpipe did not name. Returns the lanes it removed.
export function cleanupLanes({ config, lanes }) {
  const repo = config.project.repo;
  const removed = [];
  for (const l of (lanes ?? []).filter((x) => !x.blocked && x.worktree && x.branch && x.base)) {
    if (l.branch !== fill(config.git.branch_pattern, { page: l.lane })) continue;
    const at = worktreeList(repo).find((w) => w.path === realish(l.worktree));
    if (at && at.branch !== l.branch) continue;
    if (at && tryGit(l.worktree, ["status", "--porcelain"]) !== "") continue;
    if (!branchExists(repo, l.branch) || spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", l.branch, l.base]).status !== 0) continue;
    if (at && tryGit(repo, ["worktree", "remove", l.worktree]) === null) continue;
    if (tryGit(repo, ["branch", "-D", l.branch]) === null) continue;
    removed.push({ lane: l.lane, branch: l.branch, worktree: at ? l.worktree : null });
  }
  return removed;
}

// One line per thing worth knowing about a batch's run, in <batch>/batch.log.
export function batchLog(batchDir, text) {
  try {
    mkdirSync(batchDir, { recursive: true });
    appendFileSync(join(batchDir, "batch.log"), `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Everything the session reads: one manifest, the contract for the figma-batch skill.
export function buildManifest({ db, config, batch, lanes, extract, batchDir, model }) {
  const items = db.all("SELECT * FROM items WHERE batch_id = ? ORDER BY id", batch.id);
  const ex = extract?.items ?? {};
  const ledgerFor = (it) =>
    db
      .all("SELECT key, batch_id, outcome, branch, commits, at FROM ledger WHERE project = ? AND key IN (?, ?) AND batch_id != ? ORDER BY at", config.project.slug, `node:${it.file_key}:${it.node_id}`, `thread:${it.file_key}:${it.thread_id}`, batch.id)
      .map((l) => ({ ...l, commits: JSON.parse(l.commits || "[]") }));
  const context = db.all("SELECT kind, payload, note, detected_at FROM events WHERE batch_id = ? AND kind IN ('version', 'identity')", batch.id).map((e) => ({ kind: e.kind, ...JSON.parse(e.payload), note: e.note }));
  const unmarked = db.all("SELECT node_id, note FROM events WHERE batch_id = ? AND note IS NOT NULL AND kind IN ('ready', 'changed', 'comment')", batch.id);
  const used = budgetToday(db, config.project.slug).mcp_calls;
  const mcp = config.figma.mcp;
  return {
    schema: 1,
    batch: batch.id,
    project: config.project.slug,
    mode: config.project.autonomy,
    created_at: batch.created_at,
    reason: batch.reason,
    repo: config.project.repo,
    notes_file: config.project.notes || null,
    batch_dir: batchDir,
    result_schema: RESULT_SCHEMA_PATH,
    read_tools: READ_TOOLS,
    figpipe: FIGPIPE_BIN,
    models: { coordinator: model, build: config.models.build, build_hard: config.models.build_hard, review: config.models.review },
    mcp: { used_today: used, pipeline_share: mcp.pipeline_share, left_today: Math.max(0, mcp.pipeline_share - used), reserve_for_motion: mcp.reserve_for_motion, check: `figpipe budget mcp --batch ${batch.id}` },
    stack: config.stack,
    review: config.review,
    git: { base_branch: config.git.base_branch, extract_dir: config.git.extract_dir },
    files: config.figma.files.map((f) => ({ key: f.key, name: f.name, breakpoints: f.breakpoints, canonical_copy: f.canonical_copy, stale_copies: f.stale_copies })),
    lanes: lanes.map((l) => ({ ...l, items: items.filter((i) => laneOf(i) === l.lane && i.outcome === "pending").map((i) => i.id) })),
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      lane: laneOf(i),
      outcome: i.outcome,
      file_key: i.file_key,
      node_id: i.node_id,
      thread_id: i.thread_id,
      area: i.area_name,
      figma_link: i.node_id ? figmaLink(i.file_key, i.node_id) : null,
      verdict: i.verdict,
      watch: watchOfItem(i),
      events: JSON.parse(i.source || "{}").events ?? [],
      extraction: ex[i.id] ?? null,
      history: i.node_id || i.thread_id ? ledgerFor(i) : [],
    })),
    context: { versions_and_identity: context, changed_or_unmarked_after_pickup: unmarked },
    warnings: extract?.warnings ?? [],
  };
}

// Hosts the session's commands may reach: Figma's API, localhost, the CMS's read API and the
// project's extras. Write hosts (Storyblok's management API, for one) are never on it.
export const CMS_READ_DOMAINS = {
  storyblok: ["api.storyblok.com", "api-us.storyblok.com", "api-ap.storyblok.com", "api-ca.storyblok.com", "api-cn.storyblok.com", "a.storyblok.com", "a2.storyblok.com", "img2.storyblok.com"],
  contentful: ["cdn.contentful.com", "preview.contentful.com", "images.ctfassets.net"],
  sanity: ["*.apicdn.sanity.io", "cdn.sanity.io"],
  prismic: ["*.cdn.prismic.io", "images.prismic.io"],
  datocms: ["graphql.datocms.com", "www.datocms-assets.com"],
};
export function sessionDomains(config) {
  const cms = CMS_READ_DOMAINS[String(config.stack.cms.kind ?? "").toLowerCase()] ?? [];
  return [...new Set(["api.figma.com", "localhost", "127.0.0.1", ...cms, ...config.stack.allowed_domains])];
}

export const cacheDir = () => join(paths().home, "cache");

// The OS sandbox every Bash command in the session runs in (Claude Code's sandbox: Seatbelt on
// macOS). It is what makes the rules hold for scripts the guard cannot read, such as node -e:
// writes land only in the batch folder, the extract folder, the lane worktrees and the repo's git
// store (minus its config, hooks and Tony's own index and HEAD), and the network reaches only the
// hosts above. Pushes, messages and CMS writes have nowhere to go.
export function sandboxSettings({ config, batchDir, lanes }) {
  const repo = config.project.repo;
  const active = lanes.filter((l) => !l.blocked);
  const common = tryGit(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDirOf = (wt) => tryGit(wt, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const own = new Set(active.map((l) => realish(l.worktree)));
  const others = worktreeList(repo).filter((w) => !own.has(w.path) && w.path !== realish(repo)).map((w) => gitDirOf(w.path)).filter(Boolean);
  const allowWrite = [batchDir, join(repo, config.git.extract_dir), ...active.map((l) => l.worktree), common, cacheDir()].filter(Boolean);
  const denyWrite = [
    join(batchDir, "session"),
    join(batchDir, ".claude"),
    ...(common ? ["config", "hooks", "info", "index", "HEAD", "ORIG_HEAD", "FETCH_HEAD", join("logs", "HEAD")].map((f) => join(common, f)) : []),
    ...others,
    ...active.map((l) => gitDirOf(l.worktree)).filter(Boolean).map((d) => join(d, "config.worktree")),
  ];
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    network: { allowedDomains: sessionDomains(config), strictAllowlist: true, allowLocalBinding: true },
    filesystem: { allowWrite: [...new Set(allowWrite)], denyWrite: [...new Set(denyWrite)] },
  };
}

// Files the session runs with: guard config, hook settings with the sandbox, Figma-only MCP
// config, PATH shims. All of them sit in session/, which the session cannot change.
export function writeSessionFiles({ config, batch, batchDir, lanes, nodeBin = process.execPath }) {
  const sess = join(batchDir, "session");
  const bin = join(sess, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(batchDir, "broker"), { recursive: true });
  mkdirSync(join(cacheDir(), "npm"), { recursive: true });
  const writeRoots = [batchDir, join(config.project.repo, config.git.extract_dir), ...lanes.filter((l) => !l.blocked).map((l) => l.worktree)];
  const protect = [sess, join(batchDir, ".claude")];
  writeFileSync(join(sess, "guard.json"), JSON.stringify({ batch: batch.id, project: config.project.slug, writeRoots, protect }, null, 1));
  const home = paths().home;
  const hookCmd = `FIGPIPE_HOME=${shellQuote(home)} ${shellQuote(nodeBin)} ${shellQuote(FIGPIPE_BIN)} guard --batch ${shellQuote(batch.id)}`;
  const settings = {
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCmd, timeout: 30 }] }] },
    permissions: {
      deny: ["Bash(git push*)", "Bash(git remote*)", "Bash(git -C * push*)", "Bash(git -C * remote*)", "Bash(git stash*)", "Bash(git -C * stash*)", "Bash(gh *)", "Bash(open *)", "Bash(osascript*)", "WebFetch", "WebSearch"],
    },
    sandbox: sandboxSettings({ config, batchDir, lanes }),
  };
  writeFileSync(join(sess, "settings.json"), JSON.stringify(settings, null, 1));
  writeFileSync(join(sess, "mcp.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } }, null, 1));
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shims = { git: SHIMS.git(realGit), gh: SHIMS.deny("gh"), open: SHIMS.deny("open"), osascript: SHIMS.deny("osascript"), hub: SHIMS.deny("hub") };
  // Inside the session figpipe is a messenger: it hands the command to the supervisor, which runs
  // it outside the sandbox (state.db and the screenshot browser live there) for this batch only.
  shims.figpipe = `#!/bin/sh\nFIGPIPE_HOME=${shellQuote(home)} exec ${shellQuote(nodeBin)} ${shellQuote(FIGPIPE_BIN)} "$@"\n`;
  for (const [n, body] of Object.entries(shims)) {
    writeFileSync(join(bin, n), body);
    chmodSync(join(bin, n), 0o755);
  }
  linkSessionSkills(batchDir);
  return { sess, bin, writeRoots, settings: join(sess, "settings.json"), mcp: join(sess, "mcp.json") };
}

// The guarded environment: shims first on PATH, push rewritten to nowhere for every git call,
// tokens for other services removed, Node's fetch routed through the sandbox's proxy.
export function sessionEnv({ base = process.env, bin, batch, batchDir, remotes = [] }) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^(GH_|GITHUB_|GITLAB_|SLACK_|NPM_TOKEN|NODE_AUTH_TOKEN|CLOUDFLARE_|VERCEL_|NETLIFY_|STORYBLOK_|FIGMA_TOKEN|ANTHROPIC_API_KEY$|FIGPIPE_)/.test(k)) delete env[k];
  env.PATH = `${bin}:${base.PATH ?? "/usr/bin:/bin"}`;
  const cfg = [["url.figpipe-blocked://.pushInsteadOf", ""], ...remotes.map((r) => [`remote.${r}.pushurl`, BLOCKED_URL])];
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_TERMINAL_PROMPT = "0";
  env.NODE_USE_ENV_PROXY = "1";
  env.npm_config_cache = join(cacheDir(), "npm");
  env.FIGPIPE_BATCH = batch.id;
  env.FIGPIPE_HOME = paths().home;
  env.FIGPIPE_SESSION = "1";
  if (batchDir) env.FIGPIPE_BROKER = join(batchDir, "broker");
  return env;
}

// The skills a batch session loads. The session runs in the batch folder, so a link under
// <batch>/.claude/skills is a project skill there; skills the user installed globally are left to
// the global install. The guard resolves links, so edits through them land outside the write roots.
export const SESSION_SKILLS = ["figma-batch", "figma-transpose", "figma-review-page"];
export const SKILLS_DIR = join(FIGPIPE_DIR, "..", "skills");
// Sessions load project settings only (--setting-sources project), so the user's own skills are
// not there: all three are linked from this Pantograph checkout, one copy, never duplicated.
export function linkSessionSkills(batchDir) {
  const dest = join(batchDir, ".claude", "skills");
  mkdirSync(dest, { recursive: true });
  for (const name of SESSION_SKILLS) {
    rmSync(join(dest, name), { recursive: true, force: true });
    symlinkSync(realpathSync(join(SKILLS_DIR, name)), join(dest, name));
  }
  return SESSION_SKILLS;
}

export function allowedTools(config) {
  const base = ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "Agent", "Task", "TodoWrite", "Skill"];
  const bash = ["figpipe *", "node *", "git status*", "git diff*", "git add*", "git commit*", "git log*", "git show*", "git revert*", "git switch*", "git checkout*", "git restore*", "git rev-parse*", "git branch*", "git worktree list*", "ls*", "cat *", "head *", "tail *", "wc *", "mkdir *", "cp *", "mv *", "diff *", "shasum *", "file *", "curl -s http://localhost*", "curl -s http://127.0.0.1*", "lsof -i*", "kill *", ...config.stack.allowed_bash];
  // The same git commands aimed at a worktree with -C, which sessions use to stay in the batch folder.
  const gitC = bash.filter((b) => b.startsWith("git ") && !b.startsWith("git -C")).map((b) => `git -C * ${b.slice(4)}`);
  return [...base, ...[...new Set([...bash, ...gitC])].map((b) => `Bash(${b})`), ...FIGMA_MCP_READS.map((t) => `mcp__figma__${t}`)];
}

export const DISALLOWED = [
  "Bash(git push*)", "Bash(git remote*)", "Bash(git -C * push*)", "Bash(git -C * remote*)", "Bash(gh *)", "Bash(open *)", "Bash(osascript*)", "Bash(curl -X*)", "Bash(wrangler*)", "Bash(vercel*)",
  "WebFetch", "WebSearch",
  "mcp__figma__use_figma", "mcp__figma__generate_figma_design", "mcp__figma__upload_assets", "mcp__figma__create_new_file",
  "mcp__figma__add_code_connect_map", "mcp__figma__send_code_connect_mappings", "mcp__figma__generate_diagram",
];

// What this attempt may spend: the per-batch limit less what earlier attempts of the batch spent.
export const usdLeft = (config, batch) => Math.max(0, config.limits.usd_per_batch - Number(batch.usd ?? 0));

export function claudeCommand({ config, batch, batchDir, files, lanes, prompt, model, sessionId, claudeBin }) {
  const { model: m, effort } = parseModel(model);
  const args = [
    "-p", prompt,
    "--model", m, "--effort", effort,
    "--permission-mode", "dontAsk",
    "--allowedTools", ...allowedTools(config),
    "--disallowedTools", ...DISALLOWED,
    "--mcp-config", files.mcp, "--strict-mcp-config",
    "--settings", files.settings, "--setting-sources", "project",
    "--add-dir", batchDir, join(config.project.repo, config.git.extract_dir), ...lanes.filter((l) => !l.blocked).map((l) => l.worktree),
    "--max-budget-usd", String(Math.max(0.5, Math.round(usdLeft(config, batch) * 100) / 100)),
    "--output-format", "stream-json", "--verbose",
    "--json-schema", readFileSync(RESULT_SCHEMA_PATH, "utf8"),
    "--session-id", sessionId,
    "-n", `figpipe-${batch.id}`,
  ];
  return { bin: claudeBin ?? process.env.FIGPIPE_CLAUDE_BIN ?? "claude", args, cwd: batchDir };
}

export function renderPrompt({ manifestPath, mode, batch }) {
  const tpl = readFileSync(join(FIGPIPE_DIR, "templates", "prompt.md"), "utf8");
  return fill(tpl, { manifest: manifestPath, mode, batch: batch.id, skill: join(SKILLS_DIR, "figma-batch", "SKILL.md") });
}

// Usage pace: weekly "all models" meter against the even drip to the reset.
export function parseUsage(text, nowMs = Date.now()) {
  const m = text.match(/Current week \(all models\):\s*(\d+)% used\s*·\s*resets\s+([A-Z][a-z]{2})\s+(\d+)\s+at\s+(\d+)(?::(\d+))?\s*(am|pm)/i);
  if (!m) return null;
  const used = Number(m[1]);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const now = new Date(nowMs);
  let h = Number(m[4]) % 12;
  if (m[6].toLowerCase() === "pm") h += 12;
  let reset = new Date(now.getFullYear(), months.indexOf(m[2].toLowerCase()), Number(m[3]), h, Number(m[5] ?? 0));
  if (reset.getTime() < nowMs - 24 * 3600e3) reset = new Date(reset.getFullYear() + 1, reset.getMonth(), reset.getDate(), h, Number(m[5] ?? 0));
  const week = 7 * 24 * 3600e3;
  const elapsed = Math.min(1, Math.max(0, 1 - (reset.getTime() - nowMs) / week));
  const ahead = used > elapsed * 100 + 5;
  return { used, elapsed: Math.round(elapsed * 100), ahead, text: `${used}% used, ${Math.round(elapsed * 100)}% of the week gone` };
}

export function readPace(db, { claudeBin = process.env.FIGPIPE_CLAUDE_BIN ?? "claude", clock = Date.now } = {}) {
  const cached = db.get("SELECT value FROM meta WHERE key = 'pace'");
  if (cached) {
    const c = JSON.parse(cached.value);
    if (clock() - c.at < 30 * 60 * 1000) return c.pace;
  }
  const r = spawnSync(claudeBin, ["-p", "/usage", "--output-format", "text"], { encoding: "utf8", timeout: 120000 });
  const pace = r.status === 0 ? parseUsage(r.stdout ?? "", clock()) : null;
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('pace', ?)", JSON.stringify({ at: clock(), pace }));
  return pace; // null when unreadable: pacing never blocks on a meter it cannot read
}

// ---- Can Claude run a session at all? -------------------------------------------------------
// A session that meets a usage limit, a signed-out login or an empty credit balance ends at once
// with an error result and no work done. That is not a failed attempt: the batch keeps its items
// and waits. Before a session, and before any worktree or install, a free check asks the CLI the
// same question (`claude auth status` and the `/usage` meters; neither calls a model).

const HOUR = 3600e3;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "resets Oct 13 at 9am (America/Los_Angeles)", "resets 3pm" or "resets in 2 hours" -> ms, in the
// named zone (this Mac's when there is none). A date without a year is its next occurrence.
export function parseResetTime(text, nowMs = Date.now()) {
  const s = String(text ?? "");
  const named = s.match(/\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC)\)/)?.[1];
  const tz = named && validZone(named) ? named : machineZone();
  const time = (h, mi, ap) => ({ h: ap ? (Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0) : Number(h), mi: Number(mi ?? 0) });
  const now = zonedParts(nowMs, tz);
  let m = s.match(/resets?\s+(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,?\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    const date = { mo: MONTHS.indexOf(m[1].toLowerCase()) + 1, d: Number(m[2]), ...time(m[4], m[5], m[6]) };
    const ms = zonedToUtc({ y: m[3] ? Number(m[3]) : now.y, ...date }, tz);
    return !m[3] && ms < nowMs - 24 * HOUR ? zonedToUtc({ y: now.y + 1, ...date }, tz) : ms;
  }
  m = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m) {
    const ms = zonedToUtc({ y: now.y, mo: now.mo, d: now.d, ...time(m[1], m[2], m[3]) }, tz);
    return ms > nowMs ? ms : zonedToUtc({ ...addDays(now, 1), ...time(m[1], m[2], m[3]) }, tz);
  }
  m = s.match(/resets?\s+in\s+(\d+)\s*(min|hour|hr|day)/i);
  if (m) return nowMs + Number(m[1]) * { min: 60e3, hour: HOUR, hr: HOUR, day: 24 * HOUR }[m[2].toLowerCase()];
  return null;
}

// Every meter `/usage` prints: [{ label, used, resets_at }].
export function parseMeters(text, nowMs = Date.now()) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)%\s*used(.*)$/i);
    if (m) out.push({ label: m[1].trim(), used: Number(m[2]), resets_at: parseResetTime(m[3], nowMs) });
  }
  return out;
}

const USAGE_TEXT = /hit your [\w\s-]*limit|usage limit|limit reached|spend limit|rate.?limit/i;
const AUTH_TEXT = /invalid (?:x-)?api[ -]?key|\/login|not (?:logged|signed) in|authentication|oauth token|unauthorized|token (?:has )?expired/i;
const CREDIT_TEXT = /credit balance|insufficient credit|payment required|billing/i;

// Why a session could not run: { kind: usage | auth | credit, until (ms, usage only), text }.
// Read from what Claude Code printed: the result line (is_error with an API status), the API error
// message and the rate-limit event that carries the reset time. null when the session's end was
// its own (a crash, a refusal, a normal result).
export function sessionBlock(parsed, nowMs = Date.now()) {
  const r = parsed?.result;
  const api = parsed?.apiError ?? null;
  if (!r?.is_error || !(r.terminal_reason === "api_error" || r.api_error_status != null || api)) return null;
  const text = String(typeof r.result === "string" && r.result ? r.result : api?.text ?? "").replace(/\s+/g, " ").trim();
  const status = Number(r.api_error_status ?? api?.status ?? 0);
  const code = String(r.api_error ?? api?.code ?? api?.error ?? "");
  const kind =
    status === 429 || /usage_limit|rate_limit/.test(code) ? "usage"
    : status === 401 || status === 403 || /authentication|permission|invalid_api_key/.test(code) ? "auth"
    : status === 402 || /billing|credit/.test(code) ? "credit"
    : USAGE_TEXT.test(text) ? "usage"
    : AUTH_TEXT.test(text) ? "auth"
    : CREDIT_TEXT.test(text) ? "credit"
    : null;
  if (!kind) return null;
  const event = parsed.limit?.status === "rejected" && Number(parsed.limit.resetsAt) > 0 ? Number(parsed.limit.resetsAt) * 1000 : null;
  return { kind, until: kind === "usage" ? event ?? parseResetTime(text, nowMs) : null, text: text || `Claude answered ${status || code}`, limit: parsed.limit?.rateLimitType ?? null };
}

const claudeBinOf = (bin) => bin ?? process.env.FIGPIPE_CLAUDE_BIN ?? "claude";

// Who a session runs as: `claude auth status` reads the stored login and calls no model. Run with
// the session's own environment, so it names the login the background job picks up, which need
// not be the one in Tony's terminal.
export function claudeAccount({ claudeBin, env = process.env, cwd } = {}) {
  const r = spawnSync(claudeBinOf(claudeBin), ["auth", "status", "--json"], { encoding: "utf8", timeout: 60000, env, cwd });
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  if (!j || typeof j !== "object" || !("loggedIn" in j)) return { known: false, signed_in: null, text: null };
  const signedIn = j.loggedIn !== false;
  const text = signedIn
    ? [j.email, j.subscriptionType && `${j.subscriptionType} plan`, j.orgName && `organisation "${j.orgName}"`, j.authMethod && `signed in with ${j.authMethod}`, j.apiProvider && j.apiProvider !== "firstParty" && `through ${j.apiProvider}`, j.configDirectory && `settings in ${j.configDirectory}`].filter(Boolean).join(", ")
    : "not signed in";
  return { known: true, signed_in: signedIn, text, email: j.email ?? null };
}

// The free check before a session. -> { ok, kind, until, text, account, meters }: ok is false when
// Claude is signed out or a meter the session draws on is full, true when the meters were read and
// have room, null when they could not be read (an API key login has none).
export function preflight({ config, batch, batchDir, model = config.models.coordinator, claudeBin, clock = Date.now }) {
  const env = sessionEnv({ bin: join(batchDir, "session", "bin"), batch, batchDir });
  const account = claudeAccount({ claudeBin, env, cwd: batchDir });
  if (account.known && !account.signed_in) return { ok: false, kind: "auth", until: null, text: "Claude is not signed in", account, meters: [] };
  const r = spawnSync(claudeBinOf(claudeBin), ["-p", "/usage", "--output-format", "text", "--setting-sources", "project"], { encoding: "utf8", timeout: 180000, env, cwd: batchDir });
  const meters = r.status === 0 ? parseMeters(r.stdout ?? "", clock()) : [];
  // The session draws on its 5-hour window, the weekly all-models meter and its own model's meter.
  const family = parseModel(model).model.toLowerCase();
  const mine = meters.filter((m) => /session|all models/i.test(m.label) || (m.label.match(/\(([^)]+)\)/)?.[1] ?? "").toLowerCase().split(/\s+/).some((w) => w.length > 2 && family.includes(w)));
  const full = mine.filter((m) => m.used >= 100);
  if (full.length) {
    const resets = full.map((m) => m.resets_at).filter(Boolean);
    return { ok: false, kind: "usage", until: resets.length ? Math.max(...resets) : null, text: full.map((m) => `${m.label} is ${m.used}% used`).join("; "), account, meters };
  }
  return { ok: meters.length ? true : null, kind: null, until: null, text: null, account, meters };
}

export const meterLine = (meters) => meters.map((m) => `${m.label} ${m.used}% used${m.resets_at ? `, resets ${fmtAt(m.resets_at, machineZone())}` : ""}`).join("; ");

// What status, the index and the report say about a batch that waits for Claude.
export function waitLine(kind, until, source = "meter") {
  if (kind === "usage") return `Claude usage limit hit; retries after ${fmtAt(until, machineZone())}`;
  if (kind === "auth") return source === "session" ? "Claude refused the background session's login; run `claude auth login`. figpipe tries again every 6 hours" : "Claude is signed out for background sessions; run `claude auth login`. figpipe checks again every hour";
  return "Claude credit ran out; add credit. figpipe tries again every 6 hours";
}

// Hold a batch until Claude can run it: it stays ready with its items. source says who noticed:
// "meter" (the free check, before anything was created) or "session" (a session was refused; that
// attempt is not counted). A usage limit waits for its reset time, an hour when none was named.
// A signed-out login is looked at hourly, for free; a refusal the free check cannot see (a session
// refused although the meters had room, a rejected key, no credit) is tried again every 6 hours,
// because each try prepares the lanes again.
export function holdBatch({ db, batchId, block, clock = Date.now, source = "meter" }) {
  const now = clock();
  const until = block.kind === "usage" ? Math.max(block.until ?? now + HOUR, now) : now + (source === "session" || block.kind === "credit" ? 6 : 1) * HOUR;
  const line = waitLine(block.kind, until, source);
  db.run(
    `UPDATE batches SET status = 'ready', wait_kind = ?, wait_source = ?, retry_after = ?, wait_note = ?, probed_at = ?, error = ?, pid = NULL${source === "session" ? ", attempts = MAX(attempts - 1, 0)" : ""} WHERE id = ?`,
    block.kind, source, new Date(until).toISOString(), block.text ?? null, new Date(now).toISOString(), line, batchId,
  );
  return { until, line };
}

// Is a waiting batch worth another look: its wait is over, or (when the free check is what saw the
// limit) an hour has passed since the last look, since a limit can lift early.
export function dueForStart(b, now = Date.now()) {
  if (!b.wait_kind) return true;
  if (b.retry_after && now >= Date.parse(b.retry_after)) return true;
  if (b.wait_source === "session") return false;
  return !b.probed_at || now - Date.parse(b.probed_at) >= HOUR;
}

// Process start time, so a saved pid that now belongs to another process after a restart is not
// mistaken for a live batch.
export function procStarted(pid) {
  if (!pid) return null;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}
export const setPid = (db, batchId, pid) => db.run("UPDATE batches SET pid = ?, pid_started = ? WHERE id = ?", pid, procStarted(pid), batchId);

// Prepare everything and start the supervisor in the background. Returns what was started.
export async function startBatch(opts) {
  const { db, batchId, dryRun = false, clock = Date.now } = opts;
  const batch = db.get("SELECT * FROM batches WHERE id = ?", batchId);
  if (!batch) throw new Error(`no batch ${batchId}`);
  if (!dryRun) {
    // Claim the batch in one statement: only a ready batch starts, and only while nothing else runs.
    // A second `run --batch` on a running batch, or a tick racing a manual run, changes no row.
    const claimed = db.run(
      "UPDATE batches SET status = 'extracting', pid = ?, pid_started = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'ready' AND NOT EXISTS (SELECT 1 FROM batches WHERE status IN ('extracting', 'running') AND id != ?)",
      process.pid, procStarted(process.pid), nowIso(clock), batchId, batchId,
    ).changes;
    if (!claimed) {
      const now = db.get("SELECT status, pid FROM batches WHERE id = ?", batchId);
      const other = db.get("SELECT id FROM batches WHERE status IN ('extracting', 'running') AND id != ?", batchId);
      if (now.status !== "ready") return { started: false, why: `batch ${batchId} is ${now.status}${now.pid && ["extracting", "running"].includes(now.status) ? ` (pid ${now.pid})` : ""}; it was not started again` };
      return { started: false, why: `batch ${other?.id} is running; one batch runs at a time` };
    }
  }
  try {
    return await prepareAndStart({ ...opts, batch });
  } catch (e) {
    if (!dryRun) db.run("UPDATE batches SET status = 'ready', error = COALESCE(?, error) WHERE id = ? AND status = 'extracting'", e.message, batchId);
    throw e;
  }
}

async function prepareAndStart({ db, config, batchId, batch, client, dryRun = false, foreground = false, force = false, log = () => {}, extractFn, clock = Date.now }) {
  const batchDir = batchDirOf(config.project.slug, batchId);
  mkdirSync(batchDir, { recursive: true });
  const toReady = (why) => db.run("UPDATE batches SET status = 'ready', error = ? WHERE id = ?", why, batchId);

  // 0. Money. A retry does not get a fresh per-batch limit, and no batch starts past the day's cap.
  if (!dryRun && config.limits.usd_per_batch && usdLeft(config, batch) < 0.5) {
    db.run("UPDATE batches SET status = 'stuck', finished_at = ?, error = ? WHERE id = ?", nowIso(clock), `the batch has used its $${config.limits.usd_per_batch} (limits.usd_per_batch)`, batchId);
    return { started: false, finished: true, stuck: true, lanes: [] };
  }
  const spent = Number(budgetToday(db, config.project.slug, clock()).usd ?? 0);
  if (!dryRun && config.limits.usd_per_day && spent >= config.limits.usd_per_day) {
    toReady(`waiting: $${spent.toFixed(2)} of today's $${config.limits.usd_per_day} spent (limits.usd_per_day)`);
    return { started: false, why: `today's $${config.limits.usd_per_day} is spent; the batch waits until tomorrow` };
  }

  // 1. Extraction (REST, no AI). A 429 that outlasts the backoff stops here, before any AI cost.
  let extract = existsSync(join(batchDir, "extract.json")) ? JSON.parse(readFileSync(join(batchDir, "extract.json"), "utf8")) : null;
  const runExtract = async () => {
    try {
      return await extractFn({ db, config, client, batchId, clock, log });
    } catch (e) {
      toReady(`extraction stopped: ${e.message}`);
      if (e.kind === "auth") db.run("INSERT OR REPLACE INTO project_state (project, blocked, blocked_at) VALUES (?, ?, ?)", config.project.slug, `Figma token rejected (${e.status})`, nowIso(clock));
      if (e.kind === "rate_limit" && e.retry_after_s) blockUntil(db, config.project.slug, clock() + e.retry_after_s * 1000);
      throw e;
    }
  };
  if (!extract) extract = await runExtract();
  // Items settled before AI (already built, gone from Figma) close their events now.
  const settle = () => db.run("UPDATE events SET status = 'done' WHERE batch_id = ? AND item_id IN (SELECT id FROM items WHERE batch_id = ? AND outcome IN ('already_done', 'cancelled'))", batchId, batchId);
  settle();
  const pendingNow = () => db.all("SELECT * FROM items WHERE batch_id = ? AND outcome = 'pending'", batchId);
  let pending = pendingNow();
  const mode = config.project.autonomy;

  // 1b. Can Claude run a session? Asked for free, before any worktree or install. A full usage
  // meter or a signed-out login holds the batch with its items; the tick looks again hourly and
  // starts it once the wait is over. While a wait runs and the meters cannot be read, it stays held.
  if (!dryRun && mode !== "notify" && pending.length) {
    const pf = preflight({ config, batch, batchDir, clock });
    if (pf.account.text) db.run("UPDATE batches SET account = ? WHERE id = ?", pf.account.text, batchId);
    batchLog(batchDir, `attempt ${batch.attempts + 1}: Claude login for this session: ${pf.account.text ?? "unknown (claude auth status gave no answer)"}. Usage: ${meterLine(pf.meters) || "no meters read"}`);
    // While a wait runs, only meters that were the ones to see the limit can end it early: meters
    // that cannot be read, or that had room when a session was refused, say nothing.
    const waiting = batch.wait_kind && batch.retry_after && clock() < Date.parse(batch.retry_after);
    if (pf.ok === false || (waiting && !force && (pf.ok === null || batch.wait_source === "session"))) {
      let h = { line: batch.error, until: Date.parse(batch.retry_after ?? "") };
      if (pf.ok === false) h = holdBatch({ db, batchId, block: pf, clock });
      else db.run("UPDATE batches SET status = 'ready', probed_at = ?, pid = NULL WHERE id = ?", nowIso(clock), batchId);
      batchLog(batchDir, `not started: ${h.line}${pf.text ? ` (${pf.text})` : ""}`);
      return { started: false, waiting: true, why: h.line, lanes: [] };
    }
    if (batch.wait_kind) {
      db.run("UPDATE batches SET wait_kind = NULL, wait_source = NULL, retry_after = NULL, wait_note = NULL, probed_at = NULL, error = NULL WHERE id = ?", batchId);
      batchLog(batchDir, "the wait for Claude is over; starting");
      // The batch may have waited for days: build from the design as it is now, unless a session
      // already recorded work on it.
      const worked = db.get("SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND outcome IN ('applied', 'question', 'needs_you', 'failed', 'skipped')", batchId).n;
      const edited = db.all("SELECT last_touched_at FROM files WHERE project = ? AND role = 'live'", config.project.slug).some((f) => f.last_touched_at && f.last_touched_at > extract.extracted_at);
      if (!worked && edited) {
        db.run("UPDATE items SET outcome = 'pending', verdict = NULL WHERE batch_id = ? AND outcome IN ('already_done', 'cancelled')", batchId);
        extract = await runExtract();
        settle();
        pending = pendingNow();
      }
    }
  }

  // 2. Lanes: one per area. Build mode gets a worktree per lane. A retry keeps the uncommitted
  // edits its own stopped attempt left, unless another batch has run in that folder since.
  let prevLanes = [];
  try {
    // (A session Claude refused part-way is no attempt, yet the edits it left are still this batch's.)
    if (batch.attempts > 0 || batch.wait_source === "session") prevLanes = JSON.parse(readFileSync(join(batchDir, "batch.json"), "utf8")).lanes ?? [];
  } catch {}
  const since = batch.finished_at ?? batch.started_at;
  const otherSince = since ? db.get("SELECT 1 FROM batches WHERE project = ? AND id != ? AND started_at > ?", config.project.slug, batchId, since) : null;
  const laneNames = [...new Set(pending.map(laneOf))];
  const lanes = [];
  const taken = new Set();
  for (const lane of laneNames) {
    // A watched section's lane updates the pre-built page: it starts from the watch's branch and
    // previews the watch's route.
    const ws = [...new Map(pending.map(watchOfItem).filter((w) => w?.lane === lane).map((w) => [w.node, w])).values()];
    const w = ws[0];
    let l = planLane(config, lane, undefined, w ? { base: w.branch } : {});
    if (w) l.watch = { branch: w.branch, built: ws.some((x) => x.built), sections: ws.map((x) => ({ name: x.name, node: x.node, route: x.route, built: x.built, notes: x.notes })) };
    if (mode === "build" && !dryRun) {
      const carry = !otherSince && prevLanes.some((p) => !p.blocked && p.worktree === l.worktree);
      if (w && !l.existing_branch && tryGit(config.project.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]) === null)
        l = { ...l, blocked: `the watched section's branch ${w.branch} is not a local branch of ${config.project.repo}` };
      else
        try {
          l = prepareWorktree(config, l, { carry });
        } catch (e) {
          l = { ...l, blocked: e.message };
        }
    }
    if (mode === "build") {
      l.port = await freePort(config.stack.port_base + lanes.length, taken);
      taken.add(l.port);
      l.dev = fill(config.stack.dev, { port: l.port });
      const route = ws.find((x) => x.route)?.route ?? fill(config.stack.preview_route, { page: config.stack.preview_pages[lane] ?? lane });
      l.preview = `http://localhost:${l.port}${route}`;
    }
    lanes.push(l);
  }
  for (const l of lanes.filter((x) => x.blocked)) log(`lane ${l.lane} blocked: ${l.blocked}`);
  // Every lane blocked: no session, the report says why, and the batch waits for Tony.
  if (mode === "build" && lanes.length && lanes.every((l) => l.blocked) && !dryRun) {
    db.run("UPDATE batches SET status = 'stuck', dir = ?, finished_at = ?, error = ? WHERE id = ?", batchDir, nowIso(clock), lanes.map((l) => l.blocked).join("; "), batchId);
    return { started: false, finished: true, stuck: true, lanes };
  }

  // 3. Model: the cheaper coordinator only for comment-only batches when usage runs ahead.
  let model = config.models.coordinator;
  const pace = db.get("SELECT value FROM meta WHERE key = 'pace'");
  if (pace && JSON.parse(pace.value).pace?.ahead && pending.every((i) => i.kind === "comment")) model = config.models.coordinator_when_ahead_of_pace;

  const manifest = buildManifest({ db, config, batch, lanes, extract, batchDir, model });
  const manifestPath = join(batchDir, "batch.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));

  if (mode === "notify" || !pending.length) {
    if (dryRun) return { started: false, dryRun: true, manifest: manifestPath, lanes };
    const settledBySession = db.get("SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND outcome NOT IN ('pending', 'already_done', 'cancelled')", batchId).n;
    db.run("UPDATE batches SET status = 'done', finished_at = ?, dir = ?, summary = COALESCE(summary, ?) WHERE id = ?", nowIso(clock), batchDir, pending.length ? `${pending.length} new in Figma` : settledBySession ? "every item was recorded" : "nothing left to build after extraction", batchId);
    db.run("UPDATE items SET outcome = 'fyi', verdict = COALESCE(verdict, 'New in Figma.') WHERE batch_id = ? AND outcome = 'pending'", batchId);
    db.run("UPDATE events SET status = 'done' WHERE batch_id = ?", batchId);
    bumpBudget(db, config.project.slug, "batches", 1, clock());
    return { started: false, finished: true, manifest: manifestPath, lanes };
  }

  const files = writeSessionFiles({ config, batch, batchDir, lanes });
  const prompt = renderPrompt({ manifestPath, mode, batch });
  writeFileSync(join(batchDir, "prompt.md"), prompt);
  // A new session id per attempt: Claude Code refuses an id it has already used.
  const sessionId = randomUUID();
  const cmd = claudeCommand({ config, batch, batchDir, files, lanes, prompt, model, sessionId });
  writeFileSync(join(batchDir, "session", "command.json"), JSON.stringify({ bin: cmd.bin, args: cmd.args.map((a) => (a === prompt ? "<prompt.md>" : a.length > 300 ? `<${a.length} chars>` : a)), cwd: cmd.cwd }, null, 1));
  if (dryRun) return { started: false, dryRun: true, manifest: manifestPath, command: cmd, lanes };

  db.run("UPDATE batches SET status = 'running', dir = ?, session_id = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?) WHERE id = ?", batchDir, sessionId, nowIso(clock), batchId);
  bumpBudget(db, config.project.slug, "batches", 1, clock());
  if (foreground) return { started: true, foreground: true, manifest: manifestPath };
  // The supervisor outlives this tick; caffeinate keeps the Mac awake while it runs.
  const logFd = openSync(join(batchDir, "supervisor.log"), "a");
  const sup = [process.execPath, FIGPIPE_BIN, "supervise", batchId];
  const useCaffeinate = process.platform === "darwin" && !process.env.FIGPIPE_NO_CAFFEINATE;
  const child = spawn(useCaffeinate ? "/usr/bin/caffeinate" : sup[0], useCaffeinate ? ["-i", ...sup] : sup.slice(1), { detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, FIGPIPE_HOME: paths().home } });
  child.unref();
  setPid(db, batchId, child.pid);
  return { started: true, pid: child.pid, manifest: manifestPath };
}

// Figma asked for a wait longer than the backoff: no checks or extractions for the project until then.
export function blockUntil(db, project, ms) {
  const until = new Date(ms).toISOString();
  db.run("INSERT INTO project_state (project, blocked_until) VALUES (?, ?) ON CONFLICT (project) DO UPDATE SET blocked_until = excluded.blocked_until", project, until);
  return until;
}

// Parse claude -p stream-json: session id, final result, cost, and the calls Claude Code itself
// refused (not on the allowlist). The guard records its own denials; those carry reason "hook".
export function parseStream(text) {
  let session = null;
  let result = null;
  const calls = new Map();
  const denied = [];
  let mcp = null;
  let init = null;
  let limit = null;
  let apiError = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.session_id) session = m.session_id;
    if (m.type === "result") result = m;
    if (m.type === "system" && m.subtype === "init") {
      mcp = m.mcp_servers ?? null;
      init = { version: m.claude_code_version ?? null, model: m.model ?? null, key_source: m.apiKeySource ?? null };
    }
    // What the API said when it refused: the limit that was hit and when it resets.
    if (m.type === "rate_limit_event" && m.rate_limit_info) limit = m.rate_limit_info;
    if (m.type === "assistant" && (m.is_api_error_message || m.error))
      apiError = { error: m.error ?? null, code: m.api_error ?? null, status: m.api_error_status ?? null, text: (m.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ") };
    if (m.type === "assistant") for (const c of m.message?.content ?? []) if (c.type === "tool_use") calls.set(c.id, { tool: c.name, input: c.input });
    if (m.type === "system" && m.subtype === "permission_denied" && m.decision_reason_type !== "hook") {
      const call = calls.get(m.tool_use_id) ?? { tool: m.tool_name, input: {} };
      denied.push({ ...call, reason: m.decision_reason_type === "mode" ? "not on the session's allowlist" : `refused by Claude Code (${m.decision_reason_type ?? "rule"})` });
    }
  }
  let structured = result?.structured_output ?? null;
  if (!structured && typeof result?.result === "string") {
    try {
      structured = JSON.parse(result.result.replace(/^```(json)?\s*|\s*```$/g, ""));
    } catch {}
  }
  return { session, result, structured, usd: result?.total_cost_usd ?? null, denied, mcp, init, limit, apiError };
}

// Dependencies for a lane worktree, installed here (outside the sandbox, which has no registry
// access) before the session starts. Only when the package files match the lane's base branch, so
// a session's own edits to them never run on the host, and with install scripts off.
export function installCommand(config) {
  if (config.stack.install) return config.stack.install;
  return { npm: "npm ci --ignore-scripts --no-audit --no-fund", pnpm: "pnpm install --frozen-lockfile --ignore-scripts", yarn: "yarn install --frozen-lockfile --ignore-scripts", bun: "bun install --frozen-lockfile --ignore-scripts" }[config.stack.package_manager || "npm"] ?? null;
}
const PKG_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
export async function installDeps({ config, lane, batchDir, timeoutMs = 20 * 60 * 1000 }) {
  const wt = lane.worktree;
  if (!existsSync(join(wt, "package.json")) || existsSync(join(wt, "node_modules"))) return null;
  const cmd = installCommand(config);
  if (!cmd) return null;
  const same = spawnSync("git", ["-C", wt, "diff", "--quiet", lane.base, "--", ...PKG_FILES]).status === 0;
  if (!same) return { ok: false, cmd, why: `package files in ${wt} differ from ${lane.base}, so figpipe did not install them` };
  const logFile = join(batchDir, `install-${lane.lane}.log`);
  const fd = openSync(logFile, "a");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FIGPIPE_")));
  const child = spawn("/bin/sh", ["-c", cmd], { cwd: wt, env, stdio: ["ignore", fd, fd], detached: true });
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, timeoutMs);
  const code = await new Promise((res) => child.on("exit", (c) => res(c ?? 1)));
  clearTimeout(timer);
  if (code === 0) return { ok: true, cmd };
  const tail = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).pop() ?? "";
  return { ok: false, cmd, why: `exit ${code}: ${tail.slice(0, 200)}` };
}

// Dev servers a session started outlive its commands (the sandbox stops a later command from
// signalling them). After the session, stop whatever listens on the lane ports from inside a lane worktree.
export function stopDevServers(lanes) {
  const stopped = [];
  for (const l of lanes.filter((x) => x.port && x.worktree && !x.blocked)) {
    const pids = (spawnSync("lsof", ["-ti", `tcp:${l.port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean).map(Number);
    for (const pid of pids) {
      const cwd = ((spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).stdout ?? "").match(/^n(.+)$/m) ?? [])[1];
      if (!cwd || !(realish(cwd) + "/").startsWith(realish(l.worktree) + "/")) continue;
      try {
        process.kill(pid, "SIGTERM");
        stopped.push(pid);
      } catch {}
    }
  }
  return stopped;
}

// The broker: inside the sandbox figpipe cannot open state.db or start a browser, so the session's
// figpipe hands each command over as a file in <batch>/broker/. The supervisor runs it here, outside
// the sandbox, as a session command of this batch only (figpipe refuses everything else), and
// writes the answer back next to it.
export function startBroker({ batchDir, batchId, roots, nodeBin = process.execPath }) {
  const dir = join(batchDir, "broker");
  mkdirSync(dir, { recursive: true });
  let busy = false;
  let stopped = false;
  const inside = (p) => {
    const r = realish(p);
    return roots.map(realish).some((x) => r === x || r.startsWith(x + "/"));
  };
  async function one(file) {
    const id = file.replace(/\.req\.json$/, "");
    const taken = join(dir, `${id}.taken`);
    try {
      renameSync(join(dir, file), taken);
    } catch {
      return;
    }
    let req;
    try {
      req = JSON.parse(readFileSync(taken, "utf8"));
    } catch {
      req = null;
    }
    let res;
    if (!req || !Array.isArray(req.args) || !req.args.every((a) => typeof a === "string")) res = { code: 2, stdout: "", stderr: "figpipe: unreadable request\n" };
    else {
      const cwd = typeof req.cwd === "string" && existsSync(req.cwd) && inside(req.cwd) ? req.cwd : batchDir;
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FIGPIPE_(SESSION|BATCH|BROKER|BROKERED|BATCH_DIR)$/.test(k))), FIGPIPE_HOME: paths().home, FIGPIPE_SESSION: "1", FIGPIPE_BATCH: batchId, FIGPIPE_BROKERED: "1", FIGPIPE_BATCH_DIR: batchDir };
      res = await new Promise((resolve) => {
        const child = spawn(nodeBin, [FIGPIPE_BIN, ...req.args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("exit", (c) => resolve({ code: c ?? 1, stdout, stderr }));
        child.on("error", (e) => resolve({ code: 1, stdout, stderr: `figpipe: ${e.message}\n` }));
      });
    }
    writeFileSync(join(dir, `${id}.res.tmp`), JSON.stringify(res));
    renameSync(join(dir, `${id}.res.tmp`), join(dir, `${id}.res.json`));
    rmSync(taken, { force: true });
  }
  async function poll() {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".req.json")).sort()) await one(f);
    } catch {}
    busy = false;
  }
  const timer = setInterval(poll, 200);
  return {
    stop: async () => {
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 50));
      stopped = true;
    },
  };
}

// The session's side of the broker: hand the command over and wait for the answer.
export async function viaBroker(dir, args, { timeoutMs = args[0] === "capture" ? 20 * 60 * 1000 : 3 * 60 * 1000 } = {}) {
  const id = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(dir, `${id}.req.tmp`), JSON.stringify({ args, cwd: process.cwd() }));
  renameSync(join(dir, `${id}.req.tmp`), join(dir, `${id}.req.json`));
  const resFile = join(dir, `${id}.res.json`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(resFile)) {
      const res = JSON.parse(readFileSync(resFile, "utf8"));
      rmSync(resFile, { force: true });
      return res;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { code: 1, stdout: "", stderr: "figpipe: the batch supervisor did not answer; record what you have and finish\n" };
}

// Run the session in the foreground of this process, with a wall-clock kill.
export async function supervise({ db, config, batchId, after = () => {}, clock = Date.now }) {
  const batch = db.get("SELECT * FROM batches WHERE id = ?", batchId);
  const batchDir = batch.dir ?? batchDirOf(config.project.slug, batchId);
  const manifest = JSON.parse(readFileSync(join(batchDir, "batch.json"), "utf8"));
  const lanes = manifest.lanes;
  const note = (text, detail = null) => db.run("INSERT INTO notes (batch_id, kind, text, detail) VALUES (?, 'not_done', ?, ?)", batchId, text, detail);

  // Dependencies first, outside the sandbox.
  for (const l of lanes.filter((x) => !x.blocked && x.worktree && config.project.autonomy === "build")) {
    const r = await installDeps({ config, lane: l, batchDir });
    if (r && !r.ok) note(`Dependencies were not installed in ${l.lane} (${r.why}). Captures and checks there may fail.`, `cd ${l.worktree} && ${r.cmd}`);
  }

  const files = { mcp: join(batchDir, "session", "mcp.json"), settings: join(batchDir, "session", "settings.json") };
  const prompt = readFileSync(join(batchDir, "prompt.md"), "utf8");
  const cmd = claudeCommand({ config, batch, batchDir, files, lanes, prompt, model: manifest.models.coordinator, sessionId: batch.session_id });
  const remotes = (tryGit(config.project.repo, ["remote"]) ?? "").split("\n").filter(Boolean);
  const env = sessionEnv({ bin: join(batchDir, "session", "bin"), batch, batchDir, remotes });
  const guard = JSON.parse(readFileSync(join(batchDir, "session", "guard.json"), "utf8"));
  const broker = startBroker({ batchDir, batchId, roots: guard.writeRoots });
  const transcript = join(batchDir, "transcript.jsonl");
  rmSync(transcript, { force: true });
  const out = openSync(transcript, "a");
  const err = openSync(join(batchDir, "session.stderr.log"), "a");
  const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, env, detached: true, stdio: ["ignore", out, err] });
  setPid(db, batchId, child.pid);
  let timedOut = false;
  const limit = config.limits.max_minutes * 60 * 1000;
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 30000).unref();
  }, limit);
  const code = await new Promise((res) => child.on("exit", (c, s) => res(c ?? (s ? 128 : 1))));
  clearTimeout(timer);
  await broker.stop();
  stopDevServers(lanes);

  const parsed = parseStream(existsSync(transcript) ? readFileSync(transcript, "utf8") : "");
  if (parsed.session && parsed.session !== batch.session_id) db.run("UPDATE batches SET session_id = ? WHERE id = ?", parsed.session, batchId);
  // A session without the Figma MCP still builds, but motion and video were not read: say so.
  const fig = parsed.mcp?.find((s) => s.name === "figma");
  if (parsed.mcp) db.run("UPDATE batches SET figma_mcp = ? WHERE id = ?", fig?.status ?? "missing", batchId);
  if (parsed.mcp && fig?.status !== "connected") note(`Figma MCP was ${fig ? `not available (${fig.status})` : "missing"} in this session, so motion and video were not read; stills can mislead.`, "Motion hints on each item list what to check by hand.");
  // Allowlist refusals show in the report next to the guard's, so Tony can allow a command.
  for (const d of parsed.denied) db.run("INSERT INTO denials (batch_id, at, tool, input, reason) VALUES (?, ?, ?, ?, ?)", batchId, nowIso(clock), d.tool, JSON.stringify(d.input ?? {}).slice(0, 2000), d.reason);
  // Money: what the session reported, or, for a run killed before it could report, the whole limit it had.
  const spent = parsed.usd ?? (timedOut ? usdLeft(config, batch) : 0);
  if (spent) {
    db.run("UPDATE batches SET usd = COALESCE(usd, 0) + ? WHERE id = ?", spent, batchId);
    bumpBudget(db, config.project.slug, "usd", spent, clock());
  }
  if (parsed.init) batchLog(batchDir, `session ran on Claude Code ${parsed.init.version ?? "?"}, model ${parsed.init.model ?? "?"}, API key source ${parsed.init.key_source ?? "?"}; exit ${code}`);
  // Claude could not run the session (usage limit, signed out, no credit): not a failed attempt.
  // The batch keeps its items and waits; lanes that got no commit are cleared away.
  const block = timedOut ? null : sessionBlock(parsed, clock());
  if (block && db.get("SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND outcome = 'pending'", batchId).n) {
    const h = holdBatch({ db, batchId, block, clock, source: "session" });
    db.run("UPDATE batches SET finished_at = ? WHERE id = ?", nowIso(clock), batchId);
    if (!spent) db.run("UPDATE budget SET batches = MAX(batches - 1, 0) WHERE day = ? AND project = ?", localDay(clock()), config.project.slug);
    const removed = cleanupLanes({ config, lanes });
    batchLog(batchDir, `${h.line}. Claude said: "${block.text}"${removed.length ? `. Removed ${removed.map((r) => r.branch).join(", ")}: no commits` : ""}`);
    await after({ status: "waiting", error: h.line });
    return { status: "waiting", error: h.line, until: h.until };
  }
  let error = null;
  if (timedOut) error = `stopped after ${config.limits.max_minutes} min (limits.max_minutes)`;
  else if (!parsed.result) error = `the session ended without a result (exit ${code})`;
  else if (parsed.result.is_error || parsed.result.subtype !== "success") error = `the session ended with ${parsed.result.subtype ?? "an error"}`;
  if (!error && !parsed.structured) error = "the session returned no structured result";
  if (!error) {
    try {
      writeFileSync(join(batchDir, "result.json"), JSON.stringify(parsed.structured, null, 1));
      recordResult({ db, batchId, result: parsed.structured, batchDir, sessionId: parsed.session, clock });
    } catch (e) {
      error = e.message;
    }
  }
  const resume = `claude --resume ${parsed.session ?? batch.session_id}`;
  // The session recorded every item before it stopped: the work is kept and the batch is done.
  const left = db.get("SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND outcome = 'pending'", batchId).n;
  if (error && left === 0) {
    note(`The session stopped after recording every item (${error}).`, resume);
    db.run("UPDATE batches SET status = 'done', error = NULL, finished_at = ? WHERE id = ?", nowIso(clock), batchId);
    await after({ status: "done" });
    return { status: "done", error };
  }
  if (error) {
    const b = db.get("SELECT attempts, usd FROM batches WHERE id = ?", batchId);
    const status = b.attempts < 2 && usdLeft(config, b) >= 0.5 ? "ready" : "stuck";
    db.run("UPDATE batches SET status = ?, error = ?, finished_at = ? WHERE id = ?", status, error, nowIso(clock), batchId);
    if (status === "stuck") {
      note(b.attempts < 2 ? `The batch stopped and has used its $${config.limits.usd_per_batch}: ${error}` : `The batch stopped twice: ${error}`, resume);
      const removed = cleanupLanes({ config, lanes });
      if (removed.length) batchLog(batchDir, `removed ${removed.map((r) => r.branch).join(", ")}: no commits`);
    }
    await after({ status, error });
    return { status, error };
  }
  db.run("UPDATE batches SET status = 'done', error = NULL, finished_at = ? WHERE id = ?", nowIso(clock), batchId);
  await after({ status: "done" });
  return { status: "done" };
}

export function notify({ title, message, file, mode }) {
  if (mode === "none" || process.env.FIGPIPE_NO_NOTIFY) return "none";
  const url = `file://${file}`;
  if (mode === "terminal-notifier" && spawnSync("/bin/sh", ["-c", "command -v terminal-notifier"]).status === 0) {
    spawnSync("terminal-notifier", ["-title", title, "-message", message, "-open", url, "-group", "figpipe"]);
    return "terminal-notifier";
  }
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  spawnSync("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`]);
  return "osascript";
}

// Alive, and (when the start time was saved) still the same process: after a restart a saved pid
// can belong to something else.
export const pidAlive = (pid, started = null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false;
  }
  if (!started) return true;
  const now = procStarted(pid);
  return !now || now === started;
};

