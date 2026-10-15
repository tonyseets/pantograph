// Onboarding facts and health checks, without AI. `figpipe probe` infers what a project config
// needs from the repo and from Figma (read-only); `figpipe doctor` re-checks a configured project.
// The figma-setup skill reads both and asks Tony only what they leave open.
import { ownershipTable } from "./scope.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { devStatusNodes, parseFigmaUrl } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";
import { loadToken } from "../../skills/figma-transpose/scripts/figma-rest.mjs";
import { resolvePlaywright, PLAYWRIGHT_INSTALL } from "./capture.mjs";
import { freePort, claudeAccount } from "./run.mjs";
import { fill } from "./config.mjs";
import { paths, realish } from "./paths.mjs";
import { label as launchdLabel } from "./launchd.mjs";
import { describe as describeSchedule, dueState, lastSlot } from "./schedule.mjs";
import { scheduleFor, followView, wakeCommand, catchUps, AMPHETAMINE } from "./follow.mjs";
import { fetchActivity, toEvents, analyse, inferZone, lateness } from "./activity.mjs";

const tryGit = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const NODE_MIN = [22, 5];
export const nodeOk = (v = process.versions.node) => {
  const [a, b] = v.split(".").map(Number);
  return a > NODE_MIN[0] || (a === NODE_MIN[0] && b >= NODE_MIN[1]);
};

