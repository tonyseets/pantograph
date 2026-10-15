// The CLI over real HTTP: a local server plays Figma with the recorded responses (including a
// 429 without Retry-After), and figpipe runs as a separate process the way launchd runs it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { tempHome, figmaState, comment, gitRepo, FIX, LIVE, PAGE } from "./helpers.mjs";

const home = tempHome();
const BIN = new URL("../../figpipe/figpipe.mjs", import.meta.url).pathname;
const state = figmaState();
state.meta.file.last_touched_at = "2026-01-01T00:00:00Z"; // the designer is quiet; only new events count
const seen = [];
let throttleComments = 1;
let longLimit = false;
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: u.pathname, token: req.headers["x-figma-token"] });
    const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    if (req.headers["x-figma-token"] !== "test-token") return res.writeHead(403).end('{"err":"Invalid token"}');
    const p = u.pathname;
    if (longLimit) return res.writeHead(429, { "retry-after": "7200" }).end("{}");
    if (p === `/v1/files/${LIVE}/meta`) return send(state.meta);
    if (p.endsWith("/meta")) return send(state.metaStale);
    if (p === `/v1/files/${LIVE}/comments`) {
      if (throttleComments-- > 0) return res.writeHead(429).end("{}");
      return send(state.comments);
    }
    if (p === `/v1/files/${LIVE}/versions`) return send(state.versions);
    if (p === `/v1/files/${LIVE}/nodes` && u.searchParams.get("ids") === PAGE) return send(state.page);
    if (p === `/v1/files/${LIVE}/nodes`) return send({ nodes: Object.fromEntries(u.searchParams.get("ids").split(",").map((id) => [id, state.nodes[id]?.nodes[id] ?? null])) });
    if (p === `/v1/files/${LIVE}`) return send({ document: { children: [{ id: PAGE, name: "Development Ready (Latest)", type: "CANVAS" }] } });
    if (p.startsWith(`/v1/images/${LIVE}`)) return send({ err: null, images: {} });
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), "figpipe-cli-"));
  const { repo } = gitRepo(root);
  mkdirSync(join(home, "projects"), { recursive: true });
  const toml = readFileSync(join(FIX, "tern.toml"), "utf8")
    .replace("__REPO__", repo)
    .replace('autonomy = "build"', 'autonomy = "notify"')
    .replace("backoff = { default_s = 30, max_s = 120 }", "backoff = { default_s = 1, max_s = 2 }");
  writeFileSync(join(home, "projects", "tern.toml"), toml);
});
after(() => server.close());

