// Moved sections and waiting batches through the command line, over real HTTP: a check follows a
// watched section to the ready page and re-points the config file, status says so, one command
// records a baseline for every section that is the user's, and a batch that waits for Claude shows
// plainly and can be closed with a note.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { tempHome, figmaState, gitRepo, load, pageDoc, findIn, FIX, LIVE, PAGE } from "./helpers.mjs";
import { openDb } from "../../figpipe/lib/db.mjs";

const home = tempHome();
const BIN = new URL("../../figpipe/figpipe.mjs", import.meta.url).pathname;
const ABOUT = "7431:81091";
const TECH = "7431:81073";
const MOVED = "907431:81091";
const state = figmaState();
const watch = load("nodes-watch.json");
state.nodes[ABOUT] = { nodes: { [ABOUT]: watch.nodes[ABOUT] } };
state.nodes[TECH] = { nodes: { [TECH]: watch.nodes[TECH] } };
state.meta.file.last_touched_at = "2026-01-01T00:00:00Z";
const cfg = join(home, "projects", "tern.toml");
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    const p = u.pathname;
    if (req.method !== "GET") return res.writeHead(405).end("{}");
    if (p === `/v1/files/${LIVE}/meta`) return send(state.meta);
    if (p.endsWith("/meta")) return send(state.metaStale);
    if (p === `/v1/files/${LIVE}/comments`) return send(state.comments);
    if (p === `/v1/files/${LIVE}/versions`) return send(state.versions);
    if (p === `/v1/files/${LIVE}/nodes` && u.searchParams.get("ids") === PAGE) return send(state.page);
    if (p === `/v1/files/${LIVE}/nodes`)
      return send({ nodes: Object.fromEntries(u.searchParams.get("ids").split(",").map((id) => [id, state.nodes[id]?.nodes[id] ?? (findIn(pageDoc(state), id) ? { document: findIn(pageDoc(state), id) } : null)])) });
    if (p === `/v1/files/${LIVE}`) return send({ document: { children: [{ id: PAGE, name: "Development Ready (Latest)", type: "CANVAS" }, { id: "3406:6152", name: "Design In Progress", type: "CANVAS" }] } });
    if (p.startsWith(`/v1/images/${LIVE}`)) return send({ err: null, images: {} });
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { repo } = gitRepo(mkdtempSync(join(tmpdir(), "figpipe-moves-cli-")));
  mkdirSync(join(home, "projects"), { recursive: true });
  const toml = readFileSync(join(FIX, "tern.toml"), "utf8")
    .replace("__REPO__", repo)
    .replace('canonical_copy = "desktop"\n', `canonical_copy = "desktop"\n\n# Pre-built on feat/plans-r2.\n[[figma.files.watch]]\nnode = "${ABOUT}"\nname = "About"\nbranch = "main"\nroute = "/en-gb/preview/about"\npage = "Design In Progress"\n\n[[figma.files.watch]]\nnode = "${TECH}"\nname = "Technology"\nbranch = "main"\npage = "Design In Progress"\nbuilt = false\n`)
    .concat('\n[scope]\ninclude = ["Main*"]\nexclude = ["*Funnel*"]\nunknown = "ask"\n');
  writeFileSync(cfg, toml);
});
after(() => server.close());

