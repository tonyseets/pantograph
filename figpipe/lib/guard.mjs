// The guard: a PreToolUse hook for batch sessions, plus the git hooks and PATH shims that
// enforce the same rules outside Claude Code. Prompts shape intent; this enforces it.
// Fail closed: anything the guard cannot read is denied.
import { sep, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { realish } from "./paths.mjs";
import { budgetToday, bumpBudget, nowIso } from "./db.mjs";

// Figma MCP tools a batch may call (reads). Everything else on the Figma server writes or
// spends money elsewhere, and is denied.
export const FIGMA_MCP_READS = ["get_motion_context", "export_video", "get_design_context", "get_variable_defs", "get_screenshot", "get_metadata", "whoami", "download_assets"];
const MOTION_TOOLS = new Set(["get_motion_context", "export_video"]);
const FREE_TOOLS = new Set(["whoami"]);

// Split a shell command into simple commands (token arrays), quote-aware. Separators: ; & | &&
// || newlines, and the insides of $( ) and backticks become commands of their own.
export function simpleCommands(cmd) {
  const out = [];
  let cur = [];
  let tok = "";
  let has = false;
  let q = null;
  const endTok = () => {
    if (has) cur.push(tok);
    tok = "";
    has = false;
  };
  const endCmd = () => {
    endTok();
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < cmd.length) tok += cmd[++i];
      else if (q === '"' && c === "$" && cmd[i + 1] === "(") {
        // Command substitution inside double quotes still runs.
        let depth = 0;
        let j = i + 1;
        for (; j < cmd.length; j++) {
          if (cmd[j] === "(") depth++;
          else if (cmd[j] === ")" && --depth === 0) break;
        }
        out.push(...simpleCommands(cmd.slice(i + 2, j)));
        tok += cmd.slice(i, j + 1);
        i = j;
      } else tok += c;
      has = true;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      tok += cmd[++i];
      has = true;
    } else if (c === " " || c === "\t") endTok();
    else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "`" || c === "{" || c === "}") endCmd();
    else if (c === "$" && cmd[i + 1] === "(") {
      endCmd();
      i++;
    } else {
      tok += c;
      has = true;
    }
  }
  endCmd();
  return out;
}

const WRAPPERS = new Set(["env", "exec", "command", "nohup", "time", "sudo", "xargs", "nice", "builtin", "eval", "sh", "bash", "zsh"]);
// The program a simple command runs, skipping VAR=value prefixes and wrappers.
function program(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(w.split("/").pop())) {
      i++;
      while (i < words.length && words[i].startsWith("-")) i++;
      if (words[i - 1] === "-c" || words[i - 1] === "-lc") return { prog: "sh-c", args: words.slice(i) };
    } else break;
  }
  return { prog: (words[i] ?? "").split("/").pop(), args: words.slice(i + 1) };
}

// git's subcommand after its global options (-C dir, -c k=v, --git-dir=..., --no-pager, ...).
function gitSub(args) {
  const cfg = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--namespace" || a === "--exec-path") i += 2;
    else if (a === "-c") {
      cfg.push(args[i + 1] ?? "");
      i += 2;
    } else {
      if (a.startsWith("-c")) cfg.push(a.slice(2));
      i++;
    }
  }
  return { sub: args[i] ?? "", rest: args.slice(i + 1), cfg };
}

