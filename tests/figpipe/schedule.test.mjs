// When a check is due: time zones, daylight saving, windows, days, catch-up after sleep, and the
// config that holds the schedule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, ConfigError } from "../../figpipe/lib/config.mjs";
import { zonedToUtc, zonedParts, scheduleOf, slotsOn, lastSlot, nextSlot, dueState, nextCheck, wakeMinutes, describe, fmtAt, machineZone, RETRY_MINUTES } from "../../figpipe/lib/schedule.mjs";
import { ternConfig } from "./helpers.mjs";
import { readFileSync } from "node:fs";
import { FIX } from "./helpers.mjs";

const Z = "Europe/Berlin";
const LA = "America/Los_Angeles";
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
const at = (s) => Date.parse(s);
const sched = (over = {}) => ({ mode: "times", timezone: LA, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], times: [], windows: [], poll_minutes: 10, ...over });
const times = (t, over = {}) => sched({ times: t, ...over });
const windows = (w, over = {}) => sched({ mode: "windows", windows: w, ...over });

test("wall-clock to instant: ordinary days, the spring-forward gap and the fall-back hour", () => {
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 2, h: 6, mi: 0 }, Z)), "2026-10-02T04:00Z"); // CEST, +2
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 12, d: 2, h: 6, mi: 0 }, Z)), "2026-12-02T05:00Z"); // CET, +1
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 2, h: 6, mi: 0 }, LA)), "2026-10-02T13:00Z"); // PDT, -7
  // Berlin 2026-03-29: 02:00 jumps to 03:00. 02:30 does not exist and happens when 03:30 does.
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 3, d: 29, h: 2, mi: 30 }, Z)), "2026-03-29T01:30Z");
  // Berlin 2026-10-25: 03:00 falls back to 02:00. 02:30 happens twice; the first one counts.
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 25, h: 2, mi: 30 }, Z)), "2026-10-25T00:30Z");
  // Los Angeles 2026-03-08 and 2026-11-01.
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 3, d: 8, h: 2, mi: 30 }, LA)), "2026-03-08T10:30Z");
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, LA)), "2026-11-01T08:30Z");
  // Round trip.
  const p = zonedParts(at("2026-10-25T00:30:00Z"), Z);
  assert.deepEqual([p.d, p.h, p.mi, p.dow], [25, 2, 30, 6]);
});

test("fixed times run at the same wall-clock time on both sides of a clock change", () => {
  const sc = times(["06:00"], { timezone: Z });
  const day = (y, mo, d) => slotsOn(sc, { y, mo, d });
  assert.deepEqual(day(2026, 10, 24).map(iso), ["2026-10-24T04:00Z"]);
  assert.deepEqual(day(2026, 10, 25).map(iso), ["2026-10-25T05:00Z"]); // 25 h after the day before
  assert.deepEqual(day(2026, 3, 28).map(iso), ["2026-03-28T05:00Z"]);
  assert.deepEqual(day(2026, 3, 29).map(iso), ["2026-03-29T04:00Z"]); // 23 h later
  // A time inside the gap or the doubled hour still gives exactly one check that day.
  assert.equal(slotsOn(times(["02:30"], { timezone: Z }), { y: 2026, mo: 3, d: 29 }).length, 1);
  assert.equal(slotsOn(times(["02:30"], { timezone: Z }), { y: 2026, mo: 10, d: 25 }).length, 1);
});

test("Tern's schedule: three checks in Los Angeles time; last and next check", () => {
  const sc = times(["06:00", "14:00", "22:00"]);
  const now = at("2026-10-03T05:31:00Z"); // Fri 22:31 PDT
  assert.equal(iso(lastSlot(sc, now)), "2026-10-03T05:00Z"); // Fri 22:00 PDT
  assert.equal(iso(nextSlot(sc, now)), "2026-10-03T13:00Z"); // Sat 06:00 PDT
  assert.equal(fmtAt(nextSlot(sc, now), LA), "Sat 3 Oct 06:00 PDT");
  assert.equal(fmtAt(nextSlot(sc, now), Z), "Sat 3 Oct 15:00 CEST");
  // Los Angeles leaves daylight saving on 2026-11-01 (09:00Z). Checks stay at 06:00, 14:00 and 22:00 on the clock.
  assert.equal(iso(nextSlot(sc, at("2026-11-01T20:00:00Z"))), "2026-11-01T22:00Z"); // 14:00 PST, UTC-8
  assert.equal(iso(nextSlot(sc, at("2026-11-02T07:00:00Z"))), "2026-11-02T14:00Z"); // 06:00 PST
});

