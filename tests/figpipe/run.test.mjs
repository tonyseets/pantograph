// End to end without AI: reconcile -> batch -> extract -> worktrees -> guarded session (a fake
// claude) -> record -> report. Proves the no-push rails on a real git repo with a real remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { tempHome, ternConfig, figmaState, fakeClient, fakeFetch, comment, clockAt, gitRepo, LIVE, SMALL } from "./helpers.mjs";

let home = tempHome();
process.env.FIGPIPE_CLAUDE_BIN = new URL("./fake-claude.mjs", import.meta.url).pathname;
process.env.GH_TOKEN = "should-not-reach-the-session";
const { openDb } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject, addManual } = await import("../../figpipe/lib/reconcile.mjs");
const { planBatch, createBatch } = await import("../../figpipe/lib/batcher.mjs");
const { extractBatch } = await import("../../figpipe/lib/extract.mjs");
const { startBatch, supervise, parseUsage } = await import("../../figpipe/lib/run.mjs");
const { writeReport } = await import("../../figpipe/lib/report.mjs");

async function world({ feature = "feat/timeline-v2" } = {}) {
  home = tempHome(); // each world gets its own state folder
  const root = mkdtempSync(join(tmpdir(), "figpipe-run-"));
  const { repo, bare, g } = gitRepo(root, { feature });
  const db = openDb(join(home, "state.db"));
  const config = await ternConfig(repo);
  const state = figmaState();
  const clock = clockAt("2026-10-02T16:00:00Z");
  const client = fakeClient(state);
  await reconcileProject({ db, config, client, clock });
  // Tony adds the Timeline v2 section by hand; Mara mentions him on a frame inside it.
  addManual({ db, project: "tern", fileKey: LIVE, nodeId: SMALL, note: "new timeline states", clock });
  clock.advance(10);
  state.comments.comments.push(comment({ id: "9000000100", text: "@tony the pill spacing is off", node: "40000210:73781", at: "2026-10-02T16:09:00Z" }));
  await reconcileProject({ db, config, client, clock });
  const plan = planBatch({ db, config, clock, now: true });
  const b = createBatch({ db, config, plan, clock });
  const extractFn = (o) => extractBatch({ ...o, fetchImpl: fakeFetch, sleep: async () => {} });
  return { root, repo, bare, g, db, config, state, clock, client, batchId: b.id, extractFn };
}