const DENY_PROGRAMS = {
  gh: "GitHub and GitLab CLIs are not allowed",
  hub: "GitHub and GitLab CLIs are not allowed",
  glab: "GitHub and GitLab CLIs are not allowed",
  open: "opening apps or windows is not allowed; captures run headless",
  osascript: "opening apps or windows is not allowed; captures run headless",
  "xdg-open": "opening apps or windows is not allowed",
  ssh: "remote shells and file transfers are not allowed",
  scp: "remote shells and file transfers are not allowed",
  sftp: "remote shells and file transfers are not allowed",
  ftp: "remote shells and file transfers are not allowed",
  rsync: "remote shells and file transfers are not allowed",
  nc: "raw network tools are not allowed",
  ncat: "raw network tools are not allowed",
  telnet: "raw network tools are not allowed",
  sendmail: "messaging is not allowed",
  mail: "messaging is not allowed",
  mailx: "messaging is not allowed",
  mutt: "messaging is not allowed",
  wrangler: "publishing or deploying is not allowed",
  vercel: "publishing or deploying is not allowed",
  netlify: "publishing or deploying is not allowed",
  firebase: "publishing or deploying is not allowed",
  flyctl: "publishing or deploying is not allowed",
  heroku: "publishing or deploying is not allowed",
  storyblok: "CMS writes are not allowed in unattended runs",
  contentful: "CMS writes are not allowed in unattended runs",
  launchctl: "process and scheduler control is not allowed",
  crontab: "process and scheduler control is not allowed",
  caffeinate: "process and scheduler control is not allowed",
  killall: "process and scheduler control is not allowed",
  pkill: "process and scheduler control is not allowed",
};

// git subcommands that only read. Anything else changes a checkout, a branch or the shared stash.
const GIT_READS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "grep", "cat-file", "merge-base", "shortlog", "rev-list", "show-ref", "for-each-ref", "name-rev", "check-ignore", "var", "help", "version", "whatchanged", "count-objects"]);
function gitReads(sub, rest) {
  if (GIT_READS.has(sub)) return true;
  if (sub === "worktree" || sub === "stash") return rest[0] === "list";
  if (sub === "branch")
    return !rest.length || (rest.some((a) => /^(-a|-r|--all|--remotes|--list|-l|--show-current|-v|-vv|--verbose|--contains|--merged|--no-merged)$/.test(a)) && !rest.some((a) => /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force|-u|--set-upstream-to|--unset-upstream)$/.test(a)));
  if (sub === "config") return rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
  if (sub === "remote") return !rest.length || ["-v", "show", "get-url"].includes(rest[0]);
  if (sub === "tag") return !rest.length || rest.some((a) => a === "-l" || a === "--list");
  if (sub === "reflog") return !rest.length || rest[0] === "show";
  return false;
}

// The folder a git command acts on: -C (cumulative), --git-dir or --work-tree, else the cwd.
function gitTarget(args, cwd) {
  let dir = cwd;
  for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i];
    if (a === "-C") dir = dir ? resolve(dir, args[++i] ?? "") : args[++i];
    else if (a === "--git-dir" || a === "--work-tree") dir = dir ? resolve(dir, args[++i] ?? "") : args[++i];
    else if (/^--(git-dir|work-tree)=/.test(a)) dir = resolve(dir ?? "/", a.split("=").slice(1).join("="));
    else if (a === "-c" || a === "--namespace" || a === "--exec-path") i++;
  }
  return dir;
}