test("windows: every N minutes from start to end, several windows, no duplicates", () => {
  const w = windows([{ start: "08:00", end: "19:00", every: 60 }], { timezone: Z, days: ["mon", "tue", "wed", "thu", "fri"] });
  const mon = slotsOn(w, { y: 2026, mo: 10, d: 5 });
  assert.equal(mon.length, 12); // 08:00 ... 19:00
  assert.equal(iso(mon[0]), "2026-10-05T06:00Z");
  assert.equal(iso(mon[11]), "2026-10-05T17:00Z");
  assert.deepEqual(slotsOn(w, { y: 2026, mo: 10, d: 3 }), []); // Saturday
  const two = windows([{ start: "08:00", end: "10:00", every: 60 }, { start: "09:00", end: "12:00", every: 90 }], { timezone: Z });
  // 08, 09, 10 and 09:00, 10:30, 12:00 -> 08, 09, 10, 10:30, 12 once each
  assert.deepEqual(slotsOn(two, { y: 2026, mo: 10, d: 5 }).map((t) => zonedParts(t, Z)).map((p) => `${p.h}:${String(p.mi).padStart(2, "0")}`), ["8:00", "9:00", "10:00", "10:30", "12:00"]);
  // A window across the clock change still has one slot per step.
  const dst = windows([{ start: "01:00", end: "05:00", every: 60 }], { timezone: Z });
  assert.equal(slotsOn(dst, { y: 2026, mo: 3, d: 29 }).length, 4); // 01, (02 -> 03 duplicate), 03, 04, 05
  assert.equal(slotsOn(dst, { y: 2026, mo: 10, d: 25 }).length, 5);
  // A one-point window is a single check.
  assert.equal(slotsOn(windows([{ start: "07:00", end: "07:00", every: 60 }]), { y: 2026, mo: 10, d: 5 }).length, 1);
});

test("days: a schedule on one weekday still finds last week's check and next week's", () => {
  const sc = times(["09:00"], { timezone: Z, days: ["mon"] });
  const sun = at("2026-10-04T12:00:00Z"); // Sunday
  assert.equal(iso(lastSlot(sc, sun)), "2026-09-28T07:00Z"); // Mon 28 Sep 09:00 CEST
  assert.equal(iso(nextSlot(sc, sun)), "2026-10-05T07:00Z");
  assert.equal(describe(sc), "09:00 Mon, Europe/Berlin time");
  assert.equal(describe(sched({ times: ["06:00"], days: ["mon", "tue", "wed", "thu", "fri"] })), "06:00 Mon-Fri, America/Los_Angeles time");
  assert.equal(describe(sched({ times: ["06:00", "22:00"] })), "06:00, 22:00 every day, America/Los_Angeles time");
});

test("due: on time, not twice, first check, and a failed check retried at the next wake", () => {
  const sc = times(["06:00", "14:00", "22:00"]);
  const slot = at("2026-10-02T13:00:00Z"); // 06:00 PDT
  // First check ever: due, and records a baseline.
  assert.deepEqual(dueState({ sc, last: null, now: slot }), { due: true, why: "first" });
  // Last check was the 22:00 one; 06:00 has just passed.
  const last = at("2026-10-02T05:00:30Z");
  assert.equal(dueState({ sc, last, now: slot - 1000 }).due, false);
  assert.deepEqual(dueState({ sc, last, now: slot + 5 * 60000 }), { due: true, why: "scheduled" });
  // The check ran at 06:03: nothing is due until 14:00.
  const ran = slot + 3 * 60000;
  assert.equal(dueState({ sc, last: ran, now: ran + 60000 }).due, false);
  assert.equal(dueState({ sc, last: ran, now: at("2026-10-02T20:59:00Z") }).due, false);
  assert.equal(dueState({ sc, last: ran, now: at("2026-10-02T21:00:00Z") }).due, true);
  // A failed check is retried after RETRY_MINUTES, not at the next slot.
  assert.equal(dueState({ sc, last: ran, lastOk: false, now: ran + (RETRY_MINUTES - 1) * 60000 }).due, false);
  assert.deepEqual(dueState({ sc, last: ran, lastOk: false, now: ran + RETRY_MINUTES * 60000 }), { due: true, why: "retry" });
});

test("catch-up: a Mac that slept through several checks runs one on wake, then waits for the next slot", () => {
  const sc = times(["06:00", "14:00", "22:00"]);
  const last = at("2026-10-03T05:01:00Z"); // Fri 22:01 PDT check
  // Wakes Sat 17:20 PDT: the 06:00 and 14:00 checks were missed.
  const wake = at("2026-10-04T00:20:00Z");
  assert.deepEqual(dueState({ sc, last, now: wake }), { due: true, why: "catch-up" });
  assert.equal(nextCheck({ sc, last, now: wake }).now, true);
  // After that one check, nothing more is owed for the missed ones.
  const ran = wake + 20000;
  assert.equal(dueState({ sc, last: ran, now: ran + 15 * 60000 }).due, false);
  assert.equal(iso(nextCheck({ sc, last: ran, now: ran + 15 * 60000 }).at), "2026-10-04T05:00Z"); // 22:00 PDT
  // Off for a whole week: still one check.
  assert.equal(dueState({ sc, last, now: last + 7 * 86400000 }).due, true);
});

