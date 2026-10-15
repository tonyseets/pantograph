// Per-project config: ~/.figpipe/projects/<slug>.toml, validated against SCHEMA.
// A config that fails is refused with every failing field named. Unknown keys fail too,
// so a typo never turns into a silently ignored setting. Secrets are references, never values.
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { parseToml } from "./toml.mjs";
import { paths, expandHome } from "./paths.mjs";
import { WEEKDAYS, HHMM, validZone, toMinutes } from "./schedule.mjs";
import { slugify } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";

const str = (def, extra = {}) => ({ type: "string", default: def, ...extra });
const int = (def, extra = {}) => ({ type: "integer", default: def, ...extra });
const num = (def, extra = {}) => ({ type: "number", default: def, ...extra });
const bool = (def) => ({ type: "boolean", default: def });
const list = (items, def = []) => ({ type: "array", items, default: def });
const obj = (fields, extra = {}) => ({ type: "object", fields, ...extra });
const map = (values, def = {}) => ({ type: "map", values, default: def });
const oneOf = (values, def) => ({ type: "string", enum: values, default: def });

const NODE_OR_NAME = "a page name or a node id like 3618:15687";
const NODE_ID_RE = /^\d+[:-]\d+$/;
const MODEL = {
  type: "string",
  check: (v) => {
    if (/haiku|fable/i.test(v)) return "Haiku and Fable are not used; pick opus or sonnet";
    const [m, effort] = v.split(":");
    if (!/^(opus|sonnet|claude-(opus|sonnet)-[\w.-]+)$/.test(m)) return `unknown model "${m}"; use opus or sonnet, optionally with :effort`;
    if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) return `unknown effort "${effort}"`;
    return null;
  },
};

