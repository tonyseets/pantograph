// Claude usage limits and sign-in: a session that Claude could not run is not a failed attempt.
// The batch keeps its items and waits for the reset; a free check runs before any worktree; lanes
// that got no commit are cleared away; the login the background session used is written down.
// The result lines are the ones two real batches ended with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { tempHome, ternConfig, figmaState, fakeClient, fakeFetch, comment, clockAt, gitRepo, LIVE, SMALL } from "./helpers.mjs";

let home = tempHome();
process.env.FIGPIPE_CLAUDE_BIN = new URL("./fake-claude.mjs", import.meta.url).pathname;
const claudeState = join(mkdtempSync(join(tmpdir(), "figpipe-claude-")), "state.json");
process.env.FAKE_CLAUDE_STATE = claudeState;
const { openDb, budgetToday } = await import("../../figpipe/lib/db.mjs");
const { reconcileProject, addManual } = await import("../../figpipe/lib/reconcile.mjs");
const { planBatch, createBatch } = await import("../../figpipe/lib/batcher.mjs");
const { extractBatch } = await import("../../figpipe/lib/extract.mjs");
const { startBatch, supervise, parseStream, sessionBlock, parseResetTime, parseMeters, dueForStart, cleanupLanes, waitLine } = await import("../../figpipe/lib/run.mjs");
const { writeReport, statusLabel } = await import("../../figpipe/lib/report.mjs");
const { fmtAt, machineZone } = await import("../../figpipe/lib/schedule.mjs");

// What the stand-in Claude answers: { signed_out, usage, limit, resets_at }. Its calls are logged.
const claude = (o = {}) => {
  writeFileSync(claudeState, JSON.stringify(o));
  rmSync(`${claudeState}.calls`, { force: true });
};
const calls = () => (existsSync(`${claudeState}.calls`) ? readFileSync(`${claudeState}.calls`, "utf8").trim().split("\n") : []);
const RESET = Date.parse("2026-10-13T16:00:00Z"); // Oct 13 at 9am in Los Angeles
const WEEKLY = "You've hit your weekly limit · resets Oct 13 at 9am (America/Los_Angeles)";
const FULL = "Current session: 4% used · resets Oct 2 at 1:29pm (America/Los_Angeles)\nCurrent week (all models): 100% used · resets Oct 13 at 9am (America/Los_Angeles)";
const LINE = `Claude usage limit hit; retries after ${fmtAt(RESET, machineZone())}`;

async function world() {
  home = tempHome();
  const root = mkdtempSync(join(tmpdir(), "figpipe-usage-"));
  const { repo, g } = gitRepo(root, { feature: "feat/timeline-v2" });
  const db = openDb(join(home, "state.db"));
  const config = await ternConfig(repo);
  const state = figmaState();
  const clock = clockAt("2026-10-02T16:00:00Z");
  const client = fakeClient(state);
  await reconcileProject({ db, config, client, clock });
  addManual({ db, project: "tern", fileKey: LIVE, nodeId: SMALL, note: "new timeline states", clock });
  clock.advance(10);
  state.comments.comments.push(comment({ id: "9000000100", text: "@tony the pill spacing is off", node: "40000210:73781", at: "2026-10-02T16:09:00Z" }));
  await reconcileProject({ db, config, client, clock });
  const b = createBatch({ db, config, plan: planBatch({ db, config, clock, now: true }), clock });
  const extractFn = (o) => extractBatch({ ...o, fetchImpl: fakeFetch, sleep: async () => {} });
  const start = (o = {}) => startBatch({ db, config, batchId: b.id, client, extractFn, foreground: true, clock, ...o });
  const row = () => db.get("SELECT * FROM batches WHERE id = ?", b.id);
  const wt = `${repo}-fp-timeline-v2`;
  const branches = () => g(repo, "branch", "--list", "figma/*").trim();
  return { repo, g, db, config, state, clock, client, batchId: b.id, start, row, wt, branches, dir: join(home, "batches", "tern", b.id) };
}