test("catch-up across a clock change and for a window schedule", () => {
  const w = windows([{ start: "08:00", end: "19:00", every: 60 }], { timezone: Z, days: ["mon", "tue", "wed", "thu", "fri"] });
  // Friday 19:00 check ran; the Mac wakes Monday 2026-10-26 (clocks went back on the 25th) at 07:30 Berlin: nothing due.
  const last = at("2026-10-23T17:00:10Z");
  assert.equal(dueState({ sc: w, last, now: at("2026-10-26T06:30:00Z") }).due, false); // 07:30 CET
  assert.equal(dueState({ sc: w, last, now: at("2026-10-26T07:05:00Z") }).due, true); // 08:05 CET
  assert.equal(iso(nextCheck({ sc: w, last, now: at("2026-10-26T06:30:00Z") }).at), "2026-10-26T07:00Z"); // 08:00 CET, not 06:00Z
});

test("interval mode keeps the original poll behaviour, optionally limited to some days", () => {
  const sc = sched({ mode: "interval", poll_minutes: 10, timezone: Z });
  const last = at("2026-10-02T10:00:00Z");
  assert.equal(dueState({ sc, last, now: last + 9 * 60000 }).due, false);
  assert.equal(dueState({ sc, last, now: last + 9.6 * 60000 }).due, true); // 30 s tolerance, as before
  assert.equal(dueState({ sc, last, lastOk: false, now: last + 9.6 * 60000 }).due, true);
  const wk = sched({ mode: "interval", poll_minutes: 30, timezone: Z, days: ["mon", "tue", "wed", "thu", "fri"] });
  const fri = at("2026-10-02T20:00:00Z");
  assert.equal(dueState({ sc: wk, last: fri, now: at("2026-10-03T20:00:00Z") }).due, false); // Saturday
  assert.equal(iso(nextCheck({ sc: wk, last: fri, now: at("2026-10-03T20:00:00Z") }).at), "2026-10-04T22:00Z"); // Monday 00:00 CEST
  assert.equal(describe(sc), "every 10 min");
});

test("the wake interval follows the busiest project and never exceeds 15 minutes", async () => {
  const base = await ternConfig();
  const withSchedule = (s) => ({ ...base, schedule: s });
  assert.equal(wakeMinutes([base]), 10);
  assert.equal(wakeMinutes([withSchedule({ times: ["06:00"], windows: [], days: [] })]), 15);
  assert.equal(wakeMinutes([withSchedule({ times: [], windows: [{ start: "08:00", end: "19:00", every: 30 }], days: [] })]), 15);
  assert.equal(wakeMinutes([withSchedule({ times: [], windows: [{ start: "08:00", end: "19:00", every: 5 }], days: [] }), base]), 5);
});

test("schedule config: defaults, the machine's zone, and refusals that name the field", async () => {
  const toml = readFileSync(`${FIX}/tern.toml`, "utf8").replace("__REPO__", "/tmp/tern");
  const parse = (extra) => parseConfig(toml + "\n" + extra, "t.toml");
  const none = parse("");
  assert.equal(scheduleOf(none).mode, "interval");
  assert.equal(scheduleOf(none).timezone, machineZone());
  assert.equal(scheduleOf(none).days.length, 7);
  const ok = parse(`[schedule]\ntimezone = "Europe/Berlin"\ndays = ["mon","tue","wed","thu","fri"]\nwindows = [{ start = "08:00", end = "12:00", every = 60 }, { start = "13:00", end = "19:00", every = 30 }]`);
  assert.equal(scheduleOf(ok).mode, "windows");
  assert.equal(scheduleOf(parse(`[schedule]\ntimes = ["22:00", "06:00"]`)).times.join(), "06:00,22:00");
  const refused = (extra) => {
    try {
      parse(extra);
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      return e.errors.join("\n");
    }
    assert.fail("accepted");
  };
  assert.match(refused(`[schedule]\ntimezone = "Mars/Olympus"`), /schedule\.timezone: unknown time zone "Mars\/Olympus"/);
  assert.match(refused(`[schedule]\ntimes = ["25:00"]`), /schedule\.times\[0\]: "25:00" is not valid \(HH:MM, 24-hour\)/);
  assert.match(refused(`[schedule]\ntimes = ["06:00"]\nwindows = [{ start = "08:00", end = "09:00", every = 60 }]`), /use times or windows, not both/);
  assert.match(refused(`[schedule]\nwindows = [{ start = "19:00", end = "08:00", every = 60 }]`), /schedule\.windows\[0\]: end 08:00 is before start 19:00/);
  assert.match(refused(`[schedule]\nwindows = [{ start = "08:00", end = "19:00", every = 2 }]`), /every: 2 is below 5/);
  assert.match(refused(`[schedule]\nwindows = [{ start = "08:00", end = "19:00" }]`), /every: required/);
  assert.match(refused(`[schedule]\ndays = ["mon", "funday"]`), /schedule\.days\[1\]: "funday" is not one of/);
  assert.match(refused(`[schedule]\ndays = []`), /name at least one day/);
  assert.match(refused(`[schedule]\ndays = ["mon", "mon"]`), /lists a day twice/);
  assert.match(refused(`[schedule]\ncron = "0 6 * * *"`), /schedule\.cron: unknown setting/);
});