function checkGit(args, ctx = {}) {
  const { sub, rest, cfg } = gitSub(args);
  if (cfg.some((c) => /^(url\.|remote\.|core\.hookspath|include)/i.test(c))) return "overriding push, remote or hook config is not allowed";
  if (["push", "send-email", "request-pull"].includes(sub)) return `git ${sub} is not allowed; everything stays local until Tony reviews`;
  if (sub === "remote" && ["add", "set-url", "rename", "remove", "rm", "set-head", "set-branches"].includes(rest[0])) return "changing git remotes is not allowed";
  if (sub === "config" && rest.some((r) => /^(remote\.|url\.|core\.hookspath|include|branch\.[^.]+\.(remote|pushremote)|push\.)/i.test(r)))
    return "changing push, remote or hook config is not allowed";
  if (sub === "worktree" && ["remove", "prune", "move"].includes(rest[0]) && rest.includes("--force")) return "force-removing worktrees is not allowed";
  if (sub === "stash" && rest[0] !== "list") return "git stash is not allowed: the stash list is shared with Tony's checkout and other sessions; commit instead";
  // Branches figpipe did not make are Tony's: never deleted, renamed, reset or force-moved.
  const prefix = ctx.branchPrefix;
  if (prefix) {
    const names = rest.filter((a) => !a.startsWith("-"));
    const own = (b) => b.startsWith(prefix);
    if (sub === "branch" && rest.some((a) => /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force)$/.test(a)) && names.some((b) => !own(b))) return `only ${prefix}* branches may be deleted, renamed or moved`;
    if ((sub === "checkout" || sub === "switch") && rest.some((a) => /^(-B|-C|--force-create)$/.test(a))) {
      const i = rest.findIndex((a) => /^(-B|-C|--force-create)$/.test(a));
      if (rest[i + 1] && !own(rest[i + 1])) return `only ${prefix}* branches may be reset`;
    }
    if (sub === "update-ref" && !names.every((r) => r.startsWith(`refs/heads/${prefix}`) || r === "HEAD" || /^[0-9a-f]{7,40}$/.test(r))) return `only refs/heads/${prefix}* may be updated`;
  }
  // Commands that change things run only inside the lane worktrees (and the batch folder).
  if (ctx.writeRoots?.length && !gitReads(sub, rest)) {
    const target = gitTarget(args, ctx.cwd);
    if (target && !within(target, ctx.writeRoots)) return `git ${sub} changes ${target}, which is outside the lane worktrees; run it in the lane's worktree`;
  }
  return null;
}

// Tools that deploy or write to a CMS, however they are launched (npx, npm exec, pnpm dlx, bunx...).
const DEPLOY_TOOLS = /^(@(storyblok|netlify|vercel|contentful|sanity|cloudflare|firebase)\/|(@[\w.-]+\/)?(wrangler|vercel|netlify|netlify-cli|storyblok|storyblok-cli|firebase|firebase-tools|contentful|contentful-cli|sanity|surge|gh-pages|flyctl|heroku)(@|$))/;
function launched(prog, args) {
  const first = (list) => list.find((a) => !a.startsWith("-")) ?? "";
  if (prog === "npx" || prog === "bunx" || prog === "pnpx") return first(args);
  if (prog === "npm" && ["exec", "x"].includes(args[0])) return first(args.slice(1).filter((a) => a !== "--"));
  if ((prog === "pnpm" || prog === "yarn") && ["dlx", "exec"].includes(args[0])) return first(args.slice(1));
  if (prog === "bun" && args[0] === "x") return first(args.slice(1));
  return null;
}

// figpipe inside a session: only the session's own commands, and never with its environment changed.
const SESSION_FIGPIPE = new Set(["budget", "record", "result", "capture", "report", "status", "help"]);
const isFigpipe = (prog, args) => prog === "figpipe" || (prog === "node" && /figpipe\.mjs$/.test(args.find((a) => !a.startsWith("-")) ?? ""));