function fp(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, FIGPIPE_HOME: home, FIGMA_API_BASE: base, FIGPIPE_TEST_TOKEN: "test-token", FIGPIPE_NO_NOTIFY: "1", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

test("tick: baseline over HTTP, 429 backoff, GET only, no warnings printed", async () => {
  const r = await fp(["tick"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "", "the sqlite experimental warning is hidden");
  assert.ok(seen.every((s) => s.method === "GET"));
  assert.ok(seen.every((s) => s.token === "test-token"));
  assert.equal(seen.filter((s) => s.path.endsWith("/comments")).length, 2, "one 429, one retry");
  const log = readFileSync(join(home, "logs", "figpipe.log"), "utf8");
  assert.match(log, /rate limit on \/v1\/files\/.+\/comments, waiting 1s/);
});

test("a mention becomes a notify batch with a report", async () => {
  state.comments.comments.push(comment({ id: "9000000500", text: "@tony can you look at the hero?", at: new Date().toISOString(), node: "40000210:73932" }));
  let r = await fp(["tick", "--project", "tern"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tern: 1 waiting; designer active; quiet window ends in 20 min/);
  r = await fp(["run", "tern", "--now"]);
  assert.equal(r.code, 0, r.err + r.out);
  const report = r.out.trim().split("\n").pop();
  assert.ok(report.endsWith("report.html"), r.out);
  const html = readFileSync(report, "utf8");
  assert.match(html, /@tony can you look at the hero\?/);
  assert.match(html, /<span class="status tone-muted">.*?<span>FYI<\/span>/, "the mention shows as an FYI item");
  assert.ok(existsSync(join(home, "index.html")));
  r = await fp(["status"]);
  assert.match(r.out, /tern · notify · last check just now/);
  assert.match(r.out, /tern-\d{8}-\d{6} · nothing to review/, "a batch with nothing built does not hold up new work, and stays listed");
});

test("add queues a node from a Figma link and refuses stale copies and bare file links", async () => {
  let r = await fp(["add", `https://www.figma.com/design/${LIVE}/Tern?node-id=40000210-73780&t=abc`, "--note", "timeline states"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Queued for tern/);
  r = await fp(["add", `https://www.figma.com/design/${LIVE}/Tern?node-id=40000210-73780&t=abc`, "--note", "timeline states"]);
  assert.match(r.out, /Already queued/);
  r = await fp(["add", "https://www.figma.com/design/Tn7OldDemoKey8r3Vu5Ka1/Tern?node-id=1-2"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /stale copy/);
  r = await fp(["add", `https://www.figma.com/design/${LIVE}/Tern`]);
  assert.equal(r.code, 2);
  assert.match(r.out, /no node-id/);
});

test("guard hook: exit 2 with a reason on deny, 0 on allow, denies what it cannot parse", async () => {
  const st = JSON.parse((await fp(["status", "--json"])).out);
  const b = st.projects[0].batches[0];
  mkdirSync(join(b.dir, "session"), { recursive: true });
  writeFileSync(join(b.dir, "session", "guard.json"), JSON.stringify({ batch: b.id, project: "tern", writeRoots: [b.dir] }));
  let r = await fp(["guard", "--batch", b.id], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /git push is not allowed/);
  r = await fp(["guard", "--batch", b.id], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }) });
  assert.equal(r.code, 0, r.err);
  r = await fp(["guard", "--batch", b.id], { input: "not json" });
  assert.equal(r.code, 2);
  r = await fp(["guard", "--batch", "nope"], { input: "{}" });
  assert.equal(r.code, 2);
  r = await fp(["guard", "--batch", b.id], { input: JSON.stringify({ tool_name: "mcp__figma__get_design_context", tool_input: {} }) });
  assert.equal(r.code, 0);
  r = await fp(["budget", "mcp", "--batch", b.id]);
  assert.match(r.out, /yes: 119 left today/);
});

test("launchd install writes the plist under FIGPIPE_HOME and only prints the commands", async () => {
  const r = await fp(["launchd", "install"]);
  assert.equal(r.code, 0);
  const plist = r.out.match(/Plist written to (\S+)\./)[1];
  assert.ok(plist.startsWith(home));
  const xml = readFileSync(plist, "utf8");
  assert.match(xml, /<string>tick<\/string>/);
  assert.match(xml, /<key>StartInterval<\/key><integer>600<\/integer>/);
  assert.match(r.out, /launchctl bootstrap gui\/\$\(id -u\)/);
  const u = await fp(["launchd", "uninstall"]);
  assert.match(u.out, /launchctl bootout gui\/\$\(id -u\)\/com\.[^.]+\.figpipe/);
});

test("pause stops new batches; config check names bad fields", async () => {
  await fp(["pause"]);
  let r = await fp(["status"]);
  assert.match(r.out, /PAUSED/);
  await fp(["resume"]);
  r = await fp(["status"]);
  assert.doesNotMatch(r.out, /PAUSED/);
  const bad = join(home, "bad.toml");
  writeFileSync(bad, readFileSync(join(home, "projects", "tern.toml"), "utf8").replace('notify = "none"', 'notify = "slack"'));
  r = await fp(["config", "check", bad]);
  assert.equal(r.code, 1);
  assert.match(r.err, /report\.notify: "slack" is not one of/);
});

test("a long Figma rate limit pauses checks until then, and status says so", async () => {
  longLimit = true;
  let r = await fp(["tick", "--project", "tern"]);
  assert.match(r.out, /it asks to wait 2 h/);
  r = await fp(["status"]);
  assert.match(r.out, /Figma rate limit: no checks until/);
  const before = seen.length;
  r = await fp(["tick", "--project", "tern"]);
  assert.match(r.out, /Figma asked to wait; next check after/);
  assert.equal(seen.length, before, "no requests while Figma asked to wait");
  longLimit = false;
  const { openDb } = await import("../../figpipe/lib/db.mjs");
  const db = openDb(join(home, "state.db"));
  db.run("UPDATE project_state SET blocked_until = NULL");
  db.close();
});

test("help separates your commands from the ones batch sessions use", async () => {
  const r = await fp(["help"]);
  assert.ok(r.out.indexOf("You:") < r.out.indexOf("Used by batch sessions:"));
  assert.ok(r.out.indexOf("figpipe record") > r.out.indexOf("Used by batch sessions:"));
});

test("the guard fails closed when it cannot load its batch's project", async () => {
  const { openDb } = await import("../../figpipe/lib/db.mjs");
  const db = openDb(join(home, "state.db"));
  const dir = join(home, "batches", "ghost", "ghost-1");
  mkdirSync(join(dir, "session"), { recursive: true });
  writeFileSync(join(dir, "session", "guard.json"), JSON.stringify({ batch: "ghost-1", project: "ghost", writeRoots: [dir] }));
  db.run("INSERT INTO batches (id, project, status, dir, created_at) VALUES ('ghost-1', 'ghost', 'running', ?, '2026-10-02T16:00:00Z')", dir);
  db.close();
  const r = await fp(["guard", "--batch", "ghost-1"], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }) });
  assert.equal(r.code, 2, "a guard that errors denies");
  assert.match(r.err, /denied/);
});