function fp(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, FIGPIPE_HOME: home, FIGMA_API_BASE: base, FIGPIPE_TEST_TOKEN: "test-token", FIGPIPE_NO_NOTIFY: "1", ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("a check follows a moved section, re-points the config file and says so; a dry run only says what it would do", async () => {
  await fp(["pause"]); // checks keep recording; no batch starts in this test
  let r = await fp(["tick", "--project", "tern", "--backfill"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /baseline recorded for watched section "About"/);
  const before = readFileSync(cfg, "utf8");

  // The designer moves About to the ready page as "About_EN": new node ids, same design.
  const moved = structuredClone(state.nodes[ABOUT].nodes[ABOUT].document);
  const walk = (n) => {
    n.id = n.id.replace(/(\d+):(\d+)/g, (m, a, b) => `${900000 + Number(a)}:${b}`);
    for (const c of n.children ?? []) walk(c);
  };
  walk(moved);
  assert.equal(moved.id, MOVED);
  Object.assign(moved, { name: "About_EN", devStatus: { type: "READY_FOR_DEV", description: "" } });
  state.nodes[MOVED] = { nodes: { [MOVED]: { document: moved } } };
  pageDoc(state).children.push({ id: MOVED, name: "About_EN", type: "SECTION", devStatus: moved.devStatus, children: [] });
  delete state.nodes[ABOUT];
  state.meta.file.last_touched_at = "2026-01-02T00:00:00Z";

  r = await fp(["tick", "--project", "tern", "--dry-run"]);
  assert.match(r.out, /would re-point the watch "About" to "About_EN" \(907431:81091\) and keep its baseline; nothing is changed in a dry run/);
  assert.equal(readFileSync(cfg, "utf8"), before);

  r = await fp(["tick", "--project", "tern"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /tern: watched section "About" moved in Figma: now "About_EN" on "Development Ready \(Latest\)" \(907431:81091, was 7431:81091\)\. The watch follows it and keeps its baseline/);
  assert.doesNotMatch(r.out, /is gone/);
  const now = readFileSync(cfg, "utf8");
  assert.match(now, /# figpipe \d{4}-\d\d-\d\d: "About" moved in Figma, from 7431:81091 to "About_EN" on "Development Ready \(Latest\)"\. The baseline is kept\.\nnode = "907431:81091"\nname = "About"\nbranch = "main"\nroute = "\/en-gb\/preview\/about"\npage = "Development Ready \(Latest\)"/);
  assert.match(now, /# Pre-built on feat\/plans-r2\.\n\[\[figma\.files\.watch\]\]/, "the user's comment stays");
  assert.match(now, new RegExp(`node = "${TECH}"\\nname = "Technology"\\nbranch = "main"\\npage = "Design In Progress"`), "the other watch is untouched");
  assert.equal((await fp(["config", "check", "tern"])).code, 0);

  r = await fp(["status"]);
  assert.match(r.out, /About \(\/en-gb\/preview\/about from main\): now "About_EN" on "Development Ready \(Latest\)" \(moved in Figma, followed .+; the baseline is kept\); marked ready for dev/);
  assert.doesNotMatch(r.out, /Is this yours\? About_EN/);
  assert.doesNotMatch(r.out, /warning: watched section "About"/);
  assert.match(r.out, /Is this yours\? Navigation_EN/, "sections nothing accounts for are still asked about");
  r = await fp(["watch", "tern"]);
  assert.match(r.out, /About .*now "About_EN"/);

  // The next check has nothing to follow and reads no section twice.
  r = await fp(["tick", "--project", "tern"]);
  assert.doesNotMatch(r.out, /moved in Figma|is gone/);
  assert.equal(readFileSync(cfg, "utf8"), now);
});

test("watch baseline --all records every watched section and every ready section that is yours, and settles what waited", async () => {
  const db = () => openDb(join(home, "state.db"));
  let d = db();
  const waiting = () => d.all("SELECT node_id, kind FROM events WHERE status = 'pending' AND role = 'trigger' AND kind IN ('ready', 'changed') ORDER BY id").map((e) => `${e.kind} ${e.node_id}`);
  assert.ok(waiting().includes(`ready ${MOVED}`), "the moved section's ready mark waits");
  assert.ok(waiting().includes("ready 3618:25678"), "and Main_EN, yours by rule");
  d.close();
  const r = await fp(["watch", "baseline", "tern", "--all"]);
  assert.equal(r.code, 0, r.out);
  for (const name of ["About", "Technology", "Main_EN", "Main_GER"]) assert.match(r.out, new RegExp(`^${name}: baseline recorded`, "m"), name);
  assert.match(r.out, /^About: baseline recorded \(0 renders, 1 waiting change settled\)/m);
  assert.doesNotMatch(r.out, /Navigation_EN|Offer Funnel/, "sections that are not yours are left alone");
  d = db();
  assert.deepEqual(waiting(), []);
  assert.equal(d.get("SELECT COUNT(*) AS n FROM watches").n, 2, "owned sections do not become watches");
  assert.ok(d.get("SELECT 1 AS x FROM ledger WHERE key = ? AND outcome = 'already_done' AND batch_id LIKE 'baseline-%'", `node:${LIVE}:3618:25678`), "Main_EN counts as built from this design");
  d.close();
  // Named sections work the same, watched or owned; an unknown name is refused.
  assert.match((await fp(["watch", "baseline", "tern", "main_en"])).out, /^Main_EN: baseline recorded/m);
  const bad = await fp(["watch", "baseline", "tern", "Checkout"]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /Not watched or yours in tern: checkout\. Watched: About, Technology\. Yours and ready: .*Main_EN/);
  // Without --all, as before: the watched sections only.
  const plain = await fp(["watch", "baseline", "tern"]);
  assert.deepEqual(plain.out.trim().split("\n").filter((l) => !l.startsWith(" ")).map((l) => l.split(":")[0]), ["About", "Technology"]);
});

test("a batch that waits for Claude shows plainly in status and doctor, and closes with a note", async () => {
  const d = openDb(join(home, "state.db"));
  const dir = join(home, "batches", "tern", "tern-20261007-041200");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "batch.json"), JSON.stringify({ lanes: [] }));
  d.run(
    "INSERT INTO batches (id, project, status, created_at, dir, attempts, wait_kind, wait_source, retry_after, wait_note, error, account) VALUES (?, 'tern', 'ready', ?, ?, 0, 'usage', 'session', ?, ?, ?, ?)",
    "tern-20261007-041200", "2026-10-07T11:12:00.000Z", dir, "2026-10-13T16:00:00.000Z", "You've hit your weekly limit", "Claude usage limit hit; retries after Tue 13 Oct 09:00 PDT", "bg@example.invalid, max plan",
  );
  d.run("INSERT INTO items (batch_id, project, file_key, kind, node_id, title, outcome) VALUES ('tern-20261007-041200', 'tern', ?, 'changed', ?, 'About', 'pending')", LIVE, MOVED);
  d.close();
  let r = await fp(["status"]);
  assert.match(r.out, /tern-20261007-041200 · waiting · Claude usage limit hit; retries after Tue 13 Oct 09:00 PDT/);
  assert.match((await fp(["status", "--json"])).out, /"wait_kind": "usage"/);
  r = await fp(["doctor", "tern"], { FIGPIPE_CLAUDE_BIN: "/usr/bin/true" });
  assert.match(r.out, /warn  Batch tern-20261007-041200: Claude usage limit hit; retries after Tue 13 Oct 09:00 PDT; its items are kept\n\s+`figpipe run --batch tern-20261007-041200` starts it now\./);
  // Closed by hand, with the reason: it never runs, and the report keeps the note.
  r = await fp(["ack", "tern-20261007-041200", "--note", "Rebuilt by hand on feat/plans-r2"]);
  assert.equal(r.code, 0, r.out);
  const d2 = openDb(join(home, "state.db"));
  const b = d2.get("SELECT status, reviewed_by, review_note, wait_kind FROM batches WHERE id = 'tern-20261007-041200'");
  assert.deepEqual({ ...b }, { status: "reviewed", reviewed_by: "you", review_note: "Rebuilt by hand on feat/plans-r2", wait_kind: null });
  d2.close();
  assert.match(readFileSync(join(dir, "report.html"), "utf8"), /Rebuilt by hand on feat\/plans-r2/);
  assert.match(readFileSync(join(home, "index.html"), "utf8"), /Rebuilt by hand on feat\/plans-r2/);
  assert.doesNotMatch((await fp(["status"])).out, /tern-20261007-041200/);
  assert.ok(existsSync(join(home, "PAUSE")));
});