test("a batch runs end to end and nothing can be pushed", async () => {
  const w = await world();
  const { db, config, batchId, repo, bare, g } = w;
  const r = await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  assert.ok(r.started);
  const manifest = JSON.parse(readFileSync(r.manifest, "utf8"));

  // One lane: the comment pinned inside Timeline v2 joined the node's lane after extraction.
  assert.deepEqual(manifest.lanes.map((l) => l.lane), ["timeline-v2"]);
  const lane = manifest.lanes[0];
  assert.equal(lane.branch, "figma/timeline-v2");
  assert.equal(lane.base, "feat/timeline-v2", "stacks on the page's feature branch");
  assert.equal(lane.worktree, join(realpathSync(join(repo, "..")), "site-fp-timeline-v2"));
  assert.equal(lane.port, 3011);
  assert.equal(lane.preview, "http://localhost:3011/en-gb/preview/timeline-v2");
  assert.equal(manifest.items.length, 2);
  const nodeItem = manifest.items.find((i) => i.kind === "manual");
  assert.equal(nodeItem.title, "Timeline v2");
  assert.ok(nodeItem.extraction.copy.md.endsWith("copy-40000210-73780.md"));
  assert.ok(nodeItem.extraction.renders.length > 1, "node and child frames rendered");
  assert.equal(nodeItem.extraction.breakpoint_frames.length, 0, "Timeline v2 frames are 1443 wide, not a breakpoint");
  const copy = readFileSync(nodeItem.extraction.copy.md, "utf8");
  assert.match(copy, /"More than a home check\.\\nA plan for a warmer home\."/, "copy is verbatim, line breaks visible");
  const commentItem = manifest.items.find((i) => i.kind === "comment");
  assert.equal(commentItem.area, "Timeline v2");
  assert.equal(commentItem.extraction.threads[0].messages[0].text, "@tony the pill spacing is off");
  // .figma stays out of commits through info/exclude.
  assert.match(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.figma\/$/m);

  // The session command carries the rails.
  const cmd = JSON.parse(readFileSync(join(r.manifest, "..", "session", "command.json"), "utf8"));
  for (const flag of ["--permission-mode", "--strict-mcp-config", "--settings", "--max-budget-usd", "--json-schema", "--disallowedTools", "--session-id"]) assert.ok(cmd.args.includes(flag), flag);
  assert.ok(!cmd.args.includes("--bare"));
  assert.ok(cmd.args.includes("Bash(git -C * log*)"), "git -C into a worktree is allowed for read and commit commands");
  assert.ok(cmd.args.includes("Bash(git -C * push*)") && cmd.args.includes("Bash(git push*)"), "and push is refused in both forms");
  assert.ok(!cmd.args.some((a) => /^Bash\(git -C \* (push|remote)/.test(a) && cmd.args.indexOf(a) < cmd.args.indexOf("--disallowedTools")), "push never on the allowlist");
  assert.equal(cmd.args[cmd.args.indexOf("--model") + 1], "opus");

  const res = await supervise({ db, config, batchId, clock: w.clock });
  assert.equal(res.status, "done", res.error);

  const probes = JSON.parse(readFileSync(join(r.manifest, "..", "probes.json"), "utf8"));
  assert.equal(probes.path_has_shims, true);
  assert.equal(probes.gh_token_removed, true);
  assert.equal(probes.permission_mode, "dontAsk");
  assert.notEqual(probes["push_timeline-v2"], 0, "push through the shim fails");
  assert.notEqual(probes["push_noverify_timeline-v2"], 0, "push --no-verify with the real git fails");
  // The session records through figpipe, item by item, and figpipe answers only for its own batch.
  for (const [k, v] of Object.entries(probes).filter(([k]) => k.startsWith("partial_"))) assert.equal(v, 0, k);
  assert.equal(probes.result_status, 0);
  assert.equal(probes.full_record_in_session, 2, "a session may only record partials");
  assert.equal(probes.ack_in_session, 2, "a session cannot mark batches reviewed");
  assert.equal(probes.other_batch_in_session, 2, "a session cannot read another batch");
  // Outside the session too: the worktree's own config refuses, even with --no-verify.
  const direct = spawnSync("git", ["-C", lane.worktree, "push", "--no-verify", "origin", "figma/timeline-v2"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.notEqual(direct.status, 0);
  assert.equal(execFileSync("git", ["-C", bare, "branch", "--list", "figma/*"], { encoding: "utf8" }).trim(), "", "the remote never got the branch");
  // Tony's own checkout keeps its normal push setup.
  assert.equal(spawnSync("git", ["-C", repo, "config", "--get", "core.hooksPath"]).status, 1);
  assert.equal(spawnSync("git", ["-C", repo, "config", "--get", "remote.origin.pushurl"]).status, 1);
  assert.equal(g(repo, "status", "--porcelain"), "", "the main checkout is untouched");
  // The lane committed on its branch, on top of the feature branch.
  assert.match(g(lane.worktree, "log", "--oneline", "-1"), /figma\(tern-/);
  assert.equal(g(lane.worktree, "merge-base", "--is-ancestor", "feat/timeline-v2", "HEAD"), "");

  // Recorded: outcomes, ledger, cost; report rendered.
  const items = db.all("SELECT kind, outcome, change_kind FROM items WHERE batch_id = ? ORDER BY id", batchId).map((x) => ({ ...x }));
  assert.deepEqual(items, [
    { kind: "manual", outcome: "applied", change_kind: "new_page" },
    { kind: "comment", outcome: "question", change_kind: "copy" },
  ]);
  assert.equal(db.get("SELECT usd FROM batches WHERE id = ?", batchId).usd, 2.5);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM ledger").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE status = 'done'").n, 2);

  const file = writeReport(db, batchId, { projectName: "Tern" });
  const html = readFileSync(file, "utf8");
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /Built Timeline v2 at three widths\./);
  assert.match(html, /Should the button say &#39;Book your home check&#39; on mobile too\?/);
  assert.match(html, /<del>Book now<\/del>/);
  assert.match(html, /Chose: Desktop copy/);
  assert.match(html, /No hover state for the step pills\./);
  assert.match(html, /@tony the pill spacing is off/);
  assert.match(html, /http:\/\/localhost:3011\/en-gb\/preview\/timeline-v2/);
  assert.match(html, /claude --resume /);
  const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((x) => x[1]).filter((u) => !/^http:\/\/localhost/.test(u) && !/^https:\/\/www\.figma\.com\/design\//.test(u));
  assert.deepEqual(external, [], "no external assets; only local previews and Figma links");
  assert.ok(!/<(script|link)[^>]+src=/.test(html), "no external scripts or stylesheets");
  const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(srcs.length >= 4);
  for (const s of srcs) assert.ok(existsSync(join(file, "..", s)), `image ${s} is in the batch folder`);
  assert.ok(existsSync(join(home, "index.html")));
});

test("the next batch on the same node, unchanged, is already built before any AI runs", async () => {
  const w = await world();
  const { db, config } = w;
  await startBatch({ db, config, batchId: w.batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  await supervise({ db, config, batchId: w.batchId, clock: w.clock });
  db.run("UPDATE batches SET status = 'reviewed'");
  addManual({ db, project: "tern", fileKey: LIVE, nodeId: SMALL, note: "again", clock: w.clock });
  const b = createBatch({ db, config, plan: planBatch({ db, config, clock: w.clock, now: true }), clock: w.clock });
  const r = await startBatch({ db, config, batchId: b.id, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  assert.equal(r.finished, true, "no session: nothing left to build");
  const it = db.get("SELECT outcome, verdict FROM items WHERE batch_id = ?", b.id);
  assert.equal(it.outcome, "already_done");
  assert.match(it.verdict, /No design change since batch/);
});

test("a session that fails retries once, then the batch is stuck", async () => {
  const w = await world();
  const { db, config, batchId } = w;
  process.env.FAKE_CLAUDE_FAIL = "1";
  try {
    await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
    let res = await supervise({ db, config, batchId, clock: w.clock });
    assert.equal(res.status, "ready");
    await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
    res = await supervise({ db, config, batchId, clock: w.clock });
    assert.equal(res.status, "stuck");
    assert.match(db.get("SELECT error FROM batches WHERE id = ?", batchId).error, /error_during_execution/);
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
  }
});

test("a session that stops after recording every item keeps the work", async () => {
  const w = await world();
  const { db, config, batchId } = w;
  process.env.FAKE_CLAUDE_FAIL = "after";
  try {
    await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
    const res = await supervise({ db, config, batchId, clock: w.clock });
    assert.equal(res.status, "done");
    assert.deepEqual(db.all("SELECT outcome FROM items WHERE batch_id = ? ORDER BY id", batchId).map((r) => r.outcome), ["applied", "question"]);
    assert.match(db.get("SELECT text FROM notes WHERE batch_id = ? AND kind = 'not_done' AND text LIKE 'The session stopped%'", batchId).text, /error_during_execution/);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM captures").n, 3, "captures recorded mid-session are kept");
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
  }
});

test("a worktree with uncommitted edits blocks its lane instead of being touched", async () => {
  const w = await world();
  const { db, config, batchId, repo, g } = w;
  g(repo, "worktree", "add", "-q", "-b", "figma/timeline-v2", `${repo}-fp-timeline-v2`, "main");
  execFileSync("sh", ["-c", `echo draft > '${repo}-fp-timeline-v2/draft.txt'`]);
  const r = await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  assert.equal(r.stuck, true, "no session when every lane is blocked");
  assert.match(r.lanes[0].blocked, /uncommitted edits/);
  assert.match(db.get("SELECT error FROM batches WHERE id = ?", batchId).error, /uncommitted edits/);
  assert.ok(existsSync(`${repo}-fp-timeline-v2/draft.txt`));
});

test("dry run prints the plan and creates nothing", async () => {
  const w = await world();
  w.config.stack.preview_pages = { "timeline-v2": "how-it-works" };
  const r = await startBatch({ db: w.db, config: w.config, batchId: w.batchId, client: w.client, extractFn: w.extractFn, dryRun: true, clock: w.clock });
  assert.equal(r.dryRun, true);
  assert.equal(r.lanes[0].preview, "http://localhost:3011/en-gb/preview/how-it-works", "a lane named after a node previews its page");
  assert.ok(!existsSync(`${w.repo}-fp-timeline-v2`));
  assert.equal(w.db.get("SELECT status FROM batches WHERE id = ?", w.batchId).status, "ready");
});

test("usage meter parsing and pace", () => {
  const now = new Date(2026, 9, 2, 9, 0).getTime();
  const p = parseUsage("Current week (all models): 12% used · resets Oct 7 at 7:59pm (America/Los_Angeles)", now);
  assert.equal(p.used, 12);
  assert.equal(p.ahead, false);
  const q = parseUsage("Current week (all models): 70% used · resets Oct 7 at 7:59pm (America/Los_Angeles)", now);
  assert.equal(q.ahead, true);
  assert.equal(parseUsage("garbage", now), null);
});


test("a new worktree gets the ignored files it needs to run, without write tokens", async () => {
  const { copyWorktreeFiles } = await import("../../figpipe/lib/run.mjs");
  const { writeFileSync, appendFileSync, mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "figpipe-wtfiles-"));
  const { repo } = gitRepo(root);
  appendFileSync(join(repo, ".git", "info", "exclude"), ".env\n");
  writeFileSync(join(repo, ".env"), "# local\nVITE_STORYBLOK_TOKEN=read-only\nHUBSPOT_ACCESS_TOKEN=write\nexport TURNSTILE_SECRETKEY=s\nSITE_URL=http://localhost\n");
  const config = await ternConfig(repo);
  config.git.worktree_files = [".env", "index.html", "missing.txt"];
  const wt = join(root, "wt");
  mkdirSync(wt);
  const copied = copyWorktreeFiles(config, wt);
  assert.deepEqual(copied, [{ file: ".env", omitted: ["HUBSPOT_ACCESS_TOKEN", "TURNSTILE_SECRETKEY"] }], "tracked and missing files are skipped");
  const env = readFileSync(join(wt, ".env"), "utf8");
  assert.match(env, /VITE_STORYBLOK_TOKEN=read-only/);
  assert.match(env, /SITE_URL=/);
  assert.doesNotMatch(env, /HUBSPOT_ACCESS_TOKEN|TURNSTILE_SECRETKEY/);
  assert.deepEqual(copyWorktreeFiles(config, wt), [], "an existing file is never overwritten");
});

test("the batch session finds its skills as project skills, linked from one copy", async () => {
  const { linkSessionSkills } = await import("../../figpipe/lib/run.mjs");
  const { lstatSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "figpipe-skills-"));
  const batchDir = join(dir, "batch");
  assert.deepEqual(linkSessionSkills(batchDir), ["figma-batch", "figma-transpose", "figma-review-page"], "sessions load project settings only, so every skill is linked");
  assert.match(readFileSync(join(batchDir, ".claude", "skills", "figma-batch", "SKILL.md"), "utf8"), /^name: figma-batch$/m);
  assert.ok(lstatSync(join(batchDir, ".claude", "skills", "figma-batch")).isSymbolicLink(), "linked, not copied: one copy of the skills");
  const { decide } = await import("../../figpipe/lib/guard.mjs");
  const edit = decide({ tool_name: "Edit", tool_input: { file_path: join(batchDir, ".claude", "skills", "figma-batch", "SKILL.md") } }, { writeRoots: [batchDir] });
  assert.equal(edit.allow, false, "the session cannot edit Pantograph through the link");
  const own = decide({ tool_name: "Write", tool_input: { file_path: join(batchDir, ".claude", "settings.json") } }, { writeRoots: [batchDir], protect: [join(batchDir, ".claude"), join(batchDir, "session")] });
  assert.equal(own.allow, false, "nor write itself project settings");
  const sess = decide({ tool_name: "Edit", tool_input: { file_path: join(batchDir, "session", "settings.json") } }, { writeRoots: [batchDir], protect: [join(batchDir, ".claude"), join(batchDir, "session")] });
  assert.equal(sess.allow, false, "nor change its own hook and sandbox settings");
});

test("calls Claude Code refused are read from the transcript for the report", async () => {
  const { parseStream } = await import("../../figpipe/lib/run.mjs");
  const lines = [
    { type: "system", subtype: "init", session_id: "s1", mcp_servers: [{ name: "figma", status: "needs-auth" }] },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "D=x; cat $D/a | head" } }] } },
    { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t1", decision_reason_type: "mode" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "git push" } }] } },
    { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t2", decision_reason_type: "hook" },
    { type: "result", subtype: "success", total_cost_usd: 0.5, structured_output: { items: [] } },
  ];
  const p = parseStream(lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(p.session, "s1");
  assert.deepEqual(p.mcp, [{ name: "figma", status: "needs-auth" }]);
  assert.deepEqual(p.denied, [{ tool: "Bash", input: { command: "D=x; cat $D/a | head" }, reason: "not on the session's allowlist" }], "guard denials are recorded by the guard, not twice");
});

test("a stopped batch retries under a new session id and keeps its own unfinished edits", async () => {
  const w = await world();
  const { db, config, batchId } = w;
  process.env.FAKE_CLAUDE_FAIL = "1";
  let first;
  try {
    await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
    first = db.get("SELECT session_id FROM batches WHERE id = ?", batchId).session_id;
    assert.equal((await supervise({ db, config, batchId, clock: w.clock })).status, "ready");
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
  }
  // The stopped attempt left half-finished work in its own worktree.
  const wt = JSON.parse(readFileSync(join(home, "batches", "tern", batchId, "batch.json"), "utf8")).lanes[0].worktree;
  execFileSync("sh", ["-c", `echo half > '${wt}/wip.txt'`]);
  const r = await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  assert.ok(r.started, r.why);
  const manifest = JSON.parse(readFileSync(r.manifest, "utf8"));
  assert.equal(manifest.lanes[0].carried, true, "the retry continues from the edits instead of refusing the folder");
  const second = db.get("SELECT session_id FROM batches WHERE id = ?", batchId).session_id;
  assert.notEqual(second, first, "Claude Code refuses a used session id, so each attempt gets its own");
  const res = await supervise({ db, config, batchId, clock: w.clock });
  assert.equal(res.status, "done", res.error);
});

test("a running batch is not started a second time", async () => {
  const w = await world();
  const { db, config, batchId } = w;
  await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  db.run("UPDATE batches SET pid = ? WHERE id = ?", process.pid, batchId);
  const before = db.get("SELECT status, attempts FROM batches WHERE id = ?", batchId);
  const again = await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  assert.equal(again.started, false);
  assert.match(again.why, /is running/);
  assert.deepEqual({ ...db.get("SELECT status, attempts FROM batches WHERE id = ?", batchId) }, { ...before });
});

test("a saved pid that now belongs to another process does not keep a batch alive", async () => {
  const w = await world();
  const { reapDead } = await import("../../figpipe/lib/cli.mjs");
  w.db.run("UPDATE batches SET status = 'running', attempts = 1, pid = ?, pid_started = 'Thu Jan  1 00:00:00 1970' WHERE id = ?", process.pid, w.batchId);
  reapDead(w.db);
  assert.equal(w.db.get("SELECT status FROM batches WHERE id = ?", w.batchId).status, "ready");
});

test("the session runs in an OS sandbox: writes, network and settings are fenced", async () => {
  const w = await world();
  const r = await startBatch({ db: w.db, config: w.config, batchId: w.batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
  const dir = join(r.manifest, "..");
  const settings = JSON.parse(readFileSync(join(dir, "session", "settings.json"), "utf8"));
  const sb = settings.sandbox;
  assert.equal(sb.enabled, true);
  assert.equal(sb.failIfUnavailable, true, "no sandbox, no session");
  assert.equal(sb.allowUnsandboxedCommands, false, "no escape hatch");
  assert.equal(sb.autoAllowBashIfSandboxed, false, "the allowlist still applies");
  assert.equal(sb.network.strictAllowlist, true);
  assert.ok(sb.network.allowedDomains.includes("api.figma.com"));
  assert.ok(sb.network.allowedDomains.includes("api.storyblok.com"), "the CMS read API, for the dev server");
  assert.ok(!sb.network.allowedDomains.some((d) => /mapi\.storyblok|github|slack/.test(d)), "never a write or messaging host");
  const real = (p) => realpathSync(p);
  const lane = JSON.parse(readFileSync(r.manifest, "utf8")).lanes[0].worktree;
  assert.ok(sb.filesystem.allowWrite.includes(lane));
  assert.ok(!sb.filesystem.allowWrite.includes(w.repo), "Tony's checkout is not writable");
  const git = join(real(w.repo), ".git");
  for (const f of ["config", "hooks", "index", "HEAD"]) assert.ok(sb.filesystem.denyWrite.includes(join(git, f)), f);
  assert.ok(sb.filesystem.denyWrite.includes(join(dir, "session")), "the session cannot rewrite its own rules");
  const args = JSON.parse(readFileSync(join(dir, "session", "command.json"), "utf8")).args;
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project", "the user's own settings never widen a session");
  assert.ok(!args.some((a) => /stash/.test(a) && args.indexOf(a) < args.indexOf("--disallowedTools")), "git stash is not on the allowlist");
});

test("money: a timed-out run counts as its whole limit, and a retry only gets what is left", async () => {
  const w = await world();
  const { db, config, batchId } = w;
  config.limits.max_minutes = 0.02;
  process.env.FAKE_CLAUDE_SLEEP = "20000";
  try {
    await startBatch({ db, config, batchId, client: w.client, extractFn: w.extractFn, foreground: true, clock: w.clock });
    const res = await supervise({ db, config, batchId, clock: w.clock });
    assert.match(res.error, /stopped after/);
  } finally {
    delete process.env.FAKE_CLAUDE_SLEEP;
  }
  assert.equal(db.get("SELECT usd FROM batches WHERE id = ?", batchId).usd, 15, "killed before it reported its cost: counted at the limit");
  const { budgetToday } = await import("../../figpipe/lib/db.mjs");
  assert.equal(budgetToday(db, "tern", w.clock()).usd, 15);
  // No money left for this batch: it stops instead of getting a fresh $15.
  const b = db.get("SELECT status FROM batches WHERE id = ?", batchId);
  assert.equal(b.status, "stuck");
  // The daily cap holds new batches back.
  config.limits.usd_per_day = 15;
  addManual({ db, project: "tern", fileKey: LIVE, nodeId: "40000210:73932", note: "another", clock: w.clock });
  const plan = planBatch({ db, config, clock: w.clock, now: true });
  assert.equal(plan.go, false);
  assert.match(plan.wait.join(" "), /\$15\.00 of today's \$15 spent/);
});
