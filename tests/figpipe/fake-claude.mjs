#!/usr/bin/env node
// Stands in for `claude -p` in tests. Reads the batch manifest from its cwd, does a small real
// build in each lane worktree (one commit), tries to push (which must fail), writes captures,
// and prints a stream-json result like Claude Code does.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, realpathSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
// Free commands: the login and the usage meters. FAKE_CLAUDE_STATE names a JSON file tests rewrite
// between calls: { signed_out, usage (the /usage text), limit (the message a session ends with) }.
const state = process.env.FAKE_CLAUDE_STATE && existsSync(process.env.FAKE_CLAUDE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8")) : {};
const calls = (line) => process.env.FAKE_CLAUDE_STATE && appendFileSync(`${process.env.FAKE_CLAUDE_STATE}.calls`, line + "\n");
if (args[0] === "auth" && args[1] === "status") {
  calls("auth status");
  console.log(JSON.stringify(state.signed_out ? { loggedIn: false } : { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "bg@example.invalid", orgName: "Test Org", subscriptionType: "max", configDirectory: "/tmp/claude" }));
  process.exit(state.signed_out ? 1 : 0);
}
if (args[0] === "-p" && args[1] === "/usage") {
  calls("usage");
  console.log(state.usage ?? "Current session: 3% used · resets Oct 7 at 1:29pm (America/Los_Angeles)\nCurrent week (all models): 12% used · resets Oct 7 at 7:59pm (America/Los_Angeles)\nCurrent week (Fable): 100% used · resets Oct 12 at 12am (America/Los_Angeles)");
  process.exit(0);
}
calls("session");
// A session that meets the usage limit: Claude Code prints the limit event, the API's message and
// an error result, spends nothing and does no work. state.half_done: the limit came part-way, with
// edits left in the lane and some money spent.
if (state.limit) {
  const sid = args[args.indexOf("--session-id") + 1];
  if (state.half_done) for (const lane of JSON.parse(readFileSync(join(process.cwd(), "batch.json"), "utf8")).lanes) writeFileSync(join(lane.worktree, "half.txt"), "half\n");
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "system", subtype: "init", session_id: sid, model: "claude-opus-5-5", apiKeySource: "none", claude_code_version: "2.1.292", mcp_servers: [{ name: "figma", status: "needs-auth" }] });
  if (state.resets_at) out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: state.resets_at, rateLimitType: "seven_day" }, session_id: sid });
  out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: state.limit }] }, session_id: sid, error: "rate_limit", is_api_error_message: true });
  out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", total_cost_usd: state.half_done ? 1.25 : 0, num_turns: 1, result: state.limit, session_id: sid });
  process.exit(1);
}
const m = JSON.parse(readFileSync(join(process.cwd(), "batch.json"), "utf8"));
// Claude Code refuses a session id it has already used; so does this stand-in.
const sidSeen = join(process.cwd(), "session-ids.txt");
const sidArg = args[args.indexOf("--session-id") + 1];
if (existsSync(sidSeen) && readFileSync(sidSeen, "utf8").split("\n").includes(sidArg)) {
  process.stderr.write(`Error: Session ID ${sidArg} is already in use.\n`);
  process.exit(1);
}
writeFileSync(sidSeen, (existsSync(sidSeen) ? readFileSync(sidSeen, "utf8") : "") + sidArg + "\n");
writeFileSync(join(process.cwd(), "args.json"), JSON.stringify(args));
if (process.env.FAKE_CLAUDE_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_SLEEP)));
const sid = args[args.indexOf("--session-id") + 1];
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
say({ type: "system", subtype: "init", session_id: sid, model: args[args.indexOf("--model") + 1] });