// Framework -> how to start its dev server on a given port, and its usual default port.
const FRAMEWORKS = [
  { id: "nuxt", deps: ["nuxt"], files: ["nuxt.config.ts", "nuxt.config.js"], dev: "npx nuxt dev --port {port}", port: 3000 },
  { id: "next", deps: ["next"], files: ["next.config.js", "next.config.mjs", "next.config.ts"], dev: "npx next dev -p {port}", port: 3000 },
  { id: "astro", deps: ["astro"], files: ["astro.config.mjs", "astro.config.ts"], dev: "npx astro dev --port {port}", port: 4321 },
  { id: "sveltekit", deps: ["@sveltejs/kit"], files: ["svelte.config.js"], dev: "npx vite dev --port {port} --strictPort", port: 5173 },
  { id: "remix", deps: ["@remix-run/dev", "@react-router/dev"], files: [], dev: "npx vite dev --port {port} --strictPort", port: 5173 },
  { id: "gatsby", deps: ["gatsby"], files: ["gatsby-config.js", "gatsby-config.ts"], dev: "npx gatsby develop -p {port}", port: 8000 },
  { id: "eleventy", deps: ["@11ty/eleventy"], files: [".eleventy.js", "eleventy.config.js"], dev: "npx @11ty/eleventy --serve --port={port}", port: 8080 },
  { id: "vite", deps: ["vite"], files: ["vite.config.ts", "vite.config.js"], dev: "npx vite dev --port {port} --strictPort", port: 5173 },
];
const CMS = [
  ["storyblok", /^(@storyblok\/|storyblok-js-client$)/],
  ["sanity", /^(sanity$|@sanity\/|next-sanity$)/],
  ["contentful", /^contentful(-management)?$|^@contentful\//],
  ["prismic", /^@prismicio\//],
  ["builder", /^@builder\.io\//],
  ["directus", /^@directus\//],
  ["payload", /^payload$|^@payloadcms\//],
  ["strapi", /^@strapi\//],
  ["hygraph", /^@hygraph\//],
  ["wordpress", /^@wordpress\//],
];
const LOCKS = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"], ["package-lock.json", "npm"]];
const GATE_ORDER = [/^lint:quiet$/, /^lint$/, /^typecheck$|^type-check$|^check:types$/, /^check$/, /^test:unit$/, /^test$/];
const KEY_RE = /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,})|file[ _-]?key\W{0,4}([A-Za-z0-9]{20,24})\b/gi;

// Bounded walk for small, text-like files.
function walk(dir, { maxDepth = 3, skip = /^(node_modules|\.git|\.nuxt|\.next|\.output|dist|build|\.svelte-kit|\.astro|coverage|\.cache|\.vercel|\.turbo)$/, match, limit = 400 } = {}) {
  const out = [];
  const rec = (d, depth) => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.test(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p, depth + 1);
      else if (!match || match(p)) out.push(p);
      if (out.length >= limit) return;
    }
  };
  rec(dir, 0);
  return out;
}

// Everything about the repo a config needs. Pure reads.
// Ignored env files at the repo root: a fresh worktree lacks them, so its dev server may not start.
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];
const ignoredEnvFiles = (repo) => ENV_FILES.filter((f) => existsSync(join(repo, f)) && tryGit(repo, ["check-ignore", "-q", "--", f]) !== null);

export function probeRepo(repo) {
  repo = realish(repo);
  const r = { repo, slug: basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""), git: null, stack: {}, figma: {}, tools: {}, open: [] };
  if (!existsSync(repo)) {
    r.open.push(`${repo} does not exist`);
    return r;
  }
  // Git: default branch, worktrees, feature branches.
  const top = tryGit(repo, ["rev-parse", "--show-toplevel"]);
  if (top) {
    const head = tryGit(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const branches = (tryGit(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "").split("\n").filter(Boolean);
    const base = head?.replace(/^origin\//, "") ?? ["main", "master", "trunk", "develop"].find((b) => branches.includes(b)) ?? branches[0] ?? null;
    const worktrees = (tryGit(repo, ["worktree", "list", "--porcelain"]) ?? "")
      .split("\n\n")
      .map((b) => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null }))
      .filter((w) => w.path);
    const siblings = worktrees.filter((w) => realish(w.path) !== realish(top)).map((w) => w.path);
    r.git = {
      top,
      base_branch: base,
      current: tryGit(repo, ["branch", "--show-current"]),
      remotes: (tryGit(repo, ["remote"]) ?? "").split("\n").filter(Boolean),
      worktrees,
      feature_branches: branches.filter((b) => /^(feat|feature)\//.test(b)),
      worktree_pattern: "{repo}-fp-{page}",
      other_worktrees: siblings,
      dirty: !!tryGit(repo, ["status", "--porcelain"]),
      worktree_files: ignoredEnvFiles(repo),
      figma_dir_hidden: tryGit(repo, ["check-ignore", "-q", ".figma/x"]) !== null,
      figma_dir_hidden_by: (() => {
        const ex = join(tryGit(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ?? join(repo, ".git"), "info", "exclude");
        return existsSync(ex) && /^\/?\.figma\/?$/m.test(readFileSync(ex, "utf8")) ? "info/exclude" : existsSync(join(repo, ".gitignore")) && /^\/?\.figma\/?$/m.test(readFileSync(join(repo, ".gitignore"), "utf8")) ? ".gitignore" : null;
      })(),
    };
  } else r.open.push("not a git repository; build mode needs git");

  // Stack: framework, package manager, dev command and port, gates, CMS, tokens, preview routes.
  const pkg = readJson(join(repo, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const fw = FRAMEWORKS.find((f) => f.deps.some((d) => d in deps) || f.files.some((x) => existsSync(join(repo, x))));
  const pm = LOCKS.find(([f]) => existsSync(join(repo, f)))?.[1] ?? (pkg ? "npm" : null);
  const scripts = pkg?.scripts ?? {};
  const devScript = scripts.dev ?? scripts.start ?? "";
  const portMatch = devScript.match(/(?:--port[ =]|-p\s+)(\d{2,5})/);
  const userPort = portMatch ? Number(portMatch[1]) : fw?.port ?? null;
  const run = (s) => (pm === "npm" || !pm ? `npm run ${s}` : `${pm} run ${s}`);
  const gates = [];
  for (const re of GATE_ORDER) {
    const s = Object.keys(scripts).find((k) => re.test(k));
    if (!s) continue;
    if (/^lint$/.test(s) && gates.some((g) => g.endsWith("lint:quiet"))) continue;
    if (/^test$/.test(s) && gates.some((g) => g.endsWith("test:unit"))) continue;
    if (/^test$/.test(s) && /no test specified/.test(scripts[s])) continue;
    gates.push(run(s));
  }
  const cms = [...new Set(Object.keys(deps).flatMap((d) => CMS.filter(([, re]) => re.test(d)).map(([k]) => k)))];
  const textFiles = walk(repo, { maxDepth: 4, match: (p) => /\.(css|scss|json|ts|js|mjs|cjs|vue|svelte|astro|tsx|jsx)$/.test(p) && statSync(p).size < 400000 });
  const tokens = [];
  for (const p of textFiles) {
    const rel = relative(repo, p);
    if (/^tailwind\.config\.(js|ts|mjs|cjs)$/.test(rel)) tokens.push({ kind: "tailwind config", path: rel });
    else if (/tokens?\.json$|design-tokens/i.test(rel)) tokens.push({ kind: "token json", path: rel });
    else if (/\.(css|scss)$/.test(rel)) {
      const t = readFileSync(p, "utf8");
      if (/@theme\b/.test(t)) tokens.push({ kind: "tailwind @theme", path: rel });
      else if ((t.match(/--[\w-]+\s*:/g) ?? []).length >= 8) tokens.push({ kind: "css custom properties", path: rel });
    }
    if (tokens.length >= 8) break;
  }
  const routeRoots = ["pages", "app", "src/pages", "src/app", "src/routes", "routes"].map((d) => join(repo, d)).filter(existsSync);
  const preview = routeRoots
    .flatMap((d) => walk(d, { maxDepth: 6, match: (p) => /preview/i.test(relative(d, p)) }).map((p) => ({ root: relative(repo, d), file: relative(repo, p) })))
    .slice(0, 12);
  // Several preview files side by side (preview/home.vue, preview/pricing.vue): one per page.
  const dirOf = (f) => f.split("/").slice(0, -1).join("/");
  const shared = preview.find((p) => preview.filter((q) => dirOf(q.file) === dirOf(p.file)).length > 1);
  const route = shared ? previewRoute({ root: shared.root, file: `${dirOf(shared.file)}/[page].vue` }) : preview[0] ? previewRoute(preview[0]) : null;
  r.stack = {
    framework: fw?.id ?? "",
    package_manager: pm ?? "",
    dev: fw?.dev ?? (devScript ? `${run(scripts.dev ? "dev" : "start")} -- --port {port}` : ""),
    user_port: userPort,
    gates,
    cms: cms[0] ?? "",
    cms_all: cms,
    tokens,
    preview_files: preview.map((p) => p.file),
    preview_route: route,
    scripts: Object.keys(scripts),
  };
  if (!fw && pkg) r.open.push("framework not recognised; confirm the dev command");
  if (!pkg) r.open.push("no package.json; confirm how to run the site locally, or use notes mode");
  if (!route) r.open.push("no preview route found; builds will be checked on the page route itself");
  if (Object.keys(deps).some((d) => /^(@nuxtjs\/i18n|next-intl|next-i18next|@astrojs\/i18n|astro-i18next|svelte-i18n|@inlang\/paraglide)/.test(d)))
    r.open.push("the site is localised: confirm whether preview routes carry a locale prefix (for example /en/preview/{page})");

  // Figma traces in the repo: overlay skills, notes and links to file keys.
  const docs = [
    ...walk(join(repo, ".claude"), { maxDepth: 4, match: (p) => /\.(md|json|txt)$/.test(p) }),
    ...walk(repo, { maxDepth: 1, match: (p) => /\.(md|txt)$/i.test(p) }),
    ...walk(join(repo, "notes"), { maxDepth: 2, match: (p) => /\.md$/.test(p) }),
    ...walk(join(repo, "docs"), { maxDepth: 2, match: (p) => /\.md$/.test(p) }),
    ...walk(join(repo, ".figma"), { maxDepth: 3, match: (p) => /\.md$/.test(p), limit: 200 }),
  ];
  const keys = {};
  for (const p of docs) {
    let t = "";
    try {
      t = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const m of t.matchAll(KEY_RE)) (keys[m[1] ?? m[2]] ??= new Set()).add(relative(repo, p));
  }
  r.figma = {
    overlay_skills: walk(join(repo, ".claude", "skills"), { maxDepth: 2, match: (p) => /SKILL\.md$/.test(p) && /figma/i.test(p) }).map((p) => relative(repo, p)),
    keys_in_repo: Object.entries(keys).map(([key, where]) => ({ key, where: [...where].slice(0, 5) })),
    extract_dir_exists: existsSync(join(repo, ".figma")),
    agents_md: ["AGENTS.md", "CLAUDE.md"].filter((f) => existsSync(join(repo, f))),
  };

  // Tools on this Mac.
  const which = (b) => spawnSync("/bin/sh", ["-c", `command -v ${b}`], { encoding: "utf8" }).stdout.trim() || null;
  r.tools = {
    node: process.versions.node,
    node_ok: nodeOk(),
    claude: process.env.FIGPIPE_CLAUDE_BIN ?? which("claude"),
    playwright: resolvePlaywright([repo]),
    chrome: existsSync("/Applications/Google Chrome.app"),
    terminal_notifier: which("terminal-notifier"),
    figma_pat: existsSync(join(homedir(), ".config", "figma", "pat")) ? "file:~/.config/figma/pat" : null,
  };
  if (!r.tools.node_ok) r.open.push(`Node ${process.versions.node} is too old; figpipe needs 22.5 or newer`);
  if (!r.tools.playwright) r.open.push(`Playwright not found; before/after captures need it, installed once for every project without touching this repo: ${PLAYWRIGHT_INSTALL}`);
  return r;
}

// pages/[lang]/preview/[page].vue -> /{lang}/preview/{page}
function previewRoute({ root, file }) {
  let p = file.slice(root.length).replace(/\\/g, "/");
  p = p.replace(/\/(index|page|\+page)?\.(vue|tsx?|jsx?|astro|svelte|md)$/, "").replace(/\.(vue|tsx?|jsx?|astro|svelte|md)$/, "");
  p = p.replace(/\[\.\.\.(\w+)\]/g, "{page}").replace(/\[\[?(\w+)\]?\]/g, (m, k) => (/slug|page|name|id/i.test(k) ? "{page}" : `{${k}}`));
  p = p.replace(/\/\([^)]+\)/g, "");
  return p.startsWith("/") ? p : `/${p}`;
}

const READY_PAGE = /ready|dev|handoff|hand-off|build|final/i;

// What Figma says: who you are, the rate tier, each file's identity, pages, where ready marks
// sit, breakpoints. Read-only; a few calls per file.
export async function probeFigma(client, links = [], { pages: wantPages = [], depth = 4, repoKeys = [] } = {}) {
  const out = { me: null, rate_limit_type: null, plan_tier: null, files: [], webhooks: null, open: [] };
  try {
    const me = await client.me();
    out.me = { user_id: me.id, handle: me.handle };
  } catch (e) {
    out.open.push(`Figma token: ${e.message}`);
    return out;
  }
  const refs = links.map((l) => (typeof l === "string" ? parseFigmaUrl(l) ?? (/^[A-Za-z0-9]{10,}$/.test(l) ? { fileKey: l } : null) : l)).filter(Boolean);
  const keys = [...new Set(refs.map((r) => r.fileKey))];
  // Keys the repo already names (old links, an overlay skill) are checked too: a same-name copy
  // there is the classic way to build from the wrong file.
  const extra = repoKeys.filter((k) => !keys.includes(k)).slice(0, 5);
  for (const key of [...keys, ...extra]) {
    const f = { key, linked: keys.includes(key), linked_nodes: refs.filter((r) => r.fileKey === key && r.nodeId).map((r) => r.nodeId) };
    try {
      const m = (await client.meta(key)).file ?? {};
      Object.assign(f, { name: m.name, role: m.role, link_access: m.link_access, last_touched_at: m.last_touched_at, last_touched_by: m.last_touched_by?.handle ?? null, editor: m.editorType });
    } catch (e) {
      f.error = e.message;
      out.files.push(f);
      continue;
    }
    try {
      const v = await client.versions(key);
      const named = (v.versions ?? []).filter((x) => x.label);
      f.last_named_version = named[0] ? { label: named[0].label, at: named[0].created_at, by: named[0].user?.handle ?? null } : null;
    } catch {}
    out.files.push(f);
  }
  // Same name, several keys: the most recently edited one is live.
  const byName = new Map();
  for (const f of out.files.filter((x) => x.name)) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  for (const group of byName.values()) {
    group.sort((a, b) => Date.parse(b.last_touched_at ?? 0) - Date.parse(a.last_touched_at ?? 0));
    group.forEach((f, i) => {
      f.verdict = group.length === 1 ? "only" : i === 0 ? "live" : "stale";
      if (group.length > 1) f.same_name = group.filter((g) => g !== f).map((g) => g.key);
    });
  }
  for (const f of out.files.filter((x) => !x.error && x.verdict !== "stale" && (x.linked || !keys.length))) {
    try {
      const file = await client.file(f.key, { depth: 1 });
      f.pages = (file.document?.children ?? []).filter((c) => c.type === "CANVAS").map((c) => ({ id: c.id, name: c.name }));
    } catch (e) {
      f.pages_error = e.message;
      continue;
    }
    const chosen = wantPages.length
      ? f.pages.filter((p) => wantPages.includes(p.name) || wantPages.includes(p.id))
      : f.pages.filter((p) => f.linked_nodes.includes(p.id)).concat(f.pages.filter((p) => READY_PAGE.test(p.name))).filter((p, i, a) => a.indexOf(p) === i);
    f.suggested_pages = chosen.slice(0, 3).map((p) => p.name);
    f.page_scan = [];
    for (const p of chosen.slice(0, 3)) {
      try {
        const resp = await client.nodes(f.key, [p.id], { depth });
        const doc = resp.nodes?.[p.id]?.document;
        const marks = doc ? devStatusNodes(doc) : [];
        const ready = marks.filter((m) => m.status === "READY_FOR_DEV");
        const widths = {};
        for (const c of doc?.children ?? []) for (const g of c.type === "SECTION" ? c.children ?? [] : [c]) {
          const w = Math.round(g.absoluteBoundingBox?.width ?? 0);
          if (w >= 320 && w <= 2560 && g.type === "FRAME") widths[w] = (widths[w] ?? 0) + 1;
        }
        f.page_scan.push({
          page: p.name,
          ready: ready.length,
          completed: marks.filter((m) => m.status === "COMPLETED").length,
          ready_depth: marks.length ? Math.max(...marks.map((m) => m.depth)) : null,
          ready_names: ready.slice(0, 12).map((m) => m.name),
          frame_widths: Object.entries(widths).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => ({ width: Number(w), frames: n })),
        });
      } catch (e) {
        f.page_scan.push({ page: p.name, error: e.message });
      }
    }
    const depths = f.page_scan.map((s) => s.ready_depth).filter(Boolean);
    f.ready_depth = depths.length ? Math.max(...depths) : null;
    f.breakpoints = guessBreakpoints(f.page_scan.flatMap((s) => s.frame_widths ?? []));
  }
  if (keys[0]) {
    try {
      const w = await client.webhooks(keys[0]);
      out.webhooks = { readable: true, count: (w.webhooks ?? []).length };
    } catch (e) {
      out.webhooks = { readable: false, why: e.message };
    }
  }
  out.rate_limit_type = client.info?.rate_limit_type ?? null;
  out.plan_tier = client.info?.plan_tier ?? null;
  if (!keys.length) out.open.push("no Figma link given; ask for the link the designer works in");
  if (out.rate_limit_type === "low") out.open.push("the token has View/Collab limits (about 6 large reads a month): watching will not keep up; use notify mode or get a Dev or Full seat");
  return out;
}

const STANDARD = [["desktop", 1440, 1200, 1920], ["tablet", 1024, 744, 1199], ["mobile", 390, 320, 743]];
export function guessBreakpoints(widths) {
  const bp = {};
  for (const [name, def, lo, hi] of STANDARD) {
    const inRange = widths.filter((w) => w.width >= lo && w.width <= hi).sort((a, b) => b.frames - a.frames);
    bp[name] = inRange.some((w) => w.width === def) ? def : inRange[0]?.width ?? def;
  }
  return bp;
}

// ---------------------------------------------------------------------------------------------
// Doctor: one line per check, each problem with its fix.

// doctor({ config, db, client, clock }) -> [{ status: ok|warn|fail|info, check, detail, fix }]
export async function doctor({ config, db, client, clock = Date.now, launchdPlist = join(homedir(), "Library", "LaunchAgents", `${launchdLabel()}.plist`), logFile = join(paths().logs, "figpipe.log") }) {
  const out = [];
  const add = (status, check, detail = "", fix = "") => out.push({ status, check, detail, fix });
  const c = config;

  add(nodeOk() ? "ok" : "fail", "Node version", process.versions.node, nodeOk() ? "" : "Install Node 22.5 or newer.");
  add("ok", "Config", `${c._file} (${c.project.autonomy})`);

  // Figma.
  let tokenOk = true;
  try {
    loadToken(c.figma.pat_ref);
  } catch (e) {
    tokenOk = false;
    add("fail", "Figma token", e.message, `Save a personal access token where figma.pat_ref points (${c.figma.pat_ref}).`);
  }
  if (tokenOk) {
    try {
      const me = await client.me();
      const mismatch = c.figma.me.user_id && c.figma.me.user_id !== me.id;
      add(mismatch ? "warn" : "ok", "Figma token", `signed in as ${me.handle}`, mismatch ? `figma.me.user_id is ${c.figma.me.user_id} but the token belongs to ${me.id}; mentions will not match.` : "");
      if (!c.figma.me.user_id) add("warn", "Your Figma id", "figma.me.user_id is empty", `Set figma.me.user_id = "${me.id}".`);
      const tier = client.info?.rate_limit_type;
      if (tier === "low") add("fail", "Figma rate tier", "View/Collab limits: about 6 large reads a month", "Use a Dev or Full seat on the plan that owns the file, or set autonomy = \"notify\".");
      else if (tier) add(c.figma.rest_tier && c.figma.rest_tier !== tier ? "warn" : "ok", "Figma rate tier", tier, c.figma.rest_tier && c.figma.rest_tier !== tier ? `Set figma.rest_tier = "${tier}".` : "");
    } catch (e) {
      add("fail", "Figma token", e.message, "Make a new token with file_content:read, file_comments:read, file_versions:read and current_user:read.");
    }
  }
  for (const f of c.figma.files) {
    if (!tokenOk) break;
    let meta = null;
    try {
      meta = (await client.meta(f.key)).file;
      add("ok", `File ${f.name || f.key}`, `${meta.name !== f.name ? `${meta.name}, ` : ""}your role: ${meta.role}, last edit ${meta.last_touched_at?.slice(0, 16).replace("T", " ")} by ${meta.last_touched_by?.handle ?? "?"}`);
    } catch (e) {
      add("fail", `File ${f.name || f.key}`, e.message, "Check the key and that this account can open the file, with exports allowed.");
      continue;
    }
    for (const s of f.stale_copies) {
      try {
        const sm = (await client.meta(s)).file;
        const newer = Date.parse(sm.last_touched_at) > Date.parse(meta.last_touched_at);
        add(newer ? "warn" : "ok", `Stale copy ${s}`, newer ? `edited ${sm.last_touched_at.slice(0, 16).replace("T", " ")} by ${sm.last_touched_by?.handle ?? "?"}, after the watched file` : "older than the watched file", newer ? "Ask the designer which file is current; if it is this one, swap key and stale_copies." : "");
      } catch (e) {
        add("warn", `Stale copy ${s}`, e.message);
      }
    }
    try {
      const file = await client.file(f.key, { depth: 1 });
      const pages = (file.document?.children ?? []).map((p) => [p.name, p.id]).flat();
      const missing = f.pages.filter((p) => !pages.includes(p) && !pages.includes(p.replace(/-/g, ":")));
      add(missing.length ? "fail" : "ok", "Watched pages", missing.length ? `not found: ${missing.join(", ")}` : f.pages.join(", "), missing.length ? "Fix figma.files.pages; `figpipe probe <repo> --figma <link>` lists the pages." : "");
    } catch (e) {
      add("warn", "Watched pages", e.message);
    }
    // Sections pre-built from in-progress designs: still in Figma, and a baseline to diff against.
    if (f.watch.length) {
      try {
        const resp = await client.nodes(f.key, f.watch.map((w) => w.node), { depth: 1 });
        const gone = f.watch.filter((w) => !resp.nodes?.[w.node]?.document);
        const noBase = db ? f.watch.filter((w) => !db.get("SELECT baseline_id FROM watches WHERE project = ? AND file_key = ? AND node_id = ?", c.project.slug, f.key, w.node)?.baseline_id) : [];
        if (gone.length) add("fail", "Watched sections", `not in Figma: ${gone.map((w) => `${w.name} (${w.node})`).join(", ")}`, "The designer moved or deleted them, and no ready section carries their name (figpipe follows one that does on its own). Fix figma.files.watch.node (copy the section's link in Figma), then figpipe watch baseline <slug> <name>.");
        else add(noBase.length ? "info" : "ok", "Watched sections", `${f.watch.map((w) => w.name).join(", ")}${noBase.length ? `; no baseline yet for ${noBase.map((w) => w.name).join(", ")}` : ""}`, noBase.length ? "The next check records it, or run figpipe watch baseline <slug>." : "");
      } catch (e) {
        add("warn", "Watched sections", e.message);
      }
    }
  }

  // Repo and build mode.
  const repo = c.project.repo;
  const isGit = existsSync(repo) && tryGit(repo, ["rev-parse", "--git-dir"]) !== null;
  add(isGit ? "ok" : "fail", "Repo", repo, isGit ? "" : "Set project.repo to the project's git checkout.");
  if (isGit) {
    const hasBase = tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${c.git.base_branch}`]) !== null;
    add(hasBase ? "ok" : "fail", "Base branch", c.git.base_branch, hasBase ? "" : "Set git.base_branch to an existing local branch.");
    const missing = Object.entries(c.git.feature_branches).filter(([, b]) => tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) === null);
    if (missing.length) add("warn", "Feature branches", `missing: ${missing.map(([p, b]) => `${p} = ${b}`).join(", ")}`, "Those pages build on the base branch instead; remove or fix the entries.");
    const watchBranches = [...new Set(c.figma.files.flatMap((f) => f.watch.map((w) => w.branch)))];
    const noBranch = watchBranches.filter((b) => tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) === null);
    if (watchBranches.length) add(noBranch.length ? "fail" : "ok", "Watched sections' branches", noBranch.length ? `not local branches: ${noBranch.join(", ")}` : watchBranches.join(", "), noBranch.length ? "Set figma.files.watch.branch to the local branch that holds the pre-built page; its lane is blocked until then." : "");
    const hidden = tryGit(repo, ["check-ignore", "-q", `${c.git.extract_dir}/x`]) !== null;
    add(hidden ? "ok" : "info", "Extractions kept out of git", hidden ? `${c.git.extract_dir}/ is ignored` : `${c.git.extract_dir}/ is not ignored yet`, hidden ? "" : "figpipe adds it to .git/info/exclude on the first extraction.");
    const envMissing = c.project.autonomy === "build" ? ignoredEnvFiles(repo).filter((f) => !c.git.worktree_files.includes(f)) : [];
    if (envMissing.length) add("warn", "Worktree files", `${envMissing.join(", ")} not copied into new worktrees`, `Add them to git.worktree_files so a lane's dev server starts; keys matching git.worktree_env_omit stay out.`);
    // Pipeline worktrees with uncommitted edits block their lane.
    const wts = (tryGit(repo, ["worktree", "list", "--porcelain"]) ?? "").split("\n\n").map((b) => b.match(/^worktree (.+)$/m)?.[1]).filter(Boolean);
    const re = new RegExp(`^${fill(c.git.worktree_pattern, { repo: realish(repo) }).replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace("{page}", "(.+)")}$`);
    for (const w of wts.filter((p) => re.test(realish(p)))) {
      const dirty = tryGit(w, ["status", "--porcelain"]);
      if (dirty) add("warn", `Worktree ${basename(w)}`, "has uncommitted edits", "Commit or stash them; until then its lane is skipped.");
    }
  }
  if (c.project.autonomy === "build") {
    const pkg = readJson(join(repo, "package.json"));
    const scripts = pkg?.scripts ?? {};
    for (const g of c.stack.gates) {
      const m = g.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/);
      if (m && !["install", "exec", "dlx", "x"].includes(m[1]) && !(m[1] in scripts)) add("fail", `Check "${g}"`, `no "${m[1]}" script in package.json`, "Fix stack.gates.");
    }
    if (!c.stack.gates.length) add("warn", "Checks", "stack.gates is empty", "Builds are committed without lint or type checks; add the project's checks.");
    try {
      const port = await freePort(c.stack.port_base);
      add(port === c.stack.port_base ? "ok" : "info", "Dev port", port === c.stack.port_base ? `${port} is free` : `${c.stack.port_base} is busy; lanes start at ${port}`);
    } catch (e) {
      add("warn", "Dev port", e.message);
    }
    const pw = resolvePlaywright([repo]);
    add(pw ? "ok" : "warn", "Captures", pw ? "Playwright found" : "Playwright not found", pw ? "" : `Run \`${PLAYWRIGHT_INSTALL}\` once; without it reports have no screenshots.`);
  }

  // Runner, Claude, state.
  const claude = process.env.FIGPIPE_CLAUDE_BIN ?? (spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim() || null);
  add(claude ? "ok" : "fail", "Claude Code", claude ?? "not on PATH", claude ? "" : "Install Claude Code, or set FIGPIPE_CLAUDE_BIN.");
  // Which login runs the sessions. The background job has its own environment, so the last batch's
  // login is compared with the one this terminal has.
  if (claude) {
    const here = claudeAccount({ claudeBin: claude });
    const lastRun = db.get("SELECT id, account FROM batches WHERE project = ? AND account IS NOT NULL ORDER BY created_at DESC LIMIT 1", c.project.slug);
    if (here.known && !here.signed_in) add("fail", "Claude login", "not signed in", "Run `claude auth login`.");
    else if (here.known && lastRun && lastRun.account !== here.text) add("warn", "Claude login", `this terminal: ${here.text}. Batch ${lastRun.id} ran as: ${lastRun.account}`, "The background job picked up another login. Each batch folder's batch.log names the login it used.");
    else if (here.known) add("ok", "Claude login", `${here.text}${lastRun ? "; the last batch ran as the same" : ""}`);
  }
  const installed = existsSync(launchdPlist);
  const st = db.get("SELECT * FROM project_state WHERE project = ?", c.project.slug);
  const last = st?.last_tick_at ? Math.round((clock() - Date.parse(st.last_tick_at)) / 60000) : null;
  const sc = scheduleFor(db, c);
  // Overdue: how long a scheduled check has been waiting. A project on a schedule is quiet for hours
  // between checks, so "last check long ago" only means something once a check is due.
  const lastMs = st?.last_tick_at ? Date.parse(st.last_tick_at) : null;
  const slot = sc.mode === "interval" ? null : lastSlot(sc, clock());
  const overdue = sc.mode === "interval" ? (last !== null && last > c.batching.poll_minutes * 3 ? last : 0) : lastMs !== null && slot !== null && lastMs < slot ? Math.round((clock() - slot) / 60000) : 0;
  const late = overdue > 45;
  const lastWords = last === null ? "installed, no check yet" : `installed, last check ${last < 120 ? `${last} min` : `${Math.round(last / 60)} h`} ago`;
  if (!installed) add("info", "Background check", "not installed", "`figpipe launchd install` prints the commands; without it, run `figpipe tick` yourself.");
  else add(late ? "warn" : "ok", "Background check", late ? `${lastWords}; a scheduled check has waited ${overdue} min` : lastWords, late ? "Is the Mac asleep, or the job unloaded? `launchctl print gui/$(id -u)/" + launchdLabel() + "`" : "");
  add("info", "Schedule", `${describeSchedule(sc)}${dueState({ sc, last: lastMs, lastOk: st?.last_tick_ok !== 0, now: clock() }).due ? "; a check is due now" : ""}`);
  if (sc.mode === "follow") {
    // Follow mode re-derives its blocks on its own, so there is no drift to warn about; show what it uses.
    const v = followView(sc, clock());
    add("info", "Follow blocks", v.fallback ? `${v.blocks.map((b) => b.designer).join(", ")} ${v.timezone}, a fallback: ${v.reason}` : `${v.text}${v.derived_at ? `, derived ${new Date(v.derived_at).toISOString().slice(0, 10)} from ${v.events} events on ${v.active_days} days` : ""}`, v.fallback ? "The blocks are derived again once the designers have been active on 5 days in the last 30; until then these hours stand." : "");
  }
  // Catch-up lines in the log mean the Mac was asleep when a check was due. Said only when it keeps happening.
  const slept = sc.mode === "interval" ? [] : catchUps(logFile, c.project.slug, { now: clock(), days: 14 });
  if (slept.length >= 3) {
    const wake = sc.mode === "follow" ? wakeCommand(sc, clock()) : null;
    add("warn", "Mac asleep at check times", `${slept.length} checks in the last 14 days waited for the Mac to wake`, `Keep the Mac awake with an app like Amphetamine (${AMPHETAMINE}).${wake ? ` Alternative: \`${wake.command}\` wakes it for the check before your ${sc.follow.my_start} start; it needs your password and works best on power. figpipe never runs it.` : ""}`);
  }
  if (sc.mode !== "interval" && sc.mode !== "follow") {
    try {
      const keys = c.figma.files.flatMap((f) => [f.key, ...f.stale_copies]);
      const versions = [];
      const comments = [];
      for (const k of keys) {
        const a = await fetchActivity(client, k, { days: 30, now: clock() });
        versions.push(...a.versions);
        comments.push(...a.comments);
      }
      const me = await client.me();
      const { events } = toEvents({ versions, comments, me: { id: me.id, handle: me.handle }, days: 30, now: clock() });
      // Only the last 14 days count for drift: that is where a changed pattern shows.
      const recent = events.filter((e) => e.at >= clock() - 14 * 86400000);
      if (recent.length >= 10) {
        const l = lateness(recent, c);
        if (l.share >= 0.4) {
          // The schedule's zone stands when it fits the designers' hours (it is usually theirs); otherwise their zone is a guess from the activity.
          const guess = inferZone(recent);
          const fits = !guess || sc.timezone === guess.tz || guess.also_fits.includes(sc.timezone);
          const a = analyse({ events: recent, tz: fits ? sc.timezone : guess.tz, ref: clock() });
          const bl = a.combined.blocks.map((b) => (a.timezone === a.user_timezone ? `${b.own} ${a.timezone}` : `${b.own} ${a.timezone} (${b.yours} ${a.user_timezone})`)).join(", ");
          add("warn", "Schedule vs activity", `${Math.round(l.share * 100)}% of the last 14 days' edits and comments waited over 4 h for the next check (median ${l.median_h} h); designers mostly work ${bl}`, "`figpipe activity --project " + c.project.slug + "` shows when they work and suggests a schedule.");
        } else add("ok", "Schedule vs activity", `${Math.round((1 - l.share) * 100)}% of recent edits and comments get checked within 4 h (median wait ${l.median_h} h)`);
      }
    } catch (e) {
      add("info", "Schedule vs activity", `not checked: ${e.message}`);
    }
  }
 // Ownership: sections whose owner an answer, rule or tracker set, against who their comments tag.
  try {
    const table = ownershipTable({ db, config: c });
    for (const r of table.filter((x) => x.drift)) add("warn", `Owner of ${r.name}`, r.drift.why, `Check it: \`figpipe own "${r.name}" ${r.drift.owner === "mine" ? "others" : "mine"}\` if the comments are right.`);
    const asks = table.filter((x) => x.owner === "unknown" && c.scope.unknown === "ask");
    if (asks.length) add("warn", "Owner unknown", `${asks.length} ready section${asks.length === 1 ? "" : "s"} (${asks.slice(0, 3).map((x) => x.name).join(", ")}${asks.length > 3 ? ", ..." : ""}) wait for an answer`, "`figpipe own <name> mine|others` for each.");
  } catch (e) {
    add("info", "Ownership", `not checked: ${e.message}`);
  }
  if (st?.blocked) add("fail", "Project", `blocked: ${st.blocked}`, "Fix the cause; the next good check clears it.");
  if (st && st.last_tick_ok === 0) add("warn", "Last check", st.last_tick_summary ?? "failed");
  if (existsSync(paths().pause)) add("warn", "Paused", "no new batches start", "`figpipe resume`");
  const stuck = db.all("SELECT id, error FROM batches WHERE project = ? AND status IN ('stuck', 'failed') ORDER BY created_at DESC LIMIT 3", c.project.slug);
  for (const b of stuck) add("warn", `Batch ${b.id}`, `stopped: ${b.error ?? "unknown"}`, `\`figpipe run --batch ${b.id}\` retries it.`);
  for (const b of db.all("SELECT id, error FROM batches WHERE project = ? AND status = 'ready' AND wait_kind IS NOT NULL", c.project.slug))
    add("warn", `Batch ${b.id}`, `${b.error ?? "waiting for Claude"}; its items are kept`, `\`figpipe run --batch ${b.id}\` starts it now.`);
  add("info", "Figma MCP from the background", "not checked here", "The setup skill checks it with whoami; a batch without MCP still builds, and motion items wait.");
  return out;
}

export function formatDoctor(lines) {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL", info: "info" };
  return lines.map((l) => `${mark[l.status]}  ${l.check}${l.detail ? `: ${l.detail}` : ""}${l.fix ? `\n      ${l.fix}` : ""}`).join("\n");
}
