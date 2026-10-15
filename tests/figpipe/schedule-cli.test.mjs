// The schedule through the command line: tick stays silent until a check is due, runs one catch-up
// after sleep, status shows the next check in both zones, launchd wakes every 15 minutes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { tempHome, FIX, gitRepo } from "./helpers.mjs";
import { openDb } from "../../figpipe/lib/db.mjs";

const home = tempHome();
const BIN = new URL("../../figpipe/figpipe.mjs", import.meta.url).pathname;
let server;
let base;
const hits = [];

before(async () => {
  // Figma refuses every call: a check that runs shows up as a failure line, and as a request.
  server = createServer((req, res) => (hits.push(req.url), res.writeHead(403).end('{"err":"no"}')));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { repo } = gitRepo(mkdtempSync(join(tmpdir(), "figpipe-sched-")));
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(
    join(home, "projects", "tern.toml"),
    readFileSync(join(FIX, "tern.toml"), "utf8").replace("__REPO__", repo).replace('autonomy = "build"', 'autonomy = "notify"') + `\n[schedule]\ntimezone = "America/Los_Angeles"\ntimes = ["06:00", "14:00", "22:00"]\n`,
  );
});
after(() => server.close());

const fp = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, FIGPIPE_HOME: home, FIGMA_API_BASE: base, FIGPIPE_TEST_TOKEN: "t", FIGPIPE_NO_NOTIFY: "1", TZ: "Europe/Berlin", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end();
    child.on("exit", (code) => resolve({ code, out, err }));
  });

const setLast = (iso, ok = 1) => {
  const db = openDb();
  db.run("INSERT INTO project_state (project, last_tick_at, last_tick_ok) VALUES ('tern', ?, ?) ON CONFLICT (project) DO UPDATE SET last_tick_at = excluded.last_tick_at, last_tick_ok = excluded.last_tick_ok", iso, ok);
  db.close();
};

test("tick says nothing and asks Figma nothing while no check is due", async () => {
  setLast(new Date().toISOString());
  const r = await fp(["tick"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.equal(r.err, "");
  assert.equal(hits.length, 0);
});

test("a check missed while the Mac slept runs once, and says so", async () => {
  setLast(new Date(Date.now() - 3 * 86400000).toISOString());
  const r = await fp(["tick"]);
  assert.match(r.out, /tern: catching up on a check missed while the Mac was asleep/);
  assert.ok(hits.length > 0);
  // The failed check is recorded; the next wake does not repeat it within the retry delay.
  const before = hits.length;
  const again = await fp(["tick"]);
  assert.equal(again.out, "");
  assert.equal(hits.length, before);
});

test("status shows the schedule and the next check in the Mac's time and the project's time", async () => {
  setLast(new Date().toISOString());
  const r = await fp(["status"]);
  assert.match(r.out, /schedule: 06:00, 14:00, 22:00 every day, America\/Los_Angeles time/);
  assert.match(r.out, /next check: \w{3} \d+ \w{3} \d\d:00 (CEST|CET) \(Europe\/Berlin, your Mac\) · \w{3} \d+ \w{3} (06|14|22):00 (PDT|PST) \(America\/Los_Angeles\)/);
  const j = JSON.parse((await fp(["status", "--json"])).out);
  const s = j.projects[0].schedule;
  assert.equal(s.mode, "times");
  assert.equal(s.timezone, "America/Los_Angeles");
  assert.equal(s.local_timezone, "Europe/Berlin");
  assert.ok(Date.parse(s.next_check_at) > Date.now());
});

test("the background job wakes every 15 minutes for a scheduled project and --minutes overrides", async () => {
  const r = await fp(["launchd", "install"]);
  const xml = readFileSync(r.out.match(/Plist written to (\S+)\./)[1], "utf8");
  assert.match(xml, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.doesNotMatch(xml, /StartCalendarInterval/);
  assert.match(r.out, /wakes figpipe every 15 minutes/);
  assert.match(r.out, /launchctl bootout/);
  const o = await fp(["launchd", "plist", "--minutes", "5"]);
  assert.match(o.out, /<integer>300<\/integer>/);
});

test("config check and status refuse a bad schedule by field", async () => {
  const file = join(home, "bad.toml");
  writeFileSync(file, readFileSync(join(home, "projects", "tern.toml"), "utf8").replace('timezone = "America/Los_Angeles"', 'timezone = "Berlin"'));
  const r = await fp(["config", "check", file]);
  assert.equal(r.code, 1);
  assert.match(r.err, /schedule\.timezone: unknown time zone "Berlin"/);
});
