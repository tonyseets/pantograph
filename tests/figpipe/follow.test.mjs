// Follow mode: working blocks derived from the designers' activity, cached and refreshed on a
// cadence, the fallback when there is too little activity, the check before the user's day starts,
// daylight saving in both zones, doctor's sleep advice and the config that holds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigError } from "../../figpipe/lib/config.mjs";
import { zonedToUtc, zonedParts, scheduleOf, slotsOn, nextSlot, dueState, nextCheck, wakeMinutes, describe } from "../../figpipe/lib/schedule.mjs";
import { deriveBlocks, needsRefresh, refreshBlocks, loadDerived, scheduleFor, followView, wakeCommand, catchUps, AMPHETAMINE } from "../../figpipe/lib/follow.mjs";
import { toEvents } from "../../figpipe/lib/activity.mjs";
import { openDb } from "../../figpipe/lib/db.mjs";
import { doctor } from "../../figpipe/lib/setup.mjs";
import { ternConfig, fakeClient, figmaState, load, tempHome, gitRepo, LIVE } from "./helpers.mjs";

process.env.TZ = "America/Los_Angeles";
tempHome();
const Z = "Europe/Berlin";
const LA = "America/Los_Angeles";
const NOW = Date.parse("2026-10-02T12:00:00Z"); // Friday
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
const at = (s) => Date.parse(s);

// A designer in Berlin: one save every hour at :20 on each weekday of the `weeks` weeks before `end`.
function berlinWeeks({ end = NOW, weeks = 3, hours = [9, 10, 11, 12, 13, 14, 15, 16, 17], who = "Mara" } = {}) {
  const out = [];
  for (let i = 1; i <= weeks * 7; i++) {
    const d = new Date(end - i * DAY);
    if ((d.getUTCDay() + 6) % 7 > 4) continue;
    for (const h of hours) out.push({ at: zonedToUtc({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h, mi: 20 }, Z), kind: "edit", who, id: "1" });
  }
  return out.sort((a, b) => a.at - b.at);
}
const asVersions = (events) => events.map((e, i) => ({ id: String(i), created_at: new Date(e.at).toISOString(), user: { id: e.id, handle: e.who } }));

const cfg = (extra = {}) => {
  const s = { mode: "follow", every: 60, my_day_starts: "08:00", my_timezone: LA, refresh_days: 7, timezone: "", times: [], windows: [], days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], ...extra };
  return { schedule: s, batching: { poll_minutes: 10 }, project: { slug: "tern" } };
};
const block = (a, b) => ({ start: a * 60, end: b * 60 });
const derived = (blocks, over = {}) => ({ timezone: Z, days: ["mon", "tue", "wed", "thu", "fri"], blocks, fallback: false, derived_at: new Date(NOW).toISOString(), reason: "", events: 200, active_days: 15, ...over });

// ---- derivation ------------------------------------------------------------------------------------

