// When designers work: read from version and comment timestamps, in their time and the user's,
// and the schedule proposed from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedToUtc } from "../../figpipe/lib/schedule.mjs";
import { toEvents, histogram, blocks, workDays, inferZone, suggest, suggestionToml, lateness, analyse, shiftBlock, fmtBlock, fetchActivity } from "../../figpipe/lib/activity.mjs";
import { parseConfig } from "../../figpipe/lib/config.mjs";
import { readFileSync } from "node:fs";
import { FIX } from "./helpers.mjs";

const Z = "Europe/Berlin";
const LA = "America/Los_Angeles";
const NOW = Date.parse("2026-10-02T12:00:00Z");

// A designer in Berlin: one event every hour from 09:00 to 17:59 on each weekday of the three weeks before NOW.
function berlinWeek({ who = "Mara", hours = [9, 10, 11, 12, 13, 14, 15, 16, 17], weeks = 3 } = {}) {
  const out = [];
  for (let i = 1; i <= weeks * 7; i++) {
    const d = new Date(NOW - i * 86400000);
    const dow = (d.getUTCDay() + 6) % 7;
    if (dow > 4) continue;
    for (const h of hours) out.push({ at: zonedToUtc({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h, mi: 20 }, Z), kind: "edit", who, id: who });
  }
  return out.sort((a, b) => a.at - b.at);
}

test("events: your own saves and comments are left out, old ones too", () => {
  const { events, own } = toEvents({
    versions: [{ created_at: "2026-10-01T10:00:00Z", user: { id: "9", handle: "tony" } }, { created_at: "2026-10-01T11:00:00Z", user: { id: "1", handle: "Mara" } }, { created_at: "2026-07-01T11:00:00Z", user: { id: "1", handle: "Mara" } }],
    comments: [{ created_at: "2026-10-01T12:00:00Z", user: { id: "1", handle: "Mara" } }, { created_at: "2026-10-01T13:00:00Z", user: { id: "9", handle: "x" } }],
    me: { id: "9", handle: "tony" },
    days: 30,
    now: NOW,
  });
  assert.equal(own, 2);
  assert.deepEqual(events.map((e) => [e.kind, e.who]), [["edit", "Mara"], ["comment", "Mara"]]);
});

test("the histogram counts days, not events, so a burst of comments is not a habit", () => {
  const ev = berlinWeek({ hours: [10] });
  for (let i = 0; i < 40; i++) ev.push({ ...ev[0], at: ev[0].at + i * 1000 });
  const h = histogram(ev, Z);
  assert.equal(h.hours[10], 15); // 15 weekdays in three weeks
  assert.equal(h.activeDays, 15);
  assert.equal(h.dows.slice(0, 5).every((n) => n === 3), true);
  assert.equal(h.dows[5] + h.dows[6], 0);
  // The same instants read in Los Angeles land at 01:00.
  assert.equal(histogram(ev, LA).hours[1], 15);
});

test("working blocks end after the last active hour and join across a lunch dip", () => {
  const h = Array(24).fill(0);
  [9, 10, 11, 13, 14, 15, 16, 17].forEach((x) => (h[x] = 12));
  h[12] = 2; // lunch
  h[20] = 2; // an evening stray, below a quarter of the peak
  assert.deepEqual(blocks(h).map(fmtBlock), ["09:00-18:00"]);
  const split = Array(24).fill(0);
  [9, 10, 11].forEach((x) => (split[x] = 10));
  [15, 16].forEach((x) => (split[x] = 10));
  assert.deepEqual(blocks(split).map(fmtBlock), ["09:00-12:00", "15:00-17:00"]);
  assert.deepEqual(blocks(Array(24).fill(0)), []);
  assert.deepEqual(workDays([8, 8, 8, 8, 7, 2, 0]), ["mon", "tue", "wed", "thu", "fri"]);
});

test("a designer's zone is guessed from when they work, never with false certainty", () => {
  const g = inferZone(berlinWeek());
  assert.ok(["Europe/Berlin", "Europe/London", "Europe/Athens"].includes(g.tz), g.tz);
  assert.equal(g.confident, false); // activity fixes a zone only to within an hour or two
  assert.ok(g.also_fits.length >= 1);
  assert.equal(inferZone(berlinWeek({ weeks: 0 })), null); // too little to guess
  // The same hours nine hours later in absolute time (09:00-18:00 in Los Angeles) are not placed in Europe.
  assert.match(inferZone(berlinWeek().map((e) => ({ ...e, at: e.at + 9 * 3600000 }))).tz, /America|Pacific/);
});

test("zone conversion of a block, including a day shift", () => {
  const ref = Date.parse("2026-10-02T12:00:00Z");
  const b = shiftBlock({ start: 9 * 60, end: 18 * 60 }, Z, LA, ref);
  assert.equal(fmtBlock(b), "00:00-09:00");
  assert.equal(b.day_shift, 0);
  assert.equal(shiftBlock({ start: 22 * 60, end: 22 * 60 }, LA, Z, ref).day_shift, 1);
});