export const SCHEMA = obj({
  schema: int(1, { enum: [1] }),
  project: obj(
    {
      slug: { type: "string", required: true, pattern: /^[a-z0-9][a-z0-9-]*$/, hint: "lowercase letters, digits and dashes" },
      name: str(""),
      repo: { type: "string", required: true },
      autonomy: oneOf(["notify", "notes", "build"], "build"),
      notes: str(""),
      max_unreviewed_batches: int(1, { min: 0 }),
    },
    { required: true },
  ),
  figma: obj(
    {
      pat_ref: str("file:~/.config/figma/pat", { pattern: /^(file|keychain|op|env):.+/, hint: "file:<path>, keychain:<service>, op:<ref> or env:<VAR>" }),
      me: obj({ user_id: str(""), handle: str(""), names: list({ type: "string" }) }),
      rest_tier: oneOf(["high", "low", ""], ""),
      mcp: obj({ daily_cap: int(200, { min: 0 }), pipeline_share: int(120, { min: 0 }), reserve_for_motion: int(20, { min: 0 }) }),
      backoff: obj({ default_s: num(30, { min: 1 }), max_s: num(120, { min: 1 }) }),
      files: list(
        obj({
          key: { type: "string", required: true, pattern: /^[A-Za-z0-9]{10,}$/ },
          name: str(""),
          verdict: oneOf(["live", "unknown"], "live"),
          stale_copies: list({ type: "string", pattern: /^[A-Za-z0-9]{10,}$/ }),
          pages: list({ type: "string", hint: NODE_OR_NAME }),
          ready_depth: int(2, { min: 1, max: 6 }),
          source: oneOf(["poll", "webhook"], "poll"),
          breakpoints: map({ type: "integer", min: 200 }, { desktop: 1440, tablet: 1024, mobile: 390 }),
          canonical_copy: str("desktop"),
          // Pages that hold the file's component sets. Empty: pages named like "Components",
          // "Library" or "Design system".
          component_pages: list({ type: "string", hint: NODE_OR_NAME }),
          // Sections not marked ready that the user has pre-built from in-progress designs. figpipe
          // keeps those builds in step: a design change, a comment from someone else or a ready mark
          // starts a batch that updates the build on figma/<lane>, started from `branch`. Read by node
          // id, so they can sit on any page (`page` is where to look when the id goes missing).
          watch: list(
            obj({
              node: { type: "string", required: true, pattern: NODE_ID_RE, hint: "a node id like 7431:81099" },
              name: { type: "string", required: true, check: (v) => (v.trim() ? null : "empty name") },
              branch: { type: "string", required: true, pattern: /^(?!-)[^\s~^:?*[\\]+$/, hint: "a local branch name such as feat/plans-r2" },
              route: str("", { pattern: /^$|^\//, hint: "a path starting with /" }),
              lane: str("", { pattern: /^$|^[a-z0-9][a-z0-9-]*$/, hint: "lowercase letters, digits and dashes" }),
              page: str(""),
              built: bool(true),
              notes: str(""),
            }),
          ),
        }),
      ),
    },
    { required: true },
  ),
  // Who owns each ready section: mine, others or unknown. Patterns are globs, case-insensitive,
  // matched against a ready node's name and its ancestors' names.
  // include = sections that are yours; exclude = sections that are someone else's (wins over include);
  // others = people whose @mentions mark a section or thread as theirs; assign = section pattern ->
  // implementer, as read from a tracker; tracker = where that mapping came from (a note, never fetched).
  // unknown = "ask": a section with no signal is held and shown as "Is this yours?"; "mine" builds it.
  scope: obj({
    include: list({ type: "string", check: (v) => (v.trim() ? null : "empty pattern") }),
    exclude: list({ type: "string", check: (v) => (v.trim() ? null : "empty pattern") }),
    others: list({ type: "string", check: (v) => (v.trim() ? null : "empty name") }),
    assign: map({ type: "string", check: (v) => (v.trim() ? null : "empty name") }),
    tracker: str(""),
    unknown: oneOf(["mine", "ask"], "mine"),
  }),
  triggers: obj({
    ready_for_dev: bool(true),
    mentions: bool(true),
    my_threads: bool(true),
    named_versions: oneOf(["ignore", "close_batch", "trigger"], "close_batch"),
    changed_after_build: bool(true),
    deep_check_minutes: int(60, { min: 10 }),
  }),
  batching: obj({
    poll_minutes: int(10, { min: 1 }),
    quiet_minutes: int(20, { min: 0 }),
    max_wait_minutes: int(120, { min: 1 }),
    max_items: int(10, { min: 1 }),
    min_gap_minutes: int(0, { min: 0 }),
    active_hours: str("", { pattern: /^$|^\d{2}:\d{2}-\d{2}:\d{2}$/, hint: "HH:MM-HH:MM or empty" }),
  }),
  // When checks run. No mode, times or windows: every batching.poll_minutes, all day. mode = "follow"
  // derives the designers' working blocks from their recent activity (every, my_day_starts,
  // my_timezone and refresh_days only apply there; timezone then pins the designers' zone).
  schedule: obj({
    mode: oneOf(["", "follow", "times", "windows"], ""),
    every: int(60, { min: 5 }),
    my_day_starts: str("08:00", { pattern: HHMM, hint: "HH:MM, 24-hour" }),
    my_timezone: str("", { check: (v) => (v && !validZone(v) ? `unknown time zone "${v}"; use an IANA name such as America/Los_Angeles` : null) }),
    refresh_days: int(7, { min: 1, max: 90 }),
    timezone: str("", { check: (v) => (v && !validZone(v) ? `unknown time zone "${v}"; use an IANA name such as Europe/Berlin` : null) }),
    days: list({ type: "string", enum: WEEKDAYS }, [...WEEKDAYS]),
    times: list({ type: "string", pattern: HHMM, hint: "HH:MM, 24-hour" }),
    windows: list(
      obj({
        start: { type: "string", required: true, pattern: HHMM, hint: "HH:MM, 24-hour" },
        end: { type: "string", required: true, pattern: HHMM, hint: "HH:MM, 24-hour" },
        every: { type: "integer", required: true, min: 5 },
      }),
    ),
  }),
  receiver: obj({
    enabled: bool(false),
    worker_url: str(""),
    token_ref: str(""),
    webhook_ids: list({ type: "string" }),
  }),
  git: obj({
    base_branch: str("main"),
    branch_pattern: str("figma/{page}", { pattern: /\{page\}/, hint: "must contain {page}" }),
    worktree_pattern: str("{repo}-fp-{page}", { pattern: /\{page\}/, hint: "must contain {page}" }),
    stack_on_feature_branch: bool(true),
    feature_branches: map({ type: "string" }),
    extract_dir: str(".figma"),
    // Ignored files a fresh worktree needs to run (".env"), copied in from the repo. In dotenv
    // files, keys matching worktree_env_omit are left out, so write tokens never reach a session.
    worktree_files: list({ type: "string", pattern: /^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/, hint: "a path inside the repo, such as .env" }),
    worktree_env_omit: list({ type: "string" }, ["*SECRET*", "*ACCESS_TOKEN*", "*PRIVATE*", "*PASSWORD*", "*MANAGEMENT*"]),
    figma_dir_hidden_by: oneOf(["info/exclude", "tracked"], "info/exclude"),
  }),
  stack: obj({
    framework: str(""),
    package_manager: str(""),
    dev: str("", { hint: "dev server command with {port}" }),
    port_base: int(3011, { min: 1024, max: 65000 }),
    preview_route: str("/"),
    preview_pages: map({ type: "string" }),
    gates: list({ type: "string" }),
    tokens: str("design value wins; log deviations"),
    cms: obj({ kind: str(""), unattended: oneOf(["none", "drafts"], "none") }),
    allowed_bash: list({ type: "string" }),
    // Dependency install figpipe runs for a lane worktree before the session (sessions have no
    // registry access). Empty: the package manager's frozen install.
    install: str(""),
    // Hosts the dev server may read from inside the session sandbox, besides localhost, Figma's API
    // and the CMS's read API (stack.cms.kind). Reads only: CMS write hosts are never added.
    allowed_domains: list({ type: "string", pattern: /^(\*\.)?[a-z0-9.-]+$/i, hint: "a host name such as cdn.example.com or *.example.com" }),
  }),
  review: obj({
    widths: list({ type: "integer", min: 200 }, [1440, 1024, 390]),
    extra_widths: list({ type: "integer", min: 200 }),
    regression_routes: list({ type: "string" }),
    shared_paths: list({ type: "string" }),
    lenses: list({ type: "string", enum: ["parity", "responsive", "a11y", "regressions"] }, ["parity", "responsive", "a11y", "regressions"]),
    max_fix_rounds: int(1, { min: 0, max: 3 }),
  }),
  extract: obj({
    render_scale: num(2, { min: 1, max: 4 }),
    max_renders_per_item: int(24, { min: 0 }),
    // The component sets behind each node: every variant, the states the node does not show.
    component_sets: bool(true),
    component_render_scale: num(3, { min: 1, max: 4 }),
    max_component_sets: int(30, { min: 0 }),
  }),
  models: obj({
    coordinator: { ...MODEL, default: "opus:medium" },
    coordinator_when_ahead_of_pace: { ...MODEL, default: "sonnet:medium" },
    build: { ...MODEL, default: "sonnet:medium" },
    build_hard: { ...MODEL, default: "sonnet:high" },
    review: { ...MODEL, default: "opus:medium" },
  }),
  limits: obj({
    usd_per_batch: num(15, { min: 0 }),
    usd_per_day: num(45, { min: 0 }),
    batches_per_day: int(4, { min: 0 }),
    max_minutes: int(90, { min: 5 }),
    pace_with_usage_meter: bool(true),
  }),
  report: obj({
    notify: oneOf(["terminal-notifier", "osascript", "none"], "terminal-notifier"),
    publish: oneOf(["never", "artifact"], "never"),
  }),
});

const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v);

// Returns { value, errors }. value has every default filled in.
export function validate(spec, v, path = "", errors = []) {
  const here = path || "(root)";
  if (v === undefined) {
    if (spec.required) errors.push(`${here}: required`);
    if (spec.type === "object") v = {};
    else return { value: structuredClone(spec.default), errors };
  }
  const t = typeOf(v);
  const want = spec.type;
  const okType = want === t || (want === "number" && t === "integer") || (want === "map" && t === "object");
  if (!okType) {
    errors.push(`${here}: expected ${want === "map" ? "a table" : want}, got ${t}`);
    return { value: structuredClone(spec.default), errors };
  }
  if (want === "object") {
    const out = {};
    for (const k of Object.keys(v)) if (!(k in spec.fields)) errors.push(`${path ? path + "." : ""}${k}: unknown setting`);
    for (const [k, f] of Object.entries(spec.fields)) out[k] = validate(f, v[k], path ? `${path}.${k}` : k, errors).value;
    return { value: out, errors };
  }
  if (want === "map") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = validate(spec.values, x, `${path}.${k}`, errors).value;
    return { value: out, errors };
  }
  if (want === "array") {
    return { value: v.map((x, idx) => validate(spec.items, x, `${path}[${idx}]`, errors).value), errors };
  }
  if (spec.enum && !spec.enum.includes(v)) errors.push(`${here}: "${v}" is not one of ${spec.enum.map((x) => JSON.stringify(x)).join(", ")}`);
  if (spec.pattern && typeof v === "string" && !spec.pattern.test(v)) errors.push(`${here}: "${v}" is not valid${spec.hint ? ` (${spec.hint})` : ""}`);
  if (spec.min !== undefined && v < spec.min) errors.push(`${here}: ${v} is below ${spec.min}`);
  if (spec.max !== undefined && v > spec.max) errors.push(`${here}: ${v} is above ${spec.max}`);
  if (spec.check) {
    const m = spec.check(v);
    if (m) errors.push(`${here}: ${m}`);
  }
  return { value: v, errors };
}

export class ConfigError extends Error {
  constructor(file, errors) {
    super(`${file} is not valid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.file = file;
    this.errors = errors;
  }
}

// Cross-field rules the per-field schema can't express.
function crossCheck(c, errors) {
  if (!c.figma.files.length) errors.push("figma.files: watch at least one file");
  c.figma.files.forEach((f, i) => {
    if (!f.pages.length && !f.watch.length) errors.push(`figma.files[${i}].pages: name at least one page to watch`);
    if (f.stale_copies.includes(f.key)) errors.push(`figma.files[${i}].stale_copies: lists the live key itself`);
  });
  // Watched sections: one node once, and sections sharing a lane share its branch.
  const seen = new Map();
  const lanes = new Map();
  c.figma.files.forEach((f, i) =>
    f.watch.forEach((w, k) => {
      const at = `figma.files[${i}].watch[${k}]`;
      const node = w.node.replace(/-/g, ":");
      if (seen.has(node)) errors.push(`${at}.node: ${node} is already watched as "${seen.get(node)}"`);
      seen.set(node, w.name);
      const lane = watchLaneName(w);
      const other = lanes.get(lane);
      if (other && other.branch !== w.branch) errors.push(`${at}.branch: lane "${lane}" is built from ${other.branch} for "${other.name}"; sections in one lane share a branch`);
      if (!other) lanes.set(lane, w);
    }),
  );
  if (c.figma.mcp.pipeline_share > c.figma.mcp.daily_cap) errors.push("figma.mcp.pipeline_share: larger than daily_cap");
  if (c.figma.mcp.reserve_for_motion > c.figma.mcp.pipeline_share) errors.push("figma.mcp.reserve_for_motion: larger than pipeline_share");
  if (c.figma.backoff.default_s > c.figma.backoff.max_s) errors.push("figma.backoff.default_s: larger than max_s");
  if (!c.schedule.days.length) errors.push("schedule.days: name at least one day");
  if (new Set(c.schedule.days).size !== c.schedule.days.length) errors.push("schedule.days: lists a day twice");
  if (c.schedule.times.length && c.schedule.windows.length) errors.push("schedule: use times or windows, not both");
  if (new Set(c.schedule.times).size !== c.schedule.times.length) errors.push("schedule.times: lists a time twice");
  if (c.schedule.mode === "follow" && (c.schedule.times.length || c.schedule.windows.length)) errors.push('schedule: mode = "follow" takes its blocks from activity; remove times and windows, or use another mode');
  if (c.schedule.mode === "times" && !c.schedule.times.length) errors.push('schedule.times: mode = "times" needs at least one time');
  if (c.schedule.mode === "times" && c.schedule.windows.length) errors.push('schedule.windows: mode = "times" does not use windows');
  if (c.schedule.mode === "windows" && c.schedule.times.length) errors.push('schedule.times: mode = "windows" does not use times');
  if (c.schedule.mode === "windows" && !c.schedule.windows.length) errors.push('schedule.windows: mode = "windows" needs at least one window');
  c.schedule.windows.forEach((w, i) => {
    if (HHMM.test(w.start) && HHMM.test(w.end) && toMinutes(w.end) < toMinutes(w.start)) errors.push(`schedule.windows[${i}]: end ${w.end} is before start ${w.start}; a window cannot cross midnight, split it in two`);
  });
  if (c.receiver.enabled) errors.push("receiver.enabled: the webhook receiver is not part of figpipe yet; keep it false");
  if (c.project.autonomy === "build" && !c.stack.dev) errors.push("stack.dev: build mode needs the dev server command (with {port})");
  if (c.stack.dev && !c.stack.dev.includes("{port}")) errors.push("stack.dev: must contain {port}");
  if (c.project.autonomy === "build" && !c.review.widths.length) errors.push("review.widths: build mode needs at least one width");
  if (!c.figma.me.handle && !c.figma.me.user_id && (c.triggers.mentions || c.triggers.my_threads))
    errors.push("figma.me: set handle or user_id so mentions can be matched");
  if (/\bpush\b/.test(c.stack.allowed_bash.join(" "))) errors.push("stack.allowed_bash: may not allow any push command");
  if (/\bstash\b/.test(c.stack.allowed_bash.join(" "))) errors.push("stack.allowed_bash: may not allow git stash (the stash list is shared with your own checkout)");
  if (c.limits.usd_per_day && c.limits.usd_per_day < c.limits.usd_per_batch) errors.push("limits.usd_per_day: smaller than usd_per_batch");
}

export function parseConfig(text, file = "config") {
  let raw;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new ConfigError(file, [e.message]);
  }
  const { value, errors } = validate(SCHEMA, raw);
  if (!errors.length) crossCheck(value, errors);
  if (errors.length) throw new ConfigError(file, errors);
  for (const f of value.figma.files) for (const w of f.watch) w.node = w.node.replace(/-/g, ":");
  value.project.repo = expandHome(value.project.repo);
  value.project.notes = expandHome(value.project.notes);
  value._file = file;
  return value;
}

export function loadProject(slug) {
  const file = join(paths().projects, `${slug}.toml`);
  if (!existsSync(file)) throw new Error(`no project "${slug}" (expected ${file})`);
  const c = parseConfig(readFileSync(file, "utf8"), file);
  if (c.project.slug !== slug) throw new ConfigError(file, [`project.slug: "${c.project.slug}" does not match the file name "${slug}"`]);
  return c;
}

// Every project config. Invalid ones are returned as { slug, error } so status can show them.
export function loadAllProjects() {
  const dir = paths().projects;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".toml"))
    .sort()
    .map((f) => {
      const slug = basename(f, ".toml");
      try {
        return { slug, config: loadProject(slug) };
      } catch (e) {
        return { slug, error: e.message };
      }
    });
}

// Point a [[figma.files.watch]] entry at another node, in the file's own text: only that entry's
// node (and page) change, with a comment above saying what moved, so the user's comments and
// layout stay. The new text must parse before it replaces the file. false: no such entry.
export function rewriteWatchNode(file, from, to, { page = null, note = null } = {}) {
  const lines = readFileSync(file, "utf8").split("\n");
  const NODE = /(\bnode\s*=\s*")([^"]+)(")/;
  const i = lines.findIndex((l) => !/^\s*#/.test(l) && (l.match(NODE)?.[2] ?? "").replace(/-/g, ":") === from);
  if (i < 0) return false;
  lines[i] = lines[i].replace(NODE, (m, a, id, c) => `${a}${to}${c}`);
  if (page) {
    // The entry runs to the next table header.
    let end = i + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    let start = i;
    while (start > 0 && !/^\s*\[/.test(lines[start])) start--;
    for (let k = start; k < end; k++) if (/^\s*page\s*=/.test(lines[k])) lines[k] = lines[k].replace(/=\s*"(?:[^"\\]|\\.)*"/, `= ${JSON.stringify(page)}`);
  }
  if (note) lines.splice(i, 0, `${lines[i].match(/^\s*/)[0]}# ${note}`);
  const text = lines.join("\n");
  parseConfig(text, file);
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return true;
}

export const parseModel = (s) => {
  const [model, effort] = s.split(":");
  return { model, effort: effort ?? "medium" };
};

// The name reports and notifications use: project.name, else the slug in words ("tern-website" -> "Tern website").
export const displayName = (config) => {
  if (config?.project?.name) return config.project.name;
  const s = String(config?.project?.slug ?? config ?? "").replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// The lane a watched section builds in: its `lane`, else its name as a slug ("Stories" -> "stories").
export const watchLaneName = (w) => w.lane || slugify(w.name);

export const fill = (pattern, values) => pattern.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