test("the reset time is read in the zone the message names", () => {
  const now = Date.parse("2026-10-07T12:10:00Z");
  assert.equal(parseResetTime(WEEKLY, now), RESET);
  assert.equal(parseResetTime("your weekly limit resets Oct 9 at 6pm (America/Los_Angeles)", Date.parse("2026-10-05T16:00:00Z")), Date.parse("2026-10-10T01:00:00Z"));
  assert.equal(parseResetTime("resets Oct 7 at 1:29pm (America/Los_Angeles)", now), Date.parse("2026-10-07T20:29:00Z"));
  assert.equal(parseResetTime("resets 3pm (Europe/Berlin)", now), Date.parse("2026-10-07T13:00:00Z"), "a time alone is its next occurrence");
  assert.equal(parseResetTime("resets 9am (Europe/Berlin)", now), Date.parse("2026-10-08T07:00:00Z"));
  assert.equal(parseResetTime("resets Jan 2 at 9am (UTC)", Date.parse("2026-12-30T00:00:00Z")), Date.parse("2027-01-02T09:00:00Z"), "a date that has passed this year is next year's");
  assert.equal(parseResetTime("resets in 2 hours", now), now + 2 * 3600e3);
  assert.equal(parseResetTime("no time here", now), null);
  const meters = parseMeters(`You are currently using your subscription\n\n${FULL}\nCurrent week (Fable): 0% used · resets Oct 12 at 12am (America/Los_Angeles)`, now);
  assert.deepEqual(meters.map((m) => [m.label, m.used]), [["Current session", 4], ["Current week (all models)", 100], ["Current week (Fable)", 0]]);
  assert.equal(meters[1].resets_at, RESET);
});

