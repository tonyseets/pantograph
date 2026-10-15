// Test helpers: a temp FIGPIPE_HOME, the Tern config, and a fake Figma client that serves the
// recorded Figma responses (scrubbed, renamed to a made-up site, Tern), which tests then mutate to simulate designer activity.
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

export const FIX = new URL("./fixtures/tern/", import.meta.url).pathname;
export const LIVE = "Tn7LiveDemoKey0q2Wx4Yz";
export const STALE = "Tn7OldDemoKey8r3Vu5Ka1";
export const PAGE = "3618:15687";
export const SMALL = "40000210:73780";
export const load = (f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));

export function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "figpipe-test-"));
  process.env.FIGPIPE_HOME = home;
  process.env.FIGPIPE_NO_NOTIFY = "1";
  process.env.FIGPIPE_NO_CAFFEINATE = "1";
  return home;
}

export async function ternConfig(repo = "/tmp/tern-repo", patch = (t) => t) {
  const { parseConfig } = await import("../../figpipe/lib/config.mjs");
  const text = patch(readFileSync(join(FIX, "tern.toml"), "utf8").replace("__REPO__", repo));
  return parseConfig(text, "tern.toml");
}

// state holds the current "Figma"; tests change it between ticks.
export function figmaState() {
  return {
    meta: load("meta.json"),
    metaStale: load("meta-stale.json"),
    page: load("nodes-page-d2.json"),
    comments: load("comments.json"),
    versions: load("versions.json"),
    nodes: { [SMALL]: load("nodes-small.json") },
    calls: [],
  };
}

export function fakeClient(state) {
  const log = (c) => state.calls.push(c);
  return {
    info: {},
    meta: async (k) => (log(`meta ${k}`), structuredClone(k === LIVE ? state.meta : state.metaStale)),
    file: async (k) => {
      log(`file ${k}`);
      const page = state.page.nodes[PAGE].document;
      return { document: { children: [{ id: page.id, name: page.name, type: "CANVAS" }, { id: "3406:6152", name: "Design In Progress", type: "CANVAS" }] } };
    },
    nodes: async (k, ids, opts = {}) => {
      log(`nodes ${ids.join(",")} depth=${opts.depth ?? "full"}`);
      if (ids.length === 1 && ids[0] === PAGE) return structuredClone(state.page);
      const out = { nodes: {} };
      for (const id of ids) out.nodes[id] = state.nodes[id] ? structuredClone(state.nodes[id].nodes[id]) : null;
      return out;
    },
    comments: async () => (log("comments"), structuredClone(state.comments)),
    versions: async () => (log("versions"), structuredClone(state.versions)),
    images: async (k, ids) => (log(`images ${ids.join(",")}`), { err: null, images: Object.fromEntries(ids.map((i) => [i, `https://example.invalid/render/${i}`])) }),
  };
}

// The components fixtures: a Contact page frame, four of the component sets behind it (Checkbox,
// Input field, Input dropdown, Dropdown list item), the file's page list and the page that holds
// its component sets at depth 2.
export const CONTACT = "40000699:118727";
export const COMPONENTS_PAGE = "4310:41602";
export const SETS = { checkbox: "7300:89958", field: "4918:40966", dropdown: "4923:13131", listItem: "7312:90025" };
export function componentsState() {
  return { contact: load("nodes-contact.json"), sets: load("nodes-contact-sets.json"), pages: load("file-pages.json"), page: load("nodes-components-page-d2.json"), version: null, libraries: {}, calls: [] };
}
// Serves those recordings. Sets that were not recorded come back as Figma returns a node it
// cannot find (null). state.libraries maps a library set key to { file_key, node_id, nodes }.
export function componentsClient(state) {
  const log = (c) => state.calls.push(c);
  const libFile = (k) => Object.values(state.libraries).find((l) => l.file_key === k);
  return {
    info: {},
    file: async (k) => (log(`file ${k}`), structuredClone(state.pages)),
    nodes: async (k, ids, opts = {}) => {
      log(`nodes ${ids.join(",")} depth=${opts.depth ?? "full"}`);
      const from = k === LIVE ? [state.contact.nodes, state.sets.nodes, state.page.nodes] : [libFile(k)?.nodes ?? {}];
      const out = { name: state.contact.name, lastModified: state.contact.lastModified, version: state.version ?? state.contact.version, nodes: {} };
      for (const id of ids) out.nodes[id] = structuredClone(from.map((m) => m[id]).find(Boolean) ?? null);
      return out;
    },
    images: async (k, ids, opts = {}) => (log(`images ${ids.join(",")} scale=${opts.scale}`), { err: null, images: Object.fromEntries(ids.map((i) => [i, `https://example.invalid/render/${i}`])) }),
    componentSet: async (key) => {
      log(`component_set ${key}`);
      const l = state.libraries[key];
      if (!l) throw Object.assign(new Error("Figma answered 404"), { status: 404, kind: "http" });
      return { meta: { key, file_key: l.file_key, node_id: l.node_id } };
    },
  };
}

// A 1x1 PNG, for fake image downloads.
export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
export const fakeFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => PNG });

export const pageDoc = (state) => state.page.nodes[PAGE].document;
export function findIn(n, id) {
  if (n.id === id) return n;
  for (const c of n.children ?? []) {
    const r = findIn(c, id);
    if (r) return r;
  }
  return null;
}

export function comment({ id, parent = "", by = "Mara", byId = "1000000000000000101", text, node = "40000210:73932", at, resolved = null }) {
  return {
    id,
    file_key: LIVE,
    parent_id: parent,
    user: { handle: by, img_url: "https://example.invalid/avatar.png", id: byId },
    created_at: at,
    resolved_at: resolved,
    message: text,
    reactions: [],
    client_meta: parent ? null : { node_id: node, node_offset: { x: 1, y: 1 }, stable_path: [node] },
    order_id: parent ? null : "99",
  };
}

// A throwaway git repo with a bare "remote", a main branch and an optional feature branch.
export function gitRepo(root, { feature } = {}) {
  const bare = join(root, "remote.git");
  const repo = join(root, "site");
  const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.invalid");
  g(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "index.html"), "<h1>Hi</h1>\n");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  g(repo, "remote", "add", "origin", bare);
  g(repo, "push", "-q", "origin", "main");
  if (feature) {
    g(repo, "branch", feature);
  }
  return { repo, bare, g };
}

export const clockAt = (iso) => {
  let t = Date.parse(iso);
  const c = () => t;
  c.advance = (min) => (t += min * 60000);
  c.set = (s) => (t = Date.parse(s));
  return c;
};