const probes = {
  path_has_shims: realpathSync((process.env.PATH ?? "").split(":")[0]) === realpathSync(join(process.cwd(), "session", "bin")),
  git_config_count: process.env.GIT_CONFIG_COUNT,
  gh_token_removed: !("GH_TOKEN" in process.env),
  settings: args.includes("--settings"),
  strict_mcp: args.includes("--strict-mcp-config"),
  permission_mode: args[args.indexOf("--permission-mode") + 1],
};
const items = [];
const notDone = [];
for (const lane of m.lanes) {
  if (lane.blocked) {
    notDone.push({ text: `lane ${lane.lane} blocked: ${lane.blocked}` });
    continue;
  }
  writeFileSync(join(lane.worktree, `${lane.lane}.html`), `<section>${lane.lane}</section>\n`);
  const g = (...a) => spawnSync("git", ["-C", lane.worktree, ...a], { encoding: "utf8", env: process.env });
  g("add", "-A");
  g("-c", "user.email=t@example.invalid", "-c", "user.name=Test", "commit", "-q", "-m", `figma(${m.batch}): ${lane.lane}`);
  const sha = g("rev-parse", "HEAD").stdout.trim();
  // Both a plain push and --no-verify must fail from a pipeline worktree.
  probes[`push_${lane.lane}`] = g("push", "origin", lane.branch).status;
  probes[`push_noverify_${lane.lane}`] = spawnSync("/usr/bin/git", ["-C", lane.worktree, "push", "--no-verify", "origin", lane.branch], { encoding: "utf8", env: process.env }).status;
  mkdirSync(join(process.cwd(), "captures"), { recursive: true });
  for (const id of lane.items) {
    const it = m.items.find((x) => x.id === id);
    const render = it.extraction?.renders?.[0]?.path;
    const captures = [1440, 1024, 390].map((w) => {
      const after = `captures/${id}-after-${w}.png`;
      if (render && existsSync(render)) copyFileSync(render, join(process.cwd(), after));
      return { width: w, after, figma: render, ...(it.kind === "comment" ? { before: after } : {}) };
    });
    const isComment = it.kind === "comment";
    items.push({
      item_id: id,
      outcome: isComment ? "question" : "applied",
      change_kind: isComment ? "copy" : "new_page",
      verdict: isComment ? "Spacing fixed; the button copy needs the designer." : `Built ${it.title} at three widths.`,
      branch: lane.branch,
      commits: [sha],
      worktree: lane.worktree,
      preview: [{ label: "1440", url: lane.preview }],
      captures: isComment ? [] : captures,
      text_diff: isComment ? [{ before: "Book now", after: "Book your home check", where: "Hero button" }] : [],
      decisions: isComment ? [] : [{ text: "Mobile says 'Get tested', desktop says 'Book your home check'.", default_applied: "Desktop copy" }],
      questions: isComment ? [{ text: "Should the button say 'Book your home check' on mobile too?", section: "Hero" }] : [],
      flags: isComment ? [] : ["No hover state for the step pills."],
      ...(isComment ? { reply: "Fixed the spacing. Which button copy should mobile use?" } : {}),
    });
  }
}
// Record the way the figma-batch skill does: one partial result per item through the figpipe shim,
// then the final answer from `figpipe result`. Commands outside the session's set are refused.
const fp = (...a) => spawnSync("figpipe", a, { encoding: "utf8", env: process.env });
mkdirSync(join(process.cwd(), "results"), { recursive: true });
// FAKE_CLAUDE_FAIL=1 fails before recording anything; =after fails once every item is recorded.
for (const r of process.env.FAKE_CLAUDE_FAIL === "1" ? [] : items) {
  const f = join("results", `${r.item_id}.json`);
  writeFileSync(join(process.cwd(), f), JSON.stringify({ items: [r] }));
  probes[`partial_${r.item_id}`] = fp("record", m.batch, f, "--partial").status;
}
writeFileSync(join(process.cwd(), "results", "end.json"), JSON.stringify({ summary: `${items.length} items handled`, not_done: notDone, checks: [{ name: "npm run lint:quiet", status: "pass" }], mcp_calls: 2 }));
probes.partial_end = fp("record", m.batch, "results/end.json", "--partial").status;
probes.full_record_in_session = fp("record", m.batch, "results/end.json").status;
probes.ack_in_session = fp("ack", m.batch).status;
probes.other_batch_in_session = fp("result", "someone-elses-batch").status;
const fromDb = fp("result", m.batch);
probes.result_status = fromDb.status;
const final = JSON.parse(fromDb.stdout || "null");
writeFileSync(join(process.cwd(), "probes.json"), JSON.stringify(probes, null, 1));
say({ type: "assistant", message: { content: [{ type: "text", text: "working" }] }, session_id: sid });
say({
  type: "result",
  subtype: process.env.FAKE_CLAUDE_FAIL ? "error_during_execution" : "success",
  is_error: !!process.env.FAKE_CLAUDE_FAIL,
  total_cost_usd: 2.5,
  session_id: sid,
  structured_output: process.env.FAKE_CLAUDE_FAIL ? undefined : final,
});