test("a usage limit is read from the session's result, with its reset time; a failure of its own is not one", () => {
  const lines = (...l) => parseStream(l.map((x) => JSON.stringify(x)).join("\n"));
  const now = Date.parse("2026-10-07T12:10:53Z");
  // Batch tern-website-20261007-041200, as Claude Code 2.1.292 printed it.
  const weekly = lines(
    { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5", apiKeySource: "none", claude_code_version: "2.1.292", mcp_servers: [{ name: "figma", status: "needs-auth" }] },
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1791907200, rateLimitType: "seven_day", overageStatus: "rejected" } },
    { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: WEEKLY }] }, error: "rate_limit", is_api_error_message: true, api_error: "usage_limit_reached" },
    { type: "result", subtype: "success", is_error: true, api_error_status: 429, api_error: "usage_limit_reached", terminal_reason: "api_error", total_cost_usd: 0, num_turns: 1, result: WEEKLY },
  );
  assert.deepEqual(sessionBlock(weekly, now), { kind: "usage", until: RESET, text: WEEKLY, limit: "seven_day" });
  assert.deepEqual(weekly.init, { version: "2.1.292", model: "claude-opus-5-5", key_source: "none" });
  // Batch tern-website-20261005-070306: a spend limit, the reset named only in the text.
  const spend = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your weekly limit resets Oct 9 at 6pm (America/Los_Angeles)";
  const monthly = lines({ type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", total_cost_usd: 0, result: spend });
  assert.deepEqual(sessionBlock(monthly, Date.parse("2026-10-05T16:01:00Z")), { kind: "usage", until: Date.parse("2026-10-10T01:00:00Z"), text: spend, limit: null });
  const signedOut = lines({ type: "result", subtype: "success", is_error: true, api_error_status: 401, terminal_reason: "api_error", result: "Invalid API key · Please run /login" });
  assert.equal(sessionBlock(signedOut, now).kind, "auth");
  const credit = lines({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Credit balance is too low" });
  assert.equal(sessionBlock(credit, now).kind, "credit");
  // The session's own failures stay failures.
  assert.equal(sessionBlock(lines({ type: "result", subtype: "error_during_execution", is_error: true, result: "the rate limit of the dev server was hit" }), now), null);
  assert.equal(sessionBlock(lines({ type: "result", subtype: "success", is_error: false, structured_output: { items: [] } }), now), null);
  assert.equal(sessionBlock(parseStream(""), now), null);
});

test("a session that meets the usage limit leaves the batch waiting: no failed attempt, no spend, items kept, empty lanes removed", async () => {
  const w = await world();
  const { db, config, batchId, clock } = w;
  // The meters look fine, so the session starts and Claude refuses it.
  claude({ limit: WEEKLY, resets_at: RESET / 1000 });
  for (const round of [1, 2, 3]) {
    const r = await w.start({ force: true });
    assert.ok(r.started, r.why);
    assert.ok(existsSync(w.wt), "the lane was prepared for the session");
    const res = await supervise({ db, config, batchId, clock });
    assert.equal(res.status, "waiting", `round ${round}: never stuck, however often the limit is met`);
    assert.equal(res.error, LINE);
  }
  const b = w.row();
  assert.equal(b.status, "ready");
  assert.deepEqual([b.wait_kind, b.wait_source], ["usage", "session"]);
  assert.equal(b.retry_after, new Date(RESET).toISOString());
  assert.equal(b.wait_note, WEEKLY);
  assert.equal(b.error, LINE);
  assert.equal(statusLabel(b), "waiting");
  assert.equal(b.attempts, 0, "not a failed attempt");
  assert.equal(b.usd, null);
  assert.equal(budgetToday(db, "tern", clock()).batches, 0, "nor a batch on today's count");
  assert.equal(budgetToday(db, "tern", clock()).usd, 0);
  assert.deepEqual(db.all("SELECT outcome FROM items WHERE batch_id = ?", batchId).map((i) => i.outcome), ["pending", "pending"], "the items stay queued");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE batch_id = ? AND status = 'batched'", batchId).n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM notes WHERE batch_id = ? AND text LIKE 'The batch stopped%'", batchId).n, 0);
  // The lane got no commit: its worktree and branch are gone, Tony's checkout is untouched.
  assert.ok(!existsSync(w.wt));
  assert.equal(w.branches(), "");
  assert.equal(w.g(w.repo, "status", "--porcelain"), "");
  // The meters had room when Claude refused, so they cannot say when this limit lifts: no hourly
  // look, and no lanes prepared again, until the reset time.
  clock.advance(61);
  assert.equal(dueForStart(w.row(), clock()), false);
  claude({});
  const early = await w.start();
  assert.deepEqual([early.started, early.waiting, early.why], [false, true, LINE]);
  assert.ok(!existsSync(w.wt));
  assert.deepEqual(calls(), ["auth status", "usage"]);
  assert.equal(dueForStart({ ...w.row() }, RESET + 1), true);
  // New work waits behind it, and says why.
  addManual({ db, project: "tern", fileKey: LIVE, nodeId: "40000210:73932", note: "another", clock });
  assert.match(planBatch({ db, config, clock, now: true }).wait.join(" "), new RegExp(`batch ${batchId} waits: Claude usage limit hit; retries after`));
  // The report and the index say it plainly, with the command that starts it by hand.
  const html = readFileSync(writeReport(db, batchId, { projectName: "Tern" }), "utf8");
  assert.ok(html.includes(LINE), "the report says what it waits for");
  assert.match(html, /Waiting for Claude usage/);
  assert.match(html, /Nothing was built and nothing was spent; the items are kept\./);
  assert.match(html, /figpipe<\/span> <span>run<\/span> <span>--batch<\/span>/);
  assert.doesNotMatch(html, /Mark reviewed/);
  const index = readFileSync(join(home, "index.html"), "utf8");
  assert.ok(index.includes(LINE));
  // The batch log names the login the background session ran under, and what Claude said.
  const log = readFileSync(join(w.dir, "batch.log"), "utf8");
  assert.match(log, /attempt 1: Claude login for this session: bg@example\.invalid, max plan, organisation "Test Org", signed in with claude\.ai, settings in \/tmp\/claude\. Usage: Current session 3% used/);
  assert.match(log, /session ran on Claude Code 2\.1\.292, model claude-opus-5-5, API key source none/);
  assert.match(log, /Claude said: "You've hit your weekly limit/);
  assert.match(log, /Removed figma\/timeline-v2: no commits/);
  assert.match(b.account, /^bg@example\.invalid, max plan/);
  assert.match(html, /Claude login<\/dt><dd>bg@example\.invalid/);
});

test("a full meter is caught before any worktree, install or session; the wait ends at the reset or when a free check finds room", async () => {
  const w = await world();
  const { db, config, batchId, clock } = w;
  claude({ usage: FULL });
  const r = await w.start();
  assert.equal(r.started, false);
  assert.equal(r.waiting, true);
  assert.equal(r.why, LINE);
  assert.deepEqual(calls(), ["auth status", "usage"], "two free commands, no session");
  assert.ok(!existsSync(w.wt), "no worktree before Claude can run");
  assert.equal(w.branches(), "");
  assert.ok(!existsSync(join(w.dir, "session")), "and no session files");
  let b = w.row();
  assert.deepEqual([b.status, b.wait_kind, b.wait_source, b.retry_after, b.attempts], ["ready", "usage", "meter", new Date(RESET).toISOString(), 0]);
  assert.equal(budgetToday(db, "tern", clock()).batches, 0);
  assert.match(readFileSync(join(w.dir, "batch.log"), "utf8"), /not started: Claude usage limit hit; retries after .+ \(Current week \(all models\) is 100% used\)/);

  // Checked again at most hourly, for free.
  assert.equal(dueForStart(b, clock()), false);
  clock.advance(59);
  assert.equal(dueForStart(b, clock()), false);
  clock.advance(2);
  assert.equal(dueForStart(b, clock()), true);
  claude({ usage: FULL });
  assert.equal((await w.start()).waiting, true);
  assert.deepEqual(calls(), ["auth status", "usage"]);
  assert.equal(dueForStart(w.row(), clock()), false, "the hour starts again");

  // Meters that cannot be read say nothing: before the reset the batch stays held.
  clock.advance(61);
  claude({ usage: "Usage is not available for API key logins" });
  assert.equal((await w.start()).waiting, true);
  assert.deepEqual(calls(), ["auth status", "usage"]);
  assert.equal(w.row().retry_after, new Date(RESET).toISOString(), "the reset time is kept");

  // The limit lifted early: the next free check sees room and the batch runs.
  clock.advance(61);
  claude({});
  const go = await w.start();
  assert.ok(go.started, go.why);
  assert.equal((await supervise({ db, config, batchId, clock })).status, "done");
  b = w.row();
  assert.deepEqual([b.wait_kind, b.retry_after, b.error, b.attempts], [null, null, null, 1]);
  assert.match(readFileSync(join(w.dir, "batch.log"), "utf8"), /the wait for Claude is over; starting/);
});

test("after the reset time a waiting batch starts on the next check, and by hand at any time", async () => {
  const w = await world();
  const { db, config, batchId, clock } = w;
  claude({ usage: FULL });
  await w.start();
  // By hand before the reset, with meters that cannot be read: figpipe run --batch tries it.
  claude({ usage: "unreadable" });
  const forced = await w.start({ force: true });
  assert.ok(forced.started, forced.why);
  claude({ limit: WEEKLY, resets_at: RESET / 1000 });
  assert.equal((await supervise({ db, config, batchId, clock })).status, "waiting");
  // The reset passes while the Mac sleeps: due at once, and it runs.
  clock.set("2026-10-13T16:05:00Z");
  assert.equal(dueForStart(w.row(), clock()), true);
  claude({ usage: "unreadable" });
  const r = await w.start();
  assert.ok(r.started, r.why);
  assert.equal((await supervise({ db, config, batchId, clock })).status, "done");
  assert.equal(w.row().attempts, 1);
});

test("a batch that waited is built from the design as it is after the wait", async () => {
  const w = await world();
  const { db, config, batchId, clock, state } = w;
  claude({ usage: FULL });
  await w.start();
  const first = JSON.parse(readFileSync(join(w.dir, "extract.json"), "utf8")).extracted_at;
  // The designer keeps working during the week the batch waits.
  clock.set("2026-10-13T16:05:00Z");
  state.meta.file.last_touched_at = "2026-10-12T09:00:00Z";
  await reconcileProject({ db, config, client: w.client, clock });
  claude({});
  const r = await w.start();
  assert.ok(r.started, r.why);
  assert.ok(JSON.parse(readFileSync(join(w.dir, "extract.json"), "utf8")).extracted_at > first, "the extraction is redone");
  assert.equal((await supervise({ db, config, batchId, clock })).status, "done");
});

test("a limit that comes part-way keeps the work: the spend counts, the lane stays, and the retry continues from its edits", async () => {
  const w = await world();
  const { db, config, batchId, clock } = w;
  claude({ limit: WEEKLY, resets_at: RESET / 1000, half_done: true });
  await w.start();
  assert.equal((await supervise({ db, config, batchId, clock })).status, "waiting");
  let b = w.row();
  assert.deepEqual([b.attempts, b.usd, b.wait_kind], [0, 1.25, "usage"], "what was spent is counted; the attempt is not");
  assert.equal(budgetToday(db, "tern", clock()).usd, 1.25);
  assert.equal(budgetToday(db, "tern", clock()).batches, 1, "a session that worked is a batch of the day");
  assert.ok(existsSync(join(w.wt, "half.txt")), "a lane with edits in it is kept");
  clock.set("2026-10-13T16:05:00Z");
  claude({});
  const r = await w.start();
  assert.ok(r.started, r.why);
  assert.equal(JSON.parse(readFileSync(r.manifest, "utf8")).lanes[0].carried, true, "the retry continues from them");
  assert.equal((await supervise({ db, config, batchId, clock })).status, "done");
});

test("signed out: the batch waits for the sign-in and checks hourly; nothing is created", async () => {
  const w = await world();
  claude({ signed_out: true });
  const r = await w.start();
  assert.equal(r.waiting, true);
  assert.equal(r.why, waitLine("auth"));
  assert.match(r.why, /Claude is signed out for background sessions; run `claude auth login`/);
  assert.deepEqual(calls(), ["auth status"]);
  const b = w.row();
  assert.deepEqual([b.wait_kind, b.wait_source], ["auth", "meter"]);
  assert.equal(Date.parse(b.retry_after) - w.clock(), 3600e3);
  assert.ok(!existsSync(w.wt));
  w.clock.advance(61);
  claude({});
  assert.ok((await w.start()).started);
});

test("only lanes with nothing in them are removed", async () => {
  const w = await world();
  const { config, g, repo } = w;
  claude({});
  const r = await w.start();
  const lanes = JSON.parse(readFileSync(r.manifest, "utf8")).lanes;
  // Uncommitted edits: kept for the retry.
  writeFileSync(join(w.wt, "draft.txt"), "half\n");
  assert.deepEqual(cleanupLanes({ config, lanes }), []);
  assert.ok(existsSync(join(w.wt, "draft.txt")));
  // A commit of its own: kept.
  g(w.wt, "add", "-A");
  g(w.wt, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "-m", "work");
  assert.deepEqual(cleanupLanes({ config, lanes }), []);
  assert.match(w.branches(), /figma\/timeline-v2/);
  // A branch figpipe did not name is never touched, even when it holds nothing.
  g(repo, "branch", "mine/empty", "main");
  assert.deepEqual(cleanupLanes({ config, lanes: [{ lane: "x", branch: "mine/empty", base: "main", worktree: join(repo, "..", "nowhere") }] }), []);
  assert.match(g(repo, "branch", "--list", "mine/*"), /mine\/empty/);
  // Merged into its base: nothing of its own is left, so it goes.
  g(repo, "branch", "-f", "feat/timeline-v2", "figma/timeline-v2");
  assert.deepEqual(cleanupLanes({ config, lanes }).map((x) => x.branch), ["figma/timeline-v2"]);
  assert.ok(!existsSync(w.wt));
  execFileSync("git", ["-C", repo, "rev-parse", "--verify", "feat/timeline-v2"]);
});