test("suggestion: windows over the working blocks on their days, plus a check before your day starts", () => {
  const s = suggest({ events: berlinWeek(), tz: Z, userTz: LA, userStart: "08:00", every: 60, ref: NOW });
  assert.equal(s.timezone, Z);
  assert.deepEqual(s.days, ["mon", "tue", "wed", "thu", "fri"]);
  // 09:00-18:00 Berlin = 00:00-09:00 Los Angeles, which already covers the hour before 08:00 there.
  assert.deepEqual(s.windows, [{ start: "09:00", end: "18:00", every: 60 }]);
  // Designers who finish before your day: a separate check lands in your hour before 08:00 (17:00 Berlin).
  const early = suggest({ events: berlinWeek({ hours: [8, 9, 10, 11] }), tz: Z, userTz: LA, userStart: "08:00", ref: NOW });
  assert.deepEqual(early.windows, [{ start: "08:00", end: "12:00", every: 60 }, { start: "16:00", end: "16:00", every: 60 }]);
  assert.match(suggestionToml(early), /^\[schedule\]\ntimezone = "Europe\/Berlin"\ndays = \["mon", "tue", "wed", "thu", "fri"\]\nwindows = \[\{ start = "08:00", end = "12:00", every = 60 \}, \{ start = "16:00", end = "16:00", every = 60 \}\]$/);
  // Config accepts what the suggestion prints.
  const toml = readFileSync(`${FIX}/tern.toml`, "utf8").replace("__REPO__", "/tmp/tern");
  assert.doesNotThrow(() => parseConfig(toml + "\n" + suggestionToml(early), "t.toml"));
  // Thin data is called rough.
  const thin = suggest({ events: berlinWeek({ weeks: 1 }), tz: Z, userTz: LA, ref: NOW });
  assert.match(thin.notes.join(), /only 5 active days/);
});

test("lateness: a three-a-day schedule in Los Angeles against Berlin working hours", () => {
  const toml = readFileSync(`${FIX}/tern.toml`, "utf8").replace("__REPO__", "/tmp/tern");
  const fixed = parseConfig(toml + `\n[schedule]\ntimezone = "America/Los_Angeles"\ntimes = ["06:00", "14:00", "22:00"]`, "t.toml");
  const l = lateness(berlinWeek(), fixed);
  // Berlin 09:00-18:00 = 00:00-09:00 PDT: the 06:00 PDT check is the first after most of it.
  assert.ok(l.share > 0.4, `${l.share}`);
  const every = parseConfig(toml, "t.toml");
  assert.equal(lateness(berlinWeek(), every).share, 0);
  const dense = parseConfig(toml + `\n[schedule]\ntimezone = "Europe/Berlin"\nwindows = [{ start = "08:00", end = "19:00", every = 60 }]`, "t.toml");
  assert.equal(lateness(berlinWeek(), dense).share, 0);
});

test("analyse reports each person in their time and yours", () => {
  const ev = [...berlinWeek({ who: "Mara" }), ...berlinWeek({ who: "Zoë", hours: [14, 15, 16, 17, 18, 19] })];
  const r = analyse({ events: ev, userTz: LA, tz: Z, ref: NOW });
  assert.deepEqual(r.people.map((p) => p.who), ["Mara", "Zoë"]);
  assert.equal(r.people[0].blocks[0].own, "09:00-18:00");
  assert.equal(r.people[0].blocks[0].yours, "00:00-09:00");
  assert.equal(r.people[1].blocks[0].own, "14:00-20:00");
  assert.equal(r.people[1].blocks[0].yours, "05:00-11:00");
  assert.equal(r.suggestion.timezone, Z);
});

test("fetching follows Figma's version pages back to the window's start", async () => {
  const pages = [
    { versions: [{ created_at: "2026-10-01T10:00:00Z", user: { handle: "a" } }, { created_at: "2026-09-20T10:00:00Z", user: { handle: "a" } }], pagination: { next_page: "https://api.figma.com/v1/files/K/versions?page_size=30&after=2026-09-20 10:00:00 UTC" } },
    { versions: [{ created_at: "2026-09-01T10:00:00Z", user: { handle: "a" } }], pagination: {} },
  ];
  const calls = [];
  const client = {
    get: async (path, q) => (calls.push([path, q]), pages[calls.length - 1]),
    comments: async () => ({ comments: [{ created_at: "2026-09-30T10:00:00Z" }, { created_at: "2026-06-30T10:00:00Z" }] }),
  };
  const a = await fetchActivity(client, "K", { days: 30, now: NOW });
  assert.equal(calls.length, 1 + 1); // the first page already reaches 09-20 (older than nothing yet), so it asks once more
  assert.equal(calls[1][1].after, "2026-09-20 10:00:00 UTC");
  assert.equal(a.versions.length, 2); // the 09-01 one is outside the window
  assert.equal(a.comments.length, 1);
});