function checkHttp(prog, args) {
  const joined = args.join(" ");
  if (/(^|\s)(-X|--request)\s*(?!GET\b)[A-Za-z]+|(^|\s)(-d|--data\S*|-F|--form\S*|-T|--upload-file|--json|--post\S*)(\s|=|$)/.test(` ${joined}`)) return "only GET requests are allowed";
  const urls = joined.match(/https?:\/\/[^\s'"]+/g) ?? [];
  for (const u of urls) {
    let host = "";
    try {
      host = new URL(u).hostname;
    } catch {
      return "unreadable URL";
    }
    if (!["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "api.figma.com"].includes(host)) return `network access to ${host} is not allowed`;
  }
  return null;
}

// checkBash(command, ctx) -> reason string when denied, null when allowed.
// ctx (optional): { writeRoots, cwd, branchPrefix } for the rules that depend on where a command runs.
export function checkBash(cmd, ctx = {}) {
  const c = String(cmd ?? "");
  // Whole-string rules: hold even inside scripts passed as strings.
  if (/(?<!api\.)\bfigma\.com\b/i.test(c)) return "figma.com in a command is not allowed; read Figma through figpipe or the read tools";
  if (/\bGIT_CONFIG\w*|\bGIT_DIR\s*=|\bcore\.hooksPath\b/i.test(c)) return "touching git config overrides is not allowed";
  if (/\bgit\b[\s\S]*\s--no-verify\b[\s\S]*\bpush\b|\bgit\b[\s\S]*\bpush\b[\s\S]*\s--no-verify\b/.test(c)) return "git push is not allowed";
  if (/\bFIGPIPE_\w*\s*=|\bunset\s+[^;&|]*\bFIGPIPE_|\benv\b[^;&|]*\s-u\s*FIGPIPE_/.test(c)) return "changing figpipe's session settings is not allowed";
  let cwd = ctx.cwd;
  for (const words of simpleCommands(c)) {
    const { prog, args } = program(words);
    if (prog === "sh-c") {
      const inner = checkBash(args.join(" "), { ...ctx, cwd });
      if (inner) return inner;
      continue;
    }
    if (prog === "cd") {
      const to = args.find((a) => !a.startsWith("-"));
      cwd = !to || to === "~" ? homedir() : to.startsWith("~/") ? homedir() + to.slice(1) : isAbsolute(to) ? to : cwd ? resolve(cwd, to) : undefined;
      continue;
    }
    if (prog === "git") {
      const why = checkGit(args, { ...ctx, cwd });
      if (why) return why;
    } else if (DENY_PROGRAMS[prog]) return DENY_PROGRAMS[prog];
    else if (["curl", "wget", "http", "https", "xh"].includes(prog)) {
      const why = checkHttp(prog, args);
      if (why) return why;
    } else if (["npm", "pnpm", "yarn", "bun"].includes(prog) && ["publish", "deploy", "unpublish"].includes(args[0])) return "publishing is not allowed";
    else if (isFigpipe(prog, args)) {
      const rest = prog === "figpipe" ? args : args.slice(args.findIndex((a) => /figpipe\.mjs$/.test(a)) + 1);
      const sub = rest.find((a) => !a.startsWith("-")) ?? "help";
      if (!SESSION_FIGPIPE.has(sub)) return `figpipe ${sub} is not available inside a batch session`;
    } else if (prog === "rm" && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a)) && args.some((a) => ["/", "~", "$HOME", "/Users", "~/"].includes(a))) return "deleting home or root is not allowed";
    const tool = launched(prog, args);
    if (tool && DEPLOY_TOOLS.test(tool)) return "publishing, deploying or CMS writes are not allowed";
  }
  return null;
}

const real = realish;
function within(p, roots) {
  const abs = real(p);
  return roots.map(real).some((r) => abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep));
}

// decide(input, ctx) -> { allow: true } | { allow: false, reason }
// ctx: { writeRoots: [abs dirs], protect: [abs dirs inside them the session may not change],
//        mcpLeft: () => { left, motionLeft }, cwd, branchPrefix }
export function decide(input, ctx) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  if (!tool) return { allow: false, reason: "the guard could not read the tool call" };
  const flat = JSON.stringify(ti);

  if (tool === "Bash" || tool === "BashOutput" || tool === "PowerShell") {
    const why = checkBash(ti.command, { writeRoots: ctx.writeRoots, cwd: ctx.cwd, branchPrefix: ctx.branchPrefix });
    return why ? { allow: false, reason: why } : { allow: true };
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const p = ti.file_path ?? ti.notebook_path;
    if (!p) return { allow: false, reason: "no file path" };
    if (!within(p, ctx.writeRoots)) return { allow: false, reason: `edits are allowed only in the pipeline worktrees, the batch folder and ${ctx.extractLabel ?? ".figma"}; ${p} is outside them` };
    if (ctx.protect?.length && within(p, ctx.protect)) return { allow: false, reason: `${p} holds the session's own rules and cannot be changed` };
    return { allow: true };
  }
  if (tool === "WebFetch" || tool === "WebSearch") {
    if (/figma\.com/i.test(flat)) return { allow: false, reason: "figma.com is read through the API, never fetched as a page" };
    return { allow: true };
  }
  if (tool.startsWith("mcp__")) {
    const [, server, name] = tool.split("__");
    if (!/figma/i.test(server ?? "")) return { allow: false, reason: `MCP server ${server} is not available to batches` };
    if (!FIGMA_MCP_READS.includes(name)) return { allow: false, reason: `${name} writes to Figma or is not needed; batches only read` };
    if (FREE_TOOLS.has(name)) return { allow: true };
    const b = ctx.mcpLeft?.();
    if (b) {
      const left = MOTION_TOOLS.has(name) ? b.left : b.left - b.reserve;
      if (left <= 0)
        return { allow: false, reason: MOTION_TOOLS.has(name) ? "today's Figma MCP allowance for the pipeline is used up" : "the rest of today's Figma MCP allowance is held for motion" };
    }
    return { allow: true, countMcp: true };
  }
  if (/computer-use|claude-in-chrome|browser|playwriter|slack|gmail|mail/i.test(tool)) return { allow: false, reason: `${tool} is not available to batches` };
  if (/figma\.com/i.test(flat) && !/api\.figma\.com/.test(flat) && tool !== "Read" && tool !== "Grep" && tool !== "Glob")
    return { allow: false, reason: "figma.com is read through the API only" };
  return { allow: true };
}

