// Follow mode through the command line: tick derives the designers' blocks once and reuses them,
// status shows them in both zones with the next check, activity quotes what follow would do, and
// the background job still wakes every 15 minutes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { tempHome, FIX, gitRepo, load } from "./helpers.mjs";
import { openDb } from "../../figpipe/lib/db.mjs";
import { zonedToUtc } from "../../figpipe/lib/schedule.mjs";

const home = tempHome();
const BIN = new URL("../../figpipe/figpipe.mjs", import.meta.url).pathname;
const Z = "Europe/Berlin";
let server;
let base;
const hits = [];

// A designer in Berlin saving a version every hour from 09:20 to 17:20 on weekdays, for three weeks.
function versions() {
  const out = [];
  for (let i = 1; i <= 21; i++) {
    const d = new Date(Date.now() - i * 86400000);
    if ((d.getUTCDay() + 6) % 7 > 4) continue;
    for (let h = 9; h <= 17; h++) out.push({ id: `${i}-${h}`, created_at: new Date(zonedToUtc({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h, mi: 20 }, Z)).toISOString(), user: { id: "1", handle: "Mara" } });
  }
  return out;
}

before(async () => {
  // Figma serves the version and comment lists and who the token is; every other call is refused, so a
  // check that goes on to read the file fails after it derived the blocks.
  server = createServer((req, res) => {
    hits.push(req.url);
    const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (/\/versions/.test(req.url)) return json({ versions: req.url.includes("Tn7LiveDemoKey0q2Wx4Yz") ? versions() : [] });
    if (/\/comments/.test(req.url)) return json({ comments: [] });
    if (req.url.startsWith("/v1/me")) return json(load("me.json"));
    res.writeHead(403).end('{"err":"no"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { repo } = gitRepo(mkdtempSync(join(tmpdir(), "figpipe-follow-")));
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(
    join(home, "projects", "tern.toml"),
    readFileSync(join(FIX, "tern.toml"), "utf8").replace("__REPO__", repo).replace('autonomy = "build"', 'autonomy = "notify"') + `\n[schedule]\nmode = "follow"\nevery = 60\nmy_day_starts = "08:00"\nmy_timezone = "America/Los_Angeles"\n`,
  );
});
after(() => server.close());

const fp = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, FIGPIPE_HOME: home, FIGMA_API_BASE: base, FIGPIPE_TEST_TOKEN: "t", FIGPIPE_NO_NOTIFY: "1", TZ: "America/Los_Angeles" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end();
    child.on("exit", (code) => resolve({ code, out, err }));
  });
const versionHits = () => hits.filter((u) => /\/versions/.test(u)).length;

test("config check accepts follow mode", async () => {
  const r = await fp(["config", "check", "tern"]);
  assert.equal(r.code, 0, r.err + r.out);
});

test("status before the first check: the fallback blocks in your zone, saying nothing was read yet", async () => {
  const r = await fp(["status"]);
  assert.match(r.out, /schedule: follow the designers: every 60 min 08:00-20:00 every day, America\/Los_Angeles time \(fallback/);
  assert.match(r.out, /blocks: 08:00-20:00 America\/Los_Angeles, a fallback \(no activity read yet\)/);
  assert.match(r.out, /next check: due now/);
});

test("the first check derives the blocks from the version and comment lists only", async () => {
  const r = await fp(["tick"]);
  assert.match(r.out, /tern: follow: working blocks 09:00-18:00 Europe\/Berlin from \d+ events on \d+ days/);
  assert.ok(versionHits() > 0);
  assert.ok(hits.filter((u) => /\/versions|\/comments/.test(u)).length >= 2);
  const db = openDb();
  const row = db.get("SELECT * FROM follow_blocks WHERE project = 'tern'");
  db.close();
  assert.equal(row.ok, 1);
  assert.equal(row.fallback, 0);
  assert.equal(row.timezone, Z);
  assert.deepEqual(JSON.parse(row.blocks), [{ start: 540, end: 1080 }]);
});

test("another check the same day reuses the cached blocks and does not read the lists again for them", async () => {
  const before = versionHits();
  const r = await fp(["tick", "--project", "tern"]);
  assert.doesNotMatch(r.out, /follow: working blocks/);
  // The check itself reads versions once per watched file (live and stale copy); the derivation would add as many again.
  const per = versionHits() - before;
  assert.ok(per <= 2, `${per} version reads`);
});

test("status shows the blocks in both zones, when they were derived and the next check", async () => {
  const r = await fp(["status"]);
  assert.match(r.out, /schedule: follow the designers: every 60 min 09:00-18:00 Mon-Fri, Europe\/Berlin time, plus a check before your 08:00 America\/Los_Angeles day starts/);
  assert.match(r.out, /blocks: 09:00-18:00 Europe\/Berlin = 00:00-09:00 America\/Los_Angeles, derived just now from \d+ events on \d+ days; check at 07:00 before your 08:00 start/);
  assert.match(r.out, /next check: \w{3} \d+ \w{3} \d\d:\d\d P[DS]T \(America\/Los_Angeles, your Mac\) · \w{3} \d+ \w{3} \d\d:\d\d (CEST|CET) \(Europe\/Berlin\)/);
  const s = JSON.parse((await fp(["status", "--json"])).out).projects[0].schedule;
  assert.equal(s.mode, "follow");
  assert.equal(s.follow.fallback, false);
  assert.deepEqual(s.follow.blocks, [{ designer: "09:00-18:00", yours: "00:00-09:00" }]);
  assert.equal(s.follow.timezone, Z);
  assert.equal(s.wake_command.command, "sudo pmset repeat wakeorpoweron MTWRF 07:01:00");
  assert.ok(Date.parse(s.next_check_at) > Date.now() - 20 * 60000);
});

test("activity quotes what follow mode would do, in both zones", async () => {
  const r = await fp(["activity", "--project", "tern", "--user-tz", "America/Los_Angeles"]);
  assert.match(r.out, /Follow the designers \(recommended\): every 60 min 09:00-18:00 Europe\/Berlin = 00:00-09:00 America\/Los_Angeles, Mon-Fri; a check already falls before your 08:00 start\./);
  const j = JSON.parse((await fp(["activity", "--project", "tern", "--user-tz", "America/Los_Angeles", "--json"])).out);
  assert.equal(j.follow.fallback, false);
  assert.equal(j.follow.pre_day.time, "07:00");
});

test("the background job still wakes every 15 minutes; follow needs no launchd change", async () => {
  const r = await fp(["launchd", "install"]);
  const xml = readFileSync(r.out.match(/Plist written to (\S+)\./)[1], "utf8");
  assert.match(xml, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.doesNotMatch(xml, /StartCalendarInterval/);
});
