// The guard: what a batch session may and may not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tempHome } from "./helpers.mjs";

tempHome();
const { checkBash, decide } = await import("../../figpipe/lib/guard.mjs");

test("pushes, remote changes and config overrides are denied however they are written", () => {
  const denied = [
    "git push",
    "git push origin figma/hero",
    "git -C /x/site push --no-verify",
    "cd site && git push -f",
    "npm run lint; git push",
    "echo $(git push)",
    'bash -c "git push origin main"',
    "env FOO=1 git push",
    "/usr/bin/git push",
    "git remote add mine https://github.com/x/y",
    "git remote set-url origin git@github.com:x/y",
    "git config remote.origin.pushurl https://github.com/x/y",
    "git config --worktree --unset core.hooksPath",
    "git -c url.x.insteadOf= fetch",
    "GIT_CONFIG_COUNT=0 git status",
    "unset GIT_CONFIG_KEY_0",
    "git send-email 0001.patch",
    "gh pr create --fill",
    "xargs gh issue list",
  ];
  for (const c of denied) assert.ok(checkBash(c), `should deny: ${c}`);
});

test("screen, network, deploys and CMS writes are denied", () => {
  for (const c of [
    "open http://localhost:3011",
    "osascript -e 'tell app \"Figma\" to activate'",
    "curl https://example.com",
    "curl -X POST https://api.figma.com/v1/files/k/comments -d '{}'",
    "curl --data x=1 http://localhost:3011/api",
    "wget https://evil.example",
    "echo https://www.figma.com/design/abc",
    "npx wrangler deploy",
    "npm publish",
    "storyblok push-components",
    "ssh host",
    "rm -rf ~",
    "launchctl bootout gui/501/x",
  ])
    assert.ok(checkBash(c), `should deny: ${c}`);
});

test("ordinary build commands pass", () => {
  for (const c of [
    "git status --porcelain",
    "git add -A && git commit -m \"figma(b1): push button styles (Hero)\"",
    "git log --oneline | head -5",
    "npm run lint:quiet",
    "npx nuxt dev --port 3011",
    "node capture.mjs --widths 1440,1024,390",
    "curl -s http://localhost:3011/en-gb/preview/how-it-works",
    "figpipe budget mcp --batch tern-1",
    "rm -rf .output dist",
    "npm run open-graph",
  ])
    assert.equal(checkBash(c), null, c);
});

test("edits stay in the worktrees, the batch folder and .figma", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-"));
  const wt = join(root, "site-fp-hero");
  const batch = join(root, "batch");
  const fig = join(root, "site", ".figma");
  for (const d of [wt, batch, fig]) mkdirSync(d, { recursive: true });
  const ctx = { writeRoots: [wt, batch, fig] };
  assert.ok(decide({ tool_name: "Edit", tool_input: { file_path: join(wt, "components/Hero.vue") } }, ctx).allow);
  assert.ok(decide({ tool_name: "Write", tool_input: { file_path: join(batch, "result.json") } }, ctx).allow);
  assert.ok(!decide({ tool_name: "Write", tool_input: { file_path: join(root, "site", "components/Hero.vue") } }, ctx).allow, "Tony's own checkout");
  assert.ok(!decide({ tool_name: "Edit", tool_input: { file_path: join(wt, "..", "site", "x.vue") } }, ctx).allow, "no escaping with ..");
  assert.ok(!decide({ tool_name: "Write", tool_input: { file_path: `${wt}-evil/x` } }, ctx).allow, "a sibling with the same prefix");
  assert.ok(decide({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }, ctx).allow);
});

test("Figma MCP: reads within budget, writes never, motion keeps its reserve", () => {
  let left = 30;
  const ctx = { writeRoots: [], mcpLeft: () => ({ left, reserve: 20 }) };
  const call = (name) => decide({ tool_name: `mcp__figma__${name}`, tool_input: {} }, ctx);
  assert.ok(call("get_design_context").allow);
  assert.ok(call("get_design_context").countMcp);
  assert.ok(!call("use_figma").allow);
  assert.ok(!call("generate_figma_design").allow);
  assert.ok(!call("upload_assets").allow);
  left = 15;
  assert.ok(!call("get_screenshot").allow, "general reads stop at the motion reserve");
  assert.ok(call("get_motion_context").allow);
  left = 0;
  assert.ok(!call("export_video").allow);
  assert.ok(call("whoami").allow, "whoami costs nothing");
  assert.ok(!decide({ tool_name: "mcp__plugin_slack_slack__slack_send_message", tool_input: {} }, ctx).allow);
  assert.ok(!decide({ tool_name: "mcp__computer-use__screenshot", tool_input: {} }, ctx).allow);
  assert.ok(!decide({ tool_name: "WebFetch", tool_input: { url: "https://www.figma.com/design/x" } }, ctx).allow);
  assert.ok(!decide({}, ctx).allow, "unreadable input is denied");
});

test("a session cannot change Tony's checkout, the shared stash or his branches", () => {
  const ctx = { writeRoots: ["/tmp/site-fp-hero", "/tmp/batch"], cwd: "/tmp/batch", branchPrefix: "figma/" };
  const denied = [
    "git -C /Users/tony/Projects/site checkout -- .",
    "git -C /Users/tony/Projects/site restore --staged --worktree .",
    "cd /Users/tony/Projects/site && git reset --hard",
    "git stash",
    "git -C /tmp/site-fp-hero stash pop",
    "git branch -D feat/how-it-works",
    "git -C /tmp/site-fp-hero branch -m feat/x feat/y",
    "git -C /tmp/site-fp-hero checkout -B main",
    "git update-ref refs/heads/main HEAD",
  ];
  for (const c of denied) assert.ok(checkBash(c, ctx), `should deny: ${c}`);
  const allowed = [
    "git -C /tmp/site-fp-hero add -A",
    "cd /tmp/site-fp-hero && git commit -m 'figma(b): hero'",
    "git -C /tmp/site-fp-hero branch -D figma/old",
    "git -C /Users/tony/Projects/site log --oneline -5",
    "git -C /Users/tony/Projects/site diff main...feat/x",
    "git branch --show-current",
    "git stash list",
  ];
  for (const c of allowed) assert.equal(checkBash(c, ctx), null, `should allow: ${c}`);
});

test("deploy and CMS tools are denied however they are launched; figpipe keeps its session limits", () => {
  for (const c of ["npx --yes storyblok push-components", "npm exec -- wrangler deploy", "npm x vercel", "pnpm dlx netlify-cli deploy", "yarn dlx @storyblok/cli push", "bunx firebase deploy", "bun x contentful space import"])
    assert.match(checkBash(c) ?? "", /deploying|CMS/, c);
  for (const c of ["figpipe ack b1", "figpipe run --batch b1", "node /x/figpipe/figpipe.mjs ack b1", "FIGPIPE_SESSION=0 figpipe ack b1", "env -u FIGPIPE_BROKER figpipe result b1", "unset FIGPIPE_SESSION; figpipe ack b1"])
    assert.ok(checkBash(c), c);
  for (const c of ["figpipe record b1 results/1.json --partial", "figpipe capture b1 --item 3 --phase after --url http://localhost:3011/", "figpipe budget mcp --batch b1", "npx nuxt dev --port 3011"]) assert.equal(checkBash(c), null, c);
});