// Hook entry: reads the tool call from stdin, exits 2 with the reason on deny.
export async function runGuardHook({ db, config, batch, writeRoots, protect = [], stdinText }) {
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch {
    process.stderr.write("figpipe guard: could not parse the tool call; denied\n");
    return 2;
  }
  const project = config.project.slug;
  const mcp = config.figma.mcp;
  const ctx = {
    writeRoots,
    protect,
    cwd: input.cwd,
    branchPrefix: config.git.branch_pattern.split("{page}")[0] || null,
    extractLabel: config.git.extract_dir,
    mcpLeft: () => {
      const used = budgetToday(db, project).mcp_calls;
      return { left: mcp.pipeline_share - used, reserve: mcp.reserve_for_motion };
    },
  };
  let d;
  try {
    d = decide(input, ctx);
  } catch (e) {
    d = { allow: false, reason: `guard error: ${e.message}` };
  }
  if (!d.allow) {
    db.run("INSERT INTO denials (batch_id, at, tool, input, reason) VALUES (?, ?, ?, ?, ?)", batch, nowIso(), input.tool_name, JSON.stringify(input.tool_input ?? {}).slice(0, 2000), d.reason);
    process.stderr.write(`figpipe guard: ${d.reason}\n`);
    return 2;
  }
  if (d.countMcp) {
    bumpBudget(db, project, "mcp_calls");
    if (batch) db.run("UPDATE batches SET mcp_calls = mcp_calls + 1 WHERE id = ?", batch);
  }
  return 0;
}

// Shell shims put first on PATH inside a batch session. Same rules, for commands that run
// inside scripts the hook never sees.
export const SHIMS = {
  git: (realGit) => `#!/bin/sh
# figpipe: git without push. Generated per batch.
for a in "$@"; do
  case "$a" in
    push|send-email|request-pull) echo "figpipe: git $a is blocked; everything stays local until Tony reviews" >&2; exit 1 ;;
  esac
done
exec ${realGit} "$@"
`,
  deny: (name) => `#!/bin/sh
echo "figpipe: ${name} is blocked in batch sessions" >&2
exit 1
`,
};

export const PRE_PUSH = `#!/bin/sh
# figpipe: pipeline worktrees never push. Review the branch, then push it yourself from your own checkout.
echo "figpipe: push refused from a pipeline worktree" >&2
exit 1
`;

// Pass-through for the repo's own hooks, so pipeline commits still run them.
export const passThroughHook = (name, originalDir) => `#!/bin/sh
# figpipe: run the repo's own ${name} hook if it has one.
h="${originalDir}/${name}"
[ -x "$h" ] && exec "$h" "$@"
exit 0
`;
export const HOOK_NAMES = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "post-rewrite", "reference-transaction", "post-index-change"];