test("derive: the designers' blocks, work days and zone come from their activity, yours left out", () => {
  const mine = [{ created_at: "2026-10-01T03:00:00Z", user: { id: "9", handle: "tony" } }, { created_at: "2026-09-30T03:00:00Z", user: { id: "9", handle: "tony" } }];
  const { events, own } = toEvents({ versions: [...asVersions(berlinWeeks()), ...mine], me: { id: "9", handle: "tony" }, days: 30, now: NOW });
  assert.equal(own, 2);
  const d = deriveBlocks({ events, userTz: LA });
  assert.equal(d.fallback, false);
  assert.equal(d.timezone, Z);
  assert.deepEqual(d.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.deepEqual(d.blocks, [{ start: 9 * 60, end: 18 * 60 }]);
  assert.equal(d.active_days, 15);
  // A pinned zone is used as given.
  assert.equal(deriveBlocks({ events, pinnedTz: "Europe/London", userTz: LA }).timezone, "Europe/London");
});

test("fallback: too few events or days give 08:00-20:00 hourly in the guessed zone, and say why", () => {
  // Three events: no guess, so the user's zone.
  const few = berlinWeeks({ weeks: 1 }).slice(0, 3);
  const f = deriveBlocks({ events: few, userTz: LA });
  assert.equal(f.fallback, true);
  assert.equal(f.timezone, LA);
  assert.match(f.reason, /only 3 edits, comments and ready marks on 1 days/);
  // Plenty of events on two days: enough to guess the zone, too few days to trust blocks.
  const burst = berlinWeeks({ weeks: 1 }).slice(0, 18);
  const b = deriveBlocks({ events: burst, userTz: LA });
  assert.equal(b.fallback, true);
  assert.equal(b.timezone, Z);
  // The schedule built from a fallback row: 60-minute checks 08:00-20:00 in that zone.
  const sc = scheduleOf(cfg(), { ...b, derived_at: new Date(NOW).toISOString() });
  assert.equal(sc.mode, "follow");
  assert.equal(sc.timezone, Z);
  assert.deepEqual(sc.windows, [{ start: "08:00", end: "20:00", every: 60 }]);
  assert.equal(sc.follow.fallback, true);
  assert.match(describe(sc), /fallback, too little activity/);
  // Before anything was read: the same blocks in your zone.
  const none = scheduleOf(cfg(), null);
  assert.equal(none.timezone, LA);
  assert.deepEqual(none.windows, [{ start: "08:00", end: "20:00", every: 60 }]);
  assert.match(followView(none, NOW).reason, /no activity read yet/);
});

// ---- the schedule ----------------------------------------------------------------------------------

test("follow: checks every `every` minutes inside the blocks on the days they work, and nowhere else", () => {
  const sc = scheduleOf(cfg({ every: 60 }), derived([block(9, 18)]));
  const mon = slotsOn(sc, { y: 2026, mo: 10, d: 5 }).map((t) => clock(t, Z));
  assert.deepEqual(mon, ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
  // Saturday in Berlin: no work, and no pre-day check on that date either.
  assert.deepEqual(slotsOn(sc, { y: 2026, mo: 10, d: 3 }), []);
  // Two blocks, every 90 minutes from each block's start.
  const two = scheduleOf(cfg({ every: 90, my_day_starts: "08:00" }), derived([block(9, 12), block(14, 18)]));
  assert.deepEqual(slotsOn(two, { y: 2026, mo: 10, d: 5 }).map((t) => clock(t, Z)).filter((x) => x !== "15:45"), ["09:00", "10:30", "12:00", "14:00", "15:30", "17:00"]);
  // A narrower configured `days` narrows the derived ones.
  assert.deepEqual(scheduleOf(cfg({ days: ["mon", "tue"] }), derived([block(9, 18)])).days, ["mon", "tue"]);
  // The wake interval stays 15 minutes unless `every` is shorter.
  assert.equal(wakeMinutes([cfg({ every: 60 })]), 15);
  assert.equal(wakeMinutes([cfg({ every: 10 })]), 10);
});
const clock = (ms, tz) => {
  const p = zonedParts(ms, tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
};

test("pre-day check: a block check 60-90 minutes before your day counts; otherwise one is added 75 minutes ahead", () => {
  const sunday = at("2026-10-05T00:00:00Z"); // Sunday evening in Los Angeles
  // Berlin 09:00-18:00 is 00:00-09:00 in Los Angeles: the 07:00 check is 60 minutes before 08:00. Nothing is added.
  const covered = scheduleOf(cfg(), derived([block(9, 18)]));
  const vc = followView(covered, sunday);
  assert.deepEqual(vc.pre_day, { my_day_starts: "08:00", time: "07:00", extra_check: false });
  assert.equal(slotsOn(covered, { y: 2026, mo: 10, d: 5 }).length, 10);
  // Berlin 09:00-12:00 ends at 03:00 in Los Angeles: an extra check at 06:45, which is 15:45 in Berlin.
  const early = scheduleOf(cfg(), derived([block(9, 12)]));
  const mon = slotsOn(early, { y: 2026, mo: 10, d: 5 });
  assert.equal(mon.length, 5); // 09, 10, 11, 12 and your Monday's 06:45
  assert.equal(iso(mon[4]), "2026-10-05T13:45Z");
  assert.deepEqual(followView(early, sunday).pre_day, { my_day_starts: "08:00", time: "06:45", extra_check: true });
  // Checks every 30 minutes and a day that starts at 08:30: 07:30 is inside the 60-90 minute band.
  const half = scheduleOf(cfg({ every: 30, my_day_starts: "08:30" }), derived([block(9, 18)]));
  assert.equal(followView(half, sunday).pre_day.extra_check, false);
  // Friday afternoon: nothing over the weekend, the next check is Monday morning in Berlin.
  const friday = at("2026-10-02T20:00:00Z");
  assert.equal(followView(early, friday).pre_day.time, "06:45");
  assert.equal(iso(nextSlot(early, friday)), "2026-10-05T07:00Z");
});

test("block checks and the pre-day check keep their own zone's wall-clock time across daylight saving", () => {
  const sc = scheduleOf(cfg(), derived([block(9, 12)]));
  // Los Angeles falls back on 2026-11-01: the 06:45 check moves from 13:45Z to 14:45Z.
  const before = slotsOn(sc, { y: 2026, mo: 10, d: 30 }).filter((t) => clock(t, LA) === "06:45");
  const after = slotsOn(sc, { y: 2026, mo: 11, d: 3 }).filter((t) => clock(t, LA) === "06:45");
  assert.deepEqual([before.length, after.length], [1, 1]);
  assert.equal(iso(before[0]).slice(11), "13:45Z");
  assert.equal(iso(after[0]).slice(11), "14:45Z");
  // Berlin springs forward on 2026-03-29, Los Angeles already did on 03-08. The designers' 09:00 stays 09:00.
  const nine = (d) => slotsOn(sc, { y: 2026, mo: 3, d }).find((t) => clock(t, Z) === "09:00");
  assert.equal(iso(nine(27)).slice(11), "08:00Z"); // CET
  assert.equal(iso(nine(30)).slice(11), "07:00Z"); // CEST
  // The gap between the two zones is 9 hours, 8 between the two clock changes, 9 again after.
  assert.equal(followView(sc, at("2026-03-02T12:00:00Z")).blocks[0].yours, "00:00-03:00");
  assert.equal(followView(sc, at("2026-03-15T12:00:00Z")).blocks[0].yours, "01:00-04:00");
  assert.equal(followView(sc, at("2026-04-05T12:00:00Z")).blocks[0].yours, "00:00-03:00");
  // Across the Los Angeles change every weekday has exactly one pre-day check, none skipped, none doubled.
  const found = [];
  for (let i = 0; i < 16; i++) {
    const d = new Date(Date.UTC(2026, 9, 24 + i));
    for (const t of slotsOn(sc, { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() })) if (clock(t, LA) === "06:45") found.push(zonedParts(t, LA).d + "/" + zonedParts(t, LA).mo);
  }
  assert.deepEqual(found, ["26/10", "27/10", "28/10", "29/10", "30/10", "2/11", "3/11", "4/11", "5/11", "6/11"]);
});

test("due, catch-up and next check work on follow like on windows", () => {
  const sc = scheduleOf(cfg(), derived([block(9, 18)]));
  const last = at("2026-10-05T07:01:00Z"); // Mon 09:01 Berlin
  const wake = at("2026-10-05T08:05:00Z"); // 10:05 Berlin: the 10:00 check is 5 minutes old
  assert.deepEqual(dueState({ sc, last, now: wake }), { due: true, why: "scheduled" });
  assert.equal(dueState({ sc, last: at("2026-10-05T08:01:00Z"), now: wake }).due, false);
  // Asleep through the afternoon: one catch-up.
  assert.deepEqual(dueState({ sc, last, now: at("2026-10-05T12:30:00Z") }), { due: true, why: "catch-up" });
  const n = nextCheck({ sc, last: at("2026-10-05T08:01:00Z"), now: wake });
  assert.equal(iso(n.at), "2026-10-05T09:00Z");
  // Friday evening in Berlin: the next check is Monday 09:00 there.
  assert.equal(iso(nextCheck({ sc, last: at("2026-10-02T16:01:00Z"), now: at("2026-10-02T17:00:00Z") }).at), "2026-10-05T07:00Z");
});

// ---- the cache and its cadence ------------------------------------------------------------------------

const slug = "tern";
function clientFor(events, { failing = false } = {}) {
  const calls = [];
  const c = {
    ...fakeClient(figmaState()),
    me: async () => load("me.json"),
    get: async (path) => (calls.push(path), failing ? Promise.reject(new Error("Figma said no")) : { versions: path.includes(LIVE) ? asVersions(events) : [] }),
    comments: async () => (calls.push("comments"), { comments: [] }),
    calls,
  };
  return c;
}
const followConfig = (extra = "") => ternConfig("/tmp/tern-repo", (t) => t + `\n[schedule]\nmode = "follow"\nmy_timezone = "America/Los_Angeles"\n${extra}`);

test("refresh: derived once, reused for refresh_days, then recomputed, never more than once a day", async () => {
  const config = await followConfig("refresh_days = 7\n");
  const db = openDb(":memory:");
  const events = berlinWeeks();
  const client = clientFor(events);
  assert.equal(needsRefresh({ row: loadDerived(db, slug), config, now: NOW }), true);
  const r = await refreshBlocks({ db, config, client, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.fallback, false);
  const callsFirst = client.calls.length;
  assert.ok(callsFirst > 0 && client.calls.every((c) => /versions|comments/.test(c)), "only version and comment lists are read");
  const row = loadDerived(db, slug);
  assert.deepEqual(row.blocks, [{ start: 540, end: 1080 }]);
  assert.equal(row.timezone, Z);
  // The schedule built from the cache.
  const sc = scheduleFor(db, config);
  assert.equal(sc.timezone, Z);
  assert.deepEqual(sc.windows, [{ start: "09:00", end: "18:00", every: 60 }]);
  // Day 1 to day 6: no refresh. Day 7: refresh.
  for (const d of [0.5, 1, 3, 6.9]) assert.equal(needsRefresh({ row, config, now: NOW + d * DAY }), false, `day ${d}`);
  assert.equal(needsRefresh({ row, config, now: NOW + 7 * DAY }), true);
  // refresh_days = 1 still means one derivation a day at most.
  const daily = await followConfig("refresh_days = 1\n");
  assert.equal(needsRefresh({ row, config: daily, now: NOW + 0.9 * DAY }), false);
  assert.equal(needsRefresh({ row, config: daily, now: NOW + 1 * DAY }), true);
  // Not follow mode: never.
  assert.equal(needsRefresh({ row: null, config: await ternConfig("/tmp/tern-repo"), now: NOW }), false);
});

test("refresh: a fallback result is tried again after a day, a failed read after an hour, and the old blocks stay in use", async () => {
  const config = await followConfig();
  const db = openDb(":memory:");
  // Too little activity: a fallback, stored with its reason.
  await refreshBlocks({ db, config, client: clientFor(berlinWeeks({ weeks: 1 }).slice(0, 3)), now: NOW });
  let row = loadDerived(db, slug);
  assert.equal(row.fallback, true);
  assert.match(row.reason, /only 3 edits/);
  assert.equal(scheduleFor(db, config).follow.fallback, true);
  assert.equal(needsRefresh({ row, config, now: NOW + 3 * 3600000 }), false);
  assert.equal(needsRefresh({ row, config, now: NOW + DAY }), true);
  // The designers got busy: the next derivation replaces the fallback.
  await refreshBlocks({ db, config, client: clientFor(berlinWeeks()), now: NOW + DAY });
  row = loadDerived(db, slug);
  assert.equal(row.fallback, false);
  assert.equal(scheduleFor(db, config).follow.fallback, false);
  // A failed read keeps those blocks, says so, and is retried after an hour.
  const t = NOW + 9 * DAY;
  const bad = await refreshBlocks({ db, config, client: clientFor([], { failing: true }), now: t });
  assert.equal(bad.ok, false);
  row = loadDerived(db, slug);
  assert.equal(row.ok, false);
  assert.match(row.error, /Figma said no/);
  assert.deepEqual(row.blocks, [{ start: 540, end: 1080 }]);
  assert.equal(scheduleFor(db, config).follow.fallback, false);
  assert.equal(needsRefresh({ row, config, now: t + 30 * 60000 }), false);
  assert.equal(needsRefresh({ row, config, now: t + 61 * 60000 }), true);
  // Never derived and the first read failed: fallback blocks, the failure as the reason.
  const fresh = openDb(":memory:");
  await refreshBlocks({ db: fresh, config, client: clientFor([], { failing: true }), now: NOW });
  const sc = scheduleFor(fresh, config);
  assert.equal(sc.follow.fallback, true);
  assert.match(sc.follow.reason, /could not read the designers' activity \(Figma said no\)/);
});

test("refresh: pinning another designer zone re-derives, and the old blocks are not used for the new zone meanwhile", async () => {
  const db = openDb(":memory:");
  const plain = await followConfig();
  await refreshBlocks({ db, config: plain, client: clientFor(berlinWeeks()), now: NOW });
  const pinned = await followConfig('timezone = "Europe/London"\n');
  const sc = scheduleFor(db, pinned);
  assert.equal(sc.timezone, "Europe/London");
  assert.equal(sc.follow.fallback, true);
  assert.equal(needsRefresh({ row: loadDerived(db, slug), config: pinned, now: NOW + 2 * DAY }), true);
});

// ---- status, wake command, doctor -------------------------------------------------------------------------

test("status view: blocks in the designers' time and yours, when derived, the pre-day check", () => {
  const sc = scheduleOf(cfg(), derived([block(9, 18)]));
  const v = followView(sc, at("2026-10-05T00:00:00Z"));
  assert.deepEqual(v.blocks, [{ designer: "09:00-18:00", yours: "00:00-09:00" }]);
  assert.equal(v.text, "09:00-18:00 Europe/Berlin = 00:00-09:00 America/Los_Angeles");
  assert.equal(v.derived_at, new Date(NOW).toISOString());
  assert.equal(v.fallback, false);
  assert.deepEqual(v.days, ["mon", "tue", "wed", "thu", "fri"]);
});

test("wake command: one minute after the check before your day starts, on the days that have one", () => {
  const covered = scheduleOf(cfg(), derived([block(9, 18)]));
  assert.deepEqual(wakeCommand(covered, NOW), { days: "MTWRF", time: "07:01:00", command: "sudo pmset repeat wakeorpoweron MTWRF 07:01:00" });
  const early = scheduleOf(cfg({ my_day_starts: "09:30" }), derived([block(9, 12)]));
  assert.equal(wakeCommand(early, NOW).command, "sudo pmset repeat wakeorpoweron MTWRF 08:16:00");
  assert.equal(wakeCommand(scheduleOf({ schedule: { times: ["06:00"], windows: [], days: [] }, batching: {} }), NOW), null);
});

test("catch-up lines in the log are counted per project and within the window", () => {
  const file = join(mkdtempSync(join(tmpdir(), "figpipe-log-")), "figpipe.log");
  const line = (t, s) => `${new Date(t).toISOString()} ${s}`;
  writeFileSync(file, [line(NOW - DAY, "tern: catching up on a check missed while the Mac was asleep"), line(NOW - 3 * DAY, "other: catching up on a check missed while the Mac was asleep"), line(NOW - 20 * DAY, "tern: catching up on a check missed while the Mac was asleep"), line(NOW - 2 * DAY, "tern: 2 new events")].join("\n"));
  assert.equal(catchUps(file, "tern", { now: NOW }).length, 1);
  assert.equal(catchUps(file, "tern", { now: NOW, days: 30 }).length, 2);
  assert.deepEqual(catchUps(join(tmpdir(), "no-such-log"), "tern", { now: NOW }), []);
});

async function doctorFor({ log }) {
  const { repo } = gitRepo(mkdtempSync(join(tmpdir(), "figpipe-fdoc-")));
  process.env.FIGPIPE_TEST_TOKEN = "t";
  process.env.FIGPIPE_CLAUDE_BIN = "/usr/bin/true";
  const config = await ternConfig(repo, (t) => t.replace('autonomy = "build"', 'autonomy = "notify"') + `\n[schedule]\nmode = "follow"\nmy_timezone = "America/Los_Angeles"\n`);
  const db = openDb(":memory:");
  await refreshBlocks({ db, config, client: clientFor(berlinWeeks()), now: NOW });
  const dir = mkdtempSync(join(tmpdir(), "figpipe-doc-"));
  const logFile = join(dir, "figpipe.log");
  writeFileSync(logFile, log.map((t) => `${new Date(t).toISOString()} tern: catching up on a check missed while the Mac was asleep`).join("\n"));
  const client = { ...fakeClient(figmaState()), info: { rate_limit_type: "high" }, me: async () => load("me.json") };
  return doctor({ config, db, client, clock: () => NOW, launchdPlist: "/nonexistent.plist", logFile });
}

test("doctor in follow mode reports the derived blocks and says nothing about sleep while the Mac is awake", async () => {
  const lines = await doctorFor({ log: [] });
  const by = (c) => lines.find((l) => l.check === c);
  assert.match(by("Schedule").detail, /follow the designers: every 60 min 09:00-18:00 Mon-Fri, Europe\/Berlin time/);
  assert.match(by("Follow blocks").detail, /09:00-18:00 Europe\/Berlin = 00:00-09:00 America\/Los_Angeles, derived 2026-10-02 from \d+ events on 15 days/);
  assert.equal(by("Mac asleep at check times"), undefined);
  assert.equal(by("Schedule vs activity"), undefined, "follow mode re-derives its blocks, so it has no drift to report");
  assert.ok(!JSON.stringify(lines).includes("Amphetamine"));
});

test("doctor suggests keeping the Mac awake first and the wake command second, only after repeated catch-ups", async () => {
  const lines = await doctorFor({ log: [NOW - DAY, NOW - 3 * DAY, NOW - 6 * DAY] });
  const w = lines.find((l) => l.check === "Mac asleep at check times");
  assert.equal(w.status, "warn");
  assert.match(w.detail, /3 checks in the last 14 days/);
  assert.ok(w.fix.startsWith(`Keep the Mac awake with an app like Amphetamine (${AMPHETAMINE}).`));
  assert.match(w.fix, /Alternative: `sudo pmset repeat wakeorpoweron MTWRF 07:01:00`/);
  assert.match(w.fix, /needs your password and works best on power/);
  // Two catch-ups are an ordinary week, not a habit.
  const few = await doctorFor({ log: [NOW - DAY, NOW - 3 * DAY] });
  assert.equal(few.find((l) => l.check === "Mac asleep at check times"), undefined);
});

// ---- config ------------------------------------------------------------------------------------------------

test("config: follow mode and its settings", async () => {
  const c = await followConfig('every = 30\nmy_day_starts = "07:30"\nrefresh_days = 3\ntimezone = "Europe/Berlin"\n');
  assert.deepEqual([c.schedule.mode, c.schedule.every, c.schedule.my_day_starts, c.schedule.refresh_days, c.schedule.timezone], ["follow", 30, "07:30", 3, "Europe/Berlin"]);
  const d = await followConfig();
  assert.deepEqual([d.schedule.every, d.schedule.my_day_starts, d.schedule.refresh_days, d.schedule.my_timezone], [60, "08:00", 7, "America/Los_Angeles"]);
  const bad = async (extra, re) => await assert.rejects(followConfig(extra), (e) => e instanceof ConfigError && re.test(e.message));
  await assert.rejects(ternConfig("/tmp/tern-repo", (t) => t + '\n[schedule]\nmode = "follow"\nmy_timezone = "Los Angeles"\n'), /unknown time zone "Los Angeles"/);
  await bad("every = 2\n", /schedule\.every: 2 is below 5/);
  await bad('my_day_starts = "8am"\n', /schedule\.my_day_starts/);
  await bad("refresh_days = 0\n", /schedule\.refresh_days: 0 is below 1/);
  await bad('times = ["06:00"]\n', /mode = "follow" takes its blocks from activity/);
  await assert.rejects(ternConfig("/tmp/tern-repo", (t) => t + '\n[schedule]\nmode = "sometimes"\n'), /schedule\.mode/);
  await assert.rejects(ternConfig("/tmp/tern-repo", (t) => t + '\n[schedule]\nmode = "times"\n'), /mode = "times" needs at least one time/);
  // The existing modes are unchanged and may name themselves.
  const t = await ternConfig("/tmp/tern-repo", (x) => x + '\n[schedule]\nmode = "times"\ntimes = ["06:00"]\n');
  assert.equal(scheduleOf(t).mode, "times");
});
